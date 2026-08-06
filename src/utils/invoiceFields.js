/**
 * The columns a client is allowed to write on an Invoice row.
 *
 * Both write paths used to spread `...request.body` straight into Prisma, which
 * fails the moment a caller sends a key that is not a column — and `taxRate` is
 * exactly that: it lives on UserInvoiceConfig.defaultTaxRate, is used to compute
 * `amount` in the browser, and is not stored on the invoice at all. Prisma
 * answers with "Unknown argument `taxRate`" and the whole create fails.
 *
 * A whitelist instead of a spread, so the schema decides what is writable rather
 * than whatever the client happened to post. Anything not listed here is
 * dropped silently, which is the correct behaviour for a field the row does not
 * have — the frontend legitimately holds working values (taxRate, discount
 * percentages) that only ever feed the arithmetic.
 */

/** Scalars a caller may set on either kind of document. */
const SHARED = [
  "invoiceName",
  "subject",
  "fromName",
  "fromCompanyName",
  "fromEmail",
  "fromPhone",
  "fromAddress",
  "currency",
  "status",
  "amount",
  "template",
];

/** Invoices additionally own the money-and-time fields. */
const INVOICE_ONLY = ["date", "dueDate", "amountPaid", "paidAt"];

/** Quotes own their expiry instead. */
const QUOTE_ONLY = ["validUntil"];

/**
 * Picks only the writable keys, and only those actually present, so a partial
 * update stays partial — passing `undefined` for an absent key would blank the
 * column on a PUT.
 */
function pickWritable(body = {}, kind = "INVOICE") {
  const allowed = [
    ...SHARED,
    ...(kind === "QUOTE" ? QUOTE_ONLY : INVOICE_ONLY),
  ];
  const out = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

module.exports = { pickWritable, SHARED, INVOICE_ONLY, QUOTE_ONLY };
