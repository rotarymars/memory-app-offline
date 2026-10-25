// Entry point: routing, the header's "unexported changes" status, app-wide
// drag & drop, the service worker, and the safety nets around leaving the
// page with changes that haven't been exported.

import { APP_VERSION } from "./version.js";
import { h, mount } from "./ui/dom.js";
import { imageFilesFrom } from "./ui/images.js";
import { isModalOpen, toast } from "./ui/modal.js";
import { noteHashChange, parseHash, replaceHash } from "./ui/nav.js";
import { readSnapshotMeta, requestPersistence } from "./ui/storage.js";
import * as store from "./ui/store.js";
import {
  canSaveInPlace,
  openExportDialog,
  openStudyFile,
  resumeDeviceCopy,
  saveInPlace,
  setPendingImport,
} from "./ui/study.js";
import { renderCardEdit, renderCardList, renderCardNew } from "./views/cards.js";
import { renderFile } from "./views/file.js";
import { renderHome } from "./views/home.js";
import { renderImport } from "./views/import.js";
import { renderLaunch } from "./views/launch.js";
import { renderPackBuilder } from "./views/pack.js";
import { renderProgress } from "./views/progress.js";
import { renderReviewSession, renderReviewSetup } from "./views/review.js";

const app = document.getElementById("app");
const nav = document.getElementById("site-nav");
const headerStatus = document.getElementById("header-status");
const banners = document.getElementById("banners");

// Set while this tab has study data loaded, so a reload in the same tab
// carries on with this device's copy instead of showing the start screen.
const LOADED_FLAG = "memory-offline:loaded";

const ROUTES = [
  // `live`: redrawn when the file status shown on it changes (e.g. after exporting).
  { path: /^\/$/, nav: "home", live: true, render: (root) => renderHome(root) },
  { path: /^\/review$/, nav: "review", render: (root, params) => renderReviewSetup(root, params) },
  { path: /^\/review\/session$/, nav: "review", render: (root) => renderReviewSession(root) },
  { path: /^\/cards$/, nav: "cards", render: (root, params) => renderCardList(root, params) },
  { path: /^\/cards\/new$/, nav: "cards", render: (root, params) => renderCardNew(root, params) },
  {
    path: /^\/cards\/([^/]+)$/,
    nav: "cards",
    render: (root, _params, m) => renderCardEdit(root, decodeURIComponent(m[1])),
  },
  { path: /^\/import$/, nav: "import", render: (root) => renderImport(root) },
  // The pack builder doesn't need a study file.
  { path: /^\/pack$/, nav: "pack", needsData: false, render: (root) => renderPackBuilder(root) },
  { path: /^\/progress$/, nav: "progress", render: (root) => renderProgress(root) },
  { path: /^\/file$/, nav: "file", live: true, render: (root) => renderFile(root, { onReload: go }) },
];

let cleanup = null;
let renderToken = 0;
let currentRoute = null;

function setNav(active) {
  nav.hidden = active === null;
  for (const a of nav.querySelectorAll("a")) {
    if (a.dataset.nav === active) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
}

async function route({ keepScroll = false } = {}) {
  const token = ++renderToken;
  if (cleanup) {
    try {
      cleanup();
    } catch (err) {
      console.error(err);
    }
    cleanup = null;
  }
  const { path, params } = parseHash();
  let match = null;
  let found = ROUTES[0];
  for (const r of ROUTES) {
    match = r.path.exec(path);
    if (match) {
      found = r;
      break;
    }
  }
  if (!match) {
    replaceHash("#/");
    return;
  }

  // Each render gets a fresh container; a slow (async) view that finishes
  // after you've moved on writes into a detached one.
  const root = h("div", { class: "view" });
  mount(app, root);
  if (!keepScroll) window.scrollTo(0, 0);
  currentRoute = found;

  if (found.needsData !== false && !store.hasState()) {
    currentRoute = null;
    setNav(null);
    await renderLaunch(root, { onLoaded: (hash) => go(hash) });
    return;
  }
  setNav(found.nav);
  try {
    const result = await found.render(root, params, match);
    if (token !== renderToken) {
      if (typeof result === "function") result();
      return;
    }
    cleanup = typeof result === "function" ? result : null;
  } catch (err) {
    console.error(err);
    mount(
      root,
      h(
        "div",
        { class: "banner banner--danger" },
        `画面の表示中にエラーが起きました: ${err?.message ?? err}`
      )
    );
  }
}

/** Navigates to `hash`, or re-renders if we're already there. */
function go(hash = location.hash || "#/") {
  if (location.hash !== hash && !(hash === "#/" && location.hash === "")) location.hash = hash;
  else void route();
}

// ---- Header: unexported changes and autosave status ----------------------

function renderHeaderStatus() {
  const s = store.getState();
  if (!s) {
    mount(headerStatus);
    return;
  }
  const { status, error, storageOk } = store.getSaveStatus();
  mount(
    headerStatus,
    !storageOk
      ? h("span", { class: "status-badge status-badge--danger", title: "この環境では IndexedDB が使えません" }, "自動保存オフ")
      : status === "error"
        ? h(
            "span",
            { class: "status-badge status-badge--danger", title: String(error?.message ?? error ?? "") },
            "自動保存エラー"
          )
        : null,
    s.dirty
      ? h(
          "button",
          {
            type: "button",
            class: "status-badge",
            title: "書き出していない変更があります。クリックで書き出し",
            onclick: () => openExportDialog(),
          },
          "未書き出しの変更あり"
        )
      : null,
    canSaveInPlace()
      ? h(
          "button",
          {
            type: "button",
            class: `btn btn--sm ${s.dirty ? "btn--primary" : ""}`,
            title: `${store.getFileHandle().name} に上書き保存（Ctrl/⌘+S）`,
            onclick: () => saveInPlace(),
          },
          "上書き保存"
        )
      : null,
    h(
      "button",
      {
        type: "button",
        class: `btn btn--sm ${s.dirty && !canSaveInPlace() ? "btn--primary header-export--wide" : "btn--ghost"}`,
        onclick: () => openExportDialog(),
      },
      canSaveInPlace() ? "書き出す…" : "書き出す"
    )
  );
}

// Ctrl/⌘+S saves (in place where possible) instead of saving the web page.
function setupSaveShortcut() {
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
    if (!store.hasState()) return;
    e.preventDefault();
    void saveInPlace();
  });
}

let askedForPersistence = false;
let liveSignature = "";

// What the dashboard and the file screen show about the file; when it
// changes they're redrawn in place.
function fileSignature(s) {
  return [
    s?.dirty,
    s?.lastExportAt,
    s?.lastChangeAt,
    s?.cards.length,
    s?.source.fileName,
    store.getFileHandle()?.name,
    store.getSaveStatus().status,
    s?.settings.reviewOrder,
  ].join("|");
}

function onStoreChange(s) {
  renderHeaderStatus();
  try {
    // Remember which copy this tab has, so a reload resumes it only if it's
    // the one in IndexedDB (not, say, a file whose saving the reload cut off).
    if (s) sessionStorage.setItem(LOADED_FLAG, s.snapshotId);
  } catch {
    // Private mode: reloads just show the start screen.
  }
  if (s?.dirty && !askedForPersistence) {
    askedForPersistence = true;
    void requestPersistence();
  }

  const { status, error } = store.getSaveStatus();
  if (status === "error") {
    showBanner(
      "autosave",
      "danger",
      `この端末への自動保存に失敗しています（${error?.message ?? error}）。少し待つと自動でやり直しますが、念のため今すぐ書き出してください。`,
      [h("button", { type: "button", class: "btn btn--sm btn--primary", onclick: () => openExportDialog() }, "書き出す")]
    );
  } else {
    hideBanner("autosave");
  }

  const signature = fileSignature(s);
  if (signature !== liveSignature) {
    liveSignature = signature;
    if (currentRoute?.live && s && !isModalOpen()) void route({ keepScroll: true });
  }
}

// ---- Banners ---------------------------------------------------------------

const shownBanners = new Map();

function hideBanner(id) {
  shownBanners.get(id)?.remove();
  shownBanners.delete(id);
}

function showBanner(id, kind, content, actions = []) {
  if (shownBanners.has(id)) return;
  const el = h(
    "div",
    { class: `banner banner--${kind}`, role: "status" },
    h("span", null, content),
    actions.length ? h("div", { class: "row" }, actions) : null
  );
  shownBanners.set(id, el);
  banners.append(el);
}

// ---- Leaving with unexported changes ---------------------------------------

let leavingOnPurpose = false;

function setupLeaveGuards() {
  window.addEventListener("beforeunload", (e) => {
    if (leavingOnPurpose) return;
    // Unexported changes, or changes not yet written to this device.
    if (store.getState()?.dirty || store.hasUnsavedWrites()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // Get pending autosave writes out before the page can be frozen or closed.
  const flush = () => void store.flushSave();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
    // Back on screen: retry anything that failed while we were away.
    else store.retrySave();
  });
}

// ---- Drag & drop anywhere ------------------------------------------------

function hasFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

function setupDragAndDrop() {
  window.addEventListener("dragover", (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    // File handles must be asked for while the drop event is being handled;
    // with one, a dropped study file can be saved back to with one click.
    const items = Array.from(e.dataTransfer.items ?? []);
    const handles = Promise.all(
      items.map((item) =>
        item.kind === "file" && typeof item.getAsFileSystemHandle === "function"
          ? item.getAsFileSystemHandle().catch(() => null)
          : Promise.resolve(null)
      )
    );
    const files = Array.from(e.dataTransfer.files ?? []);
    void handleDrop(files, handles);
  });
}

async function handleDrop(files, handlesPromise) {
  if (files.length === 0) return;
  if (isModalOpen()) {
    toast("ダイアログを閉じてからドロップしてください", { danger: true });
    return;
  }
  const { path } = parseHash();
  const zips = files.filter((f) => /\.zip$/i.test(f.name));
  const texts = files.filter((f) => /\.txt$/i.test(f.name));
  const images = imageFilesFrom(files);

  if (path === "/import" || texts.length > 0) {
    if (!store.hasState()) {
      toast("先に学習ファイルを開くか、空のデータで始めてください", { danger: true });
      return;
    }
    setPendingImport(files);
    if (path === "/import") void route();
    else location.hash = "#/import";
    return;
  }
  if (zips.length === 1 && path !== "/pack") {
    const handles = await handlesPromise;
    const index = files.indexOf(zips[0]);
    const handle = handles[index]?.kind === "file" ? handles[index] : null;
    if (await openStudyFile(zips[0], handle)) go("#/");
    return;
  }
  if (images.length > 0) return; // stray image drop outside a card form: ignore
  toast("学習ファイル（.zip）か、取り込む .txt / パックをドロップしてください", { danger: true });
}

// ---- Installed app: opening .zip files from the OS (desktop Chrome) ------

function setupLaunchQueue() {
  if (!("launchQueue" in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    const [handle] = params.files ?? [];
    if (!handle) return;
    const file = await handle.getFile();
    if (await openStudyFile(file, handle)) go("#/");
  });
}

// ---- Service worker: offline cache and updates -----------------------------

function setupServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let updateRequested = false;
  navigator.serviceWorker
    .register("./sw.js", { updateViaCache: "none" })
    .then((reg) => {
      const offer = () => {
        if (!reg.waiting || !navigator.serviceWorker.controller) return;
        showBanner("update", "accent", "新しいバージョンがあります。", [
          h(
            "button",
            {
              type: "button",
              class: "btn btn--sm btn--primary",
              onclick: async () => {
                await store.flushSave();
                updateRequested = true;
                reg.waiting?.postMessage({ type: "SKIP_WAITING" });
              },
            },
            "更新する"
          ),
        ]);
      };
      offer();
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed") offer();
        });
      });
      // Look for a new version when the app comes back to the foreground.
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") reg.update().catch(() => {});
      });
    })
    .catch((err) => console.warn("service worker not registered", err));

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!updateRequested) return;
    // Everything is autosaved, so reload straight back into the same data.
    leavingOnPurpose = store.getSaveStatus().storageOk && !store.hasUnsavedWrites();
    location.reload();
  });
}

// ---- Two tabs on the same data -------------------------------------------

function setupTabGuard() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("memory-offline");
  const warn = () =>
    showBanner(
      "tabs",
      "warning",
      "このアプリが別のタブ（またはウィンドウ）でも開かれています。片方を閉じないと、この端末の自動保存が食い違うことがあります。"
    );
  channel.onmessage = (e) => {
    if (e.data?.type === "hello") {
      channel.postMessage({ type: "here" });
      warn();
    } else if (e.data?.type === "here") {
      warn();
    }
  };
  channel.postMessage({ type: "hello" });
}

// ---- Boot ----------------------------------------------------------------

async function boot() {
  document.getElementById("app-version").textContent = `v${APP_VERSION}`;
  const storageOk = await store.initStorage();
  if (!storageOk) {
    showBanner(
      "storage",
      "danger",
      "この環境では自動保存（IndexedDB）が使えません。ページを閉じる前に必ず書き出してください。"
    );
  }
  store.subscribe(onStoreChange);
  setupLeaveGuards();
  setupSaveShortcut();
  setupDragAndDrop();
  setupLaunchQueue();
  setupServiceWorker();
  setupTabGuard();

  let loadedHere = null;
  try {
    loadedHere = sessionStorage.getItem(LOADED_FLAG);
  } catch {
    loadedHere = null;
  }
  if (loadedHere && storageOk) {
    const meta = await readSnapshotMeta();
    if (meta?.snapshotId === loadedHere) await resumeDeviceCopy();
  }

  window.addEventListener("hashchange", () => {
    noteHashChange();
    void route();
  });
  await route();
}

boot().catch((err) => {
  console.error(err);
  mount(
    app,
    h("p", { class: "banner banner--danger" }, `起動に失敗しました: ${err?.message ?? err}`)
  );
});
