#!/usr/bin/env node
// Turns a .txt of cards (the blank-line format, with the ★ and [img:…] rules)
// plus its image files into a card pack .zip for the app's 「取り込み」 screen.
//
//   node tools/make-pack.mjs 公共_ワークシート.txt
//   node tools/make-pack.mjs cards.txt --images ./figs --out 地理.zip --name 地理
//
// Reads the .txt the same way the app does (js/lib/card-text.js), so a file
// that makes a good pack also imports fine as a plain .txt. Needs nothing but
// Node and the fflate copy in vendor/.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCardText } from "../js/lib/card-text.js";
import { imageNameKey, packFromTextCards } from "../js/lib/import-pack.js";
import { imageTypeFromName, sniffImageType } from "../js/lib/mime.js";
import { buildPackZip } from "../js/lib/pack-file.js";
import { APP_VERSION } from "../js/version.js";

const BIG_IMAGE_BYTES = 1.5 * 1024 * 1024;

const USAGE = `使い方:
  node tools/make-pack.mjs <カード.txt> [オプション]

オプション:
  --images <フォルダ>   [img:…] の画像を探すフォルダ
                        （省略時: .txt と同じフォルダ、次にその中の images/）
  --out <ファイル.zip>  出力先（省略時: .txt と同じ場所に <名前>.zip）
  --name <パック名>     pack.json の name（省略時: .txt のファイル名）
  --force               出力先が既にあっても上書きする
  --allow-missing       見つからない画像があっても、画像なしで作る
  -h, --help            この説明を表示

.txt の書き方:
  表 → 空行 → 裏 → 空行 → 次の表 …（表・裏とも複数行可）
  表の先頭が ★ のカードは最重要（★ は取り除かれる）
  [img:front:map.png] / [img:back:map.png] の行で、そのカードの表/裏に画像を付ける`;

/** UTF-8 first; text saved by older Windows tools may be Shift_JIS. */
export function decodeText(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

/**
 * Builds the pack. Pure apart from `readImage`, so tests can feed it files.
 * @param {object} args
 * @param {string} args.text
 * @param {string} args.name
 * @param {(name: string) => ({ bytes: Uint8Array, type: string } | null)} args.readImage
 * @param {Date} [args.now]
 */
export function makePack({ text, name, readImage, now = new Date() }) {
  const parsed = parseCardText(text);
  const files = new Map();
  for (const card of parsed.cards) {
    for (const ref of [card.frontImageName, card.backImageName]) {
      if (!ref) continue;
      const key = imageNameKey(ref);
      if (files.has(key)) continue;
      const image = readImage(key);
      if (image) files.set(key, image);
    }
  }
  const pack = packFromTextCards(parsed.cards, files);
  const bytes = buildPackZip({
    name,
    cards: pack.cards,
    images: pack.images,
    createdAt: now.toISOString(),
    appVersion: APP_VERSION,
  });
  return {
    bytes,
    cards: pack.cards,
    images: pack.images,
    missing: pack.missing,
    warnings: [...parsed.warnings, ...pack.warnings],
  };
}

function parseArgs(argv) {
  const opts = { force: false, allowMissing: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} の後に値が必要です`);
      return argv[++i];
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--images") opts.images = value();
    else if (a === "--out") opts.out = value();
    else if (a === "--name") opts.name = value();
    else if (a === "--force") opts.force = true;
    else if (a === "--allow-missing") opts.allowMissing = true;
    else if (a.startsWith("--")) throw new Error(`不明なオプション: ${a}`);
    else rest.push(a);
  }
  if (rest.length > 1) throw new Error("入力する .txt は1つだけ指定してください");
  opts.input = rest[0];
  return opts;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(`エラー: ${err.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help || !opts.input) {
    console.log(USAGE);
    return opts.help ? 0 : 1;
  }

  const input = resolve(opts.input);
  if (!existsSync(input) || !statSync(input).isFile()) {
    console.error(`エラー: ${opts.input} が見つかりません`);
    return 1;
  }
  const base = basename(input, extname(input));
  const imageDirs = opts.images
    ? [resolve(opts.images)]
    : [dirname(input), join(dirname(input), "images")];
  const out = resolve(opts.out ?? join(dirname(input), `${base}.zip`));
  const name = opts.name ?? base;

  if (existsSync(out) && !opts.force) {
    console.error(`エラー: ${out} は既にあります（上書きするなら --force）`);
    return 1;
  }

  const notes = [];
  const readImage = (key) => {
    // Only files inside the images folder.
    if (isAbsolute(key) || key.split("/").includes("..")) {
      notes.push(`画像 ${key}: 画像フォルダの外は参照できません`);
      return null;
    }
    const path = imageDirs.map((dir) => join(dir, key)).find((p) => existsSync(p) && statSync(p).isFile());
    if (!path) return null;
    const bytes = new Uint8Array(readFileSync(path));
    const type = imageTypeFromName(path) ?? sniffImageType(bytes);
    if (!type) {
      notes.push(`画像 ${key}: 画像として認識できません`);
      return null;
    }
    if (bytes.length > BIG_IMAGE_BYTES) {
      notes.push(
        `画像 ${key} は ${(bytes.length / 1024 / 1024).toFixed(1)} MB あります（アプリが取り込むときに長辺1200pxへ縮小します）`
      );
    }
    return { bytes, type };
  };

  const result = makePack({ text: decodeText(readFileSync(input)), name, readImage });

  for (const w of [...result.warnings, ...notes]) console.warn(`注意: ${w}`);
  if (result.missing.length > 0) {
    const list = result.missing.map((m) => `  - ${m}`).join("\n");
    if (!opts.allowMissing) {
      console.error(
        `エラー: 見つからない画像があります（探した場所: ${imageDirs.join(", ")}）:\n${list}\n画像なしで作るなら --allow-missing を付けてください。`
      );
      return 1;
    }
    console.warn(`注意: 見つからない画像は付けずに作りました:\n${list}`);
  }
  if (result.cards.length === 0) {
    console.error("エラー: カードが1枚も見つかりませんでした（表と裏の間に空行がありますか？）");
    return 1;
  }

  writeFileSync(out, result.bytes);
  const important = result.cards.filter((c) => c.important).length;
  console.log(
    `${out} を作りました: カード ${result.cards.length}枚（★最重要 ${important}枚）・画像 ${result.images.size}枚`
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
