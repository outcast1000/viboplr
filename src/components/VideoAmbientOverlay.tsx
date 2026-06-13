import { useEffect, useRef, useState, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { getInitials } from "../utils";
import { extractDominantColor, type RGB } from "../utils/extractDominantColor";
import { nextQueueTrack, glowColorValue } from "../utils/videoOverlay";
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
}

/** Resolve a local image path to a webview-usable src (remote URLs pass
 *  through). Mirrors the per-surface helper in NowPlayingView/QueuePanel. */
function toSrc(path: string | null): string | null {
  if (!path) return null;
  if (/^(https?:|data:)/.test(path)) return path;
  if (path.startsWith("file://")) return convertFileSrc(path.substring(7));
  return convertFileSrc(path);
}

export function VideoAmbientOverlay({
  currentTrack,
  playing,
  queue,
  queueIndex,
  getAlbumImage,
  getArtistImage,
  onPlayQueueIndex,
}: VideoAmbientOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number>(0);
  const [visible, setVisible] = useState(true);
  const [glow, setGlow] = useState<RGB | null>(null);
  // Bump on track change to re-trigger the intro slide-in animation.
  const [introKey, setIntroKey] = useState(0);

  // Sample the glow color from the (already-resolved) current track image.
  useEffect(() => {
    let cancelled = false;
    const src = toSrc(currentTrack?.image_url ?? null);
    if (!src) { setGlow(null); return; }
    extractDominantColor(src).then((rgb) => {
      if (!cancelled) setGlow(rgb);
    });
    return () => { cancelled = true; };
  }, [currentTrack?.image_url]);

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
    ? toSrc(
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

      {currentTrack && (
        <div key={introKey} className="video-ambient-intro video-ambient-fade anim-slide-text-in">
          <div className="video-ambient-intro-title">{currentTrack.title}</div>
          {currentTrack.artist_name && (
            <div className="video-ambient-intro-sub">{currentTrack.artist_name}</div>
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
