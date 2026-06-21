import { convertFileSrc } from "@tauri-apps/api/core";

export function resolveImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  // data: URIs (e.g. a plugin-supplied inline cover) are usable as-is — never
  // run them through convertFileSrc, which would treat them as a file path.
  if (url.startsWith("data:")) return url;
  // Plugins can append `#v=N` to a local path to bust the WebView's image
  // cache when the underlying file is rewritten in place (e.g. Spotify's
  // weekly-rotating Discover Weekly cover). Translate to `?v=N` so the URL
  // changes for asset:// requests.
  const hashIdx = url.indexOf("#v=");
  if (hashIdx >= 0) {
    const base = url.substring(0, hashIdx);
    const version = url.substring(hashIdx + 3);
    return convertFileSrc(base) + "?v=" + encodeURIComponent(version);
  }
  return convertFileSrc(url);
}

/**
 * Strip a plugin-appended `#v=N` cache-buster from a local path so it can be
 * passed to the backend (which treats the whole string as a filesystem path
 * and would fail to find a file whose name literally contains `#v=...`).
 * No-op for http(s) URLs.
 */
export function stripImageVersion(url: string | undefined | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const hashIdx = url.indexOf("#v=");
  return hashIdx >= 0 ? url.substring(0, hashIdx) : url;
}
