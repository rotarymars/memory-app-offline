#!/usr/bin/env node
// One-time move from the online memory-app (Neon Postgres + Vercel Blob) to a
// study file for the offline app. Reads one account's cards, downloads their
// images, and writes memory-study_YYYY-MM-DD_HHMM.zip.
//
//   cd tools && npm install
//   DATABASE_URL='postgresql://…' node export-from-memory-app.mjs --user <username>
//
// Read-only: it runs SELECTs and downloads images, nothing else. Mapping:
//   tag → tags: [tag] · important: false · level, dates and the four answer
//   tallies kept as they are · daily.json starts empty (the online app keeps
//   no per-day history).

import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { studyFileName } from "../js/lib/format.js";
import { sha256Hex } from "../js/lib/hash.js";
import { imagePathFor } from "../js/lib/import-pack.js";
import { buildStudyZip, defaultSettings } from "../js/lib/study-file.js";
import { APP_VERSION } from "../js/version.js";
import { cardFromRow, detectImageType } from "./lib/migrate.mjs";

const USAGE = `使い方:
  cd tools && npm install
  DATABASE_URL='postgresql://…' node export-from-memory-app.mjs --user <ユーザー名> [--out <ファイル.zip>]

オプション:
  --user <ユーザー名>   移行するアカウント（users.username）
  --user-id <id>        アカウントのない user_id のカードを移行するとき
  --out <ファイル.zip>  出力先（省略時: カレントフォルダに memory-study_日付_時刻.zip）
  --force               出力先が既にあっても上書きする
  -h, --help            この説明を表示

DATABASE_URL は Neon コンソールの接続文字列です（Vercel からは取得できません）。`;

function parseArgs(argv) {
  const opts = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} の後に値が必要です`);
      return argv[++i];
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--user") opts.user = value();
    else if (a === "--user-id") opts.userId = value();
    else if (a === "--out") opts.out = value();
    else if (a === "--force") opts.force = true;
    else throw new Error(`不明な引数: ${a}`);
  }
  return opts;
}

async function loadNeon() {
  try {
    return (await import("@neondatabase/serverless")).neon;
  } catch {
    throw new Error(
      "@neondatabase/serverless が見つかりません。先に tools フォルダで `npm install` を実行してください。"
    );
  }
}

// Owners of cards, with account names where there is an account.
async function listOwners(sql) {
  return sql.query(
    `select c.user_id as "userId", u.username, count(*)::int as cards
       from cards c left join users u on u.id = c.user_id
      group by c.user_id, u.username
      order by u.username nulls last, c.user_id`
  );
}

async function resolveUserId(sql, opts) {
  if (opts.userId) return opts.userId;
  const owners = await listOwners(sql);
  if (opts.user) {
    const owner = owners.find((o) => o.username === opts.user);
    if (owner) return owner.userId;
    const [account] = await sql.query("select id from users where username = $1", [opts.user]);
    if (account) return account.id; // an account with no cards
    throw new Error(`ユーザー ${opts.user} が見つかりません`);
  }
  if (owners.length === 1) return owners[0].userId;
  const table = owners
    .map((o) => `  ${o.username ?? "（アカウントなし）"}  user_id=${o.userId}  カード${o.cards}枚`)
    .join("\n");
  throw new Error(`どのアカウントを移行するか --user で指定してください:\n${table}`);
}

async function download(url) {
  if (!/^https:\/\//i.test(url)) throw new Error("https の URL ではありません");
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const type = detectImageType(bytes, res.headers.get("content-type"), url);
      if (!type) throw new Error("画像の形式がわかりません");
      return { bytes, type };
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastError;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`エラー: 環境変数 DATABASE_URL がありません。\n\n${USAGE}`);
    return 1;
  }
  const now = new Date();
  const out = resolve(opts.out ?? studyFileName(now));
  if (existsSync(out) && !opts.force) {
    console.error(`エラー: ${out} は既にあります（上書きするなら --force）`);
    return 1;
  }

  const neon = await loadNeon();
  const sql = neon(url);
  const userId = await resolveUserId(sql, opts);
  const rows = await sql.query(
    `select id, front, back, tag,
            front_image_url as "frontImageUrl", back_image_url as "backImageUrl",
            review_level as "reviewLevel", next_review_at as "nextReviewAt",
            last_reviewed_at as "lastReviewedAt",
            again_count as "againCount", down_count as "downCount",
            good_count as "goodCount", great_count as "greatCount",
            created_at as "createdAt", updated_at as "updatedAt"
       from cards
      where user_id = $1
      order by created_at, id`,
    [userId]
  );
  console.log(`カード ${rows.length}枚を読み込みました（user_id=${userId}）`);

  // Each image URL once, even if several cards share it.
  const urls = [...new Set(rows.flatMap((r) => [r.frontImageUrl, r.backImageUrl]).filter(Boolean))];
  const images = new Map(); // study path → { bytes, type }
  const byUrl = new Map(); // url → { path, hash }
  const failures = [];
  for (const [i, imageUrl] of urls.entries()) {
    process.stdout.write(`画像をダウンロード中 ${i + 1}/${urls.length}\r`);
    try {
      const image = await download(imageUrl);
      const hash = await sha256Hex(image.bytes);
      const path = imagePathFor(hash, image.type);
      images.set(path, image);
      byUrl.set(imageUrl, { path, hash });
    } catch (err) {
      failures.push(`${imageUrl}: ${err?.message ?? err}`);
    }
  }
  if (urls.length) process.stdout.write("\n");

  const cards = [];
  for (const row of rows) {
    const front = row.frontImageUrl ? byUrl.get(row.frontImageUrl) : null;
    const back = row.backImageUrl ? byUrl.get(row.backImageUrl) : null;
    cards.push(
      await cardFromRow(row, {
        id: randomUUID(),
        frontImage: front?.path ?? null,
        backImage: back?.path ?? null,
        frontImageHash: front?.hash ?? null,
        backImageHash: back?.hash ?? null,
        now,
      })
    );
  }

  const lastChangeAt = cards.reduce((t, c) => (c.updatedAt > t ? c.updatedAt : t), "") || null;
  const bytes = buildStudyZip({
    cards,
    daily: {},
    settings: defaultSettings(),
    images,
    exportedAt: now.toISOString(),
    lastChangeAt,
    appVersion: APP_VERSION,
  });
  writeFileSync(out, bytes);

  const heic = [...images.values()].filter((img) => /heic|heif/.test(img.type)).length;
  console.log(`${out} を書き出しました: カード ${cards.length}枚・画像 ${images.size}枚`);
  if (heic) {
    console.warn(
      `注意: HEIC/HEIF の画像が ${heic}枚あります。Safari 以外では表示できないので、必要ならアプリの編集画面で画像を付け直してください。`
    );
  }
  if (failures.length) {
    console.warn(`注意: ダウンロードできなかった画像 ${failures.length}件（そのカードは画像なしで移行しました）:`);
    for (const f of failures) console.warn(`  - ${f}`);
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`エラー: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
);
