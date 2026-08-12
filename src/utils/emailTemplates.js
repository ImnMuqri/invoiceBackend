const { sen } = require("./invoiceMoney");

/* Thousands separators for a headline figure, on top of the sen conversion.
   Formatting alone was the bug: `amount` is sen, so a RM500 invoice went out
   to the client as "MYR 50,000.00" in the Amount Due block. */
const money = (value) => {
  const [whole, cents] = sen(value).split(".");
  return `${Number(whole).toLocaleString()}.${cents}`;
};

/* Anything interpolated into this HTML comes from a user-editable field — a
   company name, a client name — and lands in somebody else's mail client. */
const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Generates a professional HTML email template for invoices.
 * `amount` is SEN, like every money value in this codebase.
 *
 * WHOSE BRAND IS AT THE TOP. The sender's. This template used to open with the
 * InvoKita logo and wordmark, centred, above everything — so a client who was
 * sent an invoice by their supplier opened an email branded by a company they
 * have no relationship with, and the actual sender appeared only as text in the
 * sentence below it. The pay page and the quotation page had the same fault and
 * were fixed; this is the surface a client sees FIRST, before either of them.
 *
 * `senderLogo` is the account's uploaded letterhead (an absolute R2 or backend
 * url — see utils/storage.js). Absent for most accounts, so the header falls
 * back to their company name set as type, which is still theirs.
 *
 * `attribution` is the object from utils/attribution.js, or null. Same rule as
 * every other client-facing surface, so an account that pays to remove our line
 * has it removed here too rather than only on the two pages that asked.
 */
const getInvoiceEmailTemplate = ({
  clientName,
  senderName,
  senderCompany,
  senderLogo,
  attribution,
  invoiceNumber,
  amount,
  currency,
  dueDate,
  status,
  publicUrl,
  isPayable = false,
}) => {
  const statusColor = status === "Overdue" ? "#ef4444" : "#6366f1";
  const statusBg = status === "Overdue" ? "#fee2e2" : "#eef2ff";

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.5; color: #1e293b; margin: 0; padding: 0; background-color: #f8fafc; width: 100% !important; }
        .container { max-width: 600px; width: 100%; margin: 40px auto; padding: 32px; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
        .header-table { width: 100%; margin-bottom: 32px; }
        .logo-svg { width: 32px; height: 32px; display: inline-block; vertical-align: middle; }
        .logo { font-size: 24px; font-weight: 800; color: #0f172a; letter-spacing: -0.025em; display: inline-block; vertical-align: middle; margin-left: 12px; }
        .intro { margin-bottom: 32px; font-size: 16px; color: #475569; }
        
        /* UI Card Styling */
        .invoice-card { background-color: #f1f5f9; border-radius: 12px; padding: 24px; margin-bottom: 32px; text-align: center; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: ${statusColor}; background-color: ${statusBg}; margin-bottom: 16px; }
        .invoice-id { font-size: 14px; color: #64748b; margin-bottom: 8px; display: block; }
        .amount-label { font-size: 14px; color: #475569; margin-bottom: 4px; display: block; }
        .amount-value { font-size: 36px; font-weight: 800; color: #0f172a; margin-bottom: 16px; }
        .due-date { font-size: 14px; color: #64748b; padding-top: 16px; border-top: 1px solid #e2e8f0; }

        .button { display: inline-block; background-color: #0f172a; color: #ffffff !important; padding: 14px 28px; border-radius: 10px; font-weight: 600; text-decoration: none; transition: background-color 0.2s; margin-bottom: 24px; }
        .footer { text-align: center; font-size: 12px; color: #94a3b8; border-top: 1px solid #f1f5f9; padding-top: 24px; }
      </style>
    </head>
    <body>
      <div class="container">
        <table class="header-table" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td align="center">
              ${
                senderLogo
                  ? `<img src="${esc(senderLogo)}" alt="${esc(senderCompany || senderName || "")}" style="max-height: 48px; max-width: 200px; width: auto; height: auto;" />`
                  : `<span class="logo">${esc(senderCompany || senderName || "Invoice")}</span>`
              }
            </td>
          </tr>
        </table>

        <p class="intro">
          Hi <strong>${esc(clientName)}</strong>,
          <br><br>
          You have received an invoice from <strong>${esc(senderName)}</strong>${senderCompany ? ` at <strong>${esc(senderCompany)}</strong>` : ""}.
        </p>

        <div class="invoice-card">
          <span class="status-badge">${status}</span>
          <span class="invoice-id">${invoiceNumber}</span>
          <span class="amount-label">Amount Due</span>
          <div class="amount-value">${currency} ${money(amount)}</div>
          <div class="due-date">Due ${new Date(dueDate).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" })}</div>
        </div>

        <div style="text-align: center;">
          <a href="${publicUrl}" class="button">${isPayable ? "View & Pay Invoice" : "View Invoice"}</a>
        </div>

        <p style="font-size: 14px; color: #64748b; text-align: center; margin-bottom: 32px;">
          A PDF copy of your invoice is also attached to this email.
        </p>

        <!-- Ours, at the foot, and only when the account has not paid to remove
             it — the same rule and the same placement as the payment page and
             the PDF. It used to sit here unconditionally, which is how a Max
             customer ended up with our line stripped from one surface and
             printed on the next. -->
        ${
          attribution
            ? `<div class="footer">
          <a href="${esc(attribution.url)}" style="color: #94a3b8; text-decoration: none;">${esc(attribution.text)}</a>
        </div>`
            : ""
        }
      </div>
    </body>
    </html>
  `;
};

module.exports = {
  getInvoiceEmailTemplate,
};
