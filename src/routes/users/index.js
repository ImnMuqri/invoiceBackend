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
        phoneNumber: true,
        heardAbout: true,
        currentStatus: true,
        onboardingCompleted: true,
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
        subscriptions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: {
            plan: true,
            status: true,
            subscriptionStart: true,
            subscriptionEnds: true,
          }
        }
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
        phoneNumber: data.phoneNumber,
        heardAbout: data.heardAbout,
        currentStatus: data.currentStatus,
        onboardingCompleted: data.onboardingCompleted,
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        address: data.address,
        defaultCurrency: data.defaultCurrency,
        defaultTaxRate: data.defaultTaxRate,
      },
      select: {
        id: true,
        name: true,
        phoneNumber: true,
        heardAbout: true,
        currentStatus: true,
        onboardingCompleted: true,
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

    const { createRecurringPlan } = require("../../utils/xendit");
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
    });

    if (plan === "FREE") {
      // Direct downgrade to free
      const updatedUser = await prisma.user.update({
        where: { id: user.id },
        data: { plan: "FREE", xenditSubscriptionId: null },
      });
      return { plan: "FREE", message: "Successfully downgraded to FREE plan." };
    }

    try {
      // Create xendit recurring plan
      const { plan: xenditPlan, customerId } = await createRecurringPlan(user, plan);

      // Update user with customerId if newly created
      if (customerId && customerId !== user.xenditCustomerId) {
        await prisma.user.update({
          where: { id: user.id },
          data: { xenditCustomerId: customerId },
        });
      }

      // Xendit plan response will contain a checkout URL (actions array)
      const authUrlAction = xenditPlan.actions?.find((a) => a.action === "AUTH");
      const checkoutUrl = authUrlAction ? authUrlAction.url : null;

      if (!checkoutUrl) {
        return reply.internalServerError("Could not generate Xendit checkout URL");
      }

      return {
        plan,
        checkoutUrl,
        message: "Redirecting to payment Gateway...",
      };
    } catch (err) {
      request.log.error(err);
      return reply.internalServerError(
        "Failed to create Xendit subscription: " + (err.response?.data?.message || err.message)
      );
    }
  });

  // Register settings routes
  fastify.register(require("./settings"), { prefix: "/settings" });
  fastify.register(require("./payments"), { prefix: "/payments" });
}

module.exports = userRoutes;
