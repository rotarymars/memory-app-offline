import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBulkInput } from "../js/lib/parse-bulk.js";
import { parseCardText } from "../js/lib/card-text.js";

test("a blank line toggles between front and back", () => {
  const text = "What does TCP stand for?\n\nTransmission Control Protocol\n\nWhat is HTTP?\n\nHyperText Transfer Protocol";
  assert.deepEqual(parseBulkInput(text), [
    { front: "What does TCP stand for?", back: "Transmission Control Protocol" },
    { front: "What is HTTP?", back: "HyperText Transfer Protocol" },
  ]);
});

test("multi-line fronts and backs are kept, joined with \\n", () => {
  const text = "line 1\nline 2\n\nanswer a\nanswer b\n公共10 p.1\n\nq2\n\na2\n";
  assert.deepEqual(parseBulkInput(text), [
    { front: "line 1\nline 2", back: "answer a\nanswer b\n公共10 p.1" },
    { front: "q2", back: "a2" },
  ]);
});

test("runs of blank lines count once; whitespace-only lines are blank", () => {
  const text = "\n\n  \nq1\n\n\n\t\na1\n \n\nq2\n\na2";
  assert.deepEqual(parseBulkInput(text), [
    { front: "q1", back: "a1" },
    { front: "q2", back: "a2" },
  ]);
});

test("CRLF line endings", () => {
  assert.deepEqual(parseBulkInput("q1\r\n\r\na1\r\n\r\nq2\r\n\r\na2\r\n"), [
    { front: "q1", back: "a1" },
    { front: "q2", back: "a2" },
  ]);
});

test("a trailing front without a back is dropped (zip to the shorter side)", () => {
  assert.deepEqual(parseBulkInput("q1\n\na1\n\nq2"), [{ front: "q1", back: "a1" }]);
  assert.deepEqual(parseBulkInput(""), []);
  assert.deepEqual(parseBulkInput("only a front"), []);
});

test("lines are not trimmed (same as the online parser)", () => {
  assert.deepEqual(parseBulkInput("  indented q  \n\n\tanswer"), [
    { front: "  indented q  ", back: "\tanswer" },
  ]);
});

test("the user's worksheet format parses into question / answer+source pairs", () => {
  const text = [
    "仏滅後、正法・像法・末法の三つの時代を経て、仏教は衰微するという思想を何というか。",
    "",
    "末法思想",
    "公共10 p.1 空欄1",
    "",
    "末法思想で、証（悟り）がない千年の時代を何というか。",
    "",
    "像法（ぞうぼう）",
    "公共10 p.1",
    "",
  ].join("\n");
  assert.deepEqual(parseBulkInput(text), [
    {
      front: "仏滅後、正法・像法・末法の三つの時代を経て、仏教は衰微するという思想を何というか。",
      back: "末法思想\n公共10 p.1 空欄1",
    },
    { front: "末法思想で、証（悟り）がない千年の時代を何というか。", back: "像法（ぞうぼう）\n公共10 p.1" },
  ]);
});

test("★ at the start of a front marks the card important and is stripped", () => {
  const { cards, warnings } = parseCardText("★源信の著書は？\n\n『往生要集』\n\n普通の問題\n\n答え\n\n　★ 全角スペースの後\n\nA\n\n★\n改行の後\n\nB");
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    cards.map((c) => [c.front, c.important]),
    [
      ["源信の著書は？", true],
      ["普通の問題", false],
      ["全角スペースの後", true],
      ["改行の後", true],
    ]
  );
});

test("★ elsewhere in the front, or on the back, does not count", () => {
  const { cards } = parseCardText("問題★\n\n★答え\n\n源信 ☆印\n\n答え");
  assert.deepEqual(
    cards.map((c) => [c.front, c.back, c.important]),
    [
      ["問題★", "★答え", false],
      ["源信 ☆印", "答え", false],
    ]
  );
});

test("[img:front:…] / [img:back:…] lines attach images and leave the text", () => {
  const text = "この地図の都市は？\n[img:front:map1.png]\n\n札幌\n[img:back:map1-answer.png]\n\n[img:front:only-image.jpg]\n\n答え\n[IMG:BACK: spaced name.png ]";
  const { cards, warnings } = parseCardText(text);
  assert.deepEqual(warnings, []);
  assert.deepEqual(cards, [
    {
      front: "この地図の都市は？",
      back: "札幌",
      important: false,
      frontImageName: "map1.png",
      backImageName: "map1-answer.png",
    },
    {
      front: "",
      back: "答え",
      important: false,
      frontImageName: "only-image.jpg",
      backImageName: "spaced name.png",
    },
  ]);
});

test("an image line may sit in the other side's block", () => {
  const { cards } = parseCardText("問題\n\n答え\n[img:front:q.png]");
  assert.equal(cards[0].frontImageName, "q.png");
  assert.equal(cards[0].back, "答え");
});

test("two images for one side: the first wins, with a warning", () => {
  const { cards, warnings } = parseCardText("q\n[img:front:a.png]\n[img:front:b.png]\n\nans");
  assert.equal(cards[0].frontImageName, "a.png");
  assert.equal(warnings.length, 1);
});

test("a card left empty after stripping is skipped with a warning", () => {
  const { cards, warnings } = parseCardText("★\n\n答え\n\n問題\n\n[img:front:x.png]");
  assert.equal(cards.length, 0);
  assert.equal(warnings.length, 2);
});

test("a UTF-8 BOM is ignored", () => {
  const { cards } = parseCardText("﻿★問題\n\n答え");
  assert.deepEqual([cards[0].front, cards[0].important], ["問題", true]);
});
