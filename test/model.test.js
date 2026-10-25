// Cards, tags, the daily tally, hashing and the open-file decision.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  applyAnswerToCard,
  createCard,
  filterCards,
  isDue,
  normalizeCard,
  referencedImages,
  reviewFieldsOf,
  sortNewestFirst,
} from "../js/lib/cards.js";
import {
  addToDaily,
  currentStreak,
  dailySeries,
  localDateKey,
  normalizeDaily,
  sumDaily,
} from "../js/lib/daily.js";
import { sha256Hex, sha256HexSync } from "../js/lib/hash.js";
import { randomId } from "../js/lib/ids.js";
import { sniffImageType } from "../js/lib/mime.js";
import { baselineChangeTime, changedOnDisk, decideOnOpen } from "../js/lib/snapshot.js";
import { splitBack } from "../js/lib/split-back.js";
import {
  collectTags,
  parseTagInput,
  suggestTagsFromFileName,
} from "../js/lib/tags.js";
import { studyFileName, safeFileName } from "../js/lib/format.js";

const NOW = new Date("2026-10-25T12:00:00Z");

test("parseTagInput splits on , 、 ， and drops blanks and repeats", () => {
  assert.deepEqual(parseTagInput("公共, 倫理、期末，公共 ,, "), ["公共", "倫理", "期末"]);
  assert.deepEqual(parseTagInput(""), []);
  assert.deepEqual(parseTagInput("  a   b  "), ["a b"]);
});

test("suggestTagsFromFileName", () => {
  assert.deepEqual(suggestTagsFromFileName("公共_ワークシート.txt"), [
    "公共_ワークシート",
    "公共",
    "ワークシート",
  ]);
  assert.deepEqual(suggestTagsFromFileName("/path/to/古文単語12.zip"), ["古文単語12"]);
  assert.deepEqual(suggestTagsFromFileName("memory-pack_地理.zip"), ["地理"]);
  assert.deepEqual(suggestTagsFromFileName("地理-pack.zip"), ["地理"]);
  assert.deepEqual(suggestTagsFromFileName("pack_2026-10-25.zip"), []);
  assert.deepEqual(suggestTagsFromFileName("古文単語_12.txt"), ["古文単語_12", "古文単語"]);
});

test("collectTags counts and sorts", () => {
  const cards = [{ tags: ["b", "a"] }, { tags: ["a"] }, { tags: [] }];
  assert.deepEqual(collectTags(cards), [
    { tag: "a", count: 2 },
    { tag: "b", count: 1 },
  ]);
});

test("createCard: new cards are due now, level 0, zero counts", () => {
  const card = createCard({ front: "Q", back: "A", tags: ["x", "x", " y "], important: 1 }, NOW);
  assert.match(card.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(card.tags, ["x", "y"]);
  assert.equal(card.important, true);
  assert.equal(card.reviewLevel, 0);
  assert.equal(card.nextReviewAt, NOW.toISOString());
  assert.equal(card.lastReviewedAt, null);
  assert.equal(card.againCount + card.downCount + card.goodCount + card.greatCount, 0);
  assert.ok(isDue(card, NOW));
  assert.equal("contentHash" in card, false);
});

test("randomId falls back to getRandomValues without randomUUID", () => {
  const original = globalThis.crypto.randomUUID;
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true });
    assert.match(randomId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    Object.defineProperty(globalThis.crypto, "randomUUID", { value: original, configurable: true });
  }
});

test("applyAnswerToCard moves the level, schedules, and counts; undo restores", () => {
  const card = { ...createCard({ front: "Q", back: "A" }, NOW), reviewLevel: 5 };
  const before = reviewFieldsOf(card);
  const later = new Date(NOW.getTime() + 60_000);
  const answered = applyAnswerToCard(card, "again", 3, later);
  assert.equal(answered.reviewLevel, 3);
  assert.equal(answered.againCount, 1);
  assert.equal(answered.lastReviewedAt, later.toISOString());
  assert.equal(answered.updatedAt, later.toISOString());
  assert.equal(answered.nextReviewAt, new Date(later.getTime() + 2 * 3_600_000).toISOString());
  assert.equal(card.againCount, 0, "input not mutated");
  assert.deepEqual({ ...answered, ...before }, card);
});

test("normalizeCard fills gaps and drops missing images", () => {
  const { card, warnings } = normalizeCard(
    {
      id: "abc",
      front: 12,
      tag: "legacy",
      important: "true",
      frontImage: "images/a.webp",
      backImage: "images/missing.webp",
      reviewLevel: 99.7,
      nextReviewAt: "not a date",
      againCount: -3,
      goodCount: "4",
    },
    { hasImage: (p) => p === "images/a.webp", now: NOW }
  );
  assert.equal(card.id, "abc");
  assert.equal(card.front, "12");
  assert.equal(card.back, "");
  assert.deepEqual(card.tags, ["legacy"]);
  assert.equal(card.important, true);
  assert.equal(card.frontImage, "images/a.webp");
  assert.equal(card.backImage, null);
  assert.equal(card.reviewLevel, 15);
  assert.equal(card.nextReviewAt, NOW.toISOString());
  assert.equal(card.againCount, 0);
  assert.equal(card.goodCount, 4);
  assert.equal(warnings.length, 1);
  assert.equal(normalizeCard("nope", { hasImage: () => false }).card, null);
});

test("filterCards: tags any-of, untagged, important, due, search", () => {
  const mk = (front, tags, important, due) => ({
    ...createCard({ front, back: "答え", tags, important }, NOW),
    nextReviewAt: new Date(NOW.getTime() + (due ? -1 : 1) * 3_600_000).toISOString(),
  });
  const a = mk("Ａｐｐｌｅ りんご", ["英語"], true, true);
  const b = mk("源信", ["公共", "倫理"], false, false);
  const c = mk("無題", [], true, false);
  const all = [a, b, c];
  const fronts = (list) => list.map((x) => x.front);
  assert.deepEqual(fronts(filterCards(all, {}, NOW)), fronts(all));
  assert.deepEqual(fronts(filterCards(all, { tags: ["倫理", "英語"] }, NOW)), [a.front, b.front]);
  assert.deepEqual(fronts(filterCards(all, { untagged: true }, NOW)), [c.front]);
  assert.deepEqual(fronts(filterCards(all, { tags: ["公共"], untagged: true }, NOW)), [b.front, c.front]);
  assert.deepEqual(fronts(filterCards(all, { importantOnly: true }, NOW)), [a.front, c.front]);
  assert.deepEqual(fronts(filterCards(all, { dueOnly: true }, NOW)), [a.front]);
  assert.deepEqual(fronts(filterCards(all, { query: "apple" }, NOW)), [a.front]);
  assert.deepEqual(fronts(filterCards(all, { query: "倫理 源" }, NOW)), [b.front]);
  assert.deepEqual(fronts(filterCards(all, { query: "倫理 りんご" }, NOW)), []);
  assert.deepEqual(fronts(filterCards(all, { importantOnly: true, tags: ["英語"], dueOnly: true }, NOW)), [a.front]);
});

test("sortNewestFirst keeps import order for cards created together", () => {
  const t1 = new Date("2026-10-01T00:00:00Z");
  const x = createCard({ front: "1" }, t1);
  const y = createCard({ front: "2" }, NOW);
  const z = createCard({ front: "3" }, NOW);
  assert.deepEqual(sortNewestFirst([x, y, z]).map((c) => c.front), ["2", "3", "1"]);
});

test("referencedImages", () => {
  const cards = [
    { frontImage: "images/a", backImage: null },
    { frontImage: "images/a", backImage: "images/b" },
  ];
  assert.deepEqual([...referencedImages(cards)].sort(), ["images/a", "images/b"]);
});

test("daily tally: local date keys, add, undo, normalize", () => {
  assert.equal(localDateKey(new Date(2026, 9, 5, 23, 59)), "2026-10-05");
  let d = {};
  d = addToDaily(d, "2026-10-25", "good");
  d = addToDaily(d, "2026-10-25", "good");
  d = addToDaily(d, "2026-10-25", "again");
  assert.deepEqual(d, { "2026-10-25": { again: 1, down: 0, good: 2, great: 0 } });
  d = addToDaily(d, "2026-10-25", "again", -1);
  d = addToDaily(d, "2026-10-25", "good", -1);
  d = addToDaily(d, "2026-10-25", "good", -1);
  assert.deepEqual(d, {}, "a day back to zero is removed");
  assert.deepEqual(
    normalizeDaily({ "2026-10-25": { again: 3, good: "40", great: -1 }, junk: { good: 1 }, "2026-10-01": { good: 0 } }),
    { "2026-10-25": { again: 3, down: 0, good: 40, great: 0 } }
  );
  assert.deepEqual(normalizeDaily(null), {});
});

test("dailySeries fills empty days, oldest first; sumDaily; streak", () => {
  const daily = {
    "2026-10-23": { again: 1, down: 0, good: 2, great: 0 },
    "2026-10-25": { again: 0, down: 1, good: 0, great: 4 },
  };
  const today = new Date(2026, 9, 25, 9, 0);
  const series = dailySeries(daily, 3, today);
  assert.deepEqual(series.map((s) => [s.key, s.total]), [
    ["2026-10-23", 3],
    ["2026-10-24", 0],
    ["2026-10-25", 5],
  ]);
  assert.deepEqual(sumDaily(daily), { again: 1, down: 1, good: 2, great: 4 });
  assert.equal(currentStreak(daily, today), 1);
  assert.equal(currentStreak({ "2026-10-24": daily["2026-10-23"] }, today), 1, "yesterday still counts");
  assert.equal(currentStreak({}, today), 0);
});

test("sha256: pure-JS fallback matches node:crypto", async () => {
  const samples = [
    new Uint8Array(0),
    new TextEncoder().encode("abc"),
    new TextEncoder().encode("日本語のテキスト★"),
    new Uint8Array(55).fill(7),
    new Uint8Array(56).fill(7),
    new Uint8Array(64).fill(255),
    Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) & 255),
  ];
  for (const bytes of samples) {
    const expected = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256HexSync(bytes), expected);
    assert.equal(await sha256Hex(bytes), expected);
  }
  assert.equal(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("sniffImageType", () => {
  assert.equal(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])), "image/png");
  assert.equal(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="">')), "image/svg+xml");
  assert.equal(sniffImageType(new TextEncoder().encode("hello world")), null);
});

test("splitBack: answer, note after a blank line, source lines", () => {
  assert.deepEqual(splitBack("末法思想\n公共10 p.1 空欄1"), {
    answer: "末法思想\n公共10 p.1 空欄1",
    note: "",
    source: "",
  });
  assert.deepEqual(splitBack("答え\n\n解説の行\n出典：教科書 p.3\nSource: wiki"), {
    answer: "答え",
    note: "解説の行",
    source: "出典：教科書 p.3\nSource: wiki",
  });
});

test("studyFileName / safeFileName", () => {
  assert.equal(studyFileName(new Date(2026, 9, 5, 7, 3)), "memory-study_2026-10-05_0703.zip");
  assert.equal(safeFileName('a/b:c*?"<>|'), "a_b_c______");
  assert.equal(safeFileName("  "), "pack");
});

test("decideOnOpen: unexported changes newer than the file → device copy is newer", () => {
  const d = decideOnOpen(
    { dirty: true, lastChangeAt: "2026-10-25T00:00:00Z", cardCount: 10 },
    { exportedAt: "2026-10-24T00:00:00Z", latestEditAt: "2026-10-24T00:00:00Z" },
    null
  );
  assert.deepEqual([d.offerRestore, d.reason, d.deviceNewer, d.olderThanLastExport], [true, "unexported", true, false]);
});

test("decideOnOpen: unexported changes OLDER than the file are offered, but not as newer", () => {
  // Forgot to export on this device on 10/20, then studied elsewhere and
  // exported there on 10/25: both sides have changes; the file is newer.
  const d = decideOnOpen(
    { dirty: true, lastChangeAt: "2026-10-20T00:00:00Z", cardCount: 10 },
    { exportedAt: "2026-10-25T00:00:00Z", latestEditAt: "2026-10-24T23:00:00Z" },
    null
  );
  assert.deepEqual([d.offerRestore, d.reason, d.deviceNewer], [true, "unexported", false]);
});

test("decideOnOpen: a clean copy newer than the file is offered", () => {
  const d = decideOnOpen(
    { dirty: false, lastChangeAt: "2026-10-25T00:00:00Z", cardCount: 10 },
    { exportedAt: "2026-10-24T00:00:00Z", latestEditAt: null },
    { exportedAt: "2026-10-25T01:00:00Z" }
  );
  assert.deepEqual([d.offerRestore, d.reason, d.deviceNewer, d.olderThanLastExport], [true, "newer", true, true]);
});

test("decideOnOpen: reopening the file you just exported asks nothing", () => {
  const exported = "2026-10-25T01:00:00.000Z";
  const d = decideOnOpen(
    { dirty: false, lastChangeAt: "2026-10-25T00:59:00Z", cardCount: 10 },
    { exportedAt: exported, latestEditAt: "2026-10-25T00:59:00Z" },
    { exportedAt: exported }
  );
  assert.deepEqual([d.offerRestore, d.olderThanLastExport], [false, false]);
});

test("decideOnOpen: a file exported elsewhere later is fine", () => {
  const d = decideOnOpen(
    { dirty: false, lastChangeAt: "2026-10-20T00:00:00Z", cardCount: 10 },
    { exportedAt: "2026-10-24T00:00:00Z", latestEditAt: null },
    { exportedAt: "2026-10-20T00:01:00Z" }
  );
  assert.deepEqual([d.offerRestore, d.olderThanLastExport], [false, false]);
});

test("decideOnOpen: no copy, or an empty untouched one, asks nothing", () => {
  const file = { exportedAt: "2026-10-24T00:00:00Z", latestEditAt: null };
  assert.equal(decideOnOpen(null, file, null).offerRestore, false);
  assert.equal(
    decideOnOpen({ dirty: false, lastChangeAt: "2026-10-25T00:00:00Z", cardCount: 0 }, file, null).offerRestore,
    false
  );
});

test("changedOnDisk: only a later exportedAt on disk counts as someone else's save", () => {
  assert.equal(changedOnDisk("2026-10-25T00:00:00Z", "2026-10-25T00:00:00.000Z"), false);
  assert.equal(changedOnDisk("2026-10-25T00:00:00Z", "2026-10-24T00:00:00Z"), false);
  assert.equal(changedOnDisk("2026-10-25T00:00:00Z", "2026-10-25T00:00:01Z"), true);
  assert.equal(changedOnDisk(null, "2026-10-25T00:00:00Z"), true);
  assert.equal(changedOnDisk("2026-10-25T00:00:00Z", null), false);
});

test("baselineChangeTime is the file's newest time", () => {
  assert.equal(
    baselineChangeTime({ exportedAt: "2026-10-24T00:00:00Z", latestEditAt: "2026-10-23T00:00:00Z" }),
    "2026-10-24T00:00:00.000Z"
  );
  assert.equal(baselineChangeTime({ exportedAt: null, latestEditAt: null }), null);
});
