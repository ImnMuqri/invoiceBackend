async function publicPlansRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.get("/", async (request, reply) => {
    try {
      const plans = await prisma.plan.findMany({
        where: { isActive: true },
        orderBy: { price: "asc" },
      });
      return plans;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch public plans");
    }
  });
}

module.exports = publicPlansRoutes;
