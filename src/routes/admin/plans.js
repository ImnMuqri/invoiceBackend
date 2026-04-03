async function planRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET / - List all plans (Admin only)
  fastify.get("/", async (request, reply) => {
    try {
      const plans = await prisma.plan.findMany({
        orderBy: { price: "asc" },
      });
      return plans;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch plans");
    }
  });

  // POST / - Create a new plan
  fastify.post("/", async (request, reply) => {
    try {
      const plan = await prisma.plan.create({
        data: request.body,
      });
      return plan;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to create plan");
    }
  });

  // PUT /:id - Update a plan
  fastify.put("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const plan = await prisma.plan.update({
        where: { id: parseInt(id) },
        data: request.body,
      });
      return plan;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to update plan");
    }
  });

  // DELETE /:id - Delete a plan
  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      await prisma.plan.delete({
        where: { id: parseInt(id) },
      });
      return { success: true, message: "Plan deleted successfully" };
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to delete plan");
    }
  });
}

module.exports = planRoutes;
