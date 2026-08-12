/**
 * Attribution rule tests (spec 09, part A).
 *
 * Short, because the rule is short — but it is worth pinning, because the two
 * surfaces that draw this line are rendered from different endpoints by
 * different code, and the bug this replaces was exactly them disagreeing: the
 * payment page hid its watermark for Max accounts while the PDF printed its
 * footer for everybody, so a Max customer's client saw it stripped from the
 * page they were sent and still present on the document attached to it.
 *
 * Run: npm run test:attribution
 */

const assert = require("assert");
const {
  showAttribution,
  canRemoveAttribution,
  attributionUrl,
  attributionFor,
  COPY,
} = require("../utils/attribution");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
  }
}

console.log("\nThe rule\n");

test("free accounts always show it, whatever the flag says", () => {
  assert.strictEqual(showAttribution("FREE", true), true);
  assert.strictEqual(showAttribution("FREE", false), true);
  assert.strictEqual(showAttribution("free", false), true);
  assert.strictEqual(showAttribution(null, false), true);
  assert.strictEqual(showAttribution(undefined, false), true);
});

test("pro accounts always show it too — removal is a Max feature", () => {
  /* The flag is IGNORED here, not merely defaulted on. A Pro account that
     switched it off while removal was available on every paid plan must not
     keep an opt-out the plan no longer grants, or the entitlement quietly
     depends on when somebody signed up rather than on what they pay for. */
  assert.strictEqual(showAttribution("PRO", true), true);
  assert.strictEqual(showAttribution("PRO", false), true);
  assert.strictEqual(showAttribution("pro", false), true);
  assert.strictEqual(canRemoveAttribution("PRO"), false);
});

test("an unrecognised plan is treated as PAID, unlike the quota rules", () => {
  /* Deliberately the opposite direction to usage.js, which floors an unknown
     plan at zero. The two are not the same kind of decision:
       - an unknown plan granting unlimited quota is free money, a real exploit
       - an unknown plan hiding our attribution line costs one marketing
         impression
     Against that, the restrictive choice has a worse failure: a plan renamed in
     the admin table would silently stop honouring a paying customer's setting,
     and our branding would reappear on their invoices with no explanation. The
     cheap failure is preferred to the visible one, and `user.plan` is written
     from the Plan table by the subscription webhook rather than by a user, so
     an arbitrary value here is not a reachable state. */
  assert.strictEqual(showAttribution("SOMETHING_ELSE", false), false);
  assert.strictEqual(canRemoveAttribution("SOMETHING_ELSE"), true);
  /* But it still shows by DEFAULT, which is the part that matters. */
  assert.strictEqual(showAttribution("SOMETHING_ELSE", undefined), true);
});

test("every plan shows it by default", () => {
  for (const plan of ["FREE", "PRO", "MAX", "STARTER"]) {
    assert.strictEqual(showAttribution(plan, undefined), true, plan);
    assert.strictEqual(showAttribution(plan, null), true, plan);
    assert.strictEqual(showAttribution(plan, true), true, plan);
  }
});

test("only Max can switch it off", () => {
  assert.strictEqual(showAttribution("MAX", false), false);
  assert.strictEqual(canRemoveAttribution("MAX"), true);

  for (const plan of ["FREE", "PRO"]) {
    assert.strictEqual(showAttribution(plan, false), true, plan);
    assert.strictEqual(canRemoveAttribution(plan), false, plan);
  }
});

test("removal IS gated to the top tier", () => {
  /* This reverses the earlier rule, which held that Pro and Max differ on
     volume only. Recorded rather than deleted because the argument against
     gating is still a real one — somebody upgrading twice to take our line off
     their own invoice is a plausible way to lose an account — and whoever
     revisits this should weigh it again rather than rediscover it. */
  assert.notStrictEqual(canRemoveAttribution("PRO"), canRemoveAttribution("MAX"));
});

test("a missing config row is treated as ON, not as an opt-out", () => {
  /* The column defaults to true. An account with no UserInvoiceConfig row at
     all must not silently become opted out. */
  assert.strictEqual(showAttribution("MAX", undefined), true);
});

console.log("\nWhat the surfaces get\n");

test("attributionFor returns null rather than a hidden object", () => {
  /* Templates do `v-if="attribution"`. Returning { show: false } would let a
     surface render a hidden-but-present block, which is the shape this kind of
     flag usually fails in. */
  assert.strictEqual(attributionFor({ plan: "MAX", enabled: false }), null);
});

test("attributionFor returns text and a link when it should show", () => {
  const a = attributionFor({ plan: "FREE", enabled: false });
  assert.ok(a, "a free account must always get one");
  assert.strictEqual(a.text, COPY.en);
  assert.ok(a.url.startsWith("http"));
});

test("both surfaces agree for the same account", () => {
  /* The whole reason this lives in one module. */
  for (const plan of ["FREE", "PRO", "MAX"]) {
    for (const enabled of [true, false, undefined]) {
      const pay = attributionFor({ plan, enabled, surface: "pay" });
      const pdf = attributionFor({ plan, enabled, surface: "pdf" });
      assert.strictEqual(
        !!pay,
        !!pdf,
        `payment page and PDF disagree for ${plan}/${enabled}`,
      );
      if (pay) assert.strictEqual(pay.text, pdf.text);
    }
  }
});

console.log("\nThe tracked link\n");

test("the link carries a source so signups from it can be measured", () => {
  const url = new URL(attributionUrl("pay"));
  assert.strictEqual(url.searchParams.get("utm_source"), "invoice");
  assert.strictEqual(url.searchParams.get("utm_medium"), "attribution");
});

test("the surfaces are distinguishable in the tag", () => {
  /* The payment page and the PDF convert differently, and knowing which earns
     the signups is the only thing that makes this measurable rather than
     decorative. */
  const pay = new URL(attributionUrl("pay")).searchParams.get("utm_campaign");
  const pdf = new URL(attributionUrl("pdf")).searchParams.get("utm_campaign");
  assert.notStrictEqual(pay, pdf);
});

test("both languages are written, so adding a document language is not a hunt", () => {
  assert.ok(COPY.en && COPY.ms);
  assert.notStrictEqual(COPY.en, COPY.ms);
  /* Short. This sits at the foot of somebody else's invoice and must never
     look like an advert. */
  assert.ok(COPY.en.length <= 30, COPY.en);
  assert.ok(COPY.ms.length <= 30, COPY.ms);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
