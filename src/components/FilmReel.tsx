import "./FilmReel.css";

/**
 * Video sibling of {@link SpinningDisc}: a film reel that rotates while playing
 * and freezes when paused. Round + rotating, so it reads as the vinyl disc's
 * matched pair (audio = record, video = reel) while staying clearly distinct via
 * the reel rim + ring of sprocket holes.
 *
 * Same 12×12 viewBox / `currentColor` body / `--bg-primary`-punched holes contract
 * as SpinningDisc. Renders a bare `<svg>` (no wrapper) so it can be either a
 * fixed-size indicator (`size` in px — sidebar Now Playing, art fallback, frame
 * badge) or CSS-sized via `className` (the `.video-row-thumb-icon` % placeholder).
 * This is the single video glyph for the whole app — do not reintroduce a second
 * "video" icon elsewhere.
 */
export function FilmReel({
  size = 14,
  playing = false,
  className,
}: {
  size?: number;
  playing?: boolean;
  className?: string;
}) {
  return (
    <svg
      className={`film-reel${playing ? " playing" : ""}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      {/* reel body + rim */}
      <circle cx="6" cy="6" r="5.5" fill="currentColor" />
      <circle cx="6" cy="6" r="4.15" fill="none" stroke="var(--bg-primary)" strokeWidth="0.7" />
      {/* ring of sprocket holes punched through to the surface */}
      <g fill="var(--bg-primary)">
        <circle cx="6" cy="2.55" r="0.95" />
        <circle cx="8.98" cy="4.28" r="0.95" />
        <circle cx="8.98" cy="7.72" r="0.95" />
        <circle cx="6" cy="9.45" r="0.95" />
        <circle cx="3.02" cy="7.72" r="0.95" />
        <circle cx="3.02" cy="4.28" r="0.95" />
      </g>
      {/* hub */}
      <circle cx="6" cy="6" r="1.5" fill="var(--bg-primary)" />
      <circle cx="6" cy="6" r="0.6" fill="currentColor" />
    </svg>
  );
}
