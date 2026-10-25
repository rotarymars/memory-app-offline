// Dialogs and toasts. A plain div-based modal (rather than <dialog>) so it
// behaves the same on older iOS Safari.

import { h, mount } from "./dom.js";

let openCount = 0;

/**
 * @param {object} options
 * @param {string} options.title
 * @param {Node | Node[] | string} [options.body]
 * @param {{ label: string, kind?: string, value?: any, onClick?: () => any, keepOpen?: boolean }[]} [options.actions]
 * @param {boolean} [options.dismissible]  Esc / backdrop closes it (resolves with undefined)
 * @param {boolean} [options.row]          lay buttons out in a row on wide screens
 * @returns {{ result: Promise<any>, close: (value?: any) => void, element: HTMLElement }}
 */
export function openModal({ title, body, actions = [], dismissible = true, row = false }) {
  const root = document.getElementById("modal-root");
  let resolve;
  const result = new Promise((r) => (resolve = r));
  const previousFocus = document.activeElement;

  let closed = false;
  const close = (value) => {
    // A dialog can be closed from two places at once (Esc while a save
    // finishes); only the first counts.
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    backdrop.remove();
    openCount--;
    resolve(value);
    if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) {
      previousFocus.focus({ preventScroll: true });
    }
  };

  const onKey = (e) => {
    if (e.key === "Escape" && dismissible) {
      e.preventDefault();
      e.stopPropagation();
      close(undefined);
    }
  };

  const buttons = actions.map((a) =>
    h(
      "button",
      {
        type: "button",
        class: `btn ${a.kind ?? ""}`,
        onclick: async () => {
          if (a.onClick) {
            const out = await a.onClick();
            if (a.keepOpen) return;
            close(out === undefined ? a.value : out);
          } else {
            close(a.value);
          }
        },
      },
      a.label
    )
  );

  const titleId = `modal-title-${Date.now()}`;
  const modal = h(
    "div",
    { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId, tabindex: "-1" },
    h("h2", { class: "modal__title", id: titleId }, title),
    body ? h("div", { class: "modal__body" }, body) : null,
    buttons.length
      ? h("div", { class: `modal__actions ${row ? "modal__actions--row" : ""}` }, buttons)
      : null
  );
  const backdrop = h(
    "div",
    {
      class: "modal-backdrop",
      onclick: (e) => {
        if (e.target === backdrop && dismissible) close(undefined);
      },
    },
    modal
  );
  root.append(backdrop);
  openCount++;
  document.addEventListener("keydown", onKey, true);
  // Take focus off whatever opened the dialog, so Enter/Space can't press
  // that button again behind it.
  (buttons[0] ?? modal).focus({ preventScroll: true });
  return { result, close, element: modal };
}

export function isModalOpen() {
  return openCount > 0;
}

/**
 * Yes/no question. Resolves true for OK.
 * @param {string} title
 * @param {string | Node} [message]
 * @param {{ ok?: string, cancel?: string, danger?: boolean }} [options]
 */
export function confirmDialog(title, message, { ok = "OK", cancel = "キャンセル", danger = false } = {}) {
  return openModal({
    title,
    body: message ? (typeof message === "string" ? h("p", null, message) : message) : null,
    row: true,
    actions: [
      { label: ok, kind: danger ? "btn--solid-danger" : "btn--primary", value: true },
      { label: cancel, value: false },
    ],
  }).result.then((v) => v === true);
}

export function alertDialog(title, message) {
  return openModal({
    title,
    body: typeof message === "string" ? h("p", { class: "pre-wrap" }, message) : message,
    actions: [{ label: "OK", kind: "btn--primary", value: true }],
  }).result;
}

/**
 * A short message at the bottom of the screen.
 * @param {string} message
 * @param {{ danger?: boolean, ms?: number }} [options]
 */
export function toast(message, { danger = false, ms = 3200 } = {}) {
  const root = document.getElementById("toasts");
  if (!root) return;
  const el = h("div", { class: `toast ${danger ? "toast--danger" : ""}`, role: "status" }, message);
  // Only the latest two, so they never pile up over a dialog.
  while (root.childElementCount >= 2) root.firstElementChild.remove();
  root.append(el);
  setTimeout(() => el.remove(), ms);
}

/** A non-modal "working…" overlay for slow steps (zipping, importing). */
export function busy(message) {
  const { close, element } = openModal({ title: message, dismissible: false });
  const status = h("p", { class: "muted small" }, "");
  element.append(status);
  return {
    set: (text) => mount(status, text),
    done: () => close(),
  };
}
