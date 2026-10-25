// Card packs: a zip for adding cards, with no review progress in it.
//
//   pack.json   { format, formatVersion, name, createdAt, appVersion, cards: [...] }
//   images/     images referenced from pack.json as "images/…"
//
// Each pack card is { front, back, important, frontImage, backImage }. Tags
// aren't part of a pack: they're chosen when the pack is imported.

import { strToU8, zipSync } from "../../vendor/fflate/esm/browser.js";
import {
  collectImages,
  FileFormatError,
  findRoot,
  parseJsonEntry,
  readZip,
  resolveImageRef,
} from "./zip.js";

export const PACK_FORMAT = "memory-pack";
export const PACK_FORMAT_VERSION = 1;

/**
 * @typedef {object} PackCard
 * @property {string} front
 * @property {string} back
 * @property {boolean} important
 * @property {string | null} frontImage  "images/…" inside the pack
 * @property {string | null} backImage
 */

/** @typedef {{ bytes: Uint8Array, type: string }} ImageData */

/**
 * @param {object} pack
 * @param {string} pack.name
 * @param {PackCard[]} pack.cards
 * @param {Map<string, ImageData>} pack.images
 * @param {string} pack.createdAt
 * @param {string} pack.appVersion
 * @returns {Uint8Array}
 */
export function buildPackZip({ name, cards, images, createdAt, appVersion }) {
  const json = {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    name,
    createdAt,
    appVersion,
    cardCount: cards.length,
    cards: cards.map((c) => ({
      front: c.front,
      back: c.back,
      important: Boolean(c.important),
      frontImage: c.frontImage ?? null,
      backImage: c.backImage ?? null,
    })),
  };
  /** @type {Record<string, any>} */
  const files = { "pack.json": strToU8(JSON.stringify(json, null, 2)) };
  for (const c of cards) {
    for (const path of [c.frontImage, c.backImage]) {
      if (path && images.has(path) && !files[path]) {
        files[path] = [images.get(path).bytes, { level: 0 }];
      }
    }
  }
  return zipSync(files, { level: 6, mtime: new Date(createdAt) });
}

/**
 * @typedef {object} Pack
 * @property {string | null} name
 * @property {PackCard[]} cards
 * @property {Map<string, ImageData>} images
 * @property {string[]} warnings
 */

/**
 * Reads a pack zip. Lenient about hand-made packs: pack.json may be a bare
 * array of cards, and image references may leave off "images/".
 * @param {Uint8Array} bytes
 * @returns {Pack}
 */
export function parsePackZip(bytes) {
  const entries = readZip(bytes);
  const prefix = findRoot(entries, "pack.json");
  if (prefix === null) {
    if (findRoot(entries, "cards.json") !== null) {
      throw new FileFormatError(
        "これは学習ファイルです。カードパックではないので取り込めません（学習ファイルは「ファイル」から開きます）。",
        "is-study"
      );
    }
    throw new FileFormatError("カードパックではありません（pack.json がありません）。", "not-pack");
  }
  const raw = parseJsonEntry(entries, `${prefix}pack.json`, "pack.json");
  const json = Array.isArray(raw) ? { cards: raw } : raw;
  if (!json || typeof json !== "object" || !Array.isArray(json.cards)) {
    throw new FileFormatError("pack.json に cards の配列がありません。", "not-pack");
  }
  if (json.format !== undefined && json.format !== PACK_FORMAT) {
    throw new FileFormatError(
      `カードパックではありません（format が "${String(json.format)}" です）。`,
      "not-pack"
    );
  }
  const version = Number(json.formatVersion ?? PACK_FORMAT_VERSION);
  if (version > PACK_FORMAT_VERSION) {
    throw new FileFormatError(
      `新しいバージョンで作られたパックです（形式 v${version}）。アプリを更新してください。`,
      "too-new"
    );
  }

  const warnings = [];
  const images = collectImages(entries, prefix, warnings);
  const cards = [];
  json.cards.forEach((c, i) => {
    const n = i + 1;
    if (!c || typeof c !== "object") {
      warnings.push(`${n}枚目: カードの形式ではないのでスキップしました`);
      return;
    }
    const side = (ref, label) => {
      const path = resolveImageRef(ref, images);
      if (path === undefined) {
        warnings.push(`${n}枚目: ${label}の画像 ${String(ref)} がパック内にありません`);
        return null;
      }
      return path;
    };
    const card = {
      front: typeof c.front === "string" ? c.front : String(c.front ?? ""),
      back: typeof c.back === "string" ? c.back : String(c.back ?? ""),
      important: c.important === true || c.important === "true" || c.important === 1,
      frontImage: side(c.frontImage, "表面"),
      backImage: side(c.backImage, "裏面"),
    };
    if (card.front.trim() === "" && !card.frontImage) {
      warnings.push(`${n}枚目: 表面が空なのでスキップしました`);
      return;
    }
    if (card.back.trim() === "" && !card.backImage) {
      warnings.push(`${n}枚目: 裏面が空なのでスキップしました`);
      return;
    }
    cards.push(card);
  });

  return {
    name: typeof json.name === "string" && json.name.trim() ? json.name.trim() : null,
    cards,
    images,
    warnings,
  };
}
