# Spotify Browse Plugin

## Purpose

Scrapes playlists and tracks from the Spotify web app (`open.spotify.com`) via an embedded browser window. Spotify does not provide a public API for personalized sections like "Made for You", so the plugin navigates the DOM directly. Users can monitor multiple Spotify browse sections, save playlists to the app's saved-playlists store, and play/enqueue scraped tracks through Viboplr's fallback resolution.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Spotify Plugin (index.js)                      │
│                                                 │
│  State ─── Render ─── Actions ─── Scraper       │
│    │          │          │            │          │
│    │     setViewData     │     openBrowseWindow  │
│    │          │          │         eval()        │
│    │          ▼          │            │          │
│    │   PluginViewRenderer│     ┌──────▼───────┐  │
│    │   (toolbar, tabs,   │     │ Spotify Web  │  │
│    │    card-grid, etc.) │     │ (headless or │  │
│    │          │          │     │  visible)    │  │
│    ▼          │          ▼     └──────────────┘  │
│  plugin_storage     api.playlists                │
│  (preferences,      (Save to Playlists)          │
│   sections)                                      │
└─────────────────────────────────────────────────┘
```

### Key Components

- **State** — single `state` object holding all UI and data state; persisted across sessions via `api.storage`
- **Scraper** — opens `open.spotify.com` in a browse window, injects JS scripts to check login, navigate sections, find playlists, scroll and scrape tracks
- **Renderer** — builds plugin view data (toolbar, tabs, card grids, track row lists) and calls `api.ui.setViewData`

## UI Structure

### Toolbar (hoisted, always visible)
- **Title:** "Spotify"
- **Buttons:** "Refresh All" + "Open Browser" (idle/done), "Cancel" (during scrape), "Open Spotify" (first use)
- **Status text:** Live scrape progress during activity, last check time + results when idle, error messages on failure

### Tabs
- One tab per configured section (e.g. "Made for You", "Your Top Mixes") with playlist count badges
- **"+" tab** — shows inline text input to add a new section

### Section Tab Content
- **Per-section toolbar:** "Refresh [section]" + "Remove Section" buttons
- **Playlist card grid** with context menus: Play, Enqueue, View/Edit, Save to Playlists
- Empty state message when no playlists found

### Playlist Detail View
- Back button, Save to Playlists button
- Playlist name, track count, cover image
- Track row list with change indicators (green border = added, strikethrough = removed)

### Settings Panel (`spotify-settings`)
- Auto-refresh interval select (Off / 6h / 12h / 24h / 2 days / weekly)
- Show browser window during refresh toggle
- Debug logging toggle (writes `logs/sync-runs.json` + `logs/page-debug.log`)

## Scraping Flow

### Phase 1: Login Check
1. Open `open.spotify.com` in browse window (visible or headless)
2. Poll every 3s by injecting `SCRIPT_CHECK_LOGIN`
3. Script checks for positive signals (`user-widget-link`, library button, avatar) and negative signals (`login-button`, `signup-button`)
4. If `positive && !negative` → logged in, proceed
5. If still not logged in after a short grace period (~2 polls), the window is surfaced (`handle.show()`), a sign-in banner is injected (`SCRIPT_LOGIN_BANNER`), and a notification is shown. Polling then continues **indefinitely** — when the user logs in, the banner is removed (`SCRIPT_REMOVE_LOGIN_BANNER`), a headless window is re-hidden, and scraping proceeds; if the user closes the window first, the scrape aborts. This applies to both user-initiated Sync and silent auto-refresh.

### Phase 2: Section Discovery
For each section in `sectionsToScrape`:
1. Navigate to Spotify home (`open.spotify.com`)
2. Inject `scriptFindSection(sectionName)` — searches `<a>` tags and headings for matching text (case-insensitive)
3. Click the matching element to navigate to the section page
4. Wait 4s for page render
5. If not found after 10 retries, record as failed section and move on

### Phase 3: Playlist Scraping
1. Inject `SCRIPT_SCRAPE_PLAYLISTS` on the section page
2. Selector: `a[class][draggable="false"][href*="/playlist/"]`
3. For each matching link: extract playlist ID from href, name from text content, image by walking up to 6 parent elements
4. Deduplicate by playlist ID

### Phase 4: Track Scraping
For each discovered playlist:
1. Navigate to `/playlist/{id}`
2. Wait 4s for page load
3. Inject `scriptScrollThenScrape(playlistId, gen)`
4. Auto-scroll to load all tracks (800ms intervals, stop after 3 stable heights or 50 ticks)
5. Scope to `[data-testid="playlist-tracklist"]` or `<main>` to avoid sidebar
6. Parse each `[role="row"]`: extract track name, artist(s), album, duration, image
7. 45s timeout per playlist
8. On empty/error/timeout, the playlist page is reloaded and re-scraped once before giving up.

### Generation Guard
- `scrapeGeneration` counter increments on each new scrape and on cancel
- All async callbacks check `gen !== scrapeGeneration` to abort stale operations

## Data Model

### Plugin Storage Keys

| Key | Shape | Purpose |
|-----|-------|---------|
| `spotify_browse_state` | `{ playlists, playlistTracks, savedAt }` | Current scrape results (legacy KV, migrated to on-disk layout) |
| `spotify_browse_sections` | `string[]` | Configured section names |
| `spotify_browse_preferences` | `{ showBrowserOnRefresh, autoRefreshHours, debugLogging, lastCheckAt, lastCheckResult }` | User preferences + last check info |

### Debug Log Files (written only when "Debug logging" is on)

| File | Contents | Trim |
|------|----------|------|
| `logs/sync-runs.json` | Array of run reports (trigger, timing, per-section/playlist status) | last 20 runs |
| `logs/page-debug.log` | Full HTML + snapshot of each playlist page that failed to parse (after retry) | ~2 MB |

### Playlist Object (scraped)
```
{ id, name, description, imageUrl, uri, section }
```

### Track Object (scraped)
```
{ name, artist, album, duration, imageUrl }
```

## Track Retention

On refresh, if a playlist's fresh scrape returns zero tracks while the previous scrape had
tracks, the old tracks (and cover) are kept. This guards against transient parse failures
wiping a playlist; the tradeoff is that an intentionally-emptied Spotify playlist keeps
showing old tracks until a non-empty scrape succeeds.

Each playlist records `lastSyncedAt` (ISO timestamp) on a successful non-empty scrape,
shown as "synced <date>, <time>" on cards and the playlist detail header. A failed scrape
(empty/error/timeout) is retried once by reloading the page before giving up.

## Image Caching

- Playlist covers: cached as `{pluginCacheDir}/spotify-browse/{playlistId}/cover.jpg`
- Track images: cached as `{pluginCacheDir}/spotify-browse/{playlistId}/{djb2hash}.jpg`
- Orphaned cache directories (playlists no longer in state) are cleaned up on startup
- Images are cached after each scrape via `plugin_cache_image` command

## Auto-Refresh

- Configurable interval: 0 (off), 6, 12, 24, 48, or 168 hours
- Uses `api.scheduler.register("auto-refresh", intervalMs)`
- Silent refresh runs headless (no visible browser), records results
- Badge shows accent dot on changes, error dot on failure

## Actions Reference

### Toolbar Actions
| Action | Trigger | Behavior |
|--------|---------|----------|
| `open-spotify` | First-use button | Full scrape with visible browser |
| `manual-refresh` | Refresh All button | Full scrape (headless unless pref set) |
| `cancel` | Cancel button | Increment generation, close browser |
| `open-browser` | Open Browser button | Open Spotify in visible window |

### Section Actions
| Action | Data | Behavior |
|--------|------|----------|
| `refresh-section` | `{ section }` | Scrape single section, merge results |
| `remove-section-tab` | `{ section }` | Remove section from config and tabs |
| `add-section-tab` | — | Add section from pending input |

### Playlist Actions
| Action | Context | Behavior |
|--------|---------|----------|
| `play-playlist` | Card context menu | Play via `requestAction("play-tracks")` |
| `enqueue-playlist` | Card context menu | Enqueue via `requestAction("enqueue-tracks")` |
| `view-playlist` | Card click/menu | Show playlist detail view |
| `save-playlist` | Detail view button | Save to app playlists via `api.playlists.save` |
| `save-playlist-ctx` | Card context menu | Save to app playlists |

## Injected Scripts

| Script | Purpose | Key Selector |
|--------|---------|-------------|
| `SCRIPT_CHECK_LOGIN` | Detect login state | `[data-testid="user-widget-link"]`, `[data-testid="login-button"]` |
| `scriptFindSection(name)` | Navigate to a section | `<a>` and `<h2>/<h3>/<span>/<p>` text matching |
| `SCRIPT_SCRAPE_PLAYLISTS` | Find playlists on section page | `a[class][draggable="false"][href*="/playlist/"]` |
| `scriptNavigatePlaylist(id)` | Navigate to playlist page | Direct URL assignment |
| `scriptScrollThenScrape(id, gen)` | Scroll + parse tracks | `[role="row"]` inside `[data-testid="playlist-tracklist"]` |
| `SCRIPT_FULL_DUMP` | Full-HTML dump of a failed page | `[data-testid="playlist-tracklist"]` -> `main` -> `body` |
| `SCRIPT_LOGIN_BANNER` | Inject "please sign in" banner when not logged in | fixed-position `<div>` prepended to `<html>` |
| `SCRIPT_REMOVE_LOGIN_BANNER` | Remove the sign-in banner once logged in | by element id |

## Known Limitations

- Spotify OAuth is non-functional; the plugin relies on the user being logged in via the browser session
- DOM selectors may break when Spotify updates their web app
- Headless scraping requires an existing login session (cookies persisted by the browse window)
- Track matching for playback uses title+artist fuzzy matching via fallback resolution, not Spotify track IDs
