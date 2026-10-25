// Small navigation helpers shared by the views (hash routing: "#/cards?…").

// Hash changes since the page loaded, not counting our own replaces. If it's
// 0, the current screen was opened directly (or after a reload) and there's
// no earlier screen of this app to go back to.
let navigations = 0;
let replacing = false;

/** Called by the router on every hashchange. */
export function noteHashChange() {
  if (replacing) {
    replacing = false;
    return;
  }
  navigations++;
}

/** Navigates without leaving a history entry behind. */
export function replaceHash(hash) {
  if (location.hash === hash) return;
  replacing = true;
  location.replace(hash);
}

/**
 * Goes back if there's an earlier screen of this app to go back to (so the
 * card list comes back with its filters), else to `fallback`.
 */
export function goBack(fallback) {
  if (navigations > 0) history.back();
  else location.hash = fallback;
}

/** "#/cards?tags=a" → { path: "/cards", params } */
export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, "") || "/";
  const q = raw.indexOf("?");
  const path = q === -1 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : raw.slice(q + 1));
  return { path: path || "/", params };
}
