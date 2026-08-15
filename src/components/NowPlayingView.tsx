import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import { isVideoTrack } from "../utils";
import type { QueueTrack } from "../types";
import type { LyricsData } from "../types/informationTypes";
import type { UseLyricsResult } from "../hooks/useLyrics";
import { parseLrc, currentSyncedLineIndex, lyricPosition } from "../utils/lyrics";
import { LyricsOffsetControl } from "./LyricsOffsetControl";
import { resolveNowPlayingArt } from "../utils/nowPlayingArt";
import { usePlaybackPosition } from "../playback/positionStore";
import { useIdleVisibility } from "../hooks/useIdleVisibility";
import { TrackArtFallback } from "./TrackArtFallback";
import "./NowPlayingView.css";

interface NowPlayingViewProps {
  /**
   * Which chrome surrounds this surface.
   *
   * `view` (default) is the `nowplaying` main-content view: the app's caption bar,
   * sidebar and now-playing bar are all on screen around it, and this view owns
   * the track's title/artist/album line.
   *
   * `fullscreen` is the same surface inside `AudioFullscreen` — bigger, and with
   * `FullscreenControls` underneath it. That bar already carries the title with
   * clickable artist/album links, so the identity block here would be a second
   * copy of it; and with the app chrome gone the stage has far more room to fill.
   * Everything else — backdrop, art regime, lyrics, the corner action row — is
   * deliberately identical, which is the point of there being one component.
   */
  variant?: "view" | "fullscreen";
  track: QueueTrack | null;
  lyrics: UseLyricsResult;
  /** Image-provider chain lookups (album → artist fallback). Called during render
      so the async cache-resolve re-render is picked up, same as HomeShelf/cards. */
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  /** Has that lookup settled? The getters above return `null` for "no image" and
      "still looking" alike, and this view can't treat the two the same: art
      decides the whole surface regime (blurred backdrop + always-light text vs
      skin gradient + skin text), so an in-flight lookup read as "no art" commits
      to the wrong regime and then flips — on a light skin the text inverts. */
  isAlbumImageResolved?: (name: string, artistName?: string | null) => boolean;
  isArtistImageResolved?: (name: string) => boolean;
  /** Seek playback to an absolute position (seconds) — wired to tap-to-seek on synced lines. */
  onSeek?: (secs: number) => void;
  /** A plugin visualizer filling the `nowplaying` slot. When present it takes
      the art column's place — a vinyl deck or a meter belongs where the static
      square was. App owns the plugin plumbing; this view just gives it room. */
  visualizerSlot?: ReactNode;
  /** Open the visualizer picker, anchored under the Visualizer button.
      Still a native menu (a list of choices is a menu, and the app-wide rule
      admits no JS dropdowns) — it just hangs off a visible button now instead of
      a ⋯ that gave no clue what was behind it. */
  onOpenVisualizerPicker?: (x: number, y: number) => void;
  /** Show/hide the lyrics column. The view gates the button on whether this
      track has lyrics at all, so there is no `hasLyrics` prop to keep in step
      with the one it already derives for the layout. */
  onToggleLyrics?: () => void;
  /** Toggle the fullscreen surface — enter from the view, leave from fullscreen.
      One callback for both directions, because it is one button in one place:
      the row would otherwise have three items windowed and two in fullscreen,
      and the odd one out is the button the user just pressed to get there.
      Absent when fullscreen isn't available, which is what hides it.
      Mirrors the video theater's own fullscreen button (VideoAmbientOverlay):
      the two are the same view in the same state, so the affordance shouldn't
      be a visible button for one and a buried menu item for the other. */
  onToggleFullscreen?: () => void;
  /** The user collapsed the lyrics column. Independent of whether this track
      has lyrics at all — both end up hiding the column, and both hand the
      freed width to whatever is in the art column. */
  lyricsHidden?: boolean;
  /** Per-track lyrics timing offset; positive delays. See `lyricPosition`. */
  lyricsOffsetSecs?: number;
  /** Omit to hide the offset control (it is also hidden for plain lyrics, which
      have no timeline to shift). */
  onLyricsOffsetChange?: (secs: number) => void;
}

/** Centered, lean-back lyrics display. Synced (karaoke) when LRC timing is
    available, otherwise centered plain text. Synced auto-scrolls to the active
    line (pausing briefly after manual scroll) and lines are tap-to-seek; plain
    text doesn't auto-scroll (no timing to follow). */
function NowPlayingLyrics({
  data,
  onSeek,
  offsetSecs = 0,
}: {
  data: LyricsData;
  onSeek?: (secs: number) => void;
  /** Per-track lyrics timing offset; positive delays. See `lyricPosition`. */
  offsetSecs?: number;
}) {
  // Subscribed at this leaf so the ~4 Hz position tick re-renders only the
  // lyrics panel, not the whole view (or App).
  const positionSecs = usePlaybackPosition();
  const synced = useMemo(
    () => (data.kind === "synced" && data.text ? parseLrc(data.text) : null),
    [data.kind, data.text],
  );
  const activeIdx = synced ? currentSyncedLineIndex(synced, lyricPosition(positionSecs, offsetSecs)) : -1;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrollTimer = useRef<number>(0);
  // Suppress the `scroll` events our own auto-scroll produces so they aren't
  // mistaken for manual scrolling. The window must outlast a smooth
  // scrollIntoView animation (~hundreds of ms).
  const suppressUntil = useRef(0);

  const markProgrammatic = () => { suppressUntil.current = performance.now() + 700; };

  // Synced: keep the active line centered (pauses while the user is scrolling).
  useEffect(() => {
    if (synced && !userScrolled && activeRef.current) {
      markProgrammatic();
      activeRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [synced, activeIdx, userScrolled]);

  // Plain (no timing): no auto-scroll. Without per-line sync there's nothing to
  // follow, so the text stays put and the user scrolls it themselves.

  const onScroll = () => {
    if (performance.now() < suppressUntil.current) return; // ignore our own scrolls
    setUserScrolled(true);
    if (userScrollTimer.current) clearTimeout(userScrollTimer.current);
    userScrollTimer.current = window.setTimeout(() => setUserScrolled(false), 4000);
  };

  useEffect(() => () => { if (userScrollTimer.current) clearTimeout(userScrollTimer.current); }, []);

  if (synced) {
    return (
      <div className="np-lyrics-scroll np-lyrics-scroll--synced" ref={scrollRef} onScroll={onScroll}>
        {synced.map((line, i) => {
          const active = i === activeIdx;
          const state = active ? "active" : i < activeIdx ? "past" : "upcoming";
          return (
            <div
              key={i}
              ref={active ? activeRef : undefined}
              className={`np-lyric-line np-lyric-line--${state}${onSeek ? " np-lyric-line--seekable" : ""}`}
              // Seek to where this line actually plays, which is its LRC time
              // plus the offset — the inverse of lyricPosition. Seeking to the
              // raw time would land `offsetSecs` away from the words the user
              // clicked, i.e. wrong by exactly the amount they just corrected.
              onClick={onSeek ? () => onSeek(Math.max(0, line.time + offsetSecs)) : undefined}
              title={onSeek ? "Jump to this line" : undefined}
            >
              {line.text || "♪"}
            </div>
          );
        })}
      </div>
    );
  }

  // Plain (no timing): centered static text.
  return (
    <div className="np-lyrics-scroll np-lyrics-scroll--plain" ref={scrollRef} onScroll={onScroll}>
      {data.text.split("\n").map((line, i) => (
        <div key={i} className="np-lyric-line np-lyric-line--plain">{line || " "}</div>
      ))}
    </div>
  );
}

/** Single-source crossfade: when `src` changes the incoming layer fades in on
    top of the previous one, which is pruned once the fade completes. Used for
    the album art and the blurred backdrop so a track change dissolves instead of
    snapping. Layers beneath the top stay fully opaque, so there's no mid-fade dip
    to the background. */
function Crossfade({
  src,
  className,
  render,
}: {
  src: string | null;
  className?: string;
  render: (src: string) => ReactNode;
}) {
  const [layers, setLayers] = useState<{ id: number; src: string }[]>([]);
  const nextId = useRef(0);
  const pruneTimer = useRef(0);

  useEffect(() => {
    if (!src) {
      setLayers([]);
      return;
    }
    setLayers((prev) => {
      if (prev.length && prev[prev.length - 1].src === src) return prev; // unchanged
      // Keep only the just-departing layer beneath the incoming one.
      return [...prev.slice(-1), { id: nextId.current++, src }];
    });
  }, [src]);

  // Fallback prune to a single layer after the fade window, so layers can't
  // accumulate even when `transitionend` never fires (e.g. reduced motion).
  useEffect(() => {
    if (layers.length <= 1) return;
    if (pruneTimer.current) clearTimeout(pruneTimer.current);
    pruneTimer.current = window.setTimeout(
      () => setLayers((prev) => prev.slice(-1)),
      700,
    );
    return () => {
      if (pruneTimer.current) clearTimeout(pruneTimer.current);
    };
  }, [layers]);

  return (
    <div className={`np-xfade ${className ?? ""}`} aria-hidden="true">
      {layers.map((layer, i) => (
        <CrossfadeLayer key={layer.id} top={i === layers.length - 1}>
          {render(layer.src)}
        </CrossfadeLayer>
      ))}
    </div>
  );
}

function CrossfadeLayer({ top, children }: { top: boolean; children: ReactNode }) {
  // Mount hidden and reveal on the next frame so the opacity transition actually
  // runs (same deferred-reveal trick as DetailHeroBackground). Only the topmost
  // layer fades in; layers beneath stay opaque until pruned.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);
  const hidden = top && !entered;
  return (
    <div className={`np-xfade-layer${hidden ? " np-xfade-layer--enter" : ""}`}>
      {children}
    </div>
  );
}

export function NowPlayingView({
  variant = "view",
  track,
  lyrics,
  getAlbumImage,
  getArtistImage,
  isAlbumImageResolved,
  isArtistImageResolved,
  onSeek,
  visualizerSlot,
  onOpenVisualizerPicker,
  onToggleLyrics,
  onToggleFullscreen,
  lyricsHidden,
  lyricsOffsetSecs = 0,
  onLyricsOffsetChange,
}: NowPlayingViewProps) {
  const isVideo = track ? isVideoTrack(track) : false;
  const isFullscreen = variant === "fullscreen";

  // The corner buttons fade out when the pointer goes quiet and come back on
  // movement, the same way the fullscreen bar and the video theater overlay do.
  // This is a lean-back surface: at rest it should be the artwork and the words,
  // not three icons. `:hover` / `:focus-within` on the row keep it up in CSS, so
  // the timer can never pull a button out from under the cursor or off a
  // keyboard focus — no JS needed for either.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const { visible: actionsVisible, hide: hideActions } = useIdleVisibility({
    getTarget: () => surfaceRef.current,
  });
  // Fullscreen's identity comes from the control bar under it, so this surface
  // draws neither the title block nor the tags line there.
  const showIdentity = !isFullscreen;

  // Read-only tags for the metadata line. NowPlayingView operates on a
  // QueueTrack (no DB id), so resolve to a library track by metadata; tags show
  // only for tracks that exist in the library. Editing lives in the Now Playing
  // bar's tag popover and the track detail page, not in this lean-back view.
  const [trackTags, setTrackTags] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    // Two DB round-trips for a line fullscreen doesn't render.
    if (!track || !showIdentity) { setTrackTags([]); return; }
    invoke<{ id: number } | null>("find_track_by_metadata", {
      title: track.title,
      artistName: track.artist_name ?? null,
      albumName: track.album_title ?? null,
    })
      .then((lib) => {
        if (cancelled) return;
        if (!lib) { setTrackTags([]); return; }
        invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id })
          .then((rows) => { if (!cancelled) setTrackTags(rows.map((r) => r.name)); })
          .catch((e) => console.error("Failed to load tags for now-playing track:", e));
      })
      .catch((e) => console.error("Failed to resolve now-playing track:", e));
    return () => { cancelled = true; };
  }, [track?.title, track?.artist_name, track?.album_title, showIdentity]);

  // Resolve art via the image-provider plugin chain: explicit url → album →
  // artist. `pending` distinguishes "no art" from "still looking", which this
  // view has to act on — see resolveNowPlayingArt.
  const art = track && !isVideo
    ? resolveNowPlayingArt(track, {
        getAlbumImage,
        getArtistImage,
        isAlbumImageResolved,
        isArtistImageResolved,
      })
    : { path: null, pending: false };
  const albumImageSrc = resolveImageSrc(art.path);
  const artPending = art.pending;

  // Keyed on the track identity so a track change remounts the line and replays
  // the entrance animation (it stays put across position ticks).
  const metaLine = useMemo(() => {
    if (!track) return null;
    const parts = [track.artist_name, track.album_title].filter(Boolean) as string[];
    return (
      <div className="np-meta np-enter" key={track.key}>
        <div className="np-title">{track.title}</div>
        {parts.length > 0 && <div className="np-subtitle">{parts.join(" · ")}</div>}
      </div>
    );
  }, [track]);

  // Sizing tier for the fullscreen variant (see NowPlayingView.css). Carried on
  // every branch so the empty/video states are laid out consistently too.
  const rootClass = `now-playing-view${variant === "fullscreen" ? " now-playing-view--fs" : ""}`;

  if (!track) {
    return (
      <div className={`${rootClass} np-empty`}>
        <div className="np-empty-msg">Nothing playing</div>
      </div>
    );
  }

  // Video: the shared <video> element is layered over this area by App.tsx
  // (.video-container--theater). We only reserve space + show metadata.
  if (isVideo) {
    return (
      <div className={`${rootClass} np-video`}>
        <div className="np-video-spacer" />
      </div>
    );
  }

  // Audio: blurred-art backdrop + sharp art + centered karaoke/plain lyrics,
  // with an up-next peek on the side.
  const hasArt = !!albumImageSrc;
  // The no-art surface is a commitment — skin gradient, skin text colors — so it
  // waits for a settled answer. While a lookup is out the art regime holds, and
  // `--np-backdrop-base` is the dark layer its light text sits on until the
  // backdrop itself arrives.
  const artRegime = hasArt || artPending;
  const hasLyrics = lyrics.status === "loaded" && !!lyrics.data;
  // One flag drives the layout: "no lyrics on screen", whether because the
  // track has none or because the user collapsed them. The art column — and so
  // a visualizer sitting in it — takes the whole stage either way.
  const showLyrics = hasLyrics && !lyricsHidden;
  return (
    <div
      ref={surfaceRef}
      className={`${rootClass} np-audio${artRegime ? "" : " np-audio--noart"}${showLyrics ? "" : " np-audio--nolyrics"}`}
      // Leaving the surface hides the row at once rather than after the idle
      // wait — the pointer has gone to the sidebar or the queue, so there is
      // nothing left to wait for.
      onMouseLeave={hideActions}
    >
      {/* Every view action is a visible button. There is no ⋯ and no right-click
          menu: the three things this view can do are now all on screen, so a
          second, hidden route to the same three would be duplication rather than
          convenience. The visualizer picker is still a native menu — it's a list
          of choices — but it hangs off the button that describes it.

          The row travels into fullscreen unchanged; only "enter fullscreen" drops
          out there, because the control bar under it owns the exit. */}
      {(onOpenVisualizerPicker || onToggleLyrics || onToggleFullscreen) && (
        <div className={`np-actions${actionsVisible ? " is-visible" : ""}`}>
          {onOpenVisualizerPicker && (
            <button
              className="np-action-btn"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                onOpenVisualizerPicker(r.left, r.bottom);
              }}
              title="Choose visualizer"
              aria-label="Choose visualizer"
            >
              {/* A record, echoing the sidebar's Now Playing disc. Deliberately
                  NOT equalizer bars: the now-playing bar already uses those for
                  the actual EQ, and this picks what fills the art column. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <circle cx="12" cy="12" r="3.2" />
              </svg>
            </button>
          )}
          {onToggleLyrics && (
            <button
              className={`np-action-btn${showLyrics ? "" : " is-off"}`}
              onClick={onToggleLyrics}
              // Disabled rather than hidden, so the row doesn't reshuffle as the
              // queue moves between tracks that have lyrics and tracks that don't.
              disabled={!hasLyrics}
              title={
                hasLyrics
                  ? showLyrics
                    ? "Hide lyrics"
                    : "Show lyrics"
                  : "No lyrics for this track"
              }
              aria-label={showLyrics ? "Hide lyrics" : "Show lyrics"}
              aria-pressed={showLyrics}
            >
              {/* Same glyph as the video theater's subtitle toggle — same idea,
                  same corner of the same view. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M7 14.5a2 2 0 0 1 0-4" />
                <path d="M15 14.5a3 3 0 0 1 0-4" />
              </svg>
            </button>
          )}
          {/* Last, so it lands in the extreme corner — the same spot the video
              theater's fullscreen button occupies. Present in BOTH variants, and
              in the same place: the row is the surface's own control set, so it
              would read as a glitch if the button that got you here vanished on
              arrival. Only the direction (and so the glyph) flips. */}
          {onToggleFullscreen && (
            <button
              className="np-action-btn"
              onClick={onToggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? (
                // Arrows pointing in — the same glyph FullscreenControls' own
                // exit button uses, so the two routes out look like one action.
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}
        </div>
      )}
      {hasArt && (
        <Crossfade
          src={albumImageSrc}
          className="np-xfade--backdrop"
          render={(src) => (
            <div className="np-backdrop" style={{ backgroundImage: `url("${src}")` }} />
          )}
        />
      )}
      <div className="np-stage">
        <div className={"np-art-col" + (visualizerSlot ? " np-art-col--visualizer" : "")}>
          {visualizerSlot ? (
            visualizerSlot
          ) : hasArt ? (
            <Crossfade
              src={albumImageSrc}
              className="np-xfade--art"
              render={(src) => <img className="np-art" src={src} alt="" />}
            />
          ) : artPending ? (
            // An empty frame, not the initials fallback: the lookup may still
            // come back with a cover, and initials that appear for one frame and
            // are then replaced read as a glitch rather than as a placeholder.
            <div className="np-art np-art--pending" aria-hidden="true" />
          ) : (
            <div key={track.key} className="np-art np-art--placeholder np-enter">
              {/* Scaled with the frame, which the fullscreen tier roughly doubles.
                  A fixed 72px glyph in a 710px square reads as a rendering fault
                  rather than a placeholder — and the art-only fullscreen this
                  replaced already drew it at 96. */}
              <TrackArtFallback track={track} size={variant === "fullscreen" ? 128 : 72} />
            </div>
          )}
        </div>
        {/* Unmounted, not just hidden, when collapsed — the synced panel runs a
            position-driven auto-scroll, and leaving that ticking behind
            `display: none` would burn frames on something nobody can see. */}
        {!lyricsHidden && (
          <div className="np-lyrics-col">
            {lyrics.status === "loaded" && lyrics.data ? (
              <NowPlayingLyrics key={track.key} data={lyrics.data} onSeek={onSeek} offsetSecs={lyricsOffsetSecs} />
            ) : lyrics.status === "loading" ? (
              <div className="np-lyrics-hint" aria-hidden="true" />
            ) : null}
            {/* Only for SYNCED lyrics: plain text has no timeline to shift, so
                the control would be a knob wired to nothing. */}
            {onLyricsOffsetChange && lyrics.data?.kind === "synced" && (
              <LyricsOffsetControl
                offsetSecs={lyricsOffsetSecs}
                onChange={onLyricsOffsetChange}
                className="np-lyrics-offset"
              />
            )}
          </div>
        )}
      </div>
      {/* Fullscreen's control bar already shows the title with clickable
          artist/album links, so drawing them here too would be the same fact
          twice on one screen. */}
      {showIdentity && metaLine}
      {showIdentity && trackTags.length > 0 && (
        <div className="np-tags np-enter" key={`${track.key}-tags`}>{trackTags.join(" · ")}</div>
      )}
    </div>
  );
}
