async function systemRoutes(fastify, opts) {
  const { prisma } = fastify;

  // GET / - Get system configuration
  fastify.get("/", async (request, reply) => {
    try {
      let config = await prisma.systemConfiguration.findFirst();
      
      // Initialize if doesn't exist
      if (!config) {
        config = await prisma.systemConfiguration.create({
          data: {
            whatsappEnabled: true,
            emailEnabled: true,
            invoiceCreationEnabled: true,
            paymentsEnabled: true,
            globalNotice: null,
            maintenanceMode: false,
          }
        });
      }
      
      return config;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to fetch system configuration");
    }
  });

  // PATCH / - Update system configuration
  fastify.patch("/", async (request, reply) => {
    try {
      const { 
        whatsappEnabled, 
        emailEnabled, 
        invoiceCreationEnabled, 
        paymentsEnabled, 
        globalNotice, 
        maintenanceMode 
      } = request.body;

      const currentConfig = await prisma.systemConfiguration.findFirst();
      
      if (!currentConfig) {
        return prisma.systemConfiguration.create({
          data: {
            whatsappEnabled: whatsappEnabled ?? true,
            emailEnabled: emailEnabled ?? true,
            invoiceCreationEnabled: invoiceCreationEnabled ?? true,
            paymentsEnabled: paymentsEnabled ?? true,
            globalNotice: globalNotice ?? null,
            maintenanceMode: maintenanceMode ?? false,
          }
        });
      }

      const updatedConfig = await prisma.systemConfiguration.update({
        where: { id: currentConfig.id },
        data: {
          ...(whatsappEnabled !== undefined && { whatsappEnabled }),
          ...(emailEnabled !== undefined && { emailEnabled }),
          ...(invoiceCreationEnabled !== undefined && { invoiceCreationEnabled }),
          ...(paymentsEnabled !== undefined && { paymentsEnabled }),
          ...(globalNotice !== undefined && { globalNotice }),
          ...(maintenanceMode !== undefined && { maintenanceMode }),
        }
      });

      return updatedConfig;
    } catch (error) {
      fastify.log.error(error);
      return reply.internalServerError("Failed to update system configuration");
    }
  });
}

module.exports = systemRoutes;
