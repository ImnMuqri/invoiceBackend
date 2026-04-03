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
        companyPhone: true,
        address: true,
        defaultCurrency: true,
        defaultTaxRate: true,
        reminderInterval: true,
        whatsappReminderInterval: true,
        invoiceIncludeName: true,
        invoiceIncludeEmail: true,
        invoiceIncludePersonalPhone: true,
        invoiceIncludeCompanyPhone: true,
        invoiceIncludeCompanyName: true,
        invoiceIncludeAddress: true,
        globalAutoChaser: true,
        invoicePrefix: true,
        defaultTaxRate: true,
        plan: true,
        waSendsUsed: true,
        emailSendsUsed: true,
        waRemindersUsed: true,
        emailRemindersUsed: true,
        aiUsed: true,
        referralCode: true,
        referralCredits: true,
        lastResetDate: true,
        createdAt: true,
        subscriptions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            plan: true,
            status: true,
            subscriptionStart: true,
            subscriptionEnds: true,
            cancelAtPeriodEnd: true,
          },
        },
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
        companyPhone: data.companyPhone,
        address: data.address,
        defaultCurrency: data.defaultCurrency,
        defaultTaxRate: data.defaultTaxRate,
        reminderInterval: data.reminderInterval,
        invoiceIncludeName: data.invoiceIncludeName,
        invoiceIncludeEmail: data.invoiceIncludeEmail,
        invoiceIncludePersonalPhone: data.invoiceIncludePersonalPhone,
        invoiceIncludeCompanyPhone: data.invoiceIncludeCompanyPhone,
        invoiceIncludeCompanyName: data.invoiceIncludeCompanyName,
        invoiceIncludeAddress: data.invoiceIncludeAddress,
        globalAutoChaser: data.globalAutoChaser,
        invoicePrefix: data.invoicePrefix,
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
        companyPhone: true,
        address: true,
        defaultCurrency: true,
        defaultTaxRate: true,
        reminderInterval: true,
        invoiceIncludeName: true,
        invoiceIncludeEmail: true,
        invoiceIncludePersonalPhone: true,
        invoiceIncludeCompanyPhone: true,
        invoiceIncludeCompanyName: true,
        invoiceIncludeAddress: true,
        globalAutoChaser: true,
        invoicePrefix: true,
        plan: true,
      },
    });

    return updatedUser;
  });

  // POST subscribe to a plan
  fastify.post("/subscribe", async (request, reply) => {
    const { plan, promoCode } = request.body;
    if (!["FREE", "PRO", "MAX"].includes(plan)) {
      return reply.badRequest("Invalid plan");
    }

    const {
      createRecurringPlan,
      cancelRecurringPlan,
    } = require("../../utils/xendit");
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
    });

    if (plan === "FREE") {
      // Find active subscription to cancel in Xendit
      const activeSub = await prisma.subscription.findFirst({
        where: { userId: user.id, status: "ACTIVE" },
      });

      if (activeSub && activeSub.xenditSubscriptionId) {
        await cancelRecurringPlan(activeSub.xenditSubscriptionId);
        await prisma.subscription.update({
          where: { id: activeSub.id },
          data: { status: "CANCELLED", cancelAtPeriodEnd: true },
        });
      }

      return {
        plan: user.plan,
        message:
          "Your subscription has been cancelled and will remain active until the end of the current period.",
      };
    }

    // Check if already active
    const activeSub = await prisma.subscription.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
    });

    if (activeSub) {
      if (activeSub.plan === plan) {
        return reply.badRequest(
          `You already have an active ${plan} subscription.`,
        );
      }

      // Switching plans: Cancel old one first in Xendit
      if (activeSub.xenditSubscriptionId) {
        await cancelRecurringPlan(activeSub.xenditSubscriptionId);
        await prisma.subscription.update({
          where: { id: activeSub.id },
          data: { status: "CANCELLED" },
        });
      }
    }

    // Clean up old pending ones for same plan to avoid UI clutter
    await prisma.subscription.deleteMany({
      where: { userId: user.id, status: "PENDING", plan: plan },
    });

    try {
      let discount = null;
      if (promoCode) {
        const promo = await prisma.promoCode.findUnique({
          where: { code: promoCode.toUpperCase() },
        });

        if (promo && promo.isActive) {
          const now = new Date();
          const isNotExpired = !promo.expiresAt || promo.expiresAt > now;
          const hasUsesLeft = !promo.maxUses || promo.uses < promo.maxUses;

          if (isNotExpired && hasUsesLeft) {
            discount = {
              discountType: promo.discountType,
              discountValue: promo.discountValue,
            };

            // Increment usage count
            await prisma.promoCode.update({
              where: { id: promo.id },
              data: { uses: { increment: 1 } },
            });
          }
        }
      }

      // Create xendit recurring plan
      const { plan: xenditPlan, customerId } = await createRecurringPlan(
        user,
        plan,
        discount,
      );

      // Update user with customerId if newly created
      if (customerId && customerId !== user.xenditCustomerId) {
        await prisma.user.update({
          where: { id: user.id },
          data: { xenditCustomerId: customerId },
        });
      }

      // Xendit plan response will contain a checkout URL (actions array)
      const authUrlAction = xenditPlan.actions?.find(
        (a) => a.action === "AUTH",
      );
      const checkoutUrl = authUrlAction ? authUrlAction.url : null;

      if (!checkoutUrl) {
        return reply.internalServerError(
          "Could not generate Xendit checkout URL",
        );
      }

      return {
        plan,
        checkoutUrl,
        message: "Redirecting to payment Gateway...",
      };
    } catch (err) {
      request.log.error(err);
      return reply.internalServerError(
        "Failed to create Xendit subscription: " +
          (err.response?.data?.message || err.message),
      );
    }
  });

  // GET /plans - List all public plans
  fastify.get("/plans", async (request, reply) => {
    try {
      const plans = await prisma.plan.findMany({
        where: { isPublic: true },
        orderBy: { price: "asc" },
      });
      return plans;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch plans");
    }
  });

  // Register settings routes
  fastify.register(require("./settings"), { prefix: "/settings" });
  fastify.register(require("./payments"), { prefix: "/payments" });
}

module.exports = userRoutes;
