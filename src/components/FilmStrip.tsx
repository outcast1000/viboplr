import { useId } from "react";
import "./FilmStrip.css";

// Sprocket holes: two columns, six rows each stepping by the pitch (2.1). The
// extra rows above/below the visible body let the scroll animation loop
// seamlessly (translate by exactly one pitch).
const HOLE_YS = [-0.75, 1.35, 3.45, 5.55, 7.65, 9.75];
const COLUMNS = [1.55, 8.95];

/**
 * Video sibling of {@link SpinningDisc}: a film strip whose sprocket holes scroll
 * (film advancing through a gate) while playing and freeze when paused. Same
 * 12×12 viewBox / size / color contract as SpinningDisc so the two read as a
 * matched pair. The strip body inherits `currentColor`; the perforations punch
 * through to `--bg-primary`, exactly like the disc's spindle hole.
 */
export function FilmStrip({ size = 14, playing }: { size?: number; playing: boolean }) {
  const clipId = useId();
  return (
    <span className={`film-strip${playing ? " playing" : ""}`}>
      <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className="film-strip-svg">
        <defs>
          <clipPath id={clipId}>
            <rect x="0.6" y="1.6" width="10.8" height="8.8" rx="1.6" />
          </clipPath>
        </defs>
        {/* strip body */}
        <rect x="0.6" y="1.6" width="10.8" height="8.8" rx="1.6" fill="currentColor" />
        {/* perforations, clipped to the body so scrolling holes never spill past the rounded edges */}
        <g className="film-strip-holes" clipPath={`url(#${clipId})`}>
          {COLUMNS.map((x) =>
            HOLE_YS.map((y) => (
              <rect key={`${x}-${y}`} x={x} y={y} width="1.5" height="1.35" rx="0.4" fill="var(--bg-primary)" />
            )),
          )}
        </g>
      </svg>
    </span>
  );
}
