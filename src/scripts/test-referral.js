/**
 * Referral programme tests (spec 09, part B).
 *
 * Pure rules only — utils/referral.js. The write path (utils/referralLedger.js)
 * needs a database and is not covered here; what IS covered is every decision
 * it makes before it writes, which is where the money is.
 *
 * Run: npm run test:referral
 */

const assert = require("assert");
const {
  CREDIT_SEN,
  REFERRED_DISCOUNT_SEN,
  PERIOD_CAP_SEN,
  ATTRIBUTION_WINDOW_DAYS,
  REJECT,
  canonicalEmail,
  domainOf,
  screenSignup,
  suspicionFlags,
  creditAllowedThisPeriod,
  creditForConversion,
  applyCredit,
  referralUrl,
  shareText,
  visitorHash,
  periodKey,
  shouldSharePrompt,
  SHARE_PROMPT_COOLDOWN_DAYS,
  SHARE_PROMPT_MAX_DISMISSALS,
} = require("../utils/referral");

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

console.log("\nSelf-referral\n");

test("the same mailbox spelled differently is caught", () => {
  /* The obvious attempt: sign up again as yourself+1@gmail.com. Gmail ignores
     dots and everything after a plus, so these are one mailbox and one person. */
  const referrer = { email: "ahmad.faizal@gmail.com" };
  for (const attempt of [
    "ahmad.faizal@gmail.com",
    "ahmadfaizal@gmail.com",
    "ahmad.faizal+invokita@gmail.com",
    "AHMAD.FAIZAL@GMAIL.COM",
    "a.h.m.a.d.f.a.i.z.a.l@gmail.com",
  ]) {
    const r = screenSignup({ referrer, candidateEmail: attempt });
    assert.strictEqual(r.ok, false, `"${attempt}" slipped through`);
    assert.strictEqual(r.reason, REJECT.SAME_EMAIL);
  }
});

test("two genuinely different people are allowed", () => {
  const r = screenSignup({
    referrer: { email: "ahmad@gmail.com" },
    candidateEmail: "siti@gmail.com",
  });
  assert.strictEqual(r.ok, true);
});

test("a missing referrer is refused", () => {
  const r = screenSignup({ referrer: null, candidateEmail: "a@b.com" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, REJECT.SELF);
});

test("canonicalEmail does not mangle the domain", () => {
  /* Dots are stripped from the LOCAL part only. Stripping them from the domain
     would make a@gmail.com and a@gmailcom the same address. */
  assert.strictEqual(canonicalEmail("a.b@my.company.com"), "ab@my.company.com");
  assert.strictEqual(domainOf("a@my.company.com"), "my.company.com");
});

console.log("\nThe attribution window\n");

test("a signup inside the window is attributed", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const clickedAt = new Date("2026-05-20T00:00:00Z"); // 12 days
  const r = screenSignup({
    referrer: { email: "a@x.com" },
    candidateEmail: "b@y.com",
    clickedAt,
    now,
  });
  assert.strictEqual(r.ok, true);
});

test("a signup long after the click is not", () => {
  /* A click from a year ago did not cause this signup, and paying for it would
     be paying for a coincidence. */
  const now = new Date("2026-06-01T00:00:00Z");
  const clickedAt = new Date("2025-06-01T00:00:00Z");
  const r = screenSignup({
    referrer: { email: "a@x.com" },
    candidateEmail: "b@y.com",
    clickedAt,
    now,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, REJECT.WINDOW);
});

test("no recorded click still attributes", () => {
  /* Somebody who was told about the product in person and typed the code in
     never generated a click. Refusing them would punish the most genuine
     referral there is. */
  const r = screenSignup({
    referrer: { email: "a@x.com" },
    candidateEmail: "b@y.com",
    clickedAt: null,
  });
  assert.strictEqual(r.ok, true);
});

test("the window is a round number of days, stated once", () => {
  assert.strictEqual(ATTRIBUTION_WINDOW_DAYS, 30);
});

console.log("\nShared domains: a flag, not a rejection\n");

test("two colleagues on one company domain are flagged", () => {
  const flags = suspicionFlags({
    referrer: { email: "ahmad@acme.com.my" },
    referredEmail: "siti@acme.com.my",
  });
  assert.deepStrictEqual(flags, [REJECT.SAME_DOMAIN]);
});

test("two strangers on gmail are NOT flagged", () => {
  /* Blocking on shared domain without excluding the consumer providers would
     reject almost every genuine referral in this market. */
  for (const d of ["gmail.com", "yahoo.com", "hotmail.com", "icloud.com", "outlook.com"]) {
    const flags = suspicionFlags({
      referrer: { email: `a@${d}` },
      referredEmail: `b@${d}`,
    });
    assert.deepStrictEqual(flags, [], d);
  }
});

test("a flag never becomes a rejection on its own", () => {
  /* Colleagues genuinely do recommend tools to each other. The flag is for a
     human looking at a suspicious cluster, not an automatic refusal. */
  const r = screenSignup({
    referrer: { email: "ahmad@acme.com.my" },
    candidateEmail: "siti@acme.com.my",
  });
  assert.strictEqual(r.ok, true);
});

console.log("\nCredit and the period cap\n");

test("a conversion is worth the standard credit when there is room", () => {
  assert.strictEqual(creditForConversion(0), CREDIT_SEN);
  assert.strictEqual(creditForConversion(CREDIT_SEN), CREDIT_SEN);
});

test("the cap truncates the last conversion rather than refusing it", () => {
  /* Recording a converted-for-less referral is more honest than refusing it:
     the referral did happen, and the referrer should see it. */
  const nearlyFull = PERIOD_CAP_SEN - 500;
  assert.strictEqual(creditForConversion(nearlyFull), 500);
});

test("nothing is granted once the cap is reached", () => {
  assert.strictEqual(creditForConversion(PERIOD_CAP_SEN), 0);
  assert.strictEqual(creditForConversion(PERIOD_CAP_SEN + 5000), 0);
});

test("the cap never goes negative", () => {
  assert.strictEqual(creditAllowedThisPeriod(PERIOD_CAP_SEN * 3), 0);
  assert.strictEqual(creditAllowedThisPeriod(-100), PERIOD_CAP_SEN);
});

test("the cap bounds what a script can extract", () => {
  /* The worst case is not somebody earning a lot legitimately — it is accounts
     that each pay one month and cancel, converting subscription revenue into
     credit at a fixed rate. The cap is what bounds that. */
  const conversionsBeforeCap = Math.ceil(PERIOD_CAP_SEN / CREDIT_SEN);
  assert.ok(conversionsBeforeCap <= 20, `${conversionsBeforeCap} is too loose a cap`);
});

console.log("\nApplying credit to a bill\n");

test("credit reduces the charge and is spent exactly once", () => {
  const { chargeSen, usedSen } = applyCredit(2900, 1000);
  assert.strictEqual(chargeSen, 1900);
  assert.strictEqual(usedSen, 1000);
});

test("credit larger than the bill leaves the remainder on the account", () => {
  /* The whole point of a balance rather than a coupon. */
  const { chargeSen, usedSen } = applyCredit(500, 1000);
  assert.strictEqual(chargeSen, 0);
  assert.strictEqual(usedSen, 500);
});

test("a charge is never negative", () => {
  for (const [amount, credit] of [[0, 5000], [100, 100], [-50, 100]]) {
    const { chargeSen, usedSen } = applyCredit(amount, credit);
    assert.ok(chargeSen >= 0, `charge ${chargeSen}`);
    assert.ok(usedSen >= 0, `used ${usedSen}`);
  }
});

test("amounts are whole sen", () => {
  const { chargeSen, usedSen } = applyCredit(2900.6, 999.4);
  assert.strictEqual(chargeSen, Math.round(chargeSen));
  assert.strictEqual(usedSen, Math.round(usedSen));
});

console.log("\nBoth sides get something\n");

test("the referred account is given a first-month discount", () => {
  /* Without it the link feels like the referrer taking a commission from a
     friend, which is the difference between a programme people use and one
     they are embarrassed by. */
  assert.ok(REFERRED_DISCOUNT_SEN > 0);
});

console.log("\nThe link and the share text\n");

test("the link carries the code", () => {
  const url = new URL(referralUrl("ABCD1234"));
  assert.strictEqual(url.searchParams.get("ref"), "ABCD1234");
});

test("the share source is tagged when given", () => {
  const url = new URL(referralUrl("ABCD1234", "wa"));
  assert.strictEqual(url.searchParams.get("via"), "wa");
});

test("share text exists in both languages and carries the link", () => {
  const en = shareText("ABCD1234", "en");
  const ms = shareText("ABCD1234", "ms");
  assert.ok(en.includes("ABCD1234"));
  assert.ok(ms.includes("ABCD1234"));
  assert.notStrictEqual(en, ms);
});

test("share text leads with what the READER gets, not what the sender earns", () => {
  /* A share message that reads like an ad is one people rewrite or do not
     send. It must not mention the sender's commission. */
  for (const locale of ["en", "ms"]) {
    const text = shareText("ABCD1234", locale).toLowerCase();
    for (const word of ["commission", "i earn", "i get paid", "komisen"]) {
      assert.ok(!text.includes(word), `${locale} share text says "${word}"`);
    }
  }
  assert.ok(/discount/i.test(shareText("X", "en")));
  assert.ok(/diskaun/i.test(shareText("X", "ms")));
});

console.log("\nClick counting stays non-identifying\n");

test("the visitor hash is stable for one visitor and differs across visitors", () => {
  const a = visitorHash("1.2.3.4", "Mozilla/5.0");
  const b = visitorHash("1.2.3.4", "Mozilla/5.0");
  const c = visitorHash("5.6.7.8", "Mozilla/5.0");
  assert.strictEqual(a, b, "must dedupe a refresh");
  assert.notStrictEqual(a, c);
});

test("the hash does not contain the address it was made from", () => {
  const h = visitorHash("203.0.113.42", "Mozilla/5.0");
  assert.ok(!h.includes("203"), "the raw address must not be recoverable by eye");
  assert.match(h, /^[a-f0-9]{32}$/);
});

console.log("\nPeriods\n");

test("the period key matches the metering's format", () => {
  /* Same shape as chase.js so the two are readable side by side. */
  assert.match(periodKey(new Date("2026-06-15T00:00:00Z")), /^\d{4}-\d{2}$/);
});

test("the period is Kuala Lumpur's month, not the server's", () => {
  /* 31 May 17:00 UTC is 1 June in KL. A server in UTC must not put that
     conversion in the wrong month and reopen the cap a day early. */
  assert.strictEqual(periodKey(new Date("2026-05-31T17:00:00Z")), "2026-06");
  assert.strictEqual(periodKey(new Date("2026-05-31T15:00:00Z")), "2026-05");
});

console.log("\nThe share prompt: only after a qualifying event\n");

test("no qualifying event means no prompt, ever", () => {
  /* Spec acceptance criterion: "The share prompt appears only after a
     qualifying event." Not on signup, not on a timer, not on first login. */
  assert.strictEqual(shouldSharePrompt({ eligibleAt: null }), false);
  assert.strictEqual(shouldSharePrompt({}), false);
  assert.strictEqual(shouldSharePrompt(), false);
});

test("a qualifying event shows it", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.strictEqual(
    shouldSharePrompt({ eligibleAt: new Date("2026-05-30T00:00:00Z"), now }),
    true,
  );
});

test("the frequency cap holds even with a fresh qualifying event", () => {
  /* Somebody who gets paid weekly would otherwise see this every week, which
     turns a nice moment into furniture. */
  const now = new Date("2026-06-01T00:00:00Z");
  assert.strictEqual(
    shouldSharePrompt({
      eligibleAt: new Date("2026-05-31T00:00:00Z"),
      shownAt: new Date("2026-05-28T00:00:00Z"), // 4 days ago
      now,
    }),
    false,
  );
});

test("it returns once the cooldown has passed", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  assert.strictEqual(
    shouldSharePrompt({
      eligibleAt: new Date("2026-05-31T00:00:00Z"),
      shownAt: new Date("2026-04-01T00:00:00Z"),
      now,
    }),
    true,
  );
});

test("the cooldown boundary is the stated number of days", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  const justInside = new Date(now.getTime() - (SHARE_PROMPT_COOLDOWN_DAYS - 1) * 86400000);
  const justOutside = new Date(now.getTime() - (SHARE_PROMPT_COOLDOWN_DAYS + 1) * 86400000);
  const eligibleAt = new Date("2026-05-31T00:00:00Z");

  assert.strictEqual(shouldSharePrompt({ eligibleAt, shownAt: justInside, now }), false);
  assert.strictEqual(shouldSharePrompt({ eligibleAt, shownAt: justOutside, now }), true);
});

test("two dismissals silence it permanently", () => {
  /* Somebody who has said no twice has answered the question. */
  const now = new Date("2026-06-01T00:00:00Z");
  const eligibleAt = new Date("2026-05-31T00:00:00Z");

  assert.strictEqual(shouldSharePrompt({ eligibleAt, dismissals: 1, now }), true);
  assert.strictEqual(shouldSharePrompt({ eligibleAt, dismissals: 2, now }), false);
  /* And no amount of time or new events brings it back. */
  assert.strictEqual(
    shouldSharePrompt({
      eligibleAt,
      dismissals: SHARE_PROMPT_MAX_DISMISSALS,
      shownAt: new Date("2020-01-01T00:00:00Z"),
      now,
    }),
    false,
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
