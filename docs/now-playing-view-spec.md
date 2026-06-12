# Spec: "Now Playing" View (theater / lyrics surface)

## Summary

A new sidebar **destination view** called **Now Playing** that shows the currently
playing track in a lean-back, full-column layout. The centerpiece is **type-driven**:

- **Video track** → the (existing, shared) `<video>` element, large and centered.
- **Audio track** → large album art over a blurred-art ambient background, with
  **big synced lyrics** centered on top (karaoke style). Degrades to plain lyrics →
  centered art → skin-accent gradient.

The now-playing **bar** at the bottom remains the transport — the view itself has no
controls. Leaving the view (clicking any other sidebar item) returns the video to its
normal dock and keeps playback going.

This is **not** a new player. There is one `<video>` element (`usePlayback.videoRef`)
and one playback pipeline; Now Playing only re-lays-out what already exists, exactly the
way fullscreen does.

## Decisions (settled during design)

| Decision | Choice |
|---|---|
| What it is | Destination view in the sidebar; works for every track |
| Centerpiece | Type-driven (video element vs art+lyrics) |
| Audio+lyrics layout | Art-as-backdrop, lyrics centered on top |
| No-lyrics audio | Big centered art only (visualizer is a later add) |
| Video tracks | Lyrics suppressed; video is the focus |
| Transport | None on the view — rely on the now-playing bar |

## Degradation chain (never a broken state)

```
video                → big video element, ambient bg off
audio + synced lyrics → blurred-art backdrop + sharp art + karaoke lyrics
audio + plain lyrics  → blurred-art backdrop + sharp art + scrollable plain lyrics
audio + no lyrics     → blurred-art backdrop + centered sharp art
audio + no art        → skin-accent gradient backdrop + centered placeholder
```

---

## The one architectural subtlety: who owns the main column

The single `<video>` element is mounted in `.video-container`, which lives **inside**
`<main>` (App.tsx ~3009–3033) and is docked top/bottom/left/right by `useVideoLayout`.
The Now Playing view also wants to be the content of `<main>`. They compete for the
same space.

**Resolution — follow the fullscreen precedent (CSS reposition, no remount).**
Fullscreen keeps the same `<video>` mounted and just calls `requestFullscreen()` on its
container; CSS (`.video-container:fullscreen { … }`) restyles it. We do the same with a
plain class instead of the native API:

- Keep `<video>` mounted in `.video-container` where it is today — **never** move it in
  the DOM, **never** portal it (that would tear down the media element and kill any
  active transcode session).
- When `view === "nowplaying"` **and** the current track is a video, add a
  `.video-container--theater` class. That class position:absolute-fills the main column
  area (over the NowPlayingView body), centered, `object-fit` per `fitMode`.
- `NowPlayingView` renders a video-state body that is **just a metadata line + spacer**
  (the visible video is the repositioned `.video-container` sitting on top). For audio,
  the theater class is absent and `.video-container` stays `display:none` (it already
  hides for non-video tracks), so NowPlayingView's art/lyrics body shows normally.

This keeps one element, one pipeline, and reuses the proven fullscreen pattern.

> Note: the docked-video splitter / dock-side / fit controls are irrelevant while in
> theater (the video fills the column). `fitMode` still applies for letterbox vs fill.
> When the user leaves the view, removing the class drops the video back to its dock.

---

## Files to change / create

### 1. `src/types.ts` — add the view

**Line ~95**, add `"nowplaying"` to the `View` union:

```ts
export type View = "home" | "search" | "artists" | "albums" | "tags" | "history"
  | "collections" | "playlists" | "nowplaying" | "settings" | "extensions"
  | `plugin:${string}`;
```

### 2. `src/hooks/useLyrics.ts` — NEW (the only genuinely new logic)

A standalone hook that runs the existing plugin info-type "lyrics" provider chain for a
`QueueTrack`, reusing the same cache/TTL path `useInformationTypes` uses. Returns
`{ data, kind, status, loading }` shaped for `LyricsRenderer`.

Reuse, don't reinvent:
- Entity key for tracks is `track:{artistName}:{title}` (`buildEntityKey`,
  `types/informationTypes.ts:161`).
- Fetch via the same `invokeInfoFetch(pluginId, "lyrics", entity)` provider-chain
  fallback used in `useInformationTypes.ts` (~162–209): walk lyric providers in priority
  order, first `status: "ok"` wins; consult/​upsert the info-value cache
  (`info_get_values_for_entity` / `info_upsert_value`) with the same TTL decision
  (`decideCacheAction`).

Sketch:

```ts
export function useLyrics(track: QueueTrack | null, invokeInfoFetch, lyricsProviders) {
  const [state, setState] = useState<{ data: LyricsData | null; status; loading }>(...);
  useEffect(() => {
    if (!track?.title) { setState(empty); return; }
    const entity: InfoEntity = {
      kind: "track", name: track.title, id: 0,
      artistName: track.artist_name ?? "", albumTitle: track.album_title ?? "",
    };
    // 1) consult info-value cache (entityKey = track:{artist}:{title}, type "lyrics")
    // 2) if miss/stale: walk lyricsProviders, invokeInfoFetch(pluginId,"lyrics",entity)
    //    first ok wins; upsert into cache
    // (mirror useInformationTypes' decideCacheAction + dedupe-in-flight)
  }, [track?.title, track?.artist_name]);
  return state; // { data, kind, status, loading }
}
```

Notes:
- `track.id` is `0`/absent for queue tracks — fine, lyrics keying is name-based.
- Dedupe concurrent fetches for the same key (mirror `inFlightRef` in
  `useInformationTypes`).
- The lyric provider list (ordered, enabled) comes from the same source
  `useInformationTypes`/`usePlugins` already expose; pass it in rather than recomputing.

### 3. `src/components/NowPlayingView.tsx` — NEW

Pure presentational view. Props:

```ts
interface NowPlayingViewProps {
  track: QueueTrack | null;          // playback.currentTrack
  positionSecs: number;              // playback.positionSecs
  lyrics: ReturnType<typeof useLyrics>;
  albumImageSrc: string | null;      // via useImageCache (album then artist fallback)
  onSaveLyrics: (payload) => void;   // route to existing "save-lyrics" action
}
```

Render logic:

```
if (!track)            → empty state ("Nothing playing")
if isVideoTrack(track) → video body: metadata line only (the .video-container--theater
                          element is layered on top by App.tsx; this body just reserves
                          space + shows title/artist/album)
else (audio):
  background: blurred copy of albumImageSrc (or skin --accent gradient if none)
  center:
    - sharp album art (or placeholder)
    - if lyrics.data: <LyricsRenderer data={lyrics.data}
                         context={{ positionSecs }} onAction={onSaveLyrics} />
      (synced → karaoke highlight + autoscroll; plain → scrollable text — renderer
       already branches on data.kind)
    - else: nothing (art alone)
  metadata line: title — artist · album
```

Reused as-is: `LyricsRenderer` (`components/renderers/LyricsRenderer.tsx` — scales via
`--fs-*` CSS vars, no fixed sizes), `useImageCache`, skin color vars.

### 4. `src/components/NowPlayingView.css` — NEW

- Backdrop: `position:absolute; inset:0; background-image` blurred (`filter: blur(40px)
  brightness(0.5)`), `object-fit: cover`; gradient fallback uses
  `var(--accent)`/`var(--bg-primary)`.
- Center column: flex, centered, max-width cap; art size responsive.
- Lyrics: bump font scale up (override `.renderer-lyrics .lyrics-line` to e.g.
  `--fs-lg`/`--fs-xl`, active line brighter/bold) **scoped under a Now-Playing class** so
  it doesn't affect the track-detail tab.
- All colors via skin custom props (skin compatibility rule). No hardcoded colors.
- `.video-container--theater` rule (could live here or in `TrackDetailView.css` beside
  the existing `:fullscreen` rules): `position:absolute` fill the main content rect,
  center, `object-fit` per `data-fit`.

### 5. `src/App.tsx` — wire it up

- **Theater class on the video container** (~3009): add
  `view === "nowplaying" && currentTrack && isVideoTrack(currentTrack)` →
  ` video-container--theater` to the className, and let the existing `display:none`
  logic keep it hidden for audio. (Do not gate the splitter on theater — just let the
  class override layout.)
- **Render the view** in the main view chain (after `SearchView`, ~2831):

```tsx
{view === "nowplaying" && (
  <NowPlayingView
    track={playback.currentTrack}
    positionSecs={playback.positionSecs}
    lyrics={nowPlayingLyrics}              // useLyrics(playback.currentTrack, …)
    albumImageSrc={nowPlayingArt}          // useImageCache album→artist by name
    onSaveLyrics={handleSaveLyrics}        // reuse the existing save-lyrics handler
  />
)}
```

- **Call `useLyrics`** near the other hooks: `const nowPlayingLyrics =
  useLyrics(playback.currentTrack, invokeInfoFetch, lyricProviders);` (cheap when the
  view isn't open — it only fetches on track change and the cache short-circuits).
- **Sidebar handler** (~2524, after `onShowHistory`):

```tsx
onShowNowPlaying={() => {
  pushAndScroll();
  library.setView("nowplaying");
  library.setSelectedArtist(null);
  library.setSelectedAlbum(null);
  library.setSelectedTag(null);
  library.setSelectedTrack(null);
}}
```

### 6. `src/components/Sidebar.tsx` — nav entry

- Add a `nowplaying` icon SVG to the `icons` object (~8–15).
- Add `onShowNowPlaying: () => void;` to `SidebarProps` (~55, after `onShowHistory`).
- Add a nav item (after History, ~98):

```ts
{ key: "nowplaying", label: "Now Playing", icon: icons.nowplaying,
  active: noDetail && view === "nowplaying", onClick: onShowNowPlaying,
  hint: "Now Playing — ⌘3" },
```

The animated indicator follows `.nav-btn.active` automatically — no change needed.

### 7. `src/hooks/useInAppKeyboardShortcuts.ts` — Cmd/Ctrl+3

Add before `case "f"` (~149), mirroring the existing `case "2"`:

```ts
case "3":
  e.preventDefault();
  d.pushState();
  library.setView("nowplaying");
  library.setSelectedArtist(null);
  library.setSelectedAlbum(null);
  library.setSelectedTag(null);
  library.setSelectedTrack(null);
  break;
```

(Check whether Cmd+3 is already bound elsewhere; if so, pick the next free digit and
update the sidebar hint to match.)

---

## Conventions / rules to honor

- **Startup view rule:** Do **not** persist or restore `"nowplaying"` as the startup
  view. Startup always lands on Home. Within a session, selecting it navigates as usual.
- **Skin compatibility:** all colors via skin CSS custom props; verify across skins.
- **Error logging:** `useLyrics` fetch `.catch(console.error)` with context; empty result
  is `status: "not_found"`, not a thrown error.
- **Image resolution:** never put raw FS paths in `<img src>` — route album/artist art
  through `useImageCache` (same chain queue/now-playing use); `convertFileSrc` for local.
- **QueueTrack only:** `currentTrack` is a `QueueTrack` (no DB IDs). Lyrics keying is
  name-based, so this is fine — do not reach for `track.id`/`album_id`.
- **Native menus / modals rules:** N/A (no menus/modals added here).

## Test notes

- TS unit: pure logic in `useLyrics` (cache-decision + provider-fallback selection) can be
  extracted and tested like `informationTypes.test.ts` (no React).
- Manual / E2E: switch to Now Playing with (a) a video track → video fills column, leaving
  returns it to dock and playback continues; (b) an audio track with synced lyrics →
  karaoke highlight tracks `positionSecs`; (c) audio with no lyrics → centered art;
  (d) no art → gradient.

## Scope estimate

- New: `NowPlayingView.tsx`, `NowPlayingView.css`, `useLyrics.ts`.
- Edits: `types.ts`, `Sidebar.tsx`, `App.tsx` (3 spots), `useInAppKeyboardShortcuts.ts`.
- Reused untouched: `LyricsRenderer`, `useImageCache`, the `videoRef`/playback pipeline,
  skin system, the info-type fetch/cache plumbing.
```
