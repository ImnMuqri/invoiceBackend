const { encrypt, decrypt } = require("../../utils/encryption");

async function paymentRoutes(fastify, opts) {
  const { prisma } = fastify;

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
    const { provider, apiKey, secretKey, collectionId, categoryCode, xSignatureKey } = request.body;

    if (!["TOYYIBPAY", "BILLPLZ"].includes(provider)) {
      return reply.badRequest("Invalid provider");
    }

    const encryptedData = {
      apiKey: apiKey ? encrypt(apiKey) : null,
      secretKey: secretKey ? encrypt(secretKey) : null,
      xSignatureKey: xSignatureKey ? encrypt(xSignatureKey) : null,
    };

    const existing = await prisma.paymentProvider.findFirst({
      where: { userId: request.user.id, provider },
    });
    const count = await prisma.paymentProvider.count({
      where: { userId: request.user.id },
    });

    if (existing) {
      const updated = await prisma.paymentProvider.update({
        where: { id: existing.id },
        data: {
          ...encryptedData,
          collectionId,
          categoryCode,
          isActive: true,
          isPreferred: count === 1 ? true : existing.isPreferred,
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
        isPreferred: count === 0 ? true : false,
      },
    });
    return { message: `${provider} connected successfully`, id: created.id };
  });

  // PATCH set preferred provider
  fastify.patch("/:id/prefer", async (request, reply) => {
    const { id } = request.params;
    const provider = await prisma.paymentProvider.findUnique({ where: { id: parseInt(id) } });

    if (!provider || provider.userId !== request.user.id) {
      return reply.notFound("Provider not found");
    }

    await prisma.paymentProvider.updateMany({
      where: { userId: request.user.id },
      data: { isPreferred: false },
    });
    await prisma.paymentProvider.update({
      where: { id: parseInt(id) },
      data: { isPreferred: true },
    });

    return { message: "Preferred provider updated" };
  });

  // DELETE provider
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params;
    const provider = await prisma.paymentProvider.findUnique({ where: { id: parseInt(id) } });

    if (!provider || provider.userId !== request.user.id) {
      return reply.notFound("Provider not found");
    }

    const wasPreferred = provider.isPreferred;
    await prisma.paymentProvider.delete({ where: { id: parseInt(id) } });

    if (wasPreferred) {
      const nextOne = await prisma.paymentProvider.findFirst({
        where: { userId: request.user.id },
      });
      if (nextOne) {
        await prisma.paymentProvider.update({
          where: { id: nextOne.id },
          data: { isPreferred: true },
        });
      }
    }

    return { message: "Provider disconnected successfully" };
  });

  // GET manual payment settings — now reads from ManualPayment model
  fastify.get("/manual", async (request, reply) => {
    const manual = await prisma.manualPayment.findUnique({
      where: { userId: request.user.id },
      select: {
        bankName: true,
        accountNumber: true,
        accountName: true,
        qrCode: true,
      },
    });

    // Return with old field names for frontend compatibility
    return {
      manualBankName: manual?.bankName ?? null,
      manualAccountNumber: manual?.accountNumber ?? null,
      manualAccountName: manual?.accountName ?? null,
      manualQrCode: manual?.qrCode ?? null,
    };
  });

  // PUT update manual payment settings
  fastify.put("/manual", async (request, reply) => {
    const data = request.body;

    const updated = await prisma.manualPayment.upsert({
      where: { userId: request.user.id },
      update: {
        bankName: data.manualBankName,
        accountNumber: data.manualAccountNumber,
        accountName: data.manualAccountName,
        qrCode: data.manualQrCode,
      },
      create: {
        userId: request.user.id,
        bankName: data.manualBankName,
        accountNumber: data.manualAccountNumber,
        accountName: data.manualAccountName,
        qrCode: data.manualQrCode,
      },
    });

    return {
      manualBankName: updated.bankName,
      manualAccountNumber: updated.accountNumber,
      manualAccountName: updated.accountName,
      manualQrCode: updated.qrCode,
      message: "Manual payment settings updated successfully",
    };
  });
}

module.exports = paymentRoutes;
