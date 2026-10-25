// The study data file: one zip holding everything you study from.
//
//   meta.json    format version, export time, app version, settings
//   cards.json   every card with its review state (array of Card)
//   daily.json   answers per local day
//   images/      card images, referenced from cards.json as "images/…"
//
// The README has the full spec. Bump STUDY_FORMAT_VERSION only for changes an
// older app couldn't read correctly; new optional fields don't need it.

import { strFromU8, strToU8, unzipSync, zipSync } from "../../vendor/fflate/esm/browser.js";
import { imagePathsOf, normalizeCard } from "./cards.js";
import { normalizeDaily } from "./daily.js";
import { randomId } from "./ids.js";
import { parseReviewOrder } from "./review-order.js";
import {
  collectImages,
  FileFormatError,
  findRoot,
  parseJsonEntry,
  readZip,
} from "./zip.js";

export const STUDY_FORMAT = "memory-study";
export const STUDY_FORMAT_VERSION = 1;

/** @typedef {import("./cards.js").Card} Card */
/** @typedef {import("./daily.js").Daily} Daily */
/** @typedef {{ bytes: Uint8Array, type: string }} ImageData */
/** @typedef {{ reviewOrder: import("./review-order.js").ReviewOrder }} Settings */

export function defaultSettings() {
  return { reviewOrder: "random" };
}

/** @param {any} raw @returns {Settings} */
export function normalizeSettings(raw) {
  return { reviewOrder: parseReviewOrder(raw?.reviewOrder) };
}

/**
 * @param {object} data
 * @param {Card[]} data.cards
 * @param {Daily} data.daily
 * @param {Settings} data.settings
 * @param {Map<string, ImageData>} data.images
 * @param {string} data.exportedAt      ISO time written to meta.json
 * @param {string | null} data.lastChangeAt
 * @param {string} data.appVersion
 * @returns {Uint8Array}
 */
export function buildStudyZip({ cards, daily, settings, images, exportedAt, lastChangeAt, appVersion }) {
  const referenced = [...new Set(cards.flatMap(imagePathsOf))].sort();
  const included = referenced.filter((path) => images.has(path));
  const meta = {
    format: STUDY_FORMAT,
    formatVersion: STUDY_FORMAT_VERSION,
    exportedAt,
    lastChangeAt,
    appVersion,
    cardCount: cards.length,
    imageCount: included.length,
    settings: normalizeSettings(settings),
  };
  /** @type {Record<string, any>} */
  const files = {
    "meta.json": strToU8(JSON.stringify(meta, null, 2)),
    "cards.json": strToU8(JSON.stringify(cards, null, 2)),
    "daily.json": strToU8(JSON.stringify(daily, null, 2)),
  };
  // Images are already compressed; storing them as-is keeps export fast.
  for (const path of included) files[path] = [images.get(path).bytes, { level: 0 }];
  return zipSync(files, { level: 6, mtime: new Date(exportedAt) });
}

/**
 * @typedef {object} StudyFile
 * @property {Card[]} cards
 * @property {Daily} daily
 * @property {Settings} settings
 * @property {Map<string, ImageData>} images  only the ones some card uses
 * @property {string | null} exportedAt
 * @property {string | null} latestEditAt     newest of lastChangeAt and the cards' own times
 * @property {string | null} appVersion
 * @property {number} formatVersion
 * @property {string[]} warnings
 */

/**
 * Reads a study zip. Throws FileFormatError when it isn't one (including when
 * it's a card pack, which goes through the importer instead).
 * @param {Uint8Array} bytes
 * @param {{ now?: Date }} [options]
 * @returns {StudyFile}
 */
export function parseStudyZip(bytes, { now = new Date() } = {}) {
  const entries = readZip(bytes);
  const prefix = findRoot(entries, "cards.json");
  if (prefix === null) {
    if (findRoot(entries, "pack.json") !== null) {
      throw new FileFormatError(
        "これはカードパック（pack.json）です。「取り込み」から読み込んでください。",
        "is-pack"
      );
    }
    throw new FileFormatError(
      "学習ファイルではありません（cards.json がありません）。",
      "not-study"
    );
  }

  const warnings = [];
  const meta = parseJsonEntry(entries, `${prefix}meta.json`, "meta.json");
  if (meta === undefined) warnings.push("meta.json がないため、設定は初期値になります");
  const m = meta && typeof meta === "object" ? meta : {};
  if (m.format !== undefined && m.format !== STUDY_FORMAT) {
    throw new FileFormatError(
      `学習ファイルではありません（format が "${String(m.format)}" です）。`,
      "not-study"
    );
  }
  const formatVersion = Number(m.formatVersion ?? STUDY_FORMAT_VERSION);
  if (formatVersion > STUDY_FORMAT_VERSION) {
    throw new FileFormatError(
      `新しいバージョンのアプリで作られたファイルです（形式 v${formatVersion}）。アプリを更新してから開いてください。`,
      "too-new"
    );
  }

  const rawCards = parseJsonEntry(entries, `${prefix}cards.json`, "cards.json");
  if (!Array.isArray(rawCards)) {
    throw new FileFormatError("cards.json がカードの配列になっていません。", "not-study");
  }
  const rawDaily = parseJsonEntry(entries, `${prefix}daily.json`, "daily.json");

  const allImages = collectImages(entries, prefix, warnings);
  const cards = [];
  const seenIds = new Set();
  for (const raw of rawCards) {
    const { card, warnings: w } = normalizeCard(raw, {
      hasImage: (path) => allImages.has(path),
      now,
    });
    warnings.push(...w);
    if (!card) continue;
    if (seenIds.has(card.id)) {
      warnings.push(`id が重複していたカードに新しい id を振りました（${card.id}）`);
      card.id = randomId();
    }
    seenIds.add(card.id);
    cards.push(card);
  }

  // Keep only the images some card uses.
  const images = new Map();
  for (const card of cards) {
    for (const path of imagePathsOf(card)) images.set(path, allImages.get(path));
  }

  const exportedAt = validIso(m.exportedAt);
  let latest = validIso(m.lastChangeAt);
  for (const card of cards) {
    for (const t of [card.updatedAt, card.lastReviewedAt]) {
      if (t && (!latest || t > latest)) latest = t;
    }
  }

  return {
    cards,
    daily: normalizeDaily(rawDaily),
    settings: normalizeSettings(m.settings),
    images,
    exportedAt,
    latestEditAt: latest,
    appVersion: typeof m.appVersion === "string" ? m.appVersion : null,
    formatVersion,
    warnings: dedupe(warnings),
  };
}

/**
 * Reads just meta.json's format and exportedAt, without unpacking the rest —
 * enough to tell whether a file was saved by someone else since we opened it.
 * @param {Uint8Array} bytes
 * @returns {{ format: string | null, exportedAt: string | null } | null} null if unreadable
 */
export function peekStudyMeta(bytes) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "meta.json" || /^[^/]+\/meta\.json$/.test(f.name) });
  } catch {
    return null;
  }
  const [name] = Object.keys(files).sort((a, b) => a.length - b.length);
  if (!name) return null;
  try {
    const meta = JSON.parse(strFromU8(files[name]).replace(/^\uFEFF/, ""));
    return {
      format: typeof meta?.format === "string" ? meta.format : null,
      exportedAt: validIso(meta?.exportedAt),
    };
  } catch {
    return null;
  }
}

function validIso(value) {
  if (typeof value !== "string" && !(value instanceof Date)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function dedupe(list) {
  return [...new Set(list)];
}
