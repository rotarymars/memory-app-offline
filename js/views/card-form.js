// The card editor form, shared by "new card", "edit card" and the pack
// builder: front and back text, one image per side (file pick, drag & drop or
// paste), tags (comma-separated) and the important flag.

import { h, mount, isTypingTarget } from "../ui/dom.js";
import { imageFilesFrom, prepareImage } from "../ui/images.js";
import { formatTagInput, parseTagInput } from "../lib/tags.js";

/**
 * @typedef {{ kind: "keep" } | { kind: "remove" } | { kind: "new", blob: Blob }} ImageChange
 * @typedef {{ front: string, back: string, tags: string[], important: boolean,
 *   frontImage: ImageChange, backImage: ImageChange }} CardFormValues
 */

const SIDES = ["front", "back"];
const SIDE_LABELS = { front: "表面", back: "裏面" };
const PLACEHOLDERS = { front: "問題・覚えたいこと", back: "答え・覚える内容" };

/**
 * @param {object} options
 * @param {{ front?: string, back?: string, tags?: string[], important?: boolean,
 *   frontImageUrl?: string | null, backImageUrl?: string | null }} [options.initial]
 * @param {boolean} [options.showTags]
 * @param {{ tag: string, count: number }[]} [options.tagSuggestions]
 * @param {{ label: string, action: string, kind?: string, skipValidation?: boolean }[]} options.buttons
 * @param {(values: CardFormValues, action: string) => Promise<boolean | void>} options.onSubmit
 *   resolve false to keep the form as it is (e.g. on error)
 */
export function cardForm({ initial = {}, showTags = true, tagSuggestions = [], buttons, onSubmit }) {
  const images = {
    front: { url: initial.frontImageUrl ?? null, change: { kind: "keep" }, busy: false, error: null, objectUrl: null },
    back: { url: initial.backImageUrl ?? null, change: { kind: "keep" }, busy: false, error: null, objectUrl: null },
  };
  let lastSide = "front";
  let submitting = false;

  const textareas = {
    front: h("textarea", {
      class: "textarea",
      rows: 3,
      placeholder: PLACEHOLDERS.front,
      value: initial.front ?? "",
      "aria-label": "表面",
    }),
    back: h("textarea", {
      class: "textarea",
      rows: 4,
      placeholder: PLACEHOLDERS.back,
      value: initial.back ?? "",
      "aria-label": "裏面",
    }),
  };
  const imageSlots = { front: h("div", { class: "image-field" }), back: h("div", { class: "image-field" }) };

  const tagsInput = h("input", {
    class: "input",
    type: "text",
    value: formatTagInput(initial.tags ?? []),
    placeholder: "例: 公共, 倫理（カンマ区切りで複数）",
    autocomplete: "off",
    "aria-label": "タグ",
  });
  const tagChips = h("div", { class: "filter-chips" });
  const importantBox = h("input", { type: "checkbox", checked: Boolean(initial.important) });
  const errorBox = h("p", { class: "text-danger small", role: "alert", hidden: true });
  const buttonEls = buttons.map((b) =>
    h(
      "button",
      { type: "button", class: `btn ${b.kind ?? ""}`, onclick: () => submit(b.action, b.skipValidation) },
      b.label
    )
  );

  function renderTagChips() {
    if (!showTags) return;
    const current = parseTagInput(tagsInput.value);
    mount(
      tagChips,
      tagSuggestions.slice(0, 30).map(({ tag }) =>
        h(
          "button",
          {
            type: "button",
            class: "filter-chip",
            "aria-pressed": current.includes(tag) ? "true" : "false",
            onclick: () => {
              const now = parseTagInput(tagsInput.value);
              const next = now.includes(tag) ? now.filter((t) => t !== tag) : [...now, tag];
              tagsInput.value = formatTagInput(next);
              renderTagChips();
            },
          },
          tag
        )
      )
    );
  }
  tagsInput.addEventListener("input", renderTagChips);

  function shownUrl(side) {
    const img = images[side];
    if (img.change.kind === "remove") return null;
    if (img.change.kind === "new") return img.objectUrl;
    return img.url;
  }

  function renderImage(side) {
    const img = images[side];
    const url = shownUrl(side);
    const fileInput = h("input", {
      type: "file",
      accept: "image/*",
      hidden: true,
      onchange: () => {
        const [file] = imageFilesFrom(fileInput.files);
        fileInput.value = "";
        if (file) void setImage(side, file);
      },
    });
    mount(
      imageSlots[side],
      h(
        "div",
        { class: "row" },
        h(
          "button",
          { type: "button", class: "btn btn--sm", onclick: () => fileInput.click(), disabled: img.busy },
          url ? "画像を変更" : "画像を追加"
        ),
        url
          ? h(
              "button",
              { type: "button", class: "btn btn--sm btn--ghost btn--danger", onclick: () => removeImage(side) },
              "画像を外す"
            )
          : null,
        img.busy ? h("span", { class: "muted small" }, "画像を処理中…") : null,
        h("span", { class: "muted small" }, "選択・ドロップ・貼り付け"),
        fileInput
      ),
      img.error ? h("p", { class: "text-danger small" }, img.error) : null,
      url ? h("div", { class: "image-preview" }, h("img", { src: url, alt: `${SIDE_LABELS[side]}の画像` })) : null
    );
  }

  async function setImage(side, file) {
    const img = images[side];
    img.busy = true;
    img.error = null;
    renderImage(side);
    try {
      const blob = await prepareImage(file);
      if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
      img.objectUrl = URL.createObjectURL(blob);
      img.change = { kind: "new", blob };
    } catch (err) {
      img.error = err?.message ?? "画像を読み込めませんでした";
    } finally {
      img.busy = false;
      renderImage(side);
    }
  }

  function removeImage(side) {
    const img = images[side];
    if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
    img.objectUrl = null;
    img.change = img.url ? { kind: "remove" } : { kind: "keep" };
    img.error = null;
    renderImage(side);
  }

  function sideBox(side) {
    const box = h(
      "div",
      { class: "side-box", dataset: { side } },
      h("label", { class: "field" }, h("span", { class: "field__label" }, SIDE_LABELS[side]), textareas[side]),
      imageSlots[side]
    );
    box.addEventListener("focusin", () => (lastSide = side));
    box.addEventListener("pointerdown", () => (lastSide = side));
    // Dropping an image anywhere on this side attaches it here.
    box.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      imageSlots[side].classList.add("is-over");
    });
    box.addEventListener("dragleave", (e) => {
      if (!box.contains(e.relatedTarget)) imageSlots[side].classList.remove("is-over");
    });
    box.addEventListener("drop", (e) => {
      imageSlots[side].classList.remove("is-over");
      const [file] = imageFilesFrom(e.dataTransfer?.files);
      if (!file) return;
      e.preventDefault();
      e.stopPropagation();
      void setImage(side, file);
    });
    return box;
  }

  async function submit(action, skipValidation = false) {
    if (submitting) return;
    if (images.front.busy || images.back.busy) return;
    const values = {
      front: textareas.front.value.trim(),
      back: textareas.back.value.trim(),
      tags: parseTagInput(tagsInput.value),
      important: importantBox.checked,
      frontImage: images.front.change,
      backImage: images.back.change,
    };
    const hasImage = (side) => shownUrl(side) !== null;
    if (!skipValidation) {
      if (!values.front && !hasImage("front")) return showError("表面に文字か画像を入れてください。");
      if (!values.back && !hasImage("back")) return showError("裏面に文字か画像を入れてください。");
    }
    errorBox.hidden = true;
    submitting = true;
    buttonEls.forEach((b) => (b.disabled = true));
    try {
      await onSubmit(values, action);
    } catch (err) {
      showError(err?.message ?? String(err));
    } finally {
      submitting = false;
      buttonEls.forEach((b) => (b.disabled = false));
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  const element = h(
    "form",
    {
      class: "panel stack",
      onsubmit: (e) => {
        e.preventDefault();
        void submit(buttons[0]?.action);
      },
    },
    sideBox("front"),
    sideBox("back"),
    showTags
      ? h(
          "div",
          { class: "field" },
          h("span", { class: "field__label" }, "タグ ", h("span", { class: "muted" }, "（任意・カンマ区切り）")),
          tagsInput,
          tagChips
        )
      : null,
    h("label", { class: "check" }, importantBox, h("span", null, h("span", { class: "star" }, "★"), " 最重要カード")),
    errorBox,
    h("div", { class: "row", style: { justifyContent: "flex-end" } }, buttonEls)
  );

  // Pasting an image puts it on the side it was pasted into (or the side you
  // were last working on). Text on the clipboard wins inside a text field:
  // Office apps put a picture of the copied text there too.
  element.addEventListener("paste", (e) => {
    const data = e.clipboardData;
    if (!data) return;
    if (isTypingTarget(e.target) && data.getData("text/plain")) return;
    const [file] = imageFilesFrom(data.files);
    if (!file) return;
    e.preventDefault();
    const side = e.target instanceof Element ? e.target.closest("[data-side]")?.dataset.side : null;
    void setImage(side ?? lastSide, file);
  });

  renderImage("front");
  renderImage("back");
  renderTagChips();

  return {
    element,
    focus: () => textareas.front.focus(),
    /** Clears text and images; keeps tags (and the flag if asked). */
    reset({ keepImportant = false } = {}) {
      textareas.front.value = "";
      textareas.back.value = "";
      if (!keepImportant) importantBox.checked = false;
      for (const side of SIDES) {
        const img = images[side];
        if (img.objectUrl) URL.revokeObjectURL(img.objectUrl);
        Object.assign(img, { url: null, change: { kind: "keep" }, busy: false, error: null, objectUrl: null });
        renderImage(side);
      }
      errorBox.hidden = true;
    },
    /** Revokes preview URLs when the view goes away. */
    dispose() {
      for (const side of SIDES) if (images[side].objectUrl) URL.revokeObjectURL(images[side].objectUrl);
    },
  };
}

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}
