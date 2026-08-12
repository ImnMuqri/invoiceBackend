const {
  renderInvoiceMessage,
  renderQuoteMessage,
  waShareUrl,
} = require("../../utils/whatsappMessage");
const {
  ensurePublicToken,
  publicQuoteUrl,
} = require("../../utils/quoteLifecycle");

/** FRONTEND_URL, minus the quoting and trailing slash people leave in .env. */
function frontendOrigin() {
  return (process.env.FRONTEND_URL || "http://localhost:3000")
    .replace(/['"]/g, "")
    .replace(/\/$/, "");
}

async function whatsappRoutes(fastify, opts) {
  // Manual trigger for automated chaser (for testing/admin)
  fastify.post(
    "/run-chaser",
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
    "/send/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const invoice = await fastify.prisma.invoice.findFirst({
          /* INVOICES ONLY (spec 07).
             This had no kind filter, and quotations share this table — so a
             quote id here sent a client a message reading "here is your invoice
             QUO-0018 ... Due on Invalid Date", and worse, consumeChase() below
             would stamp chasedInPeriod on the quotation. That is a chase cycle
             opened on a document the spec says must never be chased. Quotes go
             out through POST /api/quotes/:id/send, which words the message
             correctly and links to the accept/decline page. */
          where: { id: parseInt(id), kind: "INVOICE", userId: request.user.id },
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

        /* Composed by utils/whatsappMessage so this, the reminder below, the
           quotation send and both manual share links produce the same words from
           the same template. The four hand-rolled copies this replaces had
           already drifted from each other and from the settings preview. */
        const message = renderInvoiceMessage({
          purpose: "send",
          template: notif.whatsappSendTemplate,
          invoice,
          profile,
          invoiceUrl: `${frontendOrigin()}/pay/${invoice.id}`,
        });

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
    "/remind/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const invoice = await fastify.prisma.invoice.findFirst({
          /* Invoices only — see the send route above. A reminder is by
             definition a chase, and a quotation is never chased. */
          where: { id: parseInt(id), kind: "INVOICE", userId: request.user.id },
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

        const message = renderInvoiceMessage({
          purpose: "remind",
          template: notif.whatsappReminderTemplate,
          invoice,
          profile,
          invoiceUrl: `${frontendOrigin()}/pay/${invoice.id}`,
        });

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

  /* ── Manual share ──────────────────────────────────────────────────────────
     Compose the message and hand back a wa.me link. The user's own WhatsApp
     sends it — we do not.

     This exists because Twilio is not settled yet, and it is the honest version
     of that situation: the wording, the document reference and the link are all
     the ones the automated send would use, so a business that shares by hand
     today sounds identical to one sending through us tomorrow.

     What these routes deliberately do NOT do, all for the same reason — nothing
     has been sent by us and we cannot know whether the sender went through with
     it:

       * no chase metering. consumeChase() would spend a paid allowance on a
         message we did not deliver, on a click that might have been curiosity.
       * no whatsappStatus = "Sent". That column drives the chaser and the
         client-facing "sent" state; setting it from a share would mark an
         invoice delivered on the strength of a browser tab opening.
       * no message log entry, for the same reason.
       * no plan gate. There is nothing metered to gate, and putting a paywall on
         "copy my own words into my own WhatsApp" would be charging for the
         clipboard.

     GET, because it is a read: composing text has no side effects, and it stays
     safe to retry. */

  /** The sender's profile and template row, which both share routes need. */
  const senderContext = async (userId) => {
    const user = await fastify.prisma.user.findUnique({
      where: { id: userId },
      select: {
        notification: { select: { whatsappSendTemplate: true } },
        profile: { select: { name: true, companyName: true } },
      },
    });
    return {
      notif: user?.notification || {},
      profile: user?.profile || {},
    };
  };

  fastify.get(
    "/share/invoice/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!Number.isInteger(id)) return reply.badRequest("Invalid invoice id");

      /* kind: "INVOICE" for the same reason the send route filters on it — a
         quotation id here would produce "here is your invoice QUO-0018 … due
         Invalid Date". Quotations have their own route below. */
      const invoice = await fastify.prisma.invoice.findFirst({
        where: { id, kind: "INVOICE", userId: request.user.id },
        include: { client: true },
      });
      if (!invoice) return reply.notFound("Invoice not found");

      const { notif, profile } = await senderContext(request.user.id);

      const text = renderInvoiceMessage({
        purpose: "send",
        template: notif.whatsappSendTemplate,
        invoice,
        profile,
        invoiceUrl: `${frontendOrigin()}/pay/${invoice.id}`,
      });

      /* `url` is null when the client has no phone number. The UI must say so
         rather than open anything — see waShareUrl. */
      return {
        text,
        url: waShareUrl({ phone: invoice.client?.phone, text }),
        hasPhone: !!invoice.client?.phone,
        clientName: invoice.client?.name || "",
      };
    },
  );

  fastify.get(
    "/share/quote/:id",
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!Number.isInteger(id)) return reply.badRequest("Invalid quotation id");

      const quote = await fastify.prisma.invoice.findFirst({
        where: { id, kind: "QUOTE", userId: request.user.id },
        include: { client: true },
      });
      if (!quote) return reply.notFound("Quotation not found");

      const { profile } = await senderContext(request.user.id);

      /* Minting the token is the one write these routes make, and it is not a
         side effect of sharing — it is the quotation's permanent public address,
         created on first need and reused forever after. Without it the link in
         the message would point nowhere. */
      const token = await ensurePublicToken(fastify.prisma, quote);

      const text = renderQuoteMessage({
        quote,
        profile,
        quoteUrl: publicQuoteUrl(token),
      });

      return {
        text,
        url: waShareUrl({ phone: quote.client?.phone, text }),
        hasPhone: !!quote.client?.phone,
        clientName: quote.client?.name || "",
      };
    },
  );
}

module.exports = whatsappRoutes;
