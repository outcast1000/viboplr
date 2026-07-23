import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveImageSrc } from "../utils/resolveImageUrl";
import type { QueueTrack } from "../types";
import { getInitials } from "../utils";
import { extractDominantColor, type RGB } from "../utils/extractDominantColor";
import { nextQueueTrack, glowColorValue } from "../utils/videoOverlay";
import { currentSyncedLineIndex, type LrcLine } from "../utils/lyrics";
import { usePlaybackPosition } from "../playback/positionStore";
import { store } from "../store";
import "./VideoAmbientOverlay.css";

const IDLE_TIMEOUT = 3000;

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
   *  good enough duration match. When present, a subtitle-style current-line
   *  overlay is offered (user-toggleable, persisted). */
  syncedLyricLines?: LrcLine[] | null;
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
}: VideoAmbientOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>(0);
  const [visible, setVisible] = useState(true);
  const [glow, setGlow] = useState<RGB | null>(null);
  // Bump on track change to re-trigger the intro slide-in animation.
  const [introKey, setIntroKey] = useState(0);

  // Subtitle-style lyrics-over-video toggle (persisted, default on). Self-
  // contained here: App decides *whether lyrics are available* (and passes them
  // in); this button decides whether to *show* them.
  const [lyricsOn, setLyricsOn] = useState(true);
  useEffect(() => {
    store.get<boolean>("videoLyricsOverlay").then((v) => {
      if (v === false) setLyricsOn(false);
    }).catch(console.error);
  }, []);
  const toggleLyrics = useCallback(() => {
    setLyricsOn((on) => {
      const next = !on;
      store.set("videoLyricsOverlay", next).catch(console.error);
      return next;
    });
  }, []);

  // Mirror document fullscreen state so the FS button shows enter/exit correctly.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement);
    onChange();
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Sample the glow color from the (already-resolved) current track image.
  useEffect(() => {
    let cancelled = false;
    const src = resolveImageSrc(currentTrack?.image_url ?? null);
    if (!src) { setGlow(null); return; }
    extractDominantColor(src).then((rgb) => {
      if (!cancelled) setGlow(rgb);
    });
    return () => { cancelled = true; };
  }, [currentTrack?.image_url]);

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

  // Idle-timer visibility: mirror FullscreenControls — show on activity, hide
  // after the timeout while playing, stay visible while paused.
  const resetTimer = useCallback(() => {
    setVisible(true);
    clearTimeout(timerRef.current);
    if (playing) {
      timerRef.current = window.setTimeout(() => setVisible(false), IDLE_TIMEOUT);
    }
  }, [playing]);

  // Re-show + re-arm whenever play state flips (stay visible while paused).
  useEffect(() => {
    if (!playing) {
      clearTimeout(timerRef.current);
      setVisible(true);
    } else {
      resetTimer();
    }
  }, [playing, resetTimer]);

  // Track change: re-trigger intro animation and re-show.
  useEffect(() => {
    setIntroKey((k) => k + 1);
    resetTimer();
  }, [currentTrack?.key, resetTimer]);

  // Show on mouse movement over the video container (our parent).
  useEffect(() => {
    const container = rootRef.current?.parentElement;
    if (!container) return;
    const onMove = () => resetTimer();
    container.addEventListener("mousemove", onMove);
    return () => container.removeEventListener("mousemove", onMove);
  }, [resetTimer]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

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
    <div
      ref={rootRef}
      className={`video-ambient${visible ? " is-visible" : ""}`}
      style={{ ["--glow-color" as string]: glowColorValue(glow) }}
    >
      <div className="video-ambient-glow" />

      {syncedLyricLines && (
        <button
          className={`video-ambient-lyrics-toggle video-ambient-fade${lyricsOn ? "" : " is-off"}`}
          onClick={toggleLyrics}
          title={lyricsOn ? "Hide lyrics" : "Show lyrics"}
          aria-label={lyricsOn ? "Hide lyrics" : "Show lyrics"}
          aria-pressed={lyricsOn}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M7 14.5a2 2 0 0 1 0-4" />
            <path d="M15 14.5a3 3 0 0 1 0-4" />
          </svg>
        </button>
      )}

      {syncedLyricLines && lyricsOn && <VideoLyrics lines={syncedLyricLines} />}

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

/** Subtitle-style current synced line (+ the upcoming line, dimmer) over the
 *  video. Subscribes to the ~4 Hz position tick at this leaf so only this line
 *  re-renders. Shows nothing during the intro / instrumental gaps (no active
 *  line), matching the mini-player's synced-lyrics behavior. */
function VideoLyrics({ lines }: { lines: LrcLine[] }) {
  const position = usePlaybackPosition();
  const idx = currentSyncedLineIndex(lines, position);
  const current = idx >= 0 ? lines[idx].text.trim() : "";
  if (!current) return null; // before the first line, or a blank gap line
  let next = "";
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].text.trim();
    if (t) { next = t; break; }
  }
  return (
    <div className="video-ambient-lyrics">
      <div className="video-ambient-lyric-current">{current}</div>
      {next && <div className="video-ambient-lyric-next">{next}</div>}
    </div>
  );
}
