// Shared zip reading for study files and card packs, on top of fflate.

import { strFromU8, unzipSync } from "../../vendor/fflate/esm/browser.js";
import { imageTypeFromName, sniffImageType } from "./mime.js";

// A problem with the file the user picked, worded for them.
export class FileFormatError extends Error {
  /**
   * @param {string} message
   * @param {"not-zip" | "not-study" | "not-pack" | "is-pack" | "is-study" | "too-new" | "bad-json"} kind
   */
  constructor(message, kind) {
    super(message);
    this.name = "FileFormatError";
    this.kind = kind;
  }
}

/**
 * All files in a zip, by path. Folders and the junk macOS adds are skipped.
 * @param {Uint8Array} bytes
 * @returns {Map<string, Uint8Array>}
 */
export function readZip(bytes) {
  let files;
  try {
    files = unzipSync(bytes, {
      filter: (f) =>
        !f.name.endsWith("/") &&
        !f.name.startsWith("__MACOSX/") &&
        !/(^|\/)\.DS_Store$/.test(f.name),
    });
  } catch {
    throw new FileFormatError(
      "ZIPファイルとして読み込めませんでした。ファイルが壊れていないか確認してください。",
      "not-zip"
    );
  }
  return new Map(Object.entries(files).map(([name, data]) => [name.normalize("NFC"), data]));
}

/**
 * Where the zip's content starts. Zipping a folder (e.g. "Compress" in macOS
 * Finder) puts everything under that folder's name, so `marker` may be at
 * "folder/marker" rather than at the top.
 * @param {Map<string, Uint8Array>} entries
 * @param {string} marker
 * @returns {string | null} the prefix to strip ("" or "folder/"), or null if absent
 */
export function findRoot(entries, marker) {
  if (entries.has(marker)) return "";
  const candidates = [...entries.keys()].filter(
    (name) => name.endsWith(`/${marker}`) && name.split("/").length === 2
  );
  return candidates.length === 1 ? candidates[0].slice(0, -marker.length) : null;
}

/**
 * @param {Map<string, Uint8Array>} entries
 * @param {string} path
 * @param {string} label   file name for the error message
 */
export function parseJsonEntry(entries, path, label) {
  const data = entries.get(path);
  if (!data) return undefined;
  try {
    return JSON.parse(strFromU8(data).replace(/^﻿/, ""));
  } catch {
    throw new FileFormatError(`${label} の内容が正しいJSONではありません。`, "bad-json");
  }
}

/**
 * The images under `<prefix>images/`, keyed by their path without the prefix
 * ("images/…"). The type comes from the extension, or the bytes if that fails.
 * @param {Map<string, Uint8Array>} entries
 * @param {string} prefix
 * @param {string[]} warnings
 * @returns {Map<string, { bytes: Uint8Array, type: string }>}
 */
export function collectImages(entries, prefix, warnings) {
  const images = new Map();
  for (const [name, bytes] of entries) {
    if (!name.startsWith(`${prefix}images/`)) continue;
    const path = name.slice(prefix.length);
    if (path.split("/").some((part) => part === ".." || part === ".")) continue;
    const type = imageTypeFromName(path) ?? sniffImageType(bytes);
    if (!type) {
      warnings.push(`${path} は画像として認識できないため読み込みませんでした`);
      continue;
    }
    images.set(path, { bytes, type });
  }
  return images;
}

/**
 * Resolves an image reference from pack.json/cards.json to a key of `images`.
 * Accepts "images/a.png", "./images/a.png" and a bare "a.png".
 * @param {unknown} ref
 * @param {Map<string, unknown>} images
 * @returns {string | null | undefined} the path, null for "no image", undefined if not found
 */
export function resolveImageRef(ref, images) {
  if (ref === null || ref === undefined || ref === "") return null;
  if (typeof ref !== "string") return undefined;
  const cleaned = ref.normalize("NFC").replace(/^\.\//, "").replace(/^\/+/, "");
  if (images.has(cleaned)) return cleaned;
  if (images.has(`images/${cleaned}`)) return `images/${cleaned}`;
  return undefined;
}
