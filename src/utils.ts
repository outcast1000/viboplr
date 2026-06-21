
export const trashLabel = navigator.platform.includes("Mac") ? "Trash" : "Recycle Bin";

const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "wmv"];

// Pull the file extension out of a scheme-prefixed path/URL, ignoring any
// query (`?token=…`) or fragment (`#v=12`) suffix. Returns "" when absent.
function extensionFromPath(path: string): string {
  const clean = path.split(/[?#]/)[0];
  const dot = clean.lastIndexOf(".");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  if (dot <= slash) return "";
  return clean.slice(dot + 1).toLowerCase();
}

export function isVideoTrack(track: { format: string | null; path?: string | null }): boolean {
  const format = track.format?.toLowerCase() ?? "";
  // A known format is authoritative — a real audio file with a misleading name
  // must not be treated as video. Only fall back to the path extension when the
  // format is absent (e.g. queue tracks built from path-less plugin metadata).
  if (format) return VIDEO_FORMATS.includes(format);
  return track.path ? VIDEO_FORMATS.includes(extensionFromPath(track.path)) : false;
}

export function getInitials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2);
}

export function formatDuration(secs: number | null | undefined): string {
  if (!secs) return "--:--";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function parseSubsonicUrl(raw: string): { serverUrl: string; username: string; password: string } | null {
  try {
    // Replace subsonic:// with https:// so URL parser can handle it
    const normalized = raw.replace(/^subsonic:\/\//, "https://");
    const url = new URL(normalized);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!username) return null;
    // Reconstruct server URL without credentials
    url.username = "";
    url.password = "";
    const serverUrl = url.toString().replace(/\/$/, "");
    return { serverUrl, username, password };
  } catch {
    return null;
  }
}

export function collectionKindLabel(kind: string): string {
  switch (kind) {
    case "local": return "Local";
    case "subsonic": return "Server";
    case "manifest": return "Music source";
    case "seed": return "Test";
    default: return kind;
  }
}

export function shouldScrobble(
  positionSecs: number,
  durationSecs: number | null,
): boolean {
  if (durationSecs == null || durationSecs < 30) return false;
  const threshold = Math.min(durationSecs * 0.5, 240);
  return positionSecs >= threshold;
}

export const stripAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    if (v >= 100) return `${Math.round(v)}M`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}M`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    if (v >= 100) return `${Math.round(v)}K`;
    if (v >= 10) return `${v.toFixed(1).replace(/\.0$/, "")}K`;
    return `${v.toFixed(2).replace(/\.?0+$/, "")}K`;
  }
  return String(n);
}
