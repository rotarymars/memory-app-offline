// Pure state transitions for a review session: answering, and relearning a
// missed card a few cards later. The UI keeps the previous state around so the
// last answer can be undone.
//
// Ported from memory-app/lib/review-session.ts. The online app held the last
// answer back from its save queue so it could still be undone; here every
// answer is written to the study data right away and undo restores the card
// (see applyAnswerToCard / restoreReviewFields in cards.js), so the
// pending-save merging (`mergeAnswer`) has no counterpart.

import { requeueCard } from "./review-order.js";
import { nextLevel } from "./spaced-repetition.js";

/** @typedef {import("./spaced-repetition.js").ReviewOutcome} ReviewOutcome */

/**
 * One answer: which card, what was answered, and the level it moved from/to.
 * @typedef {{ id: string, outcome: ReviewOutcome, from: number, level: number }} HeldAnswer
 */

/**
 * @typedef {{ id: string, reviewLevel: number, relearn?: boolean }} SessionCard
 * `relearn` is set on a copy put back into the queue after a miss.
 */

/**
 * @template {SessionCard} T
 * @typedef {object} SessionState
 * @property {T[]} queue
 * @property {number} index
 * @property {number} completed
 * @property {string[]} missed Ids of cards missed at least once this session, in the order first missed.
 */

/**
 * @template {SessionCard} T
 * @param {T[]} cards
 * @returns {SessionState<T>}
 */
export function startSession(cards) {
  return { queue: cards, index: 0, completed: 0, missed: [] };
}

function addMissed(missed, id) {
  return missed.includes(id) ? missed : [...missed, id];
}

// Grades the card on screen. Every answer moves the card on the ladder,
// re-shows included, so a card missed and then recalled ends up one level
// below where it started (L5 → Again → L3 → Good → L4). A miss puts the card
// back a few cards later at its lowered level, until it's answered correctly.
/**
 * @template {SessionCard} T
 * @param {SessionState<T>} state
 * @param {ReviewOutcome} outcome
 * @returns {{ state: SessionState<T>, held: HeldAnswer } | null}
 */
export function answerCard(state, outcome) {
  const current = state.queue[state.index];
  if (!current) return null;
  const level = nextLevel(current.reviewLevel, outcome);
  const held = {
    id: current.id,
    outcome,
    from: current.reviewLevel,
    level,
  };
  const again = outcome === "again";
  return {
    held,
    state: {
      queue: again
        ? requeueCard(state.queue, state.index + 1, {
            ...current,
            reviewLevel: level,
          })
        : state.queue,
      index: state.index + 1,
      completed: state.completed + 1,
      missed: again ? addMissed(state.missed, current.id) : state.missed,
    },
  };
}

// Practice: a miss puts the card back a few cards later, a hit drops it.
// Levels never change.
/**
 * @template {SessionCard} T
 * @param {SessionState<T>} state
 * @param {boolean} gotIt
 * @returns {SessionState<T> | null}
 */
export function practiceCard(state, gotIt) {
  const current = state.queue[state.index];
  if (!current) return null;
  return {
    queue: gotIt
      ? state.queue
      : requeueCard(state.queue, state.index + 1, current),
    index: state.index + 1,
    completed: state.completed + 1,
    missed: gotIt ? state.missed : addMissed(state.missed, current.id),
  };
}
