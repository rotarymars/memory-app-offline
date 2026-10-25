// Pack builder: make cards (text, images, important flag) and export them as
// a card pack .zip to import later — on this device or another. Works without
// a study file open. The draft is kept in IndexedDB until you clear it.

import { defaultPackName, safeFileName } from "../lib/format.js";
import { randomId } from "../lib/ids.js";
import { buildPackZip } from "../lib/pack-file.js";
import { APP_VERSION } from "../version.js";
import { h, mount } from "../ui/dom.js";
import { canShareFiles, download, isIOS, shareFile } from "../ui/files.js";
import { pathForBlob } from "../ui/images.js";
import { confirmDialog, toast } from "../ui/modal.js";
import { readPackDraft, writePackDraft } from "../ui/storage.js";
import { cardForm } from "./card-form.js";

/**
 * @typedef {{ id: string, front: string, back: string, important: boolean,
 *   frontImage: string | null, backImage: string | null }} DraftCard
 */

let draft = null; // { name, cards: DraftCard[] }
let draftImages = new Map(); // path → Blob
let loaded = false;
const urls = new Map();

function urlFor(path) {
  if (!path || !draftImages.has(path)) return null;
  if (!urls.has(path)) urls.set(path, URL.createObjectURL(draftImages.get(path)));
  return urls.get(path);
}

async function ensureLoaded() {
  if (loaded) return;
  const saved = await readPackDraft();
  draft = saved?.draft ?? { name: defaultPackName(), cards: [] };
  draftImages = saved?.images ?? new Map();
  loaded = true;
}

async function persist() {
  // Keep only images some draft card uses.
  const used = new Set(draft.cards.flatMap((c) => [c.frontImage, c.backImage]).filter(Boolean));
  for (const path of [...draftImages.keys()]) {
    if (!used.has(path)) {
      draftImages.delete(path);
      const url = urls.get(path);
      if (url) URL.revokeObjectURL(url);
      urls.delete(path);
    }
  }
  const ok = await writePackDraft(draft, draftImages);
  if (!ok) toast("下書きを自動保存できませんでした（このページを閉じると消えます）", { danger: true });
}

async function imageFromChange(change, existing) {
  if (change.kind === "keep") return existing;
  if (change.kind === "remove") return null;
  const path = await pathForBlob(change.blob);
  draftImages.set(path, change.blob);
  return path;
}

export async function renderPackBuilder(root) {
  await ensureLoaded();
  let editingId = null;
  let form = null;

  const nameInput = h("input", {
    class: "input",
    type: "text",
    value: draft.name,
    "aria-label": "パック名",
    onchange: () => {
      draft.name = nameInput.value.trim() || defaultPackName();
      void persist();
    },
  });

  const formBox = h("div");
  const listBox = h("div", { class: "stack-sm" });

  function openForm(card = null) {
    form?.dispose();
    editingId = card?.id ?? null;
    form = cardForm({
      showTags: false,
      initial: card
        ? {
            front: card.front,
            back: card.back,
            important: card.important,
            frontImageUrl: urlFor(card.frontImage),
            backImageUrl: urlFor(card.backImage),
          }
        : {},
      buttons: card
        ? [
            { label: "キャンセル", action: "cancel", kind: "btn--ghost", skipValidation: true },
            { label: "変更を保存", action: "save", kind: "btn--primary" },
          ]
        : [{ label: "パックに追加", action: "add", kind: "btn--primary" }],
      onSubmit: async (values, action) => {
        if (action === "cancel") {
          openForm(null);
          return;
        }
        const existing = draft.cards.find((c) => c.id === editingId);
        const next = {
          id: existing?.id ?? randomId(),
          front: values.front,
          back: values.back,
          important: values.important,
          frontImage: await imageFromChange(values.frontImage, existing?.frontImage ?? null),
          backImage: await imageFromChange(values.backImage, existing?.backImage ?? null),
        };
        draft.cards = existing
          ? draft.cards.map((c) => (c.id === existing.id ? next : c))
          : [...draft.cards, next];
        await persist();
        toast(existing ? "変更しました" : "パックに追加しました");
        openForm(null);
        drawList();
        if (!existing) form.focus();
      },
    });
    mount(
      formBox,
      h("div", { class: "stack-sm" }, h("h2", { class: "section-title" }, card ? "カードを編集" : "カードを追加"), form.element)
    );
  }

  async function exportPack(share) {
    const images = new Map();
    for (const [path, blob] of draftImages) {
      images.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
    }
    const bytes = buildPackZip({
      name: draft.name,
      cards: draft.cards,
      images,
      createdAt: new Date().toISOString(),
      appVersion: APP_VERSION,
    });
    const blob = new Blob([bytes], { type: "application/zip" });
    const fileName = `${safeFileName(draft.name)}.zip`;
    if (share) {
      if (await shareFile(blob, fileName)) toast(`共有しました: ${fileName}`);
    } else {
      download(blob, fileName);
      toast(`ダウンロードしました: ${fileName}`);
    }
  }

  function drawList() {
    const cards = draft.cards;
    mount(
      listBox,
      h(
        "div",
        { class: "row-between" },
        h("h2", { class: "section-title" }, `パックのカード（${cards.length}枚）`),
        h(
          "div",
          { class: "row" },
          cards.length
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn--sm btn--ghost btn--danger",
                  onclick: async () => {
                    const ok = await confirmDialog("下書きを消去しますか？", `${cards.length}枚のカードが消えます。`, {
                      ok: "消去",
                      danger: true,
                    });
                    if (!ok) return;
                    draft = { name: defaultPackName(), cards: [] };
                    nameInput.value = draft.name;
                    await persist();
                    openForm(null);
                    drawList();
                  },
                },
                "下書きを消去"
              )
            : null,
          canShareFiles()
            ? h(
                "button",
                {
                  type: "button",
                  class: `btn btn--sm ${isIOS() ? "btn--primary" : ""}`,
                  disabled: cards.length === 0,
                  onclick: () => exportPack(true).catch((err) => toast(String(err?.message ?? err), { danger: true })),
                },
                "共有…"
              )
            : null,
          h(
            "button",
            {
              type: "button",
              class: `btn btn--sm ${isIOS() && canShareFiles() ? "" : "btn--primary"}`,
              disabled: cards.length === 0,
              onclick: () => exportPack(false).catch((err) => toast(String(err?.message ?? err), { danger: true })),
            },
            "パックを書き出す（.zip）"
          )
        )
      ),
      cards.length === 0
        ? h("p", { class: "muted small" }, "まだカードがありません。上のフォームで追加してください。")
        : h(
            "ul",
            { class: "list list--tight" },
            cards.map((card, i) => {
              const thumb = urlFor(card.frontImage) ?? urlFor(card.backImage);
              return h(
                "li",
                { class: "card-row" },
                h(
                  "div",
                  { class: "card-row__inner" },
                  h("span", { class: "muted small tabular", style: { minWidth: "1.5rem" } }, String(i + 1)),
                  thumb ? h("img", { class: "card-row__thumb", src: thumb, alt: "" }) : null,
                  h(
                    "div",
                    { class: "grow" },
                    card.important ? h("span", { class: "chip chip--important" }, "★ 最重要") : null,
                    h("div", { class: "card-row__front", style: { marginTop: card.important ? "0.375rem" : 0 } }, card.front || "（画像のみ）"),
                    h("div", { class: "card-row__back" }, card.back || "（画像のみ）")
                  ),
                  h(
                    "div",
                    { class: "card-row__actions" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn--xs btn--ghost",
                        onclick: () => {
                          openForm(card);
                          window.scrollTo({ top: 0, behavior: "smooth" });
                        },
                      },
                      "編集"
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "btn btn--xs btn--ghost btn--danger",
                        onclick: async () => {
                          const ok = await confirmDialog("このカードをパックから外しますか？", card.front.slice(0, 60) || "（画像のみ）", {
                            ok: "外す",
                            danger: true,
                          });
                          if (!ok) return;
                          draft.cards = draft.cards.filter((c) => c.id !== card.id);
                          await persist();
                          if (editingId === card.id) openForm(null);
                          drawList();
                        },
                      },
                      "削除"
                    )
                  )
                )
              );
            })
          )
    );
  }

  mount(
    root,
    h(
      "div",
      { class: "stack" },
      h("h1", { class: "page-title" }, "パック作成"),
      h(
        "p",
        { class: "muted small" },
        "カードを作って、カードパック（.zip）として書き出します。パックは「取り込み」で学習ファイルに追加できます（タグは取り込むときに付けます）。下書きはこの端末に自動保存されます。"
      ),
      h("label", { class: "field" }, h("span", { class: "field__label" }, "パック名（ファイル名になります）"), nameInput),
      formBox,
      listBox
    )
  );
  openForm(null);
  drawList();
  return () => form?.dispose();
}
