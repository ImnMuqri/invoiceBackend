/**
 * Quotation lifecycle tests (spec 07).
 *
 * Pure functions only — no database, no network, no fastify. Everything tested
 * here is a decision that gets made in more than one place (the public page,
 * the owner's list, the nightly sweep) and would be a silent contradiction if
 * the copies drifted.
 *
 * Run: node src/scripts/test-quote-lifecycle.js
 */

const assert = require("assert");
const {
  QUOTE_STATUSES,
  OPEN_STATUSES,
  AWAITING_REPLY,
  CLOSED_STATUSES,
  mintPublicToken,
  isExpired,
  effectiveStatus,
  isAnswerable,
} = require("../utils/quoteLifecycle");

const {
  getQuoteEmail,
  getQuoteAnsweredEmail,
  getQuoteExpiredEmail,
} = require("../utils/quoteEmail");

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

const day = (iso) => new Date(iso);

console.log("\nStatus vocabulary\n");

test("every status is accounted for as open or closed", () => {
  const union = [...OPEN_STATUSES, ...CLOSED_STATUSES].sort();
  assert.deepStrictEqual(union, [...QUOTE_STATUSES].sort());
});

test("no status is both open and closed", () => {
  const overlap = OPEN_STATUSES.filter((s) => CLOSED_STATUSES.includes(s));
  assert.deepStrictEqual(overlap, []);
});

test("awaiting-reply is a subset of open, and excludes Draft", () => {
  assert.ok(AWAITING_REPLY.every((s) => OPEN_STATUSES.includes(s)));
  assert.ok(!AWAITING_REPLY.includes("Draft"));
});

test("no quote status collides with an invoice money status", () => {
  /* The two kinds share a table and a status column. A quote that happened to
     read "Overdue" or "Paid" would be picked up by anything filtering for
     money owed — the exact failure the schema comment warns about. */
  const MONEY = ["Pending", "Overdue", "Paid", "Partially Paid", "Void", "Cancelled"];
  const collide = QUOTE_STATUSES.filter((s) => MONEY.includes(s));
  assert.deepStrictEqual(collide, []);
});

console.log("\nExpiry: end of the validUntil day, in Kuala Lumpur\n");

/* All instants below are written in UTC on purpose. These assertions have to
   hold on a Railway box running UTC and on a laptop in KL, and a test written
   in local time would pass in one place and fail in the other — which is the
   exact class of bug being tested for. KL is UTC+8, no DST. */
const VALID_UNTIL_30_NOV = { validUntil: day("2026-11-30T00:00:00Z") };

test("not expired at 01:15 KL on the validUntil day", () => {
  /* The nightly sweep's hour. A naive `validUntil < now` expires every
     quotation a full day early — on a day the client can still accept. */
  assert.strictEqual(
    isExpired(VALID_UNTIL_30_NOV, day("2026-11-29T17:15:00Z")), // 01:15 KL, 30 Nov
    false,
  );
});

test("not expired at 23:59 KL on the validUntil day", () => {
  assert.strictEqual(
    isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T15:59:00Z")), // 23:59 KL, 30 Nov
    false,
  );
});

test("expired at 00:01 KL the following day", () => {
  assert.strictEqual(
    isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T16:01:00Z")), // 00:01 KL, 1 Dec
    true,
  );
});

test("expired by the time the sweep runs the next morning", () => {
  assert.strictEqual(
    isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T17:15:00Z")), // 01:15 KL, 1 Dec
    true,
  );
});

test("the boundary is exact to the millisecond", () => {
  /* Midnight KL on 1 Dec is 16:00 UTC on 30 Nov. One ms before is the last
     moment the quotation is live. */
  assert.strictEqual(isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T15:59:59.999Z")), false);
  assert.strictEqual(isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T16:00:00.000Z")), true);
});

test("month and year boundaries do not wrap wrongly", () => {
  const dec31 = { validUntil: day("2026-12-31T00:00:00Z") };
  assert.strictEqual(isExpired(dec31, day("2026-12-31T15:00:00Z")), false); // 23:00 KL 31 Dec
  assert.strictEqual(isExpired(dec31, day("2026-12-31T16:00:00Z")), true); // 00:00 KL 1 Jan
});

test("no validUntil means it never expires", () => {
  assert.strictEqual(isExpired({ validUntil: null }, new Date()), false);
  assert.strictEqual(isExpired({}, new Date()), false);
});

test("an unparseable validUntil does not expire the quote", () => {
  /* Failing open is right here: the alternative is a NaN comparison silently
     marking a live quotation dead and taking the accept button away. */
  assert.strictEqual(isExpired({ validUntil: "not a date" }, new Date()), false);
});

test("expiry is decided in KL regardless of the process timezone", () => {
  /* The regression guard. An earlier version used setHours(), which resolves in
     the process timezone — UTC on Railway — while every cron is pinned to
     Asia/Kuala_Lumpur. Eight hours is enough to move an expiry across a date
     boundary. Re-running the boundary assertions under a shifted TZ proves the
     answer no longer depends on where the code happens to be running. */
  const original = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Kuala_Lumpur", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      assert.strictEqual(
        isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T15:59:59.999Z")),
        false,
        `live moment misread under TZ=${tz}`,
      );
      assert.strictEqual(
        isExpired(VALID_UNTIL_30_NOV, day("2026-11-30T16:00:00.000Z")),
        true,
        `expiry moment misread under TZ=${tz}`,
      );
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});

console.log("\neffectiveStatus: what to SHOW vs what is stored\n");

test("a lapsed Sent quote shows as Expired before the sweep relabels it", () => {
  const q = { status: "Sent", validUntil: day("2026-01-01T00:00:00Z") };
  assert.strictEqual(effectiveStatus(q, day("2026-06-01T00:00:00Z")), "Expired");
});

test("a lapsed Viewed quote shows as Expired too", () => {
  const q = { status: "Viewed", validUntil: day("2026-01-01T00:00:00Z") };
  assert.strictEqual(effectiveStatus(q, day("2026-06-01T00:00:00Z")), "Expired");
});

test("an ANSWERED quote is never relabelled by expiry", () => {
  /* Accepting on the last valid day and reading the record a month later must
     still say Accepted. Expiry outranking an answer would erase the answer. */
  for (const status of ["Accepted", "Declined"]) {
    const q = { status, validUntil: day("2026-01-01T00:00:00Z") };
    assert.strictEqual(effectiveStatus(q, day("2026-06-01T00:00:00Z")), status);
  }
});

test("a Draft is never relabelled by expiry", () => {
  const q = { status: "Draft", validUntil: day("2026-01-01T00:00:00Z") };
  assert.strictEqual(effectiveStatus(q, day("2026-06-01T00:00:00Z")), "Draft");
});

test("a live quote keeps its stored status", () => {
  const q = { status: "Viewed", validUntil: day("2027-01-01T00:00:00Z") };
  assert.strictEqual(effectiveStatus(q, day("2026-06-01T00:00:00Z")), "Viewed");
});

console.log("\nisAnswerable: can the client still press the button?\n");

test("Sent and Viewed within validity are answerable", () => {
  const future = day("2027-01-01T00:00:00Z");
  const now = day("2026-06-01T00:00:00Z");
  assert.strictEqual(isAnswerable({ status: "Sent", validUntil: future }, now), true);
  assert.strictEqual(isAnswerable({ status: "Viewed", validUntil: future }, now), true);
});

test("Draft is not answerable — it was never sent", () => {
  const now = day("2026-06-01T00:00:00Z");
  assert.strictEqual(isAnswerable({ status: "Draft", validUntil: null }, now), false);
});

test("an already-answered quote is not answerable again", () => {
  const now = day("2026-06-01T00:00:00Z");
  for (const status of ["Accepted", "Declined", "Expired"]) {
    assert.strictEqual(isAnswerable({ status, validUntil: null }, now), false);
  }
});

test("a lapsed quote is not answerable", () => {
  const q = { status: "Sent", validUntil: day("2026-01-01T00:00:00Z") };
  assert.strictEqual(isAnswerable(q, day("2026-06-01T00:00:00Z")), false);
});

test("effectiveStatus and isAnswerable never disagree", () => {
  /* If the page says Expired it must not also render an accept button. */
  const now = day("2026-06-01T00:00:00Z");
  const dates = [null, day("2026-01-01T00:00:00Z"), day("2027-01-01T00:00:00Z")];
  for (const status of QUOTE_STATUSES) {
    for (const validUntil of dates) {
      const q = { status, validUntil };
      if (isAnswerable(q, now)) {
        assert.ok(
          AWAITING_REPLY.includes(effectiveStatus(q, now)),
          `${status} / ${validUntil} is answerable but shows as ${effectiveStatus(q, now)}`,
        );
      }
    }
  }
});

console.log("\nPublic token\n");

test("tokens are url-safe and long enough to not be guessable", () => {
  const t = mintPublicToken();
  assert.match(t, /^[A-Za-z0-9_-]+$/, "must be url-safe with no padding");
  /* 16 random bytes in base64url = 22 chars. Anything materially shorter means
     somebody reduced the entropy behind an accept button. */
  assert.ok(t.length >= 22, `token too short: ${t.length}`);
});

test("tokens do not repeat", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) seen.add(mintPublicToken());
  assert.strictEqual(seen.size, 2000);
});

console.log("\nEmails: amounts are SEN, and the audience is right\n");

const QUOTE = {
  clientName: "Wayne Lim",
  senderName: "Aisyah",
  senderCompany: "Studio Kirana",
  quoteNumber: "QUO-0018",
  /* 120000 sen = RM1,200.00. Printed raw this reads "120,000" — a hundred
     times the price, in a document a client is asked to agree to. */
  amount: 120000,
  currency: "MYR",
  validUntil: "2026-11-30",
  subject: "Website build",
  publicUrl: "https://invokita.my/quote/abc123",
};

test("the client email converts sen to ringgit", () => {
  const { html, text } = getQuoteEmail(QUOTE);
  assert.ok(html.includes("1,200.00"), "html should show 1,200.00");
  assert.ok(text.includes("1,200.00"), "text should show 1,200.00");
  assert.ok(!html.includes("120,000.00"), "html must not show raw sen");
});

test("the client email leads with the link, not an attachment", () => {
  const { html, text } = getQuoteEmail(QUOTE);
  assert.ok(html.includes(QUOTE.publicUrl));
  assert.ok(text.includes(QUOTE.publicUrl));
});

test("the client email never implies payment is due", () => {
  const { subject, html, text } = getQuoteEmail(QUOTE);
  const body = `${subject} ${html} ${text}`.toLowerCase();
  for (const word of ["amount due", "overdue", "pay now", "payment due"]) {
    assert.ok(!body.includes(word), `client quote email must not say "${word}"`);
  }
});

test("client-supplied text is escaped", () => {
  /* The client name comes from a form. An unescaped tag in an HTML email is a
     hole, and the decline reason is typed by somebody outside the account. */
  const { html } = getQuoteEmail({ ...QUOTE, clientName: '<script>x</script>' });
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(html.includes("&lt;script&gt;"));

  const declined = getQuoteAnsweredEmail({
    accepted: false,
    quoteNumber: "QUO-1",
    clientName: "Wayne",
    reason: '<img src=x onerror="alert(1)">',
    amount: 100,
    currency: "MYR",
    quoteId: 1,
  });
  assert.ok(!declined.html.includes("<img src=x"));
});

test("the accepted email goes to the owner and points at the invoice", () => {
  const { subject, html } = getQuoteAnsweredEmail({
    accepted: true,
    quoteNumber: "QUO-0018",
    clientName: "Wayne Lim",
    acceptedName: "Wayne Lim",
    amount: 120000,
    currency: "MYR",
    quoteId: 7,
  });
  assert.ok(subject.startsWith("Accepted:"));
  assert.ok(html.includes("1,200.00"));
  assert.ok(html.includes("/quotes/edit/7"));
  assert.ok(html.toLowerCase().includes("raise the invoice"));
});

test("the expiry email says nothing went to the client", () => {
  /* The spec's rule, restated as a test: expiry notifies the USER and the
     client hears nothing. If this string ever disappears, somebody has changed
     who the email is for. */
  const { subject, html, text } = getQuoteExpiredEmail({
    quotes: [
      { invoiceNumber: "QUO-0018", clientName: "Wayne Lim", amount: 120000, currency: "MYR" },
    ],
  });
  assert.ok(subject.includes("QUO-0018"));
  assert.ok(html.toLowerCase().includes("nothing was sent to the client"));
  assert.ok(text.toLowerCase().includes("nothing was sent to the client"));
  assert.ok(html.includes("1,200.00"));
});

test("the expiry email pluralises rather than sending one per quote", () => {
  const { subject, html } = getQuoteExpiredEmail({
    quotes: [
      { invoiceNumber: "QUO-1", clientName: "A", amount: 100, currency: "MYR" },
      { invoiceNumber: "QUO-2", clientName: "B", amount: 200, currency: "MYR" },
    ],
  });
  assert.ok(subject.includes("2 quotations"));
  assert.ok(html.includes("QUO-1") && html.includes("QUO-2"));
});

console.log("\nThe guarantee: a quotation is never chased\n");

/* These read the source rather than calling a function, which is unusual and
   deliberate. "A sent quote generates no automated follow up of any kind" is
   spec 07's first acceptance criterion, and it is not enforced by any single
   function — it holds because every chase-shaped query filters on kind. That is
   a property of the code's SHAPE, and the only way to stop it eroding is to
   assert on the shape. If one of these fails, do not delete the test: a query
   that reaches quotations has been added to a path that messages clients. */
const fs = require("fs");
const path = require("path");
const read = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8");

test("every invoice query in the cron names a kind", () => {
  const src = read("src/plugins/cron.js");

  /* Counted rather than parsed. Matching balanced braces with a regex is how
     this test lied the first time — it "found" a query whose where clause is
     built by accountantExport.whereFor(), which does filter kind INVOICE, and
     reported a violation that did not exist.

     So: every invoice query in this file either names a kind inline or hands
     its where clause to whereFor(). Both counts are asserted, which catches a
     new unfiltered query without pretending to understand the syntax. */
  const queries = (src.match(/prisma\.invoice\.(findMany|findFirst|count|groupBy)\(/g) || [])
    .length;
  const inlineKind = (src.match(/kind:\s*"(INVOICE|QUOTE)"/g) || []).length;
  const viaHelper = (src.match(/ex\.whereFor\(/g) || []).length;

  assert.ok(queries > 0, "expected invoice queries in the cron");
  assert.strictEqual(
    inlineKind + viaHelper,
    queries,
    `${queries} invoice queries in cron.js but only ${inlineKind + viaHelper} name a kind — ` +
      "an unfiltered query here chases or expires the wrong kind of document",
  );
});

test("the overdue sweep never touches quotations", () => {
  const src = read("src/plugins/cron.js");
  const overdue = src.slice(src.indexOf("markOverdueInvoices"), src.indexOf("expireQuotes"));
  assert.ok(
    /kind:\s*"INVOICE"/.test(overdue),
    "the overdue sweep must filter kind INVOICE — a quote marked Overdue enters the money figures",
  );
});

test("manual WhatsApp send and remind are invoice-only", () => {
  /* Both had no kind filter. A quote id on either sent the client invoice
     wording and stamped chasedInPeriod on the quotation — a chase cycle opened
     on a document that must never be chased. */
  const src = read("src/routes/whatsapp/index.js");
  const lookups = (src.match(/prisma\.invoice\.find\w+\(/g) || []).length;
  const guarded = (src.match(/kind:\s*"INVOICE"/g) || []).length;

  assert.ok(lookups > 0, "expected invoice lookups in the whatsapp routes");
  assert.strictEqual(
    guarded,
    lookups,
    `${lookups} invoice lookups in the whatsapp routes but ${guarded} kind filters — ` +
      "an unguarded one lets a quote id open a chase cycle on a quotation",
  );
});

test("the quote send path opens no chase cycle", () => {
  const src = read("src/routes/quotes/index.js");
  const send = src.slice(src.indexOf('"/:id/send"'), src.indexOf('"/:id/decision"'));
  /* It may consume allowance — a WhatsApp message costs the same either way —
     but it must never schedule or set a reminder field. */
  for (const f of ["ReminderSent", "reminderInterval", "autoChaser"]) {
    assert.ok(!send.includes(f), `the quote send path references "${f}"`);
  }
});

test("the public client-facing routes carry no authenticate hook", () => {
  /* Comments stripped first. The file's header explains at length that there is
     no `fastify.authenticate` hook and must never be one — and the first
     version of this test read that sentence as the violation it warns against,
     failing on correct code. Assert on what executes, not on what is written. */
  const src = read("src/routes/quote/index.js")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  for (const gate of ["fastify.authenticate", "addHook", "preHandler", "preValidation"]) {
    assert.ok(
      !src.includes(gate),
      `the client-facing quote routes reference "${gate}" — they must stay public, ` +
        "a client answering a quotation has no account and will not make one",
    );
  }
});

test("the public payload never exposes money-owed columns", () => {
  const { PUBLIC_QUOTE_SELECT } = require("../routes/quote/index.js");
  const keys = Object.keys(PUBLIC_QUOTE_SELECT);
  for (const owed of ["dueDate", "amountDue", "amountPaid", "amountAdjusted", "chasedInPeriod"]) {
    assert.ok(!keys.includes(owed), `the client-facing quote exposes "${owed}"`);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
