import { useState, useEffect, useRef, useCallback } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { AutoContinuePopover } from "./AutoContinuePopover";

interface FullscreenControlsProps {
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
  onToggleFullscreen: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
}

const IDLE_TIMEOUT = 3000;

export function FullscreenControls({
  currentTrack, playing,
  positionSecs, durationSecs, scrobbled,
  volume, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
  onToggleLike, onToggleFullscreen, onArtistClick, onAlbumClick,
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
        <div className="fs-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
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
            <span
              className={`fs-like-btn${currentTrack.liked ? " liked" : ""}`}
              onClick={onToggleLike}
              title={currentTrack.liked ? "Unlike" : "Like"}
            >{currentTrack.liked ? "\u2665" : "\u2661"}</span>
          )}
        </div>
        <div className="fs-center">
          <button className="ctrl-btn" onClick={onPrevious} title="Previous">{"\u23EE"}</button>
          <button className="ctrl-btn fs-play-btn" onClick={onPause} title="Play / Pause">
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button className="ctrl-btn" onClick={onNext} title="Next">{"\u23ED"}</button>
          <button className="ctrl-btn" onClick={onStop} title="Stop">{"\u23F9"}</button>
          <span className="fs-time">
            {formatDuration(positionSecs)} / {formatDuration(durationSecs)}
            {scrobbled && <span className="fs-scrobbled" title="Logged to play history">{"\u2713"}</span>}
          </span>
        </div>
        <div className="fs-right">
          <button
            className={`ctrl-btn mode-btn ${queueMode !== "normal" ? "active" : ""}`}
            onClick={onToggleQueueMode}
            title={queueMode === "normal" ? "Normal" : queueMode === "loop" ? "Loop" : "Shuffle"}
          >
            {queueMode === "shuffle" ? "\uD83D\uDD00" : queueMode === "loop" ? "\uD83D\uDD01" : "\u27A1"}
          </button>
          <div className="auto-continue-wrapper">
            <button
              className={`ctrl-btn auto-continue-btn ${autoContinueEnabled ? "active" : ""}`}
              onClick={onToggleAutoContinuePopover}
              title="Auto Continue"
            >
              {"\u221E"}
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
            <span className="volume-icon" onClick={onMute} title="Mute" dangerouslySetInnerHTML={{ __html: volume === 0
              ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
              : volume < 0.5
              ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`
              : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`
            }} />
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
            className="ctrl-btn fs-exit-btn"
            onClick={onToggleFullscreen}
            title="Exit fullscreen (F)"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
