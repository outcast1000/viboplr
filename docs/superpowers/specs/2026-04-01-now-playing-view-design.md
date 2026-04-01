# Now Playing View — Design Spec

## Summary

A full-window "Now Playing" view that replaces all app chrome (sidebar, footer bar, main content) when activated. Two modes: **Audio** (information-dense magazine layout with artist/album metadata) and **Video** (full-view video with overlay controls). Toggled via a dedicated button in the footer bar; exited via close button or Escape key.

## Motivation

Currently the only "now playing" surface is the compact footer bar. There is no way to see rich track context (artist bio, album info, similar tracks, tags) at a glance while listening. The Now Playing view provides an immersive, information-dense experience without leaving the app.

## Audio Mode — Magazine Layout

### Left Side (~60% width)

**Hero area (top):**
- Large album art image (sourced from `useImageCache` album cache)
- Adjacent to art: track title, clickable artist name (accent color), album name + year
- Track tags displayed as pill badges (clickable — exits Now Playing and navigates to tag view)
- Like/dislike buttons

**Up Next (below track info):**
- Compact card showing the next track in queue: small album art thumbnail, track title, artist name
- Data sourced from `useQueue.peekNext()`
- Hidden if queue has no next track

**Similar Tracks (fills remaining left-side space):**
- Scrollable list of similar tracks from Last.fm
- Each row: small thumbnail, track title, artist name
- Clickable to play the similar track (if in library) or search for it

### Right Side (~40% width), vertically scrollable

**Artist Card:**
- Circular artist image (from `useImageCache` artist cache)
- Artist name, listener count, scrobble count
- Bio text (summary from Last.fm artist info)
- Similar artist names as clickable links
- Artist tags as pill badges

**Album Card:**
- Small album art thumbnail (not duplicating the hero — this is a smaller contextual reference)
- Album title, year, track count
- Album description/wiki text from Last.fm
- Album tags as pill badges

### Empty/Loading States

- While Last.fm data is loading: show the section headers with a subtle "Loading..." placeholder text
- If Last.fm is not configured or data fails to load: hide the data-dependent content within each section (bio text, stats, similar artists, tags) but keep the section structure with the image and name
- Similar Tracks section: hidden entirely if no data available
- Artist/Album cards: always shown (image + name from library data), Last.fm metadata is additive

### Bottom Controls Bar (full width)

- Waveform seek bar (using `WaveformSeekBar` component if peaks available, fallback to simple progress bar)
- Elapsed time / total duration
- Previous, Play/Pause, Next, Stop buttons
- Volume slider with mute toggle
- Close button (✕) to exit the Now Playing view
- Scrobble indicator (checkmark near seek bar when scrobbled, matching existing NowPlayingBar behavior)

## Video Mode

When `isVideoTrack(currentTrack)` is true, the Now Playing view switches entirely:

- Video element fills the entire view area
- Controls overlay at bottom with the same UX as existing `FullscreenControls`:
  - Auto-hide after 3 seconds of mouse inactivity when playing
  - Always visible when paused
  - Cursor hides when controls are hidden
  - Gradient background for readability
- Close button (✕) in the overlay controls to exit
- No side panels — full immersion for video content

### FullscreenControls Refactoring

The existing `FullscreenControls` component derives its "active" state from `document.fullscreenElement`, so its auto-hide behavior only works in OS fullscreen. To reuse it in the Now Playing view (which is not OS fullscreen), it needs to accept an `active` prop that controls whether auto-hide is enabled, instead of relying solely on the fullscreen DOM check. When `active={true}`, the component should behave identically to its current fullscreen behavior (auto-hide, cursor management) regardless of whether the browser is in OS fullscreen mode.

The Now Playing video mode reuses the same `FullscreenControls` component with all its existing props. The queue toggle and other extended controls remain available — they are not stripped down for this context.

### Video Element Strategy

The `<video>` element in App.tsx cannot be unmounted and remounted without interrupting playback. The approach:
- Use **CSS repositioning**: when the Now Playing view is active and the current track is video, apply CSS to the existing `.video-container` to make it `position: fixed` and fill the Now Playing view area
- The video element stays in the same place in the React tree — only its CSS positioning changes
- When exiting the Now Playing view, the CSS reverts and the video returns to its normal split-view position
- This avoids any React reconciliation issues or playback interruption

## Entry & Exit

### Entering the View

- **Trigger:** Dedicated button (expand/maximize icon) in the `NowPlayingBar` footer bar
- **Condition:** Only visible/enabled when a track is currently loaded (`currentTrack !== null`)
- **State:** Sets `showNowPlayingView = true` in App.tsx

### Exiting the View

- **Close button:** ✕ in the bottom controls bar (audio) or overlay controls (video)
- **Escape key:** Pressing Escape exits the Now Playing view
- **Navigation:** Clicking artist name, album name, or tag in the view exits Now Playing and navigates to the corresponding library view
- **Playback stops:** If `currentTrack` becomes null (playback fully stopped, not just paused), exit automatically. This respects auto-continue — the view stays open as long as a track is loaded.
- **State:** Sets `showNowPlayingView = false`

### Mutual Exclusivity

- Mini mode and Now Playing view are mutually exclusive. Entering Now Playing while in mini mode should first exit mini mode.
- Entering mini mode while in Now Playing should exit the Now Playing view.

## Component Architecture

### New Files

- `src/components/NowPlayingView.tsx` — Main component with audio/video mode branching

### Modified Files

- `src/App.tsx` — Add `showNowPlayingView` state, render `NowPlayingView` conditionally, add Escape key handler, pass props, lift Last.fm data fetching (see below)
- `src/components/NowPlayingBar.tsx` — Add expand button to enter the view
- `src/components/FullscreenControls.tsx` — Accept `active` prop to decouple from OS fullscreen
- `src/App.css` — Styles for the Now Playing view layout, CSS for video repositioning

### Now Playing Last.fm State (separate from library browser)

The existing `artistBio`, `albumWiki`, and `similarArtists` state in App.tsx are scoped to the library browser selection (`selectedArtist`/`selectedAlbum`), not the currently playing track. The Now Playing view needs its own **separate state** keyed to the current track to avoid clobbering library data:

- `npArtistBio` — `{ summary, listeners, playcount } | null`, fetched for `currentTrack.artist`
- `npAlbumWiki` — `string | null`, fetched for `currentTrack.album`. Note: `parseAlbumInfo` should be expanded to also extract album tags from the Last.fm response.
- `npSimilarArtists` — similar artist list for the current track's artist
- `npSimilarTracks` — similar tracks for the current track (currently local to `TrackPropertiesModal`, needs new state + `listen()` in App.tsx)
- `npTrackTags` — track tags (currently local to `TrackPropertiesModal`, needs new state + `listen()` in App.tsx)
- `npArtistTags` — artist tags (currently local to `TrackPropertiesModal`, needs new state + `listen()` in App.tsx)

All `np*` state is invalidated (set to null) when `currentTrack` changes. Fetches are triggered when the Now Playing view is open and `currentTrack` changes (or on initial view open). The `listen()` calls for `lastfm-similar-tracks`, `lastfm-track-tags`, and `lastfm-artist-tags` events need to be added to App.tsx to populate the `np*` state. The existing `TrackPropertiesModal` should also be updated to consume the shared `np*` state instead of managing its own.

### Props (from App.tsx)

- `currentTrack`, `playing`, `positionSecs`, `durationSecs`, `volume`, `scrobbled` — from `usePlayback`
- `onPause`, `onStop`, `onNext`, `onPrevious`, `onSeek`, `onVolume`, `onMute`, `onToggleLike`, `onToggleDislike` — playback callbacks
- `waveformPeaks` — from `useWaveform`
- `nextTrack` — from `useQueue.peekNext()`
- `queueMode` — from `useQueue`
- `albumImagePath`, `artistImagePath` — from `useImageCache`
- `npArtistBio` — `{ summary, listeners, playcount } | null`, keyed to current track
- `npAlbumWiki` — `string | null`, keyed to current track (expanded to include album tags)
- `npSimilarArtists` — similar artists for current track's artist
- `npSimilarTracks` — similar tracks for current track
- `npTrackTags`, `npArtistTags` — tags for current track and artist
- `onClose` — sets `showNowPlayingView = false`
- `onArtistClick`, `onAlbumClick`, `onTagClick` — navigate and close

### Rendering Logic in App.tsx

When `showNowPlayingView` is true:
- Hide sidebar, main content area, footer bar, queue panel
- Render `NowPlayingView` spanning the full window (except the caption bar, which stays for window drag/close controls)
- For video mode: apply CSS class to `.video-container` that repositions it to fill the Now Playing view area

### Data Fetching on View Open

When the Now Playing view opens, App.tsx should trigger fetches for any missing `np*` Last.fm data for the current track:
- If `npSimilarTracks` is null, invoke `get_similar_tracks`
- If `npArtistBio` is null, invoke `get_artist_info`
- If `npAlbumWiki` is null, invoke `get_album_info`
- If `npTrackTags`/`npArtistTags` are null, invoke `get_track_top_tags`/`get_artist_top_tags`

When `currentTrack` changes while the view is open, all `np*` state is cleared to null and re-fetched for the new track. This ensures the view always shows data for the playing track, not stale data from a previous track.

## Styling

- Follows existing skin system — uses CSS custom properties for all colors
- Background: `--bg-primary` or `--now-playing-bg`
- Cards/panels: `--bg-secondary` with subtle borders
- Accent color for interactive elements: `--accent`
- Right panel scroll: thin custom scrollbar matching app theme
- Responsive to window size: album art scales, right panel collapses below if window is narrow (future enhancement, not in scope for v1)

## Out of Scope

- No OS fullscreen support from the Now Playing view (existing video double-click fullscreen remains separate)
- No full queue display (just "Up Next" for the single next track)
- No lyrics panel
- No responsive/narrow-window layout (v1 assumes reasonable desktop window size)
- No animation/transition when entering/exiting the view (can be added later)
- No keyboard shortcut to open the Now Playing view (can be added later; Escape to close is sufficient for v1)
