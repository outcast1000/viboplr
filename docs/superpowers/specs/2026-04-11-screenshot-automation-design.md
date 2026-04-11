# Screenshot Automation Design

## Problem

The docs website (viboplr.com) has 10 screenshot placeholder slots — 1 hero image on `index.html` and 9 feature sections on `features.html` — all showing "coming soon". There are zero actual screenshots in `docs/assets/`.

## Solution

A Playwright script that starts the Vite dev server, mocks the Tauri backend IPC, navigates the app to specific states, and captures WebP screenshots at 2x resolution.

## Decisions

- **Playwright + Vite dev server** — not the full Tauri app. Simpler, automatable, no build step.
- **Mock `window.__TAURI_INTERNALS__`** via `page.addInitScript()` — keeps app code clean. The mock intercepts `invoke()` and returns canned responses.
- **WebP at 2x** — 1280x800 viewport with `deviceScaleFactor: 2` producing 2560x1600 images.
- **Raw UI capture** — no faux window chrome.
- **All 10 screenshots** in one script run.

## File Structure

```
scripts/screenshots/
  playwright.config.ts     — Playwright config (viewport, webp, output dir)
  take-screenshots.ts      — Main Playwright test file: 10 test cases
  mock-data.ts             — Canned invoke responses (artists, albums, tracks, etc.)
  mock-tauri.ts            — addInitScript payload that intercepts invoke()
docs/assets/screenshots/   — Output directory (10 WebP files, gitignored or committed)
package.json               — New "screenshots" npm script
```

## Mock Layer

### How It Works

`mock-tauri.ts` exports a function that returns a string of JavaScript to be injected via `page.addInitScript()`. This script runs before the app loads and sets up `window.__TAURI_INTERNALS__` with a mock `invoke()` that:

1. Looks up the command name in a response map
2. Returns the canned response if found
3. For unknown commands, returns a sensible default (`null`, `[]`, or `{}`) and logs the command name to the console

The response map is built from the data in `mock-data.ts`.

### Startup Calls (Always Respond)

These are called on every page load during app initialization:

| Command | Mock Response |
|---------|--------------|
| `get_profile_info` | App settings/profile object |
| `get_artists` | ~15-20 artists with names, IDs, image slugs |
| `get_albums` | ~30 albums linked to artists |
| `get_tags` | ~10 genre tags (Rock, Electronic, Jazz, etc.) |
| `get_collections` | 1 local folder + 1 Navidrome server |
| `get_collection_stats` | Track/album counts per collection |
| `get_track_count` | 847 |
| `list_user_skins` | Empty array (use default skin) |
| `get_download_status` | Empty download queue |
| `info_sync_types` | Empty array |
| `sync_image_providers` | Empty array |
| `write_frontend_log` | No-op |

### View-Specific Calls

| Command | When Triggered |
|---------|---------------|
| `get_tracks` / `get_tracks_by_artist` / `get_tracks_by_tag` | Navigating to track lists |
| `get_liked_tracks` | Liked view |
| `get_history_most_played`, `get_history_recent`, `get_history_most_played_artists`, `get_history_most_played_since` | History view |
| `search_all` | Central search |
| `tidal_search` | TIDAL view |
| `get_tags_for_track`, `get_track_play_stats`, `get_track_audio_properties` | Track properties modal |

### Fallback

Any unhandled command returns a default empty value and logs a warning to the browser console for debugging.

## Screenshot Map

| # | Name | Filename | App State / Actions |
|---|------|----------|-------------------|
| 1 | Hero | `hero.webp` | "All tracks" view with track list populated, no track playing. Default landing state. |
| 2 | Playback | `playback.webp` | A track "playing" — mock current track state so now-playing bar shows track info with progress bar partially filled. |
| 3 | Library | `library.webp` | Artist or album detail view — click into an artist to show their tracks. |
| 4 | Search | `search.webp` | Central search dropdown open with results visible. |
| 5 | Servers | `servers.webp` | Collections view showing local folder + Navidrome collection. |
| 6 | Mini Player | `mini-player.webp` | Resize viewport to mini dimensions (~320x52), capture the compact now-playing bar. |
| 7 | Keyboard | `keyboard.webp` | Trigger keyboard shortcut overlay (press `?`), capture with overlay visible. |
| 8 | Skins | `skins.webp` | Settings panel open on Skins tab showing built-in skin list. |
| 9 | Discovery | `discovery.webp` | Track properties modal open on Similar tab with similar tracks/artists data. |
| 10 | Plugins | `plugins.webp` | Settings panel open on Plugins tab. |

## Capture Settings

- **Viewport**: 1280x800 (except Mini Player: ~320x52)
- **Device scale factor**: 2 (produces 2560x1600 images)
- **Format**: WebP
- **Wait strategy**: `networkidle` + short settle delay (~500ms) for animations to complete

## Script Execution Flow

The npm script `screenshots` does the following:

1. Start the Vite dev server (`npm run dev` or `npx vite`) on a known port
2. Wait for the server to be ready
3. Run the Playwright test file which:
   a. For each screenshot, creates a new page
   b. Injects the Tauri mock via `addInitScript()`
   c. Navigates to the app
   d. Performs interactions to reach the desired state
   e. Waits for settle
   f. Captures screenshot to `docs/assets/screenshots/<name>.webp`
4. Stop the Vite dev server

## Integration with Docs Site

After screenshots are generated, the existing placeholder `<div class="feature-image">` elements in `index.html` and `features.html` need to be updated to reference the new images:

```html
<!-- Before -->
<div class="feature-image">
  <span>Playback screenshot — coming soon</span>
</div>

<!-- After -->
<div class="feature-image">
  <img src="assets/screenshots/playback.webp" alt="Viboplr playback view" loading="lazy" width="2560" height="1600">
</div>
```

The hero screenshot in `index.html` replaces the `hero-screenshot-inner` placeholder similarly.

## Dependencies

- `@playwright/test` — dev dependency
- Playwright browsers installed (`npx playwright install chromium`)
- Vite dev server (already configured)

## Mock Data Quality

The mock data should use realistic-looking music metadata — real-ish artist names, album titles, and track names make the screenshots look authentic. The data shapes must match what the Rust backend returns (referencing `models.rs` structs serialized via serde).
