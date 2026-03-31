async function promoCodeRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET /api/admin/promo-codes - List all promo codes
  fastify.get("/", async (request, reply) => {
    try {
      const promoCodes = await prisma.promoCode.findMany({
        orderBy: { createdAt: "desc" },
      });
      return promoCodes;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch promo codes");
    }
  });

  // POST /api/admin/promo-codes - Create a new promo code
  fastify.post("/", async (request, reply) => {
    try {
      const { code, discountType, discountValue, maxUses, expiresAt } =
        request.body;

      const newPromo = await prisma.promoCode.create({
        data: {
          code: code.toUpperCase(),
          discountType,
          discountValue,
          maxUses: maxUses ? parseInt(maxUses) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });

      return newPromo;
    } catch (error) {
      if (error.code === "P2002") {
        return reply.badRequest("Promo code already exists");
      }
      fastify.log.error(error);
      return reply.internalServerError("Failed to create promo code");
    }
  });

  // DELETE /api/admin/promo-codes/:id - Delete a promo code
  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.promoCode.delete({
        where: { id: parseInt(id) },
      });
      return { success: true, message: "Promo code deleted successfully" };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to delete promo code");
    }
  });

  // PATCH /api/admin/promo-codes/:id/toggle - Toggle active status
  fastify.patch("/:id/toggle", async (request, reply) => {
    try {
      const { id } = request.params;
      const promo = await prisma.promoCode.findUnique({
        where: { id: parseInt(id) },
      });

      const updatedPromo = await prisma.promoCode.update({
        where: { id: parseInt(id) },
        data: { isActive: !promo.isActive },
      });

      return updatedPromo;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to toggle promo code status");
    }
  });
}

module.exports = promoCodeRoutes;
