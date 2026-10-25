// Guarding against a forgotten export. This device keeps its working copy in
// IndexedDB; when a study file is opened, these decide whether to offer that
// copy instead, which of the two is newer, and whether the file looks older
// than one exported from here.

/**
 * @typedef {object} SnapshotInfo
 * @property {boolean} dirty               has changes not yet exported
 * @property {string | null} lastChangeAt  last edit or answer (ISO)
 * @property {number} cardCount
 */

/**
 * @typedef {object} OpenedFileInfo
 * @property {string | null} exportedAt    meta.json exportedAt
 * @property {string | null} latestEditAt  newest edit time inside the file
 */

/**
 * @typedef {object} OpenDecision
 * @property {boolean} offerRestore        ask whether to use this device's copy instead
 * @property {"unexported" | "newer" | null} reason
 *   "unexported": this device has changes that were never exported (whatever their age)
 *   "newer": no unexported changes, but this device's copy was changed after the file
 * @property {boolean} deviceNewer         this device's copy was changed after the file
 * @property {boolean} olderThanLastExport the file predates the last export from this device
 * @property {string | null} fileTime      newest of exportedAt / latestEditAt
 */

function newest(...values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    if (best === null || t > Date.parse(best)) best = new Date(t).toISOString();
  }
  return best;
}

/**
 * @param {SnapshotInfo | null} snapshot   null when this device has no copy
 * @param {OpenedFileInfo} file
 * @param {{ exportedAt: string } | null} lastExport   last export from this device
 * @returns {OpenDecision}
 */
export function decideOnOpen(snapshot, file, lastExport) {
  const fileTime = newest(file.exportedAt, file.latestEditAt);
  let offerRestore = false;
  let reason = null;
  let deviceNewer = false;

  // An empty, untouched copy (e.g. "start empty" and nothing else) isn't
  // worth asking about.
  const hasContent = snapshot && (snapshot.dirty || snapshot.cardCount > 0);
  if (hasContent) {
    deviceNewer = Boolean(
      snapshot.lastChangeAt &&
        (!fileTime || Date.parse(snapshot.lastChangeAt) > Date.parse(fileTime))
    );
    // Unexported changes are always worth asking about — even when the file
    // is newer (both sides then have changes the other lacks).
    if (snapshot.dirty) {
      offerRestore = true;
      reason = "unexported";
    } else if (deviceNewer) {
      offerRestore = true;
      reason = "newer";
    }
  }

  const olderThanLastExport = Boolean(
    lastExport?.exportedAt &&
      (!fileTime || Date.parse(fileTime) < Date.parse(lastExport.exportedAt))
  );

  return { offerRestore, reason, deviceNewer, olderThanLastExport, fileTime };
}

/**
 * The time a freshly opened file's working copy counts as last changed: the
 * file's own newest time, not the moment it was opened. Otherwise opening the
 * same file again would look like "this device has something newer".
 * @param {OpenedFileInfo} file
 * @returns {string | null}
 */
export function baselineChangeTime(file) {
  return newest(file.exportedAt, file.latestEditAt);
}

/**
 * Before saving over the opened file: has someone else written it since we
 * opened (or last saved) it? Compares the exportedAt in the file on disk with
 * the one we know about.
 * @param {string | null} knownExportedAt   source.exportedAt of the working data
 * @param {string | null} diskExportedAt    exportedAt read from the file now
 * @returns {boolean}
 */
export function changedOnDisk(knownExportedAt, diskExportedAt) {
  if (!diskExportedAt) return false;
  if (!knownExportedAt) return true;
  return Date.parse(diskExportedAt) > Date.parse(knownExportedAt);
}
