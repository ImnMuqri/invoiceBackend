async function clientRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  // GET all clients
  fastify.get(
    "/",
    {
      schema: {
        description: "Get all clients",
        response: {
          200: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                email: { type: "string" },
                phone: { type: "string" },
                address: { type: "string" },
                company: { type: "string" },
                riskScore: { type: "number" },
                averageDelayDays: { type: "number" },
                totalRevenue: { type: "number" },
                profitMargin: { type: "number" },
                status: { type: "string" },
                autoChaser: { type: "boolean" },
                autoEmailChaser: { type: "boolean" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      return prisma.client.findMany({
        where: { userId: request.user.id },
        orderBy: { updatedAt: "desc" },
      });
    },
  );

  // GET client by ID
  fastify.get("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const client = await prisma.client.findUnique({
      where: { id, userId: request.user.id },
      include: { invoices: true },
    });
    if (!client) {
      return reply.notFound("Client not found");
    }
    return client;
  });

  // POST create client
  fastify.post("/", async (request, reply) => {
    const data = request.body;
    const client = await prisma.client.create({
      data: {
        ...data,
        userId: request.user.id,
      },
    });
    return client;
  });

  // DELETE client
  fastify.delete("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    await prisma.client.delete({
      where: { id, userId: request.user.id },
    });
    return { success: true };
  });

  // PUT update client
  fastify.put("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const body = request.body;

    // Only allow these fields to be updated via this endpoint
    const allowedFields = [
      "name",
      "email",
      "phone",
      "address",
      "company",
      "autoChaser",
      "autoEmailChaser",
    ];
    const data = {};

    allowedFields.forEach((field) => {
      if (body[field] !== undefined) {
        data[field] = body[field];
      }
    });

    try {
      const client = await prisma.client.update({
        where: { id, userId: request.user.id },
        data,
      });
      return client;
    } catch (err) {
      console.error("Error updating client:", err);
      return reply.internalServerError("Failed to update client");
    }
  });
}

module.exports = clientRoutes;
