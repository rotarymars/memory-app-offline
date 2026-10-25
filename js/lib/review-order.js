// The order a review session goes through its cards. Cards on the same level
// are equally urgent, so within a level they're always shuffled rather than
// falling back to creation or due-date order.
//
// Ported from memory-app/lib/review-order.ts unchanged, apart from the
// Japanese labels.

export const REVIEW_ORDERS = Object.freeze(["random", "low", "high"]);

/** @typedef {"random" | "low" | "high"} ReviewOrder */

/** @type {Readonly<Record<ReviewOrder, string>>} */
export const REVIEW_ORDER_LABELS = Object.freeze({
  random: "ランダム",
  low: "レベルの低い順",
  high: "レベルの高い順",
});

/** @returns {ReviewOrder} */
export function parseReviewOrder(value) {
  return REVIEW_ORDERS.includes(value) ? value : "random";
}

function shuffled(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * @template {{ reviewLevel: number }} T
 * @param {T[]} cards
 * @param {ReviewOrder} order
 * @returns {T[]}
 */
export function orderCards(cards, order) {
  const out = shuffled(cards);
  // Array.prototype.sort is stable, so the shuffle survives within a level.
  if (order === "low") out.sort((a, b) => a.reviewLevel - b.reviewLevel);
  if (order === "high") out.sort((a, b) => b.reviewLevel - a.reviewLevel);
  return out;
}

// How far back a missed card goes: it's shown again as the RELEARN_GAP-th card
// after the one you just answered (so RELEARN_GAP - 1 others come between).
export const RELEARN_GAP = 5;

// Where a missed card re-enters the queue, given that the cards still to come
// start at `start`. Clamped to the end when fewer cards are left.
export function relearnIndex(queueLength, start, gap = RELEARN_GAP) {
  return Math.min(start + Math.max(0, gap - 1), queueLength);
}

// Puts a missed card back into the part of the queue still to come (from
// `start` on), RELEARN_GAP cards later. This ignores the card order on purpose:
// a miss lowers the card's level, so slotting it by level in "lowest level
// first" would bring it straight back. The copy is flagged `relearn` so a later
// order change leaves it where it is.
/**
 * @template {{ reviewLevel: number, relearn?: boolean }} T
 * @param {T[]} queue
 * @param {number} start
 * @param {T} card
 * @param {number} [gap]
 * @returns {T[]}
 */
export function requeueCard(queue, start, card, gap = RELEARN_GAP) {
  const at = relearnIndex(queue.length, start, gap);
  return [...queue.slice(0, at), { ...card, relearn: true }, ...queue.slice(at)];
}

// Re-sorts the cards from `from` on. Cards waiting to be relearned keep their
// slot so a new order can't pull a just-missed card to the front; everything
// else is reordered into the remaining slots.
/**
 * @template {{ reviewLevel: number, relearn?: boolean }} T
 * @param {T[]} queue
 * @param {number} from
 * @param {ReviewOrder} order
 * @returns {T[]}
 */
export function reorderRemaining(queue, from, order) {
  const rest = queue.slice(from);
  const sorted = orderCards(
    rest.filter((c) => !c.relearn),
    order
  );
  let k = 0;
  return [
    ...queue.slice(0, from),
    ...rest.map((c) => (c.relearn ? c : sorted[k++])),
  ];
}
