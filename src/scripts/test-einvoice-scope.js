/**
 * Acceptance tests for the e-Invoice scope checker (spec 06).
 *
 *   node src/scripts/test-einvoice-scope.js
 *
 * The four criteria the spec sets are each tested by name below, because they
 * are the ones that will be silently broken by the next person who edits the
 * rules file:
 *
 *   1. Changing a threshold in the config changes the output, with no code
 *      change.
 *   2. Both language versions return identical logic and equivalent copy.
 *   3. An ambiguous input returns the cannot-determine branch, not a confident
 *      wrong answer.
 *   4. The disclaimer and the rule-set review date are present on every
 *      result.
 *
 * No test runner, because this repo has none. Plain node and node:assert.
 */

const assert = require("node:assert/strict");
const { RULES } = require("../utils/einvoiceRules");
const { evaluate, publicRuleset, phaseForBand, relaxationEnd, ScopeInputError } =
  require("../utils/einvoiceScope");
const { renderVerdict, ringgit } = require("../utils/einvoiceCopy");
const { getScopeResultEmail } = require("../utils/einvoiceEmail");

/* A fixed clock. Every date assertion below is relative to it, so the suite
   does not start failing on its own the morning a phase date rolls past. */
const NOW = new Date("2026-08-07T04:00:00Z"); // 12:00 in Kuala Lumpur

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    failures.push({ name, message: err.message });
  }
}

const input = (over = {}) => ({
  turnoverBand: "UNDER_1M",
  startYear: 2018,
  partOfGroup: false,
  businessType: "SOLE_PROP",
  ...over,
});

/* ── 1. The verdicts ──────────────────────────────────────────────────────── */

test("under the threshold is exempt", () => {
  const v = evaluate(input(), NOW);
  assert.equal(v.outcome, "EXEMPT");
  assert.equal(v.exemptionThresholdSen, RULES.exemptionThresholdSen);
});

test("each band above the threshold maps to its published phase and date", () => {
  const expected = {
    "1M_TO_5M": ["PHASE_4", "2026-01-01"],
    "5M_TO_25M": ["PHASE_3", "2025-07-01"],
    "25M_TO_100M": ["PHASE_2", "2025-01-01"],
    ABOVE_100M: ["PHASE_1", "2024-08-01"],
  };
  for (const [band, [phase, date]] of Object.entries(expected)) {
    const v = evaluate(input({ turnoverBand: band, startYear: 2015 }), NOW);
    assert.equal(v.outcome, "IN_SCOPE", band);
    assert.equal(v.phase, phase, band);
    assert.equal(v.startDate, date, band);
  }
});

test("every band maps to exactly one phase, or is below the exemption line", () => {
  /* Guards the edit that quietly leaves a band straddling two phases. */
  for (const band of RULES.turnoverBands) {
    if (band.unknown) continue;
    const ceiling = band.exclusiveMax ? band.maxSen - 1 : band.maxSen;
    const belowLine = ceiling !== null && ceiling < RULES.exemptionThresholdSen;
    if (belowLine) continue;
    assert.ok(phaseForBand(band), `${band.id} maps to no phase`);
  }
});

test("relaxation window is start + n months, minus a day", () => {
  assert.equal(relaxationEnd("2026-01-01", 6), "2026-06-30");
  assert.equal(relaxationEnd("2025-07-01", 6), "2025-12-31");
  assert.equal(relaxationEnd("2024-08-01", 6), "2025-01-31");
  assert.equal(relaxationEnd("2026-01-01", 0), null);
});

test("hasStarted and relaxationActive are judged against the clock", () => {
  const v = evaluate(input({ turnoverBand: "1M_TO_5M", startYear: 2015 }), NOW);
  assert.equal(v.hasStarted, true);
  /* Phase 4 relaxed to 30 June 2026; the clock is August. */
  assert.equal(v.relaxationActive, false);

  const during = evaluate(
    input({ turnoverBand: "1M_TO_5M", startYear: 2015 }),
    new Date("2026-03-01T04:00:00Z")
  );
  assert.equal(during.relaxationActive, true);

  const before = evaluate(
    input({ turnoverBand: "1M_TO_5M", startYear: 2015 }),
    new Date("2025-11-01T04:00:00Z")
  );
  assert.equal(before.hasStarted, false);
  assert.equal(before.relaxationActive, false);
});

test("the clock is read in Kuala Lumpur, not UTC", () => {
  /* 31 Dec 2025 16:30 UTC is already 1 Jan 2026 in KL — the day phase 4 opens.
     Read in UTC this returns hasStarted:false, which is wrong for a Malaysian
     tax date. */
  const v = evaluate(
    input({ turnoverBand: "1M_TO_5M", startYear: 2015 }),
    new Date("2025-12-31T16:30:00Z")
  );
  assert.equal(v.hasStarted, true);
});

/* ── 2. Criterion 3: ambiguity returns cannot-determine ───────────────────── */

test("ambiguous inputs each return cannot-determine with a reason", () => {
  const cases = [
    [{ turnoverBand: "UNSURE" }, "TURNOVER_UNKNOWN"],
    [{ businessType: "OTHER" }, "BUSINESS_TYPE_OTHER"],
    [{ partOfGroup: true }, "GROUP_STRUCTURE"],
    [{ turnoverBand: "5M_TO_25M", startYear: 2024 }, "RECENT_START"],
  ];
  for (const [over, reason] of cases) {
    const v = evaluate(input(over), NOW);
    assert.equal(v.outcome, "CANNOT_DETERMINE", JSON.stringify(over));
    assert.equal(v.reason, reason, JSON.stringify(over));
  }
});

test("a high-turnover 'something else' is not given a confident phase", () => {
  const v = evaluate(
    input({ turnoverBand: "ABOVE_100M", startYear: 2001, businessType: "OTHER" }),
    NOW
  );
  assert.equal(v.outcome, "CANNOT_DETERMINE");
  assert.equal(v.phase, undefined);
});

test("a recent start still surfaces its phase as indicative, clearly separated", () => {
  const v = evaluate(input({ turnoverBand: "5M_TO_25M", startYear: 2024 }), NOW);
  assert.equal(v.indicative.phase, "PHASE_3");
  assert.equal(v.phase, undefined, "the indicative phase must not leak into the verdict");
  const r = renderVerdict(v, "en");
  assert.match(r.paragraphs.join(" "), /reference only/i);
});

test("a group member above the threshold is still told they are in scope", () => {
  /* Being in a group cannot make an in-scope business exempt. It is a note. */
  const v = evaluate(
    input({ turnoverBand: "25M_TO_100M", startYear: 2010, partOfGroup: true }),
    NOW
  );
  assert.equal(v.outcome, "IN_SCOPE");
  assert.equal(v.groupNote, true);
});

test("malformed input is rejected, not guessed at", () => {
  const bad = [
    { turnoverBand: "MADE_UP" },
    { businessType: "PLC" },
    { partOfGroup: "yes" },
    { startYear: "twenty" },
    { startYear: 2099 },
    { startYear: 1500 },
  ];
  for (const over of bad) {
    assert.throws(() => evaluate(input(over), NOW), ScopeInputError, JSON.stringify(over));
  }
});

/* ── 3. Criterion 1: a config edit changes the output, with no code edit ──── */

/** Runs `fn` against a temporarily mutated rules file, then puts it back. */
function withConfig(mutate, fn) {
  const phase4 = RULES.phases.find((p) => p.id === "PHASE_4");
  const band = RULES.turnoverBands.find((b) => b.id === "1M_TO_5M");
  const saved = {
    threshold: RULES.exemptionThresholdSen,
    phase4Min: phase4.minSen,
    bandMax: band.maxSen,
    bandExclusiveMax: band.exclusiveMax,
  };
  try {
    mutate({ phase4, band });
    fn();
  } finally {
    RULES.exemptionThresholdSen = saved.threshold;
    phase4.minSen = saved.phase4Min;
    band.maxSen = saved.bandMax;
    band.exclusiveMax = saved.bandExclusiveMax;
  }
}

test("moving the exemption threshold moves the answer", () => {
  /* Pretend LHDN raised the exemption to RM5,000,000: the threshold moves,
     phase 4's floor moves with it, and the RM1m–RM5m band becomes the one
     that sits under the line — so its ceiling turns exclusive, exactly how
     UNDER_1M is modelled today. Every line here is a data edit. */
  withConfig(
    ({ phase4, band }) => {
      RULES.exemptionThresholdSen = 5_000_000 * 100;
      phase4.minSen = 5_000_000 * 100;
      band.exclusiveMax = true;
    },
    () => {
      const v = evaluate(input({ turnoverBand: "1M_TO_5M", startYear: 2015 }), NOW);
      assert.equal(v.outcome, "EXEMPT", "a band now under the threshold must read exempt");
      assert.match(renderVerdict(v, "en").paragraphs[0], /RM5,000,000/);
      assert.match(renderVerdict(v, "ms").paragraphs[0], /RM5,000,000/);
    }
  );

  /* And the edit is genuinely what changed the answer, not a stale cache. */
  assert.equal(evaluate(input({ turnoverBand: "1M_TO_5M", startYear: 2015 }), NOW).outcome, "IN_SCOPE");
});

test("a half-finished config edit fails honest rather than guessing", () => {
  /* The threshold is raised but the bands are not re-cut, so 1M_TO_5M now
     straddles the exemption line. There is a tempting wrong answer available
     in both directions; the engine must decline to pick one. */
  withConfig(
    ({ phase4 }) => {
      RULES.exemptionThresholdSen = 5_000_000 * 100;
      phase4.minSen = 5_000_000 * 100;
    },
    () => {
      const v = evaluate(input({ turnoverBand: "1M_TO_5M", startYear: 2015 }), NOW);
      assert.equal(v.outcome, "CANNOT_DETERMINE");
      assert.equal(v.reason, "BAND_UNMAPPED");
    }
  );
});

test("no threshold or phase date is hardcoded in the rendered copy", () => {
  /* Every figure a reader sees must have come from the config. Swap the
     config's phase date and the sentence must move with it. */
  const phase = RULES.phases.find((p) => p.id === "PHASE_3");
  const original = phase.startDate;
  try {
    phase.startDate = "2027-03-15";
    const v = evaluate(input({ turnoverBand: "5M_TO_25M", startYear: 2015 }), NOW);
    for (const locale of ["en", "ms"]) {
      const text = renderVerdict(v, locale).paragraphs.join(" ");
      assert.match(text, /2027/, locale);
      assert.doesNotMatch(text, /1 July 2025|1 Julai 2025/, locale);
    }
  } finally {
    phase.startDate = original;
  }
});

test("the published thresholds are what LHDN publishes", () => {
  /* A tripwire, not a rule. If somebody edits the config, this fails and they
     have to consciously re-verify against hasil.gov.my and update it here. */
  assert.equal(ringgit(RULES.exemptionThresholdSen), "RM1,000,000");
  assert.equal(RULES.baseFinancialYear, 2022);
  assert.deepEqual(
    RULES.phases.map((p) => [ringgit(p.minSen), p.startDate]),
    [
      ["RM100,000,000", "2024-08-01"],
      ["RM25,000,000", "2025-01-01"],
      ["RM5,000,000", "2025-07-01"],
      ["RM1,000,000", "2026-01-01"],
    ]
  );
});

/* ── 4. Criterion 2: both locales, identical logic ────────────────────────── */

const ALL_INPUTS = [];
for (const band of RULES.turnoverBands) {
  for (const type of RULES.businessTypes) {
    for (const group of [true, false]) {
      for (const year of [2001, 2022, 2023, 2026]) {
        ALL_INPUTS.push({
          turnoverBand: band.id,
          businessType: type,
          partOfGroup: group,
          startYear: year,
        });
      }
    }
  }
}

test("every input combination produces a verdict — nothing throws, nothing is undefined", () => {
  for (const i of ALL_INPUTS) {
    const v = evaluate(i, NOW);
    assert.ok(
      ["EXEMPT", "IN_SCOPE", "CANNOT_DETERMINE"].includes(v.outcome),
      JSON.stringify(i)
    );
    if (v.outcome === "CANNOT_DETERMINE") assert.ok(v.reason, JSON.stringify(i));
    if (v.outcome === "IN_SCOPE") assert.ok(v.phase && v.startDate, JSON.stringify(i));
  }
});

test("both locales render the same verdict, with equivalent structure", () => {
  for (const i of ALL_INPUTS) {
    const v = evaluate(i, NOW);
    const en = renderVerdict(v, "en");
    const ms = renderVerdict(v, "ms");
    const where = JSON.stringify(i);

    /* Same shape: same number of paragraphs, same number of steps. A locale
       that has quietly lost a paragraph is a locale telling a different
       story, and that is what criterion 2 is guarding against. */
    assert.equal(en.paragraphs.length, ms.paragraphs.length, where);
    assert.equal(en.steps.length, ms.steps.length, where);
    /* And genuinely translated, not the English falling through. */
    assert.notEqual(en.headline, ms.headline, where);
  }
});

test("no rendered string is left with an unfilled {token} or an empty figure", () => {
  for (const i of ALL_INPUTS) {
    const v = evaluate(i, NOW);
    for (const locale of ["en", "ms"]) {
      const r = renderVerdict(v, locale);
      const all = [r.headline, ...r.paragraphs, ...r.steps, r.disclaimer, r.reviewedLabel];
      for (const s of all) {
        assert.doesNotMatch(s, /\{\w+\}/, `${locale} ${JSON.stringify(i)}: ${s}`);
        /* "the  exemption threshold" — a token that resolved to nothing. */
        assert.doesNotMatch(s, /\s{2,}/, `${locale} ${JSON.stringify(i)}: ${s}`);
        assert.doesNotMatch(s, /\bRM\b(?!\d)/, `${locale} ${JSON.stringify(i)}: ${s}`);
      }
    }
  }
});

/* ── 5. Criterion 4: disclaimer and review date always present ─────────────── */

test("every result carries the disclaimer and the review date", () => {
  for (const i of ALL_INPUTS) {
    const v = evaluate(i, NOW);
    for (const locale of ["en", "ms"]) {
      const r = renderVerdict(v, locale);
      assert.ok(r.disclaimerTitle && r.disclaimer, JSON.stringify(i));
      assert.ok(r.portalLabel, JSON.stringify(i));
      assert.match(r.reviewedLabel, /2026/, `${locale} ${JSON.stringify(i)}`);
      assert.ok(r.status && r.headline && r.steps.length, JSON.stringify(i));
    }
  }
});

/* ── 6. The wire and the email ────────────────────────────────────────────── */

test("the public ruleset exposes bands and metadata, and no internals", () => {
  const r = publicRuleset();
  assert.ok(r.reviewedOn && r.version && r.sources.portal);
  assert.equal(r.turnoverBands.length, RULES.turnoverBands.length);
  assert.ok(r.turnoverBands.every((b) => "minSen" in b && "maxSen" in b));
  assert.equal(r.phases, undefined, "phase internals are not part of the form contract");
});

test("the emailed copy carries the same verdict, in both locales", () => {
  for (const band of ["UNDER_1M", "5M_TO_25M", "UNSURE"]) {
    for (const locale of ["en", "ms"]) {
      const v = evaluate(input({ turnoverBand: band, startYear: 2015 }), NOW);
      const r = renderVerdict(v, locale);
      const { subject, html, text } = getScopeResultEmail(r, v);

      assert.ok(subject.length, `${band} ${locale}`);
      for (const part of [html, text]) {
        assert.ok(part.includes(r.headline), `${band} ${locale}: headline missing`);
        assert.ok(part.includes(r.disclaimer), `${band} ${locale}: disclaimer missing`);
        assert.ok(part.includes(r.reviewedLabel), `${band} ${locale}: review date missing`);
        for (const s of r.steps) {
          assert.ok(part.includes(s), `${band} ${locale}: a next step is missing`);
        }
      }
    }
  }
});

test("ringgit formatting goes through the sen boundary", () => {
  assert.equal(ringgit(100_000_000), "RM1,000,000");
  assert.equal(ringgit(10_000_000_000), "RM100,000,000");
  assert.equal(ringgit(0), "RM0");
});

/* ── Report ───────────────────────────────────────────────────────────────── */

console.log(`\ne-Invoice scope checker — ${passed} passed, ${failed} failed\n`);
for (const f of failures) console.error(`  ✗ ${f.name}\n    ${f.message}\n`);
process.exit(failed ? 1 : 0);
