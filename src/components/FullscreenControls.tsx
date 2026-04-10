import { useState, useEffect, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { AutoContinuePopover } from "./AutoContinuePopover";
import { WaveformSeekBar } from "./WaveformSeekBar";

interface FullscreenControlsProps {
  waveformPeaks: number[] | null;
  currentTrack: Track | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  scrobbled: boolean;
  volume: number;
  queueMode: "normal" | "loop" | "shuffle";
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
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onToggleLike: () => void;
  onToggleDislike?: () => void;
  onToggleFullscreen: () => void;
  showQueue: boolean;
  onToggleQueue: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
}

const IDLE_TIMEOUT = 3000;

export function FullscreenControls({
  waveformPeaks,
  currentTrack, playing,
  positionSecs, durationSecs, scrobbled,
  volume, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
  onToggleLike, onToggleDislike, onToggleFullscreen, showQueue, onToggleQueue, onArtistClick, onAlbumClick,
}: FullscreenControlsProps) {
  const [visible, setVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const timerRef = useRef<number>(0);
  const draggingRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Track fullscreen state
  useEffect(() => {
    const onChange = () => {
      const fs = !!document.fullscreenElement;
      setIsFullscreen(fs);
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
      <div
        className="fs-seek-bar"
        onClick={(e) => {
          if (!durationSecs) return;
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          onSeek(pct * durationSecs);
        }}
      >
        {waveformPeaks ? (
          <WaveformSeekBar
            peaks={waveformPeaks}
            progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
            accentColor="rgba(83, 168, 255, 0.8)"
            dimColor="rgba(255, 255, 255, 0.2)"
          />
        ) : (
          <div className="fs-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
        )}
        <span className="fs-seek-time fs-seek-elapsed">{formatDuration(positionSecs)}</span>
        <span className="fs-seek-time fs-seek-total">
          {formatDuration(durationSecs)}
          {scrobbled && <span className="fs-scrobbled" title="Logged to play history">{"\u2713"}</span>}
        </span>
      </div>
      <div className="fs-main">
        <div className="fs-info">
          {imagePath && <img className="fs-art" src={convertFileSrc(imagePath)} alt="" />}
          <div className="fs-info-text">
            {currentTrack ? (
              <>
                <span className="fs-title">{currentTrack.title}</span>
                <span className="fs-subtitle">
                  <span className="fs-link" onClick={currentTrack.artist_id ? () => onArtistClick(currentTrack.artist_id!) : undefined}>{currentTrack.artist_name || "Unknown"}</span>
                  {currentTrack.album_id && currentTrack.album_title && (
                    <><span className="fs-sep"> — </span><span className="fs-link" onClick={() => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id)}>{currentTrack.album_title}</span></>
                  )}
                </span>
              </>
            ) : null}
          </div>
          {currentTrack && (
            <>
              <button
                className={`g-btn g-btn-sm${currentTrack.liked === 1 ? " liked" : ""}`}
                onClick={onToggleLike}
                title={currentTrack.liked === 1 ? "Unlike" : "Like"}
              >
                {currentTrack.liked === 1
                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
              </button>
              {onToggleDislike && <button
                className={`g-btn g-btn-xs${currentTrack.liked === -1 ? " disliked" : ""}`}
                onClick={onToggleDislike}
                title={currentTrack.liked === -1 ? "Remove hate" : "Hate"}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>}
            </>
          )}
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
          <button
            className={`g-btn g-btn-sm${queueMode !== "normal" ? " active" : ""}`}
            onClick={onToggleQueueMode}
            title={queueMode === "normal" ? "Normal" : queueMode === "loop" ? "Loop" : "Shuffle"}
          >
            {queueMode === "shuffle"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>
              : queueMode === "loop"
              ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>}
          </button>
          <div className="auto-continue-wrapper">
            <button
              className={`g-btn g-btn-sm${autoContinueEnabled ? " active" : ""}`}
              onClick={onToggleAutoContinuePopover}
              title="Auto Continue"
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
              />
            )}
          </div>
          <div className="fs-volume">
            <button className="g-btn g-btn-sm" onClick={onMute} title="Mute">
              {volume === 0
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                : volume < 0.5
                ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>}
            </button>
            <input
              type="range"
              className="volume-slider"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              style={{ background: `linear-gradient(to right, var(--accent) ${volume * 100}%, rgba(255,255,255,0.12) ${volume * 100}%)` }}
              onChange={(e) => onVolume(parseFloat(e.target.value))}
              onMouseDown={handleDragStart}
              onMouseUp={handleDragEnd}
            />
          </div>
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
            title="Exit fullscreen (F)"
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
  );
}
