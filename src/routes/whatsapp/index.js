async function whatsappRoutes(fastify, opts) {
  // Manual trigger for automated chaser (for testing/admin)
  fastify.post(
    "/whatsapp/run-chaser",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      try {
        await fastify.runReminderJob();
        return {
          message: "Automated reminder chaser job started successfully.",
        };
      } catch (error) {
        fastify.log.error(error);
        return reply.internalServerError("Failed to run reminder job");
      }
    },
  );

  // Send specific invoice via WhatsApp
  fastify.post(
    "/whatsapp/send/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        // Usage check
        await fastify.usage.checkAndIncrement(request.user.id, "waSend");

        const invoice = await fastify.prisma.invoice.findUnique({
          where: { id: parseInt(id) },
          include: {
            client: true,
          },
        });

        if (!invoice) return reply.notFound("Invoice not found");
        if (!invoice.client.phone)
          return reply.badRequest("Client does not have a phone number");

        const user = await fastify.prisma.user.findUnique({
          where: { id: request.user.id },
        });

        const template =
          user?.whatsappSendTemplate ||
          "{{userName}} {{companyName}} via InvoKita\n\nHello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}";

        const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/['"]/g, "").replace(/\/$/, "") : "http://localhost:3000";
        const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;

        const message = template
          .replace(/{{userName}}/g, user.name || "")
          .replace(/{{companyName}}/g, user.companyName || "InvoKita User")
          .replace(/{{clientName}}/g, invoice.client.name)
          .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
          .replace(/{{totalAmount}}/g, invoice.amount.toLocaleString())
          .replace(/{{currency}}/g, invoice.currency)
          .replace(/{{invoiceUrl}}/g, invoiceUrl)
          .replace(
            /{{dueDate}}/g,
            new Date(invoice.dueDate).toLocaleDateString("en-US", {
              day: "numeric",
              month: "short",
              year: "numeric",
            }),
          );

        let credentials = null;
        if (user.whatsappMode === "CUSTOM") {
          credentials = {
            sid: user.twilioSid,
            token: user.twilioAuthToken,
            phoneNumber: user.twilioPhoneNumber,
          };
        }

        await fastify.whatsapp.sendMessage(
          invoice.client.phone,
          message,
          credentials,
        );

        await fastify.prisma.invoice.update({
          where: { id: parseInt(id) },
          data: { whatsappStatus: "Sent" },
        });

        return { message: "WhatsApp message sent successfully" };
      } catch (error) {
        fastify.log.error(error);
        return reply.internalServerError("Failed to send WhatsApp message");
      }
    },
  );

  // Send manual reminder for specific invoice via WhatsApp
  fastify.post(
    "/whatsapp/remind/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        // Usage check
        await fastify.usage.checkAndIncrement(request.user.id, "waReminder");

        const invoice = await fastify.prisma.invoice.findUnique({
          where: { id: parseInt(id) },
          include: {
            client: true,
          },
        });

        if (!invoice) return reply.notFound("Invoice not found");
        if (!invoice.client.phone)
          return reply.badRequest("Client does not have a phone number");

        const user = await fastify.prisma.user.findUnique({
          where: { id: request.user.id },
        });

        const template =
          user?.whatsappReminderTemplate ||
          "{{userName}} {{companyName}} via InvoKita\n\nFriendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.";

        const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/['"]/g, "").replace(/\/$/, "") : "http://localhost:3000";
        const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;

        const message = template
          .replace(/{{userName}}/g, user.name || "")
          .replace(/{{companyName}}/g, user.companyName || "InvoKita User")
          .replace(/{{clientName}}/g, invoice.client.name)
          .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
          .replace(/{{totalAmount}}/g, invoice.amount.toLocaleString())
          .replace(/{{currency}}/g, invoice.currency)
          .replace(/{{invoiceUrl}}/g, invoiceUrl)
          .replace(
            /{{dueDate}}/g,
            new Date(invoice.dueDate).toLocaleDateString("en-US", {
              day: "numeric",
              month: "short",
              year: "numeric",
            }),
          );

        let credentials = null;
        if (user.whatsappMode === "CUSTOM") {
          credentials = {
            sid: user.twilioSid,
            token: user.twilioAuthToken,
            phoneNumber: user.twilioPhoneNumber,
          };
        }

        await fastify.whatsapp.sendMessage(
          invoice.client.phone,
          message,
          credentials,
        );

        await fastify.prisma.invoice.update({
          where: { id: parseInt(id) },
          data: {
            whatsappStatus: "Sent",
            whatsappLastReminderSent: new Date(),
          },
        });

        return { message: "WhatsApp reminder sent successfully" };
      } catch (error) {
        fastify.log.error(error);
        return reply.internalServerError("Failed to send WhatsApp reminder");
      }
    },
  );
}

module.exports = whatsappRoutes;
