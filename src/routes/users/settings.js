async function settingsRoutes(fastify, opts) {
  const { prisma } = fastify;

  // Apply authentication
  fastify.addHook("onRequest", fastify.authenticate);

  // GET user settings
  fastify.get("/", async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        whatsappSendTemplate: true,
        whatsappReminderTemplate: true,
        whatsappMode: true,
        twilioSid: true,
        twilioAuthToken: true,
        twilioPhoneNumber: true,
      },
    });

    if (!user) {
      return reply.notFound("User not found");
    }

    return user;
  });

  // PUT update user settings
  fastify.put("/", async (request, reply) => {
    const data = request.body;

    const updatedUser = await prisma.user.update({
      where: { id: request.user.id },
      data: {
        whatsappSendTemplate: data.whatsappSendTemplate,
        whatsappReminderTemplate: data.whatsappReminderTemplate,
        whatsappMode: data.whatsappMode,
        twilioSid: data.twilioSid,
        twilioAuthToken: data.twilioAuthToken,
        twilioPhoneNumber: data.twilioPhoneNumber,
      },
      select: {
        whatsappSendTemplate: true,
        whatsappReminderTemplate: true,
        whatsappMode: true,
        twilioSid: true,
        twilioAuthToken: true,
        twilioPhoneNumber: true,
      },
    });

    return updatedUser;
  });
}

module.exports = settingsRoutes;
