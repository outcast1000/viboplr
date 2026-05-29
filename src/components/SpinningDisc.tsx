import "./SpinningDisc.css";

/**
 * The canonical "currently playing" indicator used across the app
 * (now-playing mini bar, Library/Search track rows, Queue panel).
 * A vinyl disc that spins while playing and freezes when paused.
 * Inherits color from `currentColor` so each surface's accent applies.
 */
export function SpinningDisc({ size = 14, playing }: { size?: number; playing: boolean }) {
  return (
    <span className={`spinning-disc${playing ? " playing" : ""}`}>
      <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className="spinning-disc-svg">
        <circle cx="6" cy="6" r="5.5" fill="currentColor" />
        <path d="M6 0.8 A5.2 5.2 0 0 1 11.2 6 L9 6 A3 3 0 0 0 6 3 Z" fill="rgba(255,255,255,0.55)" />
        <circle cx="6" cy="6" r="4" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.4" />
        <circle cx="6" cy="6" r="2.6" fill="none" stroke="rgba(0,0,0,0.25)" strokeWidth="0.4" />
        <circle cx="6" cy="6" r="1.4" fill="var(--bg-primary)" />
        <circle cx="6" cy="6" r="0.5" fill="currentColor" />
      </svg>
    </span>
  );
}
