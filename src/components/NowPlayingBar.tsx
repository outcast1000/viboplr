import { useRef, useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { AutoContinuePopover } from "./AutoContinuePopover";
import { WaveformSeekBar } from "./WaveformSeekBar";
import { SegmentedSeekBar } from "./SegmentedSeekBar";
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
  currentTrack: Track | null;
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
  onTrackClick: (trackId: number) => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
  onNavigateToArtistByName?: (name: string) => void;
  onNavigateToAlbumByName?: (name: string, artistName?: string) => void;
  syncWithPlaying: boolean;
  onToggleSync: () => void;
  showHelp: boolean;
  onToggleHelp: () => void;
  playbackError?: string | null;
  resolvingStatus?: { error: string | null; trying: string | null } | null;
  resolvedSource?: { name: string; url: string } | null;
  onSkipError?: () => void;
}

export function NowPlayingBar({
  waveformPeaks,
  currentTrack, playing,
  positionSecs, durationSecs, scrobbled,
  trackRank, artistRank,
  volume, queueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath, miniMode, onToggleMiniMode, onClose,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
  onToggleLike, onToggleDislike, onTrackClick, onArtistClick, onAlbumClick,
  onNavigateToArtistByName, onNavigateToAlbumByName,
  syncWithPlaying, onToggleSync,
  showHelp, onToggleHelp,
  playbackError, resolvingStatus, resolvedSource, onSkipError,
}: NowPlayingBarProps) {
  const miniDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const likeBtnRef = useRef<HTMLButtonElement>(null);
  const dislikeBtnRef = useRef<HTMLButtonElement>(null);
  const [sourceTooltip, setSourceTooltip] = useState<{ text: string; x: number; y: number } | null>(null);

  // Blur any focused element when entering mini mode so no button appears selected
  useEffect(() => {
    if (miniMode) (document.activeElement as HTMLElement)?.blur();
  }, [miniMode]);

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
      <footer className="now-playing now-playing-mini" onMouseDown={handleDrag} onWheel={(e) => {
          e.preventDefault();
          onVolume(Math.min(1, Math.max(0, volume + (e.deltaY < 0 ? 0.05 : -0.05))));
        }} onDoubleClick={isMac ? (e) => {
          if (!(e.target as HTMLElement).closest("button")) onToggleMiniMode();
        } : undefined}>
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
                <span className="now-artist">
                  {resolvingStatus ? (
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
              </>
            ) : (
              <span className="now-title">No track playing</span>
            )}
          </div>
        </div>
        <div className="mini-right">
          <div className="now-controls">
            <button className="g-btn g-btn-sm" onClick={onPrevious} title="Previous">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button className="g-btn g-btn-md mini-play-btn" onClick={onPause} title="Play / Pause">
              {playing
                ? <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
                : <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
            </button>
            <button className="g-btn g-btn-sm" onClick={onNext} title="Next">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
            </button>
          </div>
          <span className="mini-separator" />
          <div className="mini-window-btns">
            <button className="g-btn mini-expand-btn" onClick={onToggleMiniMode} title="Exit mini mode">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/></svg>
            </button>
            <button className="g-btn mini-close-btn" onClick={onClose} title="Close">
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </div>
        <div className="mini-progress" style={{ width: `${progress}%` }} />
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
          {currentTrack && currentTrack.id > 0 && (
            <div className="now-like-col">
              <button
                ref={likeBtnRef}
                className={`g-btn g-btn-sm${currentTrack.liked === 1 ? " liked" : ""}`}
                onClick={() => {
                  likeBtnRef.current?.classList.add("anim-heart-bounce");
                  onToggleLike();
                }}
                onAnimationEnd={() => likeBtnRef.current?.classList.remove("anim-heart-bounce")}
                title={`${currentTrack.liked === 1 ? "Unlike" : "Like"} (${mod}L)`}
              >
                {currentTrack.liked === 1
                  ? <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>}
              </button>
              {onToggleDislike && <button
                ref={dislikeBtnRef}
                className={`g-btn g-btn-sm now-dislike-btn${currentTrack.liked === -1 ? " disliked" : ""}`}
                onClick={() => {
                  dislikeBtnRef.current?.classList.add("anim-heart-bounce-subtle");
                  onToggleDislike();
                }}
                onAnimationEnd={() => dislikeBtnRef.current?.classList.remove("anim-heart-bounce-subtle")}
                title={currentTrack.liked === -1 ? "Remove hate" : "Hate"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
              </button>}
            </div>
          )}
          <div className="now-info-text">
            {currentTrack ? (
              <>
                <span className="now-title now-link" onClick={() => onTrackClick(currentTrack.id)}>
                  <SlideText text={currentTrack.title} />
                  {trackRank != null && trackRank <= 100 && <span className="now-rank-badge" title={`Track rank #${trackRank}`}>#{trackRank}</span>}
                </span>
                <span className="now-subtitle">
                  {!resolvingStatus && (() => {
                    const source = resolvedSource?.name || (currentTrack.path.startsWith("tidal://") ? "TIDAL" : currentTrack.path.startsWith("subsonic://") ? "Subsonic" : "Local");
                    const isLocal = currentTrack.path.startsWith("file://") || !currentTrack.path.includes("://");
                    const tip = [
                      `Source: ${source}`,
                      currentTrack.format ? `Format: ${currentTrack.format.toUpperCase()}` : null,
                      currentTrack.file_size ? `Size: ${(currentTrack.file_size / 1048576).toFixed(1)} MB` : null,
                      currentTrack.collection_name ? `Collection: ${currentTrack.collection_name}` : null,
                      isLocal ? `Path: ${currentTrack.path.replace(/^file:\/\//, "")}` : null,
                      !isLocal && resolvedSource ? `URL: ${(() => { try { return new URL(resolvedSource.url).hostname; } catch { return resolvedSource.url.slice(0, 50); } })()}` : null,
                    ].filter(Boolean).join("\n");
                    return <span
                      className="now-source-icon"
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setSourceTooltip({ text: tip, x: rect.left, y: rect.top - 8 });
                      }}
                      onMouseLeave={() => setSourceTooltip(null)}
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
                      <span className="now-link" onClick={currentTrack.artist_id ? () => onArtistClick(currentTrack.artist_id!) : (currentTrack.artist_name && onNavigateToArtistByName ? () => onNavigateToArtistByName(currentTrack.artist_name!) : undefined)}><SlideText text={currentTrack.artist_name || "Unknown"} /></span>
                      {artistRank != null && artistRank <= 100 && <span className="now-rank-badge" title={`Artist rank #${artistRank}`}>#{artistRank}</span>}
                      {currentTrack.album_title && (
                        <><span className="now-sep"> — </span><span className="now-link" onClick={currentTrack.album_id ? () => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id) : (onNavigateToAlbumByName ? () => onNavigateToAlbumByName(currentTrack.album_title!, currentTrack.artist_name ?? undefined) : undefined)}>{currentTrack.album_title}</span></>
                      )}
                    </>
                  )}
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
          className={`g-btn g-btn-sm${syncWithPlaying ? " active" : ""}`}
          onClick={onToggleSync}
          data-tooltip={syncWithPlaying ? "Stop following playback" : "Follow playback — auto-shows track details when song changes"}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
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
      {sourceTooltip && (
        <div
          className="ds-tooltip visible"
          style={{ left: sourceTooltip.x, top: sourceTooltip.y, transform: "translateY(-100%)" }}
        >{sourceTooltip.text}</div>
      )}
    </footer>
  );
}
