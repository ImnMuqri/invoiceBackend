const { createNotification } = require("./notificationUtils");

/**
 * Centralized utility for marking an invoice as paid and updating relevant metrics.
 */
/**
 * Record money received against an invoice (spec 03).
 *
 * Replaces flipping a paid flag. A gateway confirming LESS than the full amount
 * now produces a partial payment and leaves the invoice partially paid, which
 * is the whole point: the chaser was sending full-amount reminders to clients
 * who had already paid something.
 *
 * Deduplicated on the gateway's own reference, so a webhook delivered twice
 * records the money once.
 */
async function recordGatewayPayment(prisma, invoiceId, { amount, method, gatewayRef, reference }) {
  const { recalculate } = require("./invoiceMoney");

  if (gatewayRef) {
    const seen = await prisma.payment.findUnique({ where: { gatewayRef } });
    if (seen) {
      /* Already recorded. Recalculate anyway — cheap, and it repairs an invoice
         whose totals were left inconsistent by an earlier partial failure. */
      return recalculate(prisma, invoiceId);
    }
  }

  await prisma.payment.create({
    data: {
      invoiceId,
      amount,
      method: method || "OTHER",
      gatewayRef: gatewayRef || null,
      reference: reference || null,
      automatic: true,
    },
  });

  const result = await recalculate(prisma, invoiceId);

  if (result?.settled) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { client: true },
    });
    if (invoice) {
      await createNotification(
        prisma,
        invoice.userId,
        "Invoice Paid",
        `Invoice ${invoice.invoiceNumber || invoice.id} for ${invoice.client?.name} has been paid in full.`,
        "CLIENT_PAID",
      );
    }
  }

  return result;
}

async function markInvoiceAsPaid(prisma, invoiceId, amountPaid = null) {
  const now = new Date();

  // 1. Fetch the invoice with client data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });

  if (!invoice) throw new Error(`Invoice #${invoiceId} not found`);
  if (invoice.status === "Paid") return invoice;

  // 2. Mark the invoice as paid
  const updateData = {
    status: "Paid",
    paidAt: now,
  };
  
  if (amountPaid !== null) {
    updateData.amountPaid = amountPaid;
  } else if (invoice.amount) {
    updateData.amountPaid = invoice.amount;
  }

  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoiceId },
    data: updateData,
    include: { client: true },
  });

  // Notify App
  await createNotification(prisma, invoice.userId, "Invoice Paid", `Invoice ${invoice.invoiceNumber || invoice.id} for ${invoice.client.name} has been marked as fully paid.`, "CLIENT_PAID");

  // 3. Recalculate client-wide metrics
  // Fetch all paid invoices for this client to get a true historical average
  const paidInvoices = await prisma.invoice.findMany({
    where: {
      kind: "INVOICE",
      clientId: invoice.clientId,
      status: "Paid",
      paidAt: { not: null },
    },
  });

  const totalRevenue = paidInvoices.reduce((sum, inv) => sum + inv.amount, 0);

  let totalDelayDays = 0;
  paidInvoices.forEach((inv) => {
    if (inv.paidAt && inv.dueDate) {
      const delayMs = inv.paidAt.getTime() - inv.dueDate.getTime();
      const delayDays = Math.max(0, Math.ceil(delayMs / (1000 * 60 * 60 * 24)));
      totalDelayDays += delayDays;
    }
  });

  const averageDelayDays =
    paidInvoices.length > 0
      ? Math.round(totalDelayDays / paidInvoices.length)
      : 0;

  // 4. Update the Client record
  await prisma.client.update({
    where: { id: invoice.clientId },
    data: {
      averageDelayDays,
      totalRevenue,
    },
  });

  return updatedInvoice;
}

/**
 * Handle payment failure (e.g., from webhooks)
 */
async function handlePaymentFailure(prisma, invoiceId, reason = "") {
  const invoice = await prisma.invoice.findUnique({
    where: { id: parseInt(invoiceId) },
    include: { client: true },
  });

  if (!invoice) return;

  // Notify the user about the failure
  await createNotification(
    prisma,
    invoice.userId,
    "Payment Failed",
    `A payment attempt for Invoice ${invoice.invoiceNumber || invoice.id} (${invoice.client.name}) has failed.${reason ? ` Reason: ${reason}` : ""}`,
    "PAYMENT_FAILED",
  );
}

/**
 * Check if an invoice is overdue and trigger a notification if so.
 */
async function checkAndNotifyOverdue(prisma, invoiceId) {
  const now = new Date();
  const invoice = await prisma.invoice.findUnique({
    where: { id: parseInt(invoiceId) },
    include: { client: true },
  });

  if (
    invoice &&
    invoice.status === "Pending" &&
    invoice.dueDate &&
    new Date(invoice.dueDate) < now
  ) {
    // 1. Update status to Overdue if it was Pending
    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "Overdue" },
    });

    // 2. Notify the owner
    await createNotification(
      prisma,
      invoice.userId,
      "Invoice Overdue",
      `Invoice ${invoice.invoiceNumber || invoice.id} for ${invoice.client.name} is now overdue.`,
      "OVERDUE",
    );
  }
}

module.exports = {
  recordGatewayPayment,
  markInvoiceAsPaid,
  handlePaymentFailure,
  checkAndNotifyOverdue,
};
