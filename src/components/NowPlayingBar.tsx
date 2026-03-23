import { useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { AutoContinuePopover } from "./AutoContinuePopover";

const mod = navigator.platform.includes("Mac") ? "\u2318" : "Ctrl+";

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


interface NowPlayingBarProps {
  currentTrack: Track | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  scrobbled: boolean;
  volume: number;
  queueMode: "normal" | "loop" | "shuffle";
  showQueue: boolean;
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
  onToggleQueue: () => void;
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onToggleLike: () => void;
  onArtistClick: (artistId: number) => void;
  onAlbumClick: (albumId: number, artistId?: number | null) => void;
}

export function NowPlayingBar({
  currentTrack, playing,
  positionSecs, durationSecs, scrobbled,
  volume, queueMode, showQueue,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  imagePath, miniMode, onToggleMiniMode, onClose,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onMute, onToggleQueueMode, onToggleQueue,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
  onToggleLike, onArtistClick, onAlbumClick,
}: NowPlayingBarProps) {
  const [showHelp, setShowHelp] = useState(false);

  if (miniMode) {
    const handleDrag = (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      if (e.buttons === 1) getCurrentWindow().startDragging();
    };
    const progress = durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0;
    return (
      <footer className="now-playing now-playing-mini" onMouseDown={handleDrag}>
        <div className="now-info">
          {currentTrack ? (
            <>
              <span className="now-title">{currentTrack.title}</span>
              <span className="now-artist">{currentTrack.artist_name || "Unknown"}</span>
            </>
          ) : (
            <span className="now-title">No track playing</span>
          )}
        </div>
        <div className="now-controls">
          <button className="ctrl-btn" onClick={onPrevious} title="Previous">{"\u23EE"}</button>
          <button className="ctrl-btn play-btn" onClick={onPause}>
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button className="ctrl-btn" onClick={onNext} title="Next">{"\u23ED"}</button>
        </div>
        <span className="mini-separator" />
        <button className="ctrl-btn mini-expand-btn" onClick={onToggleMiniMode} title="Exit mini mode">{"\u26F6"}</button>
        <button className="ctrl-btn mini-close-btn" onClick={onClose} title="Close">{"\u2715"}</button>
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
        <div className="now-seek-fill" style={{ width: `${durationSecs > 0 ? (positionSecs / durationSecs) * 100 : 0}%` }} />
      </div>
      <div className="now-main">
        <div className="now-info">
          {imagePath && <img className="now-art" src={convertFileSrc(imagePath)} alt="" />}
          <div className="now-info-text">
            {currentTrack ? (
              <>
                <span className={`now-title${currentTrack.album_id ? " now-link" : ""}`} onClick={currentTrack.album_id ? () => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id) : undefined}>{currentTrack.title}</span>
                <span className="now-subtitle">
                  <span className="now-link" onClick={currentTrack.artist_id ? () => onArtistClick(currentTrack.artist_id!) : undefined}>{currentTrack.artist_name || "Unknown"}</span>
                  {currentTrack.album_id && currentTrack.album_title && (
                    <><span className="now-sep"> — </span><span className="now-link" onClick={() => onAlbumClick(currentTrack.album_id!, currentTrack.artist_id)}>{currentTrack.album_title}</span></>
                  )}
                </span>
              </>
            ) : (
              <span className="now-title">No track playing</span>
            )}
          </div>
          {currentTrack && (
            <span
              className={`now-like-btn${currentTrack.liked ? " liked" : ""}`}
              onClick={onToggleLike}
              title={`${currentTrack.liked ? "Unlike" : "Like"} (${mod}L)`}
            >{currentTrack.liked ? "\u2665" : "\u2661"}</span>
          )}
        </div>
        <div className="now-controls">
          <button className="ctrl-btn" onClick={onPrevious} title={`Previous (${mod}\u2190)`}>{"\u23EE"}</button>
          <button className="ctrl-btn play-btn" onClick={onPause} title="Play / Pause (Space)">
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button className="ctrl-btn" onClick={onNext} title={`Next (${mod}\u2192)`}>{"\u23ED"}</button>
          <button className="ctrl-btn" onClick={onStop} title="Stop">{"\u23F9"}</button>
          <span className="now-time">
            {formatDuration(positionSecs)} / {formatDuration(durationSecs)}
            {scrobbled && <span className="now-scrobbled" title="Logged to play history">{"\u2713"}</span>}
          </span>
        </div>
      <div className="now-right">
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
        <div className="now-volume">
          <span className="volume-icon" onClick={onMute} title={`Mute (${mod}M)`} dangerouslySetInnerHTML={{ __html: volume === 0
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
          />
        </div>
        <button
          className={`ctrl-btn queue-toggle-btn ${showQueue ? "active" : ""}`}
          onClick={onToggleQueue}
          title={`Playlist (${mod}P)`}
        >
          {"\u2630"}
        </button>
        <button
          className="ctrl-btn mini-mode-btn"
          onClick={onToggleMiniMode}
          title="Mini player"
        >
          {"\u2013"}
        </button>
        <button
          className="ctrl-btn help-btn"
          onClick={() => setShowHelp(!showHelp)}
          title="Keyboard shortcuts"
        >
          {"?"}
        </button>
      </div>
      </div>
      {showHelp && (
        <div className="shortcuts-overlay" onClick={() => setShowHelp(false)}>
          <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
            <div className="shortcuts-header">
              <span>Keyboard Shortcuts</span>
              <button className="ctrl-btn" onClick={() => setShowHelp(false)}>{"\u2715"}</button>
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
    </footer>
  );
}
