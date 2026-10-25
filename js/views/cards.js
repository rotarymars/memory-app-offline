// Card list (search, tag and important filters, bulk delete) and the new /
// edit screens — after memory-app/app/cards.

import {
  createCard,
  filterCards,
  isDue,
  sortNewestFirst,
} from "../lib/cards.js";
import { formatDateTime } from "../lib/format.js";
import {
  formatInterval,
  formatTimeUntil,
  intervalMinutesForLevel,
} from "../lib/spaced-repetition.js";
import { collectTags } from "../lib/tags.js";
import { h, mount, toggleChip } from "../ui/dom.js";
import { pathForBlob } from "../ui/images.js";
import { confirmDialog, toast } from "../ui/modal.js";
import { goBack } from "../ui/nav.js";
import { getState, imageUrl, update } from "../ui/store.js";
import { cardForm } from "./card-form.js";
import { reviewHref } from "./review.js";

const PAGE_SIZE = 100;

export function renderCardList(root, params) {
  let query = params.get("q") ?? "";
  let tags = params.getAll("tags").length ? params.getAll("tags") : [];
  let untagged = params.get("untagged") === "1";
  let important = params.get("important") ?? "all"; // all | only | not
  let limit = PAGE_SIZE;
  const selected = new Set();

  tags = tags.filter((t) => collectTags(getState().cards).some((x) => x.tag === t));

  const searchInput = h("input", {
    class: "input",
    type: "search",
    placeholder: "検索（表・裏・タグ）",
    value: query,
    "aria-label": "検索",
    oninput: () => {
      query = searchInput.value;
      limit = PAGE_SIZE;
      drawList();
    },
  });
  const filterBox = h("div", { class: "stack-sm" });
  const listBox = h("div", { class: "stack-sm" });
  // New cards start with the tags you're looking at.
  const newCardLink = h("a", { class: "btn btn--sm btn--primary", href: "#/cards/new" }, "新しいカード");

  // Keep the filters in the URL so Back from the editor returns to them.
  function syncUrl() {
    const q = new URLSearchParams();
    if (query) q.set("q", query);
    for (const t of tags) q.append("tags", t);
    if (untagged) q.set("untagged", "1");
    if (important !== "all") q.set("important", important);
    const next = `#/cards${q.toString() ? `?${q}` : ""}`;
    if (location.hash !== next) history.replaceState(null, "", next);
    const t = new URLSearchParams();
    for (const tag of tags) t.append("tags", tag);
    newCardLink.href = `#/cards/new${tags.length ? `?${t}` : ""}`;
  }

  function visibleCards() {
    const s = getState();
    let list = filterCards(s.cards, { tags, untagged, query, importantOnly: important === "only" });
    if (important === "not") list = list.filter((c) => !c.important);
    return sortNewestFirst(list);
  }

  function drawFilters() {
    const s = getState();
    // Recounted each time: deleting cards changes the counts (or removes a tag).
    const allTags = collectTags(s.cards);
    tags = tags.filter((t) => allTags.some((x) => x.tag === t));
    const hasUntagged = s.cards.some((c) => c.tags.length === 0);
    mount(
      filterBox,
      allTags.length || hasUntagged
        ? h(
            "div",
            { class: "filter-chips" },
            toggleChip("すべて", tags.length === 0 && !untagged, () => {
              tags = [];
              untagged = false;
              limit = PAGE_SIZE;
              drawFilters();
              drawList();
            }),
            allTags.map(({ tag, count }) =>
              toggleChip(
                tag,
                tags.includes(tag),
                (on) => {
                  tags = on ? [...tags, tag] : tags.filter((t) => t !== tag);
                  limit = PAGE_SIZE;
                  drawFilters();
                  drawList();
                },
                h("span", { class: "count" }, `(${count})`)
              )
            ),
            hasUntagged
              ? toggleChip("タグなし", untagged, (on) => {
                  untagged = on;
                  limit = PAGE_SIZE;
                  drawFilters();
                  drawList();
                })
              : null
          )
        : null,
      h(
        "div",
        { class: "segmented", role: "radiogroup", "aria-label": "最重要" },
        [
          ["all", "すべて"],
          ["only", "★ 最重要だけ"],
          ["not", "最重要以外"],
        ].map(([value, label]) =>
          h(
            "label",
            null,
            h("input", {
              type: "radio",
              name: "important-filter",
              value,
              checked: important === value,
              onchange: () => {
                important = value;
                limit = PAGE_SIZE;
                drawList();
              },
            }),
            h("span", null, label)
          )
        )
      )
    );
  }

  function drawList() {
    syncUrl();
    const now = new Date();
    const cards = visibleCards();
    for (const id of [...selected]) if (!cards.some((c) => c.id === id)) selected.delete(id);
    const shown = cards.slice(0, limit);
    const selectedCount = selected.size;
    const allSelected = cards.length > 0 && selectedCount === cards.length;

    const selectAll = h("input", {
      type: "checkbox",
      class: "card-row__check",
      checked: allSelected,
      indeterminate: selectedCount > 0 && !allSelected,
      onchange: () => {
        if (allSelected) selected.clear();
        else for (const c of cards) selected.add(c.id);
        drawList();
      },
    });

    mount(
      listBox,
      tags.length || untagged || important === "only"
        ? h(
            "div",
            { class: "banner banner--accent" },
            h("span", null, `${cards.length}枚が該当します。`),
            h(
              "a",
              {
                class: "link",
                href: reviewHref({ tags, untagged, important: important === "only", scope: "due" }),
              },
              "この条件で復習 →"
            )
          )
        : null,
      cards.length === 0
        ? h(
            "div",
            { class: "panel panel--dashed" },
            h("p", { class: "muted" }, getState().cards.length === 0 ? "まだカードがありません。" : "条件に合うカードがありません。"),
            getState().cards.length === 0
              ? h("a", { class: "link", href: "#/cards/new", style: { display: "inline-block", marginTop: "0.75rem" } }, "最初のカードを作る →")
              : null
          )
        : [
            h(
              "div",
              { class: "toolbar" },
              h(
                "label",
                { class: "check" },
                selectAll,
                selectedCount > 0 ? `${selectedCount}枚を選択中` : `すべて選択（${cards.length}）`
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "btn btn--sm btn--ghost btn--danger",
                  disabled: selectedCount === 0,
                  onclick: () => deleteCards([...selected]),
                },
                `選択したカードを削除${selectedCount > 0 ? `（${selectedCount}）` : ""}`
              )
            ),
            h("ul", { class: "list" }, shown.map((card) => cardRow(card, now))),
            cards.length > shown.length
              ? h(
                  "button",
                  {
                    type: "button",
                    class: "btn",
                    onclick: () => {
                      limit += PAGE_SIZE;
                      drawList();
                    },
                  },
                  `さらに表示（残り ${cards.length - shown.length} 枚）`
                )
              : null,
          ]
    );
  }

  function cardRow(card, now) {
    const due = isDue(card, now);
    const next = new Date(card.nextReviewAt);
    const thumb = imageUrl(card.frontImage) ?? imageUrl(card.backImage);
    return h(
      "li",
      { class: `card-row ${selected.has(card.id) ? "is-selected" : ""}` },
      h(
        "div",
        { class: "card-row__inner" },
        h("input", {
          type: "checkbox",
          class: "card-row__check",
          checked: selected.has(card.id),
          "aria-label": `選択: ${card.front.slice(0, 40)}`,
          onchange: (e) => {
            if (e.target.checked) selected.add(card.id);
            else selected.delete(card.id);
            drawList();
          },
        }),
        thumb ? h("img", { class: "card-row__thumb", src: thumb, alt: "" }) : null,
        h(
          "div",
          { class: "grow" },
          h(
            "div",
            { class: "card-row__meta" },
            card.important ? h("span", { class: "chip chip--important" }, "★ 最重要") : null,
            h(
              "span",
              { class: `chip ${due ? "chip--due" : ""}` },
              `L${card.reviewLevel} · ${formatInterval(intervalMinutesForLevel(card.reviewLevel))}`
            ),
            card.tags.map((t) =>
              h(
                "button",
                {
                  type: "button",
                  class: "chip",
                  onclick: () => {
                    tags = [t];
                    untagged = false;
                    limit = PAGE_SIZE;
                    drawFilters();
                    drawList();
                  },
                },
                t
              )
            ),
            h("span", { title: formatDateTime(next) }, due ? "期限" : `あと ${formatTimeUntil(next, now)}`)
          ),
          h("div", { class: "card-row__front" }, card.front || "（画像のみ）"),
          h("div", { class: "card-row__back" }, card.back || "（画像のみ）")
        ),
        h(
          "div",
          { class: "card-row__actions" },
          h("a", { class: "btn btn--xs btn--ghost", href: `#/cards/${encodeURIComponent(card.id)}` }, "編集"),
          h(
            "button",
            { type: "button", class: "btn btn--xs btn--ghost btn--danger", onclick: () => deleteCards([card.id]) },
            "削除"
          )
        )
      )
    );
  }

  async function deleteCards(ids) {
    if (ids.length === 0) return;
    const s = getState();
    const one = ids.length === 1 ? s.cards.find((c) => c.id === ids[0]) : null;
    const ok = await confirmDialog(
      ids.length === 1 ? "このカードを削除しますか？" : `${ids.length}枚のカードを削除しますか？`,
      one ? `「${one.front.slice(0, 60) || "（画像のみ）"}」を削除します。学習の記録も消えます。` : "学習の記録も消えます。元に戻せません。",
      { ok: "削除", danger: true }
    );
    if (!ok) return;
    const gone = new Set(ids);
    update((st) => ({ cards: st.cards.filter((c) => !gone.has(c.id)) }));
    for (const id of ids) selected.delete(id);
    toast(`${ids.length}枚を削除しました`);
    drawFilters();
    drawList();
  }

  mount(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row-between" },
        h("h1", { class: "page-title" }, "カード"),
        h(
          "div",
          { class: "row" },
          h("a", { class: "btn btn--sm", href: "#/import" }, "取り込み"),
          newCardLink
        )
      ),
      searchInput,
      filterBox,
      listBox
    )
  );
  drawFilters();
  drawList();
}

// ---- New / edit ------------------------------------------------------------

async function resolveImage(change, existing) {
  if (change.kind === "keep") return { path: existing, blob: null };
  if (change.kind === "remove") return { path: null, blob: null };
  return { path: await pathForBlob(change.blob), blob: change.blob };
}

async function applyForm(values, existing = null) {
  const front = await resolveImage(values.frontImage, existing?.frontImage ?? null);
  const back = await resolveImage(values.backImage, existing?.backImage ?? null);
  const putImages = new Map();
  if (front.blob) putImages.set(front.path, front.blob);
  if (back.blob) putImages.set(back.path, back.blob);
  return {
    fields: {
      front: values.front,
      back: values.back,
      tags: values.tags,
      important: values.important,
      frontImage: front.path,
      backImage: back.path,
    },
    putImages,
  };
}

export function renderCardNew(root, params) {
  const s = getState();
  const known = new Set(collectTags(s.cards).map((t) => t.tag));
  const form = cardForm({
    initial: { tags: params.getAll("tags").filter((t) => known.has(t)) },
    tagSuggestions: collectTags(s.cards),
    buttons: [
      { label: "追加して続ける", action: "next", kind: "" },
      { label: "追加", action: "done", kind: "btn--primary" },
    ],
    onSubmit: async (values, action) => {
      const { fields, putImages } = await applyForm(values);
      const card = createCard(fields);
      update((st) => ({ cards: [...st.cards, card] }), { putImages });
      toast("カードを追加しました");
      if (action === "next") {
        form.reset();
        form.focus();
      } else {
        goBack("#/cards");
      }
    },
  });
  mount(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row-between" },
        h("h1", { class: "page-title" }, "新しいカード"),
        h("a", { class: "muted small", href: "#/cards" }, "← カード一覧へ")
      ),
      form.element,
      h("p", { class: "muted small" }, "たくさん登録するときは、.txt やカードパックの「取り込み」が便利です。")
    )
  );
  form.focus();
  return () => form.dispose();
}

export function renderCardEdit(root, id) {
  const s = getState();
  const card = s.cards.find((c) => c.id === id);
  if (!card) {
    mount(
      root,
      h(
        "div",
        { class: "empty-state" },
        h("h1", { class: "page-title" }, "カードが見つかりません"),
        h("a", { class: "link", href: "#/cards" }, "← カード一覧へ")
      )
    );
    return undefined;
  }
  const form = cardForm({
    initial: {
      front: card.front,
      back: card.back,
      tags: card.tags,
      important: card.important,
      frontImageUrl: imageUrl(card.frontImage),
      backImageUrl: imageUrl(card.backImage),
    },
    tagSuggestions: collectTags(s.cards),
    buttons: [
      { label: "削除", action: "delete", kind: "btn--ghost btn--danger", skipValidation: true },
      { label: "変更を保存", action: "save", kind: "btn--primary" },
    ],
    onSubmit: async (values, action) => {
      if (action === "delete") {
        const ok = await confirmDialog("このカードを削除しますか？", "学習の記録も消えます。元に戻せません。", {
          ok: "削除",
          danger: true,
        });
        if (!ok) return;
        update((st) => ({ cards: st.cards.filter((c) => c.id !== id) }));
        toast("カードを削除しました");
        goBack("#/cards");
        return;
      }
      const latest = getState().cards.find((c) => c.id === id);
      if (!latest) throw new Error("このカードは削除されています");
      const { fields, putImages } = await applyForm(values, latest);
      const changed =
        fields.front !== latest.front ||
        fields.back !== latest.back ||
        fields.important !== latest.important ||
        fields.frontImage !== latest.frontImage ||
        fields.backImage !== latest.backImage ||
        fields.tags.join("\u0000") !== latest.tags.join("\u0000");
      if (changed) {
        const updatedAt = new Date().toISOString();
        update(
          (st) => ({ cards: st.cards.map((c) => (c.id === id ? { ...c, ...fields, updatedAt } : c)) }),
          { putImages }
        );
        toast("保存しました");
      }
      goBack("#/cards");
    },
  });
  mount(
    root,
    h(
      "div",
      { class: "stack" },
      h(
        "div",
        { class: "row-between" },
        h("h1", { class: "page-title" }, "カードを編集"),
        h("a", { class: "muted small", href: "#/cards" }, "← カード一覧へ")
      ),
      form.element,
      h(
        "p",
        { class: "muted small" },
        `現在のレベル: L${card.reviewLevel} · 次の復習: ${formatDateTime(card.nextReviewAt)} · 回答: もう一度 ${card.againCount} / 難しい ${card.downCount} / 正解 ${card.goodCount} / 簡単 ${card.greatCount}`
      )
    )
  );
  return () => form.dispose();
}
