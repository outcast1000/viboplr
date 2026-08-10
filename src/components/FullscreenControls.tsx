import { useState, useEffect, useRef, useCallback } from "react";
import type { QueueTrack, QueueMode } from "../types";
import { resolveImageUrl } from "../utils/resolveImageUrl";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { usePlaybackPosition } from "../playback/positionStore";
import { AutoContinuePopover } from "./AutoContinuePopover";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { FilmstripSeekBar } from "./FilmstripSeekBar";
import { StoryboardTile } from "./StoryboardTile";
import { tileIndexAt, type Storyboard } from "../utils/storyboard";
// Bubble thumbnail width. Sheet tiles are larger (up to 400px) to serve the hero
// art, so the bubble downscales — percentage-based positioning keeps it sharp.
const SEEK_THUMB_WIDTH = 176;
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import { BufferingChip } from "./BufferingChip";
import { bufferedFraction, type PlaybackBuffer } from "../playback/bufferState";

interface FullscreenControlsProps {
  waveformPeaks: number[] | null;
  /** Seek-preview tiles for the current video track; null for audio. */
  storyboard: Storyboard | null;
  currentTrack: QueueTrack | null;
  playing: boolean;
  durationSecs: number;
  scrobbled: boolean;
  /** Buffer state of the current source, or null when no engine reported one.
   *  Same contract as the now-playing bar's. */
  buffer?: PlaybackBuffer | null;
  volume: number;
  muted: boolean;
  queueMode: QueueMode;
  autoContinueEnabled: boolean;
  autoContinueSameFormat: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  imagePath: string | null;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onMute: () => void;
  onToggleQueueMode: () => void;
  onRandomize: () => void;
  queueLength: number;
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAutoContinueWeights: () => void;
  onCloseAutoContinuePopover: () => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  onToggleFullscreen: () => void;
  showQueue: boolean;
  onToggleQueue: () => void;
  /** Whether synced lyrics exist for the current video (gates the subtitle toggle). */
  hasSubtitles: boolean;
  subtitlesOn: boolean;
  onToggleSubtitles: () => void;
  onNavigateToArtistByName: (name: string) => void;
  onNavigateToAlbumByName: (name: string, artistName?: string | null) => void;
  /**
   * Treat this as a live fullscreen presentation even though there is no DOM
   * `:fullscreen` element.
   *
   * Two surfaces need it, both of which use WINDOW fullscreen: the audio /
   * visualizer overlay (see AudioFullscreen) and **native mpv video**
   * (`.video-container--native-fs`). In both, `document.fullscreenElement` is
   * null, so the idle auto-hide and the cursor-hiding — both gated on it — never
   * arm and the controls sit permanently over the picture. Only the browser
   * engine's video fullscreen is a real DOM `:fullscreen`, which is detected
   * without help.
   */
  active?: boolean;
}

const IDLE_TIMEOUT = 3000;

export function FullscreenControls({
  waveformPeaks,
  storyboard,
  currentTrack, playing,
  durationSecs, scrobbled, buffer,
  volume, muted, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode, onRandomize, queueLength,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight, onResetAutoContinueWeights, onCloseAutoContinuePopover,
  onToggleLike, onToggleDislike, onToggleFullscreen, showQueue, onToggleQueue, hasSubtitles, subtitlesOn, onToggleSubtitles, onNavigateToArtistByName, onNavigateToAlbumByName,
  active = false,
}: FullscreenControlsProps) {
  // Subscribed here (not passed from App) so the ~4 Hz position tick re-renders
  // only this overlay.
  const positionSecs = usePlaybackPosition();
  const bufferedPct = bufferedFraction(buffer?.bufferedToSecs ?? null, durationSecs);
  const [visible, setVisible] = useState(true);
  const [domFullscreen, setDomFullscreen] = useState(false);
  // Either kind of fullscreen counts: the video path uses a DOM :fullscreen
  // element, the audio path uses window fullscreen + a pinned overlay.
  const isFullscreen = active || domFullscreen;
  const timerRef = useRef<number>(0);
  const draggingRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const fsAcAnchorRef = useRef<HTMLButtonElement>(null);
  // Scrub preview: pct picks the storyboard tile, x positions the bubble
  // (px within .fs-seek-wrap).
  const [seekHover, setSeekHover] = useState<{ pct: number; x: number } | null>(null);
  const seekWrapRef = useRef<HTMLDivElement>(null);

  // Track fullscreen state
  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setDomFullscreen(fs);
      if (!fs) {
        clearTimeout(timerRef.current);
        setVisible(true);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  // Auto-hide timer
  const resetTimer = useCallback(() => {
    setVisible(true);
    clearTimeout(timerRef.current);
    if (playing && !draggingRef.current) {
      timerRef.current = window.setTimeout(() => setVisible(false), IDLE_TIMEOUT);
    }
  }, [playing]);

  // Reset timer when play state changes (keep visible while paused)
  useEffect(() => {
    if (!isFullscreen) return;
    if (!playing) {
      clearTimeout(timerRef.current);
      setVisible(true);
    } else {
      resetTimer();
    }
  }, [playing, isFullscreen, resetTimer]);

  // Mousemove on the fullscreen container (parent of this component)
  useEffect(() => {
    if (!isFullscreen) return;
    const container = overlayRef.current?.parentElement;
    if (!container) return;
    const onMove = () => resetTimer();
    container.addEventListener("mousemove", onMove);
    return () => container.removeEventListener("mousemove", onMove);
  }, [isFullscreen, resetTimer]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    resetTimer();
  };

  const handleDragStart = () => {
    draggingRef.current = true;
    clearTimeout(timerRef.current);
  };

  const handleDragEnd = () => {
    draggingRef.current = false;
    resetTimer();
  };

  // Apply cursor style to fullscreen container
  useEffect(() => {
    if (!isFullscreen) return;
    const container = overlayRef.current?.parentElement;
    if (!container) return;
    container.style.cursor = visible ? "default" : "none";
    return () => { container.style.cursor = ""; };
  }, [isFullscreen, visible]);

  return (
    <div
      ref={overlayRef}
      className={`fs-controls${visible ? " fs-visible" : ""}`}
      onClick={handleOverlayClick}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* The bubble has to live outside .fs-seek-bar, which clips (overflow: hidden).
          Mirrors .now-seek-wrap in the now-playing bar. */}
      <div className="fs-seek-wrap" ref={seekWrapRef}>
      <div
        className="fs-seek-bar"
        onClick={(e) => {
          if (!durationSecs) return;
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          onSeek(pct * durationSecs);
        }}
        onMouseMove={(e) => {
          // Deliberately no stopPropagation: the overlay's idle timer watches
          // mousemove, and swallowing it here would hide the controls mid-scrub.
          if (!durationSecs) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          const wrapLeft = seekWrapRef.current?.getBoundingClientRect().left ?? rect.left;
          setSeekHover({ pct, x: e.clientX - wrapLeft });
        }}
        onMouseLeave={() => setSeekHover(null)}
      >
        {/* Video fullscreen usually has a storyboard; audio fullscreen never does
            and falls to the waveform. The flat fill is the last resort — a video
            whose board never resolved, or audio with no cached waveform. */}
        {storyboard && durationSecs > 0 ? (
          <FilmstripSeekBar
            board={storyboard}
            durationSecs={durationSecs}
            progress={positionSecs / durationSecs}
            hoverPct={seekHover?.pct ?? null}
            bufferedPct={bufferedPct}
          />
        ) : waveformPeaks ? (
          <WaveformSeekBar
            peaks={waveformPeaks}
            progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
          />
        ) : (
          <>
            {/* The flat fill is what a NETWORK audio track actually gets here —
                no storyboard (audio) and no waveform (those are local-only), so
                this is the only branch the buffered edge can ever reach. Drawn
                as a band under the played fill, the shape every video player
                uses. Absent when `bufferedPct` is null (any local source), so
                that case renders exactly as it did before. */}
            {bufferedPct != null && (
              <div className="fs-seek-buffered" style={{ width: `${bufferedPct * 100}%` }} />
            )}
            <div className="fs-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
          </>
        )}
        <BufferingChip buffer={buffer} />
        <span className="fs-seek-time fs-seek-elapsed">{formatDuration(positionSecs)}</span>
        <span className="fs-seek-time fs-seek-total">
          {formatDuration(durationSecs)}
          {scrobbled && <span className="fs-scrobbled" title="Logged to play history">{"\u2713"}</span>}
        </span>
      </div>
      {seekHover !== null && durationSecs > 0 && (() => {
        const hoverSecs = seekHover.pct * durationSecs;
        const tile = storyboard ? tileIndexAt(storyboard, hoverSecs) : null;
        return (
          <div
            className={`fs-seek-bubble${tile !== null ? " has-thumb" : ""}`}
            style={{ left: seekHover.x }}
          >
            {tile !== null && storyboard && (
              <StoryboardTile
                board={storyboard}
                index={tile}
                className="seek-preview-thumb"
                width={SEEK_THUMB_WIDTH}
                height={Math.round(SEEK_THUMB_WIDTH * (storyboard.tileH / storyboard.tileW))}
              />
            )}
            <span>{formatDuration(hoverSecs)}</span>
          </div>
        );
      })()}
      </div>
      <div className="fs-main">
        <div className="fs-info">
          {imagePath && <img className="fs-art" src={resolveImageUrl(imagePath)} alt="" />}
          <div className="fs-like-col">
            {currentTrack && (
              <LikeDislikeButtons
                liked={currentTrack.liked}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                variant="glass"
                size={13}
              />
            )}
          </div>
          <div className="fs-info-text">
            {currentTrack ? (
              <>
                <span className="fs-title">{currentTrack.title}</span>
                <span className="fs-subtitle">
                  <span className="fs-link" onClick={currentTrack.artist_name ? () => onNavigateToArtistByName(currentTrack.artist_name!) : undefined}>{currentTrack.artist_name || "Unknown"}</span>
                  {currentTrack.album_title && (
                    <><span className="fs-sep"> — </span><span className="fs-link" onClick={() => onNavigateToAlbumByName(currentTrack.album_title!, currentTrack.artist_name)}>{currentTrack.album_title}</span></>
                  )}
                </span>
              </>
            ) : null}
          </div>
        </div>
        <div className="fs-center">
          <button className="g-btn g-btn-md" onClick={onPrevious} title="Previous">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button className="g-btn g-btn-play fs-play-btn" onClick={onPause} title="Play / Pause">
            {playing
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
          </button>
          <button className="g-btn g-btn-md" onClick={onNext} title="Next">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
          </button>
          <button className="g-btn g-btn-xs" onClick={onStop} title="Stop">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          </button>
        </div>
        <div className="fs-right">
          <div className="fs-group">
          <button
            className={`g-btn g-btn-sm${queueMode !== "normal" ? " active" : ""}`}
            onClick={onToggleQueueMode}
            title={queueMode === "normal" ? "Normal" : queueMode === "repeat-all" ? "Repeat All" : "Repeat One"}
          >
            {queueMode === "repeat-one"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M11.5 9 13 8.3V16"/></svg>
              : queueMode === "repeat-all"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>}
          </button>
          <button
            className="g-btn g-btn-sm"
            onClick={onRandomize}
            disabled={queueMode === "repeat-one" || queueLength < 2}
            title="Randomize queue order"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>
          </button>
          <div className="auto-continue-wrapper">
            <button
              ref={fsAcAnchorRef}
              className={`g-btn g-btn-sm${autoContinueEnabled && queueMode === "normal" ? " active" : ""}`}
              onClick={onToggleAutoContinuePopover}
              disabled={queueMode !== "normal"}
              title={queueMode === "normal" ? "Auto Continue" : "Auto Continue (only in Normal mode)"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 12c-2-2.67-4-4-6-4a4 4 0 1 0 0 8c2 0 4-1.33 6-4zm0 0c2 2.67 4 4 6 4a4 4 0 0 0 0-8c-2 0-4 1.33-6 4z"/></svg>
            </button>
            {showAutoContinuePopover && (
              <AutoContinuePopover
                enabled={autoContinueEnabled}
                sameFormat={autoContinueSameFormat}
                weights={autoContinueWeights}
                onToggle={onToggleAutoContinue}
                onToggleSameFormat={onToggleAutoContinueSameFormat}
                onAdjust={onAdjustAutoContinueWeight}
                onResetAll={onResetAutoContinueWeights}
                onClose={onCloseAutoContinuePopover}
                anchorRef={fsAcAnchorRef}
              />
            )}
          </div>
          </div>
          <div className="fs-group">
          <div className="fs-volume">
            <button className={`g-btn g-btn-sm${muted ? " is-muted" : ""}`} onClick={onMute} title="Mute">
              {muted || volume === 0
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                : volume < 0.5
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>}
            </button>
            <input
              type="range"
              className={`volume-slider${muted ? " is-muted" : ""}`}
              min="0"
              max="1"
              step="0.01"
              value={volume}
              style={{ background: `linear-gradient(to right, ${muted ? "var(--text-tertiary)" : "var(--accent)"} ${volume * 100}%, rgba(var(--overlay-base), 0.12) ${volume * 100}%)` }}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
              onMouseDown={handleDragStart}
              onMouseUp={handleDragEnd}
            />
          </div>
          </div>
          <div className="fs-group">
          {hasSubtitles && (
            <button
              className={`g-btn g-btn-sm${subtitlesOn ? " active" : ""}`}
              onClick={onToggleSubtitles}
              title={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
              aria-label={subtitlesOn ? "Hide subtitles" : "Show subtitles"}
              aria-pressed={subtitlesOn}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <path d="M7 14.5a2 2 0 0 1 0-4" />
                <path d="M15 14.5a3 3 0 0 1 0-4" />
              </svg>
            </button>
          )}
          <button
            className={`g-btn g-btn-sm${showQueue ? " active" : ""}`}
            onClick={onToggleQueue}
            title="Playlist"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <button
            className="g-btn g-btn-sm"
            onClick={onToggleFullscreen}
            title="Exit fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}
