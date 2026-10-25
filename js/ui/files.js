// Getting files in and out: pickers, saving back to the same file (File System
// Access API, desktop Chrome/Edge), downloads, and the share sheet (the
// reliable way to "Save to Files" on iPhone).

const ZIP_ACCEPT = ".zip,application/zip,application/x-zip-compressed";

export const supportsFileHandles =
  typeof window !== "undefined" && "showOpenFilePicker" in window;
export const supportsSaveAs =
  typeof window !== "undefined" && "showSaveFilePicker" in window;

export function isIOS() {
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    navigator.standalone === true
  );
}

/**
 * Opens the system file picker with an <input type=file>.
 * @param {{ accept?: string, multiple?: boolean }} [options]
 * @returns {Promise<File[]>} empty if cancelled (where the browser reports it)
 */
export function pickFiles({ accept = "", multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = "none";
    let settled = false;
    const finish = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => finish([]));
    document.body.append(input);
    input.click();
  });
}

/**
 * Picks a study file. Where file handles are supported the handle comes back
 * too, so the file can be saved over later with one click.
 * @returns {Promise<{ file: File, handle: FileSystemFileHandle | null } | null>}
 */
export async function pickStudyFile() {
  if (supportsFileHandles) {
    try {
      const [handle] = await window.showOpenFilePicker({
        id: "memory-study",
        multiple: false,
        types: [
          {
            description: "学習ファイル (.zip)",
            accept: { "application/zip": [".zip"] },
          },
        ],
      });
      return { file: await handle.getFile(), handle };
    } catch (err) {
      if (err?.name === "AbortError") return null;
      // Some embedded browsers expose the API but refuse it; fall back.
    }
  }
  const [file] = await pickFiles({ accept: ZIP_ACCEPT });
  return file ? { file, handle: null } : null;
}

/**
 * Makes sure we may write to `handle`. The browser's prompt needs the click
 * that led here, so call this before any slow work.
 * @param {FileSystemFileHandle} handle
 */
export async function ensureWritable(handle) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission?.(options)) === "granted") return;
  const permission = await handle.requestPermission?.(options);
  if (permission !== "granted") {
    throw new Error("ファイルへの書き込みが許可されませんでした");
  }
}

/**
 * Overwrites the file behind `handle`, asking for write permission if needed.
 * @param {FileSystemFileHandle} handle
 * @param {Blob} blob
 */
export async function saveToHandle(handle, blob) {
  await ensureWritable(handle);
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * "Save as…" dialog (desktop Chrome/Edge).
 * @returns {Promise<FileSystemFileHandle | null>} null if cancelled
 */
export async function saveAs(blob, suggestedName) {
  try {
    const handle = await window.showSaveFilePicker({
      id: "memory-study",
      suggestedName,
      types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
    });
    await saveToHandle(handle, blob);
    return handle;
  } catch (err) {
    if (err?.name === "AbortError") return null;
    throw err;
  }
}

export function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.append(a);
  a.click();
  a.remove();
  // Long enough for the slowest browsers to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function canShareFiles() {
  try {
    const probe = new File([new Uint8Array(1)], "probe.zip", { type: "application/zip" });
    return typeof navigator.canShare === "function" && navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Hands the file to the system share sheet.
 * @returns {Promise<boolean>} false if the user cancelled
 */
export async function shareFile(blob, fileName) {
  const file = new File([blob], fileName, { type: "application/zip" });
  try {
    await navigator.share({ files: [file], title: fileName });
    return true;
  } catch (err) {
    if (err?.name === "AbortError") return false;
    throw err;
  }
}

export async function readFileBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}
