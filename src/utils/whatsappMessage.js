/**
 * One WhatsApp message, composed in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * The token-filling was written out four times — twice verbatim in
 * routes/whatsapp (send and remind), once in routes/quotes, and once more in
 * plugins/cron — and the system defaults had already drifted apart between them
 * and the settings screen. Settings previews
 *
 *   "Hi {{clientName}}, here is invoice *{{invoiceNumber}}* …"
 *
 * as what goes out when the box is left blank, while the send route actually
 * sent
 *
 *   "{{userName}} {{companyName}} via InvoKita\n\nHello {{clientName}} …"
 *
 * so a user who never touched the template was shown one message and their
 * client received a different one. Nobody would ever catch that: the preview is
 * the only place a sender sees their own wording, and the client has nothing to
 * compare against.
 *
 * The defaults below are the settings screen's, verbatim, because that is the
 * copy the user was shown and agreed to. Keep them in step with the DEFAULTS
 * object in Frontend/components/business/Whatsapp.vue — those two are the pair
 * that has to match, and the reason this module has a test.
 *
 * It also renders the message for the manual share links, which is the point of
 * the exercise: "share on WhatsApp" has to produce the same words the automated
 * send would, or the feature is a second voice for the same business.
 */

const { sen } = require("./invoiceMoney");
const { normalisePhone } = require("./phoneNormalise");

/**
 * What goes out when the sender has not written their own.
 *
 * Kept identical to the settings screen's placeholders. `remind` is only used by
 * the manual reminder route; the cron chaser has its own bilingual set with a
 * partial-payment variant, which is a different problem and stays where it is.
 */
const DEFAULTS = {
  send: "Hi {{clientName}}, here is invoice *{{invoiceNumber}}* for {{currency}} {{totalAmount}}, due {{dueDate}}.\n\nYou can view and pay it here: {{invoiceUrl}}\n\nThank you,\n{{companyName}}",
  remind:
    "Hi {{clientName}}, a quick reminder that invoice *{{invoiceNumber}}* for {{currency}} {{totalAmount}} was due on {{dueDate}}.\n\nHere is the link again: {{invoiceUrl}}\n\nThanks,\n{{companyName}}",
};

/**
 * Dates as a Malaysian reader writes them — 20 Aug 2026, day first.
 *
 * en-GB, not en-US, so this agrees with the preview in settings. The two send
 * routes were formatting en-US ("Aug 20, 2026") while the preview showed en-GB,
 * which is a small thing to see change under you after you have written a
 * sentence around it.
 */
function niceDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Substitute {{tokens}}.
 *
 * Tolerates inner whitespace, so a template typed as `{{ clientName }}` fills in
 * rather than reaching the client with the braces still on it — the old
 * `.replace(/{{clientName}}/g, …)` chain matched only the tight form.
 *
 * An UNKNOWN token is left exactly as written, deliberately. A typo that renders
 * as `{{clientNmae}}` is visible in the preview and gets fixed; silently
 * blanking it hides the mistake until a client asks who the message is for.
 */
function fillTokens(template, values) {
  return String(template || "").replace(
    /\{\{\s*(\w+)\s*\}\}/g,
    (whole, key) => (key in values ? String(values[key] ?? "") : whole),
  );
}

/**
 * The values every invoice template can reference.
 *
 * `totalAmount` goes through sen() and never through the raw column. Amounts are
 * stored in sen, so the bare value asks a client for "50,000" on a RM500
 * invoice — in a WhatsApp message, which cannot be edited once it has been read.
 */
function invoiceTokens({ invoice, profile = {}, invoiceUrl }) {
  return {
    userName: profile.name || "",
    companyName: profile.companyName || profile.name || "InvoKita User",
    clientName: invoice.client?.name || "",
    invoiceNumber: invoice.invoiceNumber || invoice.id,
    totalAmount: sen(invoice.amount),
    currency: invoice.currency || "MYR",
    dueDate: niceDate(invoice.dueDate),
    invoiceUrl: invoiceUrl || "",
  };
}

/**
 * An invoice message, from the sender's template or ours.
 *
 * `purpose` picks which of the two templates and which default: "send" for the
 * first one, "remind" for a chase.
 */
function renderInvoiceMessage({
  purpose = "send",
  template,
  invoice,
  profile,
  invoiceUrl,
}) {
  const chosen = template?.trim() ? template : DEFAULTS[purpose] || DEFAULTS.send;
  return fillTokens(chosen, invoiceTokens({ invoice, profile, invoiceUrl }));
}

/**
 * A quotation message.
 *
 * NOT user-editable, and not for want of trying: there is no quote template
 * column, and defaulting one to the invoice wording would send "your invoice is
 * due" about an offer nobody has accepted yet. A fixed correct sentence beats a
 * configurable wrong one. When quotes get their own settings row this grows a
 * `template` argument like the invoice above.
 *
 * Composed here rather than inline in the send route so the manual share link
 * and the Twilio send cannot drift.
 */
function renderQuoteMessage({ quote, profile = {}, quoteUrl }) {
  const who = [profile.name, profile.companyName || "InvoKita User"]
    .filter(Boolean)
    .join(" ");
  return (
    `${who} via InvoKita\n\n` +
    `Hello ${quote.client?.name || ""}, here is quotation ${quote.invoiceNumber} for ` +
    `${quote.currency} ${sen(quote.amount)}.` +
    (quote.validUntil
      ? ` The price holds until ${niceDate(quote.validUntil)}.`
      : "") +
    `\n\nAccept or decline here: ${quoteUrl}`
  );
}

/**
 * A wa.me link that opens the chat with the message already typed.
 *
 * THE NUMBER MUST BE INTERNATIONAL. wa.me reads the path segment as a full
 * international number with no plus — "60163590309". Hand it the local form
 * everybody actually types, "0163590309", and WhatsApp does not error: it looks
 * up a number that does not exist and shows "no account with this number" on a
 * phone, or a grey empty page on WhatsApp Web. That looks like the feature is
 * broken rather than like the number needs a country code.
 *
 * Stripping punctuation is NOT enough, which is what this used to do. "01635…"
 * survives a \D strip completely intact and is still wrong.
 *
 * So it goes through normalisePhone, the same module client import uses — the
 * one place that knows 016 is a nine-digit Malaysian mobile prefix and that the
 * leading zero is replaced by 60 rather than kept. Clients created through the
 * form are stored exactly as typed, so most numbers in the database ARE local
 * form; normalising at read time fixes every one of them without a migration.
 *
 * It returns null when there is no number, or when there is one that cannot be
 * resolved to a real international number. normalisePhone refuses rather than
 * guesses, and a refusal here is worth honouring: a wa.me link built on a guess
 * opens a chat with a stranger.
 */
function waShareUrl({ phone, text }) {
  const number = normalisePhone(phone);
  if (!number.ok) return null;
  return `https://wa.me/${number.value}?text=${encodeURIComponent(text || "")}`;
}

/**
 * Why a share link could not be built, as something the UI can say out loud.
 *
 * Split from waShareUrl so a caller can tell "no number saved" from "the number
 * saved is not one WhatsApp can dial" — different sentences, different fixes,
 * and the second one is invisible unless somebody says it.
 */
function phoneProblem(phone) {
  if (!String(phone || "").trim()) return "missing";
  return normalisePhone(phone).ok ? null : "unusable";
}

module.exports = {
  DEFAULTS,
  fillTokens,
  niceDate,
  invoiceTokens,
  renderInvoiceMessage,
  renderQuoteMessage,
  waShareUrl,
  phoneProblem,
};
