import type { Track } from "./types";

const VIDEO_FORMATS = ["mp4", "m4v", "mov", "webm"];

export function isVideoTrack(track: Track): boolean {
  return VIDEO_FORMATS.includes(track.format?.toLowerCase() ?? "");
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

export function tidalCoverUrl(coverId: string | null, size = 320): string | null {
  if (!coverId) return null;
  const path = coverId.replace(/-/g, "/");
  return `https://resources.tidal.com/images/${path}/${size}x${size}.jpg`;
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
    case "tidal": return "TIDAL";
    case "seed": return "Test";
    default: return kind;
  }
}
