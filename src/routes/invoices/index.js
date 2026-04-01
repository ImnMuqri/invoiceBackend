async function invoiceRoutes(fastify, opts) {
  const { prisma } = fastify;

  // PUBLIC ROUTES (No Auth Required)
  // GET invoice by ID (Public for payment page)
  fastify.get("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        client: true,
        items: true,
        user: {
          select: {
            plan: true,
            manualBankName: true,
            manualAccountNumber: true,
            manualAccountName: true,
            manualQrCode: true,
            paymentProviders: {
              where: { isActive: true, isPreferred: true },
              select: {
                id: true,
                provider: true,
              },
            },
          },
        },
      },
    });
    if (!invoice) {
      return reply.notFound("Invoice not found");
    }
    return invoice;
  });

  // GET invoice PDF (Public for payment page)
  fastify.get("/:id/pdf", async (request, reply) => {
    const id = Number(request.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
    });

    if (!invoice) return reply.notFound("Invoice not found");

    // Public URL for PDF generation (Using more professional export layout)
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
    const publicUrl = `${frontendUrl}/invoices/${id}/export`;

    try {
      const pdfBuffer = await fastify.generatePDF(publicUrl);
      reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `attachment; filename=Invoice-${invoice.invoiceNumber}.pdf`,
        )
        .send(pdfBuffer);
    } catch (err) {
      fastify.log.error(err);
      return reply.internalServerError("Failed to generate PDF");
    }
  });

  // PROTECTED ROUTES (Auth Required)
  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    // GET all invoices
    protectedInstance.get("/", async (request, reply) => {
      return prisma.invoice.findMany({
        where: { userId: request.user.id },
        include: { client: true },
        orderBy: { date: "desc" },
      });
    });

    // POST create invoice
    protectedInstance.post("/", async (request, reply) => {
      // Enforce usage limits BEFORE doing anything else
      try {
        await fastify.usage.checkAndIncrement(request.user.id, "invoice");
      } catch (err) {
        if (err.statusCode === 403) return reply.forbidden(err.message);
        throw err;
      }

      const {
        clientId,
        items,
        template,
        fromCompanyName,
        usedAi,
        ...invoiceData
      } = request.body;

      // Handle AI usage increment if the builder was used
      if (usedAi) {
        try {
          await fastify.usage.checkAndIncrement(request.user.id, "ai");
        } catch (err) {
          if (err.statusCode === 403) return reply.forbidden(err.message);
          throw err;
        }
      }

      // Calculate amount from items if not provided
      const amount =
        invoiceData.amount ||
        items.reduce((sum, item) => sum + item.price * item.quantity, 0);

      const invoice = await prisma.invoice.create({
        data: {
          ...invoiceData,
          fromCompanyName,
          amount,
          template: template || "professional",
          user: { connect: { id: request.user.id } },
          client: { connect: { id: Number(clientId) } },
          items: {
            create: items.map((item) => ({
              ...item,
              total: item.price * item.quantity,
            })),
          },
        },
        include: { items: true, client: true },
      });

      // Update with ID-based invoice number
      const updatedInvoice = await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          invoiceNumber: `INVK-${invoice.id.toString().padStart(4, "0")}`,
        },
        include: { items: true, client: true },
      });

      return { ...updatedInvoice, message: "Invoice created successfully" };
    });

    // PUT update invoice
    protectedInstance.put("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const {
        clientId,
        items,
        invoiceNumber,
        template,
        fromCompanyName,
        usedAi,
        ...invoiceData
      } = request.body;

      // Handle AI usage increment if the builder was used in this session
      if (usedAi) {
        try {
          await fastify.usage.checkAndIncrement(request.user.id, "ai");
        } catch (err) {
          if (err.statusCode === 403) return reply.forbidden(err.message);
          throw err;
        }
      }

      const updateData = {
        ...invoiceData,
        fromCompanyName,
        template: template || "professional",
        invoiceNumber: `INVK-${id.toString().padStart(4, "0")}`,
      };

      // Only handle amount if explicitly provided or items changed
      if (request.body.amount !== undefined) {
        updateData.amount = request.body.amount;
      } else if (items && items.length > 0) {
        updateData.amount = items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0,
        );
      }

      if (clientId) {
        updateData.client = { connect: { id: Number(clientId) } };
      }

      if (items) {
        updateData.items = {
          deleteMany: {}, // Clear old items
          create: items.map((item) => ({
            name: item.name,
            price: item.price,
            quantity: item.quantity,
            total: item.price * item.quantity,
          })),
        };
      }

      const invoice = await prisma.invoice.update({
        where: { id, userId: request.user.id },
        data: updateData,
        include: { items: true, client: true },
      });

      return { ...invoice, message: "Invoice updated successfully" };
    });

    // DELETE invoice
    protectedInstance.delete("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      await prisma.invoice.delete({
        where: { id, userId: request.user.id },
      });
      return { success: true, message: "Invoice deleted successfully" };
    });
  });

  fastify.post(
    "/:id/send",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number(request.params.id);
      const { method, email, isReminder } = request.body; // method: 'email' or 'whatsapp'

      const invoice = await prisma.invoice.findFirst({
        where: { id, userId: request.user.id },
        include: { client: true },
      });

      if (!invoice) return reply.notFound("Invoice not found");

      if (invoice.status === "Paid") {
        return reply.badRequest(
          "Cannot send communications for an invoice that is already paid",
        );
      }

      const frontendUrl = process.env.FRONTEND_URL
        ? process.env.FRONTEND_URL.replace(/['"]/g, "")
        : "http://localhost:3000";
      const publicUrl = `${frontendUrl.replace(/\/$/, "")}/pay/${id}`;

      if (method === "email") {
        const targetEmail = email || invoice.client.email;
        if (!targetEmail) return reply.badRequest("No email provided");

        try {
          // Usage check
          await fastify.usage.checkAndIncrement(
            request.user.id,
            isReminder ? "emailReminder" : "emailSend",
          );

          // Fetch user for personalization
          const user = await prisma.user.findUnique({
            where: { id: request.user.id },
          });

          // Generate PDF
          // For local development, we must use localhost so Puppeteer can reach the local frontend
          // Even if FRONTEND_URL is set to production, local Puppeteer can't reach local data on a production URL.
          // Simplified: check if we are local based on the frontend URL
          const isLocal =
            frontendUrl.includes("localhost") ||
            frontendUrl.includes("127.0.0.1");
          const pdfBaseUrl = isLocal ? "http://localhost:3000" : frontendUrl;
          const pdfGenerateUrl = `${pdfBaseUrl.replace(/\/$/, "")}/invoices/${id}/export`;

          fastify.log.info(
            { pdfGenerateUrl, frontendUrl, publicUrl, isLocal },
            "Generating PDF for invoice email",
          );

          let pdfBuffer = await fastify.generatePDF(pdfGenerateUrl);

          // Ensure it's a standard Buffer for Resend
          if (pdfBuffer && !(pdfBuffer instanceof Buffer)) {
            pdfBuffer = Buffer.from(pdfBuffer);
          }

          fastify.log.info(
            { pdfSize: pdfBuffer?.length },
            "PDF generated for attachment",
          );

          // Check if user has a preferred payment provider
          const preferredProvider = await prisma.paymentProvider.findFirst({
            where: {
              userId: request.user.id,
              isActive: true,
              isPreferred: true,
            },
          });

          // Get template
          const {
            getInvoiceEmailTemplate,
          } = require("../../utils/emailTemplates");
          const html = getInvoiceEmailTemplate({
            clientName: invoice.client.name,
            senderName: user.name || "Our Company",
            senderCompany: user.companyName,
            invoiceNumber: invoice.invoiceNumber || `#${id}`,
            amount: invoice.amount,
            currency: invoice.currency,
            dueDate: invoice.dueDate,
            status: isReminder
              ? "Payment Reminder"
              : invoice.status === "Pending" &&
                  new Date(invoice.dueDate) < new Date()
                ? "Overdue"
                : invoice.status,
            publicUrl,
            isPayable: !!preferredProvider,
          });

          const subjectPrefix = isReminder ? "REMINDER: " : "";

          await fastify.email.send({
            to: targetEmail,
            subject: `${subjectPrefix}Invoice ${invoice.invoiceNumber || id} from ${user.companyName || user.name}`,
            html,
            attachments: pdfBuffer
              ? [
                  {
                    filename: `Invoice_${invoice.invoiceNumber || id}.pdf`,
                    content: pdfBuffer,
                  },
                ]
              : [],
          });

          // Update last sent date
          await prisma.invoice.update({
            where: { id },
            data: { emailLastSent: new Date() },
          });

          return {
            success: true,
            message: isReminder ? "Reminder email sent" : "Email sent",
          };
        } catch (err) {
          fastify.log.error(err);
          // If usage check fails (403), pass the error through
          if (err.statusCode === 403) throw err;
          return reply.internalServerError("Failed to send email");
        }
      } else if (method === "whatsapp") {
        const user = await prisma.user.findUnique({
          where: { id: request.user.id },
          select: { plan: true },
        });

        if (user.plan === "FREE") {
          return reply.forbidden(
            "Upgrade to Pro to send invoices via WhatsApp",
          );
        }

        // For WhatsApp, we return a sharing link
        // This is usually handled on the frontend for better UX (opening the app)
        // but we can provide the formatted text/link here.
        const greeting = isReminder
          ? `Friendly reminder for ${invoice.client.name}`
          : `Hi ${invoice.client.name}`;
        const actionText = isReminder
          ? `your invoice ${invoice.invoiceNumber} is awaiting payment`
          : `your invoice ${invoice.invoiceNumber} is ready`;

        const text = encodeURIComponent(
          `${greeting}, ${actionText}: ${publicUrl}. Please ignore if already paid.`,
        );

        // Update last sent date (since we are generating the link to send)
        await prisma.invoice.update({
          where: { id },
          data: { whatsappLastSent: new Date() },
        });

        const waLink = `https://wa.me/${invoice.client.phone?.replace(/\D/g, "")}?text=${text}`;
        return { success: true, waLink };
      }

      return reply.badRequest("Invalid delivery method");
    },
  );
}

module.exports = invoiceRoutes;
