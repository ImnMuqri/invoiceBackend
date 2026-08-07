/**
 * The quotation lifecycle (spec 07), in one place.
 *
 * Quotes are Invoice rows with `kind: "QUOTE"` — see the model comment in
 * schema.prisma for why. What makes them a different DOCUMENT is the status
 * vocabulary below: not one of these words means money is owed, and nothing in
 * this file schedules, sends or implies a follow-up.
 *
 * That last point is the spec's central rule and it is worth restating where
 * somebody will read it: a quote is NEVER chased. A client who has not replied
 * to a quotation has not agreed to anything and owes nothing, so an automated
 * nudge there is sales pressure rather than collections — a different product,
 * with a different tone, spending the user's reputation on a prospect they have
 * not won yet. The chase engine stays on invoices. The guarantee is structural:
 * plugins/cron.js filters `kind: "INVOICE"` before it looks at anything.
 */

const crypto = require("crypto");

/** Every status a quotation can hold. Draft and Sent predate this spec. */
const QUOTE_STATUSES = ["Draft", "Sent", "Viewed", "Accepted", "Declined", "Expired"];

/**
 * Still waiting for an answer.
 *
 * Draft is in here deliberately even though it has not been sent: from the
 * user's point of view it is unfinished business either way, and leaving it out
 * would mean a quote written and forgotten never appears anywhere again.
 */
const OPEN_STATUSES = ["Draft", "Sent", "Viewed"];

/** Sent to somebody and not yet answered — the only states expiry applies to. */
const AWAITING_REPLY = ["Sent", "Viewed"];

/** Decided, one way or the other. */
const CLOSED_STATUSES = ["Accepted", "Declined", "Expired"];

/**
 * A url-safe token with 128 bits of entropy behind it.
 *
 * Long enough that guessing is not a strategy, short enough to survive being
 * pasted into a WhatsApp message without wrapping onto three lines. base64url
 * rather than hex for the same reason — same entropy, two thirds the length.
 */
function mintPublicToken() {
  return crypto.randomBytes(16).toString("base64url");
}

/**
 * The token for this quote, minting one if it has none.
 *
 * Existing quotes predate the column, so this is the backfill: the first time
 * anybody asks for a quote's public link, it gets one.
 *
 * The conditional update is what makes it safe to call from two places at once.
 * A plain update would let two concurrent requests on the same legacy quote
 * each mint a token and each write it, and the caller whose write lost would
 * hand its user a link that 404s — a broken url pasted into a WhatsApp message
 * and no way to tell it was ever wrong. Writing only `where publicToken: null`
 * means exactly one of them wins, and the loser reads back the winner's token
 * rather than trusting the one it generated.
 */
async function ensurePublicToken(prisma, quote) {
  if (quote.publicToken) return quote.publicToken;

  const token = mintPublicToken();
  const { count } = await prisma.invoice.updateMany({
    where: { id: quote.id, publicToken: null },
    data: { publicToken: token },
  });
  if (count === 1) return token;

  /* Somebody else got there first. Theirs is the one that is stored, so theirs
     is the only one that resolves. */
  const fresh = await prisma.invoice.findUnique({
    where: { id: quote.id },
    select: { publicToken: true },
  });
  return fresh?.publicToken || token;
}

/** Where the frontend serves the public quotation page. */
function publicQuoteUrl(token) {
  const base = (process.env.FRONTEND_URL || "http://localhost:3000")
    .replace(/['"]/g, "")
    .replace(/\/$/, "");
  return `${base}/quote/${token}`;
}

/** Malaysia is UTC+8 with no daylight saving, so one constant is the whole rule. */
const KL_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Past its validity date.
 *
 * Two decisions in here, both of which were wrong in an earlier version.
 *
 * 1. The END of the validUntil day, not its midnight. A quote that "holds until
 *    30 November" is one the client reasonably expects to be able to accept ON
 *    the 30th. Comparing against midnight takes a day off every quotation the
 *    product has ever issued.
 *
 * 2. The end of that day in KUALA LUMPUR, computed explicitly. The first
 *    version used setHours(23,59,59,999), which resolves in the process
 *    timezone — UTC on Railway — while every cron in this codebase is pinned to
 *    Asia/Kuala_Lumpur. The two disagreed by eight hours, which is enough to
 *    move an expiry across a date boundary. A user in Malaysia sets a date in
 *    Malaysian terms and the answer has to be computed in Malaysian terms,
 *    whatever the server happens to think the time is.
 *
 * validUntil is a calendar DATE (the builder stores it at UTC midnight), so its
 * UTC components are the date the user picked and are read as such.
 */
function isExpired(quote, now = new Date()) {
  if (!quote?.validUntil) return false;
  const d = new Date(quote.validUntil);
  if (Number.isNaN(d.getTime())) return false;

  /* Start of the NEXT day in KL, minus a millisecond. */
  const endOfDayKL =
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) -
    KL_OFFSET_MS -
    1;

  return endOfDayKL < now.getTime();
}

/**
 * The status to SHOW, which is not always the status stored.
 *
 * The expiry sweep runs nightly, so between a quote lapsing and 01:15 the next
 * morning the stored status still says Sent. Rather than let the two disagree
 * on screen, everything that displays a quote reads through here.
 */
function effectiveStatus(quote, now = new Date()) {
  if (!quote) return null;
  if (AWAITING_REPLY.includes(quote.status) && isExpired(quote, now)) return "Expired";
  return quote.status;
}

/** True when the client can still act on this quotation. */
function isAnswerable(quote, now = new Date()) {
  return AWAITING_REPLY.includes(quote.status) && !isExpired(quote, now);
}

module.exports = {
  QUOTE_STATUSES,
  OPEN_STATUSES,
  AWAITING_REPLY,
  CLOSED_STATUSES,
  mintPublicToken,
  ensurePublicToken,
  publicQuoteUrl,
  isExpired,
  effectiveStatus,
  isAnswerable,
};
