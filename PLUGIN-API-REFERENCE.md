# Plugin API Reference

Complete reference of all functions and events available to Vibo plugins via the `api` object, and which plugins use each.

---

## Top-level methods

| API | Description | Used By |
|-----|-------------|---------|
| `log(level, message, section?)` | Write a log message to the backend logger (level: "error" / "warn" / "info") | — |

## `api.library` — Library Operations

| API | Description | Used By |
|-----|-------------|---------|
| `getTracks(opts?)` | Get tracks, filtered by artistId/albumId/tagId with limit/offset | — |
| `ftsTracks(query, opts?)` | Full-text search tracks by title, artist name, album title with limit/offset | — |
| `ftsArtists(query, opts?)` | Full-text search artists by name with limit/offset | — |
| `ftsAlbums(query, opts?)` | Full-text search albums by title and artist name with limit/offset | — |
| `ftsTags(query, opts?)` | Full-text search tags by name with limit/offset | — |
| `getArtists(opts?)` | Get all artists, optionally with limit/offset | — |
| `getAlbums(opts?)` | Get albums, optionally filtered by artistId with limit/offset | — |
| `getTags(opts?)` | Get all tags, optionally with limit/offset | — |
| `getTrackById(id)` | Get a single track by ID | — |
| `getArtistById(id)` | Get a single artist by ID | — |
| `getAlbumById(id)` | Get a single album by ID | — |
| `getTagById(id)` | Get a single tag by ID | — |
| `getHistory(opts?)` | Get recent play history | — |
| `getMostPlayed(opts?)` | Get most played tracks, optionally by last N days | — |
| `recordHistoryPlaysBatch(plays)` | Batch-import play history entries | **lastfm** — imports scrobble history from Last.fm API |
| `applyTags(trackId, tagNames)` | Apply tags to a track | **auto-tagger** — applies discovered/approved tags to matching tracks |
| `onTrackAdded(handler)` | Event: one track added outside a scan or sync (a download, an upgrade, a saved copy) — scans report once via `onScanComplete` | **auto-tagger** — auto-assigns approved tags to newly added tracks |
| `onTrackRemoved(handler)` | Event: track removed from library | — |
| `onScanComplete(handler)` | Event: collection scan finishes | **auto-tagger** — re-runs tag matching on new tracks after a scan |
| `onLikeChanged(handler)` | Event: the user liked, disliked or un-liked a track, artist, album or tag — `{ kind, name, artistName, albumTitle, albumArtistName, liked, previous }`, after the save; not sent for `setTrackLikesBatch` imports | **community** — sends the user's likes to Vibo Community when they switch that on |
| `onLikeChanged(handler)` | Event: the user liked, disliked or un-liked a track, artist, album or tag (`{ kind, name, artistName, albumTitle, albumArtistName, liked, previous }`; not sent for `setTrackLikesBatch` imports) | **community** — sends the user's likes to Vibo Community when they switch that on |

## `api.playback` — Playback Control & Events

| API | Description | Used By |
|-----|-------------|---------|
| `getCurrentTrack()` | Get currently playing track (sync) | — |
| `isPlaying()` | Check if playback is active (sync) | — |
| `getPosition()` | Get playback position in seconds (sync) | — |
| `playTrack(track)` | Play a single PluginTrack | — |
| `playTracks(tracks, startIndex, context)` | Play multiple PluginTracks with optional playlist context (name, coverUrl, source, metadata) | **spotify-browse** — plays playlist from clicked track or start |
| `insertTrack(track, position)` | Insert a PluginTrack into the queue at position (-1 = end) | — |
| `insertTracks(tracks, position)` | Insert multiple PluginTracks into the queue at position (-1 = end) | **spotify-browse** — enqueues playlist tracks |
| `onTrackStarted(handler)` | Event: track starts playing | **lastfm** — sends "now playing" update to Last.fm |
| `onTrackScrobbled(handler)` | Event: scrobble threshold met (50% or 4min) | **lastfm** — scrobbles the track to Last.fm |
| `onTrackLiked(handler)` | Event: track liked/unliked | **lastfm** — syncs love/unlove status with Last.fm |
| `onStreamResolve(providerId, handler)` | Register fallback stream URL resolver by metadata (title, artist, album) | — |
| `onResolveStreamByUri(scheme, handler)` | Register stream URL resolver for a URI scheme (e.g. "spotify", "ytdlp") | — |

## `api.contextMenu` — Context Menu Actions

| API | Description | Used By |
|-----|-------------|---------|
| `onAction(actionId, handler)` | Handle right-click context menu action | — |

## `api.ui` — UI & Notifications

| API | Description | Used By |
|-----|-------------|---------|
| `setViewData(viewId, data)` | Render/update a plugin sidebar view | **lastfm** — settings panel; **lyrics-search** — settings with domain toggles; **spotify-browse** — playlists/tracks/settings views; **auto-tagger** — analyze/approved/settings views; **mock-download** — settings panel |
| `showNotification(message, options?)` | Show a toast for the result of a user action; `options.action` adds one button. Not for ongoing states — see `.claude/rules/plugins.md` "View design guidelines" | **spotify-browse** — archive/delete/save confirmations; **auto-tagger** — "applying tags" confirmation |
| `setViewHeader(viewId, header)` | Set a view's host-drawn header (subtitle, status, buttons, logo/banner); `null` restores the manifest `viewHeader` | — (new; see `.claude/rules/plugins.md` "View header") |
| `navigateToView(viewId)` | Navigate to a plugin sidebar view | — |
| `requestAction(action, payload)` | Request a host-level action (navigate, download, etc.) | **auto-tagger** — refresh-library after applying tags |
| `onAction(actionId, handler)` | Register handler for UI button/toggle/tab events | **lastfm** — connect/disconnect/import/auto-import actions; **lyrics-search** — domain toggles, test search; **spotify-browse** — tab switching, refresh, play, archive, etc.; **auto-tagger** — analyze, approve, settings; **mock-download** — toggle/delay/rate settings |
| `setBadge(viewId, badge)` | Set dot/count badge on sidebar item | **spotify-browse** — dot badge when playlist changes detected |

## `api.storage` — Persistent Key-Value Store

| API | Description | Used By |
|-----|-------------|---------|
| `get(key)` | Retrieve stored value | **lastfm** — session/credentials/cache; **lyrics-search** — enabled domains; **spotify-browse** — playlists/tracks/sections/settings; **auto-tagger** — approved tags/stopwords/settings; **mock-download** — enabled/delay/rates |
| `set(key, value)` | Store value | Same plugins as `get` |
| `delete(key)` | Delete stored value | **lastfm** — clears session on disconnect; **spotify-browse** — clears deleted playlists/sections |
| `cacheFile(subdir, filename, url)` | Download URL to plugin cache dir, return local path | **spotify-browse** — caches playlist covers and track images |
| `getCachePath(subdir, filename)` | Get cached file path or null | — |
| `listCacheDirs()` | List subdirectories in plugin cache root | **spotify-browse** — finds orphaned cache dirs for cleanup |
| `deleteCacheDir(subdir)` | Delete a cache subdirectory | **spotify-browse** — removes orphaned playlist cache dirs |

## `api.network` — HTTP, OAuth & Browser Windows

| API | Description | Used By |
|-----|-------------|---------|
| `fetch(url, init?)` | HTTP request (proxied through Rust) | **All plugins** — every plugin uses this for API calls (Last.fm, Deezer, iTunes, MusicBrainz, Genius, LRCLIB, Lyrics.ovh, AudioDB, Google search, GitHub API) |
| `openUrl(url)` | Open URL in system browser | **lastfm** — opens auth URL |
| `onDeepLink(handler)` | Handle deep link callbacks | **lastfm** — receives OAuth callback after auth |
| `openBrowseWindow(url, opts)` | Open internal browser window with JS eval/messaging | **spotify-browse** — scrapes open.spotify.com via injected JS; **lyrics-search** — Google search for lyrics URLs |

## `api.collections` — Local Collections

| API | Description | Used By |
|-----|-------------|---------|
| `getLocalCollections()` | Get all local collections (id, name, path) | **auto-tagger** — lists collections for analysis scope selection |
| `requestAdd(source)` | Open the app's prefilled Add Server / Add Music Source dialog (user confirms; no permission) | **community** — Servers tab |

## `api.playlists` — Playlist Management

| API | Description | Used By |
|-----|-------------|---------|
| `save(data)` | Save a playlist with tracks | **spotify-browse** — saves scraped Spotify playlists to app library |
| `list()` | List all saved playlists | — |
| `delete(id)` | Delete a playlist | — |
| `getTracks(id)` | Get tracks in a playlist | — |

## `api.cues` — Now Playing Cue Sheets

Keyed by title + artist (accent/case-insensitive), so a sheet follows the song onto any copy. Worker plugins need `cues:read` / `cues:write`.

| API | Description | Used By |
|-----|-------------|---------|
| `get(title, artistName?)` | The stored sheet for a song, or `null` | **community** — "imported / update available" state |
| `list()` | Every stored sheet, newest first | **community** — "My sheets" tab |
| `set(title, artistName, sheet, meta?)` | Validate + store (host normalizer; returns what will play). `meta`: `{ author?, albumName?, durationSecs? }`. Emits `cue-sheet-changed` | **community** — imports a published sheet |
| `delete(title, artistName?)` | Remove; resolves whether one existed | — |

## `api.informationTypes` — Information Type Providers

| API | Description | Used By |
|-----|-------------|---------|
| `onFetch(infoTypeId, handler)` | Register information type fetch handler | **genius** — song_bio, song_meaning, artist_bio, album_wiki, lyrics; **lastfm** — artist_bio, artist_stats, similar_artists, artist_top_tracks, album_wiki, album_track_popularity, track_info, track_tags, similar_tracks; **lrclib** — lyrics; **lyrics-ovh** — lyrics; **lyrics-search** — lyrics |

## `api.imageProviders` — Artist/Album Image Providers

| API | Description | Used By |
|-----|-------------|---------|
| `onFetch("artist", handler)` | Register artist image provider | **audiodb** — TheAudioDB artist images; **deezer** — Deezer artist images; **itunes** — iTunes artist artwork; **musicbrainz** — MusicBrainz/Wikimedia artist images |
| `onFetch("album", handler)` | Register album image provider | **deezer** — Deezer album covers; **itunes** — iTunes album artwork; **musicbrainz** — Cover Art Archive |

## `api.downloads` — Download Providers

| API | Description | Used By |
|-----|-------------|---------|
| `getDownloadFormat()` | Get user's configured download format (flac/aac/mp3) | — |
| `enqueue(request)` | Enqueue a download request (title, uri, provider, etc.) and return its ID | — |
| `onResolveByUri(providerId, handler)` | Resolve download by URI scheme | **mock-download** — resolves `mock://` URIs |
| `onResolveByMetadata(providerId, handler)` | Resolve download by title/artist/album | **mock-download** — matches against mock catalog |
| `onInteractiveSearch(providerId, handler)` | User-facing search for download candidates | **mock-download** — mock catalog search |
| `onInteractiveResolve(providerId, handler)` | Resolve a user-selected search result | **mock-download** — resolves selected mock track |

## `api.scheduler` — Task Scheduling

| API | Description | Used By |
|-----|-------------|---------|
| `register(taskId, intervalMs)` | Register a recurring scheduled task | **spotify-browse** — auto-refresh playlists on configurable interval |
| `unregister(taskId)` | Unregister a scheduled task | **spotify-browse** — stops auto-refresh when disabled |
| `complete(taskId)` | Mark a task execution complete | **spotify-browse** — marks auto-refresh task complete after scrape |
| `onDue(taskId, handler)` | Handler called when scheduled task is due | **spotify-browse** — triggers playlist re-scrape |

## `api.env` — Build-time Environment Variables

| API | Description | Used By |
|-----|-------------|---------|
| `get(key)` | Get an allowlisted build-time env var (returns null if unset) | **lastfm** — reads LASTFM_API_KEY and LASTFM_API_SECRET |

## `api.system` — System Commands

| API | Description | Used By |
|-----|-------------|---------|
| `exec(program, args?, opts?)` | Execute an allowlisted program (yt-dlp, ffmpeg), returns { exitCode, stdout, stderr } | — |
| `readAudioTags(paths)` | Read embedded tags for a batch of local files (one result per path, null when unreadable; no filename fallback) | **qbittorrent** — real title/artist/album for a finished torrent's files |

---

## Summary

- **15 namespaces**, ~73 methods/events
- Heaviest consumers: **lastfm** (scrobbling + 9 info types + OAuth + history import), **spotify-browse** (web scraping + playback + playlists + scheduling + caching)
- Image-only plugins (audiodb, deezer, itunes, musicbrainz) are minimal: just `network.fetch` + `imageProviders.onFetch`
- Lyrics plugins (lrclib, lyrics-ovh, lyrics-search) use `informationTypes.onFetch("lyrics")` + `network.fetch`
- "—" in the "Used By" column means the API is available but no current plugin uses it
