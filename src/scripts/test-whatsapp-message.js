/**
 * The WhatsApp message, and the two things about it that are easy to get wrong.
 *
 * 1. MONEY. Amounts are stored in sen. A template that interpolates the raw
 *    column asks a client for "50000" on a RM500 invoice, inside a message that
 *    cannot be edited once it has been read. This is the reason the renderer
 *    exists rather than four inline .replace() chains.
 *
 * 2. DRIFT. The defaults here have to be the same strings the settings screen
 *    previews. They were not — settings showed "Hi {{clientName}}, here is
 *    invoice *{{invoiceNumber}}*…" while the send route sent "{{userName}}
 *    {{companyName}} via InvoKita\n\nHello {{clientName}}…" — so a sender who
 *    never wrote a template was shown one message and their client got another.
 *    The last test in this file reads the frontend component and compares, so
 *    the next person to edit one of the two finds out here.
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  DEFAULTS,
  fillTokens,
  niceDate,
  invoiceTokens,
  renderInvoiceMessage,
  renderQuoteMessage,
  waShareUrl,
} = require("../utils/whatsappMessage");

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

console.log("\nWhat goes out on WhatsApp\n");

const INVOICE = {
  id: 7,
  invoiceNumber: "INV-0007",
  /* RM500.00, stored the only way amounts are stored. */
  amount: 50000,
  currency: "MYR",
  dueDate: "2026-08-20T00:00:00.000Z",
  client: { name: "Aisyah", phone: "60123456789" },
};

const PROFILE = { name: "Iman Muqri", companyName: "Bsyx" };

test("the amount is ringgit, never the raw sen column", () => {
  const text = renderInvoiceMessage({
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "https://invokita.my/pay/7",
  });

  assert.ok(text.includes("500.00"), "should read 500.00");
  assert.ok(
    !text.includes("50000"),
    "the sen value must never reach the client",
  );
});

test("the invoice number and the pay link are both in the default", () => {
  const text = renderInvoiceMessage({
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "https://invokita.my/pay/7",
  });

  assert.ok(text.includes("INV-0007"));
  assert.ok(text.includes("https://invokita.my/pay/7"));
});

test("the sender's own template wins over the default", () => {
  const text = renderInvoiceMessage({
    template: "Salam {{clientName}}, {{currency}} {{totalAmount}} — {{invoiceUrl}}",
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "https://invokita.my/pay/7",
  });

  assert.strictEqual(text, "Salam Aisyah, MYR 500.00 — https://invokita.my/pay/7");
});

test("a blank or whitespace template falls back rather than sending nothing", () => {
  for (const template of ["", "   ", "\n", null, undefined]) {
    const text = renderInvoiceMessage({
      template,
      invoice: INVOICE,
      profile: PROFILE,
      invoiceUrl: "https://invokita.my/pay/7",
    });
    assert.ok(text.includes("INV-0007"), `blank template (${JSON.stringify(template)})`);
  }
});

test("remind and send are different messages", () => {
  const values = {
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "https://invokita.my/pay/7",
  };
  const send = renderInvoiceMessage({ purpose: "send", ...values });
  const remind = renderInvoiceMessage({ purpose: "remind", ...values });

  assert.notStrictEqual(send, remind);
  assert.ok(remind.includes("reminder"));
});

test("tokens fill in whether or not they are padded with spaces", () => {
  const values = invoiceTokens({
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "u",
  });
  assert.strictEqual(fillTokens("{{clientName}}", values), "Aisyah");
  assert.strictEqual(fillTokens("{{ clientName }}", values), "Aisyah");
});

test("an unknown token is left visible rather than silently blanked", () => {
  const values = invoiceTokens({
    invoice: INVOICE,
    profile: PROFILE,
    invoiceUrl: "u",
  });
  /* A typo the sender can see in the preview and fix, instead of a message
     addressed to nobody. */
  assert.strictEqual(fillTokens("Hi {{clientNmae}}", values), "Hi {{clientNmae}}");
});

test("a missing due date does not put 'Invalid Date' in front of a client", () => {
  assert.strictEqual(niceDate(null), "");
  assert.strictEqual(niceDate("not a date"), "");

  const text = renderInvoiceMessage({
    invoice: { ...INVOICE, dueDate: null },
    profile: PROFILE,
    invoiceUrl: "u",
  });
  assert.ok(!/Invalid Date/.test(text));
});

test("dates read day-first, the way the settings preview shows them", () => {
  assert.strictEqual(niceDate("2026-08-20T00:00:00.000Z"), "20 Aug 2026");
});

test("a company with no name still addresses the client from someone", () => {
  const text = renderInvoiceMessage({
    invoice: INVOICE,
    profile: {},
    invoiceUrl: "u",
  });
  assert.ok(!text.includes("{{"), "no unfilled tokens");
  assert.ok(text.includes("InvoKita User"));
});

test("the quotation message links to accept/decline, not to a payment page", () => {
  const text = renderQuoteMessage({
    quote: {
      invoiceNumber: "QUO-0018",
      amount: 120000,
      currency: "MYR",
      validUntil: "2026-09-01T00:00:00.000Z",
      client: { name: "Aisyah" },
    },
    profile: PROFILE,
    quoteUrl: "https://invokita.my/quote/tok",
  });

  assert.ok(text.includes("QUO-0018"));
  assert.ok(text.includes("1200.00"), "sen formatted, not 120000");
  assert.ok(text.includes("Accept or decline"));
  assert.ok(text.includes("https://invokita.my/quote/tok"));
  assert.ok(!/invoice/i.test(text), "a quotation is not an invoice");
});

test("a quotation with no expiry does not claim one", () => {
  const text = renderQuoteMessage({
    quote: {
      invoiceNumber: "QUO-1",
      amount: 100,
      currency: "MYR",
      validUntil: null,
      client: { name: "A" },
    },
    profile: PROFILE,
    quoteUrl: "u",
  });
  assert.ok(!text.includes("holds until"));
});

test("the share link carries the number and the encoded message", () => {
  const url = waShareUrl({ phone: "60123456789", text: "Hi there & thanks" });
  assert.ok(url.startsWith("https://wa.me/60123456789?text="));
  /* & and spaces must be encoded or the message is truncated at the ampersand. */
  assert.ok(url.includes("Hi%20there%20%26%20thanks"));
});

test("a decorated number is reduced to digits rather than trusted", () => {
  assert.ok(
    waShareUrl({ phone: "+60 12-345 6789", text: "x" }).startsWith(
      "https://wa.me/60123456789?",
    ),
  );
});

test("it is wa.me, so the link lands on the client's chat", () => {
  const url = waShareUrl({ phone: "60123456789", text: "x" });
  /* NOT web.whatsapp.com/send. That skips wa.me's "Continue to Chat" step and
     opens the sender's own WhatsApp Web without the client's conversation —
     which is indistinguishable from the feature being broken. */
  assert.ok(url.startsWith("https://wa.me/"));
  assert.ok(!url.includes("web.whatsapp.com"));
});

test("no phone number yields no link at all", () => {
  /* Rather than wa.me/?text=…, which opens WhatsApp with nothing selected and
     reads as "it opened my own WhatsApp and did nothing". The caller shows "no
     phone number saved for this client" instead of opening a dead window. */
  for (const phone of [null, undefined, "", "   ", "not-a-number"]) {
    assert.strictEqual(
      waShareUrl({ phone, text: "hello" }),
      null,
      `phone: ${JSON.stringify(phone)}`,
    );
  }
});

test("the defaults match the ones the settings screen previews", () => {
  /* Read the component rather than restating its strings, so this cannot pass by
     being updated in lockstep with a mistake. */
  const vue = fs.readFileSync(
    path.join(
      __dirname,
      "../../../Frontend/components/business/Whatsapp.vue",
    ),
    "utf8",
  );

  const block = vue.match(/const DEFAULTS = \{([\s\S]*?)\n\};/);
  assert.ok(block, "could not find the DEFAULTS block in Whatsapp.vue");

  for (const [key, expected] of Object.entries(DEFAULTS)) {
    /* The literal as written in the component, with its escapes intact. */
    const written = expected.replace(/\n/g, "\\n");
    assert.ok(
      block[1].includes(written),
      `the ${key} default in Whatsapp.vue no longer matches utils/whatsappMessage.\n` +
        `  backend: ${written}\n` +
        `  Update both, or the sender is shown one message and the client gets another.`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
