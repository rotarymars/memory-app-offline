// Progress, after memory-app/app/progress/page.tsx: recall per tag, how far
// along each tag's cards are, and an estimate of how long until everything is
// mature. Added here: due counts, answer totals, and a daily chart from
// daily.json.

import { sumCounts } from "../lib/cards.js";
import { currentStreak, dailySeries, localDateKey, totalOf } from "../lib/daily.js";
import { formatRate, formatShortDate } from "../lib/format.js";
import { formatDuration, summarizeCards } from "../lib/progress.js";
import {
  formatInterval,
  intervalMinutesForLevel,
  MATURE_LEVEL,
  OUTCOME_LABELS,
  REVIEW_OUTCOMES,
} from "../lib/spaced-repetition.js";
import { h, mount } from "../ui/dom.js";
import { getState } from "../ui/store.js";
import { reviewHref } from "./review.js";

const CHART_DAYS = 30;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// Outcomes mean good/bad, so they wear the app's status colors, always next
// to their label.
const OUTCOME_COLORS = {
  again: "var(--danger)",
  down: "var(--warning)",
  good: "var(--success)",
  great: "var(--accent)",
};

const STAGES = [
  { key: "learning", label: "学習中", note: "（1日未満）", color: "var(--warning)" },
  { key: "young", label: "復習中", note: "", color: "var(--accent)" },
  { key: "mature", label: "定着", note: "", color: "var(--success)" },
];

export function renderProgress(root) {
  const s = getState();
  const now = new Date();
  const { tags, overall } = summarizeCards(s.cards, now);

  if (overall.total === 0) {
    mount(
      root,
      h(
        "div",
        { class: "empty-state" },
        h("h1", { class: "page-title" }, "まだ進捗はありません。"),
        h(
          "p",
          { class: "muted", style: { maxWidth: "28rem" } },
          "カードを追加して復習すると、タグごとの正答率や、すべてが定着するまでの目安がここに表示されます。"
        ),
        h("a", { class: "btn btn--primary", href: "#/import" }, "カードを取り込む")
      )
    );
    return;
  }

  const matureInterval = formatInterval(intervalMinutesForLevel(MATURE_LEVEL));

  mount(
    root,
    h(
      "div",
      { class: "stack-lg" },
      h(
        "section",
        { class: "stack-sm" },
        h("h1", { class: "hero-title" }, "進捗"),
        h(
          "p",
          { class: "muted" },
          `次の復習が${matureInterval}以上先になったカードを「定着」と数えます。時間の目安は、期限どおりに復習し、これまでと同じくらい正解する場合のものです。`
        )
      ),
      h(
        "section",
        { class: "stats" },
        stat(
          "正答率",
          formatRate(overall.recallRate),
          overall.reviews > 0 ? `回答 ${overall.reviews}回` : "まだ回答がありません"
        ),
        stat(
          "定着",
          `${Math.round((overall.mature / overall.total) * 100)}%`,
          `${overall.total}枚中 ${overall.mature}枚`
        ),
        stat(
          "全カード定着まで",
          overall.msToMature > 0 ? `≈ ${formatDuration(overall.msToMature)}` : "完了",
          overall.msToMature > 0 ? "復習を続けた場合" : "すべて定着しています"
        ),
        stat("残りの復習回数", `≈ ${overall.reviewsToMature}`, "すべて定着するまで")
      ),
      dailySection(s.daily, now),
      outcomeSection(sumCounts(s.cards)),
      h(
        "section",
        { class: "stack-sm" },
        h(
          "div",
          { class: "row-between", style: { alignItems: "baseline" } },
          h("h2", { class: "section-title" }, "タグ別"),
          legend()
        ),
        overall.reviews === 0
          ? h(
              "p",
              { class: "muted small" },
              "正答率は復習するにつれて埋まっていきます。それまでは、10問中8問くらい正解する前提で見積もっています。"
            )
          : null,
        h("ul", { class: "list list--tight" }, tags.map((t) => tagRow(t)))
      )
    )
  );
}

function stat(label, value, detail) {
  return h(
    "div",
    { class: "stat" },
    h("div", { class: "stat__label" }, label),
    h("div", { class: "stat__value" }, value),
    h("div", { class: "stat__detail" }, detail)
  );
}

function rateColor(rate) {
  if (rate === null) return "var(--muted)";
  if (rate >= 0.85) return "var(--success)";
  if (rate >= 0.7) return "var(--warning)";
  return "var(--danger)";
}

function tagRow(t) {
  return h(
    "li",
    { class: "progress-row" },
    h(
      "div",
      { class: "progress-row__head" },
      h(
        "div",
        { class: "grow" },
        h(
          "div",
          { class: "tag-row__name", style: t.tag ? null : { fontStyle: "italic", color: "var(--muted)" } },
          t.tag ?? "タグなし"
        ),
        h(
          "div",
          { class: "small muted" },
          `${t.total}枚 · 期限 ${t.due}枚 · 定着 ${t.mature}枚 · `,
          t.msToMature > 0
            ? `すべて定着まで ≈ ${formatDuration(t.msToMature)}（あと約${t.reviewsToMature}回）`
            : "すべて定着"
        )
      ),
      h(
        "div",
        { class: "row", style: { flex: "none", gap: "0.75rem", flexWrap: "nowrap" } },
        h(
          "div",
          null,
          h("div", { class: "progress-row__rate", style: { color: rateColor(t.recallRate) } }, formatRate(t.recallRate)),
          h("div", { class: "small muted", style: { textAlign: "right" } }, t.reviews > 0 ? `正答率 · 回答${t.reviews}回` : "まだ回答なし")
        ),
        h(
          "a",
          {
            class: `btn btn--xs ${t.due > 0 ? "btn--primary" : "btn--ghost"}`,
            href: reviewHref({ tags: t.tag ? [t.tag] : [], untagged: t.tag === null, scope: "due" }),
          },
          "復習"
        )
      )
    ),
    stageBar(t),
    t.reviews > 0
      ? h(
          "div",
          { class: "outcomes" },
          REVIEW_OUTCOMES.map((o) =>
            h(
              "span",
              { class: "legend__item" },
              h("span", { class: "legend__dot", style: { background: OUTCOME_COLORS[o] } }),
              `${OUTCOME_LABELS[o]} ${t.counts[o]}`
            )
          )
        )
      : null
  );
}

function stageBar(t) {
  return h(
    "div",
    {
      class: "stage-bar",
      role: "img",
      "aria-label": STAGES.map((st) => `${st.label} ${t[st.key]}枚`).join("、"),
    },
    STAGES.map((st) =>
      t[st.key] > 0
        ? h("div", {
            title: `${st.label}: ${t[st.key]}枚`,
            style: { width: `${(t[st.key] / t.total) * 100}%`, background: st.color },
          })
        : null
    )
  );
}

function legend() {
  return h(
    "div",
    { class: "legend" },
    STAGES.map((st) =>
      h(
        "span",
        { class: "legend__item" },
        h("span", { class: "legend__dot", style: { background: st.color } }),
        st.label + st.note
      )
    )
  );
}

// ---- Answer totals: one part-to-whole bar ----------------------------------

function outcomeSection(counts) {
  const total = totalOf(counts);
  if (total === 0) return null;
  return h(
    "section",
    { class: "stack-sm" },
    h("h2", { class: "section-title" }, "回答の内訳（全期間）"),
    h(
      "div",
      { class: "panel panel--tight stack-sm" },
      h(
        "div",
        {
          class: "stage-bar outcome-bar",
          role: "img",
          "aria-label": REVIEW_OUTCOMES.map((o) => `${OUTCOME_LABELS[o]} ${counts[o]}回`).join("、"),
        },
        REVIEW_OUTCOMES.map((o) =>
          counts[o] > 0
            ? h("div", {
                title: `${OUTCOME_LABELS[o]}: ${counts[o]}回`,
                style: { width: `${(counts[o] / total) * 100}%`, background: OUTCOME_COLORS[o] },
              })
            : null
        )
      ),
      h(
        "div",
        { class: "legend legend--values" },
        REVIEW_OUTCOMES.map((o) =>
          h(
            "span",
            { class: "legend__item" },
            h("span", { class: "legend__dot", style: { background: OUTCOME_COLORS[o] } }),
            `${OUTCOME_LABELS[o]} `,
            h("b", { class: "legend__value" }, `${counts[o]}回`),
            h("span", { class: "muted" }, `（${Math.round((counts[o] / total) * 100)}%）`)
          )
        )
      )
    )
  );
}

// ---- Daily answers: one column per day ---------------------------------------

// A round axis maximum whose half is a whole number too (the chart has a
// gridline at the middle): 2, 4, 6, 8, 10, 20, 30, 40, 50, 60, 80, 100, 200…
function niceMax(value) {
  if (value <= 10) return Math.max(2, Math.ceil(value / 2) * 2);
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 3, 4, 5, 6, 8, 10]) {
    if (step * pow >= value) return step * pow;
  }
  return 10 * pow;
}

// "0.2回" below ten a day, "12回" above.
function formatAverage(value) {
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}回`;
}

function dailySection(daily, now) {
  const series = dailySeries(daily, CHART_DAYS, now);
  const total = series.reduce((n, d) => n + d.total, 0);
  const todayKey = localDateKey(now);
  const today = series.find((d) => d.key === todayKey)?.total ?? 0;
  const max = Math.max(0, ...series.map((d) => d.total));
  const top = niceMax(max);

  const tooltip = h("div", { class: "chart__tooltip", role: "status", hidden: true });
  const plot = h("div", { class: "chart__plot" });
  for (const fraction of [0.5, 1]) {
    plot.append(
      h(
        "div",
        { class: "chart__gridline", style: { bottom: `${fraction * 100}%` } },
        h("span", { class: "chart__gridlabel" }, String(Math.round(top * fraction)))
      )
    );
  }

  const showTip = (day, col) => {
    const correct = day.counts.good + day.counts.great;
    mount(
      tooltip,
      h("div", { class: "chart__tooltip-value" }, `${day.total}回`),
      h("div", { class: "chart__tooltip-label" }, `${formatShortDate(day.date)}（${WEEKDAYS[day.date.getDay()]}）`),
      day.total > 0
        ? [
            h(
              "div",
              { class: "chart__tooltip-rows" },
              REVIEW_OUTCOMES.map((o) => h("div", null, `${OUTCOME_LABELS[o]} ${day.counts[o]}`))
            ),
            h("div", { class: "chart__tooltip-label" }, `正答率 ${Math.round((correct / day.total) * 100)}%`),
          ]
        : null
    );
    tooltip.hidden = false;
    // Centre over the column, kept inside the chart.
    const box = plot.getBoundingClientRect();
    const c = col.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const left = Math.min(Math.max(c.left - box.left + c.width / 2 - width / 2, 0), box.width - width);
    tooltip.style.left = `${left}px`;
  };
  const hideTip = () => {
    tooltip.hidden = true;
  };

  series.forEach((day) => {
    const col = h(
      "div",
      {
        class: `chart__col ${day.key === todayKey ? "is-today" : ""}`,
        tabindex: "0",
        role: "img",
        "aria-label": `${formatShortDate(day.date)} ${day.total}回`,
        onpointerenter: () => showTip(day, col),
        onpointerleave: hideTip,
        onfocus: () => showTip(day, col),
        onblur: hideTip,
      },
      day.total > 0
        ? h("div", { class: "chart__bar", style: { height: `${(day.total / top) * 100}%` } })
        : null
    );
    plot.append(col);
  });
  plot.append(tooltip);

  // Dates under every 7th column, counting back from today so today is labelled.
  const axis = h(
    "div",
    { class: "chart__axis", "aria-hidden": "true" },
    series.map((day, i) =>
      h("span", null, (series.length - 1 - i) % 7 === 0 ? formatShortDate(day.date) : "")
    )
  );

  const table = h(
    "table",
    { class: "chart__table" },
    h(
      "thead",
      null,
      h("tr", null, h("th", null, "日付"), h("th", null, "合計"), REVIEW_OUTCOMES.map((o) => h("th", null, OUTCOME_LABELS[o])))
    ),
    h(
      "tbody",
      null,
      [...series].reverse().map((day) =>
        h(
          "tr",
          null,
          h("td", null, `${formatShortDate(day.date)}（${WEEKDAYS[day.date.getDay()]}）`),
          h("td", null, String(day.total)),
          REVIEW_OUTCOMES.map((o) => h("td", null, String(day.counts[o])))
        )
      )
    )
  );

  return h(
    "section",
    { class: "stack-sm" },
    h("h2", { class: "section-title" }, `1日の回答数（直近${CHART_DAYS}日）`),
    h(
      "div",
      { class: "panel panel--tight stack-sm" },
      h(
        "div",
        { class: "chart-kpis" },
        kpi("合計", `${total}回`),
        kpi("1日平均", formatAverage(total / CHART_DAYS)),
        kpi("今日", `${today}回`),
        kpi("連続", `${currentStreak(daily, now)}日`)
      ),
      total === 0
        ? h("p", { class: "muted small" }, "この期間の回答はまだありません。復習すると日ごとの回数がここに積み上がります（練習モードは数えません）。")
        : h("figure", { class: "chart" }, plot, axis),
      total === 0
        ? null
        : h("details", null, h("summary", { class: "small muted" }, "表で見る"), table)
    )
  );
}

function kpi(label, value) {
  return h("div", { class: "chart-kpi" }, h("div", { class: "stat__label" }, label), h("div", { class: "chart-kpi__value" }, value));
}
