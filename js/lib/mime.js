// Image types by file extension and by content. Zip entries carry no MIME
// type, and an <img> needs the right one (SVG especially), so every image read
// from a zip gets its type from here.

const TYPE_BY_EXT = Object.freeze({
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  heic: "image/heic",
  heif: "image/heif",
});

const EXT_BY_TYPE = Object.freeze({
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
});

export function imageTypeFromName(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ""));
  return m ? (TYPE_BY_EXT[m[1].toLowerCase()] ?? null) : null;
}

export function extensionForType(type) {
  return EXT_BY_TYPE[type] ?? "bin";
}

export function isImageType(type) {
  return Object.prototype.hasOwnProperty.call(EXT_BY_TYPE, type);
}

/**
 * Recognizes the common image formats from their first bytes.
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
export function sniffImageType(bytes) {
  const at = (i) => bytes[i];
  const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length < 4) return null;
  if (at(0) === 0x89 && ascii(1, 4) === "PNG") return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 2) === "BM") return "image/bmp";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP")
    return "image/webp";
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (["heic", "heix", "heim", "heis", "hevc", "hevx"].includes(brand))
      return "image/heic";
    if (brand === "mif1" || brand === "msf1") return "image/heif";
  }
  const head = new TextDecoder()
    .decode(bytes.subarray(0, 512))
    .replace(/^﻿/, "")
    .trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg")))
    return "image/svg+xml";
  return null;
}
