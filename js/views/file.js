// The study file: what's open, exporting, opening another, settings, and the
// state of this device's autosave.

import { formatAgo, formatBytes, formatDateTime } from "../lib/format.js";
import { parseReviewOrder, REVIEW_ORDER_LABELS, REVIEW_ORDERS } from "../lib/review-order.js";
import { STUDY_FORMAT_VERSION } from "../lib/study-file.js";
import { APP_VERSION } from "../version.js";
import { h, mount } from "../ui/dom.js";
import { pickStudyFile, supportsFileHandles } from "../ui/files.js";
import { requestPersistence, storageEstimate } from "../ui/storage.js";
import {
  getFileHandle,
  getLastExport,
  getSaveStatus,
  getState,
  totalImageBytes,
  update,
} from "../ui/store.js";
import { openExportDialog, openStudyFile, startEmpty } from "../ui/study.js";

export async function renderFile(root, { onReload }) {
  const s = getState();
  const handle = getFileHandle();
  const lastExport = await getLastExport();
  const { status, error, storageOk } = getSaveStatus();
  let persisted = null;
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? null;
  } catch {
    persisted = null;
  }
  const estimate = await storageEstimate();

  const openOther = async () => {
    const picked = await pickStudyFile();
    if (picked && (await openStudyFile(picked.file, picked.handle))) onReload("#/");
  };

  mount(
    root,
    h(
      "div",
      { class: "stack" },
      h("h1", { class: "page-title" }, "ファイル"),
      h(
        "section",
        { class: "panel stack-sm" },
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
          h("dd", null, s.source.fileName ?? "（新規・まだ書き出していません）"),
          handle ? [h("dt", null, "上書き先"), h("dd", null, `${handle.name}（このブラウザで開いたファイル）`)] : null,
          h("dt", null, "カード"),
          h("dd", null, `${s.cards.length}枚`),
          h("dt", null, "画像"),
          h("dd", null, `${s.images.size}枚（${formatBytes(totalImageBytes())}）`),
          h("dt", null, "最終変更"),
          h("dd", null, s.lastChangeAt ? `${formatDateTime(s.lastChangeAt)}（${formatAgo(s.lastChangeAt)}）` : "—"),
          h("dt", null, "このデータの書き出し"),
          h("dd", null, s.lastExportAt ? formatDateTime(s.lastExportAt) : "まだ書き出していません"),
          h("dt", null, "この端末の最終書き出し"),
          h("dd", null, lastExport ? `${formatDateTime(lastExport.exportedAt)}${lastExport.fileName ? `（${lastExport.fileName}）` : ""}` : "—")
        ),
        h(
          "div",
          { class: "row", style: { marginTop: "0.5rem" } },
          h("button", { type: "button", class: "btn btn--primary", onclick: () => openExportDialog() }, "書き出す"),
          h("button", { type: "button", class: "btn", onclick: openOther }, "別の学習ファイルを開く"),
          h(
            "button",
            {
              type: "button",
              class: "btn btn--ghost btn--danger",
              onclick: async () => {
                if (await startEmpty()) onReload("#/");
              },
            },
            "空のデータで始める"
          )
        ),
        h(
          "p",
          { class: "muted small" },
          supportsFileHandles
            ? "このブラウザでは、開いたファイルに「上書き保存」できます。"
            : "このブラウザでは、書き出すたびに新しいファイル（memory-study_日付_時刻.zip）として保存されます。古いファイルは自分で整理してください。"
        )
      ),
      h(
        "section",
        { class: "panel stack-sm" },
        h("h2", { class: "section-title" }, "設定"),
        h(
          "label",
          { class: "field" },
          h("span", { class: "field__label" }, "復習の順番"),
          h(
            "select",
            {
              class: "select",
              onchange: (e) => {
                const order = parseReviewOrder(e.target.value);
                update((st) => ({ settings: { ...st.settings, reviewOrder: order } }));
              },
            },
            REVIEW_ORDERS.map((o) => h("option", { value: o, selected: s.settings.reviewOrder === o }, REVIEW_ORDER_LABELS[o]))
          ),
          h("span", { class: "muted small" }, "学習ファイル（meta.json）に保存されます。")
        )
      ),
      h(
        "section",
        { class: "panel stack-sm" },
        h("h2", { class: "section-title" }, "この端末の自動保存"),
        h(
          "p",
          { class: "small" },
          !storageOk
            ? "使えません（IndexedDB が無効です）。こまめに書き出してください。"
            : status === "error"
              ? `保存に失敗しました: ${error?.message ?? error}。空き容量を確認し、今すぐ書き出してください。`
              : "変更はすべてこの端末（ブラウザの IndexedDB）に自動保存されています。書き出しを忘れても、次に開いたときに復元できます。"
        ),
        estimate?.usage !== undefined
          ? h("p", { class: "muted small" }, `使用量: ${formatBytes(estimate.usage)}${estimate.quota ? ` / 上限 約${formatBytes(estimate.quota)}` : ""}`)
          : null,
        persisted === true
          ? h("p", { class: "muted small" }, "保存領域は保護されています（ブラウザが勝手に消しません）。")
          : persisted === false
            ? h(
                "div",
                { class: "row" },
                h(
                  "span",
                  { class: "muted small" },
                  "保存領域は保護されていません。容量が足りなくなるとブラウザが消すことがあります。"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "btn btn--sm",
                    onclick: async () => {
                      await requestPersistence();
                      onReload("#/file");
                    },
                  },
                  "保護をリクエスト"
                )
              )
            : null
      ),
      h(
        "p",
        { class: "muted small" },
        `Memory オフライン v${APP_VERSION} · 学習ファイル形式 v${STUDY_FORMAT_VERSION}`
      )
    )
  );
}
