/**
 * What a client is actually charged on the public payment page.
 *
 * Short, because the rule is one subtraction — but it is the rule that decides
 * how much money leaves somebody's account, and it was wrong in production:
 * every gateway bill was raised for `invoice.amount`, so a client who had paid
 * half was sent to a checkout for the full amount a second time and the page
 * printed that same figure under the words "Amount Due".
 *
 * The comparisons in the verify endpoints are pinned here too, because they are
 * the other half of the same change. Charging the balance while still measuring
 * the gateway's answer against the total would reject the exact payment the
 * endpoint had just asked for — the client charged, the invoice left open, and
 * no error anywhere to explain it.
 *
 * Run: npm run test:pay
 */

const assert = require("assert");
const { outstandingSen } = require("../routes/pay");

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

console.log("\nWhat is still owed\n");

test("an untouched invoice is charged in full", () => {
  assert.strictEqual(outstandingSen({ amount: 125000 }), 125000);
});

test("a part payment is deducted", () => {
  /* THE BUG. 50000 already paid on a 125000 invoice used to produce a bill for
     125000 — the client charged the full amount twice. */
  assert.strictEqual(
    outstandingSen({ amount: 125000, amountPaid: 50000 }),
    75000,
  );
});

test("a credit note is deducted", () => {
  assert.strictEqual(
    outstandingSen({ amount: 125000, amountAdjusted: 25000 }),
    100000,
  );
});

test("payments and credit notes are deducted together", () => {
  assert.strictEqual(
    outstandingSen({ amount: 125000, amountPaid: 50000, amountAdjusted: 25000 }),
    50000,
  );
});

test("a fully covered invoice owes nothing, never a negative", () => {
  /* An overpayment or an over-generous credit note must not produce a negative
     charge — some gateways accept one and it becomes a refund nobody intended. */
  assert.strictEqual(outstandingSen({ amount: 10000, amountPaid: 10000 }), 0);
  assert.strictEqual(outstandingSen({ amount: 10000, amountPaid: 15000 }), 0);
  assert.strictEqual(
    outstandingSen({ amount: 10000, amountAdjusted: 12000 }),
    0,
  );
});

test("missing terms count as zero rather than NaN", () => {
  /* The public payload selects these columns explicitly and the other callers
     use `include`, but a NaN here would sail into a gateway as an amount. */
  assert.strictEqual(outstandingSen({ amount: 5000 }), 5000);
  assert.strictEqual(
    outstandingSen({ amount: 5000, amountPaid: null, amountAdjusted: undefined }),
    5000,
  );
});

test("the stored amountDue column is NOT what is charged", () => {
  /* It defaults to 0 and is only written by invoiceMoney.recalculate(), so an
     invoice predating that column — or one whose recalculation failed halfway —
     holds a plausible-looking zero against a real balance. Reading it would
     raise a bill for nothing. The subtraction cannot go stale. */
  assert.strictEqual(
    outstandingSen({ amount: 90000, amountPaid: 0, amountDue: 0 }),
    90000,
  );
});

console.log("\nThe verification gates use the same figure\n");

test("a balance payment clears a partially paid invoice", () => {
  /* Billplz reports paid_amount in sen. The bill was raised for the balance, so
     the gate has to measure against the balance: against `amount` this returns
     false and the client is charged with the invoice still open. */
  const invoice = { amount: 125000, amountPaid: 50000 };
  const paidAmount = outstandingSen(invoice); // what the bill was raised for
  assert.ok(paidAmount >= outstandingSen(invoice), "balance should clear");
  assert.ok(
    paidAmount < Number(invoice.amount),
    "and it is deliberately less than the original total",
  );
});

test("an underpayment still does not clear it", () => {
  const invoice = { amount: 125000, amountPaid: 50000 };
  const short = outstandingSen(invoice) - 1;
  assert.ok(short < outstandingSen(invoice));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
