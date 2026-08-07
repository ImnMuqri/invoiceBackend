/**
 * LHDN e-Invoice scope rules — THE configuration file (spec 06).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FILE IS DATA. THE ENGINE IS einvoiceScope.js. KEEP IT THAT WAY.
 *
 * The thresholds and dates below have been revised by LHDN more than once
 * already — the RM500,000 exemption announced in June 2025 was superseded by a
 * RM1,000,000 exemption, and the phase 4/5 dates moved twice before that. So
 * changing a rule must be a data edit here, never a code change in the engine
 * or a copy change in the frontend. If you find yourself writing an `if` about
 * a specific ringgit figure anywhere else, that is the bug.
 *
 * ACCURACY RULE (spec 06, "Accuracy requirement"):
 *   Every figure here is sourced from LHDN's own published material. Vendor
 *   blogs and accounting-firm summaries are NOT acceptable sources — several
 *   still publish the superseded RM500,000 threshold. Every entry carries the
 *   URL it came from and the date it was last checked. When you edit anything,
 *   re-check it against the same source and move `reviewedOn` forward, because
 *   that date is printed on the public page as a promise to the reader.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Turnover figures are in SEN, like every other money figure in this codebase.
 * RM1,000,000 is 100_000_000 sen. Formatting happens at the display boundary.
 */

/** Ringgit to sen, for legibility in the table below. Not exported: this file
 *  is the only place that needs to write a threshold as a ringgit figure. */
const RM = (ringgit) => ringgit * 100;

const RULES = {
  /* Bump when any figure below changes. Returned with every result so a
     screenshot can be traced back to the rule set that produced it. */
  version: "2026-08-07",

  /**
   * The date a human last checked this file against LHDN. Printed on the public
   * page. If this is more than a few months old, the page is quietly lying
   * about how current it is — re-verify before shipping anything else.
   */
  reviewedOn: "2026-08-07",

  sources: {
    timeline:
      "https://www.hasil.gov.my/en/e-invois/pelaksanaan-e-invois-di-malaysia/garis-masa-pelaksanaan-e-invois/",
    guidelines:
      "https://www.hasil.gov.my/en/e-invoice/reference-for-the-implementation-of-e-invoice/guidelines/",
    portal: "https://myinvois.hasil.gov.my/",
  },

  /**
   * Below this, no e-Invoice obligation.
   *
   * "Taxpayers with an annual turnover or revenue of less than RM1,000,000 are
   * exempted from e-Invoice implementation."
   *   — hasil.gov.my e-Invoice Implementation Timeline, page last updated
   *     7 December 2025. Checked 2026-08-07.
   *
   * Note the word "less than": a business at exactly RM1,000,000 is NOT
   * exempt. The bands below are cut on that boundary so the engine never has
   * to guess which side of it a user sits on.
   */
  exemptionThresholdSen: RM(1_000_000),

  /**
   * The phased mandate, exactly as LHDN publishes it.
   *
   *   > RM100 million ................ 1 August 2024
   *   > RM25m and up to RM100m ....... 1 January 2025
   *   > RM5m and up to RM25m ......... 1 July 2025
   *   up to RM5 million .............. 1 January 2026
   *
   *   — hasil.gov.my e-Invoice Implementation Timeline (English and Bahasa
   *     Malaysia versions agree), page last updated 7 December 2025.
   *     Checked 2026-08-07.
   *
   * `maxSen` is inclusive and `minSen` is exclusive by default, matching
   * LHDN's own "more than X up to Y" phrasing. `maxSen: null` means unbounded.
   * `minInclusive: true` flips the floor for the one phase whose floor is not
   * LHDN's wording but the exemption line — see phase 4.
   *
   * `relaxationMonths` is the interim relaxation window running from the
   * implementation date, during which consolidated e-Invoices are accepted for
   * transactions that would otherwise each need their own.
   *   — IRBM e-Invoice Specific Guideline, "e-Invoice treatment during interim
   *     relaxation period". Six months from the phase date, e.g. phase 3
   *     (1 July 2025) relaxes until 31 December 2025. Checked 2026-08-07.
   */
  phases: [
    {
      id: "PHASE_1",
      number: 1,
      minSen: RM(100_000_000),
      maxSen: null,
      startDate: "2024-08-01",
      relaxationMonths: 6,
    },
    {
      id: "PHASE_2",
      number: 2,
      minSen: RM(25_000_000),
      maxSen: RM(100_000_000),
      startDate: "2025-01-01",
      relaxationMonths: 6,
    },
    {
      id: "PHASE_3",
      number: 3,
      minSen: RM(5_000_000),
      maxSen: RM(25_000_000),
      startDate: "2025-07-01",
      relaxationMonths: 6,
    },
    {
      id: "PHASE_4",
      number: 4,
      /* The published band is "up to RM5 million" with no floor, but the
         RM1,000,000 exemption is the effective floor, so that is what is
         encoded. Keeping the exemption in one place and deriving the floor
         from it would be cleverer and worse: when LHDN next moves the
         exemption, whoever edits it must consciously decide whether phase 4's
         floor moves with it. Two edits, both deliberate.

         minInclusive because the exemption is worded "LESS THAN RM1,000,000".
         A business at exactly RM1,000,000 is in this phase, not exempt. */
      minSen: RM(1_000_000),
      minInclusive: true,
      maxSen: RM(5_000_000),
      startDate: "2026-01-01",
      relaxationMonths: 6,
    },
  ],

  /**
   * The date given to taxpayers who start out under the exemption threshold
   * and later cross it.
   *
   *   — IRBM e-Invoice Guideline v4.6 (issued 7 December 2025), described as
   *     the concessionary e-Invoice implementation date. Checked 2026-08-07.
   *
   * CONFIDENCE NOTE: this one was confirmed from LHDN's guideline summaries
   * rather than read off the timeline table like the phases above, and the
   * mechanics of *when* the crossing counts are not encoded here at all. The
   * engine therefore only ever mentions this date as context on an exempt
   * result — it never uses it to declare somebody in scope.
   */
  concessionaryDate: "2026-07-01",

  /**
   * How LHDN fixes which band a taxpayer falls in: the statement of
   * comprehensive income in the FY2022 audited financial statements, or the
   * FY2022 tax return where accounts are not audited.
   *   — IRBM e-Invoice Guideline. Checked 2026-08-07.
   *
   * A business that started trading after this year has no FY2022 figure, so
   * its date is fixed by a different rule that is deliberately NOT guessed at
   * here. See CANNOT_DETERMINE / RECENT_START in einvoiceScope.js.
   */
  baseFinancialYear: 2022,

  /**
   * The selectable turnover bands, cut so that no band straddles the exemption
   * threshold or a phase boundary. That is what lets the engine answer without
   * guessing: every band maps wholly inside exactly one phase, or wholly below
   * the exemption line.
   *
   * `UNSURE` is a real answer, not a missing one. Someone who does not know
   * their turnover band gets the cannot-determine branch, which is the honest
   * result and is worth more than a confident wrong one.
   */
  turnoverBands: [
    { id: "UNDER_1M", minSen: 0, maxSen: RM(1_000_000), exclusiveMax: true },
    { id: "1M_TO_5M", minSen: RM(1_000_000), maxSen: RM(5_000_000) },
    { id: "5M_TO_25M", minSen: RM(5_000_000), maxSen: RM(25_000_000), exclusiveMin: true },
    { id: "25M_TO_100M", minSen: RM(25_000_000), maxSen: RM(100_000_000), exclusiveMin: true },
    { id: "ABOVE_100M", minSen: RM(100_000_000), maxSen: null, exclusiveMin: true },
    { id: "UNSURE", unknown: true },
  ],

  /**
   * Legal forms the tool accepts. `OTHER` is routed to cannot-determine on
   * purpose: co-operatives, associations, trust bodies and statutory bodies
   * each have their own treatment in the guideline, and some persons are
   * excluded from issuing e-Invoices entirely regardless of turnover. Lumping
   * them into the turnover table would be the exact confident-wrong-answer the
   * spec forbids.
   */
  businessTypes: ["SOLE_PROP", "SDN_BHD", "PARTNERSHIP", "OTHER"],

  /** Sanity bounds for the "year you started" input. */
  minStartYear: 1900,
};

module.exports = { RULES };
