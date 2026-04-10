# Spotify Personalized Feed Design

## Problem

The Spotify plugin's `/me/playlists` endpoint only returns playlists the user owns or has explicitly followed. Spotify's algorithmic playlists (Discover Weekly, Daily Mix 1-6, Release Radar, etc.) are generated server-side and pushed to clients via internal APIs not part of the official Web API. Additionally, the current implementation only fetches 50 playlists without pagination, so users with large libraries may be missing playlists.

## Solution

Use Spotify's undocumented `/v1/views/desktop-home` endpoint (same OAuth token, no new scopes) to fetch the full personalized home feed, while keeping the official `/me/playlists` endpoint as a guaranteed fallback. Fix playlist pagination to fetch all playlists.

## Changes to `src-tauri/plugins/spotify-browse/index.js`

### New State Fields

```js
homeSections: [],         // Array of { title, items[] } from personalized feed
allPlaylistsLoaded: false // Whether playlist pagination completed
```

### New Function: `fetchHomeFeed()`

Calls the undocumented Spotify home feed endpoint:

```
GET https://api.spotify.com/v1/views/desktop-home
  ?content_limit=10&locale=en&platform=web
  &types=album,playlist,artist&limit=20&offset=0
```

Uses the existing OAuth bearer token. Parses the response into normalized sections:

```js
{ title: "Made For You", items: [{ id, name, description, imageUrl, type, uri }] }
```

Filters to keep only playlist/album/artist items (ignores podcasts, shows, episodes). On failure, returns an empty array silently — no error shown to the user.

### Modified Function: `loadHome()`

Runs two parallel fetch chains:

1. **Home feed** via `fetchHomeFeed()` (undocumented, best-effort)
2. **All playlists** via paginated `/me/playlists?limit=50&offset=N` calls (official, reliable)
3. **Liked songs count** via `/me/tracks?limit=1` (official, already exists)

Both chains resolve independently. The home screen renders as soon as both complete.

### Playlist Pagination

Replace the single `/me/playlists?limit=50` call with a loop that accumulates all playlists:

```
offset=0: GET /me/playlists?limit=50&offset=0  → append items, check total
offset=50: GET /me/playlists?limit=50&offset=50 → append items, check total
... until offset >= total
```

### Redesigned Home Screen Layout

```
[Username's Library]
[Search bar]

--- Personalized sections (from home feed, if available) ---
[Section: "Made For You" — card grid of playlists]
[Section: "Recently Played" — card grid]
[Section: "Jump Back In" — card grid]
[Section: "Your Top Mixes" — card grid]
... (all sections returned by the endpoint)

--- Official API data (always present) ---
[Liked Songs — card with track count]
[Your Playlists — card grid, all playlists paginated]

[Refresh | Disconnect]
```

Each personalized section is rendered with a heading and a `card-grid` component. If the personalized feed fails, these sections are omitted and the user sees the familiar playlists + liked songs layout.

### Navigation from Personalized Items

- **Playlist items**: Extract playlist ID from URI, reuse existing `loadPlaylistTracks()` flow
- **Album/artist items**: Open in Spotify via `api.network.openUrl()` (deep link or web URL)

The "Back" button from a playlist view returns to home as it does today.

### Error Handling

| Scenario | Behavior |
|----------|----------|
| Home feed returns 403/404/5xx | Silent fallback — no personalized sections shown |
| Home feed response has unexpected structure | Log warning, skip all personalized sections |
| Individual section has unexpected items | Skip that section, render others |
| Official API `/me/playlists` fails | Show error as today |
| Token expired mid-fetch | Existing `refreshAccessToken()` handles retry |

### What This Does NOT Do

- No web scraping or credential storage
- No new OAuth scopes or re-authentication flow
- No caching of the home feed (changes frequently)
- No deep in-app browsing of albums/artists from the feed
- No use of `/recommendations` endpoint (home feed already includes algorithmic content)

### OAuth Scopes

No changes. The existing `user-library-read playlist-read-private` scopes are sufficient. The undocumented endpoint works with any valid access token.
