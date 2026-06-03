# Mixtape Full-Export Native Format Selection

**Date:** 2026-06-04
**Status:** Approved (design)

## Summary

Full-mode mixtape export should pack every track in its **native format** — no
transcoding. Local `file://` tracks are copied verbatim (already true today).
Remote tracks are downloaded via the provider resolve chain, with the user
choosing a **maximum preferred format** per export instead of relying on a global
setting.

As part of this, the now-redundant global **Settings > General → Download
format** setting is removed, along with two pieces of plumbing it was the last
justification for: the `api.downloads.getDownloadFormat()` plugin API method and
the unused `useDownloads.downloadTrack` function. The `useDownloads` hook is
dissolved entirely.

## Goals

- Full mixtape packs tracks in native format (no re-encode).
- Per-export "max preferred format" picker for remote tracks, shown only when the
  mixtape actually contains remote tracks.
- Remove the global Download format setting and its dead/now-redundant plumbing.
- No new host↔plugin contract; reuse the existing format-hint resolve path.

## Non-Goals

- No transcoding/quality enforcement. The chosen format is a **hint**; each
  provider returns the best native option it can and falls back to its own best.
- No per-provider pickers. A single cross-provider preference ladder.
- No change to playlist-only export (it packs no audio).
- No change to the regular `DownloadModal` flow beyond dropping the `downloadFormat`
  seed prop (it already remembers `lastDownloadQuality`).

## Decisions (from brainstorming)

1. Format choice lives **in the export modal**, per-export — not in Settings.
2. **No transcoding** — pack/download tracks in their native format.
3. `file://` = local (packed verbatim); everything else = remote. A `subsonic://`
   entry is always treated as remote even if a matching local copy exists in the
   library.
4. The picker is a **single "max preferred format" ceiling**, passed as the
   existing `format` hint; each provider interprets it and falls back to native
   best ("provider decides").
5. Dropdown is a **fixed host-defined ladder**, shown **only when the full mixtape
   contains ≥1 remote track**.
6. **Remove** the global Settings > Download format setting.
7. **Remove** `api.downloads.getDownloadFormat()` and `useDownloads.downloadTrack`.
8. **Inline** the `download-resolve-request` listener into App.tsx and delete
   `useDownloads.ts`.

## Current Behavior (baseline)

- `MixtapeExportModal` (full mode) sends `options.format = downloadFormat || "flac"`
  to `export_mixtape_full` (`MixtapeExportModal.tsx:221`).
- Backend `export_mixtape_full` reads `let format = options.format.as_deref().unwrap_or("flac")`
  (`commands/mixtapes.rs:206`).
- Local `file://` tracks are packed verbatim — `format` ignored
  (`commands/mixtapes.rs:224-237`).
- Remote tracks go through `resolve_and_download_track(..., &format)`
  (`commands/mod.rs:811`), which emits `download-resolve-request` with the `format`
  string (`commands/mod.rs:843`). The packed file's extension is **sniffed from the
  resolved URL** (`.flac`/`.m4a`/`.mp3`, `commands/mod.rs:851`), not transcoded.
- `downloadFormat` is sourced from `Settings > General → Download format`
  (`store` key `downloadFormat`, default `"flac"`), surfaced via `useDownloads`.
- The same `downloadFormat` also seeds the regular `DownloadModal`'s initial
  quality, but `lastDownloadQuality` immediately overrides it
  (`SingleTrackDownload.tsx:75-89`, `MultiTrackDownload.tsx:56-69`).

## Design

### 1. Format ladder

A fixed, host-defined constant, rendered highest-first. Lives in a small exported
util (e.g. `src/utils/mixtapeFormatLadder.ts`) so it is testable and not inline JSX.

| Label            | `value` (hint string) |
|------------------|-----------------------|
| FLAC hi-res      | `flac-hires`          |
| FLAC (lossless)  | `flac`                |
| AAC / M4A        | `aac`                 |
| MP3              | `mp3`                 |

- **Default selection:** `flac` — matches the backend `.unwrap_or("flac")` so
  existing behavior is preserved for users who don't touch the control.
- These are **hint strings**, passed straight into `options.format` →
  `download-resolve-request` `format`. Providers already receive this and already
  fall back to native best.
- `flac-hires` is new vocabulary. Providers that don't recognize it fall back to
  their best native option (the documented "provider decides" contract). **No
  backend `DownloadFormat` enum change** is needed: mixtape packing sniffs the real
  extension from the resolved URL rather than transcoding.

### 2. UI placement & gating (`MixtapeExportModal.tsx`)

- New `maxFormat` state, default `"flac"`.
- Rendered on the **Details** tab, inside the existing `exportMode === "full"`
  block, directly under the "N remote tracks will be downloaded during export"
  hint (~line 330-332).
- **Gating:** renders only when `exportMode === "full"` **and** the tracklist has
  ≥1 remote track. Reuses the existing predicate `trackList.some(t => trackStatus(t) !== "local")`.
  (`trackStatus` already classifies `file://` as local, everything else as remote.)
- **Control:** a labeled `<select>` styled like the existing modal selects (e.g. the
  Type dropdown), options from the ladder, bound to `maxFormat`.
- **Playlist-only mode:** never shows it.
- On export, `maxFormat` replaces the current `downloadFormat || "flac"` argument in
  the `export_mixtape_full` invoke.

No new tabs, no layout restructuring — one new row in an existing section.

### 3. Remove global setting + plumbing

**A. Settings control + store/restore**
- `SettingsPanel.tsx` — remove the "Download format" row + `downloadFormat` /
  `onDownloadFormatChange` props.
- `App.tsx` — remove `onDownloadFormatChange` and all three `downloadFormat={...}`
  props (mixtape + two `DownloadModal` sites).
- `store.ts` — remove the `downloadFormat: "flac"` default key.
- `readPersistedSettings.ts` — remove the `downloadFormat` read + type field.
- `DownloadModal` / `SingleTrackDownload` / `MultiTrackDownload` — drop the
  `downloadFormat` prop; replace the seed `downloadFormat === "flac" ? "flac" : "aac"`
  with literal `"flac"` (then `lastDownloadQuality` overrides as before).

**B. Remove `api.downloads.getDownloadFormat()` (plugin API)**
- `types/plugin.ts` — remove `getDownloadFormat(): Promise<string>` from
  `PluginDownloadsAPI`.
- `usePlugins.ts` — remove the `async getDownloadFormat()` implementation from the
  `downloads` API object and `getDownloadFormat` from `PluginPlaybackCallbacks`.
- `App.tsx` — remove the `getDownloadFormat: () => downloadFormatRef.current`
  callback.
- **Breaking-change note:** this is a plugin-API removal. No **bundled** plugin uses
  it (verified by grep over `src-tauri/plugins/`). External gallery plugins that
  called it will get `undefined`; they should already guard with a fallback. Called
  out here intentionally.

**C. Remove `useDownloads.downloadTrack` (dead code)**
- Confirmed zero callers (only the definition, interface entry, and return field
  reference it). Removed along with the hook (see D).

**D. Dissolve `useDownloads` + collapse `downloadFormatRef`**
- The `download-resolve-request` listener effect and its `resolveTrackDownload`
  helper move into `App.tsx` as a self-contained `useEffect` keyed on the
  download-provider ref.
- `useDownloads.ts` is **deleted**; the `const downloads = useDownloads(...)` call
  and import are removed.
- `downloadFormatRef`'s only remaining reader is the **non-interactive context-menu
  enqueue** (`App.tsx:855`, `format: downloadFormatRef.current`). The ref is
  removed; that call passes `format: null` instead — consistent with the other
  context-menu enqueue paths in `useContextMenuActions.ts`, which already pass
  `format: null`. The backend treats null format as "provider/source decides."

### 4. Data flow (after change)

```
MixtapeExportModal (full + has remote tracks)
  maxFormat  ("flac-hires" | "flac" | "aac" | "mp3", default "flac")
    │
    ▼  invoke("export_mixtape_full", { options: { …, format: maxFormat } })
export_mixtape_full  →  format = options.format.unwrap_or("flac")
    │
    ├─ file:// track          → packed verbatim (format ignored)
    └─ remote track           → resolve_and_download_track(…, &format)
            │  emits download-resolve-request { …, format }
            ▼  (host → provider resolve chain, App.tsx inlined listener)
        provider returns best native URL it can at/below the hint
            │
            ▼  file extension sniffed from resolved URL → packed
```

## Testing

- **`src/__tests__/mixtapeFormatLadder.test.ts`** (new) — assert ladder order
  (highest-first), expected `value` strings, and `flac` default. Mirrors
  `builtinDownloadQualities.test.ts`.
- **Remote-detection predicate** — if extracted into a tiny pure helper, test it
  (`file://` → not remote; `subsonic://`, http, plugin scheme, null path → remote).
  If it stays inline as `trackStatus(t) !== "local"`, no new test (already covered).
- **No backend test changes** — `export_mixtape_full` already accepts/forwards
  `format`; only the frontend string changes. Existing mixtape tests stay green.
- **Manual smoke (not automated):** full mixtape with a remote track → picker
  appears, default FLAC, export forwards the hint; all-local mixtape → no picker;
  regular `DownloadModal` still defaults correctly and remembers
  `lastDownloadQuality`.
- **Regression guard:** `npx tsc --noEmit`, `npm test`, `cd src-tauri && cargo check`.

## Risks / Notes

- **Plugin API removal (B)** is the only outward-facing breaking change; mitigated
  by the fact no bundled plugin uses it and the contract was a soft "default".
- `flac-hires` only yields true hi-res when a provider implements it; otherwise it
  degrades to that provider's best native option. This is the intended
  "provider decides" behavior, not a regression.
- App.tsx grows by one inlined effect (the resolve-request listener). Acceptable —
  it removes a hook whose remaining surface was a single listener.

## Files Touched

- `src/components/MixtapeExportModal.tsx` — add picker + gating, send `maxFormat`.
- `src/utils/mixtapeFormatLadder.ts` — **new** ladder constant.
- `src/__tests__/mixtapeFormatLadder.test.ts` — **new** test.
- `src/components/SettingsPanel.tsx` — remove Download format row + props.
- `src/components/DownloadModal.tsx` — drop `downloadFormat` prop.
- `src/components/download/SingleTrackDownload.tsx` — drop prop, literal default.
- `src/components/download/MultiTrackDownload.tsx` — drop prop, literal default.
- `src/hooks/useDownloads.ts` — **deleted** (listener inlined into App.tsx).
- `src/hooks/usePlugins.ts` — remove `getDownloadFormat` (API + callback type).
- `src/types/plugin.ts` — remove `getDownloadFormat` from `PluginDownloadsAPI`.
- `src/App.tsx` — inline resolve-request listener, remove `useDownloads`/refs/props.
- `src/store.ts` — remove `downloadFormat` default.
- `src/startup/readPersistedSettings.ts` — remove `downloadFormat` read + type.
- `.claude/rules/*` — update any doc references to the removed setting / API.
