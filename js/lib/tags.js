// Tags are free-form strings; a card can have any number of them. Inputs are
// comma-separated, and the Japanese comma (、) and full-width comma (，) work
// too so an IME doesn't get in the way.

const SEPARATORS = /[,、，]/;

/**
 * "公共, 倫理、期末" → ["公共", "倫理", "期末"]. Trims, drops blanks and
 * repeats, keeps the order typed.
 * @param {string} input
 * @returns {string[]}
 */
export function parseTagInput(input) {
  return normalizeTags(String(input ?? "").split(SEPARATORS));
}

/**
 * Cleans a tag list read from a file or a form.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const tag = raw.normalize("NFC").replace(/\s+/g, " ").trim();
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

export function formatTagInput(tags) {
  return tags.join(", ");
}

// Leftovers from how packs and exports are named, which make poor tags.
const NAME_NOISE = [
  /^memory[-_ ]?(pack|study)([-_ ]|$)/i,
  /^(pack|パック)([-_ ]|$)/i,
  /([-_ ]|^)(pack|パック)$/i,
  /([-_ ]|^)\d{4}-\d{2}-\d{2}([-_ ]?\d{4})?$/,
];

/**
 * Tag ideas from a file name: the whole base name first, then its parts.
 * "公共_ワークシート.txt" → ["公共_ワークシート", "公共", "ワークシート"].
 * @param {string} fileName
 * @returns {string[]}
 */
export function suggestTagsFromFileName(fileName) {
  let base = String(fileName ?? "")
    .normalize("NFC")
    .replace(/^.*[\\/]/, "")
    .replace(/\.(zip|txt|json)$/i, "")
    .trim();
  let before;
  do {
    before = base;
    for (const noise of NAME_NOISE) base = base.replace(noise, "").trim();
  } while (base !== before);
  if (!base) return [];
  const pieces = base.split(/[\s_\-・]+/).filter(Boolean);
  // Bare numbers ("12" in 古文単語_12) mean nothing as a tag on their own.
  const parts = pieces.filter((p) => !/^\d+$/.test(p));
  return normalizeTags(pieces.length > 1 ? [base, ...parts] : [base]);
}

/**
 * Every tag in use, with how many cards carry it, sorted by name.
 * @param {{ tags: string[] }[]} cards
 * @returns {{ tag: string, count: number }[]}
 */
export function collectTags(cards) {
  const counts = new Map();
  for (const card of cards) {
    for (const tag of card.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return Array.from(counts, ([tag, count]) => ({ tag, count })).sort((a, b) =>
    compareTagNames(a.tag, b.tag)
  );
}

export function compareTagNames(a, b) {
  return a.localeCompare(b, "ja", { numeric: true });
}
