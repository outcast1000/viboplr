import "./FilmReel.css";

/**
 * Video sibling of {@link SpinningDisc}: a film reel that rotates while playing
 * and freezes when paused. Same 12×12 viewBox / size / color contract so the two
 * read as a matched pair. Inherits color from `currentColor`.
 */
export function FilmReel({ size = 14, playing }: { size?: number; playing: boolean }) {
  return (
    <span className={`film-reel${playing ? " playing" : ""}`}>
      <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className="film-reel-svg">
        <circle cx="6" cy="6" r="5.5" fill="currentColor" />
        {/* center hub hole */}
        <circle cx="6" cy="6" r="1.5" fill="var(--bg-primary)" />
        {/* five sprocket holes in a ring */}
        <circle cx="6" cy="2.6" r="0.85" fill="var(--bg-primary)" />
        <circle cx="9.23" cy="4.95" r="0.85" fill="var(--bg-primary)" />
        <circle cx="8.0" cy="8.75" r="0.85" fill="var(--bg-primary)" />
        <circle cx="4.0" cy="8.75" r="0.85" fill="var(--bg-primary)" />
        <circle cx="2.77" cy="4.95" r="0.85" fill="var(--bg-primary)" />
      </svg>
    </span>
  );
}
