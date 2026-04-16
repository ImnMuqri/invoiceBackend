const { Resend } = require("resend");
const { Webhook } = require("svix");

async function supportRoutes(fastify, opts) {
  const { prisma } = fastify;
  const resend = new Resend(process.env.RESEND_API_KEY);
  const supportResend = new Resend(process.env.RESEND_SUPPORT_KEY);

  /**
   * INBOUND WEBHOOK (Public)
   * Receives emails from Resend Inbound Parse
   */
  fastify.post("/webhook", async (request, reply) => {
    fastify.log.info({ headers: request.headers }, "Resend Webhook Headers");
    
    // 1. Verify Signature
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      const headers = {
        "svix-id": request.headers["svix-id"],
        "svix-timestamp": request.headers["svix-timestamp"],
        "svix-signature": request.headers["svix-signature"],
      };

      try {
        const wh = new Webhook(secret);
        wh.verify(request.rawBody, headers);
        fastify.log.info("Resend Webhook Signature Verified");
      } catch (err) {
        fastify.log.error({ err, headers }, "Invalid Resend Webhook Signature");
        return reply.badRequest("Invalid signature");
      }
    }

    const payload = request.body;
    fastify.log.info({ 
      keys: Object.keys(payload),
      hasData: !!payload.data,
      dataType: typeof payload.data 
    }, "Resend Webhook Structure Audit");
    fastify.log.info({ payload }, "Resend Webhook Full Payload");
    
    // Resend webhooks often wrap the email data in a 'data' property
    const data = payload.data || payload;

    // Resend Inbound fields: from, to, subject, text, html, id
    // We check both payload and nested data to be safe
    const rawFrom = data.from || payload.from || "";
    let fromEmail = "";
    let fromName = "";

    if (typeof rawFrom === 'string' && rawFrom) {
      fromEmail = rawFrom.match(/<([^>]+)>/)?.[1] || rawFrom;
      fromName = rawFrom.match(/^([^<]+)/)?.[1]?.trim() || "";
    } else if (typeof rawFrom === 'object' && rawFrom !== null) {
      fromEmail = rawFrom.email || "";
      fromName = rawFrom.name || "";
    }
    
    const subject = data.subject || payload.subject || "No Subject";
    const textContent = data.text || payload.text || "";
    const htmlContent = data.html || payload.html || "";
    const content = textContent || htmlContent || "No Content";
    const resendId = data.id || payload.id || data.resendId;

    if (!fromEmail) {
      fastify.log.warn("Resend Webhook: fromEmail is empty, skipping ticket creation");
      return reply.badRequest("Missing fromEmail");
    }

    try {
      // Find existing ticket by fromEmail and subject (simple threading)
      // Or by resendId if it's a direct reply thread
      let ticket = await prisma.ticket.findFirst({
        where: {
          fromEmail: fromEmail,
          status: { not: "CLOSED" },
          subject: { contains: subject.replace("Re: ", "").replace("RE: ", "") }
        },
        orderBy: { createdAt: "desc" }
      });

      if (!ticket) {
        // Find user by email to link
        const user = await prisma.user.findUnique({ where: { email: fromEmail } });

        ticket = await prisma.ticket.create({
          data: {
            subject,
            fromEmail,
            fromName,
            status: "OPEN",
            resendId,
            userId: user ? user.id : null
          }
        });

        // NOTIFY ADMIN (Trigger a notification for Admin only)
        const admins = await prisma.user.findMany({ where: { role: "ADMIN" } });
        for (const admin of admins) {
          await prisma.appNotification.create({
            data: {
              userId: admin.id,
              title: "New Support Ticket",
              message: `New ticket from ${fromEmail}: ${subject}`,
              type: "SUPPORT_TICKET"
            }
          });
        }
      }

      // Add message to ticket
      await prisma.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          sender: "USER",
          content
        }
      });

      // Update ticket updated timestamp
      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { updatedAt: new Date() }
      });

      return { success: true };
    } catch (err) {
      fastify.log.error(err, "Error processing support webhook");
      return reply.internalServerError("Webhook failed");
    }
  });

  /**
   * ADMIN ROUTES (Requires Authentication)
   */
  fastify.register(async (adminRoutes) => {
    adminRoutes.addHook("onRequest", fastify.authenticate);
    adminRoutes.addHook("onRequest", fastify.isAdmin);

    // List all tickets
    adminRoutes.get("/", async (request, reply) => {
      const tickets = await prisma.ticket.findMany({
        include: {
          user: {
            select: { email: true, plan: true }
          },
          _count: {
            select: { messages: true }
          }
        },
        orderBy: { updatedAt: "desc" }
      });
      return tickets;
    });

    // Get single ticket with thread
    adminRoutes.get("/:id", async (request, reply) => {
      const { id } = request.params;
      const ticket = await prisma.ticket.findUnique({
        where: { id: parseInt(id) },
        include: {
          user: {
            select: { id: true, email: true, plan: true }
          },
          messages: {
            orderBy: { createdAt: "asc" }
          }
        }
      });
      if (!ticket) return reply.notFound("Ticket not found");
      return ticket;
    });

    // Admin reply to ticket
    adminRoutes.post("/:id/reply", async (request, reply) => {
      const { id } = request.params;
      const { content, closeTicket } = request.body;

      const ticket = await prisma.ticket.findUnique({
        where: { id: parseInt(id) }
      });

      if (!ticket) return reply.notFound("Ticket not found");

      try {
        // 1. Send email via Resend (using Support Key)
        await supportResend.emails.send({
          from: "InvoKita Support <support@invokita.my>",
          to: ticket.fromEmail,
          subject: `Re: ${ticket.subject}`,
          text: content
        });

        // 2. Save message to DB
        await prisma.ticketMessage.create({
          data: {
            ticketId: ticket.id,
            sender: "ADMIN",
            content
          }
        });

        // 3. Update status
        await prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            status: closeTicket ? "CLOSED" : "PENDING",
            updatedAt: new Date()
          }
        });

        return { success: true };
      } catch (err) {
        fastify.log.error(err, "Error replying to ticket");
        return reply.internalServerError("Failed to send reply");
      }
    });

    // Manual status change
    adminRoutes.patch("/:id/status", async (request, reply) => {
      const { id } = request.params;
      const { status } = request.body;
      await prisma.ticket.update({
        where: { id: parseInt(id) },
        data: { status }
      });
      return { success: true };
    });
  });
}

module.exports = supportRoutes;
