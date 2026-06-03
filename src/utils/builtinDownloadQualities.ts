import type { DownloadQualityOption } from "../types/plugin";

/// Download quality/format options for built-in (non-plugin) providers.
///
/// Plugin providers declare their own options via `api.downloads.onGetQualities`
/// (e.g. YouTube "160kbps AAC/M4A", Tidal "FLAC"). Built-in providers don't go
/// through that path, so their options live here. Returns `null` when the
/// provider isn't a known built-in — the caller then falls back to plugin
/// options or the generic default selector.
export function builtinQualityOptions(providerId: string): DownloadQualityOption[] | null {
  switch (providerId) {
    case "__builtin:subsonic":
      // Subsonic downloads the original file untouched; the saved extension is
      // the source's real suffix (resolved server-side).
      return [{ value: "original", label: "Source original" }];
    default:
      return null;
  }
}
