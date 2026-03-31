async function publicPromoRoutes(fastify, opts) {
  const { prisma } = fastify;

  // POST /api/promo/validate
  fastify.post("/validate", async (request, reply) => {
    try {
      const { code } = request.body;
      if (!code) return reply.badRequest("Code is required");

      const promo = await prisma.promoCode.findUnique({
        where: { code: code.toUpperCase() },
      });

      if (!promo || !promo.isActive) {
        return reply.badRequest("Invalid or inactive promo code");
      }

      const now = new Date();
      if (promo.expiresAt && promo.expiresAt < now) {
        return reply.badRequest("Promo code has expired");
      }

      if (promo.maxUses && promo.uses >= promo.maxUses) {
        return reply.badRequest("Promo code has reached its usage limit");
      }

      return {
        code: promo.code,
        discountType: promo.discountType,
        discountValue: promo.discountValue,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to validate promo code");
    }
  });
}

module.exports = publicPromoRoutes;
