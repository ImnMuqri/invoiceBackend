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
 *   - a status vocabulary of their own: Draft / Sent / Accepted / Declined /
 *     Expired, none of which mean money is outstanding
 *
 * Nothing here touches payment. The pay routes filter to kind INVOICE, so a
 * quote id on a payment URL resolves to nothing.
 */

const QUOTE_STATUSES = ["Draft", "Sent", "Accepted", "Declined", "Expired"];

const { assertCreationEnabled } = require("../../utils/systemGuards");
const { pickWritable } = require("../../utils/invoiceFields");

async function quoteRoutes(fastify, opts) {
  const { prisma } = fastify;

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** Everything the caller owns, newest first. */
    protectedInstance.get("/", async (request) =>
      prisma.invoice.findMany({
        where: { kind: "QUOTE", userId: request.user.id },
        include: { client: true, convertedTo: { select: { id: true, invoiceNumber: true } } },
        orderBy: { date: "desc" },
      }),
    );

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
      return quote;
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

        const config = await prisma.userInvoiceConfig.findUnique({
          where: { userId: request.user.id },
          select: { quotePrefix: true },
        });
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
            kind: "QUOTE",
            amount,
            status: QUOTE_STATUSES.includes(rest.status) ? rest.status : "Draft",
            /* Never set. A quote has no due date, and leaving one on the row
               would make it eligible for anything that looks for money owed. */
            dueDate: null,
            validUntil: rest.validUntil ? new Date(rest.validUntil) : null,
            userQuoteNumber: next,
            invoiceNumber: `${prefix}-${String(next).padStart(4, "0")}`,
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

        return { ...quote, message: "Quotation created" };
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
          data: { status: "Accepted" },
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
