// The card record kept in cards.json, and the pure operations on it: creating,
// cleaning up what a file holds, recording an answer, and filtering.

import { randomId } from "./ids.js";
import {
  MAX_LEVEL,
  nextReviewDate,
  REVIEW_OUTCOMES,
} from "./spaced-repetition.js";
import { normalizeTags } from "./tags.js";

/**
 * @typedef {object} Card
 * @property {string} id                 crypto.randomUUID()
 * @property {string} front
 * @property {string} back
 * @property {string[]} tags
 * @property {boolean} important
 * @property {string | null} frontImage  path inside the study zip, "images/…"
 * @property {string | null} backImage
 * @property {number} reviewLevel        0…15, see spaced-repetition.js
 * @property {string} nextReviewAt       ISO 8601
 * @property {string | null} lastReviewedAt
 * @property {number} againCount         lifetime answer tallies, one per outcome
 * @property {number} downCount
 * @property {number} goodCount
 * @property {number} greatCount
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [contentHash]      content when created/imported, for dedupe
 */

/** @typedef {import("./spaced-repetition.js").ReviewOutcome} ReviewOutcome */

export const COUNT_FIELDS = Object.freeze({
  again: "againCount",
  down: "downCount",
  good: "goodCount",
  great: "greatCount",
});

/**
 * @param {{ front?: string, back?: string, tags?: string[], important?: boolean,
 *   frontImage?: string | null, backImage?: string | null, contentHash?: string }} fields
 * @param {Date} [now]
 * @returns {Card}
 */
export function createCard(fields, now = new Date()) {
  const iso = now.toISOString();
  /** @type {Card} */
  const card = {
    id: randomId(),
    front: fields.front ?? "",
    back: fields.back ?? "",
    tags: normalizeTags(fields.tags),
    important: Boolean(fields.important),
    frontImage: fields.frontImage ?? null,
    backImage: fields.backImage ?? null,
    reviewLevel: 0,
    // New cards are due immediately, as in the online app.
    nextReviewAt: iso,
    lastReviewedAt: null,
    againCount: 0,
    downCount: 0,
    goodCount: 0,
    greatCount: 0,
    createdAt: iso,
    updatedAt: iso,
  };
  if (fields.contentHash) card.contentHash = fields.contentHash;
  return card;
}

function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function count(value) {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function text(value) {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Turns one entry of a cards.json into a valid Card, filling gaps instead of
 * failing: a file edited by hand or written by an older version still opens.
 * @param {any} raw
 * @param {{ hasImage: (path: string) => boolean, now?: Date }} options
 * @returns {{ card: Card | null, warnings: string[] }}
 */
export function normalizeCard(raw, { hasImage, now = new Date() }) {
  const warnings = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { card: null, warnings: ["カードではない項目をスキップしました"] };
  }
  const nowIso = now.toISOString();
  const image = (path, side) => {
    if (path === null || path === undefined || path === "") return null;
    if (typeof path === "string" && hasImage(path)) return path;
    warnings.push(`画像 ${String(path)} がファイル内に見つからないため、${side}の画像を外しました`);
    return null;
  };
  const level = Math.trunc(Number(raw.reviewLevel ?? 0));
  const createdAt = isoOrNull(raw.createdAt) ?? nowIso;

  /** @type {Card} */
  const card = {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : randomId(),
    front: text(raw.front),
    back: text(raw.back),
    // `tag` is the online app's single tag, accepted so a hand-converted file
    // still opens.
    tags: normalizeTags(raw.tags ?? (raw.tag ? [raw.tag] : [])),
    important: raw.important === true || raw.important === "true" || raw.important === 1,
    frontImage: image(raw.frontImage, "表面"),
    backImage: image(raw.backImage, "裏面"),
    reviewLevel: Number.isFinite(level) ? Math.max(0, Math.min(level, MAX_LEVEL)) : 0,
    nextReviewAt: isoOrNull(raw.nextReviewAt) ?? nowIso,
    lastReviewedAt: isoOrNull(raw.lastReviewedAt),
    againCount: count(raw.againCount),
    downCount: count(raw.downCount),
    goodCount: count(raw.goodCount),
    greatCount: count(raw.greatCount),
    createdAt,
    updatedAt: isoOrNull(raw.updatedAt) ?? createdAt,
  };
  if (typeof raw.contentHash === "string" && raw.contentHash) {
    card.contentHash = raw.contentHash;
  }
  return { card, warnings };
}

export function isDue(card, now = new Date()) {
  return Date.parse(card.nextReviewAt) <= now.getTime();
}

/** @param {Card} card */
export function countsOf(card) {
  return {
    again: card.againCount,
    down: card.downCount,
    good: card.goodCount,
    great: card.greatCount,
  };
}

/** @param {Card} card */
export function imagePathsOf(card) {
  return [card.frontImage, card.backImage].filter(Boolean);
}

/** @param {Card[]} cards */
export function referencedImages(cards) {
  const paths = new Set();
  for (const card of cards) for (const p of imagePathsOf(card)) paths.add(p);
  return paths;
}

// The fields an answer changes, so undo can put them back exactly.
const REVIEW_FIELDS = [
  "reviewLevel",
  "nextReviewAt",
  "lastReviewedAt",
  "againCount",
  "downCount",
  "goodCount",
  "greatCount",
  "updatedAt",
];

/** @param {Card} card */
export function reviewFieldsOf(card) {
  const out = {};
  for (const f of REVIEW_FIELDS) out[f] = card[f];
  return out;
}

/**
 * Records one answer: the card moves to `level` (worked out by the session,
 * see review-session.js), is scheduled from `now`, and the outcome's tally
 * goes up by one. Same effect as the online app's applyReviewStates.
 * @param {Card} card
 * @param {ReviewOutcome} outcome
 * @param {number} level
 * @param {Date} [now]
 * @returns {Card}
 */
export function applyAnswerToCard(card, outcome, level, now = new Date()) {
  const field = COUNT_FIELDS[outcome];
  const iso = now.toISOString();
  return {
    ...card,
    reviewLevel: level,
    nextReviewAt: nextReviewDate(level, now).toISOString(),
    lastReviewedAt: iso,
    [field]: card[field] + 1,
    updatedAt: iso,
  };
}

/**
 * @typedef {object} CardFilter
 * @property {string[]} [tags]          match cards with any of these tags
 * @property {boolean} [untagged]       …or with no tags at all
 * @property {boolean} [importantOnly]
 * @property {boolean} [dueOnly]
 * @property {string} [query]           words that must all appear in the front, back or tags
 */

// Full-width and half-width forms compare equal (ＡＢＣ = abc, ｶﾅ = カナ).
export function searchKey(value) {
  return String(value).normalize("NFKC").toLowerCase();
}

/**
 * @param {Card} card
 * @param {string[]} tags
 * @param {boolean} untagged
 */
export function matchesTags(card, tags, untagged) {
  if (tags.length === 0 && !untagged) return true;
  if (untagged && card.tags.length === 0) return true;
  return card.tags.some((t) => tags.includes(t));
}

/**
 * @param {Card[]} cards
 * @param {CardFilter} filter
 * @param {Date} [now]
 * @returns {Card[]}
 */
export function filterCards(cards, filter, now = new Date()) {
  const tags = filter.tags ?? [];
  const untagged = Boolean(filter.untagged);
  const words = searchKey(filter.query ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const nowMs = now.getTime();
  return cards.filter((card) => {
    if (filter.importantOnly && !card.important) return false;
    if (filter.dueOnly && Date.parse(card.nextReviewAt) > nowMs) return false;
    if (!matchesTags(card, tags, untagged)) return false;
    if (words.length > 0) {
      const haystack = searchKey(`${card.front}\n${card.back}\n${card.tags.join("\n")}`);
      if (!words.every((w) => haystack.includes(w))) return false;
    }
    return true;
  });
}

// Newest first, like the online card list. The sort is stable, so cards
// imported together keep their order from the pack.
/** @param {Card[]} cards */
export function sortNewestFirst(cards) {
  return [...cards].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** @param {Card[]} cards */
export function sumCounts(cards) {
  const sum = { again: 0, down: 0, good: 0, great: 0 };
  for (const card of cards) {
    for (const o of REVIEW_OUTCOMES) sum[o] += card[COUNT_FIELDS[o]];
  }
  return sum;
}
