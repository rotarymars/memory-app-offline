// The service worker must cache every file the app loads, or the app breaks
// offline after the next change. These checks catch a file added without
// adding it to ASSETS, and a version bumped in one place only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION } from "../js/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sw = readFileSync(join(ROOT, "sw.js"), "utf8");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

function listedAssets() {
  const block = /const ASSETS = \[([\s\S]*?)\];/.exec(sw)[1];
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("sw.js VERSION matches APP_VERSION", () => {
  const version = /const VERSION = "([^"]+)"/.exec(sw)[1];
  assert.equal(version, APP_VERSION);
});

test("every served file is in ASSETS, and every ASSET exists", () => {
  const served = [
    ...walk(join(ROOT, "js")),
    ...walk(join(ROOT, "css")),
    ...walk(join(ROOT, "icons")),
    join(ROOT, "vendor/fflate/esm/browser.js"),
    join(ROOT, "index.html"),
    join(ROOT, "manifest.webmanifest"),
  ].map((p) => `./${relative(ROOT, p).split("\\").join("/")}`);
  const assets = listedAssets();
  assert.deepEqual([...assets].filter((a) => a !== "./").sort(), [...served].sort());
  for (const a of assets) {
    if (a === "./") continue;
    assert.ok(statSync(join(ROOT, a)).isFile(), a);
  }
});

test("every module import inside js/ points at a listed file", () => {
  const assets = new Set(listedAssets());
  for (const file of walk(join(ROOT, "js"))) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/^\s*(?:import|export)\s[^"']*?from\s+["'](\.[^"']+)["']/gm)) {
      const target = `./${relative(ROOT, join(dirname(file), m[1])).split("\\").join("/")}`;
      assert.ok(assets.has(target), `${relative(ROOT, file)} imports ${m[1]} (${target}) which is not in ASSETS`);
    }
  }
});

test("index.html and the manifest reference only cached files", () => {
  const assets = new Set(listedAssets());
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  for (const m of html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)) {
    assert.ok(assets.has(m[1]), `index.html → ${m[1]}`);
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.webmanifest"), "utf8"));
  for (const icon of manifest.icons) assert.ok(assets.has(`./${icon.src}`), icon.src);
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
});
