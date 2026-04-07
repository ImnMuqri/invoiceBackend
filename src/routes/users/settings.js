async function settingsRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // GET user settings profile
  fastify.get("/profile", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        companyName: true,
        companyEmail: true,
        companyPhone: true,
        address: true,
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
        waSendsUsed: true,
        emailSendsUsed: true,
        waRemindersUsed: true,
        emailRemindersUsed: true,
        aiUsed: true,
        whatsappSendTemplate: true,
        whatsappReminderTemplate: true,
        whatsappMode: true,
        twilioSid: true,
        twilioAuthToken: true,
        twilioPhoneNumber: true,
        whatsappReminderInterval: true,
      },
    });

    if (!user) {
      return reply.notFound("User not found");
    }

    return user;
  });

  // PUT update user settings profile
  fastify.put("/profile", async (request, reply) => {
    const data = request.body;

    // Fetch the current user to compare values and check plan
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        plan: true,
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
    });

    if (!user) {
      return reply.notFound("User not found");
    }

    // Check if user is FREE before allowing WhatsApp settings updates
    const whatsappFields = [
      "whatsappSendTemplate",
      "whatsappReminderTemplate",
      "whatsappMode",
      "twilioSid",
      "twilioAuthToken",
      "twilioPhoneNumber",
      "whatsappReminderInterval",
    ];

    const isUpdatingWhatsapp = whatsappFields.some(
      (field) => data[field] !== undefined && data[field] !== user[field],
    );

    const isUpdatingReminders =
      (data.reminderInterval !== undefined &&
        data.reminderInterval !== user.reminderInterval) ||
      (data.globalAutoChaser !== undefined &&
        data.globalAutoChaser !== user.globalAutoChaser);

    const isProTier = ["PRO", "MAX"].includes(user.plan);

    if (!isProTier) {
      // Block enabling Global Automation (Chaser)
      if (data.globalAutoChaser === true && !user.globalAutoChaser) {
        return reply.forbidden("Upgrade to Pro to enable Global Automation");
      }
      // Block setting non-zero reminder intervals (Email or WhatsApp)
      if (
        (data.reminderInterval && data.reminderInterval !== 0) ||
        (data.whatsappReminderInterval && data.whatsappReminderInterval !== 0)
      ) {
        return reply.forbidden("Upgrade to Pro to enable automated reminders");
      }
    }

    if (user.plan === "FREE") {
      if (isUpdatingWhatsapp) {
        return reply.forbidden("Upgrade to Pro to configure WhatsApp settings");
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id: request.user.id },
      data: {
        companyName: data.companyName,
        companyEmail: data.companyEmail,
        companyPhone: data.companyPhone,
        address: data.address,
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
    });

    return {
      success: true,
      message: "Settings updated successfully",
      user: updatedUser,
    };
  });
}

module.exports = settingsRoutes;
