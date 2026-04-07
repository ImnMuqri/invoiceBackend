const { encrypt, decrypt } = require("../../utils/encryption");

async function paymentRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // GET connected providers
  fastify.get("/", async (request, reply) => {
    const providers = await prisma.paymentProvider.findMany({
      where: { userId: request.user.id },
      select: {
        id: true,
        provider: true,
        isActive: true,
        isPreferred: true,
        collectionId: true,
        categoryCode: true,
        createdAt: true,
      },
    });

    return providers;
  });

  // POST connect/update provider
  fastify.post("/", async (request, reply) => {
    const { 
      provider, 
      apiKey, 
      secretKey, 
      collectionId, 
      categoryCode, 
      xSignatureKey 
    } = request.body;

    if (!["TOYYIBPAY", "BILLPLZ"].includes(provider)) {
      return reply.badRequest("Invalid provider");
    }

    // Encrypt sensitive fields
    const encryptedData = {
      apiKey: apiKey ? encrypt(apiKey) : null,
      secretKey: secretKey ? encrypt(secretKey) : null,
      xSignatureKey: xSignatureKey ? encrypt(xSignatureKey) : null,
    };

    // Check if provider already exists for this user
    const existing = await prisma.paymentProvider.findFirst({
      where: { userId: request.user.id, provider },
    });

    // Check if there are any other providers
    const count = await prisma.paymentProvider.count({
      where: { userId: request.user.id }
    });

    if (existing) {
      const updated = await prisma.paymentProvider.update({
        where: { id: existing.id },
        data: {
          ...encryptedData,
          collectionId,
          categoryCode,
          isActive: true,
          // If it's the only one, make it preferred if not already
          isPreferred: count === 1 ? true : existing.isPreferred
        },
      });
      return { message: `${provider} updated successfully`, id: updated.id };
    }

    const created = await prisma.paymentProvider.create({
      data: {
        userId: request.user.id,
        provider,
        ...encryptedData,
        collectionId,
        categoryCode,
        isPreferred: count === 0 ? true : false // First one is preferred by default
      },
    });

    return { message: `${provider} connected successfully`, id: created.id };
  });

  // PATCH set preferred
  fastify.patch("/:id/prefer", async (request, reply) => {
    const { id } = request.params;

    const provider = await prisma.paymentProvider.findUnique({
      where: { id: parseInt(id) },
    });

    if (!provider || provider.userId !== request.user.id) {
      return reply.notFound("Provider not found");
    }

    // Unset others
    await prisma.paymentProvider.updateMany({
      where: { userId: request.user.id },
      data: { isPreferred: false }
    });

    // Set this one
    await prisma.paymentProvider.update({
      where: { id: parseInt(id) },
      data: { isPreferred: true }
    });

    return { message: "Preferred provider updated" };
  });

  // DELETE provider
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params;

    const provider = await prisma.paymentProvider.findUnique({
      where: { id: parseInt(id) },
    });

    if (!provider || provider.userId !== request.user.id) {
      return reply.notFound("Provider not found");
    }

    const wasPreferred = provider.isPreferred;

    await prisma.paymentProvider.delete({
      where: { id: parseInt(id) },
    });

    // If we deleted the preferred one, set another as preferred if available
    if (wasPreferred) {
      const nextOne = await prisma.paymentProvider.findFirst({
        where: { userId: request.user.id }
      });
      if (nextOne) {
        await prisma.paymentProvider.update({
          where: { id: nextOne.id },
          data: { isPreferred: true }
        });
      }
    }

    return { message: "Provider disconnected successfully" };
  });

  // GET manual payment settings
  fastify.get("/manual", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        profile: {
          select: {
            manualBankName: true,
            manualAccountNumber: true,
            manualAccountName: true,
            manualQrCode: true,
          },
        },
      },
    });
    return user?.profile || {};
  });

  // PUT update manual payment settings
  fastify.put("/manual", async (request, reply) => {
    const data = request.body;
    const { profile } = await prisma.user.update({
      where: { id: request.user.id },
      data: {
        profile: {
          upsert: {
            create: {
              manualBankName: data.manualBankName,
              manualAccountNumber: data.manualAccountNumber,
              manualAccountName: data.manualAccountName,
              manualQrCode: data.manualQrCode,
            },
            update: {
              manualBankName: data.manualBankName,
              manualAccountNumber: data.manualAccountNumber,
              manualAccountName: data.manualAccountName,
              manualQrCode: data.manualQrCode,
            },
          },
        },
      },
      select: {
        profile: {
          select: {
            manualBankName: true,
            manualAccountNumber: true,
            manualAccountName: true,
            manualQrCode: true,
          },
        },
      },
    });
    return {
      ...(profile || {}),
      message: "Manual payment settings updated successfully",
    };
  });
}

module.exports = paymentRoutes;
