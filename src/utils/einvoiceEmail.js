/**
 * The emailed copy of a scope-checker result (spec 06).
 *
 * Renders the SAME verdict object the page renders, through the same
 * einvoiceCopy strings. Nothing in here decides anything: if this file and the
 * page ever disagree, it is a rendering bug, not a rules bug, because there is
 * only one place rules live.
 *
 * Kept deliberately plain. The result has to survive being forwarded, printed
 * and read on a phone in a WhatsApp-sized preview, so: one column, no images,
 * no web fonts, and the disclaimer above the fold rather than in a footer
 * nobody reads.
 */

const SUBJECTS = {
  en: "Your LHDN e-Invoice scope result",
  ms: "Keputusan skop e-Invois LHDN anda",
};

const LABELS = {
  en: {
    intro: "Here is the result you asked us to send. It is the same answer that was on screen.",
    checkAgain: "Run the check again",
    footer: "Sent by InvoKita because someone entered this address on our e-Invoice scope checker. We did not create an account and we will not email you again about this.",
  },
  ms: {
    intro: "Ini keputusan yang anda minta kami hantar. Ia jawapan yang sama seperti di skrin tadi.",
    checkAgain: "Buat semakan sekali lagi",
    footer: "Dihantar oleh InvoKita kerana seseorang memasukkan alamat ini di penyemak skop e-Invois kami. Kami tidak membuka akaun dan kami tidak akan emel anda lagi tentang perkara ini.",
  },
};

/** Colour per outcome, so the verdict reads before the words do. */
const TONE = {
  EXEMPT: { fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0" },
  IN_SCOPE: { fg: "#b45309", bg: "#fffbeb", border: "#fde68a" },
  CANNOT_DETERMINE: { fg: "#475569", bg: "#f8fafc", border: "#e2e8f0" },
};

/* Everything here is our own copy, not user input — but escaping by default
   costs nothing and means a future edit that does interpolate something is
   not a stored-XSS bug waiting for a reviewer to notice. */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Where the tool lives, per locale. Mirrors the Nuxt routes. */
function checkerUrl(locale) {
  const base = (process.env.FRONTEND_URL || "https://invokita.my").replace(/\/$/, "");
  return locale === "ms" ? `${base}/ms/e-invoice-check/` : `${base}/e-invoice-check`;
}

/**
 * @param {object} rendered  the output of renderVerdict()
 * @param {object} verdict   the raw verdict, for the outcome colour
 */
function getScopeResultEmail(rendered, verdict) {
  const locale = rendered.locale === "ms" ? "ms" : "en";
  const l = LABELS[locale];
  const tone = TONE[verdict.outcome] || TONE.CANNOT_DETERMINE;
  const url = checkerUrl(locale);

  const html = `<!DOCTYPE html>
<html lang="${locale === "ms" ? "ms-MY" : "en-MY"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(SUBJECTS[locale])}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px;">

    <p style="margin:0 0 24px;font-size:20px;font-weight:800;letter-spacing:-0.02em;color:#0f172a;">InvoKita</p>

    <div style="background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px;">

      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">${esc(l.intro)}</p>

      <div style="background-color:${tone.bg};border:1px solid ${tone.border};border-radius:12px;padding:20px;margin-bottom:24px;">
        <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${tone.fg};">${esc(rendered.status)}</p>
        <p style="margin:0;font-size:19px;font-weight:700;line-height:1.35;letter-spacing:-0.01em;color:#0f172a;">${esc(rendered.headline)}</p>
      </div>

      ${rendered.paragraphs
        .map(
          (p) =>
            `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#334155;">${esc(p)}</p>`
        )
        .join("\n      ")}

      <p style="margin:26px 0 10px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#64748b;">${esc(rendered.nextTitle)}</p>
      <ol style="margin:0;padding-left:20px;">
        ${rendered.steps
          .map(
            (s) =>
              `<li style="margin-bottom:10px;font-size:14px;line-height:1.6;color:#334155;">${esc(s)}</li>`
          )
          .join("\n        ")}
      </ol>

      <div style="margin-top:26px;padding:18px;border:1px solid #e2e8f0;border-radius:12px;background-color:#f8fafc;">
        <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#0f172a;">${esc(rendered.disclaimerTitle)}</p>
        <p style="margin:0 0 14px;font-size:13px;line-height:1.6;color:#475569;">${esc(rendered.disclaimer)}</p>
        <a href="https://myinvois.hasil.gov.my/" style="display:inline-block;font-size:13px;font-weight:700;color:#4f46e5;text-decoration:none;">${esc(rendered.portalLabel)} &rarr;</a>
      </div>

      <p style="margin:18px 0 0;font-size:12px;color:#94a3b8;">${esc(rendered.reviewedLabel)}</p>

      <p style="margin:24px 0 0;">
        <a href="${esc(url)}" style="display:inline-block;padding:11px 18px;border-radius:10px;background-color:#0f172a;color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">${esc(l.checkAgain)}</a>
      </p>
    </div>

    <p style="margin:20px 4px 0;font-size:11px;line-height:1.6;color:#94a3b8;">${esc(l.footer)}</p>
  </div>
</body>
</html>`;

  /* A plain-text part that stands on its own. Some of the people this tool is
     for read mail in clients that strip HTML, and a result they cannot read is
     the same as a result we never sent. */
  const text = [
    SUBJECTS[locale],
    "",
    l.intro,
    "",
    `${rendered.status.toUpperCase()} — ${rendered.headline}`,
    "",
    ...rendered.paragraphs.flatMap((p) => [p, ""]),
    rendered.nextTitle.toUpperCase(),
    ...rendered.steps.map((s, i) => `${i + 1}. ${s}`),
    "",
    rendered.disclaimerTitle.toUpperCase(),
    rendered.disclaimer,
    "https://myinvois.hasil.gov.my/",
    "",
    rendered.reviewedLabel,
    url,
    "",
    l.footer,
  ].join("\n");

  return { subject: SUBJECTS[locale], html, text };
}

module.exports = { getScopeResultEmail, checkerUrl };
