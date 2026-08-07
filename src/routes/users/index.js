async function userRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.addHook("onRequest", fastify.authenticate);

  // GET current user (me) — lean session endpoint
  // Only returns what's needed for: auth guards, navbar, dashboard quota bars, referral sidebar
  // Invoice config fields (invoiceInclude*, prefix, taxRate) are fetched separately via /settings/profile
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
        // Sub-models — only what's needed globally
        profile: {
          select: {
            name: true,
            defaultCurrency: true,
            // Needed by invoice create/edit to pre-fill "From" section
            phoneNumber: true,
            companyName: true,
            companyEmail: true,
            companyPhone: true,
            address: true,
            logoUrl: true,
          },
        },
        quota: {
          select: {
            waSendsUsed: true,
            emailSendsUsed: true,
            waRemindersUsed: true,
            emailRemindersUsed: true,
            aiUsed: true,
            invoicesUsed: true,
          },
        },
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

    const { profile, quota, ...core } = user;
    return {
      ...core,
      // Profile essentials
      name: profile?.name,
      defaultCurrency: profile?.defaultCurrency ?? "MYR",
      phoneNumber: profile?.phoneNumber,
      companyName: profile?.companyName,
      companyEmail: profile?.companyEmail,
      companyPhone: profile?.companyPhone,
      address: profile?.address,
      logoUrl: profile?.logoUrl,
      // Quota counters (dashboard bars)
      waSendsUsed: quota?.waSendsUsed ?? 0,
      emailSendsUsed: quota?.emailSendsUsed ?? 0,
      waRemindersUsed: quota?.waRemindersUsed ?? 0,
      emailRemindersUsed: quota?.emailRemindersUsed ?? 0,
      aiUsed: quota?.aiUsed ?? 0,
      invoicesUsed: quota?.invoicesUsed ?? 0,
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
      logoUrl: profile?.logoUrl,
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

    const planData = await prisma.plan.findFirst({
      where: { name: { equals: plan, mode: "insensitive" }, isActive: true },
    });

    /* Downgrading to Free is a cancellation. It is handled below and needs no
       Plan row, so it short-circuits the pricing checks that follow. */
    const isCancellation = String(plan || "").toUpperCase() === "FREE";


    /* The Plan row is the only source of a price. The fallback here used to be
       `PRO ? 59 : 99` — a fourth hardcoded pricing source, already stale against
       the table, and the one that would actually charge the customer. Charging
       a number nobody can see in the admin panel is not a fallback worth
       having: if the plan is not in the table, refuse. */
    if (!isCancellation && !planData) {
      request.log.error({ plan }, "Subscribe attempted for a plan with no active row");
      return reply.badRequest("That plan is not available.");
    }
    const resolvedPlanName = isCancellation ? "FREE" : planData.name;
    const resolvedPlanPrice = isCancellation ? 0 : planData.price;

    const { createRecurringPlan, cancelRecurringPlan } = require("../../utils/xendit");
    const user = await prisma.user.findUnique({ where: { id: request.user.id } });

    if (resolvedPlanName === "FREE") {
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
      if (activeSub.plan.toUpperCase() === resolvedPlanName.toUpperCase()) {
        return reply.badRequest(`You already have an active ${resolvedPlanName} subscription.`);
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
      where: { userId: user.id, status: "PENDING", plan: resolvedPlanName },
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
        resolvedPlanName,
        resolvedPlanPrice,
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

      return { plan: resolvedPlanName, checkoutUrl, message: "Redirecting to payment Gateway..." };
    } catch (err) {
      request.log.error(err);
      return reply.internalServerError(
        "Failed to create Xendit subscription: " + (err.response?.data?.message || err.message),
      );
    }
  });

  // POST change password
  fastify.post("/change-password", async (request, reply) => {
    const { oldPassword, newPassword } = request.body;
    const bcrypt = require("bcryptjs");

    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
    });

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      return reply.badRequest("Current password incorrect");
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    await prisma.user.update({
      where: { id: request.user.id },
      data: { password: hashedPassword },
    });

    return { status: "success", message: "Password updated successfully" };
  });

  fastify.register(require("./settings"), { prefix: "/settings" });
  fastify.register(require("./payments"), { prefix: "/payments" });
}

module.exports = userRoutes;
