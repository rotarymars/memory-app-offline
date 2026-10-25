// Opening, resuming, starting and exporting the study data — the flows around
// the one study file, including the "you have newer data on this device"
// check that guards against a forgotten export.

import { formatAgo, formatBytes, formatDateTime, studyFileName } from "../lib/format.js";
import { baselineChangeTime, changedOnDisk, decideOnOpen } from "../lib/snapshot.js";
import { buildStudyZip, normalizeSettings, parseStudyZip, peekStudyMeta } from "../lib/study-file.js";
import { FileFormatError } from "../lib/zip.js";
import { APP_VERSION } from "../version.js";
import { h, mount } from "./dom.js";
import {
  canShareFiles,
  download,
  ensureWritable,
  isIOS,
  saveAs,
  saveToHandle,
  shareFile,
  supportsFileHandles,
  supportsSaveAs,
} from "./files.js";
import { alertDialog, busy, confirmDialog, openModal, toast } from "./modal.js";
import * as storage from "./storage.js";
import * as store from "./store.js";

// Files dropped or picked somewhere else that the import view should pick up.
let pendingImportFiles = null;

export function setPendingImport(files) {
  pendingImportFiles = files;
}

export function takePendingImport() {
  const files = pendingImportFiles;
  pendingImportFiles = null;
  return files;
}

function stateFromFile(parsed, fileName) {
  const images = new Map();
  for (const [path, img] of parsed.images) {
    images.set(path, new Blob([img.bytes], { type: img.type }));
  }
  return {
    cards: parsed.cards,
    daily: parsed.daily,
    settings: parsed.settings,
    images,
    dirty: false,
    lastChangeAt: baselineChangeTime(parsed),
    lastExportAt: parsed.exportedAt,
    source: { fileName, exportedAt: parsed.exportedAt, openedAt: new Date().toISOString() },
  };
}

/** What this device holds: from memory when loaded, else from IndexedDB. */
export async function deviceCopyInfo() {
  const s = store.getState();
  if (s) {
    return {
      dirty: s.dirty,
      lastChangeAt: s.lastChangeAt,
      cardCount: s.cards.length,
      fileName: s.source.fileName,
      lastExportAt: s.lastExportAt,
    };
  }
  const meta = await storage.readSnapshotMeta();
  if (!meta) return null;
  return {
    dirty: Boolean(meta.dirty),
    lastChangeAt: meta.lastChangeAt ?? null,
    cardCount: meta.cardCount ?? 0,
    fileName: meta.source?.fileName ?? null,
    lastExportAt: meta.lastExportAt ?? null,
  };
}

/**
 * Loads this device's saved copy from IndexedDB into the app.
 * @returns {Promise<boolean>} false if there's none
 */
export async function resumeDeviceCopy() {
  const snap = await storage.readSnapshot();
  if (!snap) return false;
  const m = snap.meta;
  await store.replaceState(
    {
      cards: snap.cards,
      daily: m.daily ?? {},
      settings: normalizeSettings(m.settings),
      images: snap.images,
      dirty: Boolean(m.dirty),
      lastChangeAt: m.lastChangeAt ?? null,
      lastExportAt: m.lastExportAt ?? null,
      source: m.source ?? { fileName: null, exportedAt: null, openedAt: null },
      snapshotId: m.snapshotId ?? null,
    },
    { persist: false }
  );
  await store.restoreFileHandle(m.source?.fileName ?? null);
  return true;
}

/**
 * Opens a study file the user picked or dropped. If this device holds newer or
 * unexported data, or the file looks older than one exported from here, asks
 * which to use first.
 * @param {File} file
 * @param {FileSystemFileHandle | null} [handle]
 * @returns {Promise<boolean>} whether the app now has data loaded from it (or kept)
 */
export async function openStudyFile(file, handle = null) {
  const work = busy("ファイルを読み込んでいます…");
  let parsed;
  try {
    parsed = parseStudyZip(new Uint8Array(await file.arrayBuffer()));
  } catch (err) {
    work.done();
    if (err instanceof FileFormatError && err.kind === "is-pack") {
      if (!store.hasState()) {
        await alertDialog(
          "カードパックです",
          "このファイルは学習ファイルではなくカードパックです。先に学習ファイルを開くか「空のデータで始める」を選んでから、「取り込み」で追加してください。"
        );
        return false;
      }
      const go = await confirmDialog(
        "カードパックです",
        "このファイルは学習ファイルではなくカードパックです。「取り込み」で今の学習データに追加できます。",
        { ok: "取り込み画面へ" }
      );
      if (go) {
        setPendingImport([file]);
        location.hash = "#/import";
      }
      return false;
    }
    await alertDialog("ファイルを開けませんでした", err?.message ?? String(err));
    return false;
  }
  work.done();

  const device = await deviceCopyInfo();
  const lastExport = await store.getLastExport();
  const decision = decideOnOpen(device, parsed, lastExport);
  let choice = "file";
  if (decision.offerRestore || decision.olderThanLastExport) {
    choice = await askWhichCopy({ file, parsed, device, decision, lastExport });
    if (!choice) return false;
  }

  if (choice === "device") {
    if (!store.hasState() && !(await resumeDeviceCopy())) {
      await alertDialog("読み込めませんでした", "この端末のデータを読み込めませんでした。");
      return false;
    }
    // The opened file becomes where "上書き保存" writes to.
    if (handle) store.setFileHandle(handle);
    toast("この端末のデータを使います");
    return true;
  }

  await store.replaceState(stateFromFile(parsed, file.name), { handle });
  toast(`${file.name} を開きました（${parsed.cards.length}枚）`);
  if (parsed.warnings.length > 0) showWarnings("読み込み時の注意", parsed.warnings);
  return true;
}

export function showWarnings(title, warnings) {
  return alertDialog(
    title,
    h(
      "div",
      { class: "stack-sm" },
      h("p", null, `${warnings.length}件あります。`),
      h("ul", { class: "warn-list" }, warnings.slice(0, 200).map((w) => h("li", null, w)))
    )
  );
}

function timeLine(label, iso) {
  return h(
    "div",
    null,
    `${label}: `,
    iso ? h("b", null, formatDateTime(iso)) : "—",
    iso ? h("span", { class: "muted nowrap" }, `（${formatAgo(iso)}）`) : null
  );
}

/**
 * @returns {Promise<"device" | "file" | null>}
 */
async function askWhichCopy({ file, parsed, device, decision, lastExport }) {
  const deviceHas = device && (device.cardCount > 0 || device.dirty);
  const deviceNewer = decision.deviceNewer;
  // This device has unexported changes, but the file was saved after them —
  // most likely on another device. Both sides have something the other lacks.
  const bothChanged = decision.reason === "unexported" && !deviceNewer;

  const lines = [];
  if (bothChanged) {
    lines.push(
      h(
        "p",
        null,
        "開いたファイルの方が新しいですが、この端末にもまだ書き出していない変更があります。両方をまとめることはできないので、どちらかを選んでください。"
      ),
      h(
        "p",
        { class: "muted small" },
        "迷ったら、先に「端末のデータをバックアップとして書き出す」で保存しておくと安全です。"
      )
    );
  } else if (decision.reason === "unexported") {
    lines.push(h("p", null, "この端末には、まだ書き出していない変更があります。"));
  } else if (decision.reason === "newer") {
    lines.push(h("p", null, "この端末のデータの方が、開いたファイルより新しいです。"));
  }
  if (decision.olderThanLastExport) {
    lines.push(
      h(
        "p",
        { class: "banner banner--warning" },
        `開いたファイルは、この端末で最後に書き出したデータ（${formatDateTime(lastExport.exportedAt)}）より古いです。最新のファイルか確認してください。`
      )
    );
  }

  const newerTag = h("span", { class: "text-success" }, "（新しい）");
  const fileBox = h(
    "div",
    { class: `compare__box ${deviceNewer ? "" : "compare__box--newer"}` },
    h("div", { class: "compare__title" }, "開いたファイル", deviceNewer ? null : newerTag),
    h("div", { class: "muted", style: { overflowWrap: "anywhere" } }, file.name),
    timeLine("書き出し", parsed.exportedAt),
    h("div", null, `カード: ${parsed.cards.length}枚`)
  );
  const deviceBox = deviceHas
    ? h(
        "div",
        { class: `compare__box ${deviceNewer ? "compare__box--newer" : ""}` },
        h("div", { class: "compare__title" }, "この端末のデータ", deviceNewer ? newerTag.cloneNode(true) : null),
        device.fileName ? h("div", { class: "muted", style: { overflowWrap: "anywhere" } }, `元のファイル: ${device.fileName}`) : null,
        timeLine("最終変更", device.lastChangeAt),
        timeLine("最終書き出し", device.lastExportAt),
        h("div", null, `カード: ${device.cardCount}枚`),
        device.dirty ? h("div", { class: "text-warning" }, "未書き出しの変更あり") : null
      )
    : null;

  const backup = {
    label: "端末のデータをバックアップとして書き出す",
    keepOpen: true,
    onClick: () => exportDeviceBackup(),
  };
  const useFile = {
    label: device?.dirty ? "開いたファイルを使う（端末の未書き出しの変更は消えます）" : "開いたファイルを使う",
    value: "file",
  };
  const actions = [];
  if (deviceNewer) {
    actions.push(
      { label: "この端末のデータを使う（おすすめ）", kind: "btn--primary", value: "device" },
      { ...useFile, kind: device?.dirty ? "btn--danger" : "" },
      backup
    );
  } else if (bothChanged) {
    actions.push(
      { ...backup, kind: "btn--primary" },
      { ...useFile, kind: "" },
      { label: "この端末のデータを使う（開いたファイルより古いデータです）", value: "device" }
    );
  } else {
    actions.push({ ...useFile, kind: "btn--primary" });
    if (deviceHas) actions.push(backup);
  }
  actions.push({ label: "キャンセル", kind: "btn--ghost", value: null });

  const result = await openModal({
    title: deviceNewer
      ? "この端末に新しいデータがあります"
      : bothChanged
        ? "どちらのデータを使いますか？"
        : "古いファイルかもしれません",
    body: [...lines, h("div", { class: "compare" }, fileBox, deviceBox)],
    actions,
  }).result;
  return result ?? null;
}

/** Downloads this device's copy without changing anything. */
async function exportDeviceBackup() {
  const work = busy("バックアップを作成しています…");
  try {
    let bytes;
    const exportedAt = new Date().toISOString();
    const name = studyFileName(new Date()).replace(/\.zip$/, "_端末バックアップ.zip");
    if (store.hasState()) {
      ({ bytes } = await store.buildExport());
    } else {
      const snap = await storage.readSnapshot();
      if (!snap) throw new Error("この端末のデータが見つかりません");
      const images = new Map();
      for (const [path, blob] of snap.images) {
        images.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
      }
      bytes = buildStudyZip({
        cards: snap.cards,
        daily: snap.meta.daily ?? {},
        settings: normalizeSettings(snap.meta.settings),
        images,
        exportedAt,
        lastChangeAt: snap.meta.lastChangeAt ?? null,
        appVersion: APP_VERSION,
      });
    }
    download(new Blob([bytes], { type: "application/zip" }), name);
    toast(`${name} をダウンロードしました`);
  } catch (err) {
    toast(`バックアップに失敗しました: ${err?.message ?? err}`, { danger: true });
  } finally {
    work.done();
  }
}

/** "空のデータで始める", after confirming if that throws away this device's copy. */
export async function startEmpty() {
  const device = await deviceCopyInfo();
  if (device && (device.cardCount > 0 || device.dirty)) {
    const ok = await confirmDialog(
      "空のデータで始めますか？",
      `この端末のデータ（カード${device.cardCount}枚${device.dirty ? "・未書き出しの変更あり" : ""}）は消えます。必要なら先に書き出してください。`,
      { ok: "空で始める", danger: true }
    );
    if (!ok) return false;
  }
  await store.replaceState(store.emptyState(), { handle: null });
  return true;
}

// ---- Export ----------------------------------------------------------------

/** Whether one click can save straight back to the opened file. */
export function canSaveInPlace() {
  return supportsFileHandles && store.getFileHandle() !== null;
}

/**
 * Before writing over the opened file, checks whether it was saved by someone
 * else since we opened it (say, another computer syncing the same folder). If
 * so — or if it can't be read — asks first.
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<boolean>} whether to go ahead
 */
async function confirmOverwrite(handle) {
  let disk = null;
  try {
    const file = await handle.getFile();
    disk = peekStudyMeta(new Uint8Array(await file.arrayBuffer()));
  } catch {
    disk = null;
  }
  const known = store.getState()?.source.exportedAt ?? null;
  if (disk && disk.format !== null && !changedOnDisk(known, disk.exportedAt)) return true;
  return confirmDialog(
    disk?.exportedAt ? "保存先のファイルが更新されています" : "保存先のファイルを確認できませんでした",
    disk?.exportedAt
      ? `${handle.name} は、このデータを開いた後（または最後に保存した後）に書き換えられています（書き出し: ${formatDateTime(disk.exportedAt)}）。別の端末で保存した内容かもしれません。上書きすると、その内容は失われます。`
      : `${handle.name} が学習ファイルとして読めませんでした。上書きしますか？`,
    { ok: "上書きする", danger: true }
  );
}

/**
 * 上書き保存: writes the study data back to the file it was opened from
 * (Chrome/Edge on desktop). Elsewhere it opens the export dialog instead.
 */
export async function saveInPlace() {
  const handle = store.getFileHandle();
  if (!store.hasState()) return;
  if (!handle || !supportsFileHandles) {
    await openExportDialog();
    return;
  }
  let work = null;
  try {
    // Ask for permission while the click still counts as a user action.
    await ensureWritable(handle);
    if (!(await confirmOverwrite(handle))) return;
    work = busy("上書き保存しています…");
    const built = await store.buildExport();
    await saveToHandle(handle, new Blob([built.bytes], { type: "application/zip" }));
    if (await store.markExported(built, handle.name)) toast(`上書き保存しました: ${handle.name}`);
  } catch (err) {
    toast(`上書き保存できませんでした: ${err?.message ?? err}`, { danger: true });
  } finally {
    work?.done();
  }
}

/**
 * The export dialog: save over the opened file, save as, share, or download.
 * The zip is built as the dialog opens, so each button acts straight from
 * the tap (iOS only opens the share sheet from a fresh tap).
 */
export async function openExportDialog() {
  const s = store.getState();
  if (!s) return;
  const handle = store.getFileHandle();
  const status = h("p", { class: "muted small" }, "書き出しを準備しています…");
  const buttons = h("div", { class: "modal__actions" });
  const lastExport = await store.getLastExport();

  const modal = openModal({
    title: "学習データを書き出す",
    body: [
      h("p", null, `カード ${s.cards.length}枚・画像 ${s.images.size}枚`),
      status,
      buttons,
      h(
        "p",
        { class: "muted small" },
        lastExport
          ? `この端末で最後に書き出したのは ${formatDateTime(lastExport.exportedAt)}（${formatAgo(lastExport.exportedAt)}）です。`
          : "この端末からはまだ書き出していません。"
      ),
    ],
    actions: [{ label: "閉じる", kind: "btn--ghost", value: null }],
  });

  let built;
  try {
    built = await store.buildExport();
  } catch (err) {
    mount(status, `書き出しの準備に失敗しました: ${err?.message ?? err}`);
    return;
  }
  const blob = new Blob([built.bytes], { type: "application/zip" });
  const name = studyFileName(new Date(built.exportedAt));
  mount(status, `約 ${formatBytes(blob.size)}`);

  // Another file was opened while this dialog was up: this zip is of the old data.
  const stale = () => {
    if (store.getGeneration() === built.generation) return false;
    modal.close(null);
    toast("別のデータが開かれたので、書き出しを中止しました", { danger: true });
    return true;
  };
  const finish = async (fileName, how) => {
    const recorded = await store.markExported(built, fileName);
    modal.close(true);
    toast(recorded ? `${how}: ${fileName}` : "別のデータが開かれたので、書き出しは記録しませんでした", {
      danger: !recorded,
    });
  };
  const fail = (err) => toast(`書き出しに失敗しました: ${err?.message ?? err}`, { danger: true });

  // A download can't report whether the file was really kept (Safari asks
  // first, and you can cancel), so it only counts once you say so.
  const confirmDownload = () => {
    mount(
      status,
      `ダウンロードを始めました: ${name}。保存できたら「保存できた」を押してください（押すまで「未書き出しの変更あり」のままです）。`
    );
    mount(
      buttons,
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary",
          onclick: () => {
            if (!stale()) void finish(name, "書き出しました");
          },
        },
        "保存できた"
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: () => {
            if (!stale()) download(blob, name);
          },
        },
        "もう一度ダウンロード"
      )
    );
  };

  const items = [];
  if (handle && supportsFileHandles) {
    items.push(
      h(
        "button",
        {
          type: "button",
          class: "btn btn--primary",
          onclick: async () => {
            if (stale()) return;
            try {
              await ensureWritable(handle);
              if (!(await confirmOverwrite(handle))) return;
              await saveToHandle(handle, blob);
              await finish(handle.name, "上書き保存しました");
            } catch (err) {
              fail(err);
            }
          },
        },
        `上書き保存（${handle.name}）`
      )
    );
  }
  if (supportsSaveAs) {
    items.push(
      h(
        "button",
        {
          type: "button",
          class: `btn ${items.length === 0 ? "btn--primary" : ""}`,
          onclick: async () => {
            if (stale()) return;
            try {
              const saved = await saveAs(blob, name);
              if (!saved) return;
              store.setFileHandle(saved);
              await finish(saved.name, "保存しました");
            } catch (err) {
              fail(err);
            }
          },
        },
        "名前を付けて保存…"
      )
    );
  }
  const share = canShareFiles()
    ? h(
        "button",
        {
          type: "button",
          class: `btn ${isIOS() && items.length === 0 ? "btn--primary" : ""}`,
          onclick: async () => {
            if (stale()) return;
            try {
              if (await shareFile(blob, name)) await finish(name, "共有しました");
            } catch (err) {
              fail(err);
            }
          },
        },
        isIOS() ? "共有…（「ファイルに保存」を選ぶ）" : "共有…"
      )
    : null;
  const dl = h(
    "button",
    {
      type: "button",
      class: `btn ${items.length === 0 && !(share && isIOS()) ? "btn--primary" : ""}`,
      onclick: () => {
        if (stale()) return;
        try {
          download(blob, name);
          confirmDownload();
        } catch (err) {
          fail(err);
        }
      },
    },
    `ダウンロード（${name}）`
  );
  // On iPhone the share sheet is the dependable way to save into Files.
  if (isIOS() && share) items.push(share, dl);
  else items.push(dl, share);
  mount(buttons, items);
}
