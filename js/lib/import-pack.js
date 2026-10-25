// Adding a pack's cards (from a pack zip or a .txt) to the study data. Cards
// the study data already has are skipped, so importing the same pack twice
// adds nothing the second time.
//
// "The same card" means the same front, back and image bytes. Each card keeps
// the hash of what it was created or imported with (`contentHash`), and
// duplicates are checked against that and against what it holds now — so
// neither an untouched card nor one you've since edited comes back.

import { createCard } from "./cards.js";
import { sha256Hex } from "./hash.js";
import { extensionForType } from "./mime.js";

/** @typedef {import("./cards.js").Card} Card */
/** @typedef {import("./pack-file.js").PackCard} PackCard */
/** @typedef {{ bytes: Uint8Array, type: string }} ImageData */

function normalizeText(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

/**
 * @param {{ front: string, back: string, frontImageHash: string | null, backImageHash: string | null }} content
 * @returns {Promise<string>}
 */
export function contentHashOf({ front, back, frontImageHash, backImageHash }) {
  return sha256Hex(
    JSON.stringify([
      "memory-card/1",
      normalizeText(front),
      normalizeText(back),
      frontImageHash ?? null,
      backImageHash ?? null,
    ])
  );
}

// Images are stored under their content hash, so the same picture used on two
// cards (or imported twice) is one file.
export function imagePathFor(hash, type) {
  return `images/${hash.slice(0, 32)}.${extensionForType(type)}`;
}

/**
 * The content hash of a card as it is now.
 * @param {Card} card
 * @param {(path: string) => Promise<string | null>} imageHashOf
 */
export async function currentContentHash(card, imageHashOf) {
  return contentHashOf({
    front: card.front,
    back: card.back,
    frontImageHash: card.frontImage ? await imageHashOf(card.frontImage) : null,
    backImageHash: card.backImage ? await imageHashOf(card.backImage) : null,
  });
}

/**
 * @param {Card[]} cards
 * @param {(path: string) => Promise<string | null>} imageHashOf
 * @returns {Promise<Set<string>>}
 */
export async function knownContentHashes(cards, imageHashOf) {
  const known = new Set();
  for (const card of cards) {
    if (card.contentHash) known.add(card.contentHash);
    known.add(await currentContentHash(card, imageHashOf));
  }
  return known;
}

/**
 * @param {object} args
 * @param {Card[]} args.existingCards
 * @param {(path: string) => Promise<string | null>} args.imageHashOf  hash of a study image's bytes
 * @param {PackCard[]} args.packCards
 * @param {Map<string, ImageData>} args.packImages
 * @param {string[]} args.tags            applied to every imported card
 * @param {boolean} args.markImportant    mark every imported card important
 * @param {Date} [args.now]
 * @param {(image: ImageData) => Promise<ImageData>} [args.prepareImage]
 *   e.g. downscaling in the browser; images are stored as-is without it
 * @returns {Promise<{ cards: Card[], images: Map<string, ImageData>, added: number, skipped: number }>}
 */
export async function importPackCards({
  existingCards,
  imageHashOf,
  packCards,
  packImages,
  tags,
  markImportant,
  now = new Date(),
  prepareImage = async (image) => image,
}) {
  const known = await knownContentHashes(existingCards, imageHashOf);

  // Pack image path → hash of its bytes as they are in the pack. The content
  // hash uses these, not the stored (possibly re-encoded) bytes, so it's the
  // same every time the pack is imported.
  const sourceHashes = new Map();
  const hashOfPackImage = async (path) => {
    if (!path) return null;
    if (!sourceHashes.has(path)) {
      sourceHashes.set(path, await sha256Hex(packImages.get(path).bytes));
    }
    return sourceHashes.get(path);
  };

  // Pack image path → where it ended up in the study data.
  const stored = new Map();
  const images = new Map();
  const storeImage = async (path) => {
    if (!path) return null;
    if (!stored.has(path)) {
      const ready = await prepareImage(packImages.get(path));
      const studyPath = imagePathFor(await sha256Hex(ready.bytes), ready.type);
      images.set(studyPath, ready);
      stored.set(path, studyPath);
    }
    return stored.get(path);
  };

  const cards = [];
  let skipped = 0;
  for (const pc of packCards) {
    const hash = await contentHashOf({
      front: pc.front,
      back: pc.back,
      frontImageHash: await hashOfPackImage(pc.frontImage),
      backImageHash: await hashOfPackImage(pc.backImage),
    });
    if (known.has(hash)) {
      skipped++;
      continue;
    }
    known.add(hash); // also catches a card repeated inside the pack
    cards.push(
      createCard(
        {
          front: pc.front,
          back: pc.back,
          tags,
          important: pc.important || markImportant,
          frontImage: await storeImage(pc.frontImage),
          backImage: await storeImage(pc.backImage),
          contentHash: hash,
        },
        now
      )
    );
  }
  return { cards, images, added: cards.length, skipped };
}

/**
 * How an [img:…] file name is matched against image files: NFC, forward
 * slashes, no leading "./".
 * @param {string} name
 */
export function imageNameKey(name) {
  return name.normalize("NFC").replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Builds pack cards from parsed .txt cards (card-text.js) and the image files
 * that go with them, matched by file name. A card left with an empty side
 * because its only content was a missing image is dropped.
 * @param {import("./card-text.js").TextCard[]} textCards
 * @param {Map<string, ImageData>} filesByName   image files by name ("map.png")
 * @returns {{ cards: PackCard[], images: Map<string, ImageData>, missing: string[], warnings: string[] }}
 */
export function packFromTextCards(textCards, filesByName) {
  const images = new Map();
  const missing = [];
  const warnings = [];
  const lookup = (name) => {
    if (!name) return null;
    const key = imageNameKey(name);
    const base = key.replace(/^.*\//, "");
    const found = filesByName.has(key) ? key : filesByName.has(base) ? base : null;
    if (!found) {
      if (!missing.includes(name)) missing.push(name);
      return null;
    }
    const path = `images/${found}`;
    images.set(path, filesByName.get(found));
    return path;
  };
  const cards = [];
  textCards.forEach((c, i) => {
    const card = {
      front: c.front,
      back: c.back,
      important: c.important,
      frontImage: lookup(c.frontImageName),
      backImage: lookup(c.backImageName),
    };
    if (
      (card.front.trim() === "" && !card.frontImage) ||
      (card.back.trim() === "" && !card.backImage)
    ) {
      warnings.push(`${i + 1}枚目: 画像が見つからず中身が空になるためスキップしました`);
      return;
    }
    cards.push(card);
  });
  return { cards, images, missing, warnings };
}
