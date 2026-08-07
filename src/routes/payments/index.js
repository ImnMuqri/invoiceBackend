const { recalculate, toSen } = require("../../utils/invoiceMoney");
const { createNotification } = require("../../utils/notificationUtils");

/**
 * Payments, credit notes and voiding (spec 03).
 *
 * Every route here ends in recalculate(), which is the only writer of an
 * invoice's money and status. None of these handlers sets a status directly —
 * that is the guarantee that the balance and the label cannot disagree.
 */

const METHODS = ["BANK_TRANSFER", "CASH", "CHEQUE", "OTHER", "BILLPLZ", "TOYYIBPAY", "HITPAY", "SENANGPAY"];

async function paymentRoutes(fastify, opts) {
  const { prisma } = fastify;

  const ownedInvoice = (userId, id) =>
    prisma.invoice.findFirst({
      where: { id: Number(id), userId, kind: "INVOICE" },
      select: {
        id: true, amount: true, amountPaid: true, amountAdjusted: true,
        amountDue: true, status: true, invoiceNumber: true, currency: true,
        client: { select: { name: true } },
      },
    });

  fastify.register(async function (protectedInstance) {
    protectedInstance.addHook("onRequest", fastify.authenticate);

    /** Payment history and running balance for one invoice. */
    protectedInstance.get("/invoice/:id", async (request, reply) => {
      const invoice = await ownedInvoice(request.user.id, request.params.id);
      if (!invoice) return reply.notFound("Invoice not found");

      const [payments, creditNotes] = await Promise.all([
        prisma.payment.findMany({
          where: { invoiceId: invoice.id },
          orderBy: { receivedAt: "asc" },
        }),
        prisma.creditNote.findMany({
          where: { invoiceId: invoice.id },
          orderBy: { issuedAt: "asc" },
        }),
      ]);

      /* Built server-side so the running balance is computed once, from the same
         ordering, rather than by each client re-deriving it. */
      const events = [
        ...payments.map((p) => ({ type: "payment", at: p.receivedAt, ...p })),
        ...creditNotes.map((c) => ({ type: "credit", at: c.issuedAt, ...c })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));

      let running = invoice.amount;
      const history = events.map((e) => {
        running -= e.amount;
        return { ...e, balanceAfter: running };
      });

      return { invoice, payments, creditNotes, history };
    });

    /** Record a payment. */
    protectedInstance.post("/invoice/:id", async (request, reply) => {
      const invoice = await ownedInvoice(request.user.id, request.params.id);
      if (!invoice) return reply.notFound("Invoice not found");
      if (invoice.status === "Void") {
        return reply.badRequest("This invoice is void. Un-void it before recording payment.");
      }

      const amount = toSen(request.body?.amount);
      if (amount === null || amount <= 0) {
        return reply.badRequest("Enter an amount greater than zero.");
      }

      const method = METHODS.includes(String(request.body?.method || "").toUpperCase())
        ? String(request.body.method).toUpperCase()
        : "OTHER";

      await prisma.payment.create({
        data: {
          invoiceId: invoice.id,
          amount,
          method,
          reference: request.body?.reference?.trim() || null,
          note: request.body?.note?.trim() || null,
          receivedAt: request.body?.receivedAt ? new Date(request.body.receivedAt) : new Date(),
          automatic: false,
        },
      });

      const result = await recalculate(prisma, invoice.id);

      /* Settling cancels the chase, as it always has. A PARTIAL payment
         deliberately does not — it reschedules, and the next reminder speaks
         about the remaining balance instead of the original total. */
      if (result.settled) {
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { whatsappLastReminderSent: null, emailLastReminderSent: null },
        });
      }

      return { ...result.invoice, settled: result.settled };
    });

    /** Edit a payment. */
    protectedInstance.put("/:paymentId", async (request, reply) => {
      const id = Number(request.params.paymentId);
      const payment = await prisma.payment.findFirst({
        where: { id, invoice: { userId: request.user.id } },
        select: { id: true, invoiceId: true },
      });
      if (!payment) return reply.notFound("Payment not found");

      const data = {};
      if (request.body?.amount !== undefined) {
        const amount = toSen(request.body.amount);
        if (amount === null || amount <= 0) return reply.badRequest("Enter an amount greater than zero.");
        data.amount = amount;
      }
      if (request.body?.receivedAt !== undefined) data.receivedAt = new Date(request.body.receivedAt);
      if (request.body?.method !== undefined) {
        const m = String(request.body.method).toUpperCase();
        data.method = METHODS.includes(m) ? m : "OTHER";
      }
      if (request.body?.reference !== undefined) data.reference = request.body.reference?.trim() || null;
      if (request.body?.note !== undefined) data.note = request.body.note?.trim() || null;

      await prisma.payment.update({ where: { id }, data });
      const result = await recalculate(prisma, payment.invoiceId);
      return result.invoice;
    });

    /** Delete a payment. */
    protectedInstance.delete("/:paymentId", async (request, reply) => {
      const id = Number(request.params.paymentId);
      const payment = await prisma.payment.findFirst({
        where: { id, invoice: { userId: request.user.id } },
        include: { invoice: { select: { id: true, invoiceNumber: true, userId: true } } },
      });
      if (!payment) return reply.notFound("Payment not found");

      /* The audit trail the spec asks for. A deleted payment is money somebody
         believed had arrived; it should not vanish without a record. */
      await createNotification(
        prisma,
        payment.invoice.userId,
        "Payment removed",
        `A payment of ${(payment.amount / 100).toFixed(2)} was removed from ${payment.invoice.invoiceNumber}. The balance has gone back up.`,
        "PAYMENT_DELETED",
      );

      await prisma.payment.delete({ where: { id } });
      const result = await recalculate(prisma, payment.invoiceId);

      /* Deliberately NOT resuming the chase. An invoice that goes back into
         debt because somebody corrected a mistake should not start messaging
         the client again on its own — the user decides when that restarts. */
      if (result.reopened) {
        await createNotification(
          prisma,
          payment.invoice.userId,
          "Invoice is unpaid again",
          `${payment.invoice.invoiceNumber} has an outstanding balance again. Chasing has NOT restarted — start it yourself when you are ready.`,
          "PAYMENT_DELETED",
        );
      }

      return { ...result.invoice, reopened: result.reopened };
    });

    /** Issue a credit note. */
    protectedInstance.post("/credit-note/:invoiceId", async (request, reply) => {
      const invoice = await ownedInvoice(request.user.id, request.params.invoiceId);
      if (!invoice) return reply.notFound("Invoice not found");

      const amount = toSen(request.body?.amount);
      if (amount === null || amount <= 0) {
        return reply.badRequest("Enter an amount greater than zero.");
      }
      /* Cannot exceed what is currently owed: a credit note is a reduction of a
         debt, and crediting more than is outstanding would be a refund, which
         is explicitly out of scope. */
      if (amount > invoice.amountDue) {
        return reply.badRequest(
          `That is more than the ${(invoice.amountDue / 100).toFixed(2)} still outstanding on this invoice.`,
        );
      }
      const reason = String(request.body?.reason || "").trim();
      if (!reason) return reply.badRequest("Give a reason — it is kept with the credit note.");

      const created = await prisma.$transaction(async (tx) => {
        const config = await tx.userInvoiceConfig.findUnique({
          where: { userId: request.user.id },
          select: { creditNotePrefix: true },
        });
        const prefix = config?.creditNotePrefix || "CN";
        const last = await tx.creditNote.findFirst({
          where: { userId: request.user.id },
          orderBy: { userNumber: "desc" },
          select: { userNumber: true },
        });
        const next = (last?.userNumber || 0) + 1;

        return tx.creditNote.create({
          data: {
            invoiceId: invoice.id,
            userId: request.user.id,
            userNumber: next,
            number: `${prefix}-${String(next).padStart(4, "0")}`,
            amount,
            reason,
            issuedAt: request.body?.issuedAt ? new Date(request.body.issuedAt) : new Date(),
          },
        });
      });

      const result = await recalculate(prisma, invoice.id);
      return { creditNote: created, invoice: result.invoice, settled: result.settled };
    });

    protectedInstance.delete("/credit-note/:id", async (request, reply) => {
      const id = Number(request.params.id);
      const note = await prisma.creditNote.findFirst({
        where: { id, userId: request.user.id },
        select: { id: true, invoiceId: true },
      });
      if (!note) return reply.notFound("Credit note not found");

      await prisma.creditNote.delete({ where: { id } });
      const result = await recalculate(prisma, note.invoiceId);
      return result.invoice;
    });

    /** Void an invoice that should never have been issued. */
    protectedInstance.post("/void/:invoiceId", async (request, reply) => {
      const invoice = await ownedInvoice(request.user.id, request.params.invoiceId);
      if (!invoice) return reply.notFound("Invoice not found");

      /* Only with nothing paid. Money having changed hands means this is a
         refund or a credit note, not a document that never existed. */
      if (invoice.amountPaid > 0) {
        return reply.badRequest(
          "This invoice has payments recorded against it, so it cannot be voided. Delete the payments first, or issue a credit note instead.",
        );
      }
      const reason = String(request.body?.reason || "").trim();
      if (!reason) return reply.badRequest("Voiding needs a reason. It is kept for your records and not shown to the client.");

      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: "Void",
          voidedAt: new Date(),
          voidReason: reason,
          /* Voiding cancels every queued reminder, unconditionally. */
          whatsappLastReminderSent: null,
          emailLastReminderSent: null,
        },
      });

      const result = await recalculate(prisma, invoice.id);
      return result.invoice;
    });
  });
}

module.exports = paymentRoutes;
module.exports.METHODS = METHODS;
