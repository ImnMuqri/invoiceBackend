/**
 * Accountant export (spec 04).
 *
 * One action produces a complete record of a date range that a Malaysian
 * accountant or tax agent can work from directly. The measure of success is
 * that a user stops keeping a parallel spreadsheet — because a user who keeps a
 * parallel spreadsheet is already half migrated away.
 *
 * Everything here is pure data assembly. No HTTP, no file writing: the routes
 * decide whether the result is streamed, zipped or emailed.
 */

const { sen } = require("./invoiceMoney");

/**
 * A CSV field.
 *
 * Quoting is not optional decoration. A Malaysian address routinely contains a
 * comma, a client note can contain a newline, and a name can contain an
 * apostrophe or a quote. Any of those unescaped shifts every following column
 * by one, silently, and the accountant reconciles the wrong numbers.
 *
 * Also guards against CSV injection: a value starting =, +, - or @ is executed
 * as a formula when the file is opened in Excel. Prefixing a tab neutralises it
 * while still displaying the original text.
 */
function field(value) {
  if (value === null || value === undefined) return "";
  let out = String(value);
  if (/^[=+\-@]/.test(out)) out = `\t${out}`;
  if (/[",\n\r]/.test(out)) out = `"${out.replace(/"/g, '""')}"`;
  return out;
}

/** YYYY-MM-DD in Asia/Kuala_Lumpur, or empty. */
function isoDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

/**
 * Sen to a plain decimal.
 *
 * No currency symbol and no thousands separators, per the spec: those are
 * display concerns, and a separator turns a number into text the moment the
 * file is opened in a spreadsheet.
 */
function amount(senValue) {
  return sen(senValue);
}

const INVOICE_COLUMNS = [
  "invoice_number", "issue_date", "due_date", "client_name",
  "client_registration_number", "client_tin", "description", "currency",
  "subtotal", "tax_rate", "tax_amount", "total", "amount_paid",
  "amount_adjusted", "amount_due", "status", "date_settled",
  "payment_method", "payment_reference",
];

const PAYMENT_COLUMNS = [
  "invoice_number", "payment_date", "amount", "currency", "method",
  "reference", "recorded_automatically", "note",
];

/**
 * The BOM matters.
 *
 * Excel on Windows assumes the system codepage unless a UTF-8 byte-order mark
 * says otherwise, so without it a Malay client name with any accented character
 * — or any Chinese name — opens mangled. The spec calls this out for exactly
 * that reason.
 */
const BOM = "﻿";

function toCsv(columns, rows) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => field(row[c])).join(","));
  }
  /* CRLF: the line ending Excel expects, and harmless everywhere else. */
  return BOM + lines.join("\r\n") + "\r\n";
}

/** One row per invoice, whatever its payment history. */
function invoiceRow(inv) {
  const lineTotal = (inv.items || []).reduce((n, i) => n + i.total, 0);
  const taxRate = Number(inv.taxRate) || 0;
  /* Derived from the stored total rather than recomputed from the rate, so the
     row reconciles with what the client was actually charged even where a
     discount was applied after the fact. */
  const taxAmount = Math.max(0, inv.amount - lineTotal);

  /* The final payment is what settled it. An invoice paid in three instalments
     was not settled on the date of the first. */
  const payments = (inv.payments || [])
    .slice()
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt));
  const last = payments[payments.length - 1];
  const settled = inv.amountDue <= 0 && last ? last.receivedAt : null;

  return {
    invoice_number: inv.invoiceNumber,
    issue_date: isoDate(inv.date),
    due_date: isoDate(inv.dueDate),
    client_name: inv.client?.name || "",
    client_registration_number: inv.client?.registrationNumber || "",
    client_tin: inv.client?.tin || "",
    description: inv.invoiceName || inv.subject || "",
    currency: inv.currency,
    subtotal: amount(lineTotal),
    tax_rate: taxRate ? String(taxRate) : "0",
    tax_amount: amount(taxAmount),
    total: amount(inv.amount),
    amount_paid: amount(inv.amountPaid),
    amount_adjusted: amount(inv.amountAdjusted),
    amount_due: amount(inv.amountDue),
    status: inv.status,
    /* Blank for a partially paid invoice — it has not been settled, and a date
       here would say it had. */
    date_settled: isoDate(settled),
    payment_method: last?.method || "",
    payment_reference: last?.reference || "",
  };
}

function paymentRows(invoices) {
  const rows = [];
  for (const inv of invoices) {
    for (const p of inv.payments || []) {
      rows.push({
        invoice_number: inv.invoiceNumber,
        payment_date: isoDate(p.receivedAt),
        amount: amount(p.amount),
        currency: inv.currency,
        method: p.method,
        reference: p.reference || "",
        recorded_automatically: p.automatic ? "yes" : "no",
        note: p.note || "",
      });
    }
  }
  return rows;
}

/** Counts and totals for the cover page, in sen. */
function summarise(invoices) {
  const s = {
    issued: 0, issuedTotal: 0,
    settled: 0, settledTotal: 0,
    outstanding: 0, outstandingTotal: 0,
    credited: 0, creditedTotal: 0,
  };
  for (const inv of invoices) {
    s.issued += 1;
    s.issuedTotal += inv.amount;
    if (inv.amountDue <= 0) {
      s.settled += 1;
      s.settledTotal += inv.amountPaid;
    } else {
      s.outstanding += 1;
      s.outstandingTotal += inv.amountDue;
    }
    if (inv.amountAdjusted > 0) {
      s.credited += 1;
      s.creditedTotal += inv.amountAdjusted;
    }
  }
  return s;
}

/** The Prisma filter for a range, matching the spec's controls. */
function whereFor(userId, { from, to, clientId, status, includeVoided }) {
  return {
    userId,
    kind: "INVOICE",
    ...(from || to
      ? {
          date: {
            ...(from ? { gte: new Date(from) } : {}),
            ...(to ? { lte: new Date(to) } : {}),
          },
        }
      : {}),
    ...(clientId ? { clientId: Number(clientId) } : {}),
    ...(status ? { status } : {}),
    /* Voided invoices are absent unless explicitly asked for: they are not
       receivables and including them by default would overstate the period. */
    ...(includeVoided ? {} : { status: status || { not: "Void" } }),
  };
}

module.exports = {
  toCsv,
  invoiceRow,
  paymentRows,
  summarise,
  whereFor,
  isoDate,
  amount,
  field,
  INVOICE_COLUMNS,
  PAYMENT_COLUMNS,
  BOM,
};
