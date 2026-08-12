/**
 * QUOTATIONS
 *
 * Quotes live in the Invoice table under `kind: "QUOTE"` — see the model comment
 * in prisma/schema.prisma for why. What is different about them lives here:
 *
 *   - their own per-user sequence and prefix, so issuing a quote never advances
 *     invoice numbering and leaves gaps an accountant will ask about
 *   - `validUntil` instead of `dueDate`; a quote expires, it is not owed
 *   - their own quota counter, so quoting for work you do not win does not spend
 *     the allowance for billing the work you do
 *   - a status vocabulary of their own: Draft / Sent / Viewed / Accepted /
 *     Declined / Expired, none of which mean money is outstanding
 *
 * Nothing here touches payment. The pay routes filter to kind INVOICE, so a
 * quote id on a payment URL resolves to nothing.
 *
 * This file is the OWNER's side. The client's side — the page they open, and
 * the two buttons on it — is routes/quote/index.js, public and addressed by
 * token. Sending is here; answering is there.
 */

const { assertCreationEnabled } = require("../../utils/systemGuards");
const { pickWritable } = require("../../utils/invoiceFields");
const taxIdentity = require("../../utils/taxIdentity");
const { renderQuoteMessage } = require("../../utils/whatsappMessage");
const { getQuoteEmail } = require("../../utils/quoteEmail");
const { attributionFor } = require("../../utils/attribution");
const {
  QUOTE_STATUSES,
  mintPublicToken,
  ensurePublicToken,
  publicQuoteUrl,
  effectiveStatus,
  isExpired,
} = require("../../utils/quoteLifecycle");

/**
 * The status a quotation holds after a send, which is not always "Sent".
 *
 * Draft advances. Sent and Viewed stay where they are — resending a corrected
 * copy to somebody who has already opened the first one must not un-see it.
 * Accepted, Declined and Expired are answers, and a send does not undo an
 * answer; that is what the decision endpoint is for.
 */
function markSent(quote, data) {
  /* Draft is the ordinary case: it has now been sent.

     Sent and Viewed stay put — resending a corrected copy to somebody who has
     already opened the first one must not un-see it.

     Accepted and Declined stay put too. A send does not undo an answer; that is
     what the decision endpoint is for.

     Expired is the one that moves back. A user who extends the validity date
     and sends again has a live quotation, and leaving it labelled Expired means
     the client is looking at an accept button the product calls dead. It only
     moves when the new date is genuinely in the future — hence isExpired here
     rather than a bare status check. */
  const revived = quote.status === "Expired" && !isExpired(quote);
  const becomesSent = quote.status === "Draft" || revived;

  return {
    ...data,
    ...(becomesSent ? { status: "Sent", expiryNotifiedAt: null } : {}),
  };
}

async function quoteRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** Everything the caller owns, newest first. */
    protectedInstance.get("/", async (request) => {
      const quotes = await prisma.invoice.findMany({
        where: { kind: "QUOTE", userId: request.user.id },
        include: { client: true, convertedTo: { select: { id: true, invoiceNumber: true } } },
        orderBy: { date: "desc" },
      });
      /* Statuses are corrected on the way out, not on the way in. The expiry
         sweep runs nightly, so a quote that ran out this morning still reads
         Sent in the row until 01:15 tomorrow — and a list that says a lapsed
         quotation is "waiting on a reply" is the kind of small lie that makes
         somebody stop trusting the whole page. */
      return quotes.map((q) => ({ ...q, status: effectiveStatus(q) }));
    });

    protectedInstance.get("/:id", async (request, reply) => {
      const quote = await prisma.invoice.findFirst({
        where: {
          id: Number(request.params.id),
          kind: "QUOTE",
          userId: request.user.id,
        },
        include: {
          client: true,
          items: true,
          convertedTo: { select: { id: true, invoiceNumber: true, status: true } },
        },
      });
      if (!quote) return reply.notFound("Quotation not found");

      /* A write on a GET, deliberately and exactly once per quote.
         Quotes created before spec 07 have no token, and the alternative to
         backfilling here is a separate "get me a link" round trip that every
         caller has to remember to make before it can show a link at all. */
      const token = await ensurePublicToken(prisma, quote);

      return {
        ...quote,
        publicToken: token,
        publicUrl: publicQuoteUrl(token),
        /* What to SHOW. The expiry sweep runs nightly, so a quote that lapsed
           this morning still says Sent in the row until 01:15 tomorrow. */
        status: effectiveStatus(quote),
      };
    });

    protectedInstance.post(
      "/",
      {
        schema: {
          body: {
            type: "object",
            required: ["clientId", "items"],
            properties: {
              clientId: { type: ["number", "string"] },
              invoiceName: { type: "string" },
              subject: { type: "string" },
              fromName: { type: "string" },
              fromCompanyName: { type: "string" },
              fromEmail: { type: "string" },
              fromPhone: { type: "string" },
              fromAddress: { type: "string" },
              validUntil: { type: "string" },
              status: { type: "string" },
              currency: { type: "string" },
              template: { type: "string" },
              taxRate: { type: "number" },
              amount: { type: "number" },
              usedAi: { type: "boolean" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "price", "quantity"],
                  properties: {
                    name: { type: "string" },
                    price: { type: "number" },
                    quantity: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
      async (request, reply) => {
        if (!(await assertCreationEnabled(prisma, reply, "Quotations"))) return;

        try {
          await fastify.usage.checkAndIncrement(request.user.id, "quote");
        } catch (err) {
          if (err.statusCode === 403) return reply.forbidden(err.message);
          throw err;
        }

        const { clientId, items, template, usedAi, ...rest } = request.body;

        if (usedAi) {
          try {
            await fastify.usage.checkAndIncrement(request.user.id, "ai");
          } catch (err) {
            if (err.statusCode === 403) return reply.forbidden(err.message);
            throw err;
          }
        }

        const amount =
          rest.amount ||
          items.reduce((sum, i) => sum + i.price * i.quantity, 0);

        const [config, issuerProfile] = await Promise.all([
          prisma.userInvoiceConfig.findUnique({
            where: { userId: request.user.id },
            select: { quotePrefix: true },
          }),
          /* A quotation is a document a client keeps too, so it carries the
             same frozen identifiers an invoice does (spec 05). */
          prisma.userProfile.findUnique({
            where: { userId: request.user.id },
            select: {
              registrationNumber: true,
              tin: true,
              msicCode: true,
              sstNumber: true,
            },
          }),
        ]);
        const prefix = config?.quotePrefix || "QUO";

        /* Own sequence — deliberately reading userQuoteNumber, not
           userInvoiceNumber. Sharing the counter would put gaps in the invoice
           run every time somebody quoted. */
        const last = await prisma.invoice.findFirst({
          where: { kind: "QUOTE", userId: request.user.id },
          orderBy: { userQuoteNumber: "desc" },
          select: { userQuoteNumber: true },
        });
        const next = (last?.userQuoteNumber || 0) + 1;

        const quote = await prisma.invoice.create({
          data: {
            /* Whitelisted — the builder posts taxRate, which is not a column. */
            ...pickWritable(rest, "QUOTE"),
            ...taxIdentity.snapshotFrom(issuerProfile),
            kind: "QUOTE",
            amount,
            status: QUOTE_STATUSES.includes(rest.status) ? rest.status : "Draft",
            /* Never set. A quote has no due date, and leaving one on the row
               would make it eligible for anything that looks for money owed. */
            dueDate: null,
            validUntil: rest.validUntil ? new Date(rest.validUntil) : null,
            userQuoteNumber: next,
            invoiceNumber: `${prefix}-${String(next).padStart(4, "0")}`,
            /* The client's link, minted now rather than at send time so that
               the same url is on the PDF, in the email and in the WhatsApp
               message — three places a client might arrive from, all landing on
               one page that knows what it already told them. */
            publicToken: mintPublicToken(),
            template: template || "professional",
            user: { connect: { id: request.user.id } },
            client: { connect: { id: Number(clientId) } },
            items: {
              create: items.map((i) => ({
                ...i,
                total: i.price * i.quantity,
              })),
            },
          },
          include: { items: true, client: true },
        });

        return {
          ...quote,
          publicUrl: publicQuoteUrl(quote.publicToken),
          message: "Quotation created",
        };
      },
    );

    /**
     * POST /:id/send — put the quotation in front of the client.
     *
     * Channels are the invoice ones, because they are where clients read: email,
     * WhatsApp, or both. What is deliberately absent is everything that comes
     * after a send on the invoice side. No follow-up is scheduled, no chase
     * cycle opens, no reminder interval applies. The client hears from us once,
     * here, and then only if the user presses this again.
     *
     * METERING. A quotation sent over WhatsApp costs exactly what an invoice
     * sent over WhatsApp costs, so it draws on the same allowance through the
     * same plugin — spec 01's per-invoice unit, applied to this row. That gives
     * the behaviour you would want for free: sending a quote and then resending
     * a corrected version in the same month counts once. It does NOT make the
     * quote chased; plugins/cron.js filters `kind: "INVOICE"` before it looks
     * at anything, which is the structural guarantee that no timer will ever
     * touch this document.
     */
    protectedInstance.post(
      "/:id/send",
      {
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            properties: {
              channel: { type: "string", enum: ["email", "whatsapp", "both"] },
            },
          },
        },
      },
      async (request, reply) => {
        const id = Number(request.params.id);
        const channel = request.body?.channel || "email";

        const quote = await prisma.invoice.findFirst({
          where: { id, kind: "QUOTE", userId: request.user.id },
          include: { client: true },
        });
        if (!quote) return reply.notFound("Quotation not found");

        /* An answered quotation is not sendable.
           Sending again would spend a real WhatsApp message and a real email
           allowance to deliver a link to a page that refuses any response —
           and would talk past a decision the client has already made. Reopen it
           from the decision endpoint first if that is genuinely what is
           wanted. */
        if (quote.acceptedAt || quote.declinedAt) {
          return reply.badRequest(
            "This quotation has already been answered. Reopen it first if you want to send it again.",
          );
        }
        /* Expired is allowed through ONLY when the date has actually been
           extended — markSent() then revives it to Sent. Sending a link to a
           page that says "this has lapsed" helps nobody. */
        if (quote.status === "Expired" && isExpired(quote)) {
          return reply.badRequest(
            "This quotation has lapsed. Change how long the price holds, then send it again.",
          );
        }

        const wantEmail = channel === "email" || channel === "both";
        const wantWa = channel === "whatsapp" || channel === "both";

        if (wantEmail && !quote.client?.email) {
          return reply.badRequest(
            "That client has no email address saved, so there is nowhere to send it.",
          );
        }
        if (wantWa && !quote.client?.phone) {
          return reply.badRequest(
            "That client has no phone number saved, so there is nowhere to send it.",
          );
        }

        const token = await ensurePublicToken(prisma, quote);
        const url = publicQuoteUrl(token);

        const owner = await prisma.user.findUnique({
          where: { id: request.user.id },
          select: {
            notification: true,
            /* logoUrl brands the client's copy as the SENDER; plan and the
               attribution flag decide whether our line appears at its foot.
               Same rule as the pay page, the quotation page and the PDF. */
            plan: true,
            profile: {
              select: { name: true, companyName: true, logoUrl: true },
            },
            invoiceConfig: { select: { attributionEnabled: true } },
          },
        });
        const profile = owner?.profile || {};
        const notif = owner?.notification || {};

        const sent = [];
        const data = {};

        /**
         * One channel worked and the other did not.
         *
         * Returns the SAME shape as the success path — the updated quote, its
         * public url, `sent` — with `failed` added. The two replies used to
         * return only { sent, failed, message }, so a caller that treats any
         * 2xx as "here is the refreshed quotation" would blank its own state on
         * a partial send: the half that worked would look like a total failure
         * on screen. Anything a 200 carries, a 207 carries too.
         */
        const partial = async (failed, message) => {
          const updated = await prisma.invoice.update({
            where: { id },
            data: markSent(quote, data),
            include: { client: true, items: true },
          });
          return reply
            .code(207)
            .send({ ...updated, publicUrl: url, sent, failed, message });
        };

        /* ── Email ─────────────────────────────────────────────────────── */
        if (wantEmail) {
          /* CHECK now, CHARGE after the provider takes it — the same rule the
             WhatsApp branch below states and the chase plugin is built around.
             Incrementing first meant a Resend outage returned an error with the
             user's allowance already spent on a message that never left, and
             they would have had to notice the counter to know. */
          try {
            await fastify.usage.checkOnly(request.user.id, "emailSend");
          } catch (err) {
            if (err.statusCode === 403) return reply.forbidden(err.message);
            throw err;
          }

          const { subject, html, text } = getQuoteEmail({
            clientName: quote.client.name,
            senderName: profile.name,
            senderCompany: profile.companyName,
            senderLogo: profile.logoUrl,
            attribution: attributionFor({
              plan: owner?.plan,
              enabled: owner?.invoiceConfig?.attributionEnabled,
              surface: "quote-email",
            }),
            quoteNumber: quote.invoiceNumber,
            amount: quote.amount,
            currency: quote.currency,
            validUntil: quote.validUntil,
            subject: quote.invoiceName || quote.subject,
            publicUrl: url,
          });

          try {
            await fastify.email.send({ to: quote.client.email, subject, html, text });
          } catch (err) {
            /* Say what actually happened rather than letting this become an
               anonymous 500. The user is standing in front of this button and
               needs to know whether their client has the quotation — "could not
               send" is actionable, "something went wrong" is not. */
            fastify.log.error({ err, quoteId: quote.id }, "Quotation email failed");
            return reply.serviceUnavailable(
              "Could not send that email just now. Nothing has gone to your client — try again in a moment.",
            );
          }

          /* Charged now that it has actually gone. A 403 here would mean the
             allowance ran out between the check and the send, which is a race
             worth logging and not worth failing a delivered message over. */
          try {
            await fastify.usage.checkAndIncrement(request.user.id, "emailSend");
          } catch (err) {
            fastify.log.warn(
              { err, quoteId: quote.id },
              "Quotation email delivered but the allowance could not be charged",
            );
          }

          await fastify.chase.logMessage({
            userId: request.user.id,
            invoiceId: quote.id,
            channel: "EMAIL",
            purpose: "SEND",
          });
          data.emailLastSent = new Date();
          sent.push("email");
        }

        /* ── WhatsApp ──────────────────────────────────────────────────── */
        if (wantWa) {
          const decision = await fastify.chase.canChase(request.user.id, quote.id);
          if (!decision.allowed) {
            /* Refused rather than downgraded, matching the manual invoice send.
               Spec 01's never-drop-a-reminder rule is about messages the system
               promised to send on a schedule; this one is a button the user is
               standing in front of, and telling them it did not go is better
               than quietly sending something else. */
            const message =
              decision.reason === "chased invoice allowance exhausted"
                ? "Your WhatsApp allowance for this period is used up. You can still send this quotation by email, or top up."
                : `Cannot send over WhatsApp: ${decision.reason}`;
            /* An email that already went is not rolled back — the client has it.
               Report the half that worked rather than pretending neither did. */
            if (sent.length) return partial(["whatsapp"], message);
            return reply.forbidden(message);
          }

          /* Still not a user-editable template — there is no quote template
             column, and defaulting one to the invoice wording ("your invoice is
             due") would be worse than a fixed correct sentence. What changed is
             WHERE the sentence lives: utils/whatsappMessage, so the manual
             "Share on WhatsApp" link on the quotation page words it identically.
             Two copies of this would mean a client could get one wording from
             the button and another from the share. */
          const message = renderQuoteMessage({
            quote,
            profile,
            quoteUrl: url,
          });

          let credentials = null;
          if (notif.whatsappMode === "CUSTOM") {
            credentials = {
              sid: notif.twilioSid,
              token: notif.twilioAuthToken,
              phoneNumber: notif.twilioPhoneNumber,
            };
          }

          try {
            await fastify.whatsapp.sendMessage(quote.client.phone, message, credentials);
          } catch (err) {
            fastify.log.error({ err, quoteId: quote.id }, "Quotation WhatsApp failed");
            /* An email that already went is not rolled back — the client has
               it. Record that half and report the other honestly. */
            if (sent.length) {
              return partial(["whatsapp"], "The email went out. WhatsApp did not.");
            }
            return reply.serviceUnavailable(
              "Could not send that over WhatsApp just now. Nothing has gone to your client — try again in a moment.",
            );
          }

          /* After the provider accepted it, never before — a send that failed
             must not burn the allowance. */
          await fastify.chase.consumeChase(request.user.id, quote.id, decision);
          await fastify.chase.logMessage({
            userId: request.user.id,
            invoiceId: quote.id,
            channel: "WHATSAPP",
            purpose: "SEND",
            category: "UTILITY",
          });
          data.whatsappLastSent = new Date();
          data.whatsappStatus = "Sent";
          sent.push("whatsapp");
        }

        const updated = await prisma.invoice.update({
          where: { id },
          data: markSent(quote, data),
          include: { client: true, items: true },
        });

        return {
          ...updated,
          publicUrl: url,
          sent,
          message:
            sent.length === 2
              ? "Quotation sent by email and WhatsApp."
              : sent[0] === "whatsapp"
                ? "Quotation sent on WhatsApp."
                : "Quotation emailed.",
        };
      },
    );

    /**
     * POST /:id/decision — the user records the answer themselves.
     *
     * Most quotes are still answered in a phone call or over lunch, and a
     * product that only knows about answers given through its own button knows
     * about half of them. Same statuses, same record, entered by the user.
     */
    protectedInstance.post(
      "/:id/decision",
      {
        schema: {
          body: {
            type: "object",
            required: ["decision"],
            additionalProperties: false,
            properties: {
              decision: { type: "string", enum: ["accept", "decline", "reopen"] },
              name: { type: "string", maxLength: 120 },
              reason: { type: "string", maxLength: 500 },
            },
          },
        },
      },
      async (request, reply) => {
        const id = Number(request.params.id);
        const { decision, name, reason } = request.body;

        const quote = await prisma.invoice.findFirst({
          where: { id, kind: "QUOTE", userId: request.user.id },
          select: { id: true, convertedTo: { select: { id: true } } },
        });
        if (!quote) return reply.notFound("Quotation not found");
        if (quote.convertedTo) {
          return reply.badRequest(
            "This quotation has already been turned into an invoice, so its answer is settled.",
          );
        }

        const now = new Date();
        const data =
          decision === "accept"
            ? {
                status: "Accepted",
                acceptedAt: now,
                /* No IP. This acceptance came over the phone, and recording the
                   USER's address as the client's would be a fiction in a field
                   whose only purpose is to be evidence. */
                acceptedName: (name || "").trim() || null,
                acceptedIp: null,
                declinedAt: null,
                declineReason: null,
              }
            : decision === "decline"
              ? {
                  status: "Declined",
                  declinedAt: now,
                  declineReason: (reason || "").trim() || null,
                  acceptedAt: null,
                  acceptedName: null,
                  acceptedIp: null,
                }
              : {
                  /* Reopen: they changed their mind, or it was marked by
                     mistake. Back to waiting, and the expiry notice is cleared
                     so a re-dated quote can lapse — and be reported — again. */
                  status: "Sent",
                  acceptedAt: null,
                  acceptedName: null,
                  acceptedIp: null,
                  declinedAt: null,
                  declineReason: null,
                  expiryNotifiedAt: null,
                };

        const updated = await prisma.invoice.update({
          where: { id },
          data,
          include: { client: true, items: true },
        });
        return { ...updated, message: `Quotation marked ${updated.status.toLowerCase()}.` };
      },
    );

    protectedInstance.put("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const existing = await prisma.invoice.findFirst({
        where: { id, kind: "QUOTE", userId: request.user.id },
        select: { id: true, convertedTo: { select: { id: true } } },
      });
      if (!existing) return reply.notFound("Quotation not found");
      /* Once it has become an invoice the quote is a record of what was agreed.
         Editing it afterwards would mean the invoice and the quote it came from
         no longer say the same thing. */
      if (existing.convertedTo) {
        return reply.badRequest(
          "This quotation has already been turned into an invoice. Edit the invoice instead.",
        );
      }

      const { clientId, items, usedAi, kind, userQuoteNumber, invoiceNumber, ...rest } =
        request.body;

      const amount = Array.isArray(items)
        ? items.reduce((sum, i) => sum + i.price * i.quantity, 0)
        : rest.amount;

      const data = {
        ...pickWritable(rest, "QUOTE"),
        ...(amount !== undefined ? { amount } : {}),
        dueDate: null,
        ...(rest.validUntil !== undefined
          ? { validUntil: rest.validUntil ? new Date(rest.validUntil) : null }
          : {}),
        ...(clientId ? { client: { connect: { id: Number(clientId) } } } : {}),
        ...(Array.isArray(items)
          ? {
              items: {
                deleteMany: {},
                create: items.map((i) => ({ ...i, total: i.price * i.quantity })),
              },
            }
          : {}),
      };

      const quote = await prisma.invoice.update({
        where: { id },
        data,
        include: { items: true, client: true },
      });
      return { ...quote, message: "Quotation updated" };
    });

    protectedInstance.delete("/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const existing = await prisma.invoice.findFirst({
        where: { id, kind: "QUOTE", userId: request.user.id },
        select: { id: true, convertedTo: { select: { id: true } } },
      });
      if (!existing) return reply.notFound("Quotation not found");
      if (existing.convertedTo) {
        return reply.badRequest(
          "This quotation has an invoice attached to it. Delete the invoice first.",
        );
      }
      await prisma.invoice.delete({ where: { id } });
      return { message: "Quotation deleted" };
    });

    /**
     * Turn an accepted quotation into an invoice.
     *
     * Non-destructive by design: the quote stays, marked Accepted, and a NEW
     * invoice is created pointing back at it. You can then show a client the
     * quote they agreed to and the invoice raised against it, which is the whole
     * reason to keep quotes as records rather than mutating them into bills.
     *
     * The whole thing runs in one transaction. Half of this — an invoice with no
     * link back, or a quote marked converted with no invoice — is worse than the
     * request simply failing, because neither end can be found afterwards.
     */
    protectedInstance.post("/:id/convert", async (request, reply) => {
      const id = Number(request.params.id);
      const { dueDate } = request.body || {};

      // Converting raises a real invoice, so the same switch applies.
      if (!(await assertCreationEnabled(prisma, reply, "Invoices"))) return;

      const quote = await prisma.invoice.findFirst({
        where: { id, kind: "QUOTE", userId: request.user.id },
        include: { items: true, convertedTo: { select: { id: true } } },
      });
      if (!quote) return reply.notFound("Quotation not found");

      /* The unique constraint on convertedFromId enforces this at the database
         level too; checking here turns a constraint violation into a sentence. */
      if (quote.convertedTo) {
        return reply.badRequest(
          "This quotation has already been turned into an invoice.",
        );
      }

      try {
        await fastify.usage.checkAndIncrement(request.user.id, "invoice");
      } catch (err) {
        if (err.statusCode === 403) return reply.forbidden(err.message);
        throw err;
      }

      const invoice = await prisma.$transaction(async (tx) => {
        const config = await tx.userInvoiceConfig.findUnique({
          where: { userId: request.user.id },
          select: { invoicePrefix: true },
        });
        const prefix = config?.invoicePrefix || "INV";

        const last = await tx.invoice.findFirst({
          where: { kind: "INVOICE", userId: request.user.id },
          orderBy: { userInvoiceNumber: "desc" },
          select: { userInvoiceNumber: true },
        });
        const next = (last?.userInvoiceNumber || 0) + 1;

        const created = await tx.invoice.create({
          data: {
            kind: "INVOICE",
            userId: quote.userId,
            clientId: quote.clientId,
            invoiceName: quote.invoiceName,
            subject: quote.subject,
            fromName: quote.fromName,
            fromCompanyName: quote.fromCompanyName,
            fromEmail: quote.fromEmail,
            fromPhone: quote.fromPhone,
            fromAddress: quote.fromAddress,
            /* Carried across from the quote, NOT re-read from the profile.
               The client accepted a quotation showing these identifiers; the
               invoice for that same work must show the same ones, even if the
               profile changed in between. */
            fromRegistrationNumber: quote.fromRegistrationNumber,
            fromTin: quote.fromTin,
            fromMsicCode: quote.fromMsicCode,
            fromSstNumber: quote.fromSstNumber,
            currency: quote.currency,
            template: quote.template,
            amount: quote.amount,
            status: "Pending",
            userInvoiceNumber: next,
            invoiceNumber: `${prefix}-${String(next).padStart(4, "0")}`,
            /* Fourteen days out unless the caller says otherwise — the same
               default the builder uses, so a converted invoice behaves like one
               created by hand. */
            dueDate: dueDate
              ? new Date(dueDate)
              : new Date(Date.now() + 14 * 86400000),
            convertedFromId: quote.id,
            items: {
              create: quote.items.map((i) => ({
                name: i.name,
                price: i.price,
                quantity: i.quantity,
                total: i.total,
              })),
            },
          },
          include: { items: true, client: true },
        });

        await tx.invoice.update({
          where: { id: quote.id },
          data: {
            status: "Accepted",
            /* Only when there is not one already. If the client accepted this
               through their own link on Tuesday and the user raised the invoice
               on Friday, the acceptance happened on Tuesday — stamping it now
               would quietly rewrite the record of when the client agreed, which
               is the one thing that record is for. */
            ...(quote.acceptedAt ? {} : { acceptedAt: new Date() }),
            declinedAt: null,
            declineReason: null,
          },
        });

        return created;
      });

      return {
        ...invoice,
        message: `Invoice ${invoice.invoiceNumber} raised from ${quote.invoiceNumber}`,
      };
    });
  });
}

module.exports = quoteRoutes;
