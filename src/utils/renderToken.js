const crypto = require("crypto");
const { safeEqual } = require("./gateways/compare");

/**
 * Short-lived, single-invoice tokens for the PDF render path.
 *
 * The problem these solve: a PDF is made by pointing Puppeteer at the frontend's
 * /invoices/:id/export page, and Puppeteer carries no session. To make that
 * work, GET /invoices/:id had been left outside the authenticated sub-plugin
 * entirely — public, unauthenticated, no ownership check, on an integer id. It
 * returned the client's contact details, the sender's company details, the line
 * items and the manual-payment block, which is a bank account number, the
 * account holder's name and a DuitNow QR. Incrementing the id walked the table.
 *
 * A token issued by the backend, valid for one invoice for a couple of minutes,
 * lets the render keep working while the endpoint goes back behind a real check.
 *
 * Stateless on purpose: an HMAC over "invoiceId.expiry" needs no storage and no
 * cleanup, and the PDF is fetched seconds after the token is minted. The trade
 * is that a leaked token cannot be revoked before it expires, which is why the
 * window is two minutes rather than a day.
 *
 * Keyed off JWT_SECRET so there is no new secret to deploy or rotate. It is
 * domain-separated with a prefix so a render token can never be confused with,
 * or substituted for, a session token signed by the same key.
 */
const TTL_MS = 2 * 60 * 1000;
const PREFIX = "invoice-render:v1:";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET is required to sign render tokens");
  return s;
}

function sign(payload) {
  return crypto
    .createHmac("sha256", secret())
    .update(PREFIX + payload)
    .digest("hex");
}

/** Mint a token for one invoice. Returns "<expiryMs>.<hmac>". */
function createRenderToken(invoiceId) {
  const expiry = Date.now() + TTL_MS;
  const payload = `${invoiceId}.${expiry}`;
  return `${expiry}.${sign(payload)}`;
}

/**
 * True when `token` was issued for this invoice and has not expired.
 * Never throws — a malformed token is simply not valid.
 */
function verifyRenderToken(invoiceId, token) {
  if (typeof token !== "string" || !token.includes(".")) return false;

  const idx = token.indexOf(".");
  const expiryRaw = token.slice(0, idx);
  const received = token.slice(idx + 1);

  const expiry = Number(expiryRaw);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return false;

  /* The invoice id is inside the signed payload, so a token minted for invoice
     7 cannot be replayed against invoice 8 — the HMAC will not match. */
  const expected = sign(`${invoiceId}.${expiry}`);
  return safeEqual(expected, received);
}

module.exports = { createRenderToken, verifyRenderToken, RENDER_TOKEN_TTL_MS: TTL_MS };
