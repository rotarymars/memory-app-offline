// Importing cards into the study data: a card pack (.zip), a .txt in the
// usual blank-line format (optionally with its image files picked alongside),
// or pasted text. Asks for tags for everything imported, skips cards the
// study data already has, and reports how many were added and skipped.

import { parseCardText } from "../lib/card-text.js";
import { importPackCards, packFromTextCards } from "../lib/import-pack.js";
import { imageTypeFromName, sniffImageType } from "../lib/mime.js";
import { parsePackZip } from "../lib/pack-file.js";
import { collectTags, formatTagInput, parseTagInput, suggestTagsFromFileName } from "../lib/tags.js";
import { FileFormatError } from "../lib/zip.js";
import { h, mount } from "../ui/dom.js";
import { pickFiles } from "../ui/files.js";
import { imageFilesFrom, prepareImportedImage } from "../ui/images.js";
import { busy, toast } from "../ui/modal.js";
import { getState, imageHashOf, update } from "../ui/store.js";
import { takePendingImport } from "../ui/study.js";
import { reviewHref } from "./review.js";

const ACCEPT = ".zip,.txt,application/zip,text/plain,image/*";

const PLACEHOLDER = `★源信の著書で、後代に大きな影響を与えたものは何か。

『往生要集』
公共10 p.1

末法思想で、証（悟り）がない千年の時代を何というか。

像法（ぞうぼう）`;

/**
 * @typedef {object} Candidate
 * @property {string} sourceName
 * @property {import("../lib/pack-file.js").PackCard[]} cards
 * @property {Map<string, { bytes: Uint8Array, type: string }>} images
 * @property {string[]} warnings
 * @property {string[]} suggestions
 */

/** Text files from Windows are sometimes Shift_JIS rather than UTF-8. */
async function readText(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder("shift_jis").decode(bytes);
    } catch {
      return new TextDecoder("utf-8").decode(bytes);
    }
  }
}

async function imageMapFrom(files) {
  const map = new Map();
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = file.type || imageTypeFromName(file.name) || sniffImageType(bytes);
    if (type) map.set(file.name.normalize("NFC"), { bytes, type });
  }
  return map;
}

function fromText(text, sourceName, imageFiles = new Map()) {
  const parsed = parseCardText(text);
  const pack = packFromTextCards(parsed.cards, imageFiles);
  const warnings = [...parsed.warnings, ...pack.warnings];
  if (pack.missing.length > 0) {
    warnings.unshift(
      `画像ファイルが見つかりません: ${pack.missing.join(", ")}（.txt と一緒に画像ファイルも選んでください。見つからない画像は付けずに取り込みます）`
    );
  }
  return {
    sourceName,
    cards: pack.cards,
    images: pack.images,
    warnings,
    suggestions: sourceName ? suggestTagsFromFileName(sourceName) : [],
  };
}

/**
 * Reads what the user picked or dropped into a list of cards to import.
 * @param {File[]} files
 * @returns {Promise<Candidate>}
 */
async function candidateFromFiles(files) {
  const sources = files.filter((f) => /\.(zip|txt)$/i.test(f.name) || f.type === "text/plain" || /zip/.test(f.type));
  const images = imageFilesFrom(files);
  if (sources.length === 0) {
    throw new Error(
      images.length > 0
        ? "画像だけでは取り込めません。.txt（[img:front:ファイル名] の行で画像を指定）と一緒に選んでください。"
        : "カードパック（.zip）か .txt ファイルを選んでください。"
    );
  }
  if (sources.length > 1) {
    throw new Error("一度に取り込めるのは 1 ファイルです（.txt に添える画像は何枚でも選べます）。");
  }
  const [source] = sources;
  if (/\.txt$/i.test(source.name) || source.type === "text/plain") {
    return fromText(await readText(source), source.name, await imageMapFrom(images));
  }
  const pack = parsePackZip(new Uint8Array(await source.arrayBuffer()));
  const suggestions = suggestTagsFromFileName(source.name);
  if (pack.name) {
    for (const t of suggestTagsFromFileName(pack.name)) if (!suggestions.includes(t)) suggestions.push(t);
  }
  return {
    sourceName: source.name,
    cards: pack.cards,
    images: pack.images,
    warnings: pack.warnings,
    suggestions,
  };
}

export function renderImport(root) {
  /** @type {Candidate | null} */
  let candidate = null;
  let error = null;
  let result = null;
  let pasteText = "";
  let importing = false;

  const pending = takePendingImport();
  if (pending) void load(pending);

  async function load(files) {
    error = null;
    result = null;
    candidate = null;
    draw();
    const work = busy("ファイルを読み込んでいます…");
    try {
      candidate = await candidateFromFiles(files);
      if (candidate.cards.length === 0) {
        error = "取り込めるカードが見つかりませんでした。表と裏の間、カードとカードの間に空行があるか確認してください。";
      }
    } catch (err) {
      candidate = null;
      error =
        err instanceof FileFormatError || err instanceof Error ? err.message : String(err);
    } finally {
      work.done();
    }
    draw();
  }

  function usePaste() {
    result = null;
    error = null;
    candidate = fromText(pasteText, null);
    if (candidate.cards.length === 0) {
      error = "カードが見つかりませんでした。表と裏の間、カードとカードの間に空行を入れてください。";
      candidate = null;
    }
    draw();
  }

  async function runImport(tags, markImportant) {
    // One import at a time: a second one would check for duplicates against
    // data that doesn't include the first one's cards yet.
    if (importing || !candidate) return;
    importing = true;
    const c = candidate;
    const work = busy(`${c.cards.length}枚を取り込んでいます…`);
    try {
      const out = await importPackCards({
        existingCards: getState().cards,
        imageHashOf,
        packCards: c.cards,
        packImages: c.images,
        tags,
        markImportant,
        now: new Date(),
        prepareImage: prepareImportedImage,
      });
      if (out.added > 0) {
        const putImages = new Map();
        for (const [path, img] of out.images) {
          putImages.set(path, new Blob([img.bytes], { type: img.type }));
        }
        update((s) => ({ cards: [...s.cards, ...out.cards] }), { putImages });
      }
      result = { added: out.added, skipped: out.skipped, tags, sourceName: c.sourceName };
      candidate = null;
      toast(`${out.added}枚を追加しました`);
    } catch (err) {
      error = `取り込みに失敗しました: ${err?.message ?? err}`;
    } finally {
      importing = false;
      work.done();
    }
    draw();
  }

  function dropzone() {
    const zone = h(
      "div",
      { class: "dropzone" },
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary",
          onclick: async () => {
            const files = await pickFiles({ accept: ACCEPT, multiple: true });
            if (files.length) await load(files);
          },
        },
        "ファイルを選ぶ"
      ),
      h("span", { class: "small" }, "カードパック（.zip）または .txt。.txt に画像を付けるときは画像ファイルも一緒に選択。"),
      h("span", { class: "small only-wide" }, "ここにドロップもできます。")
    );
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("is-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("is-over");
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void load(files);
    });
    return zone;
  }

  function candidatePanel(c) {
    const existing = collectTags(getState().cards);
    const important = c.cards.filter((x) => x.important).length;
    const withImages = c.cards.filter((x) => x.frontImage || x.backImage).length;
    const tagsInput = h("input", {
      class: "input",
      type: "text",
      value: formatTagInput(c.suggestions.slice(0, 1)),
      placeholder: "例: 公共, 倫理（カンマ区切り）",
      autocomplete: "off",
      "aria-label": "取り込むカードに付けるタグ",
      oninput: () => drawChips(),
    });
    const chipsBox = h("div", { class: "filter-chips" });
    const markImportant = h("input", { type: "checkbox" });
    const ideas = [...c.suggestions, ...existing.map((t) => t.tag).filter((t) => !c.suggestions.includes(t))];

    function drawChips() {
      const current = parseTagInput(tagsInput.value);
      mount(
        chipsBox,
        ideas.slice(0, 24).map((tag) =>
          h(
            "button",
            {
              type: "button",
              class: "filter-chip",
              "aria-pressed": current.includes(tag) ? "true" : "false",
              onclick: () => {
                const now = parseTagInput(tagsInput.value);
                tagsInput.value = formatTagInput(now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag]);
                drawChips();
              },
            },
            tag
          )
        )
      );
    }
    drawChips();

    return h(
      "section",
      { class: "panel stack" },
      h(
        "div",
        { class: "stack-sm" },
        h("h2", { class: "section-title" }, "取り込む内容"),
        h(
          "p",
          null,
          c.sourceName ? h("b", null, c.sourceName) : h("b", null, "貼り付けたテキスト"),
          `：${c.cards.length}枚`,
          important ? `（★最重要 ${important}枚）` : "",
          withImages ? ` · 画像付き ${withImages}枚` : ""
        ),
        c.warnings.length
          ? h(
              "details",
              { open: c.warnings.length <= 3 },
              h("summary", { class: "text-warning small" }, `注意 ${c.warnings.length}件`),
              h("ul", { class: "warn-list" }, c.warnings.map((w) => h("li", null, w)))
            )
          : null,
        h(
          "details",
          null,
          h("summary", { class: "small muted" }, `プレビュー（最初の${Math.min(5, c.cards.length)}枚）`),
          h(
            "ul",
            { class: "list list--tight", style: { marginTop: "0.5rem" } },
            c.cards.slice(0, 5).map((card) =>
              h(
                "li",
                { class: "card-row" },
                h("div", { class: "card-row__front", style: { marginTop: 0 } }, card.important ? "★ " : "", card.front || "（画像）"),
                h("div", { class: "card-row__back" }, card.back || "（画像）")
              )
            )
          )
        )
      ),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field__label" }, "付けるタグ ", h("span", { class: "muted" }, "（カンマ区切り・全カード共通）")),
        tagsInput,
        chipsBox
      ),
      h(
        "label",
        { class: "check" },
        markImportant,
        h("span", null, "取り込むカードをすべて ", h("span", { class: "star" }, "★"), " 最重要にする")
      ),
      h(
        "p",
        { class: "muted small" },
        "学習データにすでにある同じカード（表・裏・画像が同じ）はスキップします。取り込んだカードは学習ファイルに入るので、このファイルはもう要りません。"
      ),
      h(
        "div",
        { class: "row", style: { justifyContent: "flex-end" } },
        h(
          "button",
          {
            type: "button",
            class: "btn btn--ghost",
            onclick: () => {
              candidate = null;
              draw();
            },
          },
          "やめる"
        ),
        h(
          "button",
          {
            type: "button",
            class: "btn btn--primary",
            onclick: () => runImport(parseTagInput(tagsInput.value), markImportant.checked),
          },
          `${c.cards.length}枚を取り込む`
        )
      )
    );
  }

  function draw() {
    const pasteArea = h("textarea", {
      class: "textarea",
      rows: 10,
      placeholder: PLACEHOLDER,
      value: pasteText,
      style: { fontFamily: "var(--font-mono)", fontSize: "0.875rem" },
      oninput: (e) => {
        pasteText = e.target.value;
      },
    });
    mount(
      root,
      h(
        "div",
        { class: "stack" },
        h(
          "div",
          { class: "row-between" },
          h("h1", { class: "page-title" }, "取り込み"),
          h("a", { class: "muted small", href: "#/cards" }, "← カード一覧へ")
        ),
        result
          ? h(
              "div",
              { class: "banner banner--accent" },
              h(
                "span",
                null,
                `${result.added}枚を追加しました。`,
                result.skipped ? `${result.skipped}枚は重複のためスキップしました。` : "",
                result.tags.length ? `（タグ: ${result.tags.join(", ")}）` : ""
              ),
              h(
                "div",
                { class: "row" },
                h(
                  "a",
                  {
                    class: "btn btn--sm",
                    href: `#/cards${result.tags.length ? `?${result.tags.map((t) => `tags=${encodeURIComponent(t)}`).join("&")}` : ""}`,
                  },
                  "カードを見る"
                ),
                result.added
                  ? h("a", { class: "btn btn--sm btn--primary", href: reviewHref({ tags: result.tags, scope: "due" }) }, "復習へ")
                  : null
              )
            )
          : null,
        error ? h("p", { class: "banner banner--danger", role: "alert" }, error) : null,
        candidate ? candidatePanel(candidate) : null,
        candidate ? null : dropzone(),
        candidate
          ? null
          : h(
              "details",
              { class: "panel panel--tight" },
              h("summary", { style: { cursor: "pointer", fontWeight: 500 } }, "テキストを貼り付けて取り込む"),
              h(
                "div",
                { class: "stack-sm", style: { marginTop: "0.75rem" } },
                pasteArea,
                h(
                  "div",
                  { class: "row", style: { justifyContent: "flex-end" } },
                  h("button", { type: "button", class: "btn", onclick: () => usePaste() }, "この内容で続ける")
                )
              )
            ),
        h(
          "section",
          { class: "panel panel--tight stack-sm small" },
          h("b", null, ".txt の書き方"),
          h(
            "ul",
            { class: "muted", style: { margin: 0, paddingLeft: "1.25rem", lineHeight: 1.8 } },
            h("li", null, "表 → 空行 → 裏 → 空行 → 次の表 … の順。表も裏も複数行にできます。"),
            h("li", null, "表の先頭に ★ を付けたカードは最重要になります（★ は取り除かれます）。"),
            h("li", null, "画像は [img:front:ファイル名.png] / [img:back:ファイル名.png] の行で指定し、画像ファイルも一緒に選びます。"),
            h("li", null, "1200px を超える画像は取り込み時に縮小されます。")
          )
        )
      )
    );
  }

  draw();
}
