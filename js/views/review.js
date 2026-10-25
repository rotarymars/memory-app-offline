// Review: choosing what to review (tags, important-only, due or all), and the
// flip-and-grade session itself — a port of memory-app's ReviewSession.tsx.
//
// Due cards are reviewed and every answer is recorded straight into the study
// data (and autosaved). "All cards" is practice, as in the online app: it
// goes through everything matching the filters and never changes the
// schedule, so cramming before a test doesn't push cards far into the future.

import { applyAnswerToCard, filterCards, reviewFieldsOf } from "../lib/cards.js";
import { addToDaily, localDateKey } from "../lib/daily.js";
import {
  orderCards,
  parseReviewOrder,
  RELEARN_GAP,
  reorderRemaining,
  REVIEW_ORDER_LABELS,
  REVIEW_ORDERS,
} from "../lib/review-order.js";
import { answerCard, practiceCard, startSession } from "../lib/review-session.js";
import {
  formatInterval,
  intervalMinutesForLevel,
  OUTCOME_LABELS,
} from "../lib/spaced-repetition.js";
import { splitBack } from "../lib/split-back.js";
import { collectTags } from "../lib/tags.js";
import { h, isTypingTarget, mount, toggleChip } from "../ui/dom.js";
import { isModalOpen } from "../ui/modal.js";
import { replaceHash } from "../ui/nav.js";
import { getGeneration, getState, imageUrl, update } from "../ui/store.js";

// A horizontal drag at least this long (px) counts as a swipe.
const SWIPE_MIN_PX = 60;
const FILTER_KEY = "memory-offline:review-filter";

/**
 * @typedef {object} ReviewFilter
 * @property {string[]} tags
 * @property {boolean} untagged
 * @property {boolean} importantOnly
 * @property {"due" | "all"} scope
 */

/** A link to the review screen with filters set (and optionally started). */
export function reviewHref({ tags = [], untagged = false, important = false, scope = "due", start = false } = {}) {
  const q = new URLSearchParams();
  for (const t of tags) q.append("tag", t);
  if (untagged) q.set("untagged", "1");
  if (important) q.set("important", "1");
  q.set("scope", scope);
  if (start) q.set("start", "1");
  return `#/review?${q}`;
}

function loadFilter() {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? "null");
    if (raw && typeof raw === "object") {
      return {
        tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
        untagged: Boolean(raw.untagged),
        importantOnly: Boolean(raw.importantOnly),
        scope: raw.scope === "all" ? "all" : "due",
      };
    }
  } catch {
    // Private mode or junk: start from the defaults.
  }
  return { tags: [], untagged: false, importantOnly: false, scope: "due" };
}

function saveFilter(filter) {
  try {
    localStorage.setItem(FILTER_KEY, JSON.stringify(filter));
  } catch {
    // Not important enough to bother the user about.
  }
}

function filterFromParams(params) {
  if (!params.has("scope") && !params.has("tag") && !params.has("important")) return null;
  return {
    tags: params.getAll("tag"),
    untagged: params.get("untagged") === "1",
    importantOnly: params.get("important") === "1",
    scope: params.get("scope") === "all" ? "all" : "due",
  };
}

function matching(filter, now = new Date()) {
  const s = getState();
  return filterCards(
    s.cards,
    {
      tags: filter.tags,
      untagged: filter.untagged,
      importantOnly: filter.importantOnly,
      dueOnly: filter.scope === "due",
    },
    now
  );
}

function describeFilter(filter) {
  const parts = [...filter.tags];
  if (filter.untagged) parts.push("タグなし");
  if (filter.importantOnly) parts.push("★最重要");
  return parts.join("・");
}

// ---- The session in progress -------------------------------------------

/**
 * Kept at module level so leaving the screen (say, to fix a typo in a card)
 * and coming back carries on where you were.
 * @type {null | {
 *   session: import("../lib/review-session.js").SessionState<{ id: string, reviewLevel: number, relearn?: boolean }>,
 *   revealed: boolean, order: string, practice: boolean, initialPractice: boolean,
 *   round: number, label: string,
 *   undo: null | { prev: any, cardId?: string, before?: any, dayKey?: string, outcome?: string },
 * }}
 */
let active = null;

// A session belongs to the data it was started on. Once another file is
// opened (or you start empty), it's dropped: its levels and undo point refer
// to cards that are no longer there.
function dropStaleSession() {
  if (active && active.generation !== getGeneration()) active = null;
}

export function hasActiveSession() {
  dropStaleSession();
  return active !== null && Boolean(active.session.queue[active.session.index]);
}

function startReview(filter, { replace = false } = {}) {
  const s = getState();
  const order = parseReviewOrder(s.settings.reviewOrder);
  const cards = matching(filter).map((c) => ({ id: c.id, reviewLevel: c.reviewLevel }));
  const practice = filter.scope === "all";
  active = {
    session: startSession(orderCards(cards, order)),
    revealed: false,
    order,
    practice,
    initialPractice: practice,
    round: 1,
    label: describeFilter(filter),
    undo: null,
    generation: getGeneration(),
  };
  // Started from a link (?start=1): replace it, so Back doesn't start another.
  if (replace) replaceHash("#/review/session");
  else location.hash = "#/review/session";
}

// ---- Setup screen ----------------------------------------------------------

export function renderReviewSetup(root, params) {
  const fromLink = filterFromParams(params);
  let filter = fromLink ?? loadFilter();
  const s = getState();
  const allTags = collectTags(s.cards);
  // Drop remembered tags that no longer exist.
  filter.tags = filter.tags.filter((t) => allTags.some((x) => x.tag === t));

  if (fromLink && params.get("start") === "1") {
    saveFilter(filter);
    if (matching(filter).length > 0) {
      startReview(filter, { replace: true });
      return;
    }
  }

  const draw = () => {
    saveFilter(filter);
    const now = new Date();
    const base = { ...filter };
    const dueCount = matching({ ...base, scope: "due" }, now).length;
    const allCount = matching({ ...base, scope: "all" }, now).length;
    const count = filter.scope === "due" ? dueCount : allCount;
    const hasUntagged = s.cards.some((c) => c.tags.length === 0);

    mount(
      root,
      h(
        "div",
        { class: "stack" },
        h("h1", { class: "page-title" }, "復習"),
        hasActiveSession()
          ? h(
              "div",
              { class: "banner banner--accent" },
              h("span", null, `途中のセッションがあります（残り ${active.session.queue.length - active.session.index} 枚）`),
              h(
                "div",
                { class: "row" },
                h("a", { class: "btn btn--sm btn--primary", href: "#/review/session" }, "続ける"),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn--sm btn--ghost",
                    onclick: () => {
                      active = null;
                      draw();
                    },
                  },
                  "やめる"
                )
              )
            )
          : null,
        s.cards.length === 0
          ? h(
              "div",
              { class: "panel panel--dashed stack-sm" },
              h("p", { class: "muted" }, "まだカードがありません。"),
              h("a", { class: "link", href: "#/import" }, "カードを取り込む →")
            )
          : h(
              "section",
              { class: "panel stack" },
              h(
                "div",
                { class: "field" },
                h("span", { class: "field__label" }, "タグ ", h("span", { class: "muted" }, "（複数選ぶと、どれかを含むカード）")),
                h(
                  "div",
                  { class: "filter-chips" },
                  toggleChip("すべて", filter.tags.length === 0 && !filter.untagged, () => {
                    filter = { ...filter, tags: [], untagged: false };
                    draw();
                  }),
                  allTags.map(({ tag, count: n }) =>
                    toggleChip(
                      tag,
                      filter.tags.includes(tag),
                      (on) => {
                        filter = {
                          ...filter,
                          tags: on ? [...filter.tags, tag] : filter.tags.filter((t) => t !== tag),
                        };
                        draw();
                      },
                      h("span", { class: "count" }, `(${n})`)
                    )
                  ),
                  hasUntagged
                    ? toggleChip("タグなし", filter.untagged, (on) => {
                        filter = { ...filter, untagged: on };
                        draw();
                      })
                    : null
                )
              ),
              h(
                "label",
                { class: "check" },
                h("input", {
                  type: "checkbox",
                  checked: filter.importantOnly,
                  onchange: (e) => {
                    filter = { ...filter, importantOnly: e.target.checked };
                    draw();
                  },
                }),
                h("span", null, h("span", { class: "star" }, "★"), " 最重要カードだけ")
              ),
              h(
                "div",
                { class: "field" },
                h("span", { class: "field__label" }, "対象"),
                h(
                  "div",
                  { class: "segmented", role: "radiogroup" },
                  radio("scope", "due", filter.scope === "due", `期限が来たカード（${dueCount}）`, () => {
                    filter = { ...filter, scope: "due" };
                    draw();
                  }),
                  radio("scope", "all", filter.scope === "all", `すべて（${allCount}）`, () => {
                    filter = { ...filter, scope: "all" };
                    draw();
                  })
                ),
                h(
                  "p",
                  { class: "muted small" },
                  filter.scope === "due"
                    ? "答えは記録され、次の復習日が決まります。"
                    : "練習モード: 期限前のカードも含めて全部出します。答えは記録されず、復習スケジュールは変わりません。"
                )
              ),
              h(
                "div",
                { class: "field" },
                h("span", { class: "field__label" }, "順番"),
                h(
                  "select",
                  {
                    class: "select",
                    onchange: (e) => {
                      const order = parseReviewOrder(e.target.value);
                      update((st) => ({ settings: { ...st.settings, reviewOrder: order } }));
                    },
                  },
                  REVIEW_ORDERS.map((o) =>
                    h("option", { value: o, selected: getState().settings.reviewOrder === o }, REVIEW_ORDER_LABELS[o])
                  )
                ),
                h("p", { class: "muted small" }, "同じレベルのカードは毎回シャッフルされます。")
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn--primary btn--lg",
                  disabled: count === 0,
                  onclick: () => startReview(filter),
                },
                count === 0
                  ? filter.scope === "due"
                    ? "期限が来たカードはありません"
                    : "該当するカードがありません"
                  : filter.scope === "due"
                    ? `復習を始める（${count}枚）`
                    : `練習を始める（${count}枚・記録なし）`
              ),
              count === 0 && filter.scope === "due" && allCount > 0
                ? h(
                    "p",
                    { class: "muted small" },
                    "今は期限のカードがありません。カードは次の復習日が来るとここに出てきます。「すべて」を選ぶと練習できます。"
                  )
                : null
            )
      )
    );
  };
  draw();
}

function radio(name, value, checked, label, onSelect) {
  return h(
    "label",
    null,
    h("input", { type: "radio", name, value, checked, onchange: onSelect }),
    h("span", null, label)
  );
}

// ---- Session screen ------------------------------------------------------

export function renderReviewSession(root) {
  dropStaleSession();
  if (!active) {
    replaceHash("#/review");
    return undefined;
  }
  document.body.classList.add("is-reviewing");

  let zoom = null;
  let fling = null;
  let flingTimer = null;
  let touch = null;
  let swipedAt = 0;
  let lastSession = null;

  const findCard = (id) => getState().cards.find((c) => c.id === id);

  function current() {
    // A card deleted while you were away from the session just drops out.
    for (;;) {
      const item = active.session.queue[active.session.index];
      if (!item || findCard(item.id)) return item;
      const queue = active.session.queue.filter((_, i) => i !== active.session.index);
      active.session = { ...active.session, queue };
    }
  }

  function reveal() {
    if (active.revealed) return;
    active.revealed = true;
    draw();
    // On flip, bring the answer into view if it opened below the fold.
    const answer = root.querySelector(".review-card__answer");
    const r = answer?.getBoundingClientRect();
    if (r && r.bottom > window.innerHeight - 160) {
      window.scrollBy({ top: r.bottom - window.innerHeight + 180, behavior: "smooth" });
    }
  }

  function showFling(dir) {
    fling = dir;
    clearTimeout(flingTimer);
    flingTimer = setTimeout(() => {
      fling = null;
      root.querySelector(".review-card")?.classList.remove("fling-left", "fling-right");
    }, 140);
  }

  // Practice: a miss puts the card back a few cards later, a hit drops it.
  function practiceAnswer(gotIt) {
    if (!active.revealed || !current()) return;
    const next = practiceCard(active.session, gotIt);
    if (!next) return;
    active.undo = { prev: active.session };
    active.session = next;
    active.revealed = false;
    showFling(gotIt ? "right" : "left");
    draw();
  }

  // Grades the card and records it right away: level, next review, the
  // outcome's tally, and today's count in daily.json.
  function answer(outcome) {
    if (active.generation !== getGeneration()) return end();
    const item = current();
    if (!active.revealed || !item) return;
    const result = answerCard(active.session, outcome);
    if (!result) return;
    const card = findCard(item.id);
    const now = new Date();
    const dayKey = localDateKey(now);
    const before = reviewFieldsOf(card);
    update((s) => ({
      cards: s.cards.map((c) =>
        c.id === card.id ? applyAnswerToCard(c, outcome, result.held.level, now) : c
      ),
      daily: addToDaily(s.daily, dayKey, outcome),
    }));
    active.undo = { prev: active.session, cardId: card.id, before, dayKey, outcome };
    active.session = result.state;
    active.revealed = false;
    showFling(outcome === "again" || outcome === "down" ? "left" : "right");
    draw();
  }

  // Takes back the last answer: the queue, the counters and the card's level
  // go back to just before it, and today's tally loses it again.
  function undo() {
    if (active.generation !== getGeneration()) return end();
    const point = active.undo;
    if (!point) return;
    if (point.cardId) {
      update((s) => ({
        cards: s.cards.map((c) => (c.id === point.cardId ? { ...c, ...point.before } : c)),
        daily: addToDaily(s.daily, point.dayKey, point.outcome, -1),
      }));
    }
    active.undo = null;
    active.session = point.prev;
    active.revealed = false;
    draw();
  }

  // Re-sorts the cards still to come. The card on screen stays put once its
  // answer is showing; before that it's reshuffled along with the rest. Cards
  // waiting to be relearned keep their place.
  function changeOrder(next) {
    const order = parseReviewOrder(next);
    active.order = order;
    update((s) => ({ settings: { ...s.settings, reviewOrder: order } }));
    const from = active.revealed ? active.session.index + 1 : active.session.index;
    active.session = { ...active.session, queue: reorderRemaining(active.session.queue, from, order) };
    draw();
  }

  // Starts an unrecorded practice round of the cards missed this session.
  function practiceMissed() {
    const latest = new Map();
    for (const c of active.session.queue) latest.set(c.id, c);
    const cards = active.session.missed
      .map((id) => latest.get(id))
      .filter((c) => c !== undefined && findCard(c.id))
      .map((c) => ({ id: c.id, reviewLevel: c.reviewLevel }));
    active = {
      ...active,
      session: startSession(orderCards(cards, active.order)),
      practice: true,
      round: active.round + 1,
      revealed: false,
      undo: null,
    };
    draw();
  }

  function swipe(dir) {
    if (!active.revealed) {
      reveal();
      return;
    }
    if (active.practice) practiceAnswer(dir === "right");
    else answer(dir === "right" ? "good" : "again");
  }

  function end() {
    active = null;
    location.hash = "#/";
  }

  // Keyboard shortcuts: Space/Enter reveals; once revealed, 1-4 grade the card
  // (1 = two down, 2 = down, 3 = up, 4 = two up), ← = Again and → = Good. In
  // practice mode 1/← = missed and 2/→ = got it. Z undoes the last answer.
  const grades = { 1: "again", 2: "down", 3: "good", 4: "great", ArrowLeft: "again", ArrowRight: "good" };
  function onKey(e) {
    if (isTypingTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isModalOpen()) return;
    if (zoom) {
      if (e.key === "Escape") closeZoom();
      return;
    }
    if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undo();
    } else if (!active.revealed && (e.key === " " || e.key === "Enter")) {
      e.preventDefault();
      reveal();
    } else if (active.revealed && active.practice && ["1", "2", "ArrowLeft", "ArrowRight"].includes(e.key)) {
      e.preventDefault();
      practiceAnswer(e.key === "2" || e.key === "ArrowRight");
    } else if (active.revealed && !active.practice && grades[e.key]) {
      e.preventDefault();
      answer(grades[e.key]);
    }
  }
  window.addEventListener("keydown", onKey);

  // ---- Image zoom (Lightbox) ----
  let lightbox = null;
  function openZoom(src) {
    zoom = src;
    let big = false;
    const img = h("img", {
      src,
      alt: "拡大した画像",
      onclick: (e) => {
        e.stopPropagation();
        big = !big;
        lightbox.classList.toggle("is-big", big);
      },
    });
    lightbox = h(
      "div",
      {
        class: "lightbox",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "拡大した画像",
        onclick: (e) => {
          if (e.target === lightbox) closeZoom();
        },
      },
      img,
      h("button", { type: "button", class: "lightbox__close", onclick: closeZoom }, "閉じる"),
      h("span", { class: "lightbox__hint" }, "画像をタップで拡大／縮小")
    );
    document.body.append(lightbox);
  }
  function closeZoom() {
    zoom = null;
    lightbox?.remove();
    lightbox = null;
  }

  function cardImage(src, alt) {
    return h(
      "div",
      { class: "figure" },
      h("img", {
        src,
        alt,
        onclick: (e) => {
          // Enlarge instead of flipping the card.
          e.stopPropagation();
          openZoom(src);
        },
      }),
      h("span", { class: "figure__caption" }, "タップで拡大")
    );
  }

  function answerButton(tone, solid, label, sub, kbd, onClick) {
    return h(
      "button",
      { type: "button", class: `answer-btn tone-${tone} ${solid ? "answer-btn--solid" : ""}`, onclick: onClick },
      h("span", null, label, h("span", { class: "answer-btn__kbd" }, ` (${kbd})`)),
      h("span", { class: "answer-btn__sub" }, sub)
    );
  }

  function drawDone() {
    const { queue, missed, completed } = active.session;
    const cardCount = new Set(queue.map((c) => c.id)).size;
    const firstTry = cardCount - missed.length;
    mount(
      root,
      h(
        "div",
        { class: "done" },
        h("div", { class: "muted small" }, active.round > 1 ? "練習ラウンド" : "今回のセッション"),
        h(
          "div",
          { class: "done__score" },
          h("span", { class: "text-success" }, String(firstTry)),
          h("span", { class: "muted" }, ` / ${cardCount}`)
        ),
        h(
          "p",
          { class: "muted" },
          missed.length > 0 ? `${missed.length}枚を1回以上間違えました` : "すべて1回目で正解！",
          ` · 回答 ${completed}回`
        ),
        active.practice
          ? h(
              "p",
              { class: "muted small" },
              `練習モード — ${active.round > 1 ? "このラウンドでは" : ""}復習スケジュールは変わっていません。`
            )
          : h("p", { class: "muted small" }, "結果はこの端末に自動保存されています。終わったら書き出しを忘れずに。"),
        h(
          "div",
          { class: "done__actions" },
          missed.length > 0
            ? h(
                "button",
                { type: "button", class: "btn btn--solid-danger", onclick: practiceMissed },
                `間違えたカードだけもう一度（練習・記録なし）· ${missed.length}`
              )
            : null,
          active.undo
            ? h(
                "button",
                { type: "button", class: "btn", onclick: undo },
                "↶ 最後の回答を取り消す",
                h("span", { class: "only-wide" }, " ", h("kbd", null, "Z"))
              )
            : null,
          h("button", { type: "button", class: "btn btn--primary", onclick: end }, "ホームに戻る")
        )
      )
    );
  }

  function draw() {
    const item = current();
    if (active.session !== lastSession) {
      // Next card (or undo, or a new order): back to the top.
      lastSession = active.session;
      window.scrollTo(0, 0);
    }
    if (!item) {
      drawDone();
      return;
    }
    const card = findCard(item.id);
    const { index, completed, missed, queue } = active.session;
    const remaining = queue.length - index;
    const total = completed + remaining;
    const level = item.reviewLevel;
    const back = splitBack(card.back);
    const frontImage = imageUrl(card.frontImage);
    const backImage = imageUrl(card.backImage);
    const revealed = active.revealed;

    const article = h(
      "article",
      {
        class: `review-card ${fling ? `fling-${fling}` : ""}`,
        "aria-live": "polite",
        onclick: () => {
          // A swipe also fires a click; don't let it flip the next card.
          if (Date.now() - swipedAt < 450) return;
          // Don't treat a drag-to-select as a reveal click.
          if (window.getSelection()?.toString()) return;
          if (!active.revealed) reveal();
        },
        ontouchstart: (e) => {
          const t = e.touches[0];
          touch = t ? { x: t.clientX, y: t.clientY } : null;
        },
        ontouchend: (e) => {
          const start = touch;
          touch = null;
          const t = e.changedTouches[0];
          if (!start || !t) return;
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
          swipedAt = Date.now();
          swipe(dx > 0 ? "right" : "left");
        },
      },
      h(
        "div",
        { class: "chips" },
        active.practice ? h("span", { class: "chip chip--important" }, "練習・記録なし") : null,
        card.important ? h("span", { class: "chip chip--important" }, "★ 最重要") : null,
        card.tags.map((t) => h("span", { class: "chip" }, t)),
        h("span", { class: "chip" }, `L${level} · ${formatInterval(intervalMinutesForLevel(level))}`),
        item.relearn ? h("span", { class: "chip chip--danger" }, "再学習") : null
      ),
      card.front ? h("div", { class: "review-card__front" }, card.front) : null,
      frontImage ? cardImage(frontImage, "表面の画像") : null,
      revealed
        ? h(
            "div",
            { class: "review-card__answer" },
            back.answer ? h("div", { class: "review-card__answer-text" }, back.answer) : null,
            back.note ? h("div", { class: "review-card__note" }, back.note) : null,
            backImage ? cardImage(backImage, "裏面の画像") : null,
            back.source ? h("div", { class: "review-card__source" }, back.source) : null
          )
        : h("div", { class: "review-card__hint" }, "カードをタップすると答えが表示されます")
    );

    // intervalMinutesForLevel clamps to [0, MAX_LEVEL], so over/undershooting
    // the ladder here is safe (e.g. "down" at level 0 stays at level 0).
    const iv = (l) => formatInterval(intervalMinutesForLevel(l));

    mount(
      root,
      h(
        "div",
        { class: "review" },
        h(
          "div",
          { class: "review__top" },
          h("button", { type: "button", class: "review__end", onclick: end }, "← 終了"),
          h(
            "span",
            { class: "review__counts" },
            h("span", { class: "text-success" }, "完了 ", h("b", null, String(completed))),
            "　",
            h("span", { class: "text-danger" }, "ミス ", h("b", null, String(missed.length)))
          ),
          h("span", { class: "review__position" }, `${completed + 1} / ${total}`)
        ),
        h(
          "div",
          {
            class: "progressbar",
            role: "progressbar",
            "aria-valuemin": "0",
            "aria-valuemax": String(total),
            "aria-valuenow": String(completed),
          },
          h("div", { class: "progressbar__fill", style: { width: `${(100 * completed) / total}%` } })
        ),
        article,
        h(
          "div",
          { class: "answer-bar" },
          revealed && active.practice
            ? h(
                "div",
                { class: "answer-pair" },
                answerButton("danger", true, "間違えた", `${RELEARN_GAP}枚後にもう一度`, "←", () => practiceAnswer(false)),
                answerButton("success", true, "覚えた", "次のカードへ", "→", () => practiceAnswer(true))
              )
            : revealed
              ? h(
                  "div",
                  { class: "answer-grid" },
                  answerButton("danger", true, OUTCOME_LABELS.again, `2段下げ · ${iv(level - 2)}`, "1 ←", () => answer("again")),
                  answerButton("success", true, OUTCOME_LABELS.good, `1段上げ · ${iv(level + 1)}`, "3 →", () => answer("good")),
                  answerButton("warning", false, OUTCOME_LABELS.down, `1段下げ · ${iv(level - 1)}`, "2", () => answer("down")),
                  answerButton("accent", false, OUTCOME_LABELS.great, `2段上げ · ${iv(level + 2)}`, "4", () => answer("great"))
                )
              : h(
                  "button",
                  { type: "button", class: "reveal-btn", onclick: reveal },
                  "答えを見る",
                  h("span", { class: "only-wide" }, "（Space）")
                )
        ),
        h(
          "div",
          { class: "review__footer" },
          h(
            "button",
            { type: "button", class: "review__undo", onclick: undo, disabled: !active.undo },
            "取り消す",
            h("span", { class: "only-wide" }, "（Z）")
          ),
          h(
            "select",
            {
              class: "review__order",
              "aria-label": "カードの順番",
              title: "カードの順番（同じレベルのカードはシャッフル）",
              onchange: (e) => {
                changeOrder(e.target.value);
                // Hand focus back so Space/1-4 shortcuts keep working.
                e.target.blur();
              },
            },
            REVIEW_ORDERS.map((o) => h("option", { value: o, selected: active.order === o }, REVIEW_ORDER_LABELS[o]))
          )
        ),
        h(
          "p",
          { class: "review__help" },
          h(
            "span",
            { class: "only-narrow" },
            active.practice
              ? `← スワイプで間違えた · 覚えた →。間違えたカードは${RELEARN_GAP}枚後にもう一度出ます。`
              : `← スワイプでもう一度 · 正解 →。間違えたカードは${RELEARN_GAP}枚後にもう一度出ます。`
          ),
          h(
            "span",
            { class: "only-wide" },
            active.practice
              ? `Space = 答え · ← / 1 間違えた · → / 2 覚えた · Z 取り消し。間違えたカードは${RELEARN_GAP}枚後にもう一度出ます。`
              : `Space = 答え · ← / 1 もう一度 · 2 難しい · → / 3 正解 · 4 簡単 · Z 取り消し。間違えたカードは${RELEARN_GAP}枚後にもう一度出ます。`
          ),
          active.label ? h("span", null, ` 対象: ${active.label}`) : null
        )
      )
    );
  }

  draw();

  return () => {
    window.removeEventListener("keydown", onKey);
    clearTimeout(flingTimer);
    closeZoom();
    document.body.classList.remove("is-reviewing");
  };
}
