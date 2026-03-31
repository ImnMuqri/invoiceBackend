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
            planName !== "FREE" &&
            user.plan === "FREE"
          ) {
            await prisma.user.update({
              where: { id: user.referredById },
              data: {
                referralCredits: { increment: 1 },
              },
            });
            fastify.log.info(
              `Incremented referral credits for Referrer ${user.referredById} due to User ${userId} subscription`,
            );
          }

          // Also update the dedicated Subscription table record
          const now = new Date();
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          await prisma.subscription.updateMany({
            where: {
              userId: userId,
              plan: planName,
              status: "PENDING",
            },
            data: {
              status: "ACTIVE",
              subscriptionStart: now,
              subscriptionEnds: data.scheduled_timestamp
                ? new Date(data.scheduled_timestamp)
                : nextMonth,
            },
          });

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
