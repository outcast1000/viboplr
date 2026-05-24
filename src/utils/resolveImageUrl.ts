import { convertFileSrc } from "@tauri-apps/api/core";

export function resolveImageUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
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
