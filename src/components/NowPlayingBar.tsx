import { useRef, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { QueueTrack } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import type { MiniRestingSize, MiniWidthSize } from "../hooks/useMiniMode";
import { formatDuration } from "../utils";
import { isRemoteScheme } from "../queueEntry";
import { AutoContinuePopover } from "./AutoContinuePopover";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { SegmentedSeekBar } from "./SegmentedSeekBar";
import { LikeDislikeButtons } from "./LikeDislikeButtons";
import "./NowPlayingBar.css";

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";
const isMac = navigator.platform.includes("Mac");

function SourceIcon({ s = 11, isLocal }: { s?: number; isLocal: boolean }) {
  if (isLocal) {
    return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>;
  }
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>;
}

const shortcuts = [
  { keys: "Space", action: "Play / Pause" },
  { keys: "\u2190", action: "Seek Back 15s" },
  { keys: "\u2192", action: "Seek Forward 15s" },
  { keys: "\u2191", action: "Volume Up 10%" },
  { keys: "\u2193", action: "Volume Down 10%" },
  { keys: `${mod}\u2190`, action: "Previous Track" },
  { keys: `${mod}\u2192`, action: "Next Track" },
  { keys: `${mod}L`, action: "Like / Unlike" },
  { keys: `${mod}P`, action: "Toggle Playlist" },
  { keys: `${mod}1`, action: "All Tracks" },
  { keys: `${mod}2`, action: "Artists" },
  { keys: `${mod}3`, action: "Albums" },
  { keys: `${mod}4`, action: "Tags" },
  { keys: `${mod}5`, action: "Liked" },
  { keys: `${mod}6`, action: "History" },
  { keys: `${mod}M`, action: "Mute / Unmute" },
  { keys: `${mod}\u21E7M`, action: "Mini Player" },
];


function SlideText({ text, className }: { text: string; className?: string }) {
  const [key, setKey] = useState(0);
  const prevRef = useRef(text);

  useEffect(() => {
    if (text !== prevRef.current) {
      prevRef.current = text;
      setKey(k => k + 1);
    }
  }, [text]);

  return (
    <span key={key} className={`${className ?? ""} slide-text-enter`}>
      {text}
    </span>
  );
}

interface NowPlayingBarProps {
  waveformPeaks: number[] | null;
  currentTrack: QueueTrack | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  scrobbled: boolean;
  trackRank: number | null;
  artistRank: number | null;
  volume: number;
  queueMode: "normal" | "loop" | "shuffle";
  autoContinueEnabled: boolean;
  autoContinueSameFormat: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  imagePath: string | null;
  miniMode: boolean;
  miniExpanded: boolean;
  miniRestingSize: MiniRestingSize;
  miniWidthSize: MiniWidthSize;
  onCancelCollapseTimer: () => void;
  onCycleRestingSize: () => void;
  onCycleMiniWidth: () => void;
  onToggleMiniMode: () => void;
  onClose: () => void;
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
  onTrackClick: (trackKey: string) => void;
  onNavigateToArtistByName?: (name: string) => void;
  onNavigateToAlbumByName?: (name: string, artistName?: string) => void;
  syncState: boolean;
  onToggleSync: () => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  playbackError?: string | null;
  resolvingStatus?: { error: string | null; trying: string | null } | null;
  resolvedSource?: { name: string; url: string; sourceUrl?: string | null; id?: string | null } | null;
  loadingTrack?: QueueTrack | null;
  onSkipError?: () => void;
  onDownloadTrack?: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function NowPlayingBar({
  waveformPeaks,
  currentTrack, playing,
  positionSecs, durationSecs, scrobbled,
  trackRank, artistRank,
  volume, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath, miniMode, miniExpanded, miniRestingSize, miniWidthSize, onCancelCollapseTimer, onCycleRestingSize, onCycleMiniWidth, onToggleMiniMode, onClose,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
  onToggleLike, onToggleDislike, onTrackClick,
  onNavigateToArtistByName, onNavigateToAlbumByName,
  syncState, onToggleSync,
  showHelp, onToggleHelp,
  playbackError, resolvingStatus, resolvedSource, loadingTrack, onSkipError,
  onDownloadTrack,
  onContextMenu,
}: NowPlayingBarProps) {
  const miniDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const miniVolumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sourceTooltipOpen, setSourceTooltipOpen] = useState(false);
  const [sourceAnchor, setSourceAnchor] = useState<{ x: number; y: number } | null>(null);
  const [audioProps, setAudioProps] = useState<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number } | null>(null);
  const sourceHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceTooltipRef = useRef<HTMLDivElement | null>(null);
  const [showMiniVolume, setShowMiniVolume] = useState(false);
  const [followPulse, setFollowPulse] = useState(false);

  // Pulse the Follow button when sync navigates to a new track
  useEffect(() => {
    if (!syncState || !currentTrack?.key) return;
    setFollowPulse(true);
    const t = setTimeout(() => setFollowPulse(false), 600);
    return () => clearTimeout(t);
  }, [currentTrack?.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Blur any focused element when entering mini mode so no button appears selected
  useEffect(() => {
    if (miniMode) (document.activeElement as HTMLElement)?.blur();
  }, [miniMode]);

  // Fetch audio properties for the current track (local files only). Reset on track change.
  useEffect(() => {
    setAudioProps(null);
    if (!currentTrack?.path) return;
    const isLocal = currentTrack.path.startsWith("file://") || (!currentTrack.path.includes("://") && currentTrack.path.length > 0);
    if (!isLocal) return;
    let cancelled = false;
    invoke<{ sample_rate?: number; bit_depth?: number; channels?: number; bitrate?: number }>(
      "get_audio_properties_by_path",
      { path: currentTrack.path }
    )
      .then(p => { if (!cancelled) setAudioProps(p); })
      .catch(e => console.error("Failed to load audio properties:", e));
    return () => { cancelled = true; };
  }, [currentTrack?.path]);

  // Auto-skip on error in mini mode (5s)
  useEffect(() => {
    if (!miniMode || !playbackError || !onSkipError) return;
    const timer = setTimeout(onSkipError, 5000);
    return () => clearTimeout(timer);
  }, [miniMode, playbackError, onSkipError]);

  if (miniMode) {
    const handleDrag = isMac
      ? (e: React.MouseEvent) => {
          // macOS: startDragging doesn't enter a modal loop, so dblclick fires normally
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.buttons === 1) getCurrentWindow().startDragging();
        }
      : (e: React.MouseEvent) => {
          // Windows: delay startDragging so the OS modal drag loop doesn't swallow the second click
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.buttons !== 1) return;
          e.preventDefault();
          if (e.detail === 2) {
            if (miniDragTimerRef.current) { clearTimeout(miniDragTimerRef.current); miniDragTimerRef.current = null; }
            onToggleMiniMode();
          } else {
            miniDragTimerRef.current = setTimeout(() => {
              miniDragTimerRef.current = null;
              getCurrentWindow().startDragging();
            }, 100);
          }
        };
    const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
    return (
      <footer className={`now-playing now-playing-mini${miniExpanded ? " mini-expanded" : ""}`} onMouseDown={handleDrag} onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu?.(e);
        }} onWheel={(e) => {
          e.preventDefault();
          onVolume(Math.min(1, Math.max(0, volume + (e.deltaY < 0 ? 0.05 : -0.05))));
          setShowMiniVolume(true);
          if (miniVolumeTimerRef.current) clearTimeout(miniVolumeTimerRef.current);
          miniVolumeTimerRef.current = setTimeout(() => setShowMiniVolume(false), 1000);
        }} onDoubleClick={isMac ? (e) => {
          if (!(e.target as HTMLElement).closest("button")) onToggleMiniMode();
        } : undefined}>
        {miniExpanded || miniRestingSize === "normal" ? (
          <div className="mini-compact-row">
            <div className="now-info">
              <div className="now-mini-art-wrapper">
                {imagePath ? (
                  <img className="now-mini-art" src={imagePath.startsWith("http") ? imagePath : convertFileSrc(imagePath)} alt="" />
                ) : (
                  <div className="now-mini-art now-mini-art-placeholder">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="18" height="18">
                      <circle cx="12" cy="12" r="10" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </div>
                )}
              </div>
              <div className="now-mini-info-text">
                {playbackError ? (
                  <>
                    <span className="now-title now-mini-error">Playback failed</span>
                    <span className="now-artist">{currentTrack?.title || "Unknown"}</span>
                  </>
                ) : currentTrack ? (
                  <>
                    <span className="now-title">
                      {currentTrack.title}
                      {trackRank != null && trackRank <= 100 && <span className="now-rank-badge" title={`Track rank #${trackRank}`}>#{trackRank}</span>}
                    </span>
                    {showMiniVolume ? (
                      <div className="mini-volume-row">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/>{volume > 0 && <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>}{volume > 0.5 && <path d="M19 12c0 3.53-2.04 6.58-5 8.05v2.08c4.12-1.57 7-5.47 7-10.13s-2.88-8.56-7-10.13V3.95c2.96 1.47 5 4.52 5 8.05z"/>}</svg>
                        <div className="mini-volume-track">
                          <div className="mini-volume-fill" style={{ width: `${Math.round(volume * 100)}%` }} />
                        </div>
                        <span className="mini-volume-pct">{Math.round(volume * 100)}%</span>
                      </div>
                    ) : (
                      <span className="now-artist">
                        {loadingTrack && loadingTrack.key !== currentTrack.key ? (
                          <span className="now-resolving-trying">
                            Loading {loadingTrack.title}
                            {resolvingStatus?.trying && ` · ${resolvingStatus.trying}`}...
                          </span>
                        ) : resolvingStatus ? (
                          <>
                            {resolvingStatus.error && (
                              <><span className="now-resolving-error">{resolvingStatus.error}</span><span className="now-resolving-sep"> · </span></>
                            )}
                            <span className="now-resolving-trying">Trying {resolvingStatus.trying}...</span>
                          </>
                        ) : (
                          <>
                            {currentTrack.artist_name || "Unknown"}
                            {currentTrack.album_title && ` · ${currentTrack.album_title}`}
                          </>
                        )}
                      </span>
                    )}
                  </>
                ) : loadingTrack ? (
                  <>
                    <span className="now-title"><SlideText text={loadingTrack.title} /></span>
                    <span className="now-artist">
                      <span className="now-resolving-trying">Loading...</span>
                    </span>
                  </>
                ) : (
                  <span className="now-title">No track playing</span>
                )}
              </div>
            </div>
            <div className="mini-right">
              <div className="now-controls">
                <button className="g-btn g-btn-md mini-play-btn" onClick={onPause} title="Play / Pause">
                  {playing
                    ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                    : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
                </button>
                <button className="g-btn g-btn-sm" onClick={onNext} title="Next">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
                </button>
              </div>
            </div>
            {!miniExpanded && <div className="mini-progress" style={{ transform: `scaleX(${progress / 100})` }} />}
          </div>
        ) : (
          <div className="mini-ultra-row">
            {currentTrack && (
              <span className={`mini-ultra-indicator${playing ? " playing" : ""}`}>
                {playing ? (
                  <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="0" y="2" width="2.5" height="8" rx="0.5" className="eq-bar eq-bar-1" />
                    <rect x="4" y="0" width="2.5" height="12" rx="0.5" className="eq-bar eq-bar-2" />
                    <rect x="8" y="3" width="2.5" height="7" rx="0.5" className="eq-bar eq-bar-3" />
                  </svg>
                ) : (
                  <svg width="8" height="8" viewBox="0 0 12 12" fill="currentColor">
                    <rect x="2" y="3" width="3" height="6" rx="0.75" />
                    <rect x="7" y="3" width="3" height="6" rx="0.75" />
                  </svg>
                )}
              </span>
            )}
            <span className="mini-ultra-title">
              {playbackError
                ? "Playback failed"
                : currentTrack
                  ? <><span className="mini-ultra-track">{currentTrack.title}</span><span className="mini-ultra-sep"> — </span><span className="mini-ultra-artist">{currentTrack.artist_name || "Unknown"}{currentTrack.album_title && ` · ${currentTrack.album_title}`}</span></>
                  : loadingTrack
                    ? `Loading ${loadingTrack.title}…`
                    : "No track playing"}
            </span>
            <div className="mini-progress" style={{ transform: `scaleX(${progress / 100})` }} />
          </div>
        )}
        {miniExpanded && (
          <>
            <div className="mini-seek-row" onMouseDown={(e) => e.stopPropagation()}>
              <span className="mini-seek-time">{formatDuration(positionSecs)}</span>
              <div className="mini-seek-track" onClick={(e) => {
                if (!durationSecs) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                onSeek(pct * durationSecs);
              }}>
                <div className="mini-seek-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="mini-seek-time mini-seek-total">{formatDuration(durationSecs)}</span>
            </div>
            <div className="mini-extra-row">
              <div className="mini-extra-left">
                {currentTrack && (
                  <LikeDislikeButtons
                    liked={currentTrack.liked}
                    onToggleLike={onToggleLike}
                    onToggleDislike={onToggleDislike}
                    variant="glass"
                    size={12}
                  />
                )}
              </div>
              <div className="mini-extra-right">
                <button className="g-btn g-btn-sm" onClick={onPrevious} title="Previous">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                </button>
                <button
                  className="g-btn g-btn-sm"
                  onClick={onCycleMiniWidth}
                  title={`Width: ${miniWidthSize === "small" ? "Small" : miniWidthSize === "medium" ? "Medium" : "Large"}`}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8l4 4-4 4"/><path d="M6 8l-4 4 4 4"/><line x1="2" y1="12" x2="22" y2="12"/></svg>
                </button>
                <button
                  className="g-btn g-btn-rect mini-resting-size-btn"
                  onClick={onCycleRestingSize}
                  title={miniRestingSize === "normal" ? "Switch to compact" : "Switch to normal"}
                >
                  <svg width="12" height="10" viewBox="0 0 24 16" fill="none">
                    <rect x="2" y="2" width="20" height="4" rx="1.5" fill="currentColor" opacity={miniRestingSize === "normal" ? 1 : 0.25} />
                    <rect x="5" y="11" width="14" height="2" rx="1" fill="currentColor" opacity={miniRestingSize === "compact" ? 1 : 0.25} />
                  </svg>
                  <span className="mini-resting-size-label">{miniRestingSize === "normal" ? "Normal" : "Compact"}</span>
                </button>
                <button className="g-btn mini-expand-btn" onClick={() => { onCancelCollapseTimer(); onToggleMiniMode(); }} title="Exit mini mode">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
                </button>
                <button className="g-btn mini-close-btn" onClick={() => { onCancelCollapseTimer(); onClose(); }} title="Close">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          </>
        )}
      </footer>
    );
  }

  return (
    <footer className="now-playing">
      <div
        className="now-seek-bar"
        onClick={(e) => {
          if (!durationSecs) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const pct = (e.clientX - rect.left) / rect.width;
          onSeek(pct * durationSecs);
        }}
      >
        {waveformPeaks ? (
          <WaveformSeekBar
            peaks={waveformPeaks}
            progress={durationSecs > 0 ? positionSecs / durationSecs : 0}
            accentColor="rgba(83, 168, 255, 0.7)"
            dimColor="rgba(255, 255, 255, 0.15)"
          />
        ) : durationSecs > 0 ? (
          <SegmentedSeekBar
            progress={positionSecs / durationSecs}
            durationSecs={durationSecs}
          />
        ) : null}
        <span className="now-seek-time now-seek-elapsed">{formatDuration(positionSecs)}</span>
        <span className="now-seek-time now-seek-total">
          {formatDuration(durationSecs)}
          {scrobbled && <span className="now-scrobbled" title="Logged to play history">{"\u2713"}</span>}
        </span>
      </div>
      <div className="now-main">
        <div className="now-info">
          <div className={`now-art-wrapper${playing ? " playing" : ""}`}>
            {imagePath ? (
              <img className="now-art" src={imagePath.startsWith("http") ? imagePath : convertFileSrc(imagePath)} alt="" />
            ) : (
              <div className="now-art now-art-placeholder">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" width="24" height="24">
                  <circle cx="12" cy="12" r="10" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </div>
            )}
          </div>
          <div className="now-like-col">
            {currentTrack && (
              <LikeDislikeButtons
                liked={currentTrack.liked}
                onToggleLike={onToggleLike}
                onToggleDislike={onToggleDislike}
                variant="glass"
                size={13}
                showKeyboardHint={`(${mod}L)`}
              />
            )}
          </div>
          <div className="now-info-text">
            {currentTrack ? (
              <>
                <span className="now-title-row">
                  <span className="now-title now-link" onClick={() => onTrackClick(currentTrack.key)}>
                    <SlideText text={currentTrack.title} />
                    {trackRank != null && trackRank <= 100 && <span className="now-rank-badge" title={`Track rank #${trackRank}`}>#{trackRank}</span>}
                  </span>
                  {onDownloadTrack && !currentTrack.path?.startsWith("file://") && (isRemoteScheme(currentTrack.path ?? "") || (resolvedSource && resolvedSource.name !== "Library")) && (
                    <button
                      className="now-download-btn"
                      onClick={onDownloadTrack}
                      title="Download track"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    </button>
                  )}
                </span>
                <span className="now-subtitle">
                  {loadingTrack && loadingTrack.key !== currentTrack.key ? (
                    <span className="now-resolving-trying">
                      Loading {loadingTrack.title}
                      {resolvingStatus?.trying && ` · ${resolvingStatus.trying}`}...
                    </span>
                  ) : (
                    <>
                      {!resolvingStatus && (() => {
                        const path = currentTrack.path ?? "";
                        const isLocal = path.startsWith("file://") || (!path.includes("://") && path.length > 0);
                        return <span
                          className="now-source-icon"
                          onMouseEnter={(e) => {
                            if (sourceHoverTimerRef.current) { clearTimeout(sourceHoverTimerRef.current); sourceHoverTimerRef.current = null; }
                            const rect = e.currentTarget.getBoundingClientRect();
                            setSourceAnchor({ x: rect.left, y: rect.top - 8 });
                            setSourceTooltipOpen(true);
                          }}
                          onMouseLeave={() => {
                            if (sourceHoverTimerRef.current) clearTimeout(sourceHoverTimerRef.current);
                            sourceHoverTimerRef.current = setTimeout(() => setSourceTooltipOpen(false), 150);
                          }}
                        ><SourceIcon isLocal={isLocal} /></span>;
                      })()}
                      {resolvingStatus ? (
                        <>
                          {resolvingStatus.error && (
                            <><span className="now-resolving-error">{resolvingStatus.error}</span><span className="now-resolving-sep"> · </span></>
                          )}
                          <span className="now-resolving-trying">Trying {resolvingStatus.trying}...</span>
                        </>
                      ) : (
                        <>
                          <span className="now-link" onClick={currentTrack.artist_name && onNavigateToArtistByName ? () => onNavigateToArtistByName(currentTrack.artist_name!) : undefined}><SlideText text={currentTrack.artist_name || "Unknown"} /></span>
                          {artistRank != null && artistRank <= 100 && <span className="now-rank-badge" title={`Artist rank #${artistRank}`}>#{artistRank}</span>}
                          {currentTrack.album_title && (
                            <><span className="now-sep"> — </span><span className="now-link" onClick={onNavigateToAlbumByName ? () => onNavigateToAlbumByName(currentTrack.album_title!, currentTrack.artist_name ?? undefined) : undefined}>{currentTrack.album_title}</span></>
                          )}
                        </>
                      )}
                    </>
                  )}
                </span>
              </>
            ) : loadingTrack ? (
              <>
                <span className="now-title"><SlideText text={loadingTrack.title} /></span>
                <span className="now-subtitle">
                  <span className="now-resolving-trying">Loading...</span>
                </span>
              </>
            ) : (
              <span className="now-title">No track playing</span>
            )}
          </div>
        </div>
        <div className="now-controls">
          <button className="g-btn g-btn-md" onClick={onPrevious} title={`Previous (${mod}\u2190)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button className="g-btn g-btn-play" onClick={onPause} title="Play / Pause (Space)">
            {playing
              ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
              : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
          </button>
          <button className="g-btn g-btn-md" onClick={onNext} title={`Next (${mod}\u2192)`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
          </button>
          <button className="g-btn g-btn-xs" onClick={onStop} title="Stop">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
          </button>
        </div>
      <div className="now-right">
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
        <button
          className={`g-btn g-btn-rect now-follow-btn${syncState ? " active now-follow-active" : ""}${followPulse && syncState ? " now-follow-pulse" : ""}`}
          onClick={onToggleSync}
          title={syncState ? "Following playback — click to stop" : "Follow playback"}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {syncState ? (
              <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
            ) : (
              <><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></>
            )}
          </svg>
          <span className="now-follow-label">{syncState ? "Following" : "Follow"}</span>
        </button>
        <div className="now-volume">
          <button className="g-btn g-btn-sm" onClick={onMute} title={`Mute (${mod}M)`}>
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
          />
        </div>
      </div>
      </div>
      {showHelp && (
        <div className="shortcuts-overlay" onClick={onToggleHelp}>
          <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-header">
              <span>Keyboard Shortcuts</span>
              <button className="ctrl-btn" onClick={onToggleHelp}>{"\u2715"}</button>
            </div>
            <div className="shortcuts-list">
              {shortcuts.map((s) => (
                <div key={s.keys} className="shortcut-row">
                  <kbd className="shortcut-keys">{s.keys}</kbd>
                  <span className="shortcut-action">{s.action}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {sourceTooltipOpen && sourceAnchor && currentTrack && (() => {
        const path = currentTrack.path ?? "";
        const isSubsonic = path.startsWith("subsonic://");
        const isLocal = path.startsWith("file://") || (!path.includes("://") && path.length > 0);
        const resolverName = resolvedSource?.name;
        const resolverId = resolvedSource?.id;
        const viaYouTube = resolverId === "youtube:youtube-fallback";
        const sourceUrl = resolvedSource?.sourceUrl ?? null;

        let pluginProtocol: string | null = null;
        if (!isLocal && !isSubsonic && path.includes("://") && !path.startsWith("external://") && !path.startsWith("http://") && !path.startsWith("https://")) {
          pluginProtocol = path.substring(0, path.indexOf("://"));
        }

        const sourceLabel = viaYouTube
          ? "YouTube"
          : resolverName && resolverName !== "Library"
            ? resolverName
            : pluginProtocol ? pluginProtocol.charAt(0).toUpperCase() + pluginProtocol.slice(1)
            : isSubsonic ? "Subsonic" : isLocal ? "Local" : (resolverName || "Unknown");

        const localPath = isLocal ? path.replace(/^file:\/\//, "") : null;
        // Library fallback: sourceUrl is the local file path
        const libraryFallbackPath = resolverName === "Library" && sourceUrl ? sourceUrl : null;
        const displayPath = localPath || libraryFallbackPath;
        const folder = displayPath ? displayPath.replace(/\/[^/]*$/, "") : null;

        // External link for the "open URL" action
        let externalUrl: string | null = null;
        let externalLabel: string | null = null;
        if (viaYouTube) {
          externalUrl = sourceUrl || null;
          externalLabel = "Open on YouTube";
        } else if (sourceUrl && sourceUrl.startsWith("https://tidal.com/")) {
          externalUrl = sourceUrl;
          externalLabel = "Open on TIDAL";
        } else if (isSubsonic && resolvedSource) {
          try {
            const u = new URL(resolvedSource.url);
            externalUrl = `${u.protocol}//${u.host}`;
            externalLabel = "Open server";
          } catch { /* ignore */ }
        }

        // Rows
        const rows: Array<[string, React.ReactNode]> = [];
        if (currentTrack.format) rows.push(["format", currentTrack.format.toUpperCase()]);
        if (audioProps?.bitrate) rows.push(["bitrate", `${audioProps.bitrate} kbps`]);
        if (audioProps?.sample_rate) {
          const depth = audioProps.bit_depth ? ` · ${audioProps.bit_depth}-bit` : "";
          rows.push(["quality", `${(audioProps.sample_rate / 1000).toFixed(1)} kHz${depth}`]);
        }
        if (audioProps?.channels) {
          const label = audioProps.channels === 1 ? "Mono" : audioProps.channels === 2 ? "Stereo" : `${audioProps.channels} ch`;
          rows.push(["channels", label]);
        }
        if (displayPath) rows.push(["path", <span className="now-source-path" title={displayPath}>{displayPath}</span>]);
        if (sourceUrl && !displayPath && !sourceUrl.startsWith("file://")) {
          rows.push(["source", <span className="now-source-path" title={sourceUrl}>{sourceUrl}</span>]);
        } else if (!displayPath && !sourceUrl && !isLocal && resolvedSource) {
          try {
            const u = new URL(resolvedSource.url);
            rows.push(["host", u.hostname]);
          } catch { /* ignore */ }
        }

        return (
          <div
            ref={sourceTooltipRef}
            className="ds-tooltip visible now-source-tooltip"
            style={{ left: sourceAnchor.x, top: sourceAnchor.y, transform: "translateY(-100%)" }}
            onMouseEnter={() => {
              if (sourceHoverTimerRef.current) { clearTimeout(sourceHoverTimerRef.current); sourceHoverTimerRef.current = null; }
            }}
            onMouseLeave={() => setSourceTooltipOpen(false)}
          >
            <div className="ds-tooltip-title">{sourceLabel}</div>
            {rows.length > 0 && (
              <div className="ds-tooltip-rows">
                {rows.map(([k, v]) => (
                  <div key={k} className="ds-tooltip-row">
                    <span className="ds-tooltip-key">{k}</span>
                    <span className="ds-tooltip-val">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {(folder || externalUrl) && (
              <div className="now-source-actions">
                {folder && currentTrack.path?.startsWith("file://") && (
                  <button
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    onClick={() => {
                      invoke("show_in_folder_path", { filePath: currentTrack.path }).catch(e => console.error("Failed to show in folder:", e));
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                    Open folder
                  </button>
                )}
                {externalUrl && (
                  <button
                    className="ds-btn ds-btn--ghost ds-btn--sm"
                    onClick={() => {
                      openUrl(externalUrl!).catch(e => console.error("Failed to open URL:", e));
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                    {externalLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </footer>
  );
}
