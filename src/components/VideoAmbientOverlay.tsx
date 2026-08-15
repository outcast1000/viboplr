import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import type { QueueTrack } from "../types";
import { getInitials } from "../utils";
import { nextQueueTrack } from "../utils/videoOverlay";
import { useIdleVisibility } from "../hooks/useIdleVisibility";
import { LyricsOffsetControl } from "./LyricsOffsetControl";
import type { LrcLine } from "../utils/lyrics";
import "./VideoAmbientOverlay.css";

interface VideoAmbientOverlayProps {
  currentTrack: QueueTrack | null;
  playing: boolean;
  queue: QueueTrack[];
  queueIndex: number;
  getAlbumImage: (name: string, artistName?: string | null) => string | null;
  getArtistImage: (name: string) => string | null;
  onPlayQueueIndex?: (index: number) => void;
  /** Toggle the shared <video> in/out of fullscreen. */
  onToggleFullscreen?: () => void;
  /** Parsed synced LRC for the current video, or null when unavailable / not a
   *  good enough duration match. When present, the subtitle toggle button is
   *  shown here. The subtitle text itself is rendered centrally by
   *  `VideoSubtitles` (a sibling in `.video-container`), so it's shared across
   *  every video surface — this overlay only owns the theater toggle button. */
  syncedLyricLines?: LrcLine[] | null;
  /** Shared subtitle visibility (App-owned; persisted). */
  subtitlesOn: boolean;
  onToggleSubtitles: () => void;
  /** Per-track lyrics timing offset; positive delays. See `lyricPosition`. */
  lyricsOffsetSecs?: number;
  /** Omit to hide the offset control. */
  onLyricsOffsetChange?: (secs: number) => void;
}

export function VideoAmbientOverlay({
  currentTrack,
  playing,
  queue,
  queueIndex,
  getAlbumImage,
  getArtistImage,
  onPlayQueueIndex,
  onToggleFullscreen,
  syncedLyricLines,
  subtitlesOn,
  onToggleSubtitles,
  lyricsOffsetSecs = 0,
  onLyricsOffsetChange,
}: VideoAmbientOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // Bump on track change to re-trigger the intro slide-in animation.
  const [introKey, setIntroKey] = useState(0);

  // Mirror document fullscreen state so the FS button shows enter/exit correctly.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Read-only tags for the intro label. The overlay only has a QueueTrack (no DB
  // id), so resolve to a library row by metadata first; tags show only for
  // tracks that exist in the library. Mirrors NowPlayingView's resolve path.
  const [tags, setTags] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!currentTrack) { setTags([]); return; }
    invoke<{ id: number } | null>("find_track_by_metadata", {
      title: currentTrack.title,
      artistName: currentTrack.artist_name ?? null,
      albumName: currentTrack.album_title ?? null,
    })
      .then((lib) => {
        if (cancelled) return;
        if (!lib) { setTags([]); return; }
        invoke<Array<{ id: number; name: string }>>("get_tags_for_track", { trackId: lib.id })
          .then((rows) => { if (!cancelled) setTags(rows.map((r) => r.name)); })
          .catch((e) => console.error("Failed to load tags for video track:", e));
      })
      .catch((e) => console.error("Failed to resolve video track:", e));
    return () => { cancelled = true; };
  }, [currentTrack?.title, currentTrack?.artist_name, currentTrack?.album_title]);

  // Show on activity over the video container (our parent), hide after the idle
  // wait while playing, stay up while paused. Shared with the fullscreen bar and
  // the Now Playing corner buttons — see useIdleVisibility.
  const { visible, reset: resetTimer } = useIdleVisibility({
    hold: !playing,
    getTarget: () => rootRef.current?.parentElement ?? null,
  });

  // Track change: re-trigger intro animation and re-show.
  useEffect(() => {
    setIntroKey((k) => k + 1);
    resetTimer();
  }, [currentTrack?.key, resetTimer]);

  const next = nextQueueTrack(queue, queueIndex);
  const nextTrack = next?.track ?? null;

  const nextSrc = nextTrack
    ? resolveImageSrc(
        nextTrack.image_url
          ?? (nextTrack.album_title ? getAlbumImage(nextTrack.album_title, nextTrack.artist_name) : null)
          ?? (nextTrack.artist_name ? getArtistImage(nextTrack.artist_name) : null),
      )
    : null;

  return (
    <div ref={rootRef} className={`video-ambient${visible ? " is-visible" : ""}`}>
      {syncedLyricLines && (
        <button
          className={`video-ambient-lyrics-toggle video-ambient-fade${subtitlesOn ? "" : " is-off"}`}
          onClick={onToggleSubtitles}
          title={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
          aria-label={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
          aria-pressed={subtitlesOn}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 14.5a2 2 0 0 1 0-4" />
            <path d="M15 14.5a3 3 0 0 1 0-4" />
          </svg>
        </button>
      )}

      {/* Only while subtitles are actually up: this is the surface the offset
          exists for (a music video's intro shifts every line), but a control for
          something that isn't on screen is just clutter. */}
      {syncedLyricLines && subtitlesOn && onLyricsOffsetChange && (
        <LyricsOffsetControl
          offsetSecs={lyricsOffsetSecs}
          onChange={onLyricsOffsetChange}
          className="video-ambient-offset video-ambient-fade"
        />
      )}

      {onToggleFullscreen && (
        <button
          className="video-ambient-fs video-ambient-fade"
          onClick={onToggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? (
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

      {currentTrack && (
        <div key={introKey} className="video-ambient-intro video-ambient-fade anim-slide-text-in">
          <div className="video-ambient-intro-title">{currentTrack.title}</div>
          {(() => {
            const sub = [currentTrack.artist_name, currentTrack.album_title].filter(Boolean).join(" · ");
            return sub ? <div className="video-ambient-intro-sub">{sub}</div> : null;
          })()}
          {tags.length > 0 && (
            <div className="video-ambient-intro-tags">
              {tags.map((t) => (
                <span key={t} className="video-ambient-intro-tag">{t}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {next && nextTrack && (
        <div className="video-ambient-chip video-ambient-fade">
          <div className="video-ambient-chip-label">Up next</div>
          <button
            className="video-ambient-chip-row"
            onClick={() => onPlayQueueIndex?.(next.index)}
            title={`Play ${nextTrack.title}`}
          >
            {nextSrc ? (
              <img className="video-ambient-chip-art" src={nextSrc} alt="" />
            ) : (
              <span className="video-ambient-chip-art">{getInitials(nextTrack.title)}</span>
            )}
            <span className="video-ambient-chip-info">
              <span className="video-ambient-chip-title">{nextTrack.title}</span>
              {nextTrack.artist_name && (
                <span className="video-ambient-chip-artist">{nextTrack.artist_name}</span>
              )}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
