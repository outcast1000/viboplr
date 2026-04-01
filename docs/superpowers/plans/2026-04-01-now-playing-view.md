# Now Playing View Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full-window "Now Playing" view with an information-dense audio layout and immersive video mode.

**Architecture:** New `NowPlayingView.tsx` component rendered conditionally in App.tsx when `showNowPlayingView` is true. Audio mode uses a two-column magazine layout (album art + info left, scrollable artist/album cards right). Video mode uses CSS repositioning of the existing `<video>` element with refactored `FullscreenControls`. Separate `np*` Last.fm state in App.tsx keyed to the current playing track.

**Tech Stack:** React, TypeScript, Tauri IPC (`invoke`/`listen`), CSS custom properties (skin system)

**Spec:** `docs/superpowers/specs/2026-04-01-now-playing-view-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/components/NowPlayingView.tsx` | Main Now Playing view — audio/video mode branching, magazine layout, controls bar |
| Modify | `src/components/FullscreenControls.tsx` | Accept `active` prop to decouple auto-hide from OS fullscreen |
| Modify | `src/components/NowPlayingBar.tsx` | Add expand button to enter the Now Playing view |
| Modify | `src/App.tsx` | `showNowPlayingView` state, `np*` Last.fm state, conditional rendering, Escape handler, data fetching, mutual exclusivity |
| Modify | `src/App.css` | Now Playing view styles, video-container repositioning in now-playing mode |

---

### Task 1: Refactor FullscreenControls to Accept `active` Prop

**Files:**
- Modify: `src/components/FullscreenControls.tsx:9-42` (props interface), `:59` (state), `:65-76` (fullscreenchange effect), `:88-96` (auto-hide effect), `:124-130` (cursor effect)

This is a backward-compatible change. The existing OS fullscreen behavior continues to work — the `active` prop is an additional way to enable the auto-hide behavior.

- [ ] **Step 1: Add `active` prop to the interface**

In `src/components/FullscreenControls.tsx`, add to the props interface at line ~42 (before closing brace):

```typescript
  /** When true, enables auto-hide behavior without requiring OS fullscreen */
  active?: boolean;
```

- [ ] **Step 2: Derive effective active state from both sources**

Replace the `isFullscreen` state usage. At line ~59, after the existing state:

```typescript
const [isFullscreen, setIsFullscreen] = useState(false);
```

Add a derived value below it:

```typescript
const isActive = active || isFullscreen;
```

- [ ] **Step 3: Replace `isFullscreen` checks with `isActive`**

In three useEffect hooks, replace the guard checks:

**Auto-hide effect (line ~89):** Change `if (!isFullscreen) return;` to `if (!isActive) return;`
Update the dependency array from `[playing, isFullscreen, resetTimer]` to `[playing, isActive, resetTimer]`.

**Cursor effect (line ~125):** Change `if (!isFullscreen) return;` to `if (!isActive) return;`
Update the dependency array from `[isFullscreen, visible]` to `[isActive, visible]`.

The fullscreenchange listener effect (line ~65) stays unchanged — it still sets `isFullscreen` from the DOM. The `isActive` derivation combines both.

- [ ] **Step 4: Show controls when `active` and not in OS fullscreen**

Currently `.fs-controls` has `display: none` and only `display: block` under `.video-container:fullscreen .fs-controls`. The `active` prop means we also need to show controls outside of OS fullscreen. This will be handled by the CSS in Task 7 (adding a `.np-video-active .fs-controls { display: block; }` rule). No change needed in the component itself for this.

- [ ] **Step 5: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors (the prop is optional, so all existing call sites remain valid)

- [ ] **Step 6: Commit**

```bash
git add src/components/FullscreenControls.tsx
git commit -m "refactor: add active prop to FullscreenControls for non-fullscreen auto-hide"
```

---

### Task 2: Add `np*` Last.fm State and Fetching to App.tsx

**Files:**
- Modify: `src/App.tsx:307-309` (near existing Last.fm state), `:844-872` (near existing listeners), `:862-866` (`parseAlbumInfo`)

Adds separate Now Playing Last.fm state keyed to the current track, plus event listeners and fetch-on-demand logic.

- [ ] **Step 1: Add `np*` state variables**

In `src/App.tsx`, after the existing `similarArtists` state (line ~309), add:

```typescript
// Now Playing view: Last.fm data keyed to current playing track
const [npArtistBio, setNpArtistBio] = useState<{ summary: string; listeners: string; playcount: string } | null>(null);
const [npAlbumWiki, setNpAlbumWiki] = useState<string | null>(null);
const [npAlbumTags, setNpAlbumTags] = useState<Array<{ name: string }>>([]);
const [npSimilarArtists, setNpSimilarArtists] = useState<Array<{ name: string; match: string }>>([]);
const [npSimilarTracks, setNpSimilarTracks] = useState<Array<{ name: string; artist: { name: string }; match?: string }>>([]);
const [npTrackTags, setNpTrackTags] = useState<Array<{ name: string; count?: number }>>([]);
const [npArtistTags, setNpArtistTags] = useState<Array<{ name: string; count?: number }>>([]);
const [showNowPlayingView, setShowNowPlayingView] = useState(false);
```

- [ ] **Step 2: Add `npTrackRef` for event verification**

Add a ref to track the current playing track for use in event listener closures:

```typescript
const npTrackRef = useRef<Track | null>(null);

useEffect(() => {
  npTrackRef.current = playback.currentTrack ?? null;
}, [playback.currentTrack]);
```

- [ ] **Step 3: Add `np*` data fetch function**

Add a function in App.tsx (near the existing Last.fm fetch logic) that triggers fetches for the Now Playing view:

```typescript
const fetchNpLastfmData = useCallback((track: Track) => {
  if (track.artist_name) {
    invoke("lastfm_get_similar_tracks", { artistName: track.artist_name, trackTitle: track.title });
    invoke("lastfm_get_artist_info", { artistName: track.artist_name });
    invoke("lastfm_get_track_tags", { artistName: track.artist_name, trackTitle: track.title });
    invoke("lastfm_get_artist_tags", { artistName: track.artist_name });
  }
  if (track.album_title && track.artist_name) {
    invoke("lastfm_get_album_info", { artistName: track.artist_name, albumTitle: track.album_title });
  }
}, []);
```

- [ ] **Step 4: Add effect to clear and re-fetch `np*` state on track change**

```typescript
useEffect(() => {
  // Clear np* state when track changes
  setNpArtistBio(null);
  setNpAlbumWiki(null);
  setNpAlbumTags([]);
  setNpSimilarArtists([]);
  setNpSimilarTracks([]);
  setNpTrackTags([]);
  setNpArtistTags([]);

  // Fetch new data if Now Playing view is open
  if (showNowPlayingView && playback.currentTrack) {
    fetchNpLastfmData(playback.currentTrack);
  }
}, [playback.currentTrack?.id]);
```

- [ ] **Step 5: Add ALL dedicated `np*` event listeners in a standalone useEffect**

Do **NOT** piggyback on the existing `lastfm-artist-info`/`lastfm-album-info` listeners — those are scoped to the library browser's `selectedArtist`/`selectedAlbum` and would cause data collisions. Do **NOT** place these inside any library-scoped useEffect.

Add a **standalone** `useEffect` (run once, clean up on unmount) that sets up ALL np* event listeners with verification that the incoming data matches the currently playing track via `npTrackRef`:

```typescript
useEffect(() => {
  const unlistenArtistInfo = listen<any>("lastfm-artist-info", (event) => {
    const artist = event.payload?.artist;
    const currentArtist = npTrackRef.current?.artist_name;
    if (!artist || !currentArtist) return;
    if (artist.name?.toLowerCase() !== currentArtist.toLowerCase()) return;
    const bio = artist.bio?.summary?.replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/, "").trim();
    if (bio) {
      setNpArtistBio({
        summary: bio,
        listeners: artist.stats?.listeners ?? "",
        playcount: artist.stats?.playcount ?? "",
      });
    }
    if (Array.isArray(artist.similar?.artist)) {
      setNpSimilarArtists(artist.similar.artist);
    }
  });

  const unlistenAlbumInfo = listen<any>("lastfm-album-info", (event) => {
    const album = event.payload?.album;
    const currentAlbum = npTrackRef.current?.album_title;
    if (!album || !currentAlbum) return;
    if (album.name?.toLowerCase() !== currentAlbum.toLowerCase()) return;
    const wiki = album.wiki?.summary?.replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?/, "").trim();
    if (wiki) setNpAlbumWiki(wiki);
    if (Array.isArray(album.tags?.tag)) setNpAlbumTags(album.tags.tag);
  });

  const unlistenSimilarTracks = listen<any>("lastfm-similar-tracks", (event) => {
    const currentTrack = npTrackRef.current;
    if (!currentTrack) return;
    const tracks = event.payload?.similartracks?.track;
    if (Array.isArray(tracks)) setNpSimilarTracks(tracks);
  });

  const unlistenTrackTags = listen<any>("lastfm-track-tags", (event) => {
    const currentTrack = npTrackRef.current;
    if (!currentTrack) return;
    const tags = event.payload?.toptags?.tag;
    if (Array.isArray(tags)) setNpTrackTags(tags);
  });

  const unlistenArtistTags = listen<any>("lastfm-artist-tags", (event) => {
    const currentArtist = npTrackRef.current?.artist_name;
    if (!currentArtist) return;
    const tags = event.payload?.toptags?.tag;
    if (Array.isArray(tags)) setNpArtistTags(tags);
  });

  return () => {
    unlistenArtistInfo.then((f) => f());
    unlistenAlbumInfo.then((f) => f());
    unlistenSimilarTracks.then((f) => f());
    unlistenTrackTags.then((f) => f());
    unlistenArtistTags.then((f) => f());
  };
}, []);
```

This ensures:
- All np* listeners live in one place (not scattered across library-scoped effects)
- Data collision is prevented — events from library browsing won't overwrite np* state
- `TrackPropertiesModal` can independently listen to the same events for its own local state

- [ ] **Step 6: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add np* Last.fm state for Now Playing view data"
```

---

### Task 3: Create NowPlayingView Component (Audio Mode)

**Files:**
- Create: `src/components/NowPlayingView.tsx`

The main component. This task covers the audio mode magazine layout only — video mode is Task 5.

- [ ] **Step 1: Create NowPlayingView.tsx with props interface and shell**

```typescript
import { Track } from "../types";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { convertFileSrc } from "@tauri-apps/api/core";

interface NowPlayingViewProps {
  currentTrack: Track;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  scrobbled: boolean;
  waveformPeaks: number[] | null;
  nextTrack: Track | null;
  albumImagePath: string | null;
  artistImagePath: string | null;
  npArtistBio: { summary: string; listeners: string; playcount: string } | null;
  npAlbumWiki: string | null;
  npAlbumTags: Array<{ name: string }>;
  npSimilarArtists: Array<{ name: string; match: string }>;
  npSimilarTracks: Array<{ name: string; artist: { name: string }; match?: string }>;
  npTrackTags: Array<{ name: string; count?: number }>;
  npArtistTags: Array<{ name: string; count?: number }>;
  libraryTags: Array<{ id: number; name: string }>;
  isVideo: boolean;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  onClose: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onTagClick: (tagId: number) => void;  // Resolved from name via libraryTags lookup
}

function formatTime(secs: number): string {
  if (!secs || !isFinite(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function NowPlayingView(props: NowPlayingViewProps) {
  const { currentTrack, isVideo } = props;

  if (isVideo) {
    // Video mode — Task 5
    return <div className="np-view np-video" />;
  }

  return <NowPlayingAudio {...props} />;
}
```

- [ ] **Step 2: Implement NowPlayingAudio — left side hero area**

Add the `NowPlayingAudio` function component in the same file:

```typescript
function NowPlayingAudio(props: NowPlayingViewProps) {
  const {
    currentTrack, playing, positionSecs, durationSecs, volume, scrobbled,
    waveformPeaks, nextTrack, albumImagePath, artistImagePath,
    npArtistBio, npAlbumWiki, npAlbumTags, npSimilarArtists, npSimilarTracks,
    npTrackTags, npArtistTags, libraryTags,
    onPause, onStop, onNext, onPrevious, onSeek, onVolume, onMute,
    onToggleLike, onToggleDislike, onClose,
    onArtistClick, onAlbumClick, onTagClick,
  } = props;

  // Lookup tag ID from name for navigation
  const handleTagClick = (tagName: string) => {
    const tag = libraryTags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());
    if (tag) onTagClick(tag.id);
  };

  const albumSrc = albumImagePath ? convertFileSrc(albumImagePath) : null;
  const artistSrc = artistImagePath ? convertFileSrc(artistImagePath) : null;

  // Seek bar click handler
  const handleSeekClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(ratio * durationSecs);
  };

  return (
    <div className="np-view np-audio">
      <div className="np-body">
        {/* Left side */}
        <div className="np-left">
          <div className="np-hero">
            <div className="np-hero-art">
              {albumSrc ? <img src={albumSrc} alt="" /> : <div className="np-art-placeholder">{"\u266B"}</div>}
            </div>
            <div className="np-hero-info">
              <div className="np-track-title">{currentTrack.title}</div>
              {currentTrack.artist_id && (
                <div className="np-artist-name" onClick={() => onArtistClick(currentTrack.artist_id!)}>
                  {currentTrack.artist_name}
                </div>
              )}
              <div className="np-album-name">
                {currentTrack.album_id ? (
                  <span onClick={() => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id)}>
                    {currentTrack.album_title}
                  </span>
                ) : currentTrack.album_title}
                {currentTrack.year ? ` \u00B7 ${currentTrack.year}` : ""}
              </div>

              {/* Track tags */}
              {npTrackTags.length > 0 && (
                <div className="np-tags">
                  {npTrackTags.slice(0, 8).map((tag) => (
                    <span key={tag.name} className="np-tag" onClick={() => handleTagClick(tag.name)}>
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Like / Dislike */}
              <div className="np-like-buttons">
                <button
                  className={`np-like-btn ${currentTrack.liked === 1 ? "liked" : ""}`}
                  onClick={onToggleLike}
                  title="Like"
                >{"\u2665"}</button>
                {onToggleDislike && (
                  <button
                    className={`np-like-btn ${currentTrack.liked === -1 ? "disliked" : ""}`}
                    onClick={onToggleDislike}
                    title="Dislike"
                  >{"\uD83D\uDC4E"}</button>
                )}
              </div>

              {/* Up Next */}
              {nextTrack && (
                <div className="np-up-next">
                  <span className="np-up-next-label">Up Next</span>
                  <div className="np-up-next-track">
                    <span className="np-up-next-title">{nextTrack.title}</span>
                    <span className="np-up-next-artist">{nextTrack.artist_name}</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Similar tracks */}
          {npSimilarTracks.length > 0 && (
            <div className="np-similar">
              <div className="np-section-title">Similar Tracks</div>
              <div className="np-similar-list">
                {npSimilarTracks.slice(0, 10).map((st, i) => (
                  <div key={i} className="np-similar-row">
                    <span className="np-similar-name">{st.name}</span>
                    <span className="np-similar-artist">{st.artist.name}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right side — scrollable */}
        <div className="np-right">
          {/* Artist card */}
          <div className="np-card">
            <div className="np-card-header">Artist</div>
            <div className="np-card-top">
              <div className="np-artist-img">
                {artistSrc ? <img src={artistSrc} alt="" /> : <div className="np-img-placeholder">{"\u266B"}</div>}
              </div>
              <div className="np-card-top-info">
                <div className="np-card-name">{currentTrack.artist_name}</div>
                {npArtistBio && (
                  <div className="np-card-stats">
                    {npArtistBio.listeners && <span>{Number(npArtistBio.listeners).toLocaleString()} listeners</span>}
                    {npArtistBio.playcount && <span> · {Number(npArtistBio.playcount).toLocaleString()} scrobbles</span>}
                  </div>
                )}
              </div>
            </div>
            {npArtistBio?.summary && (
              <div className="np-card-bio" dangerouslySetInnerHTML={{ __html: npArtistBio.summary }} />
            )}
            {npSimilarArtists.length > 0 && (
              <div className="np-card-similar">
                <span className="np-card-similar-label">Similar: </span>
                {npSimilarArtists.slice(0, 5).map((a, i) => (
                  <span key={a.name}>
                    {i > 0 && ", "}
                    <span className="np-card-link">{a.name}</span>
                  </span>
                ))}
              </div>
            )}
            {npArtistTags.length > 0 && (
              <div className="np-tags np-card-tags">
                {npArtistTags.slice(0, 6).map((tag) => (
                  <span key={tag.name} className="np-tag-dim">{tag.name}</span>
                ))}
              </div>
            )}
          </div>

          {/* Album card */}
          <div className="np-card">
            <div className="np-card-header">Album</div>
            <div className="np-card-top">
              <div className="np-album-img">
                {albumSrc ? <img src={albumSrc} alt="" /> : <div className="np-img-placeholder">{"\u266B"}</div>}
              </div>
              <div className="np-card-top-info">
                <div className="np-card-name">{currentTrack.album_title || "Unknown Album"}</div>
                <div className="np-card-stats">
                  {currentTrack.year && <span>{currentTrack.year}</span>}
                </div>
              </div>
            </div>
            {npAlbumWiki && (
              <div className="np-card-bio" dangerouslySetInnerHTML={{ __html: npAlbumWiki }} />
            )}
            {npAlbumTags.length > 0 && (
              <div className="np-tags np-card-tags">
                {npAlbumTags.slice(0, 6).map((tag) => (
                  <span key={tag.name} className="np-tag-dim">{tag.name}</span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Bottom controls bar */}
      <div className="np-controls">
        <div className="np-seek" onClick={handleSeekClick}>
          {waveformPeaks ? (
            <WaveformSeekBar
              peaks={waveformPeaks}
              progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
              accentColor="rgba(var(--accent-rgb), 0.7)"
              dimColor="rgba(255, 255, 255, 0.15)"
            />
          ) : (
            <div className="np-seek-simple">
              <div className="np-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
            </div>
          )}
        </div>
        <div className="np-controls-row">
          <span className="np-time">{formatTime(positionSecs)}</span>
          {scrobbled && <span className="np-scrobbled" title="Scrobbled">{"\u2713"}</span>}
          <span className="np-time np-time-total">{formatTime(durationSecs)}</span>
          <div className="np-buttons">
            <button className="ctrl-btn" onClick={onPrevious}>{"\u23EE"}</button>
            <button className="ctrl-btn play-btn" onClick={onPause}>
              {playing ? "\u23F8" : "\u25B6"}
            </button>
            <button className="ctrl-btn" onClick={onNext}>{"\u23ED"}</button>
            <button className="ctrl-btn" onClick={onStop}>{"\u23F9"}</button>
          </div>
          <div className="np-volume">
            <button className="ctrl-btn" onClick={onMute}>{volume === 0 ? "\uD83D\uDD07" : "\uD83D\uDD0A"}</button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
              className="np-volume-slider"
            />
          </div>
          <button className="ctrl-btn np-close-btn" onClick={onClose} title="Close Now Playing">{"\u2715"}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors (component is created but not yet rendered anywhere)

- [ ] **Step 4: Commit**

```bash
git add src/components/NowPlayingView.tsx
git commit -m "feat: create NowPlayingView component with audio magazine layout"
```

---

### Task 4: Add Now Playing View CSS Styles

**Files:**
- Modify: `src/App.css` (append at end, near existing `.fs-controls` rules around line ~2014)

- [ ] **Step 1: Add Now Playing view layout styles**

Append to `src/App.css`:

```css
/* ===== Now Playing View ===== */

.np-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-primary);
  grid-column: 1 / -1;
  grid-row: 2 / 4;
}

.np-body {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Left side */
.np-left {
  display: flex;
  flex-direction: column;
  padding: 20px;
  gap: 16px;
  overflow-y: auto;
}

.np-hero {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}

.np-hero-art {
  width: 200px;
  height: 200px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}

.np-hero-art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.np-art-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 48px;
  background: var(--bg-secondary);
  color: var(--text-tertiary);
}

.np-hero-info {
  min-width: 0;
  padding-top: 4px;
}

.np-track-title {
  font-size: var(--fs-xl);
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.np-artist-name {
  font-size: var(--fs-md);
  color: var(--accent);
  cursor: pointer;
  margin-top: 3px;
}

.np-artist-name:hover {
  text-decoration: underline;
}

.np-album-name {
  font-size: var(--fs-sm);
  color: var(--text-tertiary);
  margin-top: 1px;
}

.np-album-name span {
  cursor: pointer;
}

.np-album-name span:hover {
  color: var(--accent);
}

.np-tags {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.np-tag {
  background: rgba(var(--accent-rgb), 0.15);
  color: var(--accent);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: var(--fs-2xs);
  cursor: pointer;
}

.np-tag:hover {
  background: rgba(var(--accent-rgb), 0.3);
}

.np-tag-dim {
  background: rgba(255, 255, 255, 0.06);
  color: var(--text-secondary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: var(--fs-2xs);
}

.np-like-buttons {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

.np-like-btn {
  background: none;
  border: none;
  font-size: var(--fs-md);
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 2px;
}

.np-like-btn.liked {
  color: #e55;
}

.np-like-btn.disliked {
  color: var(--accent);
}

/* Up Next */
.np-up-next {
  margin-top: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.np-up-next-label {
  font-size: var(--fs-2xs);
  text-transform: uppercase;
  color: var(--text-tertiary);
  white-space: nowrap;
}

.np-up-next-track {
  min-width: 0;
}

.np-up-next-title {
  font-size: var(--fs-xs);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: block;
}

.np-up-next-artist {
  font-size: var(--fs-2xs);
  color: var(--text-tertiary);
}

/* Similar tracks */
.np-similar {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 10px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.np-section-title {
  font-size: var(--fs-2xs);
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 6px;
}

.np-similar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.np-similar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
}

.np-similar-row:hover {
  background: rgba(255, 255, 255, 0.05);
}

.np-similar-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--fs-xs);
  color: var(--text-primary);
}

.np-similar-artist {
  font-size: var(--fs-2xs);
  color: var(--text-tertiary);
  flex-shrink: 0;
}

/* Right side — scrollable */
.np-right {
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.np-card {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 14px;
}

.np-card-header {
  font-size: var(--fs-2xs);
  text-transform: uppercase;
  color: var(--text-tertiary);
  margin-bottom: 10px;
}

.np-card-top {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 10px;
}

.np-artist-img {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}

.np-artist-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.np-album-img {
  width: 72px;
  height: 72px;
  border-radius: 6px;
  overflow: hidden;
  flex-shrink: 0;
}

.np-album-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.np-img-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-tertiary);
}

.np-card-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-primary);
}

.np-card-stats {
  font-size: var(--fs-2xs);
  color: var(--text-tertiary);
  margin-top: 2px;
}

.np-card-bio {
  font-size: var(--fs-xs);
  color: var(--text-secondary);
  line-height: 1.5;
}

.np-card-bio a {
  color: var(--accent);
}

.np-card-similar {
  font-size: var(--fs-2xs);
  color: var(--text-tertiary);
  margin-top: 10px;
}

.np-card-similar-label {
  text-transform: uppercase;
  margin-right: 4px;
}

.np-card-link {
  color: var(--accent);
  cursor: pointer;
}

.np-card-link:hover {
  text-decoration: underline;
}

.np-card-tags {
  margin-top: 8px;
}

/* Bottom controls */
.np-controls {
  background: var(--now-playing-bg, var(--bg-secondary));
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  padding: 0;
}

.np-seek {
  height: 24px;
  padding: 8px 20px 0;
  cursor: pointer;
}

.np-seek-simple {
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  position: relative;
}

.np-seek-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
}

.np-controls-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 20px 10px;
}

.np-time {
  font-size: var(--fs-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
}

.np-time-total {
  text-align: right;
}

.np-scrobbled {
  color: var(--accent);
  font-size: var(--fs-xs);
}

.np-buttons {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-left: 8px;
}

.np-volume {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.np-volume-slider {
  width: 80px;
  accent-color: var(--accent);
}

.np-close-btn {
  margin-left: 8px;
  font-size: var(--fs-sm) !important;
  opacity: 0.6;
}

.np-close-btn:hover {
  opacity: 1;
}

/* Video mode in Now Playing */
.np-video {
  position: relative;
}

.app.now-playing-active .video-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  height: 100% !important;
  z-index: 5;
}

.app.now-playing-active .video-container .fs-controls {
  display: block;
}

/* Hide elements when Now Playing is active */
.app.now-playing-active .sidebar,
.app.now-playing-active .main,
.app.now-playing-active .now-playing,
.app.now-playing-active .queue-panel,
.app.now-playing-active .status-bar {
  display: none;
}
```

- [ ] **Step 2: Verify the CSS doesn't break existing styles**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors (CSS-only change)

- [ ] **Step 3: Commit**

```bash
git add src/App.css
git commit -m "feat: add Now Playing view CSS styles"
```

---

### Task 5: Add Video Mode to NowPlayingView

**Files:**
- Modify: `src/components/NowPlayingView.tsx` (the video mode placeholder from Task 3)

Video mode is simple: the component just renders a container div. The actual video stays in its existing DOM position — CSS (from Task 4) repositions `.video-container` to fill the Now Playing view when `.app.now-playing-active` is set. The `FullscreenControls` (already in the DOM, overlaying the video container) handles all controls.

- [ ] **Step 1: Update the video mode branch**

In `NowPlayingView.tsx`, replace the video placeholder:

```typescript
if (isVideo) {
  return (
    <div className="np-view np-video">
      {/* Video container is CSS-repositioned from its existing DOM location */}
      {/* FullscreenControls overlay handles all controls */}
    </div>
  );
}
```

- [ ] **Step 2: Add `onClose` button to FullscreenControls**

In `src/components/FullscreenControls.tsx`, add `onCloseNowPlaying?: () => void;` to the props interface. In the controls row, add a close button when the prop is provided:

Find the exit fullscreen button in the component (search for `onToggleFullscreen` in the JSX). Near it, add:

```typescript
{onCloseNowPlaying && (
  <button className="fs-ctrl-btn" onClick={onCloseNowPlaying} title="Close Now Playing">
    {"\u2715"}
  </button>
)}
```

- [ ] **Step 3: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/components/NowPlayingView.tsx src/components/FullscreenControls.tsx
git commit -m "feat: add video mode to NowPlayingView with close button in FullscreenControls"
```

---

### Task 6: Wire Everything in App.tsx

**Files:**
- Modify: `src/App.tsx:1769` (app class), `:900-1053` (keydown handler), `:3057-3131` (video container), `:3299-3345` (NowPlayingBar render), and the main content area rendering

This is the integration task — rendering `NowPlayingView` conditionally, passing all props, handling Escape, and enforcing mutual exclusivity with mini mode.

- [ ] **Step 1: Import NowPlayingView**

Add import at the top of `src/App.tsx`:

```typescript
import NowPlayingView from "./components/NowPlayingView";
```

- [ ] **Step 2: Add `now-playing-active` class to the app div**

At line ~1769, modify the className string to include the now-playing class when active:

Add `${showNowPlayingView ? "now-playing-active" : ""}` to the existing className template literal.

- [ ] **Step 3: Add Escape key handler (with ref to avoid stale closure)**

The `handleKeyDown` function is inside a `useEffect` with an empty dependency array (lines ~900-1053), so `showNowPlayingView` would be stale. Use a ref:

Add near the other refs in App.tsx:

```typescript
const showNowPlayingViewRef = useRef(false);
```

Add a sync effect:

```typescript
useEffect(() => { showNowPlayingViewRef.current = showNowPlayingView; }, [showNowPlayingView]);
```

Then in the existing `handleKeyDown` function (line ~901), add near the top (before other key checks):

```typescript
if (e.key === "Escape" && showNowPlayingViewRef.current) {
  setShowNowPlayingView(false);
  return;
}
```

- [ ] **Step 4: Add auto-exit when currentTrack becomes null**

Add a useEffect:

```typescript
useEffect(() => {
  if (!playback.currentTrack && showNowPlayingView) {
    setShowNowPlayingView(false);
  }
}, [playback.currentTrack]);
```

- [ ] **Step 5: Add mutual exclusivity with mini mode**

Add a useEffect:

```typescript
useEffect(() => {
  if (mini.miniMode && showNowPlayingView) {
    setShowNowPlayingView(false);
  }
}, [mini.miniMode]);
```

When opening Now Playing view, exit mini mode first. In the handler that opens the view (passed to NowPlayingBar), add:

```typescript
const openNowPlaying = () => {
  if (mini.miniMode) mini.toggleMiniMode();
  setShowNowPlayingView(true);
  if (playback.currentTrack) fetchNpLastfmData(playback.currentTrack);
};
```

- [ ] **Step 6: Render NowPlayingView conditionally**

Render `NowPlayingView` as a **direct child** of the `.app` div (not nested inside `<main>` or `<Sidebar>`). Place it after the caption bar and before `<Sidebar>`. It uses CSS grid placement (`grid-column: 1 / -1; grid-row: 2 / 4`) to span the full content area. The `.main` element is hidden via CSS when Now Playing is active. When `showNowPlayingView` is true and `currentTrack` exists:

```typescript
{showNowPlayingView && playback.currentTrack && (
  <NowPlayingView
    currentTrack={playback.currentTrack}
    playing={playback.playing}
    positionSecs={playback.positionSecs}
    durationSecs={playback.durationSecs}
    volume={playback.volume}
    scrobbled={playback.scrobbled}
    waveformPeaks={waveformPeaks}
    nextTrack={queueHook.peekNext()}
    albumImagePath={
      (playback.currentTrack.album_id && albumImageCache.images[playback.currentTrack.album_id]) || null
    }
    artistImagePath={
      (playback.currentTrack.artist_id && artistImageCache.images[playback.currentTrack.artist_id]) || null
    }
    npArtistBio={npArtistBio}
    npAlbumWiki={npAlbumWiki}
    npAlbumTags={npAlbumTags}
    npSimilarArtists={npSimilarArtists}
    npSimilarTracks={npSimilarTracks}
    npTrackTags={npTrackTags}
    npArtistTags={npArtistTags}
    isVideo={isVideoTrack(playback.currentTrack)}
    onPause={playback.handlePause}
    onStop={playback.handleStop}
    onNext={handleNext}
    onPrevious={() => queueHook.playPrevious()}
    onSeek={playback.handleSeek}
    onVolume={playback.handleVolume}
    onMute={() => {
      if (playback.volume > 0) {
        previousVolumeRef.current = playback.volume;
        playback.handleVolume(0);
      } else {
        playback.handleVolume(previousVolumeRef.current || 1.0);
      }
    }}
    onToggleLike={() => toggleLike(playback.currentTrack!)}
    onToggleDislike={() => toggleDislike(playback.currentTrack!)}
    onClose={() => setShowNowPlayingView(false)}
    onArtistClick={(id) => { setShowNowPlayingView(false); handleArtistClick(id); }}
    onAlbumClick={(id, aid) => { setShowNowPlayingView(false); handleAlbumClick(id, aid); }}
    onTagClick={(tagId) => { setShowNowPlayingView(false); library.setSelectedTag(tagId); library.setView("tags"); }}
    libraryTags={library.tags}
  />
)}
```

Note: `handleArtistClick` and `handleAlbumClick` refer to existing navigation functions in App.tsx. Find the exact function names by searching for the existing `onArtistClick` and `onAlbumClick` prop values passed to other components like `NowPlayingBar`. The `onMute` handler uses the same inline closure pattern as the existing NowPlayingBar/FullscreenControls — uses `previousVolumeRef` (declared at line ~83 in App.tsx). The `onTagClick` handler uses `library.setSelectedTag(tagId)` and `library.setView("tags")` for tag navigation by ID.

- [ ] **Step 7: Pass `active` prop to FullscreenControls for video in Now Playing**

Where `FullscreenControls` is rendered (line ~3057-3131), add the `active` and `onCloseNowPlaying` props:

```typescript
<FullscreenControls
  {...existingProps}
  active={showNowPlayingView && isVideoTrack(playback.currentTrack!)}
  onCloseNowPlaying={showNowPlayingView ? () => setShowNowPlayingView(false) : undefined}
/>
```

- [ ] **Step 8: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat: wire NowPlayingView into App with state, rendering, and exit logic"
```

---

### Task 7: Add Expand Button to NowPlayingBar

**Files:**
- Modify: `src/components/NowPlayingBar.tsx:34-69` (props), `:217-224` (controls area)

- [ ] **Step 1: Add `onOpenNowPlaying` prop**

In the `NowPlayingBarProps` interface, add:

```typescript
  onOpenNowPlaying: () => void;
```

Add `onOpenNowPlaying` to the destructured props in the component function.

- [ ] **Step 2: Add expand button to the controls area**

In the full-mode controls section (line ~217-224), after the stop button and before the closing `</div>` of `.now-controls`, add:

```typescript
<button className="ctrl-btn" onClick={onOpenNowPlaying} title="Now Playing View">{"\u26F6"}</button>
```

The `⛶` character (U+26F6, square with four corners) suggests an expand/maximize action. If this doesn't render well, alternatives: `↗` (U+2197) or a simple `▢` (U+25A2).

- [ ] **Step 3: Pass the prop from App.tsx**

In App.tsx where `NowPlayingBar` is rendered (line ~3299), add:

```typescript
onOpenNowPlaying={openNowPlaying}
```

- [ ] **Step 4: Verify type-check passes**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npm run test:all`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/components/NowPlayingBar.tsx src/App.tsx
git commit -m "feat: add expand button to NowPlayingBar to open Now Playing view"
```

---

### Task 8: Manual Verification

- [ ] **Step 1: Start the dev server**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npm run tauri dev`

- [ ] **Step 2: Verify audio mode**

1. Play an audio track
2. Click the expand button in the footer bar
3. Verify: sidebar, footer, queue panel are hidden
4. Verify: album art, track title, artist name, album name displayed
5. Verify: tags, like/dislike buttons, "Up Next" card visible (if data available)
6. Verify: similar tracks list populates after a moment (Last.fm fetch)
7. Verify: right panel shows artist card and album card with images
8. Verify: right panel scrolls
9. Verify: playback controls work (play/pause, seek, volume, prev/next)
10. Verify: clicking artist name exits view and navigates to artist
11. Verify: Escape key closes the view
12. Verify: close button (✕) closes the view

- [ ] **Step 3: Verify video mode**

1. Play a video track
2. Open Now Playing view
3. Verify: video fills the view area
4. Verify: controls overlay auto-hides after 3 seconds
5. Verify: moving mouse shows controls
6. Verify: close button in overlay exits the view
7. Verify: video continues playing without interruption when entering/exiting

- [ ] **Step 4: Verify edge cases**

1. Open Now Playing with no Last.fm configured — verify sections show gracefully
2. Stop playback while in Now Playing — verify view closes automatically
3. Toggle mini mode while in Now Playing — verify view closes
4. Switch tracks while in Now Playing — verify data refreshes
