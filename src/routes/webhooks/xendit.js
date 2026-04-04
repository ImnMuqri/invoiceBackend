async function xenditWebhooks(fastify, opts) {
  const { prisma } = fastify;

  fastify.post("/xendit", async (request, reply) => {
    const payload = request.body;

    // Acknowledge webhook quickly
    reply.send({ received: true });

    try {
      // Xendit Recurring webhook payloads might be wrapped { event, data } or just the object directly
      const data = payload.data || payload;

      if (!data || !data.reference_id) return;

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

          await prisma.user.update({
            where: { id: userId },
            data: {
              plan: planName,
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

          // Reset First-Time Discount for subsequent months
          let basePrice = 0;
          const planRecord = await prisma.plan.findUnique({
            where: { name: planName },
          });
          if (planRecord && planRecord.price) {
            basePrice = planRecord.price;
          }
          const currentAmount = data.amount || basePrice; // use webhook amount
          if (basePrice > 0 && currentAmount < basePrice) {
            try {
              const axios = require("axios");
              const secretKey = process.env.XENDIT_SECRET_KEY || "";
              const token = Buffer.from(secretKey + ":").toString("base64");

              await axios.patch(
                `https://api.xendit.co/recurring/plans/${xenditSubscriptionId}`,
                { amount: basePrice },
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
