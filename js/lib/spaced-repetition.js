// Ebbinghaus-style review intervals, in minutes.
// A review nudges the card along this ladder of levels: it can step the card
// two levels down, one level down, one level up, or two levels up.
//
// Ported from memory-app/lib/spaced-repetition.ts. The ladder and the level
// rules are unchanged; only the display strings are Japanese.

const HOUR = 60;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;

export const REVIEW_INTERVALS_MINUTES = Object.freeze([
  10, //  0: 10 min
  30, //  1: 30 min
  HOUR, //  2: 1 h
  2 * HOUR, //  3: 2 h
  3 * HOUR, //  4: 3 h
  6 * HOUR, //  5: 6 h
  12 * HOUR, //  6: 12 h
  DAY, //  7: 1 d
  2 * DAY, //  8: 2 d
  3 * DAY, //  9: 3 d
  5 * DAY, // 10: 5 d
  10 * DAY, // 11: 10 d
  15 * DAY, // 12: 15 d
  MONTH, // 13: 1 mo
  2 * MONTH, // 14: 2 mo
  3 * MONTH, // 15: 3 mo
]);

export const MAX_LEVEL = REVIEW_INTERVALS_MINUTES.length - 1;

// A card counts as mature once it's scheduled 15 days or more out.
export const MATURE_LEVEL = 12;

export function clampLevel(level) {
  return Math.max(0, Math.min(level, MAX_LEVEL));
}

export function intervalMinutesForLevel(level) {
  return REVIEW_INTERVALS_MINUTES[clampLevel(level)];
}

export function nextReviewDate(level, from = new Date()) {
  const minutes = intervalMinutesForLevel(level);
  return new Date(from.getTime() + minutes * 60_000);
}

/** @typedef {"again" | "down" | "good" | "great"} ReviewOutcome */

// Every outcome steps relative to the current level ("again" drops two).
/** @type {readonly ReviewOutcome[]} */
export const REVIEW_OUTCOMES = Object.freeze(["again", "down", "good", "great"]);

// What the answer buttons and the progress page call each outcome.
export const OUTCOME_LABELS = Object.freeze({
  again: "もう一度",
  down: "難しい",
  good: "正解",
  great: "簡単",
});

/**
 * @param {number} currentLevel
 * @param {ReviewOutcome} outcome
 */
export function nextLevel(currentLevel, outcome) {
  const target =
    outcome === "again"
      ? currentLevel - 2
      : outcome === "down"
        ? currentLevel - 1
        : outcome === "good"
          ? currentLevel + 1
          : currentLevel + 2; // "great": two levels up
  return clampLevel(target);
}

/**
 * @param {number} currentLevel
 * @param {ReviewOutcome} outcome
 * @param {Date} [now]
 */
export function applyReview(currentLevel, outcome, now = new Date()) {
  const level = nextLevel(currentLevel, outcome);
  return {
    nextLevel: level,
    nextReviewAt: nextReviewDate(level, now),
  };
}

// Same thresholds as the original ("10min", "1.5h", "2d", "1mo"), in Japanese
// units: 10分, 1.5時間, 2日, 1か月.
export function formatInterval(minutes) {
  if (minutes < HOUR) return `${minutes}分`;
  if (minutes < DAY) {
    const hours = minutes / HOUR;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}時間`;
  }
  if (minutes < MONTH) {
    const days = minutes / DAY;
    return `${Number.isInteger(days) ? days : days.toFixed(1)}日`;
  }
  const months = minutes / MONTH;
  return `${Number.isInteger(months) ? months : months.toFixed(1)}か月`;
}

export function formatTimeUntil(target, now = new Date()) {
  const ms = target.getTime() - now.getTime();
  if (ms <= 0) return "今";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return formatInterval(minutes);
}
