/**
 * The one place invoice money is written (spec 03).
 *
 * `amountPaid`, `amountAdjusted`, `amountDue` and `status` are derived from the
 * Payment and CreditNote rows, and recalculate() is the ONLY function permitted
 * to write them. Nothing else may set a status by hand.
 *
 * That rule is the whole design. The spec asks for status never to be the source
 * of truth, and the honest way to honour that in a system where status is
 * *queried* — the chaser filters on it, the dashboard groups by it, every list
 * counts by it — is not to delete the column but to guarantee a single writer.
 * Drift becomes impossible not because the value is computed on read, but
 * because there is exactly one code path that can produce it.
 *
 * Money is integer sen throughout. See the migration for why.
 */

/** Statuses that describe an invoice's fate rather than its balance. */
const TERMINAL = ["Cancelled", "Void", "Draft"];

/**
 * Derive the status from the money.
 *
 * Deliberately keeps this product's vocabulary rather than the spec's — Pending
 * where the spec says "Sent", and Cancelled kept alongside Void. Cancelled and
 * Void are genuinely different: cancelled means the work stopped, void means
 * the invoice should never have been issued at all.
 */
function deriveStatus({ amount, amountPaid, amountAdjusted, dueDate, current }) {
  if (current === "Void") return "Void";
  if (current === "Cancelled") return "Cancelled";
  /* A draft has not been issued, so it has no balance to describe. */
  if (current === "Draft") return "Draft";

  const due = amount - amountPaid - amountAdjusted;

  /* <= 0 rather than == 0: overpayment settles the invoice and is shown as a
     negative balance rather than rejected. */
  if (due <= 0) return "Paid";
  if (amountPaid > 0 || amountAdjusted > 0) return "Partially Paid";
  if (dueDate && new Date(dueDate).getTime() < Date.now()) return "Overdue";
  return "Pending";
}

/**
 * Recompute an invoice's money from its payment and credit-note rows.
 *
 * Reads the rows rather than incrementing counters: an increment is only correct
 * if every past write was correct, and this way a deleted payment, an edited
 * amount and a fresh webhook all converge on the same answer.
 *
 * Returns the updated invoice plus what changed, so callers can decide whether
 * to cancel reminders without re-reading.
 */
async function recalculate(prisma, invoiceId, { tx } = {}) {
  const db = tx || prisma;

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      amount: true,
      status: true,
      dueDate: true,
      amountPaid: true,
      amountDue: true,
      paidAt: true,
    },
  });
  if (!invoice) return null;

  const [payments, credits] = await Promise.all([
    db.payment.findMany({
      where: { invoiceId },
      select: { amount: true, receivedAt: true },
      orderBy: { receivedAt: "asc" },
    }),
    db.creditNote.findMany({
      where: { invoiceId },
      select: { amount: true },
    }),
  ]);

  const amountPaid = payments.reduce((n, p) => n + p.amount, 0);
  const amountAdjusted = credits.reduce((n, c) => n + c.amount, 0);
  const amountDue = invoice.amount - amountPaid - amountAdjusted;

  const status = deriveStatus({
    amount: invoice.amount,
    amountPaid,
    amountAdjusted,
    dueDate: invoice.dueDate,
    current: invoice.status,
  });

  /* Settled on the date of the FINAL payment, not the first and not today.
     Client payment behaviour is measured from this, so it has to be the moment
     the invoice actually cleared. */
  const paidAt =
    status === "Paid" && payments.length
      ? payments[payments.length - 1].receivedAt
      : null;

  const updated = await db.invoice.update({
    where: { id: invoiceId },
    data: { amountPaid, amountAdjusted, amountDue, status, paidAt },
  });

  return {
    invoice: updated,
    before: {
      status: invoice.status,
      amountDue: invoice.amountDue,
      amountPaid: invoice.amountPaid,
    },
    settled: status === "Paid" && invoice.status !== "Paid",
    /* True when a deletion or edit pushed a settled invoice back into debt. The
       chase is deliberately NOT resumed automatically on this — see the routes. */
    reopened: amountDue > 0 && invoice.amountDue <= 0,
  };
}

/** Sen to a display string. Never used for arithmetic. */
function sen(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Ringgit from a user-entered value to sen. Rejects nonsense rather than NaN. */
function toSen(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

module.exports = { recalculate, deriveStatus, sen, toSen, TERMINAL };
