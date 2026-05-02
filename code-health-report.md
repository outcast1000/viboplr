# Code Health Report

```
Files scanned: ~30 frontend + ~12 backend + 6 plugin
Findings: 60 total (6 high / 20 medium / 34 low)
Date: 2026-05-02
```

## High Priority

| # | Dimension | Location | Issue | Fix |
|---|-----------|----------|-------|-----|
| 1 | Performance | `TrackList.tsx`, `QueuePanel.tsx`, `HistoryView.tsx` | No list virtualization — 20k+ tracks render as 20k+ DOM nodes | Adopt `@tanstack/react-virtual` |
| 2 | Performance | All list components | Zero `React.memo` on row components — every parent state change re-renders every row | Extract row components with `React.memo` |
| 3 | Code Reuse | 7+ files | Duplicate `!path.startsWith("subsonic://") && !path.startsWith("tidal://")` compound checks | Add `isLocalTrack()` to `queueEntry.ts` |
| 4 | Code Reuse | 5 components | `formatDuration` reimplemented 5 times with minor variations | Delete copies, import from `utils.ts` |
| 5 | Behavioral | `useAppUpdater.ts:51` | "Check for updates" swallows errors and reports "up to date" — user gets false positive | Show error state or `console.error` |
| 6 | Misc | `App.tsx` (3628 lines) | Monolithic — architectural tech debt | Track for incremental extraction |

## Medium Priority

| # | Dimension | Location | Issue | Fix |
|---|-----------|----------|-------|-----|
| 7 | Canonical | `InformationSections.tsx:126-168` | `play-or-youtube` / `youtube-search` reimplement YouTube flow — miss `addLog`, save modal, `durationSecs` | Route through `watchOnYoutube()` |
| 8 | Behavioral | `usePlugins.ts:258-267` | Plugin API entity lookups (`getTrackById` etc.) `.catch(() => null)` — swallows DB errors | Add `console.error` before returning null |
| 9 | Behavioral | `useDownloads.ts:37,50` | Download provider chain swallows errors without logging | `console.error` before `continue` |
| 10 | Behavioral | `DownloadModal.tsx:358` | Download conflict check error silently swallowed | Add `console.error` |
| 11 | Behavioral | `useInformationTypes.ts:245` | Main info type fetch error handler has no `console.error` | Add `console.error` |
| 12 | Behavioral | `InformationSections.tsx:141,147,162` | YouTube action catches silent — user-triggered actions fail with no feedback | Add `console.error` and `addLog` |
| 13 | Performance | List components | No `useCallback`/`useMemo` for handlers or derived data | Add when introducing `React.memo` |
| 14 | Performance | `commands.rs:2928` | N+1 in `plugin_apply_tags` — 2N lock acquisitions for N tags | Batch into single transaction |
| 15 | Performance | `commands.rs:917` | N+1 in `bulk_update_tracks` — individual DB queries per track | Batch DB updates into transaction |
| 16 | Code Reuse | 5 components | IntersectionObserver boilerplate duplicated identically | Extract `useOnVisible(ref, callback)` hook |
| 17 | Code Reuse | `useImageCache.ts:32` | Entity key construction adds `.toLowerCase()` vs canonical `getEntityKey()` | Standardize on one approach |
| 18 | Dead Code | `src/types.ts` | 6 TIDAL types (`TidalSearchResult`, etc.) never imported — TIDAL moved to plugins | Delete |
| 19 | Dead Code | `commands.rs:2682` | `resolve_cover_url` is never called, contains stale TODO | Delete |
| 20 | Dead Code | `db.rs:2417,2515` | `record_play` + `record_history_play` — only test-reachable, production uses `record_play_by_metadata` | Gate behind `#[cfg(test)]` or delete |
| 21 | Dead Code | `commands.rs:55` | `AppState` fields `app_data_dir`, `update_checker_cancel` never read | Remove or `#[allow(dead_code)]` |
| 22 | Misc | `useWaveform.ts:111` | Logs error with `console.log` instead of `console.error` | Fix to `console.error` |
| 23 | Misc | `App.tsx:1266` | Magic `15000` duplicates `DEFAULT_TIMEOUT_MS` from `streamResolvers.ts` | Import the constant |
| 24 | Misc | `db.rs` (5597), `commands.rs` (4993) | Largest Rust files — candidates for module splitting | Split by domain |
| 25 | Misc | `DownloadModal.tsx` (1646), `SettingsPanel.tsx` (1487), `usePlugins.ts` (1440) | Large files | Incremental extraction |

## Low Priority

26 findings covering:

- **Silent catches with acceptable justification but missing comments** (14) — `App.tsx:1470` (cleanup_temp_mixtapes), `DownloadModal.tsx:449,452,489,1060` (cancel operations), `usePlugins.ts:817` (unsub cleanup), `usePlugins.ts:914` (getVersion), `App.tsx:1752` (detail track fetch), `useAppUpdater.ts:34,74` (update check/install), `useAutoContinue.ts:94` (track selection), `useSkins.ts:43,63` (skin loading), `useMiniMode.ts:56` (monitor parsing), `useWaveform.ts:54` (cache miss)
- **`console.log` in production paths that should be `console.debug`** (7) — `usePlugins.ts:1249`, `useWaveform.ts:50,104`, `App.tsx:1403,1975,1979,1982`
- **Dead types/methods in internal modules** (5) — `types.ts` (`MixtapeManifest`, `MixtapeTrack`), `informationTypes.ts` (`InfoStatus`, `InfoProvider`), `db.rs:2107` (`get_track_by_remote_id`), `db.rs:3231` (`info_delete_values_for_type`), `models.rs:360` (`MixtapeExportTrackInput.id`), `downloader.rs:37` (`tidal_quality`)
- **Magic numbers for scrobble thresholds and image rate limits** (3) — `utils.ts:58-59` (scrobble constants 30/0.5/240), `lib.rs:811,951` (1100ms image rate limit)
- **`db.rs` mutex lock pattern inconsistency** (1) — 116x `unwrap()` vs 8x `map_err()`

## Summary by Dimension

```
Canonical Actions:    2 findings (0 high, 1 medium, 1 low)
Behavioral Rules:    26 findings (1 high, 5 medium, 20 low)
Code Reuse:          6 findings (2 high, 2 medium, 2 low)
Performance:         9 findings (2 high, 3 medium, 4 low)
Dead Code:           8 findings (0 high, 4 medium, 4 low)
Misc:                9 findings (1 high, 5 medium, 4 low)
```

## Large Files — Refactoring Candidates

| File | Lines | Why it matters | Possible split |
|------|-------|---------------|----------------|
| `db.rs` | 5,597 | Single file with schema, migrations, CRUD for every entity, FTS, info types, history, providers, lyrics, playlists | Split into `db/` module: `schema.rs`, `tracks.rs`, `artists.rs`, `history.rs`, `info_types.rs`, `providers.rs` |
| `commands.rs` | 4,993 | ~107 Tauri commands in one file — pure dispatch, but navigation is painful | Split by domain: `commands/library.rs`, `commands/playback.rs`, `commands/plugins.rs`, `commands/downloads.rs` |
| `App.tsx` | 3,622 | All top-level state, view routing, event wiring, modals — the monolith | Extract modal state/rendering and view routing into separate components |
| `App.css` | 2,560 | Global styles, layout, animations, legacy component styles | Move component-specific styles to colocated `.css` files |
| `DownloadModal.tsx` | 1,646 | Two distinct modes (single + batch) in one component | Split into `SingleDownload.tsx` and `BatchDownload.tsx` with shared types |
| `SettingsPanel.tsx` | 1,487 | Every settings tab in one component | Extract each tab section into its own component |
| `usePlugins.ts` | 1,440 | Plugin API builder + lifecycle + event dispatch | Extract the API builder (`buildPluginAPI()`) into a separate module |
| `lib.rs` | 1,439 | App setup, plugin registration, fallback chains, command registration | Extract fallback chain construction and command registration |
| `SearchView.tsx` | 1,094 | Recently grown — worth watching | — |
| `PluginViewRenderer.tsx` | 1,028 | One big switch on view data types | Each `case` could be its own renderer component |
| `downloader.rs` | 1,063 | Download queue, format conversion, tag writing | Split format handlers from queue management |
| `TrackDetailView.css` | 889 | Largest component CSS file | — |
| `design-system.css` | 864 | Growing design token / utility library | Expected to grow; keep organized by category |
| `SettingsPanel.css` | 795 | Matches its large component | Would split naturally with component extraction |
| `NowPlayingBar.tsx` | 707 | Full + mini mode in one component | Could split mini mode into its own component |
| `NowPlayingBar.css` | 734 | Full + mini mode styles | Would split with component |
| `QueuePanel.tsx` | 676 | Expanded + collapsed modes, drag-and-drop | Manageable but watch for growth |
| `scanner.rs` | 626 | File walking, tag reading, filename parsing | Could extract filename parser into its own module |
| `usePlayback.ts` | 608 | Dual A/B audio element architecture, crossfade, preload | Dense but cohesive |
| `TrackDetailView.tsx` | 605 | Hero header, quality stats, inline tags, sections | Approaching threshold |

The backend pair (`db.rs` + `commands.rs` = 10,590 lines) would give the most bang for the buck — they're the hardest to navigate and the split is mechanical (group by entity/domain, move functions, re-export).
