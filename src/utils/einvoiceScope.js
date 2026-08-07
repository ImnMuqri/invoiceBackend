/**
 * The e-Invoice scope engine (spec 06).
 *
 * Pure. No database, no clock of its own — `now` is an argument, like
 * cadence.js, because "has your date already passed" is a question you have to
 * be able to test on both sides of the boundary.
 *
 * It returns CODES, never sentences. Two reasons:
 *
 *   1. The tool ships in English and Bahasa Malaysia, and the spec requires
 *      both to return identical logic. Codes make that structural rather than
 *      something a reviewer has to verify by reading two prose branches and
 *      hoping. There is one engine; the locales differ only in wording.
 *   2. The email copy and the page copy want the same verdict phrased
 *      differently. A verdict that arrives as a code can be phrased twice
 *      without being computed twice.
 *
 * The bias throughout is toward CANNOT_DETERMINE. This tool is read by people
 * deciding whether they have a legal obligation; a confident wrong answer is
 * worse for them than an honest shrug that names the next step.
 */

const { RULES } = require("./einvoiceRules");
const { mytParts } = require("./cadence");

/* ── Outcomes ──────────────────────────────────────────────────────────────
   EXEMPT           — below the exemption threshold, no obligation today
   IN_SCOPE         — a phase applies, with a date
   CANNOT_DETERMINE — the inputs do not map cleanly; go to LHDN            */
const OUTCOME = {
  EXEMPT: "EXEMPT",
  IN_SCOPE: "IN_SCOPE",
  CANNOT_DETERMINE: "CANNOT_DETERMINE",
};

/** Why we could not answer. Each one is a distinct paragraph in the copy. */
const REASON = {
  TURNOVER_UNKNOWN: "TURNOVER_UNKNOWN",
  BUSINESS_TYPE_OTHER: "BUSINESS_TYPE_OTHER",
  GROUP_STRUCTURE: "GROUP_STRUCTURE",
  RECENT_START: "RECENT_START",
  BAND_UNMAPPED: "BAND_UNMAPPED",
};

class ScopeInputError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
    this.statusCode = 400;
  }
}

/* ── Small date helpers ───────────────────────────────────────────────────── */

/** "YYYY-MM-DD" -> comparable parts. The config only ever holds plain dates. */
function parseISODate(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** Negative if a is before b, 0 if same day, positive if after. */
function compareDates(a, b) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * The last day still inside the relaxation window: start + n months, minus one
 * day. 1 January 2026 + 6 months - 1 day = 30 June 2026.
 *
 * Day-of-month clamping is not needed in practice — every phase date is the
 * 1st — but a future phase date of the 31st would otherwise silently produce a
 * date in the wrong month, and that is exactly the class of bug that only
 * shows up once it is on a public page.
 */
function relaxationEnd(startISO, months) {
  if (!months) return null;
  const { year, month, day } = parseISODate(startISO);
  const target = new Date(Date.UTC(year, month - 1 + months, day));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

/** Today in Kuala Lumpur. A Malaysian tax date is a Malaysian calendar day. */
function todayInMalaysia(now) {
  return mytParts(now);
}

/* ── Band and phase resolution ────────────────────────────────────────────── */

function findBand(bandId) {
  return RULES.turnoverBands.find((b) => b.id === bandId) || null;
}

/**
 * The phase a band falls in, or null if it does not sit wholly inside one.
 *
 * "Wholly inside" is the point. The bands are cut on the phase boundaries, so
 * a band that spans two phases means somebody edited the config into an
 * inconsistent state — and the honest response to that is cannot-determine,
 * not a coin flip between two implementation dates.
 */
function phaseForBand(band) {
  const bandFloor = band.exclusiveMin ? band.minSen + 1 : band.minSen;
  const bandCeiling = band.maxSen === null ? null : band.exclusiveMax ? band.maxSen - 1 : band.maxSen;

  return (
    RULES.phases.find((phase) => {
      const floorOk = phase.minInclusive ? bandFloor >= phase.minSen : bandFloor > phase.minSen;
      if (!floorOk) return false;
      if (phase.maxSen === null) return true;
      return bandCeiling !== null && bandCeiling <= phase.maxSen;
    }) || null
  );
}

/** True when the whole band sits under the exemption line. */
function isBelowExemption(band) {
  if (band.maxSen === null) return false;
  const ceiling = band.exclusiveMax ? band.maxSen - 1 : band.maxSen;
  return ceiling < RULES.exemptionThresholdSen;
}

/* ── Input validation ─────────────────────────────────────────────────────── */

/**
 * Rejects what is malformed; does NOT reject what is merely unanswerable.
 * "I don't know my turnover" is a valid input with a valid answer — it just
 * happens to be the cannot-determine one.
 */
function validateInput(input) {
  const { turnoverBand, startYear, businessType, partOfGroup } = input || {};

  const band = findBand(turnoverBand);
  if (!band) {
    throw new ScopeInputError("turnoverBand", "Unknown turnover band");
  }

  if (!RULES.businessTypes.includes(businessType)) {
    throw new ScopeInputError("businessType", "Unknown business type");
  }

  if (typeof partOfGroup !== "boolean") {
    throw new ScopeInputError("partOfGroup", "partOfGroup must be true or false");
  }

  const year = Number(startYear);
  if (!Number.isInteger(year)) {
    throw new ScopeInputError("startYear", "startYear must be a whole year");
  }

  return { band, businessType, partOfGroup, startYear: year };
}

/* ── The engine ───────────────────────────────────────────────────────────── */

/**
 * @param {object} input
 *   turnoverBand  one of RULES.turnoverBands[].id
 *   startYear     the year the business started operating
 *   partOfGroup   subsidiary/associate/related company of a larger group
 *   businessType  one of RULES.businessTypes
 * @param {Date} now  injected clock
 * @returns {object} a verdict of codes and dates, never prose
 */
function evaluate(input, now = new Date()) {
  const { band, businessType, partOfGroup, startYear } = validateInput(input);
  const today = todayInMalaysia(now);

  /* The year check needs the clock, so it lives here rather than in
     validateInput: a business cannot have started trading next year. */
  if (startYear < RULES.minStartYear || startYear > today.year) {
    throw new ScopeInputError("startYear", "startYear is outside the accepted range");
  }

  /* The exemption threshold rides on EVERY verdict, including the ones that
     cannot answer. It is the number the copy reaches for most often — "which
     side of RM1,000,000 are you on" is the question even when we cannot say —
     and leaving it off the early returns rendered a sentence with a hole in
     it where the figure should have been. */
  const base = {
    version: RULES.version,
    reviewedOn: RULES.reviewedOn,
    exemptionThresholdSen: RULES.exemptionThresholdSen,
    input: { turnoverBand: band.id, startYear, partOfGroup, businessType },
  };

  /* 1. No turnover figure, no answer. Nothing downstream can compensate. */
  if (band.unknown) {
    return {
      ...base,
      outcome: OUTCOME.CANNOT_DETERMINE,
      reason: REASON.TURNOVER_UNKNOWN,
    };
  }

  /* 2. Legal forms outside the four common ones are not on the turnover table
        in any way this tool can safely reproduce. Checked before turnover, so
        a co-operative with RM200m turnover is not told "phase 1" on the
        strength of a number that may not be the number LHDN looks at. */
  if (businessType === "OTHER") {
    return {
      ...base,
      outcome: OUTCOME.CANNOT_DETERMINE,
      reason: REASON.BUSINESS_TYPE_OTHER,
    };
  }

  /* 3. Under the exemption threshold. This is where most of this product's
        users land, and it is the answer the page exists to deliver. */
  if (isBelowExemption(band)) {
    /* ...unless they are inside a group. A subsidiary under RM1m on its own
       books can still be pulled in by how the group is assessed, and that is
       not a call this tool gets to make on four dropdowns. */
    if (partOfGroup) {
      return {
        ...base,
        outcome: OUTCOME.CANNOT_DETERMINE,
        reason: REASON.GROUP_STRUCTURE,
      };
    }

    return {
      ...base,
      outcome: OUTCOME.EXEMPT,
      /* Context, not an obligation: what happens if they grow past the line.
         See the confidence note on concessionaryDate in einvoiceRules.js. */
      concessionaryDate: RULES.concessionaryDate,
    };
  }

  /* 4. At or above the threshold: which phase? */
  const phase = phaseForBand(band);
  if (!phase) {
    /* Only reachable if the config's bands and phases have been edited out of
       alignment. Fail honest rather than pick the nearest phase. */
    return {
      ...base,
      outcome: OUTCOME.CANNOT_DETERMINE,
      reason: REASON.BAND_UNMAPPED,
    };
  }

  const startDate = parseISODate(phase.startDate);
  const relaxEndISO = relaxationEnd(phase.startDate, phase.relaxationMonths);
  const phaseFacts = {
    phase: phase.id,
    phaseNumber: phase.number,
    startDate: phase.startDate,
    hasStarted: compareDates(today, startDate) >= 0,
    relaxationEndDate: relaxEndISO,
    relaxationActive: relaxEndISO
      ? compareDates(today, startDate) >= 0 && compareDates(today, parseISODate(relaxEndISO)) <= 0
      : false,
    bandMinSen: band.minSen,
    bandMaxSen: band.maxSen,
  };

  /* 5. A business that started trading after the base financial year has no
        FY2022 accounts, so the band it just selected is not the figure LHDN
        would use to place it. The band still tells us something useful, so it
        goes out as *indicative* — a signpost, clearly labelled as not the
        answer — rather than being thrown away. */
  if (startYear > RULES.baseFinancialYear) {
    return {
      ...base,
      outcome: OUTCOME.CANNOT_DETERMINE,
      reason: REASON.RECENT_START,
      baseFinancialYear: RULES.baseFinancialYear,
      indicative: phaseFacts,
    };
  }

  return {
    ...base,
    outcome: OUTCOME.IN_SCOPE,
    ...phaseFacts,
    /* Being in a group cannot make an in-scope business exempt, so the verdict
       stands. It can place them in an *earlier* phase than their own books
       suggest — every one of which has already begun — so this is a note on
       the result, not a branch in it. */
    groupNote: partOfGroup,
  };
}

/**
 * The rule set as the public form needs it: bands and metadata, no verdicts.
 * Served so the frontend renders its dropdown from the config rather than from
 * its own copy of the numbers — which is what keeps "change a threshold, the
 * tool changes" true for the labels as well as the answers.
 */
function publicRuleset() {
  return {
    version: RULES.version,
    reviewedOn: RULES.reviewedOn,
    exemptionThresholdSen: RULES.exemptionThresholdSen,
    baseFinancialYear: RULES.baseFinancialYear,
    minStartYear: RULES.minStartYear,
    sources: RULES.sources,
    turnoverBands: RULES.turnoverBands.map((b) => ({
      id: b.id,
      minSen: b.minSen ?? null,
      maxSen: b.maxSen ?? null,
      exclusiveMin: !!b.exclusiveMin,
      exclusiveMax: !!b.exclusiveMax,
      unknown: !!b.unknown,
    })),
    businessTypes: RULES.businessTypes,
  };
}

module.exports = {
  OUTCOME,
  REASON,
  ScopeInputError,
  evaluate,
  publicRuleset,
  /* exported for tests */
  relaxationEnd,
  phaseForBand,
  isBelowExemption,
};
