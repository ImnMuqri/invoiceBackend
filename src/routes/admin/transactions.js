async function transactionRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET / - List all subscriptions (transactions)
  fastify.get("/", async (request, reply) => {
    try {
      const transactions = await prisma.subscription.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              profile: {
                select: {
                  name: true,
                  companyName: true,
                },
              },
            },
          },
        },
      });
      return transactions;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch transactions");
    }
  });

  // GET /:id - Get subscription details
  fastify.get("/:id", async (request, reply) => {
    try {
      const { id } = request.params;
      const transaction = await prisma.subscription.findUnique({
        where: { id: parseInt(id) },
        include: {
          user: true,
        },
      });
      if (!transaction) return reply.notFound("Transaction not found");
      return transaction;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch transaction details");
    }
  });
}

module.exports = transactionRoutes;
