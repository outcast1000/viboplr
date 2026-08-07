import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import { isVideoTrack } from "../utils";
import type { QueueTrack } from "../types";
import type { LyricsData } from "../types/informationTypes";
import type { UseLyricsResult } from "../hooks/useLyrics";
import { parseLrc, currentSyncedLineIndex } from "../utils/lyrics";
import { usePlaybackPosition } from "../playback/positionStore";
import { TrackArtFallback } from "./TrackArtFallback";
import "./NowPlayingView.css";

interface NowPlayingViewProps {
  style?: CSSProperties;
  track: QueueTrack | null;
  lyrics: UseLyricsResult;
  /** Image-provider chain lookups (album → artist fallback). Called during render
      so the async cache-resolve re-render is picked up, same as HomeShelf/cards. */
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
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
  /** Enter the fullscreen visualizer. Absent when nothing can fill that slot,
      which is also what hides the button.
      Mirrors the video theater's own fullscreen button (VideoAmbientOverlay):
      the two are the same view in the same state, so the affordance shouldn't
      be a visible button for one and a buried menu item for the other. */
  onEnterFullscreen?: () => void;
  /** The user collapsed the lyrics column. Independent of whether this track
      has lyrics at all — both end up hiding the column, and both hand the
      freed width to whatever is in the art column. */
  lyricsHidden?: boolean;
}

/** Centered, lean-back lyrics display. Synced (karaoke) when LRC timing is
    available, otherwise centered plain text. Synced auto-scrolls to the active
    line (pausing briefly after manual scroll) and lines are tap-to-seek; plain
    text doesn't auto-scroll (no timing to follow). */
function NowPlayingLyrics({
  data,
  onSeek,
}: {
  data: LyricsData;
  onSeek?: (secs: number) => void;
}) {
  // Subscribed at this leaf so the ~4 Hz position tick re-renders only the
  // lyrics panel, not the whole view (or App).
  const positionSecs = usePlaybackPosition();
  const synced = useMemo(
    () => (data.kind === "synced" && data.text ? parseLrc(data.text) : null),
    [data.kind, data.text],
  );
  const activeIdx = synced ? currentSyncedLineIndex(synced, positionSecs) : -1;

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
              onClick={onSeek ? () => onSeek(line.time) : undefined}
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
  style,
  track,
  lyrics,
  getAlbumImage,
  getArtistImage,
  onSeek,
  visualizerSlot,
  onOpenVisualizerPicker,
  onToggleLyrics,
  onEnterFullscreen,
  lyricsHidden,
}: NowPlayingViewProps) {
  const isVideo = track ? isVideoTrack(track) : false;

  // Read-only tags for the metadata line. NowPlayingView operates on a
  // QueueTrack (no DB id), so resolve to a library track by metadata; tags show
  // only for tracks that exist in the library. Editing lives in the Now Playing
  // bar's tag popover and the track detail page, not in this lean-back view.
  const [trackTags, setTrackTags] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!track) { setTrackTags([]); return; }
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
  }, [track?.title, track?.artist_name, track?.album_title]);

  // Resolve art via the image-provider plugin chain: explicit url → album → artist.
  let albumImageSrc: string | null = null;
  if (track && !isVideo) {
    if (track.image_url) {
      albumImageSrc = resolveImageSrc(track.image_url);
    } else {
      const albumPath = track.album_title ? getAlbumImage(track.album_title, track.artist_name) : null;
      const artistPath = !albumPath && track.artist_name ? getArtistImage(track.artist_name) : null;
      albumImageSrc = resolveImageSrc(albumPath ?? artistPath);
    }
  }

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

  if (!track) {
    return (
      <div className="now-playing-view np-empty" style={style}>
        <div className="np-empty-msg">Nothing playing</div>
      </div>
    );
  }

  // Video: the shared <video> element is layered over this area by App.tsx
  // (.video-container--theater). We only reserve space + show metadata.
  if (isVideo) {
    return (
      <div className="now-playing-view np-video" style={style}>
        <div className="np-video-spacer" />
      </div>
    );
  }

  // Audio: blurred-art backdrop + sharp art + centered karaoke/plain lyrics,
  // with an up-next peek on the side.
  const hasArt = !!albumImageSrc;
  const hasLyrics = lyrics.status === "loaded" && !!lyrics.data;
  // One flag drives the layout: "no lyrics on screen", whether because the
  // track has none or because the user collapsed them. The art column — and so
  // a visualizer sitting in it — takes the whole stage either way.
  const showLyrics = hasLyrics && !lyricsHidden;
  return (
    <div
      className={`now-playing-view np-audio${hasArt ? "" : " np-audio--noart"}${showLyrics ? "" : " np-audio--nolyrics"}`}
      style={style}
    >
      {/* Every view action is a visible button. There is no ⋯ and no right-click
          menu: the three things this view can do are now all on screen, so a
          second, hidden route to the same three would be duplication rather than
          convenience. The visualizer picker is still a native menu — it's a list
          of choices — but it hangs off the button that describes it. */}
      {(onOpenVisualizerPicker || onToggleLyrics || onEnterFullscreen) && (
        <div className="np-actions">
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
              theater's fullscreen button occupies. */}
          {onEnterFullscreen && (
            <button
              className="np-action-btn"
              onClick={onEnterFullscreen}
              title="Enter fullscreen"
              aria-label="Enter fullscreen"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
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
          ) : (
            <div key={track.key} className="np-art np-art--placeholder np-enter">
              <TrackArtFallback track={track} size={72} />
            </div>
          )}
        </div>
        {/* Unmounted, not just hidden, when collapsed — the synced panel runs a
            position-driven auto-scroll, and leaving that ticking behind
            `display: none` would burn frames on something nobody can see. */}
        {!lyricsHidden && (
          <div className="np-lyrics-col">
            {lyrics.status === "loaded" && lyrics.data ? (
              <NowPlayingLyrics key={track.key} data={lyrics.data} onSeek={onSeek} />
            ) : lyrics.status === "loading" ? (
              <div className="np-lyrics-hint" aria-hidden="true" />
            ) : null}
          </div>
        )}
      </div>
      {metaLine}
      {trackTags.length > 0 && (
        <div className="np-tags np-enter" key={`${track.key}-tags`}>{trackTags.join(" · ")}</div>
      )}
    </div>
  );
}
