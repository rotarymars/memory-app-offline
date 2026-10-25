// Getting images ready to store: downscaled in a canvas so the long side is at
// most MAX_IMAGE_SIDE, and encoded as WebP where the browser can actually
// encode it (Safari quietly hands back a PNG for unsupported types, so the
// result's type is checked), otherwise JPEG.

import { sha256Hex } from "../lib/hash.js";
import { imagePathFor } from "../lib/import-pack.js";
import { isImageType, sniffImageType } from "../lib/mime.js";

export const MAX_IMAGE_SIDE = 1200;
const QUALITY = 0.85;
// Imported images already this small and in a web format are kept byte for
// byte, so a pack made in the pack builder isn't re-compressed on import.
const KEEP_AS_IS_BYTES = 500 * 1024;
const KEEP_AS_IS_TYPES = ["image/webp", "image/jpeg", "image/png", "image/gif"];

let webpSupport = null;

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

export function canEncodeWebp() {
  if (!webpSupport) {
    webpSupport = (async () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 2;
        canvas.height = 2;
        const blob = await canvasToBlob(canvas, "image/webp", QUALITY);
        return blob?.type === "image/webp";
      } catch {
        return false;
      }
    })();
  }
  return webpSupport;
}

/** @param {Blob} blob @returns {Promise<HTMLImageElement>} */
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像は読み込めませんでした（対応していない形式かもしれません）"));
    };
    img.src = url;
  });
}

/**
 * @param {Blob} blob
 * @returns {Promise<{ width: number, height: number, img: HTMLImageElement }>}
 */
async function decode(blob) {
  const img = await loadImage(blob);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!width || !height) throw new Error("画像のサイズが取得できませんでした");
  return { width, height, img };
}

async function encode(img, width, height) {
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const webp = await canEncodeWebp();
  if (!webp) {
    // JPEG has no transparency: scans and diagrams are drawn on white.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, w, h);
  let out = webp ? await canvasToBlob(canvas, "image/webp", QUALITY) : null;
  if (!out || out.type !== "image/webp") {
    if (webp) {
      ctx.globalCompositeOperation = "destination-over";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
    }
    out = await canvasToBlob(canvas, "image/jpeg", QUALITY);
  }
  if (!out) throw new Error("画像の変換に失敗しました");
  return out;
}

/**
 * For an image added in the editor or pack builder (file pick, drop, paste):
 * downscaled and re-encoded. SVG stays as it is — it's already small and
 * would only lose sharpness.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
export async function prepareImage(blob) {
  const type = blob.type || sniffImageType(new Uint8Array(await blob.slice(0, 512).arrayBuffer())) || "";
  if (type === "image/svg+xml") return new Blob([blob], { type });
  const { img, width, height } = await decode(blob);
  return encode(img, width, height);
}

/**
 * For an image arriving in a pack or with a .txt: kept as-is when it's
 * already small enough, otherwise put through prepareImage. If this browser
 * can't decode it at all (e.g. HEIC outside Safari), it's kept unchanged.
 * @param {{ bytes: Uint8Array, type: string }} image
 * @returns {Promise<{ bytes: Uint8Array, type: string }>}
 */
export async function prepareImportedImage(image) {
  if (image.type === "image/svg+xml") return image;
  const blob = new Blob([image.bytes], { type: image.type });
  let decoded;
  try {
    decoded = await decode(blob);
  } catch {
    return image;
  }
  const small =
    Math.max(decoded.width, decoded.height) <= MAX_IMAGE_SIDE &&
    image.bytes.length <= KEEP_AS_IS_BYTES &&
    KEEP_AS_IS_TYPES.includes(image.type);
  if (small) return image;
  const out = await encode(decoded.img, decoded.width, decoded.height);
  return { bytes: new Uint8Array(await out.arrayBuffer()), type: out.type };
}

/** The study-data path an image will be stored under ("images/<hash>.webp"). */
export async function pathForBlob(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return imagePathFor(await sha256Hex(bytes), blob.type);
}

/** Picks the image files out of a DataTransfer / clipboard / file list. */
export function imageFilesFrom(list) {
  return Array.from(list ?? []).filter(
    (f) => f && (isImageType(f.type) || /\.(png|jpe?g|webp|gif|svg|heic|heif|avif|bmp)$/i.test(f.name ?? ""))
  );
}
