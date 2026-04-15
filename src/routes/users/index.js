async function userRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.addHook("onRequest", fastify.authenticate);

  // GET current user (me) — flat response shape, unchanged from before
  fastify.get("/me", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        plan: true,
        role: true,
        onboardingCompleted: true,
        referralCode: true,
        referralCredits: true,
        createdAt: true,
        // Sub-models
        profile: true,
        quota: true,
        invoiceConfig: true,
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

    if (!user) return reply.notFound("User not found");

    // Flatten response so frontend authStore.user.companyName etc. still work
    const { profile, quota, invoiceConfig, ...core } = user;
    return {
      ...core,
      // Profile fields
      name: profile?.name,
      phoneNumber: profile?.phoneNumber,
      heardAbout: profile?.heardAbout,
      currentStatus: profile?.currentStatus,
      companyName: profile?.companyName,
      companyEmail: profile?.companyEmail,
      companyPhone: profile?.companyPhone,
      address: profile?.address,
      defaultCurrency: profile?.defaultCurrency ?? "MYR",
      // Quota fields
      waSendsUsed: quota?.waSendsUsed ?? 0,
      emailSendsUsed: quota?.emailSendsUsed ?? 0,
      waRemindersUsed: quota?.waRemindersUsed ?? 0,
      emailRemindersUsed: quota?.emailRemindersUsed ?? 0,
      aiUsed: quota?.aiUsed ?? 0,
      invoicesUsed: quota?.invoicesUsed ?? 0,
      lastResetDate: quota?.lastResetDate,
      // Invoice config fields
      invoicePrefix: invoiceConfig?.invoicePrefix ?? "INV",
      defaultTaxRate: invoiceConfig?.defaultTaxRate ?? 0,
      invoiceIncludeName: invoiceConfig?.invoiceIncludeName ?? true,
      invoiceIncludeEmail: invoiceConfig?.invoiceIncludeEmail ?? false,
      invoiceIncludePersonalPhone: invoiceConfig?.invoiceIncludePersonalPhone ?? false,
      invoiceIncludeCompanyPhone: invoiceConfig?.invoiceIncludeCompanyPhone ?? true,
      invoiceIncludeCompanyName: invoiceConfig?.invoiceIncludeCompanyName ?? true,
      invoiceIncludeAddress: invoiceConfig?.invoiceIncludeAddress ?? true,
    };
  });

  // PUT update profile (personal + company info only)
  fastify.put("/me", async (request, reply) => {
    const data = request.body;

    await prisma.userProfile.upsert({
      where: { userId: request.user.id },
      update: {
        name: data.name,
        phoneNumber: data.phoneNumber,
        heardAbout: data.heardAbout,
        currentStatus: data.currentStatus,
        defaultCurrency: data.defaultCurrency,
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        companyPhone: data.companyPhone,
        address: data.address,
      },
      create: {
        userId: request.user.id,
        name: data.name,
        phoneNumber: data.phoneNumber,
        heardAbout: data.heardAbout,
        currentStatus: data.currentStatus,
        defaultCurrency: data.defaultCurrency ?? "MYR",
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        companyPhone: data.companyPhone,
        address: data.address,
      },
    });

    // Update onboarding flag on the core User if provided
    if (data.onboardingCompleted !== undefined) {
      await prisma.user.update({
        where: { id: request.user.id },
        data: { onboardingCompleted: data.onboardingCompleted },
      });
    }

    // Return the same flat shape as GET /me for consistency
    const updated = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true,
        email: true,
        plan: true,
        role: true,
        onboardingCompleted: true,
        profile: true,
        invoiceConfig: true,
      },
    });

    const { profile, invoiceConfig, ...core } = updated;
    return {
      ...core,
      name: profile?.name,
      phoneNumber: profile?.phoneNumber,
      heardAbout: profile?.heardAbout,
      currentStatus: profile?.currentStatus,
      companyName: profile?.companyName,
      companyEmail: profile?.companyEmail,
      companyPhone: profile?.companyPhone,
      address: profile?.address,
      defaultCurrency: profile?.defaultCurrency ?? "MYR",
      invoicePrefix: invoiceConfig?.invoicePrefix ?? "INV",
      defaultTaxRate: invoiceConfig?.defaultTaxRate ?? 0,
      invoiceIncludeName: invoiceConfig?.invoiceIncludeName ?? true,
      invoiceIncludeEmail: invoiceConfig?.invoiceIncludeEmail ?? false,
      invoiceIncludePersonalPhone: invoiceConfig?.invoiceIncludePersonalPhone ?? false,
      invoiceIncludeCompanyPhone: invoiceConfig?.invoiceIncludeCompanyPhone ?? true,
      invoiceIncludeCompanyName: invoiceConfig?.invoiceIncludeCompanyName ?? true,
      invoiceIncludeAddress: invoiceConfig?.invoiceIncludeAddress ?? true,
    };
  });

  // POST subscribe to a plan
  fastify.post("/subscribe", async (request, reply) => {
    const { plan, promoCode } = request.body;
    if (!["FREE", "PRO", "MAX"].includes(plan)) {
      return reply.badRequest("Invalid plan");
    }

    const { createRecurringPlan, cancelRecurringPlan } = require("../../utils/xendit");
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });

    if (plan === "FREE") {
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
        message: "Your subscription has been cancelled and will remain active until the end of the current period.",
      };
    }

    const activeSub = await prisma.subscription.findFirst({
      where: { userId: user.id, status: "ACTIVE" },
    });

    if (activeSub) {
      if (activeSub.plan === plan) {
        return reply.badRequest(`You already have an active ${plan} subscription.`);
      }
      if (activeSub.xenditSubscriptionId) {
        await cancelRecurringPlan(activeSub.xenditSubscriptionId);
        await prisma.subscription.update({
          where: { id: activeSub.id },
          data: { status: "CANCELLED" },
        });
      }
    }

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
            discount = { discountType: promo.discountType, discountValue: promo.discountValue };
            await prisma.promoCode.update({
              where: { id: promo.id },
              data: { uses: { increment: 1 } },
            });
          }
        }
      }

      const { plan: xenditPlan, customerId } = await createRecurringPlan(
        user,
        plan,
        discount,
        request.body.successUrl,
        request.body.failureUrl,
      );

      if (customerId && customerId !== user.xenditCustomerId) {
        await prisma.user.update({
          where: { id: user.id },
          data: { xenditCustomerId: customerId },
        });
      }

      const authUrlAction = xenditPlan.actions?.find((a) => a.action === "AUTH");
      const checkoutUrl = authUrlAction ? authUrlAction.url : null;

      if (!checkoutUrl) {
        return reply.internalServerError("Could not generate Xendit checkout URL");
      }

      return { plan, checkoutUrl, message: "Redirecting to payment Gateway..." };
    } catch (err) {
      request.log.error(err);
      return reply.internalServerError(
        "Failed to create Xendit subscription: " + (err.response?.data?.message || err.message),
      );
    }
  });

  fastify.register(require("./settings"), { prefix: "/settings" });
  fastify.register(require("./payments"), { prefix: "/payments" });
}

module.exports = userRoutes;
