// Study file and card pack (de)serialization, and importing packs with
// duplicate detection.

import { test } from "node:test";
import assert from "node:assert/strict";
import { strToU8, unzipSync, zipSync } from "../vendor/fflate/esm/browser.js";
import { createCard, applyAnswerToCard } from "../js/lib/cards.js";
import { parseCardText } from "../js/lib/card-text.js";
import { sha256Hex } from "../js/lib/hash.js";
import {
  contentHashOf,
  importPackCards,
  packFromTextCards,
} from "../js/lib/import-pack.js";
import { buildPackZip, parsePackZip } from "../js/lib/pack-file.js";
import {
  buildStudyZip,
  parseStudyZip,
  peekStudyMeta,
  STUDY_FORMAT_VERSION,
} from "../js/lib/study-file.js";

const NOW = new Date("2026-10-25T12:00:00Z");
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);

function sampleStudy() {
  const a = createCard({ front: "源信の著書は？", back: "『往生要集』", tags: ["公共", "倫理"], important: true, frontImage: "images/a.png" }, NOW);
  const b = applyAnswerToCard(createCard({ front: "Q2", back: "A2\n\n解説" }, NOW), "good", 1, NOW);
  return {
    cards: [a, b],
    daily: { "2026-10-25": { again: 0, down: 0, good: 1, great: 0 } },
    settings: { reviewOrder: "low" },
    images: new Map([
      ["images/a.png", { bytes: PNG, type: "image/png" }],
      ["images/unused.png", { bytes: PNG2, type: "image/png" }],
    ]),
  };
}

test("study zip round trip keeps cards, daily, settings and images", () => {
  const data = sampleStudy();
  const zip = buildStudyZip({
    ...data,
    exportedAt: NOW.toISOString(),
    lastChangeAt: NOW.toISOString(),
    appVersion: "1.0.0",
  });
  const names = Object.keys(unzipSync(zip)).sort();
  assert.deepEqual(names, ["cards.json", "daily.json", "images/a.png", "meta.json"], "unused images are left out");

  const parsed = parseStudyZip(zip, { now: NOW });
  assert.deepEqual(parsed.cards, data.cards);
  assert.deepEqual(parsed.daily, data.daily);
  assert.deepEqual(parsed.settings, { reviewOrder: "low" });
  assert.deepEqual([...parsed.images.keys()], ["images/a.png"]);
  assert.deepEqual(parsed.images.get("images/a.png"), { bytes: PNG, type: "image/png" });
  assert.equal(parsed.exportedAt, NOW.toISOString());
  assert.equal(parsed.formatVersion, STUDY_FORMAT_VERSION);
  assert.deepEqual(parsed.warnings, []);
});

test("meta.json carries the format version, times and settings", () => {
  const zip = buildStudyZip({ ...sampleStudy(), exportedAt: NOW.toISOString(), lastChangeAt: null, appVersion: "9.9.9" });
  const meta = JSON.parse(new TextDecoder().decode(unzipSync(zip)["meta.json"]));
  assert.deepEqual(meta, {
    format: "memory-study",
    formatVersion: 1,
    exportedAt: NOW.toISOString(),
    lastChangeAt: null,
    appVersion: "9.9.9",
    cardCount: 2,
    imageCount: 1,
    settings: { reviewOrder: "low" },
  });
});

test("peekStudyMeta reads exportedAt without unpacking the rest", () => {
  const zip = buildStudyZip({ ...sampleStudy(), exportedAt: NOW.toISOString(), lastChangeAt: null, appVersion: "1" });
  assert.deepEqual(peekStudyMeta(zip), { format: "memory-study", exportedAt: NOW.toISOString() });
  const nested = zipSync({ "x/meta.json": strToU8('{"exportedAt":"2026-01-02T03:04:05Z"}'), "x/cards.json": strToU8("[]") });
  assert.deepEqual(peekStudyMeta(nested), { format: null, exportedAt: "2026-01-02T03:04:05.000Z" });
  assert.equal(peekStudyMeta(new Uint8Array([1, 2, 3])), null);
  assert.equal(peekStudyMeta(zipSync({ "pack.json": strToU8("[]") })), null);
});

test("parseStudyZip: files inside a top-level folder (macOS Compress)", () => {
  const zip = zipSync({
    "my-study/meta.json": strToU8(JSON.stringify({ format: "memory-study", formatVersion: 1 })),
    "my-study/cards.json": strToU8(JSON.stringify([{ id: "x", front: "f", back: "b", frontImage: "images/p.png" }])),
    "my-study/images/p.png": PNG,
    "__MACOSX/my-study/._cards.json": strToU8("junk"),
  });
  const parsed = parseStudyZip(zip, { now: NOW });
  assert.equal(parsed.cards.length, 1);
  assert.equal(parsed.cards[0].frontImage, "images/p.png");
  assert.equal(parsed.images.get("images/p.png").type, "image/png");
});

test("parseStudyZip: friendly errors", () => {
  assert.throws(() => parseStudyZip(new Uint8Array([1, 2, 3, 4])), { kind: "not-zip" });
  assert.throws(() => parseStudyZip(zipSync({ "x.txt": strToU8("hi") })), { kind: "not-study" });
  assert.throws(() => parseStudyZip(zipSync({ "pack.json": strToU8("[]") })), { kind: "is-pack" });
  assert.throws(
    () => parseStudyZip(zipSync({ "meta.json": strToU8('{"formatVersion": 2}'), "cards.json": strToU8("[]") })),
    { kind: "too-new" }
  );
  assert.throws(() => parseStudyZip(zipSync({ "cards.json": strToU8("{nope") })), { kind: "bad-json" });
  assert.throws(() => parseStudyZip(zipSync({ "cards.json": strToU8("{}") })), { kind: "not-study" });
});

test("parseStudyZip: duplicate ids and missing images are repaired with warnings", () => {
  const zip = zipSync({
    "meta.json": strToU8("{}"),
    "cards.json": strToU8(
      JSON.stringify([
        { id: "same", front: "1", back: "1" },
        { id: "same", front: "2", back: "2", backImage: "images/gone.png" },
      ])
    ),
  });
  const parsed = parseStudyZip(zip, { now: NOW });
  assert.equal(parsed.cards.length, 2);
  assert.notEqual(parsed.cards[0].id, parsed.cards[1].id);
  assert.equal(parsed.cards[1].backImage, null);
  assert.equal(parsed.warnings.length, 2);
});

test("pack zip round trip; packs carry no progress or tags", () => {
  const zip = buildPackZip({
    name: "地理",
    cards: [
      { front: "Q", back: "A", important: true, frontImage: "images/q.png", backImage: null },
      { front: "Q2", back: "A2", important: false, frontImage: null, backImage: null },
    ],
    images: new Map([["images/q.png", { bytes: PNG, type: "image/png" }]]),
    createdAt: NOW.toISOString(),
    appVersion: "1.0.0",
  });
  const json = JSON.parse(new TextDecoder().decode(unzipSync(zip)["pack.json"]));
  assert.equal(json.format, "memory-pack");
  assert.deepEqual(Object.keys(json.cards[0]).sort(), ["back", "backImage", "front", "frontImage", "important"]);
  const pack = parsePackZip(zip);
  assert.equal(pack.name, "地理");
  assert.equal(pack.cards.length, 2);
  assert.equal(pack.cards[0].frontImage, "images/q.png");
  assert.deepEqual(pack.warnings, []);
});

test("parsePackZip: lenient with hand-made packs", () => {
  const zip = zipSync({
    "pack.json": strToU8(
      JSON.stringify([
        { front: "Q", back: "A", frontImage: "q.png" },
        { front: "", back: "A" },
        { front: "Q3", back: "A3", backImage: "images/missing.png" },
      ])
    ),
    "images/q.png": PNG,
  });
  const pack = parsePackZip(zip);
  assert.deepEqual(
    pack.cards.map((c) => [c.front, c.frontImage, c.backImage]),
    [
      ["Q", "images/q.png", null],
      ["Q3", null, null],
    ]
  );
  assert.equal(pack.warnings.length, 2);
  assert.throws(() => parsePackZip(zipSync({ "cards.json": strToU8("[]") })), { kind: "is-study" });
});

async function hashOfImages(images) {
  return async (path) => (images.has(path) ? sha256Hex(images.get(path).bytes) : null);
}

test("importPackCards adds with tags/important, then skips the same pack", async () => {
  const pack = {
    cards: [
      { front: "Q1", back: "A1", important: false, frontImage: "images/p.png", backImage: null },
      { front: "Q2", back: "A2", important: true, frontImage: null, backImage: null },
      { front: "Q1", back: "A1", important: false, frontImage: "images/p.png", backImage: null },
    ],
    images: new Map([["images/p.png", { bytes: PNG, type: "image/png" }]]),
  };
  const studyImages = new Map();
  const first = await importPackCards({
    existingCards: [],
    imageHashOf: await hashOfImages(studyImages),
    packCards: pack.cards,
    packImages: pack.images,
    tags: ["地理", "期末"],
    markImportant: false,
    now: NOW,
  });
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 1, "the repeat inside the pack is skipped");
  assert.deepEqual(first.cards.map((c) => [c.front, c.important, c.tags]), [
    ["Q1", false, ["地理", "期末"]],
    ["Q2", true, ["地理", "期末"]],
  ]);
  const [path] = first.images.keys();
  assert.match(path, /^images\/[0-9a-f]{32}\.png$/);
  assert.equal(first.cards[0].frontImage, path);
  assert.ok(first.cards.every((c) => typeof c.contentHash === "string"));
  for (const [p, img] of first.images) studyImages.set(p, img);

  const again = await importPackCards({
    existingCards: first.cards,
    imageHashOf: await hashOfImages(studyImages),
    packCards: pack.cards,
    packImages: pack.images,
    tags: [],
    markImportant: true,
    now: NOW,
  });
  assert.deepEqual([again.added, again.skipped], [0, 3]);
});

test("importPackCards: an edited card is still recognised; re-encoded images too", async () => {
  // The pack image gets "re-encoded" on the way in (prepareImage), so the
  // stored bytes differ from the pack's — the stored contentHash still matches.
  const pack = {
    cards: [{ front: "Q", back: "A", important: false, frontImage: "images/p.png", backImage: null }],
    images: new Map([["images/p.png", { bytes: PNG, type: "image/png" }]]),
  };
  const prepareImage = async () => ({ bytes: new Uint8Array([1, 2, 3, 4, 5]), type: "image/webp" });
  const studyImages = new Map();
  const first = await importPackCards({
    existingCards: [],
    imageHashOf: await hashOfImages(studyImages),
    packCards: pack.cards,
    packImages: pack.images,
    tags: [],
    markImportant: true,
    now: NOW,
    prepareImage,
  });
  assert.equal(first.cards[0].important, true, "markImportant");
  assert.match(first.cards[0].frontImage, /\.webp$/);
  for (const [p, img] of first.images) studyImages.set(p, img);

  const edited = { ...first.cards[0], front: "Q (fixed typo)" };
  const again = await importPackCards({
    existingCards: [edited],
    imageHashOf: await hashOfImages(studyImages),
    packCards: pack.cards,
    packImages: pack.images,
    tags: [],
    markImportant: false,
    now: NOW,
    prepareImage,
  });
  assert.deepEqual([again.added, again.skipped], [0, 1]);
});

test("importPackCards: an existing card without contentHash is matched by content", async () => {
  const existing = createCard({ front: " Q\r\n2 ", back: "A" }, NOW); // whitespace/CRLF differences
  const result = await importPackCards({
    existingCards: [existing],
    imageHashOf: async () => null,
    packCards: [{ front: "Q\n2", back: "A", important: false, frontImage: null, backImage: null }],
    packImages: new Map(),
    tags: [],
    markImportant: false,
    now: NOW,
  });
  assert.deepEqual([result.added, result.skipped], [0, 1]);
});

test("contentHashOf depends on front, back and both image hashes", async () => {
  const base = { front: "Q", back: "A", frontImageHash: null, backImageHash: null };
  const h = await contentHashOf(base);
  assert.notEqual(await contentHashOf({ ...base, back: "B" }), h);
  assert.notEqual(await contentHashOf({ ...base, frontImageHash: "x" }), h);
  assert.notEqual(await contentHashOf({ ...base, frontImageHash: "x" }), await contentHashOf({ ...base, backImageHash: "x" }));
  assert.equal(await contentHashOf({ ...base, front: "Q\n" }), h);
});

test(".txt → pack cards with images picked alongside", () => {
  const { cards } = parseCardText("★地図の都市は？\n[img:front:sub/map.png]\n\n札幌\n\nQ2\n[img:front:nope.png]\n\nA2\n\n[img:front:nope.png]\n\nA3");
  const files = new Map([["map.png", { bytes: PNG, type: "image/png" }]]);
  const pack = packFromTextCards(cards, files);
  assert.deepEqual(pack.missing, ["nope.png"]);
  assert.equal(pack.warnings.length, 1, "the image-only card with a missing image is dropped");
  assert.deepEqual(
    pack.cards.map((c) => [c.front, c.important, c.frontImage]),
    [
      ["地図の都市は？", true, "images/map.png"],
      ["Q2", false, null],
    ]
  );
  assert.ok(pack.images.has("images/map.png"));
});
