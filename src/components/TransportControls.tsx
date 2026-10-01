
// Same local definition the other shortcut-hinting components use
// (CentralSearchDropdown, Sidebar, NowPlayingBar).
const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl+";

/*
 * The clusters both playback bars render identically.
 *
 * They cannot be *one* bar — the fullscreen one has to be a child of whatever
 * element got `requestFullscreen()`, and it carries an idle auto-hide and a
 * colour regime for sitting over video (see ui.md "Now Playing Bar"). But the
 * transport and the volume cluster were verbatim
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
  /** Set while the volume is fixed (Bit-perfect mode): the slider shows 100%
   *  with this as its tooltip. Input still reaches `onVolume`, whose guard
   *  explains why nothing moved. */
  lockedReason?: string | null;
  /** Tooltip for the cluster when it isn't locked (e.g. "controls the device's
   *  own volume" in Bit-perfect mode). */
  note?: string | null;
}

/** One wheel notch over the volume cluster, matching the keyboard shortcut and
 *  the mini bar's wheel step. */
const VOLUME_WHEEL_STEP = 0.05;

export function VolumeControl({
  volume: userVolume, muted, onVolume, onMute, className, onDragStart, onDragEnd, lockedReason, note,
}: VolumeControlProps) {
  const volume = lockedReason ? 1 : userVolume;
  // Wheel anywhere over the cluster (icon included), not just the slider track —
  // the track is a few pixels tall and aiming at it would make the gesture fussy.
  // A horizontal trackpad swipe reports deltaX, so it drives the slider too.
  const handleWheel = (e: React.WheelEvent) => {
    const delta = e.deltaY !== 0 ? -e.deltaY : e.deltaX;
    if (delta === 0) return;
    onVolume(Math.min(1, Math.max(0, volume + (delta > 0 ? VOLUME_WHEEL_STEP : -VOLUME_WHEEL_STEP))));
  };
  return (
    <div className={`${className}${lockedReason ? " is-locked" : ""}`} onWheel={handleWheel} title={lockedReason ?? note ?? undefined}>
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
