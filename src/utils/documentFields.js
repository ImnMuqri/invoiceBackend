/**
 * What a document must always say about who sent it.
 *
 * Almost every field on an invoice is the user's choice. Two are not, and this
 * file is the whole of that exception:
 *
 *   1. THE BUSINESS NAME ALWAYS PRINTS. A document that does not name its
 *      sender is not a document. The client cannot file it, cannot pay it
 *      against anything, and cannot tell who is asking.
 *
 *   2. AT LEAST ONE CONTACT ALWAYS PRINTS — the business phone or the business
 *      email, whichever the account has. Naming a sender with no way to reach
 *      them is only marginally better than not naming them: the first question
 *      a client has about an invoice is who to ask about it.
 *
 * The contact rule is about the PAIR, deliberately. Requiring the phone
 * specifically would be wrong for somebody who only trades by email, and
 * requiring the email would be wrong for the many Malaysian businesses that run
 * on WhatsApp. Either one satisfies it. This mirrors the reachability rule
 * already used for clients (spec 08) — the same idea, applied to the sender.
 *
 * Enforced on the SERVER as well as in the settings UI, because the switches
 * post a plain JSON body and a disabled checkbox is a hint to a browser rather
 * than a rule.
 */

/** Print switches that cannot be turned off. */
const ALWAYS_ON = ["invoiceIncludeCompanyName"];

/** At least one of these must stay on. */
const CONTACT_FIELDS = ["invoiceIncludeCompanyPhone", "invoiceIncludeEmail"];

/**
 * Force a settings payload to satisfy the rules.
 *
 * Takes the incoming values merged over whatever is already stored, and returns
 * the corrections to apply. Returns an empty object when nothing needs fixing,
 * so a caller can spread it unconditionally.
 *
 * Corrects rather than rejects. Somebody unticking their last contact detail
 * has made a small mistake, not an attack, and an error dialog over a checkbox
 * is a worse experience than the switch simply refusing to go off — which is
 * what the UI shows them anyway.
 */
function enforceDocumentFields(next = {}) {
  const fixes = {};

  for (const key of ALWAYS_ON) {
    if (next[key] === false) fixes[key] = true;
  }

  const hasContact = CONTACT_FIELDS.some((key) =>
    fixes[key] !== undefined ? fixes[key] : next[key],
  );

  if (!hasContact) {
    /* Restore the phone. Arbitrary between the two, but not random: WhatsApp is
       how this product's users are actually reached, and the phone is the field
       more of them have filled in. */
    fixes[CONTACT_FIELDS[0]] = true;
  }

  return fixes;
}

/**
 * Is this profile complete enough to issue a document from?
 *
 * A business name, and a phone number or an email address. Returns
 * { ok } or { ok: false, missing, message }.
 */
function checkSenderIdentity(profile = {}) {
  const name = String(profile.companyName || "").trim();
  const phone = String(profile.companyPhone || "").trim();
  const email = String(profile.companyEmail || "").trim();

  const missing = [];
  if (!name) missing.push("companyName");
  if (!phone && !email) missing.push("companyPhone|companyEmail");

  if (!missing.length) return { ok: true };

  return {
    ok: false,
    missing,
    message: !name
      ? "Add your business name — it has to appear on every document you send."
      : "Add a business phone number or email address, so clients have a way to reach you about an invoice.",
  };
}

module.exports = {
  ALWAYS_ON,
  CONTACT_FIELDS,
  enforceDocumentFields,
  checkSenderIdentity,
};
