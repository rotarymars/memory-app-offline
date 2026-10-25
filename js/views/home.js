// Dashboard, after memory-app/app/page.tsx: what's due, stats, tags, and the
// state of the study file.

import { isDue } from "../lib/cards.js";
import { formatAgo, formatDateTime } from "../lib/format.js";
import { MATURE_LEVEL } from "../lib/spaced-repetition.js";
import { collectTags } from "../lib/tags.js";
import { h, mount } from "../ui/dom.js";
import { getFileHandle, getState } from "../ui/store.js";
import { openExportDialog } from "../ui/study.js";
import { reviewHref } from "./review.js";

export function renderHome(root) {
  const s = getState();
  const now = new Date();
  const cards = s.cards;
  const due = cards.filter((c) => isDue(c, now));
  const mature = cards.filter((c) => c.reviewLevel >= MATURE_LEVEL).length;
  const important = cards.filter((c) => c.important);
  const importantDue = important.filter((c) => isDue(c, now)).length;
  const tags = collectTags(cards).map(({ tag, count }) => ({
    tag,
    total: count,
    due: due.filter((c) => c.tags.includes(tag)).length,
  }));

  mount(
    root,
    h(
      "div",
      { class: "stack-lg" },
      h(
        "section",
        { class: "stack-sm" },
        h("h1", { class: "hero-title" }, "おかえりなさい。"),
        h(
          "p",
          { class: "muted" },
          cards.length === 0
            ? "まだカードがありません。カードパックや .txt を取り込むか、新しいカードを作りましょう。"
            : due.length > 0
              ? `復習できるカードが ${due.length} 枚あります。`
              : "今は復習するカードがありません。カードを追加するか、また後で来てください。"
        ),
        h(
          "div",
          { class: "row", style: { marginTop: "0.5rem" } },
          cards.length === 0
            ? [
                h("a", { class: "btn btn--primary", href: "#/import" }, "取り込む"),
                h("a", { class: "btn", href: "#/cards/new" }, "新しいカード"),
              ]
            : [
                h(
                  "a",
                  { class: "btn btn--primary", href: reviewHref({ scope: "due", start: true }) },
                  due.length > 0 ? `${due.length}枚を復習` : "復習"
                ),
                h(
                  "a",
                  {
                    class: "btn",
                    href: reviewHref({ scope: "all", start: true }),
                    title: "復習スケジュールを変えずに全カードを練習します",
                  },
                  `全${cards.length}枚を練習`
                ),
                h("a", { class: "btn", href: "#/cards/new" }, "新しいカード"),
              ]
        )
      ),

      cards.length > 0
        ? h(
            "section",
            { class: "stats" },
            stat("期限", due.length, true),
            stat("未定着", cards.length - mature),
            stat("定着", mature),
            stat("合計", cards.length)
          )
        : null,

      important.length > 0
        ? h(
            "section",
            { class: "tag-row" },
            h(
              "div",
              { class: "row grow" },
              h("span", { class: "tag-row__name" }, h("span", { class: "star" }, "★"), " 最重要カード"),
              h("span", { class: "tag-row__meta" }, `期限 ${importantDue} · 全 ${important.length}`)
            ),
            h(
              "div",
              { class: "row", style: { flex: "none", gap: "0.25rem" } },
              h("a", { class: "btn btn--xs btn--ghost", href: reviewHref({ important: true, scope: "all", start: true }) }, "練習"),
              h(
                "a",
                {
                  class: `btn btn--xs ${importantDue > 0 ? "btn--primary" : "btn--ghost"}`,
                  href: reviewHref({ important: true, scope: "due", start: true }),
                },
                "復習"
              )
            )
          )
        : null,

      tags.length > 0
        ? h(
            "section",
            { class: "stack-sm" },
            h("h2", { class: "section-title" }, "タグ別"),
            h(
              "ul",
              { class: "tag-grid" },
              tags.map((t) =>
                h(
                  "li",
                  { class: "tag-row" },
                  h(
                    "div",
                    { class: "row grow", style: { flexWrap: "nowrap", minWidth: 0 } },
                    h("span", { class: "tag-row__name" }, t.tag),
                    h("span", { class: "tag-row__meta" }, `期限 ${t.due} · 全 ${t.total}`)
                  ),
                  h(
                    "div",
                    { class: "row", style: { flex: "none", gap: "0.25rem", flexWrap: "nowrap" } },
                    h("a", { class: "btn btn--xs btn--ghost", href: `#/cards?tags=${encodeURIComponent(t.tag)}` }, "一覧"),
                    h(
                      "a",
                      {
                        class: "btn btn--xs btn--ghost",
                        href: reviewHref({ tags: [t.tag], scope: "all", start: true }),
                        title: "復習スケジュールを変えずにこのタグを練習します",
                      },
                      "練習"
                    ),
                    h(
                      "a",
                      {
                        class: `btn btn--xs ${t.due > 0 ? "btn--primary" : "btn--ghost"}`,
                        href: reviewHref({ tags: [t.tag], scope: "due", start: true }),
                      },
                      "復習"
                    )
                  )
                )
              )
            )
          )
        : null,

      fileSection(s),

      h(
        "section",
        { class: "panel" },
        h("h2", { class: "section-title" }, "スケジュールの仕組み"),
        h(
          "p",
          { style: { marginTop: "0.75rem", fontSize: "0.875rem", lineHeight: "1.75" } },
          "新しいカードはすぐに復習対象になります。正解するたびに次の復習が一段先になります: 10分 → 30分 → 1時間 → 2時間 → 3時間 → 6時間 → 12時間 → 1日 → 2日 → 3日 → 5日 → 10日 → 15日 → 1か月 → 2か月 → 3か月。間違えると2段下がるので、それまでの積み重ねを失わずに早めにもう一度出てきます。"
        )
      )
    )
  );
}

function stat(label, value, accent = false) {
  return h(
    "div",
    { class: `stat ${accent ? "stat--accent" : ""}` },
    h("div", { class: "stat__label" }, label),
    h("div", { class: "stat__value" }, String(value))
  );
}

function fileSection(s) {
  const handle = getFileHandle();
  return h(
    "section",
    { class: "panel panel--tight stack-sm" },
    h(
      "div",
      { class: "row-between" },
      h("h2", { class: "section-title" }, "学習ファイル"),
      s.dirty
        ? h("span", { class: "status-badge" }, "未書き出しの変更あり")
        : h("span", { class: "status-badge status-badge--ok" }, "書き出し済み")
    ),
    h(
      "dl",
      { class: "dl" },
      h("dt", null, "ファイル"),
      h("dd", null, s.source.fileName ?? "（新規）"),
      h("dt", null, "最終変更"),
      h("dd", null, s.lastChangeAt ? `${formatDateTime(s.lastChangeAt)}（${formatAgo(s.lastChangeAt)}）` : "—"),
      h("dt", null, "最終書き出し"),
      h("dd", null, s.lastExportAt ? formatDateTime(s.lastExportAt) : "まだ書き出していません")
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        { type: "button", class: `btn btn--sm ${s.dirty ? "btn--primary" : ""}`, onclick: () => openExportDialog() },
        handle ? "書き出す・上書き保存" : "書き出す"
      ),
      h("a", { class: "btn btn--sm btn--ghost", href: "#/file" }, "ファイルの管理")
    )
  );
}
