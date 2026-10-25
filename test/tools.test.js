// tools/make-pack.mjs and the pure mapping used by the migration script. The
// migration script itself talks to a database and is never run here — only
// syntax-checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackZip } from "../js/lib/pack-file.js";
import { decodeText, makePack } from "../tools/make-pack.mjs";
import { cardFromRow, detectImageType, isoOrNull } from "../tools/lib/migrate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures");
const CLI = join(ROOT, "tools", "make-pack.mjs");

function fixtureImage(name) {
  const path = join(FIXTURES, "images", name);
  return existsSync(path) ? { bytes: new Uint8Array(readFileSync(path)), type: "image/png" } : null;
}

test("makePack: ★, image lines, and a pack the app can read", () => {
  const text = readFileSync(join(FIXTURES, "sample.txt"), "utf8");
  const result = makePack({ text, name: "公共_ワークシート", readImage: fixtureImage });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.cards.length, 4);
  assert.equal(result.images.size, 2);

  const pack = parsePackZip(result.bytes);
  assert.equal(pack.name, "公共_ワークシート");
  assert.deepEqual(pack.warnings, []);
  assert.deepEqual(
    pack.cards.map((c) => [c.front.slice(0, 6), c.important, c.frontImage, c.backImage]),
    [
      ["仏滅後、正法", false, null, null],
      ["源信の著書で", true, null, null],
      ["この地図で赤", false, "images/map.png", "images/answer.png"],
      ["観想念仏と称", false, null, null],
    ]
  );
  assert.equal(pack.cards[2].back, "札幌");
  assert.equal(pack.cards[3].back, "観想念仏：頭の中で唱える\n称名念仏：声に出す\n公共10 p.1（手書き）");
  assert.deepEqual(pack.images.get("images/map.png").bytes, fixtureImage("map.png").bytes);
});

test("decodeText falls back to Shift_JIS", () => {
  assert.equal(decodeText(new TextEncoder().encode("日本語")), "日本語");
  assert.equal(decodeText(new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])), "日本語");
});

test("CLI: writes the pack, refuses to overwrite, and stops on missing images", () => {
  const dir = mkdtempSync(join(tmpdir(), "make-pack-"));
  try {
    const out = join(dir, "pack.zip");
    const ok = spawnSync(process.execPath, [CLI, join(FIXTURES, "sample.txt"), "--out", out], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /カード 4枚（★最重要 1枚）・画像 2枚/);
    assert.equal(parsePackZip(new Uint8Array(readFileSync(out))).cards.length, 4);

    const again = spawnSync(process.execPath, [CLI, join(FIXTURES, "sample.txt"), "--out", out], { encoding: "utf8" });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /--force/);

    const txt = join(dir, "missing.txt");
    writeFileSync(txt, "問題\n[img:front:nope.png]\n\n答え\n");
    const missing = spawnSync(process.execPath, [CLI, txt], { encoding: "utf8" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /nope\.png/);
    assert.equal(existsSync(join(dir, "missing.zip")), false);

    const allowed = spawnSync(process.execPath, [CLI, txt, "--allow-missing"], { encoding: "utf8" });
    assert.equal(allowed.status, 0, allowed.stderr);
    const pack = parsePackZip(new Uint8Array(readFileSync(join(dir, "missing.zip"))));
    assert.deepEqual([pack.cards[0].front, pack.cards[0].frontImage], ["問題", null]);

    const escape = join(dir, "escape.txt");
    writeFileSync(escape, "問題\n[img:front:../secret.png]\n\n答え\n");
    const blocked = spawnSync(process.execPath, [CLI, escape, "--images", FIXTURES], { encoding: "utf8" });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /画像フォルダの外/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: --help", () => {
  const out = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(out, /\[img:front:map\.png\]/);
});

test("migration script parses (it is never run by the tests)", () => {
  execFileSync(process.execPath, ["--check", join(ROOT, "tools", "export-from-memory-app.mjs")]);
});

test("migration mapping: tag → tags, important false, progress kept", async () => {
  const row = {
    id: 42,
    front: "Q",
    back: "A",
    tag: "地理",
    frontImageUrl: "https://example.public.blob.vercel-storage.com/a.png",
    backImageUrl: null,
    reviewLevel: 9,
    nextReviewAt: new Date("2026-11-01T00:00:00Z"),
    lastReviewedAt: "2026-10-29T00:00:00.000Z",
    againCount: 2,
    downCount: 1,
    goodCount: 7,
    greatCount: 3,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-10-29T00:00:00Z"),
  };
  const card = await cardFromRow(row, {
    id: "uuid-1",
    frontImage: "images/abc.png",
    backImage: null,
    frontImageHash: "f".repeat(64),
    backImageHash: null,
  });
  assert.deepEqual(
    { ...card, contentHash: typeof card.contentHash },
    {
      id: "uuid-1",
      front: "Q",
      back: "A",
      tags: ["地理"],
      important: false,
      frontImage: "images/abc.png",
      backImage: null,
      reviewLevel: 9,
      nextReviewAt: "2026-11-01T00:00:00.000Z",
      lastReviewedAt: "2026-10-29T00:00:00.000Z",
      againCount: 2,
      downCount: 1,
      goodCount: 7,
      greatCount: 3,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-10-29T00:00:00.000Z",
      contentHash: "string",
    }
  );
  const untagged = await cardFromRow({ ...row, tag: "", reviewLevel: 99 }, { id: "x", frontImage: null, backImage: null, frontImageHash: null, backImageHash: null });
  assert.deepEqual(untagged.tags, []);
  assert.equal(untagged.reviewLevel, 15);
  assert.equal(isoOrNull(null), null);
});

test("migration: image type from bytes, then header, then URL", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  assert.equal(detectImageType(png, "application/octet-stream", "https://x/a.bin"), "image/png");
  assert.equal(detectImageType(new Uint8Array([1, 2, 3, 4]), "image/jpeg", "https://x/a"), "image/jpeg");
  assert.equal(detectImageType(new Uint8Array([1, 2, 3, 4]), null, "https://x/photo.HEIC"), "image/heic");
  assert.equal(detectImageType(new Uint8Array([1, 2, 3, 4]), "text/html", "https://x/a"), null);
});
