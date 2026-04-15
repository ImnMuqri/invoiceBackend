async function settingsRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.addHook("onRequest", fastify.authenticate);

  // GET user settings profile — flat shape for frontend compatibility
  fastify.get("/profile", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        plan: true,
        profile: true,
        quota: true,
        notification: true,
        invoiceConfig: true,
      },
    });

    if (!user) return reply.notFound("User not found");

    const { profile, quota, notification, invoiceConfig } = user;
    return {
      // Company / Profile
      companyName: profile?.companyName,
      companyEmail: profile?.companyEmail,
      companyPhone: profile?.companyPhone,
      address: profile?.address,
      // Invoice Config
      defaultTaxRate: invoiceConfig?.defaultTaxRate ?? 0,
      invoiceIncludeName: invoiceConfig?.invoiceIncludeName ?? true,
      invoiceIncludeEmail: invoiceConfig?.invoiceIncludeEmail ?? false,
      invoiceIncludePersonalPhone: invoiceConfig?.invoiceIncludePersonalPhone ?? false,
      invoiceIncludeCompanyPhone: invoiceConfig?.invoiceIncludeCompanyPhone ?? true,
      invoiceIncludeCompanyName: invoiceConfig?.invoiceIncludeCompanyName ?? true,
      invoiceIncludeAddress: invoiceConfig?.invoiceIncludeAddress ?? true,
      globalAutoChaser: notification?.globalAutoChaser ?? true,
      invoicePrefix: invoiceConfig?.invoicePrefix ?? "INV",
      // Quota
      waSendsUsed: quota?.waSendsUsed ?? 0,
      emailSendsUsed: quota?.emailSendsUsed ?? 0,
      waRemindersUsed: quota?.waRemindersUsed ?? 0,
      emailRemindersUsed: quota?.emailRemindersUsed ?? 0,
      aiUsed: quota?.aiUsed ?? 0,
      // Notification / WhatsApp
      reminderInterval: notification?.reminderInterval ?? 0,
      whatsappSendTemplate: notification?.whatsappSendTemplate,
      whatsappReminderTemplate: notification?.whatsappReminderTemplate,
      whatsappMode: notification?.whatsappMode ?? "SYSTEM",
      twilioSid: notification?.twilioSid,
      twilioAuthToken: notification?.twilioAuthToken,
      twilioPhoneNumber: notification?.twilioPhoneNumber,
      whatsappReminderInterval: notification?.whatsappReminderInterval ?? 0,
    };
  });

  // PUT update user settings profile
  fastify.put("/profile", async (request, reply) => {
    const data = request.body;

    // Fetch current state from notification model for plan-gate checks
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        plan: true,
        notification: {
          select: {
            reminderInterval: true,
            globalAutoChaser: true,
            whatsappSendTemplate: true,
            whatsappReminderTemplate: true,
            whatsappMode: true,
            twilioSid: true,
            twilioAuthToken: true,
            twilioPhoneNumber: true,
            whatsappReminderInterval: true,
          },
        },
      },
    });

    if (!user) return reply.notFound("User not found");

    const notif = user.notification || {};
    const whatsappFields = [
      "whatsappSendTemplate", "whatsappReminderTemplate", "whatsappMode",
      "twilioSid", "twilioAuthToken", "twilioPhoneNumber", "whatsappReminderInterval",
    ];

    const isUpdatingWhatsapp = whatsappFields.some(
      (field) => data[field] !== undefined && data[field] !== notif[field],
    );
    const isProTier = ["PRO", "MAX"].includes(user.plan);

    if (!isProTier) {
      if (data.globalAutoChaser === true && !notif.globalAutoChaser) {
        return reply.forbidden("Upgrade to Pro to enable Global Automation");
      }
      if (
        (data.reminderInterval && data.reminderInterval !== 0) ||
        (data.whatsappReminderInterval && data.whatsappReminderInterval !== 0)
      ) {
        return reply.forbidden("Upgrade to Pro to enable automated reminders");
      }
      if (isUpdatingWhatsapp) {
        return reply.forbidden("Upgrade to Pro to configure WhatsApp settings");
      }
    }

    // Update UserProfile (company info fields)
    await prisma.userProfile.upsert({
      where: { userId: request.user.id },
      update: {
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        companyPhone: data.companyPhone,
        address: data.address,
      },
      create: {
        userId: request.user.id,
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        companyPhone: data.companyPhone,
        address: data.address,
      },
    });

    // Update UserInvoiceConfig
    await prisma.userInvoiceConfig.upsert({
      where: { userId: request.user.id },
      update: {
        defaultTaxRate: data.defaultTaxRate,
        invoiceIncludeName: data.invoiceIncludeName,
        invoiceIncludeEmail: data.invoiceIncludeEmail,
        invoiceIncludePersonalPhone: data.invoiceIncludePersonalPhone,
        invoiceIncludeCompanyPhone: data.invoiceIncludeCompanyPhone,
        invoiceIncludeCompanyName: data.invoiceIncludeCompanyName,
        invoiceIncludeAddress: data.invoiceIncludeAddress,
        invoicePrefix: data.invoicePrefix,
      },
      create: {
        userId: request.user.id,
        defaultTaxRate: data.defaultTaxRate ?? 0,
        invoiceIncludeName: data.invoiceIncludeName ?? true,
        invoiceIncludeEmail: data.invoiceIncludeEmail ?? false,
        invoiceIncludePersonalPhone: data.invoiceIncludePersonalPhone ?? false,
        invoiceIncludeCompanyPhone: data.invoiceIncludeCompanyPhone ?? true,
        invoiceIncludeCompanyName: data.invoiceIncludeCompanyName ?? true,
        invoiceIncludeAddress: data.invoiceIncludeAddress ?? true,
        invoicePrefix: data.invoicePrefix ?? "INV",
      },
    });

    // Update UserNotification (automation + WhatsApp)
    await prisma.userNotification.upsert({
      where: { userId: request.user.id },
      update: {
        reminderInterval: data.reminderInterval,
        globalAutoChaser: data.globalAutoChaser,
        whatsappSendTemplate: data.whatsappSendTemplate,
        whatsappReminderTemplate: data.whatsappReminderTemplate,
        whatsappMode: data.whatsappMode,
        twilioSid: data.twilioSid,
        twilioAuthToken: data.twilioAuthToken,
        twilioPhoneNumber: data.twilioPhoneNumber,
        whatsappReminderInterval: data.whatsappReminderInterval
          ? parseInt(data.whatsappReminderInterval)
          : undefined,
      },
      create: {
        userId: request.user.id,
        reminderInterval: data.reminderInterval ?? 0,
        globalAutoChaser: data.globalAutoChaser ?? true,
        whatsappSendTemplate: data.whatsappSendTemplate,
        whatsappReminderTemplate: data.whatsappReminderTemplate,
        whatsappMode: data.whatsappMode ?? "SYSTEM",
        twilioSid: data.twilioSid,
        twilioAuthToken: data.twilioAuthToken,
        twilioPhoneNumber: data.twilioPhoneNumber,
        whatsappReminderInterval: data.whatsappReminderInterval
          ? parseInt(data.whatsappReminderInterval)
          : 0,
      },
    });

    return { success: true, message: "Settings updated successfully" };
  });
}

module.exports = settingsRoutes;
