/**
 * The referral programme (spec 09, part B).
 *
 * REWARD SHAPE: account credit in sen against the referrer's next subscription
 * payment. The spec offers a choice and says to prefer this one unless there is
 * a reason not to — there is not. Credit needs no payout mechanism, no bank
 * details, no tax handling and no reconciliation; it is a discount we apply to
 * a bill we are already sending.
 *
 * WHEN IT IS EARNED: the referred account's FIRST SUCCESSFUL PAID PAYMENT.
 * Never at signup. Rewarding signups pays for empty accounts, and an incentive
 * to create empty accounts is an incentive to create fake ones.
 *
 * THE REFERRED ACCOUNT GETS SOMETHING TOO. A discount on their first month, so
 * the link is worth sharing rather than feeling like the referrer is taking a
 * commission from a friend. That single decision is the difference between a
 * programme people use and one they are embarrassed by.
 *
 * Money is SEN throughout, like every other amount in this codebase.
 */

const crypto = require("crypto");

/* ─── The numbers ─────────────────────────────────────────────────────────
   Kept together and named, because these are the only values anybody will want
   to change and hunting them through the logic is how one gets changed and the
   others do not. */

/** Credit to the referrer, per converted referral. RM10.00. */
const CREDIT_SEN = 1000;

/** Discount to the referred account on their first month. RM10.00. */
const REFERRED_DISCOUNT_SEN = 1000;

/**
 * Most credit one account can earn in a period. RM100.00.
 *
 * The spec asks for a cap and it is worth saying why beyond "abuse": without
 * one, the worst case is not somebody earning a lot legitimately — it is a
 * script creating accounts that each pay one month and cancel, converting our
 * subscription revenue into credit at a fixed exchange rate. The cap bounds the
 * damage before any of the smarter checks have to work.
 */
const PERIOD_CAP_SEN = 10000;

/**
 * How long after a click a signup still counts.
 *
 * Thirty days. Long enough that somebody who is told about the product on a
 * Friday and signs up after payday is still attributed, short enough that a
 * link clicked once does not claim credit for a signup a year later that had
 * nothing to do with it.
 */
const ATTRIBUTION_WINDOW_DAYS = 30;

const STATUS = {
  PENDING: "PENDING",
  CONVERTED: "CONVERTED",
  REVERSED: "REVERSED",
  REJECTED: "REJECTED",
};

/** Why a referral was refused. Stored, so support has an answer. */
const REJECT = {
  SELF: "self_referral",
  SAME_EMAIL: "same_email_identity",
  SAME_DOMAIN: "same_custom_domain",
  WINDOW: "outside_attribution_window",
};

/** "YYYY-MM" in Asia/Kuala_Lumpur — the same period key the metering uses. */
function periodKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .slice(0, 7);
}

/**
 * A stable, non-identifying hash of a visitor.
 *
 * Salted with JWT_SECRET so it cannot be reversed by anybody who does not
 * already hold the signing key, and truncated because this only needs to be
 * unique enough to dedupe a refresh. Deliberately NOT a cookie or a
 * fingerprint: the referrals page claims to show roughly how many people opened
 * a link, and this supports exactly that claim and nothing more.
 */
function visitorHash(ip, userAgent) {
  const salt = process.env.JWT_SECRET || "referral";
  return crypto
    .createHmac("sha256", salt)
    .update(`${ip || ""}|${userAgent || ""}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The local part of an email, normalised the way providers actually treat it.
 *
 * Gmail ignores dots and everything after a plus, so a.b+1@gmail.com and
 * ab@gmail.com are one mailbox — and are therefore one person referring
 * themselves. Applied to every domain rather than just Gmail: plus-addressing
 * is near-universal now, and the false-positive risk (two real people whose
 * addresses differ only by a plus tag) is negligible next to the alternative.
 */
function canonicalEmail(email) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at < 1) return raw;

  const local = raw.slice(0, at).split("+")[0].replace(/\./g, "");
  const domain = raw.slice(at + 1);
  return `${local}@${domain}`;
}

/**
 * Domains where "same domain" says nothing about identity.
 *
 * Two freelancers on gmail.com are not the same person, so blocking on shared
 * domain has to skip the consumer providers or it rejects almost every genuine
 * referral in this market. Shared domain is only a signal for a CUSTOM domain,
 * where it usually means two colleagues at one company — which is a grey area,
 * so it is a flag rather than a rejection.
 */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com",
  "hotmail.com", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com",
  "proton.me", "protonmail.com", "aol.com", "gmx.com", "mail.com", "zoho.com",
  "yandex.com", "qq.com", "163.com", "hotmail.co.uk", "outlook.my",
]);

function domainOf(email) {
  const raw = String(email || "").toLowerCase();
  const at = raw.lastIndexOf("@");
  return at < 0 ? "" : raw.slice(at + 1);
}

/**
 * Should this referral be allowed at all?
 *
 * Returns { ok: true } or { ok: false, reason }. Checks only what can be known
 * at SIGNUP; payment-method matching happens later, at conversion, because
 * there is no payment method yet.
 *
 * The bar is deliberately different for the two cases it catches. Referring
 * yourself is unambiguous and is rejected outright. Two people at the same
 * company domain is a grey area — colleagues genuinely do recommend tools to
 * each other — so that is allowed through and left visible rather than
 * silently refused.
 */
function screenSignup({ referrer, candidateEmail, clickedAt, now = new Date() }) {
  if (!referrer) return { ok: false, reason: REJECT.SELF };

  const mine = canonicalEmail(referrer.email);
  const theirs = canonicalEmail(candidateEmail);

  /* The same mailbox, however it was spelled. This is the check that catches
     the obvious attempt: sign up again as yourself+1@gmail.com. */
  if (mine && theirs && mine === theirs) {
    return { ok: false, reason: REJECT.SAME_EMAIL };
  }

  /* Outside the attribution window. A click from a year ago did not cause this
     signup, and paying for it would be paying for a coincidence. */
  if (clickedAt) {
    const ageDays = (now.getTime() - new Date(clickedAt).getTime()) / 86400000;
    if (ageDays > ATTRIBUTION_WINDOW_DAYS) {
      return { ok: false, reason: REJECT.WINDOW };
    }
  }

  return { ok: true };
}

/**
 * Is this pair suspicious enough to hold for review rather than pay?
 *
 * Separate from screenSignup because the answer is "maybe", and a maybe must
 * not silently become a no. Nothing in this file acts on the flag yet — it is
 * recorded so that a human looking at a suspicious cluster has something to
 * look at, which is the honest amount of anti-abuse to build before there is
 * any abuse to observe.
 */
function suspicionFlags({ referrer, referredEmail }) {
  const flags = [];
  const a = domainOf(referrer?.email);
  const b = domainOf(referredEmail);
  if (a && b && a === b && !PUBLIC_EMAIL_DOMAINS.has(a)) {
    flags.push(REJECT.SAME_DOMAIN);
  }
  return flags;
}

/**
 * How much credit can still be granted this period.
 *
 * `alreadySen` is the sum of credit already CONVERTED in this period — reversed
 * referrals do not count against the cap, because a reversal means the money
 * was taken back and the allowance with it.
 */
function creditAllowedThisPeriod(alreadySen) {
  return Math.max(0, PERIOD_CAP_SEN - Math.max(0, alreadySen || 0));
}

/** What a single conversion is worth, once the cap has had its say. */
function creditForConversion(alreadySen) {
  return Math.min(CREDIT_SEN, creditAllowedThisPeriod(alreadySen));
}

/**
 * Apply available credit to a bill.
 *
 * Returns { chargeSen, usedSen }. Never produces a negative charge and never
 * spends more credit than the bill is worth — leftover credit stays on the
 * account for next time, which is the whole point of it being a balance rather
 * than a coupon.
 */
function applyCredit(amountSen, creditSen) {
  const amount = Math.max(0, Math.round(Number(amountSen) || 0));
  const credit = Math.max(0, Math.round(Number(creditSen) || 0));
  const usedSen = Math.min(amount, credit);
  return { chargeSen: amount - usedSen, usedSen };
}

/** The referral link for a code. `via` tags where it was shared. */
function referralUrl(code, via = null) {
  const base = (process.env.MARKETING_URL || "https://invokita.my").replace(/\/$/, "");
  const params = new URLSearchParams({ ref: String(code || "") });
  if (via) params.set("via", via);
  return `${base}/r?${params.toString()}`;
}

/**
 * Prefilled share text, both languages.
 *
 * Most sharing here happens on WhatsApp, so this is written to be pasted into a
 * chat: short, first person, no marketing voice, and it leads with what the
 * reader gets rather than with what the sender earns. A share message that
 * reads like an ad is one people rewrite or do not send.
 */
function shareText(code, locale = "en") {
  const url = referralUrl(code, "wa");
  const en =
    `I use InvoKita to send invoices and chase them on WhatsApp — it follows up ` +
    `automatically until the client pays. Sign up through this and you get your ` +
    `first month discounted: ${url}`;
  const ms =
    `Saya guna InvoKita untuk hantar invois dan kejar bayaran melalui WhatsApp — ` +
    `ia susul sendiri sampai pelanggan bayar. Daftar guna pautan ini dan anda ` +
    `dapat diskaun untuk bulan pertama: ${url}`;
  return locale === "ms" ? ms : en;
}

/* ─── The share prompt ─────────────────────────────────────────────────────
   Asking somebody to recommend the product is a favour. When you ask decides
   whether it feels like one. */

/** Never more often than this, however many invoices get paid. */
const SHARE_PROMPT_COOLDOWN_DAYS = 21;

/** Two "no"s is an answer. A third ask is nagging. */
const SHARE_PROMPT_MAX_DISMISSALS = 2;

/**
 * Should the share prompt be shown right now?
 *
 * Three conditions, all required:
 *
 *   1. A QUALIFYING EVENT has happened — an invoice paid after a reminder we
 *      sent. Not any payment: an invoice paid on time before any chasing is a
 *      client being organised, and we did nothing there worth mentioning.
 *   2. The cooldown has passed. Somebody who gets paid weekly would otherwise
 *      see this every week, which turns a nice moment into furniture.
 *   3. They have not dismissed it twice.
 *
 * Pure, so the rule is testable without a database and cannot be quietly
 * different between the endpoint that reads it and any future one that does.
 */
function shouldSharePrompt({
  eligibleAt,
  shownAt,
  dismissals = 0,
  now = new Date(),
} = {}) {
  if (!eligibleAt) return false;
  if ((dismissals || 0) >= SHARE_PROMPT_MAX_DISMISSALS) return false;

  if (shownAt) {
    const days = (now.getTime() - new Date(shownAt).getTime()) / 86400000;
    if (days < SHARE_PROMPT_COOLDOWN_DAYS) return false;
  }

  return true;
}

module.exports = {
  SHARE_PROMPT_COOLDOWN_DAYS,
  SHARE_PROMPT_MAX_DISMISSALS,
  shouldSharePrompt,
  CREDIT_SEN,
  REFERRED_DISCOUNT_SEN,
  PERIOD_CAP_SEN,
  ATTRIBUTION_WINDOW_DAYS,
  STATUS,
  REJECT,
  PUBLIC_EMAIL_DOMAINS,
  periodKey,
  visitorHash,
  canonicalEmail,
  domainOf,
  screenSignup,
  suspicionFlags,
  creditAllowedThisPeriod,
  creditForConversion,
  applyCredit,
  referralUrl,
  shareText,
};
