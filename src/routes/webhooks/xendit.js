async function xenditWebhooks(fastify, opts) {
  const { prisma } = fastify;

  fastify.post("/xendit", async (request, reply) => {
    const payload = request.body;

    // Acknowledge webhook quickly
    reply.send({ received: true });

    try {
      // Xendit Recurring webhook types:
      // "recurring.plan.activated"
      // "payment.succeeded" for recurring

      const eventType = payload.event;
      const data = payload.data;

      if (!data) return;

      if (eventType === "recurring.plan.activated") {
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
