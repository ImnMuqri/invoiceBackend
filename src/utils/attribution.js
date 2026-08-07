/**
 * "Sent with InvoKita" — attribution on client-facing documents (spec 09).
 *
 * Every invoice this product sends lands in front of a second person, and that
 * person is very often somebody who also sends invoices. That touchpoint is
 * distribution built into the product rather than bought, and this file is the
 * whole of it.
 *
 * ONE RULE, ONE PLACE. Two surfaces show this — the public payment page and the
 * invoice PDF — and they are rendered by completely different code paths from
 * different endpoints. If each decided for itself whether to draw the line, they
 * would eventually disagree, and the disagreement would be visible to a paying
 * customer's client: attribution stripped from the page they were sent but
 * still printed on the PDF attached to it. So both ask this function.
 *
 * THE TONE MATTERS AS MUCH AS THE RULE. The spec is blunt about it: this must
 * never compete with the user's own logo or make their invoice look like an
 * advert. A user who feels their invoice looks cheap will either upgrade to
 * remove it, which is fine, or leave, which is not. Small, at the foot, one
 * line. If you are ever tempted to make it bigger, read that sentence again.
 */

/**
 * Plans that cannot remove it.
 *
 * A DENYLIST, not an allowlist, and that is the opposite of how usage.js floors
 * an unrecognised plan at zero. The two are different kinds of decision: an
 * unknown plan granting unlimited quota is free money, whereas an unknown plan
 * hiding this line costs one marketing impression. Against that, an allowlist
 * would mean a plan renamed in the admin table silently stopped honouring a
 * paying customer's setting and our branding reappeared on their invoices with
 * no explanation. The cheap failure is preferred to the visible one.
 *
 * Matched case-insensitively; a null or empty plan is free.
 */
const FREE_PLANS = ["FREE"];

/**
 * Should this document carry attribution?
 *
 *   free tier  → always, and the toggle is ignored
 *   paid plans → yes unless the account has switched it off
 *
 * `enabled` being null or undefined means "never chosen", which is the same as
 * on — the column defaults to true and a missing config row must not silently
 * become an opt-out.
 */
function showAttribution(plan, enabled) {
  const name = String(plan || "FREE").toUpperCase();
  if (FREE_PLANS.includes(name)) return true;
  return enabled !== false;
}

/** True when the account is allowed to turn it off at all. */
function canRemoveAttribution(plan) {
  const name = String(plan || "FREE").toUpperCase();
  return !FREE_PLANS.includes(name);
}

/**
 * Where the line points.
 *
 * The source parameter is what makes this measurable rather than decorative —
 * a signup arriving from an invoice somebody was sent is the single clearest
 * signal that this loop works, and without the tag it is indistinguishable
 * from direct traffic.
 *
 * `surface` separates the payment page from the PDF, because they convert
 * differently and knowing which one earns the signups decides where any future
 * effort goes.
 */
function attributionUrl(surface = "invoice") {
  const base = (process.env.MARKETING_URL || "https://invokita.my").replace(/\/$/, "");
  const params = new URLSearchParams({
    utm_source: "invoice",
    utm_medium: "attribution",
    utm_campaign: surface,
  });
  return `${base}/?${params.toString()}`;
}

/**
 * The words.
 *
 * Both languages are written even though only English is reachable today: the
 * payment page and the PDF are English-only surfaces because there is no
 * document language on an account to choose with. When one is added, this map
 * is already here and the call sites take a locale argument. Writing the Malay
 * now — rather than leaving a TODO — is what stops "add a language" turning
 * into "and now go and find every string".
 */
const COPY = {
  en: "Sent with InvoKita",
  ms: "Dihantar dengan InvoKita",
};

/**
 * Everything a surface needs, or null when nothing should be drawn.
 *
 * Returning null rather than `{ show: false }` is deliberate — a template that
 * does `v-if="attribution"` cannot accidentally render a hidden-but-present
 * block, which is the shape this kind of flag usually fails in.
 */
function attributionFor({ plan, enabled, surface = "invoice", locale = "en" }) {
  if (!showAttribution(plan, enabled)) return null;
  return {
    text: COPY[locale] || COPY.en,
    url: attributionUrl(surface),
  };
}

module.exports = {
  showAttribution,
  canRemoveAttribution,
  attributionUrl,
  attributionFor,
  COPY,
  FREE_PLANS,
};
