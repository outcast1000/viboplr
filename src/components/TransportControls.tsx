import { useRef } from "react";
import { AutoContinuePopover } from "./AutoContinuePopover";
import type { QueueMode } from "../types";
import type { AutoContinueWeights } from "../hooks/useAutoContinue";

// Same local definition the other shortcut-hinting components use
// (CentralSearchDropdown, Sidebar, NowPlayingBar).
const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

/*
 * The clusters both playback bars render identically.
 *
 * They cannot be *one* bar — the fullscreen one has to be a child of whatever
 * element got `requestFullscreen()`, and it carries an idle auto-hide and a
 * colour regime for sitting over video (see ui.md "Now Playing Bar"). But the
 * transport, the playlist-mode group and the volume cluster were verbatim
 * copies in both files, which is how the fullscreen bar quietly ended up
 * without an equalizer and without a segmented seek bar. Shared here, the two
 * bars are arrangements of the same controls rather than two implementations.
 *
 * Each export takes the host's container class, because the layout around them
 * genuinely differs; nothing else about them is allowed to.
 */

interface TransportButtonsProps {
  playing: boolean;
  onPrevious: () => void;
  onPause: () => void;
  onNext: () => void;
  onStop: () => void;
  /** Host's container class: `.now-controls` / `.fs-center`. */
  className: string;
  /** Extra class on the play button (the fullscreen bar sizes its own). */
  playClassName?: string;
}

export function TransportButtons({
  playing, onPrevious, onPause, onNext, onStop, className, playClassName,
}: TransportButtonsProps) {
  return (
    <div className={className}>
      <button className="g-btn g-btn-md" onClick={onPrevious} title={`Previous (${mod}←)`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
      </button>
      <button className={`g-btn g-btn-play${playClassName ? ` ${playClassName}` : ""}`} onClick={onPause} title="Play / Pause (Space)">
        {/* Keyed on the state so the icon swap re-runs its pop animation. */}
        <span className="now-play-icon" key={playing ? "pause" : "play"}>
          {playing
            ? <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
            : <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>}
        </span>
      </button>
      <button className="g-btn g-btn-md" onClick={onNext} title={`Next (${mod}→)`}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zm-2 6L6 18V6z"/></svg>
      </button>
      <button className="g-btn g-btn-xs" onClick={onStop} title="Stop">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
      </button>
    </div>
  );
}

interface QueueModeGroupProps {
  queueMode: QueueMode;
  onToggleQueueMode: () => void;
  autoContinueEnabled: boolean;
  autoContinueSameFormat: boolean;
  showAutoContinuePopover: boolean;
  autoContinueWeights: AutoContinueWeights;
  onToggleAutoContinue: () => void;
  onToggleAutoContinueSameFormat: () => void;
  onToggleAutoContinuePopover: () => void;
  onAdjustAutoContinueWeight: (key: keyof AutoContinueWeights, value: number) => void;
  onResetAutoContinueWeights: () => void;
  onCloseAutoContinuePopover: () => void;
}

/** Queue mode · auto-continue. Owns its own popover anchor ref — each bar
 *  mounts its own instance, so neither host has to hold one. (Randomize moved
 *  to the queue panel header, next to the list it reorders.) */
export function QueueModeGroup({
  queueMode, onToggleQueueMode,
  autoContinueEnabled, autoContinueSameFormat, showAutoContinuePopover, autoContinueWeights,
  onToggleAutoContinue, onToggleAutoContinueSameFormat, onToggleAutoContinuePopover,
  onAdjustAutoContinueWeight, onResetAutoContinueWeights, onCloseAutoContinuePopover,
}: QueueModeGroupProps) {
  const acAnchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
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
      <div className="auto-continue-wrapper">
        <button
          ref={acAnchorRef}
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
            anchorRef={acAnchorRef}
          />
        )}
      </div>
    </>
  );
}

interface VolumeControlProps {
  volume: number;
  muted: boolean;
  onVolume: (level: number) => void;
  onMute: () => void;
  /** Host's container class: `.now-volume` / `.fs-volume`. */
  className: string;
  /** Fired around a slider drag. The fullscreen bar pins its idle auto-hide
   *  open for the duration; the docked bar has nothing to pin. */
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export function VolumeControl({
  volume, muted, onVolume, onMute, className, onDragStart, onDragEnd,
}: VolumeControlProps) {
  return (
    <div className={className}>
      <button className={`g-btn g-btn-sm${muted ? " is-muted" : ""}`} onClick={onMute} title={`Mute (${mod}M)`}>
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
        onMouseDown={onDragStart}
        onMouseUp={onDragEnd}
      />
    </div>
  );
}
