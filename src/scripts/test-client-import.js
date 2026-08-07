/**
 * Client import tests (spec 08).
 *
 * Pure functions only — no database, no fastify. The import's whole safety
 * story is that the preview and the commit run the SAME pure analysis over the
 * same text, so testing that analysis is testing both.
 *
 * The phone section is the longest on purpose. The spec calls phone handling
 * the part most likely to break, and it is the only part whose failure is
 * invisible: a wrongly stored number does not error at import, it turns into a
 * WhatsApp message that never arrives weeks later, on an invoice the user
 * believes is being chased.
 *
 * Run: npm run test:import
 */

const assert = require("assert");
const {
  normalisePhone,
  displayPhone,
  deliverability,
  REASON,
} = require("../utils/phoneNormalise");
const {
  detectDelimiter,
  parseDelimited,
  looksLikeHeader,
  analyse,
  templateCsv,
} = require("../utils/clientImport");

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

/* ═══════════════════════════════════════════════════════════════════════════
   Phone numbers
   ═══════════════════════════════════════════════════════════════════════════ */

console.log("\nMalaysian mobiles: every local form reaches ONE stored value\n");

test("the seven formats people actually paste all normalise identically", () => {
  /* Spec acceptance criterion, verbatim: "Malaysian mobile numbers in several
     common local formats all normalise to the same stored value." */
  const forms = [
    "0123456789",
    "012-3456789",
    "012 345 6789",
    "012-345 6789",
    "(012) 345-6789",
    "+60123456789",
    "+60 12-345 6789",
    "60123456789",
    "0060123456789",
    "012.345.6789",
  ];
  const results = forms.map((f) => {
    const r = normalisePhone(f);
    assert.ok(r.ok, `"${f}" was refused: ${r.reason}`);
    return r.value;
  });
  const distinct = [...new Set(results)];
  assert.deepStrictEqual(
    distinct,
    ["60123456789"],
    `expected one stored value, got ${JSON.stringify(distinct)}`,
  );
});

test("a leading zero eaten by a spreadsheet is recovered", () => {
  /* Format a phone column as a NUMBER in Excel and the leading zero is gone
     forever. Accepted only because adding it back produces a number that
     validates — this is a check, not an assumption. */
  const r = normalisePhone("123456789");
  assert.ok(r.ok);
  assert.strictEqual(r.value, "60123456789");
});

test("the 10-digit prefixes (011, 015) are not truncated", () => {
  for (const [input, expected] of [
    ["011-2345 6789", "601123456789"],
    ["01123456789", "601123456789"],
    ["015-1234 5678", "601512345678"],
  ]) {
    const r = normalisePhone(input);
    assert.ok(r.ok, `"${input}" refused: ${r.reason}`);
    assert.strictEqual(r.value, expected, `"${input}" became ${r.value}`);
  }
});

test("a 9-digit prefix given 10 digits is refused, not trimmed", () => {
  /* 012 numbers have 9 digits after the 0. Given 10, the honest answer is
     "this is wrong", not "I will drop one and hope". */
  const r = normalisePhone("0123456789 0");
  assert.ok(!r.ok || r.value === "60123456789");

  const tooLong = normalisePhone("01234567890");
  assert.ok(!tooLong.ok, "an over-long 012 number must be refused");
  assert.strictEqual(tooLong.reason, REASON.BAD_MY_LENGTH);
});

test("landlines are kept but marked as landlines", () => {
  const r = normalisePhone("03-1234 5678");
  assert.ok(r.ok);
  assert.strictEqual(r.value, "60312345678");
  assert.strictEqual(r.kind, "my_landline");
});

console.log("\nInternational numbers are preserved, not reinterpreted\n");

test("an explicit + is honoured for any country", () => {
  for (const [input, expected] of [
    ["+65 9123 4567", "6591234567"],
    ["+1 415 555 2671", "14155552671"],
    ["+44 20 7946 0958", "442079460958"],
    ["+62 812 3456 789", "628123456789"],
  ]) {
    const r = normalisePhone(input);
    assert.ok(r.ok, `"${input}" refused: ${r.reason}`);
    assert.strictEqual(r.value, expected);
    assert.strictEqual(r.kind, "international");
  }
});

test("a 00 dial-out prefix is understood", () => {
  const r = normalisePhone("0065 9123 4567");
  assert.ok(r.ok);
  assert.strictEqual(r.value, "6591234567");
});

test("a Singapore number is never bent into a Malaysian one", () => {
  /* The failure this guards: 8-digit SG numbers are close enough in shape to
     Malaysian ones that a permissive parser will happily produce a valid-looking
     60xxxxxxxx. That number belongs to somebody else. */
  const r = normalisePhone("+6591234567");
  assert.ok(r.ok);
  assert.ok(r.value.startsWith("65"), `became ${r.value}`);
});

console.log("\nRefusals: never guess\n");

test("unparseable numbers are refused rather than stored", () => {
  /* Spec acceptance criterion: "An unparseable phone number is flagged in the
     preview and not imported silently." */
  for (const bad of ["", "   ", "abcdefg", "12345", "phone: soon", "-", "0000"]) {
    const r = normalisePhone(bad);
    assert.ok(!r.ok, `"${bad}" should have been refused but became ${r.value}`);
    assert.strictEqual(r.value, null);
  }
});

test("an ambiguous long number is refused with an actionable reason", () => {
  const r = normalisePhone("442079460958");
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, REASON.AMBIGUOUS);
  assert.ok(/country code/i.test(r.detail), "the reason should tell the user what to do");
});

test("an extension is refused rather than silently dropped", () => {
  /* Dropping "ext 12" leaves a number that dials the switchboard, which is a
     plausible-looking wrong answer — the worst kind. */
  const r = normalisePhone("03-1234 5678 ext 12");
  assert.ok(!r.ok);
  assert.strictEqual(r.reason, REASON.EXTENSION);
});

test("unknown Malaysian prefixes are refused", () => {
  const r = normalisePhone("021-2345678");
  assert.ok(!r.ok);
  assert.ok([REASON.UNKNOWN_MY_PREFIX, REASON.BAD_MY_LENGTH].includes(r.reason));
});

console.log("\nDeliverability is about the PAIR, not one column\n");

test("a mobile alone is reachable; a landline alone is not, over WhatsApp", () => {
  const mobile = deliverability({ phone: "60123456789", phoneKind: "my_mobile", email: null });
  assert.strictEqual(mobile.canWhatsApp, true);
  assert.strictEqual(mobile.reachable, true);

  const landline = deliverability({ phone: "60312345678", phoneKind: "my_landline", email: null });
  assert.strictEqual(landline.canWhatsApp, false);
  assert.strictEqual(landline.reachable, false);
});

test("an email alone is reachable", () => {
  const r = deliverability({ phone: null, phoneKind: null, email: "a@b.com" });
  assert.strictEqual(r.canEmail, true);
  assert.strictEqual(r.reachable, true);
});

test("neither is not reachable", () => {
  const r = deliverability({ phone: null, phoneKind: null, email: null });
  assert.strictEqual(r.reachable, false);
});

test("display form is for reading only and round-trips the stored value", () => {
  assert.strictEqual(displayPhone("60123456789"), "012-3456789");
  assert.strictEqual(displayPhone("6591234567"), "+6591234567");
  const back = normalisePhone(displayPhone("60123456789"));
  assert.ok(back.ok);
  assert.strictEqual(back.value, "60123456789");
});

/* ═══════════════════════════════════════════════════════════════════════════
   Parsing
   ═══════════════════════════════════════════════════════════════════════════ */

console.log("\nParsing: tabs, commas, newlines and quotes\n");

test("tab wins, because that is what a spreadsheet paste is", () => {
  assert.strictEqual(detectDelimiter("a\tb\tc"), "\t");
  /* A tab present anywhere beats commas inside the cells. */
  assert.strictEqual(detectDelimiter("a, inc\tb\tc"), "\t");
  assert.strictEqual(detectDelimiter("a,b,c"), ",");
  assert.strictEqual(detectDelimiter("a;b;c"), ";");
});

test("a one-per-line list of names parses as a single column", () => {
  const rows = parseDelimited("Ahmad\nSiti\nWayne", detectDelimiter("Ahmad\nSiti\nWayne"));
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], ["Ahmad"]);
});

test("quoted fields keep their commas", () => {
  /* Without this, every row after the first address is shifted by one column
     and the whole import is quietly wrong. */
  const rows = parseDelimited('Ahmad,"12 Jalan Besar, KL",a@b.com', ",");
  assert.deepStrictEqual(rows[0], ["Ahmad", "12 Jalan Besar, KL", "a@b.com"]);
});

test("doubled quotes mean a literal quote", () => {
  const rows = parseDelimited('Ahmad,"He said ""hello""",a@b.com', ",");
  assert.strictEqual(rows[0][1], 'He said "hello"');
});

test("a quoted field may contain a newline", () => {
  const rows = parseDelimited('Ahmad,"Line one\nLine two"', ",");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0][1], "Line one\nLine two");
});

test("blank spacer rows are dropped", () => {
  const rows = parseDelimited("Ahmad\tx\n\n\nSiti\ty", "\t");
  assert.strictEqual(rows.length, 2);
});

test("CRLF from a Windows CSV does not leak into the data", () => {
  const rows = parseDelimited("Ahmad,a@b.com\r\nSiti,c@d.com", ",");
  assert.strictEqual(rows[0][1], "a@b.com");
  assert.strictEqual(rows.length, 2);
});

console.log("\nHeader detection\n");

test("a real header row is recognised", () => {
  assert.strictEqual(looksLikeHeader(["Name", "Phone", "Email"]), true);
  assert.strictEqual(looksLikeHeader(["Nama", "No Telefon", "Emel"]), true);
});

test("a data row that happens to contain a header-ish word is NOT a header", () => {
  /* The failure this stops: reading the first real client as column names,
     which eats them silently. */
  assert.strictEqual(looksLikeHeader(["Contact Sdn Bhd", "012-3456789", "a@b.com"]), false);
  assert.strictEqual(looksLikeHeader(["Ahmad", "0123456789"]), false);
});

/* ═══════════════════════════════════════════════════════════════════════════
   Column detection and the end-to-end analysis
   ═══════════════════════════════════════════════════════════════════════════ */

console.log("\nColumn detection: the common case needs no correction\n");

test("three columns pasted from a spreadsheet map correctly with no header", () => {
  /* Spec acceptance criterion: "Pasting three columns straight from a
     spreadsheet produces a correct mapping without manual correction in the
     common case." */
  const paste = [
    "Ahmad Faizal\t012-345 6789\tahmad@example.com",
    "Siti Nurhaliza\t011-2345 6789\tsiti@example.com",
    "Wayne Lim\t016 777 8888\twayne@example.com",
  ].join("\n");

  const r = analyse(paste);
  assert.strictEqual(r.hasHeader, false);
  assert.deepStrictEqual(r.mapping, ["name", "phone", "email"]);
  assert.strictEqual(r.summary.create, 3);
  assert.strictEqual(r.summary.problems, 0);
});

test("columns in an unexpected order are still identified", () => {
  const paste = [
    "ahmad@example.com\t012-345 6789\tAhmad Faizal",
    "siti@example.com\t011-2345 6789\tSiti Nurhaliza",
  ].join("\n");
  const r = analyse(paste);
  assert.deepStrictEqual(r.mapping, ["email", "phone", "name"]);
});

test("a header row names the columns even when the content is ambiguous", () => {
  const csv = "Email,Name,Phone,Address\na@b.com,Ahmad,0123456789,12 Jalan Besar";
  const r = analyse(csv);
  assert.strictEqual(r.hasHeader, true);
  assert.deepStrictEqual(r.mapping, ["email", "name", "phone", "address"]);
});

test("Malay headers are understood", () => {
  const csv = "Nama,No Telefon,Emel,Syarikat\nAhmad,0123456789,a@b.com,Kedai Ahmad";
  const r = analyse(csv);
  assert.strictEqual(r.hasHeader, true);
  assert.deepStrictEqual(r.mapping, ["name", "phone", "email", "company"]);
});

test("name then company, with no header, does not put the company in the name", () => {
  const paste = "Ahmad Faizal\tKedai Kopi Ahmad\nSiti Nurhaliza\tSiti Design";
  const r = analyse(paste);
  assert.strictEqual(r.mapping[0], "name");
  assert.strictEqual(r.mapping[1], "company");
});

test("a phone column where NOTHING parses is still recognised, not dropped", () => {
  /* The regression this guards is the nastiest failure this module can have.
     Detection originally scored a column purely on how many of its numbers
     parsed, so a list where every number was malformed scored zero, was not
     recognised as the phone column, and was therefore ignored entirely — the
     user imported their whole client list with no phone numbers and nothing on
     screen told them. Recognised by shape, every row becomes a visible problem
     instead. */
  const paste = ["Ahmad\t012-99", "Siti\t011-12", "Wayne\t016-4"].join("\n");
  const r = analyse(paste);
  assert.strictEqual(r.mapping[1], "phone", "the column must be claimed even though none parse");
  assert.strictEqual(r.summary.problems, 3, "every row must be flagged");
  assert.ok(r.rows[0].issues.some((i) => i.code === "bad_phone"));
});

test("one unparseable number does not stop the column being recognised", () => {
  /* Every real list has one bad number in it. That row should be flagged, not
     cause the whole column to go unmapped and the import to look broken. */
  const paste = [
    "Ahmad\t012-345 6789",
    "Siti\t011-2345 6789",
    "Wayne\tcall the office",
  ].join("\n");
  const r = analyse(paste);
  assert.strictEqual(r.mapping[1], "phone");
  assert.strictEqual(r.summary.problems, 1);
});

console.log("\nRows: problems, warnings and duplicates\n");

test("a bad phone number makes the row a problem, with a reason", () => {
  const r = analyse("Ahmad\t012-99\ta@b.com");
  const row = r.rows[0];
  assert.strictEqual(row.status, "problem");
  assert.ok(row.issues.some((i) => i.code === "bad_phone"));
  assert.ok(row.issues[0].message.includes("012-99"), "the message should quote the input");
});

test("a row with a name and no contact details imports with a warning", () => {
  /* Spec acceptance criterion: "A row with a name and no contact details is
     flagged as unusable for delivery but can still be imported if the user
     chooses." */
  const r = analyse("Lone Name");
  const row = r.rows[0];
  assert.strictEqual(row.status, "create");
  assert.strictEqual(row.action, "create");
  assert.strictEqual(row.reach.reachable, false);
  assert.ok(row.warnings.some((w) => w.code === "no_contact"));
  assert.strictEqual(row.issues.length, 0, "unreachable is a warning, never a blocker");
});

test("a row with no name at all is a problem", () => {
  const r = analyse("\t012-345 6789\ta@b.com", { hasHeaderOverride: false });
  assert.strictEqual(r.rows[0].status, "problem");
  assert.ok(r.rows[0].issues.some((i) => i.code === "no_name"));
});

test("importing the same list twice creates nothing the second time", () => {
  /* Spec acceptance criterion: "Importing the same list twice creates no
     duplicates with default settings." The default action on a match must be
     skip for this to hold. */
  const paste = [
    "Ahmad Faizal\t012-345 6789\tahmad@example.com",
    "Siti Nurhaliza\t011-2345 6789\tsiti@example.com",
  ].join("\n");

  const first = analyse(paste, { existing: [] });
  assert.strictEqual(first.summary.create, 2);

  /* Simulate what the first import wrote. */
  const existing = first.rows.map((row, i) => ({
    id: i + 1,
    name: row.values.name,
    email: row.values.email,
    phone: row.values.phone,
  }));

  const second = analyse(paste, { existing });
  assert.strictEqual(second.summary.create, 0, "second run must create nothing");
  assert.strictEqual(second.summary.duplicates, 2);
  assert.ok(second.rows.every((r) => r.action === "skip"), "default must be skip");
});

test("matching prefers phone, then email, then exact name", () => {
  const existing = [
    { id: 1, name: "Someone Else", email: "other@example.com", phone: "60123456789" },
    { id: 2, name: "Email Match", email: "match@example.com", phone: null },
    { id: 3, name: "Ahmad Faizal", email: null, phone: null },
  ];

  const byPhone = analyse("Whoever\t012-345 6789\tnobody@example.com", { existing });
  assert.strictEqual(byPhone.rows[0].matchedOn, "phone");
  assert.strictEqual(byPhone.rows[0].match.id, 1);

  const byEmail = analyse("Whoever\t\tmatch@example.com", { existing });
  assert.strictEqual(byEmail.rows[0].matchedOn, "email");
  assert.strictEqual(byEmail.rows[0].match.id, 2);

  const byName = analyse("Ahmad Faizal", { existing });
  assert.strictEqual(byName.rows[0].matchedOn, "name");
  assert.strictEqual(byName.rows[0].match.id, 3);
});

test("a number written differently still matches the stored client", () => {
  /* The reason normalisation happens BEFORE matching. "012-345 6789" and
     "+60123456789" are the same person, and a duplicate check on the raw text
     would create them twice. */
  const existing = [{ id: 1, name: "Ahmad", email: null, phone: "60123456789" }];
  const r = analyse("Ahmad Faizal\t+60 12-345 6789", { existing });
  assert.strictEqual(r.rows[0].status, "duplicate");
  assert.strictEqual(r.rows[0].matchedOn, "phone");
});

test("a list that repeats somebody flags the repeat", () => {
  const paste = [
    "Ahmad Faizal\t012-345 6789",
    "Ahmad F.\t012-345 6789",
  ].join("\n");
  const r = analyse(paste, { existing: [] });
  assert.strictEqual(r.rows[1].duplicateOfRow, 0);
  assert.ok(r.rows[1].warnings.some((w) => w.code === "duplicate_in_file"));
});

test("a landline is not told it has no phone number", () => {
  /* The warning used to branch on reachability first, so a client with a
     landline and no email — unreachable, but plainly in possession of a phone
     number — was told "No phone or email". Being told something you can see is
     untrue is how somebody stops reading warnings altogether. */
  const r = analyse("Pak Samad\t03-1234 5678");
  const row = r.rows[0];
  assert.strictEqual(row.values.phone, "60312345678");
  assert.strictEqual(row.reach.reachable, false);
  const message = row.warnings.map((w) => w.message).join(" ");
  assert.ok(/landline/i.test(message), `expected a landline warning, got "${message}"`);
  assert.ok(!/No phone or email/i.test(message), "must not claim there is no phone");
});

test("a repeat within the list defaults to skip, not create", () => {
  /* Only warning about it meant the list created the person twice, and the two
     new clients then matched each other — exactly the mess duplicate handling
     exists to prevent. */
  const paste = ["Ahmad Faizal\t012-345 6789", "Ahmad F\t012 345 6789"].join("\n");
  const r = analyse(paste, { existing: [] });
  assert.strictEqual(r.rows[1].status, "duplicate");
  assert.strictEqual(r.rows[1].action, "skip");
  assert.strictEqual(r.rows[1].match, null, "there is no existing client to point at");
  assert.strictEqual(r.summary.create, 1, "only the first occurrence is created");
});

test("an in-file repeat is caught on ANY shared identifier", () => {
  /* Row 1 carries a phone and an email; row 2 carries only the email. Indexing
     each row under a single key filed row 1 under its phone, so the email match
     was missed and the same person was created twice. */
  const paste = [
    "Ahmad Faizal\t012-345 6789\tahmad@example.com",
    "A. Faizal\t\tahmad@example.com",
  ].join("\n");
  const r = analyse(paste, { existing: [] });
  assert.strictEqual(r.rows[1].duplicateOfRow, 0);
  assert.ok(r.rows[1].warnings.some((w) => w.code === "duplicate_in_file"));
});

test("a name is never matched against a phone number", () => {
  /* The keys are namespaced, so a client literally named "60123456789" cannot
     collide with somebody's phone number. */
  const paste = ["60123456789\t\ta@example.com", "Ahmad\t012-345 6789\tb@example.com"].join("\n");
  const r = analyse(paste, { existing: [] });
  assert.strictEqual(r.rows[1].duplicateOfRow, null);
});

test("email is stored lowercased so matching is stable", () => {
  const r = analyse("Ahmad\t\tAhmad@Example.COM");
  assert.strictEqual(r.rows[0].values.email, "ahmad@example.com");
});

test("a user's mapping correction overrides detection", () => {
  const paste = "Ahmad Faizal\tKedai Kopi Ahmad";
  const auto = analyse(paste);
  assert.strictEqual(auto.mapping[1], "company");

  const corrected = analyse(paste, { mappingOverride: ["name", "notes"] });
  assert.strictEqual(corrected.rows[0].values.notes, "Kedai Kopi Ahmad");
  assert.strictEqual(corrected.rows[0].values.company, null);
});

test("an unknown field in a mapping override is ignored, not trusted", () => {
  const r = analyse("Ahmad\tsomething", { mappingOverride: ["name", "isAdmin"] });
  assert.deepStrictEqual(r.mapping, ["name", null]);
  assert.ok(!("isAdmin" in r.rows[0].values));
});

console.log("\nThe template\n");

test("the template is valid CSV that imports cleanly through the same code", () => {
  /* A template that the importer itself chokes on would be an embarrassing way
     to greet somebody's first use of the feature. */
  const csv = templateCsv();
  const r = analyse(csv);
  assert.strictEqual(r.hasHeader, true);
  assert.strictEqual(r.summary.problems, 0, "the template must have no problem rows");
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.rows[0].values.name, "Ahmad Faizal");
  assert.strictEqual(r.rows[0].values.phone, "60123456789");
  assert.strictEqual(r.rows[0].values.address, "12 Jalan Besar Kuala Lumpur");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
