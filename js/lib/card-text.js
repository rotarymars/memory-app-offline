// Turns the plain-text card format (parse-bulk.js) into pack cards. On top of
// the blank-line rules it adds two things, both optional:
//
// - A front that starts with ★ marks the card important. The ★ (and any
//   spaces right after it) is stripped.
// - A line of the form [img:front:file.png] or [img:back:file.png], anywhere in
//   a card's front or back block, attaches that image file to that side. The
//   line itself is removed from the text. One image per side.
//
// Shared by the web importer and tools/make-pack.mjs so both read a .txt the
// same way.

import { parseBulkInput } from "./parse-bulk.js";

const IMAGE_LINE = /^\s*\[img:(front|back):([^\]]+)\]\s*$/i;
const IMPORTANT_MARK = /^\s*★\s*/;

/**
 * @typedef {object} TextCard
 * @property {string} front
 * @property {string} back
 * @property {boolean} important
 * @property {string | null} frontImageName File name from [img:front:…], as written.
 * @property {string | null} backImageName
 */

/**
 * @param {string} text
 * @returns {{ cards: TextCard[], warnings: string[] }}
 */
export function parseCardText(text) {
  const warnings = [];
  const cards = [];
  const pairs = parseBulkInput(stripBom(text));

  pairs.forEach((pair, i) => {
    const n = i + 1;
    const images = { front: null, back: null };
    const keep = (block) =>
      block
        .split("\n")
        .filter((line) => {
          const m = IMAGE_LINE.exec(line);
          if (!m) return true;
          const side = m[1].toLowerCase();
          const name = m[2].trim();
          if (images[side]) {
            warnings.push(
              `${n}枚目: ${sideLabel(side)}の画像が2つ以上指定されています（最初の ${images[side]} を使います）`
            );
          } else {
            images[side] = name;
          }
          return false;
        })
        .join("\n");

    let front = keep(pair.front);
    const back = keep(pair.back);

    let important = false;
    if (IMPORTANT_MARK.test(front)) {
      important = true;
      front = front.replace(IMPORTANT_MARK, "");
    }

    if (front.trim() === "" && !images.front) {
      warnings.push(`${n}枚目: 表面が空なのでスキップしました`);
      return;
    }
    if (back.trim() === "" && !images.back) {
      warnings.push(`${n}枚目: 裏面が空なのでスキップしました`);
      return;
    }
    cards.push({
      front,
      back,
      important,
      frontImageName: images.front,
      backImageName: images.back,
    });
  });

  return { cards, warnings };
}

function sideLabel(side) {
  return side === "front" ? "表面" : "裏面";
}

// Notepad on Windows likes to start UTF-8 files with a BOM.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
