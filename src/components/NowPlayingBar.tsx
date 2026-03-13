import type { Track } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";
import { formatDuration } from "../utils";
import { AutoContinuePopover } from "./AutoContinuePopover";

interface NowPlayingBarProps {
  currentTrack: Track | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  volume: number;
  queueMode: "normal" | "loop" | "shuffle";
  showQueue: boolean;
  autoContinueEnabled: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  onPause: () => void;
  onStop: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeek: (secs: number) => void;
  onVolume: (level: number) => void;
  onToggleQueueMode: () => void;
  onToggleQueue: () => void;
  onToggleAutoContinue: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
}

export function NowPlayingBar({
  currentTrack, playing,
  positionSecs, durationSecs,
  volume, queueMode, showQueue,
  autoContinueEnabled, showAutoContinuePopover, autoContinueWeights,
  onPause, onStop, onNext, onPrevious,
  onSeek, onVolume, onToggleQueueMode, onToggleQueue,
  onToggleAutoContinue, onToggleAutoContinuePopover, onAdjustAutoContinueWeight,
}: NowPlayingBarProps) {
  return (
    <footer className="now-playing">
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
      <div className="now-center">
        <div className="now-controls">
          <button className="ctrl-btn" onClick={onPrevious} title="Previous">{"\u23EE"}</button>
          <button className="ctrl-btn" onClick={onStop}>{"\u23F9"}</button>
          <button className="ctrl-btn play-btn" onClick={onPause}>
            {playing ? "\u23F8" : "\u25B6"}
          </button>
          <button className="ctrl-btn" onClick={onNext} title="Next">{"\u23ED"}</button>
        </div>
        <div className="now-seek">
          <span className="time-label">{formatDuration(positionSecs)}</span>
          <input
            type="range"
            className="seek-bar"
            min="0"
            max={durationSecs || 1}
            step="0.5"
            value={positionSecs}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
          />
          <span className="time-label">{formatDuration(durationSecs)}</span>
        </div>
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
              weights={autoContinueWeights}
              onToggle={onToggleAutoContinue}
              onAdjust={onAdjustAutoContinueWeight}
            />
          )}
        </div>
        <div className="now-volume">
          <span>{"\uD83D\uDD0A"}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={volume}
            onChange={(e) => onVolume(parseFloat(e.target.value))}
          />
        </div>
        <button
          className={`ctrl-btn queue-toggle-btn ${showQueue ? "active" : ""}`}
          onClick={onToggleQueue}
          title="Queue"
        >
          {"\u2630"}
        </button>
      </div>
    </footer>
  );
}
