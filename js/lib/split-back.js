// Splits a card's back into the answer (first paragraph), the explanation
// (the rest) and a source line ("出典：…" / "Source: …"), shown small at the
// bottom like the 地理 cards. Ported from memory-app's ReviewSession.tsx.

/**
 * @param {string} text
 * @returns {{ answer: string, note: string, source: string }}
 */
export function splitBack(text) {
  const lines = text.split(/\r?\n/);
  const isSource = (l) => /^\s*(出典|source)\s*[:：]/i.test(l);
  const source = lines.filter(isSource).join("\n").trim();
  const body = lines
    .filter((l) => !isSource(l))
    .join("\n")
    .trim();
  const blank = body.search(/\n\s*\n/);
  return blank === -1
    ? { answer: body, note: "", source }
    : {
        answer: body.slice(0, blank).trim(),
        note: body.slice(blank).trim(),
        source,
      };
}
