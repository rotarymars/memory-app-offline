import { test } from "node:test";
import assert from "node:assert/strict";
import { createCard } from "../js/lib/cards.js";
import {
  formatDuration,
  progressRows,
  summarizeCards,
  summarizeProgress,
} from "../js/lib/progress.js";

const NOW = new Date("2026-10-25T12:00:00Z");

// A small deterministic generator so the cases are random-looking but stable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomCards(n, tagChoices, seed) {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const card = createCard({ front: `q${i}`, back: "a", tags: tagChoices(r) }, NOW);
    card.reviewLevel = Math.floor(r() * 16);
    card.nextReviewAt = new Date(NOW.getTime() + (r() - 0.3) * 20 * 86_400_000).toISOString();
    card.againCount = Math.floor(r() * 4);
    card.downCount = Math.floor(r() * 3);
    card.goodCount = Math.floor(r() * 10);
    card.greatCount = Math.floor(r() * 5);
    return card;
  });
}

const strip = ({ due, ...rest }) => rest;

test("with at most one tag per card, summarizeCards equals the online summarizeProgress", () => {
  for (const seed of [1, 2, 3, 42]) {
    const cards = randomCards(
      120,
      (r) => {
        const x = r();
        return x < 0.2 ? [] : x < 0.6 ? ["公共"] : x < 0.9 ? ["地理"] : ["古文単語12"];
      },
      seed
    );
    const online = summarizeProgress(
      progressRows(cards, (c) => [c.tags[0] ?? null]),
      NOW
    );
    const offline = summarizeCards(cards, NOW);
    assert.deepEqual(offline.tags.map(strip), online.tags.map(strip));
    assert.deepEqual(strip(offline.overall), strip(online.overall));
  }
});

test("multi-tag cards count in every tag but once overall", () => {
  const cards = randomCards(60, (r) => (r() < 0.5 ? ["A", "B"] : ["B"]), 7);
  const { tags, overall } = summarizeCards(cards, NOW);
  const byTag = Object.fromEntries(tags.map((t) => [t.tag, t]));
  assert.equal(byTag.B.total, 60);
  assert.equal(byTag.A.total, cards.filter((c) => c.tags.includes("A")).length);
  assert.equal(overall.total, 60);
  assert.equal(overall.learning + overall.young + overall.mature, 60);
  const answers = cards.reduce((n, c) => n + c.againCount + c.downCount + c.goodCount + c.greatCount, 0);
  assert.equal(overall.reviews, answers);
  assert.ok(overall.msToMature >= Math.max(...tags.map((t) => t.msToMature)) - 1e-9);
  assert.equal(overall.due, cards.filter((c) => Date.parse(c.nextReviewAt) <= NOW.getTime()).length);
});

test("untagged cards form their own group, listed last", () => {
  const cards = [
    createCard({ front: "1", tags: ["b"] }, NOW),
    createCard({ front: "2", tags: [] }, NOW),
    createCard({ front: "3", tags: ["a"] }, NOW),
  ];
  const { tags } = summarizeCards(cards, NOW);
  assert.deepEqual(tags.map((t) => t.tag), ["a", "b", null]);
  assert.deepEqual(tags.map((t) => t.due), [1, 1, 1]);
});

test("every card mature: nothing left to do", () => {
  const cards = [createCard({ front: "1", tags: ["x"] }, NOW)];
  cards[0].reviewLevel = 13;
  const { overall } = summarizeCards(cards, NOW);
  assert.equal(overall.mature, 1);
  assert.equal(overall.msToMature, 0);
  assert.equal(overall.reviewsToMature, 0);
  assert.equal(overall.recallRate, null);
});

test("estimates grow with distance from maturity", () => {
  const at = (level) => {
    const c = createCard({ front: "x", tags: ["t"] }, NOW);
    c.reviewLevel = level;
    return summarizeCards([c], NOW).overall;
  };
  const low = at(0);
  const high = at(10);
  assert.ok(low.reviewsToMature > high.reviewsToMature);
  assert.ok(low.msToMature > high.msToMature);
  assert.ok(low.reviewsToMature > 0);
});

test("formatDuration uses the original cut-offs", () => {
  const H = 3_600_000;
  assert.equal(formatDuration(0.5 * H), "1時間以内");
  assert.equal(formatDuration(5 * H), "5時間");
  assert.equal(formatDuration(48 * H), "2日");
  assert.equal(formatDuration(20 * 24 * H), "3週間");
  assert.equal(formatDuration(90 * 24 * H), "3か月");
  assert.equal(formatDuration(800 * 24 * H), "2年");
});
