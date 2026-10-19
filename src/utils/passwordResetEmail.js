/**
 * The "reset your password" email.
 *
 * This one is from InvoKita to an account holder (not from a sender to their
 * client), so it carries the InvoKita mark. Written in both languages the
 * product speaks; the locale comes from the page the request was made on.
 *
 * Plain inline styles and a single table: it has to survive Gmail, Outlook and
 * phone mail clients, none of which run a stylesheet reliably.
 */

const RESET_TTL_MINUTES = 60;

const COPY = {
  en: {
    subject: "Reset your InvoKita password",
    preheader: "Use this link to set a new password. It works once.",
    hello: (name) => (name ? `Hi ${name},` : "Hi,"),
    body: "Someone asked to reset the password for your InvoKita account. If it was you, set a new one with the button below.",
    cta: "Set a new password",
    expiry: `The link works once and expires in ${RESET_TTL_MINUTES} minutes.`,
    ignore: "If you did not ask for this, you can ignore this email. Your password stays the same.",
    fallback: "Button not working? Paste this link into your browser:",
  },
  ms: {
    subject: "Tetapkan semula kata laluan InvoKita anda",
    preheader: "Guna pautan ini untuk tetapkan kata laluan baharu. Ia boleh diguna sekali.",
    hello: (name) => (name ? `Hai ${name},` : "Hai,"),
    body: "Seseorang minta tetapkan semula kata laluan akaun InvoKita anda. Jika itu anda, tetapkan yang baharu dengan butang di bawah.",
    cta: "Tetapkan kata laluan baharu",
    expiry: `Pautan ini boleh diguna sekali dan luput dalam ${RESET_TTL_MINUTES} minit.`,
    ignore: "Jika anda tidak memintanya, abaikan emel ini. Kata laluan anda kekal sama.",
    fallback: "Butang tak berfungsi? Tampal pautan ini dalam pelayar anda:",
  },
};

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function getPasswordResetEmail({ name, link, locale = "en" }) {
  const c = COPY[locale === "ms" ? "ms" : "en"];
  const safeLink = esc(link);

  const html = `<!DOCTYPE html>
<html lang="${locale === "ms" ? "ms" : "en"}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#FAF6EF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0D1B17">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF6EF;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border:1px solid #E9EFED;border-radius:16px">
<tr><td style="padding:28px 28px 8px">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:36px;height:36px;background:#059669;border-radius:9px;text-align:center;vertical-align:middle;font-weight:800;font-size:20px;color:#0D1B17">K</td>
<td style="padding-left:10px;font-weight:800;font-size:18px;letter-spacing:-0.3px">InvoKita</td>
</tr></table>
</td></tr>
<tr><td style="padding:16px 28px 0;font-size:22px;font-weight:800;letter-spacing:-0.4px">${esc(c.subject)}</td></tr>
<tr><td style="padding:14px 28px 0;font-size:15px;line-height:1.6;color:#3D554E">${esc(c.hello(name))}<br><br>${esc(c.body)}</td></tr>
<tr><td style="padding:22px 28px 0">
<a href="${safeLink}" style="display:inline-block;background:#059669;color:#0D1B17;text-decoration:none;font-weight:800;font-size:15px;padding:13px 20px;border-radius:10px">${esc(c.cta)}</a>
</td></tr>
<tr><td style="padding:16px 28px 0;font-size:13px;line-height:1.6;color:#556E67">${esc(c.expiry)}<br>${esc(c.ignore)}</td></tr>
<tr><td style="padding:18px 28px 28px;font-size:12px;line-height:1.6;color:#6E877F">${esc(c.fallback)}<br><a href="${safeLink}" style="color:#057B56;word-break:break-all">${safeLink}</a></td></tr>
</table>
<p style="margin:16px 0 0;font-size:12px;color:#6E877F">InvoKita · BSYX LABS</p>
</td></tr>
</table>
</body>
</html>`;

  const text = [c.subject, "", c.hello(name), "", c.body, "", link, "", c.expiry, c.ignore].join("\n");

  return { subject: c.subject, html, text };
}

module.exports = { getPasswordResetEmail, RESET_TTL_MINUTES };
