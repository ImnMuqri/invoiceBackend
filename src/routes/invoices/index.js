async function invoiceRoutes(fastify, opts) {
  const { prisma } = fastify;

  // PUBLIC ROUTES (No Auth Required)
  // GET invoice by ID (Public for payment page)
  fastify.get("/:id", async (request, reply) => {
    const id = Number(request.params.id);
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: { client: true, items: true },
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
    const publicUrl = `http://localhost:3000/invoices/${id}/export`;

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
      const { clientId, items, template, ...invoiceData } = request.body;

      // Calculate amount from items if not provided
      const amount =
        invoiceData.amount ||
        items.reduce((sum, item) => sum + item.price * item.quantity, 0);

      const invoice = await prisma.invoice.create({
        data: {
          ...invoiceData,
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
          invoiceNumber: `INV-${invoice.id.toString().padStart(4, "0")}`,
        },
        include: { items: true, client: true },
      });

      return updatedInvoice;
    });

    // PUT update invoice
    protectedInstance.put("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const { clientId, items, invoiceNumber, template, ...invoiceData } =
        request.body;

      // Calculate amount from items if not provided
      const amount =
        invoiceData.amount ||
        (items && items.length > 0
          ? items.reduce((sum, item) => sum + item.price * item.quantity, 0)
          : 0);

      const updateData = {
        ...invoiceData,
        amount,
        template: template || "professional",
        invoiceNumber: `INV-${id.toString().padStart(4, "0")}`,
      };

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

      return invoice;
    });

    // DELETE invoice
    protectedInstance.delete("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      await prisma.invoice.delete({
        where: { id, userId: request.user.id },
      });
      return { success: true };
    });
  });

  fastify.post(
    "/:id/send",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = Number(request.params.id);
      const { method, email } = request.body; // method: 'email' or 'whatsapp'

      const invoice = await prisma.invoice.findFirst({
        where: { id, userId: request.user.id },
        include: { client: true },
      });

      if (!invoice) return reply.notFound("Invoice not found");

      const publicUrl = `http://localhost:3000/pay/${id}`;

      if (method === "email") {
        const targetEmail = email || invoice.client.email;
        if (!targetEmail) return reply.badRequest("No email provided");

        try {
          // Usage check
          await fastify.usage.checkAndIncrement(request.user.id, "emailSend");

          await fastify.mailer.sendMail({
            from: `"InvoKita" <no-reply@invokita.com>`,
            to: targetEmail,
            subject: `Invoice ${invoice.invoiceNumber} from InvoKita`,
            text: `Hi ${invoice.client.name}, your invoice is ready. View it here: ${publicUrl}`,
            html: `<p>Hi ${invoice.client.name},</p><p>Your invoice <b>${invoice.invoiceNumber}</b> is ready.</p><p><a href="${publicUrl}">Click here to view and pay</a></p>`,
          });
          return { success: true, message: "Email sent" };
        } catch (err) {
          fastify.log.error(err);
          // If usage check fails (403), pass the error through
          if (err.statusCode === 403) throw err;
          return reply.internalServerError("Failed to send email");
        }
      } else if (method === "whatsapp") {
        // For WhatsApp, we return a sharing link
        // This is usually handled on the frontend for better UX (opening the app)
        // but we can provide the formatted text/link here.
        const text = encodeURIComponent(
          `Hi ${invoice.client.name}, your invoice ${invoice.invoiceNumber} is ready: ${publicUrl}`,
        );
        const waLink = `https://wa.me/${invoice.client.phone?.replace(/\D/g, "")}?text=${text}`;
        return { success: true, waLink };
      }

      return reply.badRequest("Invalid delivery method");
    },
  );
}

module.exports = invoiceRoutes;
