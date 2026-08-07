/**
 * Client import: parsing, column detection and duplicate matching (spec 08).
 *
 * Everything in this file is PURE — text in, structured result out, no database
 * and no request. That is what lets the preview and the commit reach identical
 * conclusions: the commit re-runs the same functions over the same input rather
 * than trusting what the browser sends back, so a user cannot be shown one
 * thing and have another written.
 *
 * SCOPE DISCIPLINE. The spec says this is deliberately small and must not
 * become a migration tool. There is no invoice history here, no third-party
 * format, no sync. It reads a list of people and stops.
 *
 * The design bias throughout: a row the user has to look at is cheap, a row
 * imported wrongly is expensive. Anything uncertain is surfaced, never guessed.
 */

const { normalisePhone, deliverability } = require("./phoneNormalise");

/* The fields a row can carry. Order matters — it is the column order of the
   downloadable template and the default left-to-right mapping guess. */
const FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "phone", label: "Phone", required: false },
  { key: "email", label: "Email", required: false },
  { key: "company", label: "Company", required: false },
  { key: "address", label: "Address", required: false },
  { key: "registrationNumber", label: "Registration No.", required: false },
  { key: "tin", label: "TIN", required: false },
  { key: "notes", label: "Notes", required: false },
];

const FIELD_KEYS = FIELDS.map((f) => f.key);

/* Header names people actually use, per field. Matched case- and
   punctuation-insensitively, so "Client Name", "client_name" and "CLIENT NAME"
   are the same thing. Malay included because half the spreadsheets in this
   market are written in it and a header the product cannot read is a mapping
   step the user has to do by hand. */
const HEADER_ALIASES = {
  name: [
    "name", "clientname", "customername", "contactname", "fullname", "client",
    "customer", "contact", "nama", "namaklien", "namapelanggan", "pelanggan",
  ],
  phone: [
    "phone", "phonenumber", "mobile", "mobilenumber", "tel", "telephone",
    "telno", "hp", "handphone", "whatsapp", "wa", "contactnumber", "number",
    "telefon", "notelefon", "notel", "nombortelefon", "nohp",
  ],
  email: ["email", "emailaddress", "mail", "eresult", "emel", "alamatemel"],
  company: [
    "company", "companyname", "business", "businessname", "organisation",
    "organization", "org", "syarikat", "namasyarikat", "perniagaan",
  ],
  address: ["address", "billingaddress", "location", "alamat", "alamatbil"],
  registrationNumber: [
    "registrationnumber", "regno", "registrationno", "companyregistration",
    "ssm", "ssmnumber", "nopendaftaran", "nodaftar",
  ],
  tin: ["tin", "taxid", "taxidentificationnumber", "tinnumber", "nocukai", "notin"],
  notes: ["notes", "note", "remarks", "remark", "comment", "comments", "catatan", "nota"],
};

/** Lowercase, strip everything that is not a letter or digit. */
const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ─────────────────────────────────────────────────────────────────────────
   Parsing
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Which delimiter is this text using?
 *
 * Decided on the FIRST NON-EMPTY LINE by counting candidates, with tab winning
 * ties. Tab first because anything pasted out of Excel, Sheets or Numbers is
 * tab separated, and that is the path the spec says matters most — it needs no
 * export step from wherever the list currently lives.
 *
 * A single column with no delimiter at all is a legitimate answer: a list of
 * names, one per line, is a real thing people paste.
 */
function detectDelimiter(text) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .find((l) => l.trim() !== "");
  if (!line) return "\t";

  const counts = {
    "\t": (line.match(/\t/g) || []).length,
    ",": (line.match(/,/g) || []).length,
    ";": (line.match(/;/g) || []).length,
  };

  if (counts["\t"] > 0) return "\t";
  if (counts[";"] > counts[","]) return ";";
  if (counts[","] > 0) return ",";
  return "\t";
}

/**
 * Split delimited text into a grid, honouring quoted fields.
 *
 * Hand-written rather than pulled from npm because the rules that matter are
 * few and the failure mode of getting them wrong is visible: a quoted field can
 * contain the delimiter, a newline, and a doubled quote meaning a literal one.
 * That is RFC 4180, and it is the difference between an address column working
 * and every row after the first address being shifted by one.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  const src = String(text ?? "").replace(/\r\n?/g, "\n");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }

  /* Whatever is left when the input runs out is the last field of the last
     row — text pasted from a textarea rarely ends in a newline. */
  row.push(field);
  rows.push(row);

  /* Blank lines are not data. Somebody's spreadsheet has a spacer row in it. */
  return rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ""));
}

/**
 * Does the first row name the columns rather than hold data?
 *
 * Two independent signals, and both have to be reasonable:
 *   - at least one cell matches a known header alias, and
 *   - no cell looks like actual data (an email address or a phone number)
 *
 * The second is what stops "Ahmad<TAB>012-3456789" being read as a header just
 * because somebody's client happens to be called something header-ish. Getting
 * this wrong eats a real client silently, which is exactly the class of failure
 * this module is built to avoid.
 */
function looksLikeHeader(row) {
  if (!row || !row.length) return false;

  const known = row.some((cell) => {
    const s = slug(cell);
    return s && Object.values(HEADER_ALIASES).some((list) => list.includes(s));
  });
  if (!known) return false;

  const dataish = row.some((cell) => {
    const v = String(cell).trim();
    if (!v) return false;
    if (EMAIL_RE.test(v)) return true;
    /* Six or more digits in a cell is data, not a column name. */
    return (v.match(/\d/g) || []).length >= 6;
  });

  return !dataish;
}

/* ─────────────────────────────────────────────────────────────────────────
   Column detection
   ───────────────────────────────────────────────────────────────────────── */

/** How strongly does this column look like emails? 0..1 */
function emailScore(values) {
  const filled = values.filter((v) => v !== "");
  if (!filled.length) return 0;
  return filled.filter((v) => EMAIL_RE.test(v)).length / filled.length;
}

/** How strongly does this column look like phone numbers that PARSE? 0..1 */
function phoneScore(values) {
  const filled = values.filter((v) => v !== "");
  if (!filled.length) return 0;
  return filled.filter((v) => normalisePhone(v).ok).length / filled.length;
}

/**
 * How strongly does this column look like it is TRYING to be phone numbers? 0..1
 *
 * Shape only — digits and the punctuation people put between them — with no
 * requirement that the number actually validates.
 *
 * This exists because scoring on parse success alone had a silent failure that
 * is exactly the one the spec warns about. A column whose numbers are all
 * malformed (a whole list typed with a missing digit, or exported with a stray
 * character) scores zero, so it is not recognised as the phone column at all,
 * so it is dropped — and the user imports their entire client list with no
 * phone numbers and nothing on screen saying so. Recognising the column by
 * shape means every one of those rows is flagged as a problem instead, which is
 * the whole point: a row the user has to look at is cheap, a client silently
 * missing their phone number is not.
 */
function phoneShapeScore(values) {
  const filled = values.filter((v) => v !== "");
  if (!filled.length) return 0;
  return (
    filled.filter((v) => {
      if (!/^[+\d\s\-().]+$/.test(v)) return false;
      return (v.match(/\d/g) || []).length >= 5;
    }).length / filled.length
  );
}

/**
 * How strongly does this column look like people's names? 0..1
 *
 * Names are defined by what they are NOT — not an email, not a number — because
 * there is no positive test for a name that survives contact with Malaysian,
 * Chinese and Tamil naming all at once. Anything letter-bearing and free of
 * digits counts.
 */
function nameScore(values) {
  const filled = values.filter((v) => v !== "");
  if (!filled.length) return 0;
  const namey = filled.filter(
    (v) => !EMAIL_RE.test(v) && /\p{L}/u.test(v) && (v.match(/\d/g) || []).length < 4,
  ).length;
  return namey / filled.length;
}

/**
 * Work out which column is which.
 *
 * Header names win when there is a header, because the user has already told
 * us. Without one — or for columns the header did not identify — the content is
 * sniffed. Confident columns (email, phone) are claimed first and the leftmost
 * remaining name-shaped column becomes the name, which is what makes the common
 * paste of "name, phone, email" map correctly with nothing for the user to fix.
 *
 * Returns an array the same length as the widest row: field key, or null for
 * "ignore this column".
 */
function detectColumns(grid, hasHeader) {
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const mapping = new Array(width).fill(null);
  const taken = new Set();

  const claim = (index, key) => {
    if (index < 0 || index >= width) return;
    if (mapping[index] || taken.has(key)) return;
    mapping[index] = key;
    taken.add(key);
  };

  /* ── 1. Header names ──────────────────────────────────────────────────── */
  if (hasHeader) {
    const header = grid[0] || [];
    for (let i = 0; i < width; i++) {
      const s = slug(header[i]);
      if (!s) continue;
      const hit = FIELD_KEYS.find((key) => HEADER_ALIASES[key].includes(s));
      if (hit) claim(i, hit);
    }
  }

  /* ── 2. Content sniffing for whatever is still unassigned ─────────────── */
  const body = hasHeader ? grid.slice(1) : grid;
  const columnValues = (i) => body.map((r) => (r[i] ?? "").trim());

  const scores = [];
  for (let i = 0; i < width; i++) {
    if (mapping[i]) continue;
    const values = columnValues(i);
    scores.push({
      i,
      email: emailScore(values),
      phone: phoneScore(values),
      phoneShape: phoneShapeScore(values),
      name: nameScore(values),
    });
  }

  /* Email first: an address is the least ambiguous thing in the grid, and a
     column of them cannot be anything else. */
  const bestEmail = scores
    .filter((s) => s.email >= 0.6)
    .sort((a, b) => b.email - a.email)[0];
  if (bestEmail) claim(bestEmail.i, "email");

  /* Then phone, on EITHER signal.
     The threshold on parsed numbers is deliberately below 1, because a real
     list has one number in it that will not parse and that row should be
     flagged rather than costing the whole column its identity. The shape
     fallback goes further: a column where NOTHING parses is still obviously a
     phone column, and claiming it means those rows surface as problems instead
     of being dropped without a word. */
  const bestPhone = scores
    .filter((s) => s.i !== bestEmail?.i && (s.phone >= 0.5 || s.phoneShape >= 0.6))
    .sort((a, b) => b.phone - a.phone || b.phoneShape - a.phoneShape)[0];
  if (bestPhone) claim(bestPhone.i, "phone");

  /* Then the leftmost name-shaped column. Leftmost rather than
     highest-scoring: in a "name, company" list both columns score alike, and
     the name is on the left in every spreadsheet anyone has ever made. */
  if (!taken.has("name")) {
    const nameCol = scores
      .filter((s) => !mapping[s.i] && s.name >= 0.5)
      .sort((a, b) => a.i - b.i)[0];
    if (nameCol) claim(nameCol.i, "name");
  }

  /* A second name-shaped column, to the right of the name, is nearly always the
     company. Claimed only when the name is settled, so a two-column
     "name, company" paste comes out right without the user touching it. */
  if (taken.has("name") && !taken.has("company")) {
    const nameIndex = mapping.indexOf("name");
    const companyCol = scores
      .filter((s) => !mapping[s.i] && s.i > nameIndex && s.name >= 0.5)
      .sort((a, b) => a.i - b.i)[0];
    if (companyCol) claim(companyCol.i, "company");
  }

  return mapping;
}

/* ─────────────────────────────────────────────────────────────────────────
   Row building
   ───────────────────────────────────────────────────────────────────────── */

/** Problems that make a row unimportable, versus things merely worth saying. */
const ISSUE = {
  NO_NAME: "no_name",
  BAD_PHONE: "bad_phone",
  BAD_EMAIL: "bad_email",
  NO_CONTACT: "no_contact",
  DUPLICATE_IN_FILE: "duplicate_in_file",
};

/**
 * Turn the grid into rows ready for preview.
 *
 * `existing` is the caller's current clients, already loaded — matching happens
 * in memory against a list rather than as a query per row, because a 200-row
 * paste would otherwise be 600 round trips.
 *
 * Every row comes back with a `status`:
 *   create    — new, importable
 *   duplicate — matched an existing client; `action` defaults to skip
 *   problem   — cannot be imported as-is; `issues` says why
 *
 * and `warnings`, which never block: a row can be perfectly importable and
 * still worth a word, and the clearest example is the client with a name and no
 * way to reach them.
 */
function buildRows(grid, mapping, { hasHeader, existing = [] } = {}) {
  const body = hasHeader ? grid.slice(1) : grid;

  /* Indexed once. Phone first, then email, then exact name — the spec's
     precedence, and it is the right one: a phone number is the most reliably
     unique thing on the list and a name is the least. */
  const byPhone = new Map();
  const byEmail = new Map();
  const byName = new Map();
  for (const c of existing) {
    if (c.phone) byPhone.set(String(c.phone), c);
    if (c.email) byEmail.set(String(c.email).toLowerCase(), c);
    if (c.name) byName.set(String(c.name).trim().toLowerCase(), c);
  }

  /* Rows already seen in THIS paste, so a list that repeats somebody does not
     quietly create them twice.
     ONE map keyed by every identifier a row carries, rather than one map per
     identifier type. Three separate maps looked tidier and missed the obvious
     case: a row with a phone and an email was filed under its phone only, so
     the same person appearing later with just their email was not recognised
     as a repeat. Whichever identifier they share is enough. */
  const seen = new Map();

  return body.map((cells, index) => {
    const raw = {};
    mapping.forEach((key, i) => {
      if (key) raw[key] = (cells[i] ?? "").trim();
    });

    const issues = [];
    const warnings = [];

    const name = (raw.name || "").trim();
    if (!name) issues.push({ code: ISSUE.NO_NAME, message: "No name in this row" });

    /* ── Phone ─────────────────────────────────────────────────────────── */
    let phone = null;
    let phoneKind = null;
    if (raw.phone) {
      const result = normalisePhone(raw.phone);
      if (result.ok) {
        phone = result.value;
        phoneKind = result.kind;
      } else {
        /* A refusal, NOT a silent drop. The spec is explicit: a broken phone
           number surfaces later as a WhatsApp message that never arrives, which
           is far worse than a row rejected at import. */
        issues.push({
          code: ISSUE.BAD_PHONE,
          message: result.detail
            ? `Phone "${raw.phone}" — ${result.detail}`
            : `Phone "${raw.phone}" could not be read`,
        });
      }
    }

    /* ── Email ─────────────────────────────────────────────────────────── */
    let email = null;
    if (raw.email) {
      const candidate = raw.email.trim().toLowerCase();
      if (EMAIL_RE.test(candidate)) email = candidate;
      else {
        issues.push({
          code: ISSUE.BAD_EMAIL,
          message: `"${raw.email}" is not an email address`,
        });
      }
    }

    /* ── Reachability ──────────────────────────────────────────────────────
       A WARNING, never an issue. The spec asks for an unreachable row to be
       flagged as unusable for delivery and still importable if the user
       chooses — you genuinely might want somebody on file before you have
       their details.

       The message is chosen by what the row actually HAS. An earlier version
       branched on `reachable` first, which meant a client with a landline and
       no email — unreachable, but obviously in possession of a phone number —
       was told "No phone or email". Being told something you can see is untrue
       is how a user stops reading warnings altogether. */
    const reach = deliverability({ phone, phoneKind, email });
    if (!reach.reachable && !issues.length) {
      if (!phone && !email) {
        warnings.push({
          code: ISSUE.NO_CONTACT,
          message: "No phone or email — you will not be able to send to them yet",
        });
      } else if (phoneKind === "my_landline") {
        warnings.push({
          code: ISSUE.NO_CONTACT,
          message:
            "That is a landline, so WhatsApp will not reach them — add an email too",
        });
      } else {
        warnings.push({
          code: ISSUE.NO_CONTACT,
          message: "Nothing here can receive a message yet",
        });
      }
    }

    /* ── Duplicates ────────────────────────────────────────────────────── */
    let match = null;
    let matchedOn = null;
    if (phone && byPhone.has(phone)) {
      match = byPhone.get(phone);
      matchedOn = "phone";
    } else if (email && byEmail.has(email)) {
      match = byEmail.get(email);
      matchedOn = "email";
    } else if (name && byName.has(name.toLowerCase())) {
      match = byName.get(name.toLowerCase());
      matchedOn = "name";
    }

    /* Repeats inside this same paste. Reported separately from an existing
       client because the fix is different — one is "you already have them",
       the other is "your list has them twice". */
    let dupeOfRow = null;
    if (!match) {
      /* Every identifier this row carries, each namespaced so a name can never
         collide with a phone number. Matching on ANY of them catches the same
         person written down twice with different details filled in. */
      const keys = [
        phone ? `phone:${phone}` : null,
        email ? `email:${email}` : null,
        name ? `name:${name.toLowerCase()}` : null,
      ].filter(Boolean);

      const hit = keys.find((k) => seen.has(k));
      if (hit !== undefined) {
        dupeOfRow = seen.get(hit);
        warnings.push({
          code: ISSUE.DUPLICATE_IN_FILE,
          message: `Same as row ${dupeOfRow + 1} in this list`,
        });
      }
      /* Recorded under all of its keys either way, so a third occurrence is
         still caught however it is written. */
      for (const k of keys) if (!seen.has(k)) seen.set(k, index);
    }

    const importable = issues.length === 0 && !!name;

    return {
      index,
      raw,
      values: {
        name,
        phone,
        email,
        company: raw.company || null,
        address: raw.address || null,
        registrationNumber: raw.registrationNumber || null,
        tin: raw.tin || null,
        notes: raw.notes || null,
      },
      phoneKind,
      reach,
      issues,
      warnings,
      match: match
        ? { id: match.id, name: match.name, email: match.email, phone: match.phone }
        : null,
      matchedOn,
      duplicateOfRow: dupeOfRow,
      /* A repeat WITHIN the list counts as a duplicate too.
         It used to be only a warning, so a list containing somebody twice
         created them twice — and the two new clients then matched each other,
         which is precisely the mess the duplicate handling exists to prevent.
         The user can still choose to add it, exactly as with a match against an
         existing client. */
      status: !importable ? "problem" : match || dupeOfRow !== null ? "duplicate" : "create",
      /* Default to SKIP on any duplicate, per the spec. Importing the same list
         twice must create nothing, and that only holds if the default is the
         safe one — a default of "update" would silently rewrite records the
         user had edited by hand since. */
      action: !importable ? "skip" : match || dupeOfRow !== null ? "skip" : "create",
    };
  });
}

/** Counts for the summary line above the preview table. */
function summarise(rows) {
  return {
    total: rows.length,
    create: rows.filter((r) => r.action === "create").length,
    update: rows.filter((r) => r.action === "update").length,
    skip: rows.filter((r) => r.action === "skip").length,
    problems: rows.filter((r) => r.status === "problem").length,
    duplicates: rows.filter((r) => r.status === "duplicate").length,
    unreachable: rows.filter((r) => !r.reach.reachable && r.status !== "problem").length,
  };
}

/**
 * The whole read side, in one call: text → mapping → rows → counts.
 *
 * The preview endpoint and the commit endpoint both go through here, which is
 * what guarantees they agree. `mappingOverride` is how the user's corrections
 * come back in — the same function, told which columns are which.
 */
function analyse(text, { mappingOverride = null, hasHeaderOverride = null, existing = [] } = {}) {
  const delimiter = detectDelimiter(text);
  const grid = parseDelimited(text, delimiter);

  if (!grid.length) {
    return {
      delimiter,
      hasHeader: false,
      columns: [],
      mapping: [],
      rows: [],
      summary: summarise([]),
    };
  }

  const hasHeader =
    hasHeaderOverride === null ? looksLikeHeader(grid[0]) : !!hasHeaderOverride;

  const mapping =
    mappingOverride && mappingOverride.length
      ? mappingOverride.map((k) => (FIELD_KEYS.includes(k) ? k : null))
      : detectColumns(grid, hasHeader);

  const rows = buildRows(grid, mapping, { hasHeader, existing });

  /* A sample of each column, so the mapping step can show the user what is
     actually in the column they are being asked to name. Two values is enough
     to recognise a column and short enough not to wrap. */
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const body = hasHeader ? grid.slice(1) : grid;
  const columns = Array.from({ length: width }, (_, i) => ({
    index: i,
    header: hasHeader ? (grid[0][i] || "").trim() : "",
    sample: body
      .map((r) => (r[i] ?? "").trim())
      .filter((v) => v !== "")
      .slice(0, 2),
    field: mapping[i] || null,
  }));

  return { delimiter, hasHeader, columns, mapping, rows, summary: summarise(rows) };
}

/** The downloadable template. Offered, never required. */
function templateCsv() {
  const header = FIELDS.map((f) => f.label).join(",");
  const example = [
    "Ahmad Faizal,012-345 6789,ahmad@example.com,Kedai Kopi Ahmad,12 Jalan Besar Kuala Lumpur,202301012345,C12345678900,Pays on time",
    "Siti Nurhaliza,+60 11-2345 6789,siti@example.com,Siti Design Studio,,,,",
  ];
  return `${header}\n${example.join("\n")}\n`;
}

module.exports = {
  FIELDS,
  FIELD_KEYS,
  ISSUE,
  detectDelimiter,
  parseDelimited,
  looksLikeHeader,
  detectColumns,
  buildRows,
  summarise,
  analyse,
  templateCsv,
};
