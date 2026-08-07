/**
 * Tax identity fields (spec 05).
 *
 * Light validation only, and deliberately so. There is no format check against
 * any official pattern and no lookup against any external service: an SSM
 * number, a TIN and an SST number all have formats that have changed over time,
 * and a regex that rejects a number a user is holding in their hand is worse
 * than no validation at all. The cost of storing something malformed here is
 * that it prints wrong on a document the user can see; the cost of refusing it
 * is that they cannot use the field.
 *
 * TWO FORMS, ONE COLUMN.
 *
 * The spec asks for both "strip spaces and dashes for storage" and "preserving
 * the user's formatting for display". With one column those cannot both be
 * literally true, so:
 *
 *   store()      what goes in the column — trimmed, internal whitespace
 *                collapsed, uppercased. Dashes and brackets survive, because
 *                "202301012345 (1234567-A)" is how a Malaysian company
 *                registration number is written and printed.
 *   normalise()  the comparison form — spaces, dashes and brackets removed.
 *
 * Display fidelity wins the column because it is the half a user notices. The
 * comparison form has no consumer today (lookups are explicitly out of scope)
 * and is computed on demand, so nothing can drift out of sync with the value
 * actually shown on the invoice.
 */

/** Empty, whitespace-only and null all mean "not provided". */
function blank(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

/**
 * What goes in the column.
 *
 * Returns null rather than "" for an empty value, so clearing a field in the
 * UI actually clears it instead of storing a string that is truthy in some
 * languages and falsy in others.
 */
function store(value) {
  if (blank(value)) return null;
  return String(value).trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * The comparison form: identifiers that differ only in punctuation are the
 * same identifier. Not written to the database — see the header.
 */
function normalise(value) {
  if (blank(value)) return null;
  return String(value)
    .toUpperCase()
    .replace(/[\s\-–—()/.]/g, "");
}

/** True when two identifiers are the same number written differently. */
function sameIdentifier(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  return x !== null && x === y;
}

/**
 * The four business identifiers, cleaned for writing.
 *
 * `undefined` is preserved as `undefined` — Prisma reads that as "leave this
 * column alone", which is what makes the partial saves on the Business page
 * safe. Only an explicitly empty value clears a column.
 */
function businessFields(data = {}) {
  const out = {};
  for (const key of ["registrationNumber", "tin", "msicCode", "sstNumber"]) {
    if (data[key] !== undefined) out[key] = store(data[key]);
  }
  return out;
}

/** The client-side identifiers, same rules. */
function clientFields(data = {}) {
  const out = {};
  for (const key of ["registrationNumber", "tin"]) {
    if (data[key] !== undefined) out[key] = store(data[key]);
  }
  if (data.isIndividual !== undefined) out.isIndividual = !!data.isIndividual;
  return out;
}

/**
 * The snapshot copied onto an invoice at issue.
 *
 * Always returns all four keys, so an invoice created while a profile has no
 * identifiers stores four explicit nulls rather than leaving columns absent —
 * "this document was issued by a business with no TIN on file" is a fact worth
 * recording, and it is what stops a later profile edit appearing to have
 * applied retroactively.
 */
function snapshotFrom(profile) {
  return {
    fromRegistrationNumber: store(profile?.registrationNumber),
    fromTin: store(profile?.tin),
    fromMsicCode: store(profile?.msicCode),
    fromSstNumber: store(profile?.sstNumber),
  };
}

/** True when a profile has none of the four. Drives the one-time prompt. */
function isMissingIdentifiers(profile) {
  return (
    blank(profile?.registrationNumber) &&
    blank(profile?.tin) &&
    blank(profile?.msicCode) &&
    blank(profile?.sstNumber)
  );
}

module.exports = {
  store,
  normalise,
  sameIdentifier,
  businessFields,
  clientFields,
  snapshotFrom,
  isMissingIdentifiers,
  blank,
};
