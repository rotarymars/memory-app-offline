// The per-day answer tally kept in daily.json:
//   { "2026-10-25": { "again": 3, "down": 1, "good": 40, "great": 12 } }
// Days are local dates. There is no per-answer log — like the per-card
// counters, this stays the same size no matter how much you review.

import { REVIEW_OUTCOMES } from "./spaced-repetition.js";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** @typedef {Record<import("./spaced-repetition.js").ReviewOutcome, number>} OutcomeCounts */
/** @typedef {Record<string, OutcomeCounts>} Daily */

/** @returns {OutcomeCounts} */
export function emptyCounts() {
  return { again: 0, down: 0, good: 0, great: 0 };
}

export function totalOf(counts) {
  return counts.again + counts.down + counts.good + counts.great;
}

// "2026-10-25" for the device's local calendar day.
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Adds (or, for undo, takes back) one answer. Returns a new object; a day
 * whose counts all drop to zero is removed.
 * @param {Daily} daily
 * @param {string} key
 * @param {import("./spaced-repetition.js").ReviewOutcome} outcome
 * @param {number} [delta]
 * @returns {Daily}
 */
export function addToDaily(daily, key, outcome, delta = 1) {
  const counts = { ...(daily[key] ?? emptyCounts()) };
  counts[outcome] = Math.max(0, counts[outcome] + delta);
  const next = { ...daily };
  if (totalOf(counts) === 0) delete next[key];
  else next[key] = counts;
  return next;
}

/**
 * Cleans a daily.json read from a file: valid date keys, non-negative whole
 * counts, empty days dropped, keys in date order.
 * @param {unknown} raw
 * @returns {Daily}
 */
export function normalizeDaily(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw).sort()) {
    if (!DATE_KEY.test(key)) continue;
    const value = raw[key];
    if (!value || typeof value !== "object") continue;
    const counts = emptyCounts();
    for (const o of REVIEW_OUTCOMES) {
      const n = Math.trunc(Number(value[o] ?? 0));
      counts[o] = Number.isFinite(n) && n > 0 ? n : 0;
    }
    if (totalOf(counts) > 0) out[key] = counts;
  }
  return out;
}

/**
 * The last `days` days up to and including `today`, oldest first, with zeros
 * for days without answers.
 * @param {Daily} daily
 * @param {number} days
 * @param {Date} [today]
 * @returns {{ key: string, date: Date, counts: OutcomeCounts, total: number }[]}
 */
export function dailySeries(daily, days, today = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    // Stepping the day-of-month keeps this right across DST changes.
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const key = localDateKey(date);
    const counts = { ...emptyCounts(), ...(daily[key] ?? {}) };
    out.push({ key, date, counts, total: totalOf(counts) });
  }
  return out;
}

/** @param {Daily} daily */
export function sumDaily(daily) {
  const sum = emptyCounts();
  for (const counts of Object.values(daily)) {
    for (const o of REVIEW_OUTCOMES) sum[o] += counts[o] ?? 0;
  }
  return sum;
}

// Consecutive days with at least one answer, ending today (or yesterday, so
// the streak doesn't read 0 before you've studied today).
export function currentStreak(daily, today = new Date()) {
  let streak = 0;
  let offset = daily[localDateKey(today)] ? 0 : 1;
  for (;;) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    if (!daily[localDateKey(date)]) return streak;
    streak++;
    offset++;
  }
}
