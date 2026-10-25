// IndexedDB: this device's working copy of the study data, so nothing is lost
// if the tab closes before you export. Every call is wrapped so that a browser
// without IndexedDB (or with it blocked) still runs the app — it just can't
// autosave, and says so.
//
// Layout (database "memory-offline"):
//   cards       card id → Card
//   images      "images/…" → Blob
//   kv          "meta" → { daily, settings, dirty, lastChangeAt, source, … }
//               "cardOrder" → [card ids]       (cards' order in the file)
//               "lastExport" → { exportedAt, fileName }
//               "fileHandle" → FileSystemFileHandle (Chrome/Edge)
//               "packDraft" → the pack builder's cards
//   packImages  "images/…" → Blob for the pack builder

const DB_NAME = "memory-offline";
const DB_VERSION = 1;
const STORES = ["cards", "images", "kv", "packImages"];

let dbPromise = null;
let currentDb = null;
let unavailableReason = null;

export function storageError() {
  return unavailableReason;
}

function openDb() {
  if (dbPromise) return dbPromise;
  const opening = new Promise((resolve) => {
    let request;
    try {
      if (typeof indexedDB === "undefined" || indexedDB === null) {
        throw new Error("IndexedDB がありません");
      }
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      unavailableReason = String(err?.message ?? err);
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema: step aside rather than block it,
      // and open a fresh connection next time.
      db.onversionchange = () => forget(db);
      // The browser closed it on us (iOS does this to suspended web apps).
      db.onclose = () => forget(db);
      currentDb = db;
      resolve(db);
    };
    request.onerror = () => {
      unavailableReason = String(request.error?.message ?? "IndexedDB を開けませんでした");
      resolve(null);
    };
    request.onblocked = () => {
      unavailableReason = "IndexedDB が別のタブにブロックされています";
    };
  });
  dbPromise = opening;
  return opening;
}

// Drops a connection that has gone bad so the next call opens a new one.
function forget(db) {
  try {
    db?.close();
  } catch {
    // Already closed.
  }
  if (db === currentDb) {
    currentDb = null;
    dbPromise = null;
  }
}

function isConnectionError(err) {
  return (
    err?.name === "InvalidStateError" ||
    err?.name === "UnknownError" ||
    /connection|closing|closed/i.test(String(err?.message ?? ""))
  );
}

/**
 * Runs `fn` with the database, once more on a fresh connection if the old one
 * turned out to be dead ("Connection to Indexed Database server lost").
 * @template T
 * @param {(db: IDBDatabase) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withDb(fn) {
  for (let attempt = 1; ; attempt++) {
    const db = await openDb();
    if (!db) throw new Error(unavailableReason ?? "IndexedDB を使えません");
    try {
      return await fn(db);
    } catch (err) {
      if (attempt >= 2 || !isConnectionError(err)) throw err;
      forget(db);
    }
  }
}

export async function storageAvailable() {
  return (await openDb()) !== null;
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB の書き込みに失敗しました"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB の書き込みが中断されました"));
  });
}

export async function getKv(key) {
  try {
    return await withDb((db) => promisify(db.transaction("kv").objectStore("kv").get(key)));
  } catch {
    return undefined;
  }
}

export async function setKv(key, value) {
  try {
    await withDb((db) => {
      const tx = db.transaction("kv", "readwrite");
      if (value === undefined) tx.objectStore("kv").delete(key);
      else tx.objectStore("kv").put(value, key);
      return done(tx);
    });
    return true;
  } catch {
    return false;
  }
}

// Some older Safari versions can't store Blobs in IndexedDB (DataCloneError);
// after that, keep the bytes instead and turn them back into a Blob on the
// way out.
let blobsWork = true;

async function storableImages(images) {
  const out = new Map();
  for (const [path, blob] of images ?? []) {
    out.set(path, blobsWork ? blob : { buffer: await blob.arrayBuffer(), type: blob.type });
  }
  return out;
}

function blobFromStored(value) {
  if (value instanceof Blob) return value;
  if (value && value.buffer) return new Blob([value.buffer], { type: value.type });
  return null;
}

// Runs `fill` in a fresh readwrite transaction. Everything async (Blob
// conversion) happens before it starts, so the transaction never waits on a
// promise and can't auto-commit half-done.
async function writeWithImages(storeNames, images, fill) {
  const run = () =>
    withDb(async (db) => {
      const stored = await storableImages(images);
      const tx = db.transaction(storeNames, "readwrite");
      try {
        fill(tx, stored);
      } catch (err) {
        try {
          tx.abort();
        } catch {
          // Already finished.
        }
        throw err;
      }
      await done(tx);
    });
  try {
    await run();
  } catch (err) {
    if (err?.name !== "DataCloneError" || !blobsWork || !images || images.size === 0) throw err;
    blobsWork = false;
    await run();
  }
}

/**
 * Writes changes to the working copy in one transaction.
 * @param {object} changes
 * @param {any} [changes.meta]
 * @param {string[] | null} [changes.cardOrder]
 * @param {import("../lib/cards.js").Card[]} [changes.putCards]
 * @param {string[]} [changes.deleteCards]
 * @param {Map<string, Blob>} [changes.putImages]
 * @param {string[]} [changes.deleteImages]
 * @param {boolean} [changes.replaceAll]  clear cards and images first
 */
export async function writeSnapshot(changes) {
  await writeWithImages(["cards", "images", "kv"], changes.putImages, (tx, images) => {
    const cards = tx.objectStore("cards");
    const imageStore = tx.objectStore("images");
    const kv = tx.objectStore("kv");
    if (changes.replaceAll) {
      cards.clear();
      imageStore.clear();
    }
    for (const card of changes.putCards ?? []) cards.put(card, card.id);
    for (const id of changes.deleteCards ?? []) cards.delete(id);
    for (const [path, value] of images) imageStore.put(value, path);
    for (const path of changes.deleteImages ?? []) imageStore.delete(path);
    if (changes.cardOrder) kv.put(changes.cardOrder, "cardOrder");
    if (changes.meta) kv.put(changes.meta, "meta");
  });
}

/**
 * Reads the whole working copy, or null if there isn't one.
 * @returns {Promise<{ meta: any, cards: import("../lib/cards.js").Card[], images: Map<string, Blob> } | null>}
 */
export async function readSnapshot() {
  try {
    return await withDb(async (db) => {
      const tx = db.transaction(["cards", "images", "kv"]);
      const [meta, order, cards, imageKeys, imageValues] = await Promise.all([
        promisify(tx.objectStore("kv").get("meta")),
        promisify(tx.objectStore("kv").get("cardOrder")),
        promisify(tx.objectStore("cards").getAll()),
        promisify(tx.objectStore("images").getAllKeys()),
        promisify(tx.objectStore("images").getAll()),
      ]);
      if (!meta) return null;
      const position = new Map((order ?? []).map((id, i) => [id, i]));
      cards.sort(
        (a, b) => (position.get(a.id) ?? Infinity) - (position.get(b.id) ?? Infinity)
      );
      const images = new Map();
      imageKeys.forEach((key, i) => {
        const blob = blobFromStored(imageValues[i]);
        if (blob) images.set(String(key), blob);
      });
      return { meta, cards, images };
    });
  } catch {
    return null;
  }
}

/** Just the meta record — enough for the launch screen. */
export async function readSnapshotMeta() {
  return (await getKv("meta")) ?? null;
}

// ---- Pack builder draft ------------------------------------------------

export async function readPackDraft() {
  try {
    return await withDb(async (db) => {
      const tx = db.transaction(["kv", "packImages"]);
      const [draft, keys, values] = await Promise.all([
        promisify(tx.objectStore("kv").get("packDraft")),
        promisify(tx.objectStore("packImages").getAllKeys()),
        promisify(tx.objectStore("packImages").getAll()),
      ]);
      if (!draft) return null;
      const images = new Map();
      keys.forEach((key, i) => {
        const blob = blobFromStored(values[i]);
        if (blob) images.set(String(key), blob);
      });
      return { draft, images };
    });
  } catch {
    return null;
  }
}

/**
 * @param {any} draft
 * @param {Map<string, Blob>} images  every image the draft uses
 */
export async function writePackDraft(draft, images) {
  try {
    await writeWithImages(["kv", "packImages"], images, (tx, stored) => {
      const store = tx.objectStore("packImages");
      store.clear();
      for (const [path, value] of stored) store.put(value, path);
      if (draft) tx.objectStore("kv").put(draft, "packDraft");
      else tx.objectStore("kv").delete("packDraft");
    });
    return true;
  } catch {
    return false;
  }
}

// Asks the browser not to evict this site's storage under pressure. Installed
// PWAs usually get this anyway; Safari otherwise clears site data after a week
// without visits.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

export async function storageEstimate() {
  try {
    return (await navigator.storage?.estimate?.()) ?? null;
  } catch {
    return null;
  }
}
