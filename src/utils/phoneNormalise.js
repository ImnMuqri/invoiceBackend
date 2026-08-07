/**
 * Phone number normalisation for client import (spec 08).
 *
 * The spec calls this the part most likely to break, and it is right. A phone
 * number that is silently stored wrong does not fail at import — it fails weeks
 * later as a WhatsApp message that never arrives, on an invoice the user thinks
 * is being chased. By then nobody connects the two. So the rule here is:
 *
 *   NEVER GUESS. Return a confident answer or refuse.
 *
 * A refusal shows up in the preview as a row the user can fix in ten seconds.
 * A wrong guess shows up as an unpaid invoice, and the user blames the product.
 *
 * NO LIBRARY, deliberately. libphonenumber is 300kb+ and its permissive parsing
 * is precisely wrong for this job: it is built to make sense of anything, where
 * this needs to reject anything ambiguous. The rules for the one country that
 * matters here are small, stable and worth stating explicitly.
 *
 * Malaysian numbering, which is what the local rules below encode:
 *   country code 60
 *   mobile      01X-XXXXXXX  — 9 or 10 digits after the leading 0
 *               011 and 015 are the 10-digit prefixes; 010/012-014/016-019 are 9
 *   landline    0X-XXXXXXX   — area codes 3-9, kept because people do invoice
 *                              businesses that only publish a landline
 * Stored international, no plus, no separators: "60123456789". That is the form
 * Twilio and the WhatsApp API want, and storing one canonical form is what makes
 * duplicate matching on phone number work at all.
 */

/** Malaysian mobile prefixes that carry TEN digits after the leading zero. */
const MY_MOBILE_10 = ["11", "15"];
/** Malaysian mobile prefixes that carry NINE digits after the leading zero. */
const MY_MOBILE_9 = ["10", "12", "13", "14", "16", "17", "18", "19"];

/** Every reason a number can be refused, as a code the UI turns into a sentence. */
const REASON = {
  EMPTY: "empty",
  TOO_SHORT: "too_short",
  TOO_LONG: "too_long",
  NOT_A_NUMBER: "not_a_number",
  UNKNOWN_MY_PREFIX: "unknown_my_prefix",
  BAD_MY_LENGTH: "bad_my_length",
  AMBIGUOUS: "ambiguous",
  EXTENSION: "extension",
};

/**
 * Strip the decoration people actually paste.
 *
 * Spaces, dashes, dots, brackets and a leading plus all go. Everything else
 * that is not a digit is a signal that this is not a bare phone number, and is
 * left in so the caller can refuse it rather than quietly deleting characters
 * until something looks plausible.
 */
function strip(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[\s\-(). ‐-―]/g, "");
}

/** Does this look like it carries an extension we would be dropping? */
function hasExtension(cleaned) {
  return /(ext|x|#)\d+$/i.test(cleaned);
}

function ok(e164, kind) {
  return { ok: true, value: e164, kind };
}

function fail(reason, detail) {
  return { ok: false, value: null, reason, detail: detail || null };
}

/**
 * Is this a valid Malaysian subscriber number, given the digits AFTER the
 * country code and without a leading zero? e.g. "123456789" for 012-3456789.
 */
function classifyMalaysian(national) {
  if (!/^\d+$/.test(national)) return fail(REASON.NOT_A_NUMBER);

  const two = national.slice(0, 2);

  if (MY_MOBILE_10.includes(two)) {
    /* 011 / 015: ten digits after the zero, so ten here. */
    if (national.length !== 10) {
      return fail(
        REASON.BAD_MY_LENGTH,
        `0${two} numbers have 10 digits after the 0, this has ${national.length}`,
      );
    }
    return ok(`60${national}`, "my_mobile");
  }

  if (MY_MOBILE_9.includes(two)) {
    if (national.length !== 9) {
      return fail(
        REASON.BAD_MY_LENGTH,
        `0${two} numbers have 9 digits after the 0, this has ${national.length}`,
      );
    }
    return ok(`60${national}`, "my_mobile");
  }

  /* Landlines: area code 3-9, then 7 or 8 subscriber digits. Kept because
     plenty of small businesses invoice a client who only publishes an office
     line — it cannot receive WhatsApp, but it is still a true phone number and
     refusing to store it would be the product being opinionated about the
     user's own address book. Delivery-readiness is judged separately. */
  if (/^[3-9]/.test(national)) {
    if (national.length < 8 || national.length > 9) {
      return fail(
        REASON.BAD_MY_LENGTH,
        `Malaysian landlines have 8 or 9 digits after the 0, this has ${national.length}`,
      );
    }
    return ok(`60${national}`, "my_landline");
  }

  /* Leading 0 or 1 or 2 after stripping the country code is not an allocation
     we recognise, and inventing one is exactly the guess this file exists to
     avoid. */
  return fail(REASON.UNKNOWN_MY_PREFIX, `0${two} is not a Malaysian prefix we recognise`);
}

/**
 * Normalise one phone number.
 *
 * Returns { ok: true, value, kind } or { ok: false, reason, detail }.
 *
 * `value` is digits only in international form with no plus — "60123456789".
 */
function normalisePhone(raw, { defaultCountry = "MY" } = {}) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return fail(REASON.EMPTY);

  /* Extensions before stripping, because strip() would turn "03-1234 5678 ext
     12" into something that then looks like a valid-length number with two
     junk digits welded on. Dialling that reaches nobody. */
  if (hasExtension(trimmed.replace(/[\s\-().]/g, ""))) {
    return fail(REASON.EXTENSION, "extensions cannot be dialled automatically");
  }

  const hadPlus = trimmed.startsWith("+");
  let cleaned = strip(trimmed);
  if (hadPlus) cleaned = cleaned.replace(/^\+/, "");

  if (!cleaned) return fail(REASON.EMPTY);
  if (!/^\+?\d+$/.test(cleaned)) {
    return fail(REASON.NOT_A_NUMBER, "contains characters that are not digits");
  }

  /* ── Already international ──────────────────────────────────────────────
     An explicit + is the one unambiguous signal in this whole file, so it is
     honoured for every country and NOT reinterpreted against the default. The
     spec asks for exactly this: preserve numbers that are already in
     international format for other countries. */
  if (hadPlus) {
    if (cleaned.startsWith("60")) return classifyMalaysian(cleaned.slice(2));
    if (cleaned.length < 7) return fail(REASON.TOO_SHORT);
    /* E.164 caps at 15 digits including the country code. */
    if (cleaned.length > 15) return fail(REASON.TOO_LONG);
    return ok(cleaned, "international");
  }

  /* ── 00 international prefix ────────────────────────────────────────────
     "0060123456789" and "0065xxxxxxx" — the dial-out prefix used across Asia
     and Europe. Unambiguous once recognised. */
  if (cleaned.startsWith("00")) {
    const rest = cleaned.slice(2);
    if (rest.startsWith("60")) return classifyMalaysian(rest.slice(2));
    if (rest.length < 7) return fail(REASON.TOO_SHORT);
    if (rest.length > 15) return fail(REASON.TOO_LONG);
    return ok(rest, "international");
  }

  if (defaultCountry !== "MY") {
    /* The default country is a constructor argument rather than a hardcoded
       assumption so this stays honest if the product ever ships elsewhere, but
       only MY has rules written. Anything else must arrive already
       international rather than being guessed at. */
    return fail(REASON.AMBIGUOUS, "no local rules for this country");
  }

  /* ── Local Malaysian forms ──────────────────────────────────────────────
     Leading zero: the form on every business card in the country. */
  if (cleaned.startsWith("0")) return classifyMalaysian(cleaned.slice(1));

  /* Country code with no plus and no zero: "60123456789", the form that comes
     out of a phone's contact export. Length is what disambiguates it from a
     local number starting with 6 — Malaysia has no 06x mobile allocation, and
     a landline written without its leading zero would be 8-9 digits, not 11. */
  if (cleaned.startsWith("60") && cleaned.length >= 11) {
    return classifyMalaysian(cleaned.slice(2));
  }

  /* Bare subscriber number, no country code, no zero: "123456789" for
     012-3456789. Common when a spreadsheet column was formatted as a NUMBER —
     Excel eats the leading zero and there is no way to get it back. Accepted
     only when adding the zero produces a valid Malaysian number, which is a
     real check and not an assumption. */
  const asLocal = classifyMalaysian(cleaned);
  if (asLocal.ok) return asLocal;

  if (cleaned.length < 7) return fail(REASON.TOO_SHORT);
  if (cleaned.length > 15) return fail(REASON.TOO_LONG);

  /* Long enough to be a phone number somewhere, but nothing here says WHERE,
     and a number stored against the wrong country fails silently at send time.
     Refuse it and let the preview ask. */
  return fail(
    REASON.AMBIGUOUS,
    "add the country code (e.g. +65) or the leading 0 for a Malaysian number",
  );
}

/** Pretty form for display only. Never stored — the canonical value is digits. */
function displayPhone(e164) {
  if (!e164) return "";
  const s = String(e164);
  if (s.startsWith("60")) {
    const national = s.slice(2);
    const two = national.slice(0, 2);
    if (MY_MOBILE_10.includes(two) || MY_MOBILE_9.includes(two)) {
      /* 0 12-345 6789 → the grouping Malaysians actually read. */
      return `0${national.slice(0, 2)}-${national.slice(2)}`;
    }
    return `0${national.slice(0, 1)}-${national.slice(1)}`;
  }
  return `+${s}`;
}

/**
 * Can this client be sent anything?
 *
 * The spec's rule, in one place: a client needs a phone number OR an email
 * address to be usable for delivery. It is a rule about the PAIR, which is why
 * it lives here rather than as a NOT NULL on either column.
 *
 * A landline counts as a phone number for storage but NOT for WhatsApp, and
 * saying so is the difference between a user who knows and a user who finds out
 * when a message does not arrive.
 */
function deliverability({ phone, phoneKind, email }) {
  const canWhatsApp = !!phone && phoneKind === "my_mobile";
  const canEmail = !!email;
  /* An international mobile is still messageable — we simply cannot tell a
     mobile from a landline abroad without a per-country rule set, so it is
     reported as unknown rather than promised. */
  const maybeWhatsApp = !!phone && phoneKind === "international";

  return {
    canEmail,
    canWhatsApp,
    maybeWhatsApp,
    reachable: canEmail || canWhatsApp || maybeWhatsApp,
  };
}

module.exports = {
  normalisePhone,
  displayPhone,
  deliverability,
  REASON,
  MY_MOBILE_9,
  MY_MOBILE_10,
};
