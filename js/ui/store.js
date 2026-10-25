// The study data being worked on, plus its autosave to IndexedDB.
//
// Every change goes through update(): it marks the data as having unexported
// changes, notifies the views, and schedules a write of just what changed
// (cards by id, images by path, and the small meta record) to IndexedDB.

import { APP_VERSION } from "../version.js";
import { referencedImages } from "../lib/cards.js";
import { sha256Hex } from "../lib/hash.js";
import { randomId } from "../lib/ids.js";
import { buildStudyZip, defaultSettings } from "../lib/study-file.js";
import * as storage from "./storage.js";

/** @typedef {import("../lib/cards.js").Card} Card */

/**
 * @typedef {object} StudyState
 * @property {Card[]} cards
 * @property {import("../lib/daily.js").Daily} daily
 * @property {import("../lib/study-file.js").Settings} settings
 * @property {Map<string, Blob>} images      "images/…" → Blob
 * @property {boolean} dirty                 changed since last export (or since opening)
 * @property {string | null} lastChangeAt    last edit or answer
 * @property {string | null} lastExportAt    when this data was last exported
 * @property {{ fileName: string | null, exportedAt: string | null, openedAt: string | null }} source
 * @property {string} snapshotId             identifies this copy in IndexedDB (not exported)
 */

/** @type {StudyState | null} */
let state = null;
// Goes up with every change; an export records which revision it wrote.
let revision = 0;
// Goes up whenever the data is swapped for other data (opening a file,
// starting empty, resuming). Things started on the old data — a review
// session, a prepared export — check it so they never touch the new data.
let generation = 0;
const listeners = new Set();

/** @type {"idle" | "saving" | "saved" | "error" | "off"} */
let saveStatus = "idle";
let saveError = null;
let storageOk = true;

let pending = emptyPending();
let saveTimer = null;
let saving = null;
const RETRY_FIRST_MS = 2000;
const RETRY_MAX_MS = 30_000;
let retryDelay = RETRY_FIRST_MS;

/** @type {FileSystemFileHandle | null} */
let fileHandle = null;

const urls = new Map();
const hashes = new Map();

function emptyPending() {
  return {
    replaceAll: false,
    cards: new Set(),
    deletedCards: new Set(),
    order: false,
    putImages: new Set(),
    deleteImages: new Set(),
    meta: false,
  };
}

export function getState() {
  return state;
}

export function hasState() {
  return state !== null;
}

export function getGeneration() {
  return generation;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error(err);
    }
  }
}

export function getSaveStatus() {
  return { status: saveStatus, error: saveError, storageOk };
}

export async function initStorage() {
  storageOk = await storage.storageAvailable();
  if (!storageOk) saveStatus = "off";
  return storageOk;
}

/**
 * Makes `next` the working data: after opening a file, starting empty, or
 * resuming this device's copy (`persist: false`, since it's already stored).
 * @param {Omit<StudyState, "images"> & { images: Map<string, Blob> }} next
 * @param {{ persist?: boolean, handle?: FileSystemFileHandle | null }} [options]
 */
export async function replaceState(next, { persist = true, handle } = {}) {
  revokeAllUrls();
  hashes.clear();
  // New data gets a new identity; resumed data keeps the one it was stored with.
  state = { ...next, snapshotId: persist ? randomId() : next.snapshotId ?? randomId() };
  revision++;
  generation++;
  if (handle !== undefined) setFileHandle(handle);
  pending = emptyPending();
  if (!persist && !next.snapshotId) pending.meta = true;
  if (persist) {
    pending.replaceAll = true;
    pending.order = true;
    pending.meta = true;
    for (const c of state.cards) pending.cards.add(c.id);
    for (const p of state.images.keys()) pending.putImages.add(p);
    emit();
    await flushSave();
  } else {
    emit();
    if (pending.meta) scheduleSave();
  }
}

/** A brand-new, empty study file. */
export function emptyState() {
  return {
    cards: [],
    daily: {},
    settings: defaultSettings(),
    images: new Map(),
    dirty: false,
    lastChangeAt: null,
    lastExportAt: null,
    source: { fileName: null, exportedAt: null, openedAt: new Date().toISOString() },
  };
}

/**
 * Applies a change. `fn` gets the current state and returns the fields to
 * replace (cards, daily, settings). New images go in `putImages`; images no
 * card uses any more are dropped automatically.
 * @param {(s: StudyState) => Partial<StudyState>} fn
 * @param {{ putImages?: Map<string, Blob> }} [options]
 */
export function update(fn, { putImages } = {}) {
  if (!state) throw new Error("学習データが読み込まれていません");
  const prev = state;
  const patch = fn(prev) ?? {};
  const next = {
    ...prev,
    ...patch,
    dirty: true,
    lastChangeAt: new Date().toISOString(),
  };

  if (putImages && putImages.size > 0) {
    next.images = new Map(prev.images);
    for (const [path, blob] of putImages) {
      next.images.set(path, blob);
      hashes.delete(path);
      pending.putImages.add(path);
      pending.deleteImages.delete(path);
    }
  }

  if (patch.cards) {
    const before = new Map(prev.cards.map((c) => [c.id, c]));
    let orderChanged = prev.cards.length !== next.cards.length;
    next.cards.forEach((card, i) => {
      if (before.get(card.id) !== card) pending.cards.add(card.id);
      if (!orderChanged && prev.cards[i].id !== card.id) orderChanged = true;
      before.delete(card.id);
    });
    for (const id of before.keys()) {
      pending.deletedCards.add(id);
      pending.cards.delete(id);
    }
    if (orderChanged) pending.order = true;

    // Drop images nothing points at any more.
    const used = referencedImages(next.cards);
    for (const path of [...next.images.keys()]) {
      if (used.has(path)) continue;
      if (next.images === prev.images) next.images = new Map(prev.images);
      next.images.delete(path);
      revokeUrl(path);
      hashes.delete(path);
      pending.putImages.delete(path);
      pending.deleteImages.add(path);
    }
  }

  pending.meta = true;
  state = next;
  revision++;
  scheduleSave();
  emit();
}

// ---- Autosave ------------------------------------------------------------

function hasPending() {
  return (
    pending.replaceAll ||
    pending.meta ||
    pending.order ||
    pending.cards.size > 0 ||
    pending.deletedCards.size > 0 ||
    pending.putImages.size > 0 ||
    pending.deleteImages.size > 0
  );
}

function scheduleSave(delay = 400) {
  if (!storageOk) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushSave(), delay);
}

/** Tries pending writes again now (e.g. when the app comes back on screen). */
export function retrySave() {
  if (hasPending()) void flushSave();
}

function metaRecord(s) {
  return {
    version: 1,
    appVersion: APP_VERSION,
    daily: s.daily,
    settings: s.settings,
    dirty: s.dirty,
    lastChangeAt: s.lastChangeAt,
    lastExportAt: s.lastExportAt,
    source: s.source,
    cardCount: s.cards.length,
    imageCount: s.images.size,
    snapshotId: s.snapshotId,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Writes pending changes now. Safe to call any time; concurrent calls queue
 * behind the one in flight.
 */
export async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!storageOk || !state) return;
  while (saving) await saving;
  if (!hasPending()) return;

  const batch = pending;
  pending = emptyPending();
  const s = state;
  const byId = new Map(s.cards.map((c) => [c.id, c]));
  const changes = {
    replaceAll: batch.replaceAll,
    putCards: [...batch.cards].map((id) => byId.get(id)).filter(Boolean),
    deleteCards: [...batch.deletedCards],
    cardOrder: batch.order ? s.cards.map((c) => c.id) : null,
    putImages: new Map(
      [...batch.putImages].filter((p) => s.images.has(p)).map((p) => [p, s.images.get(p)])
    ),
    deleteImages: [...batch.deleteImages],
    meta: metaRecord(s),
  };

  saveStatus = "saving";
  saving = (async () => {
    try {
      await storage.writeSnapshot(changes);
      saveStatus = "saved";
      saveError = null;
      retryDelay = RETRY_FIRST_MS;
    } catch (err) {
      console.error("autosave failed", err);
      saveStatus = "error";
      saveError = err;
      // Put the batch back and try again later, backing off.
      if (batch.replaceAll) pending.replaceAll = true;
      if (batch.order) pending.order = true;
      pending.meta = true;
      for (const id of batch.cards) if (!pending.deletedCards.has(id)) pending.cards.add(id);
      for (const id of batch.deletedCards) if (!pending.cards.has(id)) pending.deletedCards.add(id);
      for (const p of batch.putImages) if (!pending.deleteImages.has(p)) pending.putImages.add(p);
      for (const p of batch.deleteImages) if (!pending.putImages.has(p)) pending.deleteImages.add(p);
      scheduleSave(retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    } finally {
      saving = null;
      emit();
    }
  })();
  await saving;
}

export function hasUnsavedWrites() {
  return Boolean(saving) || hasPending();
}

// ---- Images --------------------------------------------------------------

export function imageUrl(path) {
  if (!path || !state?.images.has(path)) return null;
  let url = urls.get(path);
  if (!url) {
    url = URL.createObjectURL(state.images.get(path));
    urls.set(path, url);
  }
  return url;
}

function revokeUrl(path) {
  const url = urls.get(path);
  if (url) {
    URL.revokeObjectURL(url);
    urls.delete(path);
  }
}

function revokeAllUrls() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

/** SHA-256 of a stored image's bytes, cached. */
export function imageHashOf(path) {
  if (!state?.images.has(path)) return Promise.resolve(null);
  if (!hashes.has(path)) {
    const blob = state.images.get(path);
    hashes.set(
      path,
      blob.arrayBuffer().then((buf) => sha256Hex(new Uint8Array(buf)))
    );
  }
  return hashes.get(path);
}

export function totalImageBytes() {
  let total = 0;
  for (const blob of state?.images.values() ?? []) total += blob.size;
  return total;
}

// ---- Export ----------------------------------------------------------------

/**
 * Builds the study zip from the current data.
 * @returns {Promise<{ bytes: Uint8Array, exportedAt: string, revision: number, generation: number }>}
 */
export async function buildExport() {
  const s = state;
  const at = revision;
  const gen = generation;
  const exportedAt = new Date().toISOString();
  const images = new Map();
  for (const [path, blob] of s.images) {
    images.set(path, { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type });
  }
  const bytes = buildStudyZip({
    cards: s.cards,
    daily: s.daily,
    settings: s.settings,
    images,
    exportedAt,
    lastChangeAt: s.lastChangeAt,
    appVersion: APP_VERSION,
  });
  return { bytes, exportedAt, revision: at, generation: gen };
}

/**
 * Records a finished export. Changes made while it was being written (a
 * different revision) stay marked as unexported.
 * @param {{ exportedAt: string, revision: number }} result
 * @param {string | null} fileName
 */
export async function markExported({ exportedAt, revision: exportedRevision, generation: gen }, fileName) {
  // The data was swapped while this export was being written: it doesn't
  // describe what's loaded now.
  if (gen !== generation) return false;
  state = {
    ...state,
    dirty: state.dirty && revision !== exportedRevision,
    lastExportAt: exportedAt,
    source: {
      ...state.source,
      fileName: fileName ?? state.source.fileName,
      exportedAt,
    },
  };
  pending.meta = true;
  await storage.setKv("lastExport", { exportedAt, fileName });
  emit();
  await flushSave();
  return true;
}

export async function getLastExport() {
  return (await storage.getKv("lastExport")) ?? null;
}

// ---- File handle (File System Access API) --------------------------------

export function getFileHandle() {
  return fileHandle;
}

export function setFileHandle(handle) {
  fileHandle = handle ?? null;
  void storage.setKv("fileHandle", fileHandle ?? undefined);
  // The header's 上書き保存 button depends on it.
  if (state) emit();
}

export async function restoreFileHandle(expectedName) {
  const handle = await storage.getKv("fileHandle");
  if (handle && (!expectedName || handle.name === expectedName)) {
    fileHandle = handle;
    if (state) emit();
  }
  return fileHandle;
}
