const { safeEqual } = require("../../utils/gateways/compare");

async function xenditWebhooks(fastify, opts) {
  const { prisma } = fastify;

  fastify.post("/xendit", async (request, reply) => {
    /* Verify the callback token — and REFUSE when it is not configured.
       This read `if (callbackToken && headerToken !== callbackToken)`, so an
       unset XENDIT_CALLBACK_TOKEN skipped verification entirely. It is not in
       the required-env list either, so the service boots happily without it.

       That combination is a complete self-upgrade: this handler parses the plan
       out of `reference_id`, so an unauthenticated
           POST /api/webhooks/xendit  {"data":{"reference_id":"sub_3_MAX_1","status":"ACTIVE"}}
       granted user 3 the MAX plan, for free, with no payment and no session.

       Failing closed has a real cost: if the token is missing in production,
       genuine payments stop upgrading anyone until it is set. That is the right
       side to fail on — a paid customer waiting on support beats anyone in the
       world minting themselves a plan — but it does mean the variable MUST be
       set in Railway. */
    const callbackToken = process.env.XENDIT_CALLBACK_TOKEN;
    const headerToken = request.headers["x-callback-token"];

    if (!callbackToken) {
      fastify.log.error(
        "XENDIT_CALLBACK_TOKEN is not set — refusing every payment webhook. Set it in the environment.",
      );
      return reply.unauthorized("Callback verification is not configured");
    }
    if (!safeEqual(callbackToken, String(headerToken || ""))) {
      fastify.log.warn("Unauthorized Xendit webhook attempt");
      return reply.unauthorized("Invalid callback token");
    }

    const payload = request.body;

    // Acknowledge webhook quickly
    reply.send({ received: true });

    try {
      // Xendit Recurring webhook payloads might be wrapped { event, data } or just the object directly
      const data = payload.data || payload;

      if (!data) return;

      /* Top-ups (spec 01) come through the same webhook as subscriptions, but
         they are one-off Invoice API events rather than recurring cycles, so
         they are matched on the external_id we set at purchase time. Handled
         before the subscription branch because the two payload shapes overlap
         and a top-up must never be mistaken for a plan activation. */
      const externalId = data.external_id || "";
      if (externalId.startsWith("topup_")) {
        const settled = ["PAID", "SETTLED"].includes(String(data.status || "").toUpperCase());
        if (!settled) return;

        const topUpId = parseInt(externalId.split("_")[1], 10);
        if (!Number.isInteger(topUpId)) return;

        /* updateMany with a status guard, so a duplicate delivery of the same
           webhook cannot activate the same balance twice. */
        const result = await prisma.topUp.updateMany({
          where: { id: topUpId, status: "PENDING" },
          data: { status: "ACTIVE" },
        });
        if (result.count) {
          fastify.log.info({ topUpId }, "Top-up activated");
        }
        return;
      }


      if (!data.reference_id) return;

      const eventType = payload.event || "";
      const isActivation =
        eventType === "recurring.cycle.created" || data.status === "ACTIVE";

      if (isActivation) {
        let referenceId = data.reference_id || ""; // e.g., sub_1_PRO_123456

        // If the webhook is a cycle event, the reference_id might be "schedule_sub_..."
        if (referenceId.startsWith("schedule_")) {
          referenceId = referenceId.replace("schedule_", "");
        }

        const parts = referenceId.split("_");
        if (parts[0] === "sub" && parts.length >= 3) {
          const userId = parseInt(parts[1], 10);
          const planName = parts[2];
          // Safely extract the root Plan ID even if this is a cycle event
          const xenditSubscriptionId = data.plan_id || data.id;

          const user = await prisma.user.findUnique({
            where: { id: userId },
          });
          if (!user) return;

          /* planName is parsed out of reference_id. Even with the token now
             enforced, writing an unvalidated string into user.plan is how a
             typo becomes a customer silently dropped to the safety floor —
             usage.js resolves anything it does not recognise to FREE. Only
             names that exist as plans are written. */
          const known = (await fastify.getPlans()) || [];
          const match = known.find(
            (p) => String(p.name).toUpperCase() === String(planName).toUpperCase(),
          );
          if (!match) {
            fastify.log.error(
              { planName, referenceId, userId },
              "Xendit webhook named a plan that does not exist; ignoring",
            );
            return;
          }

          await prisma.user.update({
            where: { id: userId },
            data: {
              plan: match.name,
              xenditSubscriptionId: xenditSubscriptionId,
            },
          });

          // Referral logic: If user was referred and this is their first subscription
          if (
            user &&
            user.referredById &&
            !user.referralCreditEarned &&
            planName !== "FREE" &&
            user.plan === "FREE"
          ) {
            await prisma.user.update({
              where: { id: user.id },
              data: { referralCreditEarned: true },
            });

            await prisma.user.update({
              where: { id: user.referredById },
              data: {
                referralCredits: { increment: 1 },
              },
            });
            fastify.log.info(
              `Incremented referral credits for Referrer ${user.referredById} due to User ${userId} first-time subscription`,
            );
          }

          // Also update the dedicated Subscription table record
          const now = new Date();
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          await prisma.subscription.update({
            where: {
              xenditSubscriptionId: xenditSubscriptionId,
            },
            data: {
              status: "ACTIVE",
              subscriptionStart: now,
              subscriptionEnds: data.scheduled_timestamp
                ? new Date(data.scheduled_timestamp)
                : nextMonth,
            },
          });

          /* Reset the first-month discount for subsequent cycles.
             UNITS: basePrice is sen (Plan.price); `data.amount` comes back from
             Xendit in RINGGIT. Comparing them directly said a RM29 charge was
             "less than" 2900 every single time, so this block fired on every
             renewal and PATCHed the plan to 2900 — ringgit — turning a RM29
             subscription into RM2,900 a month from cycle two onwards. Both
             sides are held in sen here and converted only in the request. */
          const { toRinggit } = require("../../utils/xendit");
          let basePrice = 0;
          const planRecord = await prisma.plan.findUnique({
            where: { name: planName },
          });
          if (planRecord && planRecord.price) {
            basePrice = planRecord.price;
          }
          const currentAmount =
            data.amount != null ? Math.round(Number(data.amount) * 100) : basePrice;
          if (basePrice > 0 && currentAmount < basePrice) {
            try {
              const axios = require("axios");
              const secretKey = process.env.XENDIT_SECRET_KEY || "";
              const token = Buffer.from(secretKey + ":").toString("base64");

              await axios.patch(
                `https://api.xendit.co/recurring/plans/${xenditSubscriptionId}`,
                { amount: toRinggit(basePrice) },
                {
                  headers: {
                    Authorization: `Basic ${token}`,
                    "Content-Type": "application/json",
                  },
                },
              );
              fastify.log.info(
                `Reset Xendit Plan ${xenditSubscriptionId} from ${currentAmount} to base price ${basePrice} for subsequent cycles.`,
              );

              // Also update local DB
              await prisma.subscription.update({
                where: { xenditSubscriptionId: xenditSubscriptionId },
                data: { amount: basePrice },
              });
            } catch (err) {
              fastify.log.error(
                "Failed to reset Xendit plan amount: " + err.message,
              );
            }
          }

          fastify.log.info(
            `Upgraded User ${userId} to ${planName} via Xendit webhook`,
          );
        }
      } else if (eventType === "payment.succeeded") {
        // If it's a payment cycle success
        // Handle renewal logic if needed, or rely on recurring.plan hook
      }
    } catch (err) {
      fastify.log.error("Xendit Webhook processing error:", err);
    }
  });
}

module.exports = xenditWebhooks;
