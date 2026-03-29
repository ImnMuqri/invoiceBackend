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
      const isActivation = eventType === "recurring.plan.activated" || data.status === "ACTIVE";

      if (isActivation) {
        const referenceId = data.reference_id || ""; // e.g., sub_1_PRO_123456
        const parts = referenceId.split("_");
        if (parts[0] === "sub" && parts.length >= 3) {
          const userId = parseInt(parts[1], 10);
          const planName = parts[2];
          const xenditSubscriptionId = data.id;

          await prisma.user.update({
            where: { id: userId },
            data: {
              plan: planName,
              xenditSubscriptionId: xenditSubscriptionId,
            },
          });

          // Also update the dedicated Subscription table record
          const now = new Date();
          const nextMonth = new Date();
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          await prisma.subscription.updateMany({
            where: { 
              userId: userId, 
              plan: planName, 
              status: "PENDING" 
            },
            data: {
              status: "ACTIVE",
              xenditSubscriptionId: xenditSubscriptionId,
              subscriptionStart: now,
              subscriptionEnds: nextMonth
            }
          });

          fastify.log.info(`Upgraded User ${userId} to ${planName} via Xendit webhook`);
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
