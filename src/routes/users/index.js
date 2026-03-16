async function userRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication to all routes in this plugin
  fastify.addHook("onRequest", fastify.authenticate);

  // GET current user (me)
  fastify.get("/me", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        companyName: true,
        companyEmail: true,
        address: true,
        defaultCurrency: true,
        defaultTaxRate: true,
        plan: true,
        waSendsUsed: true,
        emailSendsUsed: true,
        waRemindersUsed: true,
        emailRemindersUsed: true,
        aiUsed: true,
        lastResetDate: true,
        createdAt: true,
      },
    });

    if (!user) {
      return reply.notFound("User not found");
    }

    return user;
  });

  // PUT update profile
  fastify.put("/me", async (request, reply) => {
    const data = request.body;

    const updatedUser = await prisma.user.update({
      where: { id: request.user.id },
      data: {
        name: data.name,
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        address: data.address,
        defaultCurrency: data.defaultCurrency,
        defaultTaxRate: data.defaultTaxRate,
      },
      select: {
        id: true,
        name: true,
        companyName: true,
        companyEmail: true,
        address: true,
        defaultCurrency: true,
        defaultTaxRate: true,
        plan: true,
      },
    });

    return updatedUser;
  });

  // POST subscribe to a plan
  fastify.post("/subscribe", async (request, reply) => {
    const { plan } = request.body;
    if (!["FREE", "PRO", "MAX"].includes(plan)) {
      return reply.badRequest("Invalid plan");
    }

    const updatedUser = await prisma.user.update({
      where: { id: request.user.id },
      data: { plan },
      select: {
        id: true,
        plan: true,
      },
    });

    return { ...updatedUser, message: `Successfully subscribed to ${plan} plan!` };
  });

  // Register settings routes
  fastify.register(require("./settings"), { prefix: "/settings" });
  fastify.register(require("./payments"), { prefix: "/payments" });
}

module.exports = userRoutes;
