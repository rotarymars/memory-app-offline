// The first screen when no study data is loaded: open the study file, carry on
// with this device's saved copy, or start empty.

import { formatAgo, formatDateTime } from "../lib/format.js";
import { h, mount } from "../ui/dom.js";
import { isIOS, isStandalone, pickStudyFile } from "../ui/files.js";
import * as storage from "../ui/storage.js";
import { getSaveStatus } from "../ui/store.js";
import { openStudyFile, resumeDeviceCopy, startEmpty } from "../ui/study.js";

export async function renderLaunch(root, { onLoaded }) {
  const meta = await storage.readSnapshotMeta();
  const hasCopy = meta && ((meta.cardCount ?? 0) > 0 || meta.dirty);
  const { storageOk } = getSaveStatus();

  const open = async () => {
    const picked = await pickStudyFile();
    if (picked && (await openStudyFile(picked.file, picked.handle))) onLoaded();
  };

  const resume = async () => {
    if (await resumeDeviceCopy()) onLoaded();
  };

  const empty = async () => {
    if (await startEmpty()) onLoaded("#/");
  };

  const dropzone = h(
    "div",
    { class: "dropzone", id: "launch-drop" },
    h(
      "button",
      { type: "button", class: "btn btn--primary btn--lg", onclick: open },
      "学習ファイルを開く"
    ),
    h("span", { class: "small only-wide" }, "または .zip をここにドロップ")
  );

  mount(
    root,
    h(
      "div",
      { class: "launch" },
      h("div", { class: "stack-sm" }, h("h1", { class: "hero-title" }, "Memory オフライン"),
        h(
          "p",
          { class: "muted" },
          "学習ファイル（.zip）を開いて復習・編集し、終わったら書き出します。作業中のデータはこの端末にも自動で保存されます。"
        )
      ),
      hasCopy
        ? h(
            "section",
            { class: `panel panel--tight stack-sm ${meta.dirty ? "panel--accent" : ""}` },
            h("div", { class: "row-between" }, h("b", null, "この端末のデータ"),
              meta.dirty ? h("span", { class: "status-badge" }, "未書き出しの変更あり") : null
            ),
            h(
              "dl",
              { class: "dl" },
              h("dt", null, "カード"),
              h("dd", null, `${meta.cardCount ?? 0}枚`),
              meta.source?.fileName ? [h("dt", null, "ファイル"), h("dd", null, meta.source.fileName)] : null,
              h("dt", null, "最終変更"),
              h("dd", null, meta.lastChangeAt ? `${formatDateTime(meta.lastChangeAt)}（${formatAgo(meta.lastChangeAt)}）` : "—"),
              h("dt", null, "最終書き出し"),
              h("dd", null, meta.lastExportAt ? formatDateTime(meta.lastExportAt) : "まだ書き出していません")
            ),
            h(
              "button",
              { type: "button", class: `btn ${meta.dirty ? "btn--primary" : ""} btn--block`, onclick: resume },
              "この端末のデータで続ける"
            ),
            h(
              "p",
              { class: "muted small" },
              "別の端末で更新したファイルがあるときは、そちらを開いてください。"
            )
          )
        : null,
      dropzone,
      h(
        "div",
        { class: "row", style: { justifyContent: "center" } },
        h("button", { type: "button", class: "btn", onclick: empty }, "空のデータで始める"),
        h("a", { class: "btn btn--ghost", href: "#/pack" }, "カードパックを作る")
      ),
      storageOk
        ? null
        : h(
            "p",
            { class: "banner banner--danger" },
            `この環境では自動保存（IndexedDB）が使えません${storage.storageError() ? `（${storage.storageError()}）` : ""}。こまめに書き出してください。`
          ),
      isIOS() && !isStandalone()
        ? h(
            "p",
            { class: "muted small" },
            "ヒント: Safari の共有ボタン →「ホーム画面に追加」で、オフラインでも開けるアプリとして使えます。"
          )
        : null
    )
  );

  // Desktop drag & drop onto the drop zone (the app-wide handler covers the
  // rest of the window).
  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("is-over");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-over"));
  dropzone.addEventListener("drop", () => dropzone.classList.remove("is-over"));
}
