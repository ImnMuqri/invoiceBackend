/**
 * Emails for the quotation loop (spec 07).
 *
 * Three of them, and the difference between the first and the other two is the
 * whole point of the spec:
 *
 *   getQuoteEmail        → to the CLIENT, once, when the user presses send.
 *   getQuoteAnsweredEmail→ to the OWNER, when the client accepts or declines.
 *   getQuoteExpiredEmail → to the OWNER, when a quote lapses unanswered.
 *
 * Only the first is ever addressed to a client, and nothing schedules it. A
 * quotation is an offer; following it up automatically is sales pressure on
 * somebody who has agreed to nothing, and that is a different product. The two
 * owner-facing emails exist precisely SO the client never gets chased — the
 * signal comes to the user, who can pick up the phone if they want to.
 */

const { sen } = require("./invoiceMoney");

/* Thousands separators on top of the sen conversion — same helper the invoice
   template uses, and for the same reason: `amount` is sen everywhere in this
   codebase, so formatting it raw quotes the client a hundred times the price. */
const money = (value) => {
  const [whole, cents] = sen(value).split(".");
  return `${Number(whole).toLocaleString()}.${cents}`;
};

const appUrl = () =>
  (process.env.FRONTEND_URL || "http://localhost:3000")
    .replace(/['"]/g, "")
    .replace(/\/$/, "");

const longDate = (d) =>
  new Date(d).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

/* Escaped, because every one of these interpolates a name typed by somebody
   else — a client's name on the way in, a decline reason on the way back. HTML
   email clients render tags, so an unescaped `<` is a hole. */
const esc = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const shell = (inner) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#1e293b;">
  <div style="max-width:600px;margin:40px auto;padding:32px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
      <tr><td align="center">
        <img src="${appUrl()}/InvoKitaLogo.png" alt="InvoKita" width="32" height="32" style="vertical-align:middle;" />
        <span style="font-size:24px;font-weight:800;color:#0f172a;letter-spacing:-0.025em;vertical-align:middle;margin-left:12px;">InvoKita</span>
      </td></tr>
    </table>
    ${inner}
    <div style="text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:24px;margin-top:32px;">
      Sent via InvoKita.
    </div>
  </div>
</body>
</html>`;

const button = (href, label) => `
  <div style="text-align:center;margin-bottom:24px;">
    <a href="${href}" style="display:inline-block;background-color:#0f172a;color:#ffffff;padding:14px 28px;border-radius:10px;font-weight:600;text-decoration:none;">${label}</a>
  </div>`;

/**
 * The quotation itself, to the client.
 *
 * The whole email is built around the link, because the link is where the
 * decision happens. A PDF alone is a document somebody means to reply to and
 * then does not; a page with two buttons on it is a decision they can make
 * standing up.
 *
 * `amount` is SEN, like every money value in this codebase.
 */
function getQuoteEmail({
  clientName,
  senderName,
  senderCompany,
  quoteNumber,
  amount,
  currency,
  validUntil,
  subject,
  publicUrl,
}) {
  const from = senderCompany || senderName || "your supplier";

  const html = shell(`
    <p style="margin-bottom:32px;font-size:16px;color:#475569;">
      Hi <strong>${esc(clientName)}</strong>,<br><br>
      Here is a quotation from <strong>${esc(from)}</strong>${
        senderCompany && senderName ? ` (${esc(senderName)})` : ""
      }.
    </p>

    <div style="background-color:#f1f5f9;border-radius:12px;padding:24px;margin-bottom:32px;text-align:center;">
      <span style="display:inline-block;padding:4px 12px;border-radius:9999px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#6366f1;background-color:#eef2ff;margin-bottom:16px;">Quotation</span>
      <span style="font-size:14px;color:#64748b;margin-bottom:8px;display:block;">${esc(quoteNumber)}</span>
      ${subject ? `<span style="font-size:14px;color:#475569;display:block;margin-bottom:8px;">${esc(subject)}</span>` : ""}
      <span style="font-size:14px;color:#475569;margin-bottom:4px;display:block;">Quoted price</span>
      <div style="font-size:36px;font-weight:800;color:#0f172a;margin-bottom:16px;">${esc(currency)} ${money(amount)}</div>
      ${
        validUntil
          ? `<div style="font-size:14px;color:#64748b;padding-top:16px;border-top:1px solid #e2e8f0;">This price holds until ${longDate(validUntil)}</div>`
          : ""
      }
    </div>

    ${button(publicUrl, "View and respond")}

    <p style="font-size:14px;color:#64748b;text-align:center;margin-bottom:0;">
      You can accept or decline it on that page — no account needed.
      <br>Nothing is owed until a quotation is accepted and invoiced.
    </p>
  `);

  const text = [
    `Hi ${clientName},`,
    "",
    `Here is a quotation from ${from}.`,
    "",
    `${quoteNumber}${subject ? ` — ${subject}` : ""}`,
    `Quoted price: ${currency} ${money(amount)}`,
    validUntil ? `This price holds until ${longDate(validUntil)}.` : "",
    "",
    `View and respond: ${publicUrl}`,
    "",
    "You can accept or decline it on that page — no account needed.",
    "Nothing is owed until a quotation is accepted and invoiced.",
  ]
    .filter((l) => l !== "")
    .join("\n");

  return {
    subject: `Quotation ${quoteNumber} from ${from}`,
    html,
    text,
  };
}

/**
 * The answer, to the owner.
 *
 * An accepted quotation is work already won and not yet billed, which is the
 * single most valuable thing to put in front of somebody — so the accepted
 * version leads with the invoice, not with congratulations.
 */
function getQuoteAnsweredEmail({
  accepted,
  quoteNumber,
  clientName,
  acceptedName,
  reason,
  amount,
  currency,
  quoteId,
}) {
  const manageUrl = `${appUrl()}/quotes/edit/${quoteId}`;

  if (accepted) {
    const html = shell(`
      <p style="margin-bottom:24px;font-size:16px;color:#475569;">
        <strong>${esc(clientName)}</strong> accepted quotation
        <strong>${esc(quoteNumber)}</strong>.
      </p>

      <div style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:24px;margin-bottom:32px;text-align:center;">
        <span style="font-size:14px;color:#475569;display:block;margin-bottom:4px;">Accepted</span>
        <div style="font-size:32px;font-weight:800;color:#0f172a;">${esc(currency)} ${money(amount)}</div>
        ${acceptedName ? `<div style="font-size:14px;color:#64748b;padding-top:16px;border-top:1px solid #bbf7d0;margin-top:16px;">Accepted by ${esc(acceptedName)}</div>` : ""}
      </div>

      <p style="margin-bottom:24px;font-size:15px;color:#475569;">
        Nothing has been billed yet. Turning it into an invoice carries the
        client, the lines and the amounts across — you do not retype anything.
      </p>

      ${button(manageUrl, "Raise the invoice")}
    `);

    const text = [
      `${clientName} accepted quotation ${quoteNumber}.`,
      "",
      `Accepted: ${currency} ${money(amount)}`,
      acceptedName ? `Accepted by: ${acceptedName}` : "",
      "",
      "Nothing has been billed yet. Raise the invoice here:",
      manageUrl,
    ]
      .filter((l) => l !== "")
      .join("\n");

    return { subject: `Accepted: ${quoteNumber} — ${clientName}`, html, text };
  }

  const html = shell(`
    <p style="margin-bottom:24px;font-size:16px;color:#475569;">
      <strong>${esc(clientName)}</strong> declined quotation
      <strong>${esc(quoteNumber)}</strong>.
    </p>

    ${
      reason
        ? `<div style="background-color:#f8fafc;border-left:3px solid #cbd5e1;border-radius:4px;padding:16px 20px;margin-bottom:24px;">
             <span style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;display:block;margin-bottom:8px;">What they said</span>
             <span style="font-size:15px;color:#334155;">${esc(reason)}</span>
           </div>`
        : `<p style="margin-bottom:24px;font-size:15px;color:#64748b;">They did not leave a reason.</p>`
    }

    <p style="margin-bottom:24px;font-size:15px;color:#475569;">
      Nothing has been sent to them about this. If it is worth another
      conversation, that one is yours to have.
    </p>

    ${button(manageUrl, "Open the quotation")}
  `);

  const text = [
    `${clientName} declined quotation ${quoteNumber}.`,
    "",
    reason ? `What they said: ${reason}` : "They did not leave a reason.",
    "",
    "Nothing has been sent to them about this.",
    manageUrl,
  ].join("\n");

  return { subject: `Declined: ${quoteNumber} — ${clientName}`, html, text };
}

/**
 * A quotation lapsed, to the owner.
 *
 * Sent to the USER and nobody else. The client hears nothing when a quote
 * expires — that would be an automated nudge on an offer they never answered,
 * which is the exact thing this spec refuses to build.
 */
function getQuoteExpiredEmail({ quotes }) {
  const rows = quotes
    .map(
      (q) => `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;">
          <strong>${esc(q.invoiceNumber)}</strong><br>
          <span style="color:#64748b;font-size:13px;">${esc(q.clientName)}</span>
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;text-align:right;white-space:nowrap;">
          ${esc(q.currency)} ${money(q.amount)}
        </td>
      </tr>`,
    )
    .join("");

  const one = quotes.length === 1;

  const html = shell(`
    <p style="margin-bottom:24px;font-size:16px;color:#475569;">
      ${one ? "A quotation has" : `${quotes.length} quotations have`} passed
      ${one ? "its" : "their"} validity date without an answer.
    </p>

    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:32px;">
      ${rows}
    </table>

    <p style="margin-bottom:24px;font-size:15px;color:#475569;">
      Nothing was sent to ${one ? "the client" : "the clients"} — this is for you.
      If the work is still live, extend the date or send a fresh quotation.
    </p>

    ${button(`${appUrl()}/quotes`, "Open your quotations")}
  `);

  const text = [
    one
      ? "A quotation has passed its validity date without an answer."
      : `${quotes.length} quotations have passed their validity date without an answer.`,
    "",
    ...quotes.map(
      (q) => `${q.invoiceNumber} — ${q.clientName} — ${q.currency} ${money(q.amount)}`,
    ),
    "",
    `Nothing was sent to ${one ? "the client" : "the clients"} — this is for you.`,
    `${appUrl()}/quotes`,
  ].join("\n");

  return {
    subject: one
      ? `Quotation ${quotes[0].invoiceNumber} expired unanswered`
      : `${quotes.length} quotations expired unanswered`,
    html,
    text,
  };
}

module.exports = {
  getQuoteEmail,
  getQuoteAnsweredEmail,
  getQuoteExpiredEmail,
};
