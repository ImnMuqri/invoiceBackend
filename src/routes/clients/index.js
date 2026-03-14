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

    if (!data.name || !data.email) {
      return reply.badRequest("Name and Email are required");
    }

    const email = data.email.trim().toLowerCase();

    // Check for existing client with same email for this user (case-insensitive)
    const existingClient = await prisma.client.findFirst({
      where: {
        email: {
          equals: email,
          mode: "insensitive",
        },
        userId: request.user.id,
      },
    });

    if (existingClient) {
      return reply.badRequest("Client already exists with this email");
    }

    const client = await prisma.client.create({
      data: {
        ...data,
        email: email, // Save trimmed and lowercased
        userId: request.user.id,
      },
    });
    return { ...client, message: "Client added successfully" };
  });

  // DELETE client
  fastify.delete("/:id", async (request, reply) => {
    const id = Number(request.params.id);

    // Check if client has invoices
    const invoiceCount = await prisma.invoice.count({
      where: { clientId: id, userId: request.user.id },
    });

    if (invoiceCount > 0) {
      return reply.badRequest(
        `Cannot delete client. They have ${invoiceCount} associated invoices. Delete the invoices first.`,
      );
    }

    try {
      await prisma.client.delete({
        where: { id, userId: request.user.id },
      });
      return { success: true, message: "Client deleted successfully" };
    } catch (err) {
      fastify.log.error("Error deleting client:", err);
      return reply.internalServerError("Failed to delete client");
    }
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

    // Tighten validation and normalize email
    if (data.email !== undefined) {
      data.email = data.email.trim().toLowerCase();
    }

    if (data.name === "" || data.email === "") {
      return reply.badRequest("Name and Email cannot be empty");
    }

    // If email is being changed, check for uniqueness
    if (data.email) {
      const existingWithEmail = await prisma.client.findFirst({
        where: {
          email: {
            equals: data.email,
            mode: "insensitive",
          },
          userId: request.user.id,
          id: { not: id }, // Exclude current client
        },
      });

      if (existingWithEmail) {
        return reply.badRequest("Another client already exists with this email");
      }
    }

    try {
      // Check if user is FREE before allowing chaser enablement
      if (data.autoChaser || data.autoEmailChaser) {
        const user = await prisma.user.findUnique({
          where: { id: request.user.id },
          select: { plan: true },
        });

        if (user.plan === "FREE") {
          return reply.forbidden("Upgrade to Pro to enable automated chasers");
        }
      }

      const client = await prisma.client.update({
        where: { id, userId: request.user.id },
        data,
      });
      return { ...client, message: "Client updated successfully" };
    } catch (err) {
      fastify.log.error("Error updating client:", err);
      return reply.internalServerError("Failed to update client");
    }
  });
}

module.exports = clientRoutes;
