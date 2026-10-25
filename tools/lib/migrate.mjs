// The pure part of the migration from the online memory-app: turning a row of
// its `cards` table into a study-file card. Kept apart from the script so it
// can be tested without a database.

import { contentHashOf } from "../../js/lib/import-pack.js";
import { extensionForType, imageTypeFromName, sniffImageType } from "../../js/lib/mime.js";
import { MAX_LEVEL } from "../../js/lib/spaced-repetition.js";
import { normalizeTags } from "../../js/lib/tags.js";

/**
 * A row as selected by export-from-memory-app.mjs (camelCase aliases of the
 * online app's columns).
 * @typedef {object} CardRow
 * @property {number} id
 * @property {string} front
 * @property {string} back
 * @property {string | null} tag
 * @property {string | null} frontImageUrl
 * @property {string | null} backImageUrl
 * @property {number} reviewLevel
 * @property {Date | string} nextReviewAt
 * @property {Date | string | null} lastReviewedAt
 * @property {number} againCount
 * @property {number} downCount
 * @property {number} goodCount
 * @property {number} greatCount
 * @property {Date | string} createdAt
 * @property {Date | string} updatedAt
 */

export function isoOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function count(value) {
  const n = Math.trunc(Number(value ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The image type of a downloaded file: the bytes first (most reliable), then
 * the Content-Type header, then the URL's extension.
 * @param {Uint8Array} bytes
 * @param {string | null} contentType
 * @param {string} url
 * @returns {string | null}
 */
export function detectImageType(bytes, contentType, url) {
  const sniffed = sniffImageType(bytes);
  if (sniffed) return sniffed;
  const header = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (header.startsWith("image/") && extensionForType(header) !== "bin") return header;
  try {
    return imageTypeFromName(new URL(url).pathname);
  } catch {
    return null;
  }
}

/**
 * @param {CardRow} row
 * @param {object} extra
 * @param {string} extra.id                       new UUID for the card
 * @param {string | null} extra.frontImage        "images/…" in the study file, or null
 * @param {string | null} extra.backImage
 * @param {string | null} extra.frontImageHash    SHA-256 of the image bytes
 * @param {string | null} extra.backImageHash
 * @param {Date} [extra.now]                      fallback for missing dates
 * @returns {Promise<import("../../js/lib/cards.js").Card>}
 */
export async function cardFromRow(row, { id, frontImage, backImage, frontImageHash, backImageHash, now = new Date() }) {
  const level = Math.trunc(Number(row.reviewLevel ?? 0));
  const createdAt = isoOrNull(row.createdAt) ?? now.toISOString();
  const front = String(row.front ?? "");
  const back = String(row.back ?? "");
  return {
    id,
    front,
    back,
    // The online app had one tag per card.
    tags: normalizeTags(row.tag ? [row.tag] : []),
    important: false,
    frontImage,
    backImage,
    reviewLevel: Number.isFinite(level) ? Math.max(0, Math.min(level, MAX_LEVEL)) : 0,
    nextReviewAt: isoOrNull(row.nextReviewAt) ?? now.toISOString(),
    lastReviewedAt: isoOrNull(row.lastReviewedAt),
    againCount: count(row.againCount),
    downCount: count(row.downCount),
    goodCount: count(row.goodCount),
    greatCount: count(row.greatCount),
    createdAt,
    updatedAt: isoOrNull(row.updatedAt) ?? createdAt,
    contentHash: await contentHashOf({ front, back, frontImageHash, backImageHash }),
  };
}
