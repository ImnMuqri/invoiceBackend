/**
 * Centralized utility for marking an invoice as paid and updating relevant metrics.
 */
async function markInvoiceAsPaid(prisma, invoiceId) {
  const now = new Date();

  // 1. Fetch the invoice with client data
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { client: true },
  });

  if (!invoice) throw new Error(`Invoice #${invoiceId} not found`);
  if (invoice.status === "Paid") return invoice;

  // 2. Mark the invoice as paid
  const updatedInvoice = await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "Paid",
      paidAt: now,
    },
    include: { client: true },
  });

  // 3. Recalculate client-wide metrics
  // Fetch all paid invoices for this client to get a true historical average
  const paidInvoices = await prisma.invoice.findMany({
    where: {
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

module.exports = {
  markInvoiceAsPaid,
};
