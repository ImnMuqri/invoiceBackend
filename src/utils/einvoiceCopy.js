/**
 * The words for a scope-checker verdict, in English and Bahasa Malaysia
 * (spec 06).
 *
 * WHY THIS IS ON THE SERVER AND NOT IN THE NUXT APP
 *
 * The verdict is rendered in three places: the public page, the emailed copy,
 * and (potentially) whatever reads the API next. The spec requires that both
 * language versions "return identical logic and equivalent copy". If the page
 * held the prose and the mailer held its own, that requirement would be
 * something a reviewer has to verify by reading four prose branches and
 * hoping. Here there is one verdict, one set of sentences per locale, and the
 * page is a renderer.
 *
 * The split is principled, not arbitrary: anything that depends on the rules
 * lives on this side; page chrome that does not — headings, form labels,
 * button text — stays in the frontend where it belongs.
 *
 * NOTHING HERE MAY STATE A THRESHOLD, A DATE OR A PHASE AS A LITERAL. Every
 * such figure arrives interpolated from the verdict, which comes from
 * einvoiceRules.js. That is what makes "edit the config, the tool changes"
 * true all the way to the last sentence on the page.
 */

const { sen } = require("./invoiceMoney");
const { OUTCOME, REASON } = require("./einvoiceScope");

/* ── Formatting ───────────────────────────────────────────────────────────── */

/**
 * A threshold as people write it: "RM1,000,000".
 *
 * Built on sen() — the read boundary — rather than dividing by 100 here.
 * Thresholds are whole ringgit, so the cents are dropped after conversion,
 * never before.
 */
function ringgit(amountSen) {
  const [whole] = sen(amountSen).split(".");
  return `RM${Number(whole).toLocaleString("en-MY")}`;
}

const MONTHS = {
  en: ["January", "February", "March", "April", "May", "June",
       "July", "August", "September", "October", "November", "December"],
  ms: ["Januari", "Februari", "Mac", "April", "Mei", "Jun",
       "Julai", "Ogos", "September", "Oktober", "November", "Disember"],
};

/** "2026-01-01" -> "1 January 2026" / "1 Januari 2026". Both locales put the
 *  day first, so one shape serves both. */
function longDate(iso, locale) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[locale][m - 1]} ${y}`;
}

/** The turnover band as a phrase, from its own numbers. */
function bandPhrase(verdict, locale) {
  const { bandMinSen, bandMaxSen } = verdict;
  if (bandMinSen == null) return "";
  if (bandMaxSen == null) {
    return locale === "ms"
      ? `melebihi ${ringgit(bandMinSen)}`
      : `above ${ringgit(bandMinSen)}`;
  }
  return locale === "ms"
    ? `antara ${ringgit(bandMinSen)} dan ${ringgit(bandMaxSen)}`
    : `between ${ringgit(bandMinSen)} and ${ringgit(bandMaxSen)}`;
}

/** Interpolates {token} from a flat map. Missing tokens throw rather than
 *  render "{startDate}" onto a public page. */
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) {
      throw new Error(`einvoiceCopy: no value for {${key}}`);
    }
    return values[key];
  });
}

/* ── Strings ──────────────────────────────────────────────────────────────── */

const T = {
  en: {
    statusExempt: "Not required",
    statusInScope: "Required",
    statusUnknown: "Cannot be determined",

    exempt: {
      headline: "You appear to be exempt.",
      body: [
        "LHDN exempts businesses with an annual turnover or revenue of less than {threshold} from e-Invoice. On what you have told us, that is you: you are not required to issue e-Invoices through MyInvois.",
      ],
      position: "There is no phase date for you to prepare for while you stay under the threshold. If your turnover later crosses {threshold}, LHDN's concessionary implementation date of {concessionary} is the one that applies.",
      steps: [
        "Carry on invoicing as you do now. Nothing about how you bill has to change.",
        "If a client asks you for a validated e-Invoice, tell them you are under the exemption threshold. A buyer who is mandated can issue a self-billed e-Invoice covering the transaction.",
        "Keep an eye on your annual turnover. The exemption is the only thing keeping you out, so the year you cross {threshold} is the year to check this again.",
        "Confirm your own position with LHDN before you rely on it.",
      ],
    },

    inScope: {
      headline: "You appear to be in scope — Phase {phaseNumber}.",
      bodyStarted: "Businesses with an annual turnover {band} fall in Phase {phaseNumber} of LHDN's e-Invoice rollout, which began on {startDate}. That date has passed, so the requirement applies to you now.",
      bodyUpcoming: "Businesses with an annual turnover {band} fall in Phase {phaseNumber} of LHDN's e-Invoice rollout, which begins on {startDate}. You have until then to get ready.",
      relaxActive: "You are inside the interim relaxation period, which runs to {relaxEnd}. Until then LHDN accepts a consolidated e-Invoice in place of one per transaction.",
      relaxPast: "The interim relaxation period for Phase {phaseNumber} ended on {relaxEnd}, so the full requirement now applies.",
      relaxUpcoming: "An interim relaxation period runs from {startDate} to {relaxEnd}, during which a consolidated e-Invoice is accepted in place of one per transaction.",
      groupNote: "You have told us you are part of a larger group. A group's own turnover can place a member in an earlier phase than its own books suggest — every earlier phase has already begun, so this does not change the answer, but it is worth confirming which phase you are counted in.",
      steps: [
        "Register on the MyInvois portal and get your TIN and digital certificate in order.",
        "Decide how you will submit: by hand through the MyInvois portal, or through a provider with an API integration.",
        "InvoKita does not submit to MyInvois and does not make you compliant. Use it to send invoices and get paid; use MyInvois or a compliance provider for the submission itself.",
        "Confirm your phase and your date with LHDN.",
      ],
    },

    cannot: {
      headline: "We cannot determine this.",
      steps: [
        "Ask LHDN directly, or ask your tax agent. This is exactly the kind of question they answer.",
        "The MyInvois portal is the definitive source for your own position.",
      ],
      reasons: {
        TURNOVER_UNKNOWN: {
          body: "Which side of the {threshold} exemption threshold you fall on is the entire question, and without a turnover band there is nothing to answer from.",
          extraSteps: [
            "Find the figure first: it is the revenue in your FY{baseYear} audited accounts, or your FY{baseYear} tax return if your accounts are not audited. Then come back and run this again.",
          ],
        },
        BUSINESS_TYPE_OTHER: {
          body: "Co-operatives, associations, trust bodies and statutory bodies are treated separately in LHDN's guideline, and some persons are excluded from issuing e-Invoices whatever their turnover. This tool only covers sole proprietors and freelancers, partnerships, and Sdn Bhd.",
          extraSteps: [],
        },
        GROUP_STRUCTURE: {
          body: "On its own, your turnover is under the {threshold} exemption threshold. But you have told us you are a subsidiary, associate or related company of a larger group, and how a group member is assessed can depend on the group rather than on its own books. That is not a call four dropdowns get to make.",
          extraSteps: [
            "Ask whoever handles tax for the group which phase the group is in, and whether you are counted inside it.",
          ],
        },
        RECENT_START: {
          body: "LHDN fixes your band from your FY{baseYear} figures, and you started operating in {startYear}, so you do not have them. Businesses that started later are placed by a different rule, and this tool does not guess at it.",
          indicative: "For reference only: a business with an annual turnover {band} and FY{baseYear} accounts would fall in Phase {phaseNumber}, from {startDate}. Treat that as a signpost, not as your answer.",
          extraSteps: [],
        },
        BAND_UNMAPPED: {
          body: "Your answers do not map onto LHDN's published bands cleanly enough for us to give you a phase.",
          extraSteps: [],
        },
      },
    },

    disclaimerTitle: "This is guidance, not advice",
    disclaimer: "This is a reading of LHDN's published timeline applied to four answers. It does not know your circumstances and it is not a determination of your legal position. Confirm with LHDN before you act on it.",
    reviewedLabel: "Rule set last reviewed {reviewedOn}",
    portalLabel: "Check with LHDN on MyInvois",
    nextTitle: "What to do next",
  },

  ms: {
    statusExempt: "Tidak diwajibkan",
    statusInScope: "Diwajibkan",
    statusUnknown: "Tidak dapat ditentukan",

    exempt: {
      headline: "Anda nampaknya dikecualikan.",
      body: [
        "LHDN mengecualikan perniagaan dengan pendapatan atau jualan tahunan kurang daripada {threshold} daripada e-Invois. Berdasarkan jawapan anda, itulah kedudukan anda: anda tidak diwajibkan mengeluarkan e-Invois melalui MyInvois.",
      ],
      position: "Tiada tarikh fasa yang anda perlu bersedia untuk selagi anda kekal di bawah ambang ini. Kalau jualan tahunan anda melepasi {threshold} kemudian, tarikh pelaksanaan konsesi LHDN iaitu {concessionary} yang terpakai.",
      steps: [
        "Teruskan hantar invois macam biasa. Tiada apa dalam cara anda bil yang perlu berubah.",
        "Kalau pelanggan minta e-Invois yang disahkan, beritahu mereka anda di bawah ambang pengecualian. Pembeli yang diwajibkan boleh keluarkan e-Invois bil sendiri (self-billed) untuk transaksi itu.",
        "Pantau jualan tahunan anda. Pengecualian ini sahaja yang menjadikan anda terkecuali, jadi tahun anda melepasi {threshold} adalah tahun untuk semak semula.",
        "Sahkan kedudukan anda sendiri dengan LHDN sebelum bergantung padanya.",
      ],
    },

    inScope: {
      headline: "Anda nampaknya termasuk dalam skop — Fasa {phaseNumber}.",
      bodyStarted: "Perniagaan dengan jualan tahunan {band} termasuk dalam Fasa {phaseNumber} pelaksanaan e-Invois LHDN, yang bermula pada {startDate}. Tarikh itu sudah berlalu, jadi keperluan ini terpakai kepada anda sekarang.",
      bodyUpcoming: "Perniagaan dengan jualan tahunan {band} termasuk dalam Fasa {phaseNumber} pelaksanaan e-Invois LHDN, yang bermula pada {startDate}. Anda ada masa sehingga tarikh itu untuk bersedia.",
      relaxActive: "Anda berada dalam tempoh kelonggaran interim, yang berjalan sehingga {relaxEnd}. Sehingga itu LHDN menerima e-Invois konsolidasi menggantikan satu e-Invois bagi setiap transaksi.",
      relaxPast: "Tempoh kelonggaran interim bagi Fasa {phaseNumber} tamat pada {relaxEnd}, jadi keperluan penuh terpakai sekarang.",
      relaxUpcoming: "Tempoh kelonggaran interim berjalan dari {startDate} hingga {relaxEnd}, dan sepanjang tempoh itu e-Invois konsolidasi diterima menggantikan satu e-Invois bagi setiap transaksi.",
      groupNote: "Anda beritahu yang anda sebahagian daripada kumpulan yang lebih besar. Jualan kumpulan boleh meletakkan ahlinya dalam fasa yang lebih awal daripada apa yang akaun sendiri tunjukkan — semua fasa terdahulu sudah pun bermula, jadi ini tak mengubah jawapan, tetapi elok disahkan anda dikira dalam fasa yang mana.",
      steps: [
        "Daftar di portal MyInvois dan pastikan TIN serta sijil digital anda teratur.",
        "Tentukan cara anda akan hantar: manual melalui portal MyInvois, atau melalui penyedia dengan integrasi API.",
        "InvoKita tidak menghantar ke MyInvois dan tidak menjadikan anda patuh. Guna InvoKita untuk hantar invois dan dapat bayaran; guna MyInvois atau penyedia pematuhan untuk penghantaran itu sendiri.",
        "Sahkan fasa dan tarikh anda dengan LHDN.",
      ],
    },

    cannot: {
      headline: "Kami tidak dapat tentukan.",
      steps: [
        "Tanya LHDN terus, atau tanya ejen cukai anda. Ini memang soalan yang mereka jawab.",
        "Portal MyInvois adalah sumber muktamad untuk kedudukan anda sendiri.",
      ],
      reasons: {
        TURNOVER_UNKNOWN: {
          body: "Sebelah mana ambang pengecualian {threshold} anda berada itulah soalannya, dan tanpa julat jualan tahunan tiada apa yang boleh dijawab.",
          extraSteps: [
            "Cari angka itu dahulu: ia adalah pendapatan dalam akaun beraudit TK{baseYear} anda, atau borang cukai TK{baseYear} kalau akaun anda tidak diaudit. Kemudian datang semula dan cuba lagi.",
          ],
        },
        BUSINESS_TYPE_OTHER: {
          body: "Koperasi, persatuan, badan amanah dan badan berkanun dikendalikan secara berasingan dalam garis panduan LHDN, dan sesetengah pihak dikecualikan daripada mengeluarkan e-Invois tanpa mengira jualan. Alat ini hanya meliputi pemilik tunggal dan pekerja bebas, perkongsian, dan Sdn Bhd.",
          extraSteps: [],
        },
        GROUP_STRUCTURE: {
          body: "Secara sendiri, jualan anda di bawah ambang pengecualian {threshold}. Tetapi anda beritahu yang anda subsidiari, syarikat sekutu atau syarikat berkaitan dalam kumpulan yang lebih besar, dan cara ahli kumpulan dinilai boleh bergantung pada kumpulan itu, bukan pada akaun sendiri. Itu bukan keputusan yang empat kotak pilihan boleh buat.",
          extraSteps: [
            "Tanya sesiapa yang uruskan cukai kumpulan anda, kumpulan itu dalam fasa mana dan sama ada anda dikira di dalamnya.",
          ],
        },
        RECENT_START: {
          body: "LHDN menetapkan julat anda berdasarkan angka TK{baseYear}, dan anda mula beroperasi pada {startYear}, jadi angka itu tiada. Perniagaan yang mula kemudian diletakkan mengikut peraturan lain, dan alat ini tidak meneka peraturan itu.",
          indicative: "Sebagai rujukan sahaja: perniagaan dengan jualan tahunan {band} dan akaun TK{baseYear} akan termasuk dalam Fasa {phaseNumber}, mulai {startDate}. Anggap itu sebagai papan tanda, bukan jawapan anda.",
          extraSteps: [],
        },
        BAND_UNMAPPED: {
          body: "Jawapan anda tidak dapat dipadankan dengan julat rasmi LHDN dengan cukup jelas untuk kami berikan satu fasa.",
          extraSteps: [],
        },
      },
    },

    disclaimerTitle: "Ini panduan, bukan nasihat",
    disclaimer: "Ini adalah bacaan garis masa rasmi LHDN yang digunakan pada empat jawapan. Ia tidak tahu keadaan sebenar anda dan ia bukan penentuan kedudukan undang-undang anda. Sahkan dengan LHDN sebelum anda bertindak atasnya.",
    reviewedLabel: "Set peraturan disemak kali terakhir pada {reviewedOn}",
    portalLabel: "Semak dengan LHDN di MyInvois",
    nextTitle: "Apa yang perlu dibuat seterusnya",
  },
};

/* ── Rendering ────────────────────────────────────────────────────────────── */

/**
 * Turn a verdict into the sentences a reader sees, in one locale.
 *
 * Returns a flat, render-ready shape — status, headline, paragraphs, steps,
 * disclaimer — so that a page, an email and a screenshot all show the same
 * thing in the same order. The order is the spec's: the answer, the position,
 * what to do next, then the disclaimer and the review date.
 */
function renderVerdict(verdict, locale = "en") {
  const t = T[locale] || T.en;
  const paragraphs = [];
  let status;
  let headline;
  let steps;

  /* Every token any template might reach for. Assembled once so a template
     edit cannot silently depend on a value that was never computed. */
  const v = {
    threshold: verdict.exemptionThresholdSen != null ? ringgit(verdict.exemptionThresholdSen) : "",
    concessionary: longDate(verdict.concessionaryDate, locale),
    baseYear: verdict.baseFinancialYear ?? "",
    startYear: verdict.input?.startYear ?? "",
    reviewedOn: longDate(verdict.reviewedOn, locale),
  };

  if (verdict.outcome === OUTCOME.EXEMPT) {
    status = t.statusExempt;
    headline = t.exempt.headline;
    t.exempt.body.forEach((p) => paragraphs.push(fill(p, v)));
    paragraphs.push(fill(t.exempt.position, v));
    steps = t.exempt.steps.map((s) => fill(s, v));
  } else if (verdict.outcome === OUTCOME.IN_SCOPE) {
    const f = {
      ...v,
      phaseNumber: verdict.phaseNumber,
      band: bandPhrase(verdict, locale),
      startDate: longDate(verdict.startDate, locale),
      relaxEnd: longDate(verdict.relaxationEndDate, locale),
    };
    status = t.statusInScope;
    headline = fill(t.inScope.headline, f);
    paragraphs.push(fill(verdict.hasStarted ? t.inScope.bodyStarted : t.inScope.bodyUpcoming, f));

    if (verdict.relaxationEndDate) {
      const relax = verdict.relaxationActive
        ? t.inScope.relaxActive
        : verdict.hasStarted
          ? t.inScope.relaxPast
          : t.inScope.relaxUpcoming;
      paragraphs.push(fill(relax, f));
    }
    if (verdict.groupNote) paragraphs.push(fill(t.inScope.groupNote, f));

    steps = t.inScope.steps.map((s) => fill(s, f));
  } else {
    /* Cannot determine. The reason carries its own paragraph and may add its
       own next steps ahead of the two that always apply. */
    const reason = t.cannot.reasons[verdict.reason] || t.cannot.reasons[REASON.BAND_UNMAPPED];
    const ind = verdict.indicative || {};
    const f = {
      ...v,
      phaseNumber: ind.phaseNumber ?? "",
      band: bandPhrase(ind, locale),
      startDate: longDate(ind.startDate, locale),
    };

    status = t.statusUnknown;
    headline = t.cannot.headline;
    paragraphs.push(fill(reason.body, f));
    if (reason.indicative && ind.phase) paragraphs.push(fill(reason.indicative, f));

    steps = [...reason.extraSteps.map((s) => fill(s, f)), ...t.cannot.steps.map((s) => fill(s, f))];
  }

  return {
    locale,
    status,
    headline,
    paragraphs,
    nextTitle: t.nextTitle,
    steps,
    disclaimerTitle: t.disclaimerTitle,
    disclaimer: t.disclaimer,
    reviewedLabel: fill(t.reviewedLabel, v),
    portalLabel: t.portalLabel,
  };
}

module.exports = { renderVerdict, ringgit, longDate, LOCALES: Object.keys(T) };
