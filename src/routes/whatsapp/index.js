const { sen } = require("../../utils/invoiceMoney");

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
        const invoice = await fastify.prisma.invoice.findUnique({
          where: { id: parseInt(id), userId: request.user.id },
          include: {
            client: true,
          },
        });

        if (!invoice) return reply.notFound("Invoice not found");
        if (!invoice.client.phone)
          return reply.badRequest("Client does not have a phone number");

        /* Metering is per invoice now, not per message, so the check has to sit
           after we know which invoice this is. The first WhatsApp message for an
           invoice consumes one chased invoice; later messages for the same
           invoice in the same period consume none, but still count against the
           per-invoice ceiling. */
        const decision = await fastify.chase.canChase(request.user.id, invoice.id);
        if (!decision.allowed) {
          return reply.forbidden(
            decision.reason === "chased invoice allowance exhausted"
              ? "Your WhatsApp allowance for this period is used up. Automatic reminders will still go out by email, or you can top up."
              : `Cannot send over WhatsApp: ${decision.reason}`,
          );
        }

        const user = await fastify.prisma.user.findUnique({
          where: { id: request.user.id },
          select: { notification: true, profile: { select: { name: true, companyName: true } } },
        });
        const notif = user?.notification || {};
        const profile = user?.profile || {};

        const template =
          notif.whatsappSendTemplate ||
          "{{userName}} {{companyName}} via InvoKita\n\nHello {{clientName}}, here is your invoice {{invoiceNumber}} for {{totalAmount}} {{currency}}. Due on {{dueDate}}. View here: {{invoiceUrl}}";

        const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/['"]/g, "").replace(/\/$/, "") : "http://localhost:3000";
        const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;

        const message = template
          .replace(/{{userName}}/g, profile.name || "")
          .replace(/{{companyName}}/g, profile.companyName || "InvoKita User")
          .replace(/{{clientName}}/g, invoice.client.name)
          .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
          /* `sen()`, not toLocaleString(): amounts are sen, so the raw value
             asked a client for "50,000" on a RM500 invoice — in a WhatsApp
             message, which cannot be edited once sent. */
          .replace(/{{totalAmount}}/g, sen(invoice.amount))
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
        if (notif.whatsappMode === "CUSTOM") {
          credentials = {
            sid: notif.twilioSid,
            token: notif.twilioAuthToken,
            phoneNumber: notif.twilioPhoneNumber,
          };
        }

        await fastify.whatsapp.sendMessage(
          invoice.client.phone,
          message,
          credentials,
        );

        await fastify.chase.consumeChase(request.user.id, invoice.id, decision);
        await fastify.chase.logMessage({
          userId: request.user.id,
          invoiceId: invoice.id,
          channel: "WHATSAPP",
          purpose: "SEND",
          category: "UTILITY",
        });

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
        const invoice = await fastify.prisma.invoice.findUnique({
          where: { id: parseInt(id), userId: request.user.id },
          include: {
            client: true,
          },
        });

        if (!invoice) return reply.notFound("Invoice not found");
        if (!invoice.client.phone)
          return reply.badRequest("Client does not have a phone number");

        /* Metering is per invoice now, not per message, so the check has to sit
           after we know which invoice this is. The first WhatsApp message for an
           invoice consumes one chased invoice; later messages for the same
           invoice in the same period consume none, but still count against the
           per-invoice ceiling. */
        const decision = await fastify.chase.canChase(request.user.id, invoice.id);
        if (!decision.allowed) {
          return reply.forbidden(
            decision.reason === "chased invoice allowance exhausted"
              ? "Your WhatsApp allowance for this period is used up. Automatic reminders will still go out by email, or you can top up."
              : `Cannot send over WhatsApp: ${decision.reason}`,
          );
        }

        const user = await fastify.prisma.user.findUnique({
          where: { id: request.user.id },
          select: { notification: true, profile: { select: { name: true, companyName: true } } },
        });
        const notif = user?.notification || {};
        const profile = user?.profile || {};

        const template =
          notif.whatsappReminderTemplate ||
          "{{userName}} {{companyName}} via InvoKita\n\nFriendly reminder for {{clientName}}: Your invoice {{invoiceNumber}} ({{totalAmount}} {{currency}}) is due on {{dueDate}}. Please ignore if already paid.";

        const frontendUrl = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/['"]/g, "").replace(/\/$/, "") : "http://localhost:3000";
        const invoiceUrl = `${frontendUrl}/pay/${invoice.id}`;

        const message = template
          .replace(/{{userName}}/g, profile.name || "")
          .replace(/{{companyName}}/g, profile.companyName || "InvoKita User")
          .replace(/{{clientName}}/g, invoice.client.name)
          .replace(/{{invoiceNumber}}/g, invoice.invoiceNumber || invoice.id)
          /* `sen()`, not toLocaleString(): amounts are sen, so the raw value
             asked a client for "50,000" on a RM500 invoice — in a WhatsApp
             message, which cannot be edited once sent. */
          .replace(/{{totalAmount}}/g, sen(invoice.amount))
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
        if (notif.whatsappMode === "CUSTOM") {
          credentials = {
            sid: notif.twilioSid,
            token: notif.twilioAuthToken,
            phoneNumber: notif.twilioPhoneNumber,
          };
        }

        await fastify.whatsapp.sendMessage(
          invoice.client.phone,
          message,
          credentials,
        );

        await fastify.chase.consumeChase(request.user.id, invoice.id, decision);
        await fastify.chase.logMessage({
          userId: request.user.id,
          invoiceId: invoice.id,
          channel: "WHATSAPP",
          purpose: "REMINDER",
          category: "UTILITY",
        });

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
