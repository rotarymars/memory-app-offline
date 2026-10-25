import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyReview,
  formatInterval,
  formatTimeUntil,
  intervalMinutesForLevel,
  MATURE_LEVEL,
  MAX_LEVEL,
  nextLevel,
  nextReviewDate,
  REVIEW_INTERVALS_MINUTES,
} from "../js/lib/spaced-repetition.js";
import { parseReviewOrder } from "../js/lib/review-order.js";

test("the 16-level ladder matches the online app", () => {
  const H = 60;
  const D = 24 * H;
  assert.deepEqual(
    [...REVIEW_INTERVALS_MINUTES],
    [10, 30, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 3 * D, 5 * D, 10 * D, 15 * D, 30 * D, 60 * D, 90 * D]
  );
  assert.equal(MAX_LEVEL, 15);
  assert.equal(MATURE_LEVEL, 12);
  assert.equal(intervalMinutesForLevel(MATURE_LEVEL), 15 * D);
});

test("nextLevel: again -2, down -1, good +1, great +2, clamped to 0…15", () => {
  assert.equal(nextLevel(5, "again"), 3);
  assert.equal(nextLevel(5, "down"), 4);
  assert.equal(nextLevel(5, "good"), 6);
  assert.equal(nextLevel(5, "great"), 7);
  assert.equal(nextLevel(1, "again"), 0);
  assert.equal(nextLevel(0, "down"), 0);
  assert.equal(nextLevel(15, "good"), 15);
  assert.equal(nextLevel(14, "great"), 15);
});

test("intervals clamp outside the ladder", () => {
  assert.equal(intervalMinutesForLevel(-3), 10);
  assert.equal(intervalMinutesForLevel(99), 90 * 24 * 60);
});

test("applyReview schedules from the given time", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  const r = applyReview(6, "good", now);
  assert.equal(r.nextLevel, 7);
  assert.equal(r.nextReviewAt.toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(nextReviewDate(0, now).toISOString(), "2026-10-25T00:10:00.000Z");
});

test("formatInterval uses the original thresholds with Japanese units", () => {
  assert.equal(formatInterval(10), "10分");
  assert.equal(formatInterval(60), "1時間");
  assert.equal(formatInterval(90), "1.5時間");
  assert.equal(formatInterval(24 * 60), "1日");
  assert.equal(formatInterval(36 * 60), "1.5日");
  assert.equal(formatInterval(30 * 24 * 60), "1か月");
  assert.equal(formatInterval(90 * 24 * 60), "3か月");
});

test("formatTimeUntil", () => {
  const now = new Date("2026-10-25T00:00:00Z");
  assert.equal(formatTimeUntil(new Date("2026-10-24T00:00:00Z"), now), "今");
  assert.equal(formatTimeUntil(new Date("2026-10-25T00:00:20Z"), now), "1分");
  assert.equal(formatTimeUntil(new Date("2026-10-25T02:00:00Z"), now), "2時間");
});

test("parseReviewOrder falls back to random", () => {
  assert.equal(parseReviewOrder("low"), "low");
  assert.equal(parseReviewOrder("high"), "high");
  assert.equal(parseReviewOrder("bogus"), "random");
  assert.equal(parseReviewOrder(undefined), "random");
});
