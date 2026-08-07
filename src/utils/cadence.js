/**
 * Cadence maths for recurring schedules (spec 02).
 *
 * Pure functions, no database, no clock of their own — every entry point takes
 * "now" as an argument. Date arithmetic is where recurring billing goes wrong,
 * and code that reads the clock internally cannot be tested against the cases
 * that actually break it: 31 January, leap days, and the period after a job
 * failed to run for three days.
 *
 * All reasoning is in Asia/Kuala_Lumpur. The user's month is what a monthly
 * retainer means, not the server's.
 */

const TZ = "Asia/Kuala_Lumpur";
const MYT_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Calendar parts of an instant, as seen in Kuala Lumpur. */
function mytParts(date) {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [y, m, d] = ymd.split("-").map(Number);
  return { year: y, month: m, day: d };
}

/** 09:00 Kuala Lumpur on a given calendar date, as a UTC instant. */
function mytDate(year, month, day, hour = 9) {
  return new Date(Date.UTC(year, month - 1, day, hour) - MYT_OFFSET_MS);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Months added per step, or null for weekly. */
function monthsPerStep(frequency) {
  return { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }[frequency] ?? null;
}

/**
 * The issue date of occurrence `n` (0-based) for a schedule.
 *
 * Anchored to the start date and counted forward, never accumulated by adding
 * to the previous result: adding a month to 28 February repeatedly walks the
 * date backwards and the retainer silently drifts off its day.
 */
function occurrenceDate(schedule, n) {
  const start = new Date(schedule.startDate);
  const p = mytParts(start);
  const step = Math.max(1, Number(schedule.interval) || 1);

  if (schedule.frequency === "WEEKLY") {
    const d = new Date(start.getTime() + n * step * 7 * 86400000);
    const q = mytParts(d);
    return mytDate(q.year, q.month, q.day);
  }

  const months = monthsPerStep(schedule.frequency);
  if (months === null) return null;

  const total = p.month - 1 + n * step * months;
  const year = p.year + Math.floor(total / 12);
  const month = (total % 12) + 1;

  /* The day the user asked for, clamped to the length of THIS month. A schedule
     issued on the 31st issues on the 28th, 29th or 30th where that month is
     shorter — it never skips the period, which is the rule that matters: a
     missed retainer is a month of unbilled work. */
  const wanted = Number(schedule.issueDay) || p.day;
  const day = Math.min(wanted, daysInMonth(year, month));

  return mytDate(year, month, day);
}

/** A stable key for one occurrence, used to make generation idempotent. */
function periodKeyFor(schedule, n) {
  const d = occurrenceDate(schedule, n);
  if (!d) return null;
  const p = mytParts(d);
  const pad = (x) => String(x).padStart(2, "0");
  /* Includes the occurrence index so two schedules of different cadence, or a
     weekly schedule issuing twice in one month, cannot collide on one key. */
  return `${p.year}-${pad(p.month)}-${pad(p.day)}#${n}`;
}

/** Has the schedule reached its end condition at occurrence `n`? */
function isPastEnd(schedule, n) {
  if (schedule.endMode === "AFTER_N") {
    return n >= (Number(schedule.endAfter) || 0);
  }
  if (schedule.endMode === "ON_DATE" && schedule.endDate) {
    const d = occurrenceDate(schedule, n);
    /* The last instance is the final one ON OR BEFORE the end date. */
    return !d || d.getTime() > new Date(schedule.endDate).getTime();
  }
  return false;
}

/**
 * Every occurrence that should exist by `now` and has not been generated yet.
 *
 * Returns a list rather than just the next one, so a job that did not run for
 * three days catches up instead of quietly skipping two periods. Late is
 * acceptable; missing is not.
 */
function dueOccurrences(schedule, now = new Date(), { max = 24 } = {}) {
  const out = [];
  const already = Number(schedule.occurrences) || 0;

  for (let n = already; n < already + max; n += 1) {
    if (isPastEnd(schedule, n)) break;
    const at = occurrenceDate(schedule, n);
    if (!at) break;
    if (at.getTime() > now.getTime()) break;
    out.push({ index: n, issueAt: at, periodKey: periodKeyFor(schedule, n) });
  }
  return out;
}

/** When the next instance is due, for display. Null once the schedule ends. */
function nextIssueAt(schedule, now = new Date()) {
  const already = Number(schedule.occurrences) || 0;
  for (let n = already; n < already + 240; n += 1) {
    if (isPastEnd(schedule, n)) return null;
    const at = occurrenceDate(schedule, n);
    if (!at) return null;
    if (at.getTime() > now.getTime()) return at;
  }
  return null;
}

/** Due date for an instance issued on `issueAt`. */
function dueDateFor(schedule, issueAt) {
  const days = Number(schedule.paymentTermsDays) || 0;
  return new Date(issueAt.getTime() + days * 86400000);
}

module.exports = {
  TZ,
  mytParts,
  mytDate,
  daysInMonth,
  occurrenceDate,
  periodKeyFor,
  isPastEnd,
  dueOccurrences,
  nextIssueAt,
  dueDateFor,
};
