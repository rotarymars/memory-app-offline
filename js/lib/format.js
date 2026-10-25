// Date and number formatting for the Japanese UI and for export file names.
// Everything is in the device's local time.

function pad(n, width = 2) {
  return String(n).padStart(width, "0");
}

function toDate(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "2026/10/25 21:30"
export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return "—";
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "10/25"
export function formatShortDate(value) {
  const d = toDate(value);
  if (!d) return "—";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// "memory-study_2026-10-25_2130.zip"
export function studyFileName(date = new Date()) {
  return `memory-study_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}.zip`;
}

// "pack_2026-10-25"
export function defaultPackName(date = new Date()) {
  return `pack_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Characters that Windows, macOS or iOS Files won't take in a file name.
export function safeFileName(name, fallback = "pack") {
  const cleaned = String(name ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return cleaned || fallback;
}

// "3時間前" — how long ago `value` was, for the restore prompt.
export function formatAgo(value, now = new Date()) {
  const d = toDate(value);
  if (!d) return "";
  const minutes = Math.round((now.getTime() - d.getTime()) / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}時間前`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}日前`;
  return `${Math.round(days / 30)}か月前`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatRate(rate) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}
