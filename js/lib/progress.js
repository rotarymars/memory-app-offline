// Per-tag progress: how well you recall each tag, how far along its cards are,
// and how long until every card in it is mature. Pure computation.
//
// Ported from memory-app/lib/progress.ts. The online app grouped its rows by
// a card's single tag; here a card can have several tags, so it counts towards
// each of them (and cards with no tags form their own group). The overall
// figures still count every card once — see summarizeCards.

import { COUNT_FIELDS, countsOf } from "./cards.js";
import {
  intervalMinutesForLevel,
  MATURE_LEVEL,
  nextLevel,
  REVIEW_OUTCOMES,
} from "./spaced-repetition.js";
import { compareTagNames } from "./tags.js";

/** @typedef {import("./daily.js").OutcomeCounts} OutcomeCounts */
/** @typedef {import("./cards.js").Card} Card */

/**
 * One row per (tag, level), with the outcome tallies summed — the shape the
 * online app read from the database. `lastDueAt` is the latest next-review
 * time in the group, which is what bounds how long that group takes to mature.
 * @typedef {{ tag: string | null, level: number, cards: number, lastDueAt: Date, counts: OutcomeCounts }} ProgressRow
 */

/**
 * @typedef {object} TagProgress
 * @property {string | null} tag
 * @property {number} total
 * @property {number} due              due now (not in the online progress page)
 * @property {number} learning         on the intra-day part of the ladder
 * @property {number} young            scheduled days out, not yet mature
 * @property {number} mature
 * @property {OutcomeCounts} counts
 * @property {number} reviews
 * @property {number | null} recallRate  Share of answers that were Good or Easy; null with no answers recorded.
 * @property {number} msToMature       Expected time until every card in the tag is mature (0 if they all are).
 * @property {number} reviewsToMature  Expected number of reviews still needed to get there.
 */

// Pseudo-reviews that stand in for history you don't have yet (80% recall).
// They keep the estimate sane for new tags and fade out as real answers pile
// up.
const PRIOR_COUNTS = Object.freeze({ again: 1, down: 1, good: 6, great: 2 });
// How many reviews a tag needs before its own record outweighs your overall
// record.
const TAG_PRIOR_WEIGHT = 10;

// Levels below this are still on the same-day part of the ladder (< 1 day).
export const LEARNING_BELOW_LEVEL = 7;

/**
 * Exact port of the online summarizeProgress: rows grouped by a single tag.
 * Kept so the multi-tag version below can be checked against it.
 * @param {ProgressRow[]} rows
 * @param {Date} [now]
 * @returns {{ tags: TagProgress[], overall: TagProgress }}
 */
export function summarizeProgress(rows, now = new Date()) {
  const byTag = new Map();
  for (const row of rows) {
    const group = byTag.get(row.tag);
    if (group) group.push(row);
    else byTag.set(row.tag, [row]);
  }

  const overallCounts = sumCounts(rows.map((r) => r.counts));
  const overallProbs = probabilities(overallCounts, PRIOR_COUNTS);

  const tags = Array.from(byTag, ([tag, group]) => {
    const counts = sumCounts(group.map((r) => r.counts));
    const probs = probabilities(counts, scale(overallProbs, TAG_PRIOR_WEIGHT));
    return tagProgress(tag, group, counts, probs, now);
  }).sort(compareTags);

  const overall = tagProgress(null, rows, overallCounts, overallProbs, now);
  // Each tag is estimated with its own recall; the overall finish line is
  // whichever tag gets there last.
  overall.msToMature = Math.max(0, ...tags.map((t) => t.msToMature));
  overall.reviewsToMature = tags.reduce((n, t) => n + t.reviewsToMature, 0);

  return { tags, overall };
}

/**
 * Groups cards into ProgressRows by the key `tagOf` picks for each card. A
 * card listed under several keys lands in several rows.
 * @param {Card[]} cards
 * @param {(card: Card) => (string | null)[]} tagsOf
 * @returns {ProgressRow[]}
 */
export function progressRows(cards, tagsOf) {
  const rows = new Map();
  for (const card of cards) {
    const due = new Date(card.nextReviewAt);
    for (const tag of tagsOf(card)) {
      const key = `${tag === null ? "\u0000" : tag}\u0001${card.reviewLevel}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          tag,
          level: card.reviewLevel,
          cards: 0,
          lastDueAt: due,
          counts: { again: 0, down: 0, good: 0, great: 0 },
        };
        rows.set(key, row);
      }
      row.cards += 1;
      if (due > row.lastDueAt) row.lastDueAt = due;
      for (const o of REVIEW_OUTCOMES) row.counts[o] += card[COUNT_FIELDS[o]];
    }
  }
  return Array.from(rows.values());
}

// Every tag a card counts towards; cards without tags go in the null group.
const allTagsOf = (card) => (card.tags.length > 0 ? card.tags : [null]);
// One group per card, for figures that must not count a card twice.
const firstTagOf = (card) => [card.tags[0] ?? null];

/**
 * The progress page's numbers for a set of cards.
 *
 * - Per tag: a card counts in every tag it has; untagged cards form one group.
 * - Overall: every card once. Recall, totals and stages come from all cards
 *   together. "All mature in" is the slowest tag, as before. "Reviews to go"
 *   sums each card's estimate under its first tag's recall, which is exactly
 *   the online figure when every card has at most one tag.
 * @param {Card[]} cards
 * @param {Date} [now]
 * @returns {{ tags: TagProgress[], overall: TagProgress }}
 */
export function summarizeCards(cards, now = new Date()) {
  const nowMs = now.getTime();
  const overallCounts = sumCounts(cards.map(countsOf));
  const overallProbs = probabilities(overallCounts, PRIOR_COUNTS);
  const tagPrior = scale(overallProbs, TAG_PRIOR_WEIGHT);

  const groups = groupBy(cards, allTagsOf);
  const probsByTag = new Map();
  const tags = Array.from(groups, ([tag, group]) => {
    const counts = sumCounts(group.map(countsOf));
    const probs = probabilities(counts, tagPrior);
    probsByTag.set(tag, probs);
    const result = tagProgress(tag, progressRows(group, () => [tag]), counts, probs, now);
    result.due = group.filter((c) => Date.parse(c.nextReviewAt) <= nowMs).length;
    return result;
  }).sort(compareTags);

  const overall = tagProgress(
    null,
    progressRows(cards, () => [null]),
    overallCounts,
    overallProbs,
    now
  );
  overall.due = cards.filter((c) => Date.parse(c.nextReviewAt) <= nowMs).length;
  overall.msToMature = Math.max(0, ...tags.map((t) => t.msToMature));
  overall.reviewsToMature = 0;
  for (const [tag, group] of groupBy(cards, firstTagOf)) {
    const counts = sumCounts(group.map(countsOf));
    const byFirst = tagProgress(tag, progressRows(group, () => [tag]), counts, probsByTag.get(tag), now);
    overall.reviewsToMature += byFirst.reviewsToMature;
  }

  return { tags, overall };
}

function groupBy(cards, keysOf) {
  const groups = new Map();
  for (const card of cards) {
    for (const key of keysOf(card)) {
      const group = groups.get(key);
      if (group) group.push(card);
      else groups.set(key, [card]);
    }
  }
  return groups;
}

/**
 * @param {string | null} tag
 * @param {ProgressRow[]} rows
 * @param {OutcomeCounts} counts
 * @param {Record<string, number>} probs
 * @param {Date} now
 * @returns {TagProgress}
 */
function tagProgress(tag, rows, counts, probs, now) {
  const { minutes, reviews } = expectedToMature(probs);
  const result = {
    tag,
    total: 0,
    due: 0,
    learning: 0,
    young: 0,
    mature: 0,
    counts,
    reviews: totalOf(counts),
    recallRate: null,
    msToMature: 0,
    reviewsToMature: 0,
  };
  if (result.reviews > 0) {
    result.recallRate = (counts.good + counts.great) / result.reviews;
  }

  for (const row of rows) {
    result.total += row.cards;
    if (row.level >= MATURE_LEVEL) {
      result.mature += row.cards;
      continue;
    }
    if (row.level < LEARNING_BELOW_LEVEL) result.learning += row.cards;
    else result.young += row.cards;

    // Wait until the latest card in this group comes due, then climb the
    // rest of the ladder. `minutes[level]` includes waiting out the card's
    // current interval, which the due date already accounts for.
    const waitMs = Math.max(0, row.lastDueAt.getTime() - now.getTime());
    const climbMinutes = minutes[row.level] - intervalMinutesForLevel(row.level);
    result.msToMature = Math.max(result.msToMature, waitMs + climbMinutes * 60_000);
    result.reviewsToMature += row.cards * reviews[row.level];
  }
  result.reviewsToMature = Math.round(result.reviewsToMature);
  return result;
}

// Expected minutes and reviews for a card that was just scheduled at each
// level below MATURE_LEVEL to reach it, if you review it whenever it comes
// due and answer with the given odds. Each review is a step in a Markov chain
// over levels, so for every level k:
//
//   E[k] = cost(k) + Σ p(outcome) · E[next level after outcome]
//
// with E = 0 once mature. That's a small linear system (one equation per
// level), solved directly.
function expectedToMature(probs) {
  const n = MATURE_LEVEL;
  // Rows of (I - P); the right-hand sides are filled in per cost below.
  const matrix = [];
  for (let k = 0; k < n; k++) {
    const row = new Array(n).fill(0);
    row[k] += 1;
    for (const outcome of REVIEW_OUTCOMES) {
      const to = nextLevel(k, outcome);
      if (to < n) row[to] -= probs[outcome];
    }
    matrix.push(row);
  }
  const minutesCost = Array.from({ length: n }, (_, k) => intervalMinutesForLevel(k));
  const reviewsCost = new Array(n).fill(1);
  return {
    minutes: solve(matrix, minutesCost),
    reviews: solve(matrix, reviewsCost),
  };
}

// Gaussian elimination with partial pivoting. The system is always solvable
// here: the prior keeps the odds of moving up above zero, so every level can
// reach maturity.
function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = col + 1; r < n; r++) {
      const f = m[r][col] / m[col][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r][n];
    for (let c = r + 1; c < n; c++) sum -= m[r][c] * x[c];
    x[r] = sum / m[r][r];
  }
  return x;
}

function probabilities(counts, prior) {
  const total = totalOf(counts) + totalOf(prior);
  const p = {};
  for (const o of REVIEW_OUTCOMES) p[o] = (counts[o] + prior[o]) / total;
  return p;
}

function scale(p, weight) {
  const c = {};
  for (const o of REVIEW_OUTCOMES) c[o] = p[o] * weight;
  return c;
}

function sumCounts(list) {
  const sum = { again: 0, down: 0, good: 0, great: 0 };
  for (const c of list) for (const o of REVIEW_OUTCOMES) sum[o] += c[o];
  return sum;
}

function totalOf(c) {
  return c.again + c.down + c.good + c.great;
}

// Named tags in order, untagged cards last.
function compareTags(a, b) {
  if (a.tag === null) return b.tag === null ? 0 : 1;
  if (b.tag === null) return -1;
  return compareTagNames(a.tag, b.tag);
}

// "under an hour" / "3 days" / "2 weeks" in Japanese, same cut-offs.
export function formatDuration(ms) {
  const hours = ms / 3_600_000;
  if (hours < 1) return "1時間以内";
  if (hours < 36) return `${Math.round(hours)}時間`;
  const days = hours / 24;
  if (days < 14) return `${Math.round(days)}日`;
  if (days < 60) return `${Math.round(days / 7)}週間`;
  if (days < 730) return `${Math.round(days / 30)}か月`;
  return `${Math.round(days / 365)}年`;
}
