import { useId } from "react";
import "./PlaceholderArt.css";

/**
 * The drawings behind every "no artwork" placeholder: a black vinyl record, a
 * metal film reel and a person, all on one 40-unit viewBox with the same light
 * (top-left), rim and drop shadow. The coloured part — the record's label, the
 * reel, the person — is `currentColor`, so the caller picks it: the track
 * surfaces tint it per artist (`TrackArtFallback`), the album / artist ones use
 * the skin accent (`EntityArtFallback`).
 *
 * These are artwork, not icons: the record is black on every skin, the way a
 * cover would be. Size them with `size` (px) or leave it out and size the svg
 * from CSS. They never spin — the playing indicator is `SpinningDisc` / `FilmReel`.
 */
type ArtProps = { size?: number; className?: string; color?: string };

/** Spindle hole, then the six flange windows of the reel. */
const REEL_WINDOWS: [number, number][] = [
  [20, 9.3], [29.27, 14.65], [29.27, 25.35], [20, 30.7], [10.73, 25.35], [10.73, 14.65],
];

/** Unique per instance, and stripped to characters a `url(#…)` reference takes. */
function useArtId(): string {
  return useId().replace(/[^a-zA-Z0-9_-]/g, "");
}

function ArtSvg({ size, className, color, kind, children }: ArtProps & { kind: string; children: React.ReactNode }) {
  return (
    <svg
      className={`placeholder-art placeholder-art--${kind}${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Light from the top-left, shade to the bottom-right: brushed metal on the reel, gloss on a label. */
function Sheen({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#fff" stopOpacity=".55" />
      <stop offset=".45" stopColor="#fff" stopOpacity=".05" />
      <stop offset=".55" stopColor="#000" stopOpacity=".05" />
      <stop offset="1" stopColor="#000" stopOpacity=".35" />
    </linearGradient>
  );
}

/**
 * A black record with a plain `currentColor` label. No letter on the label: at
 * the sizes it is drawn (a 26px queue thumb) a letter is a smudge, and the
 * spindle hole runs through its middle.
 */
export function VinylArt(props: ArtProps) {
  const id = useArtId();
  return (
    <ArtSvg kind="vinyl" {...props}>
      <defs>
        <Sheen id={`${id}-sheen`} />
        <radialGradient id={`${id}-body`}>
          <stop offset="0" stopColor="#2b2b30" />
          <stop offset=".7" stopColor="#141417" />
          <stop offset="1" stopColor="#0a0a0c" />
        </radialGradient>
        {/* Glints that brighten toward the rim, as light catches the grooves. */}
        <linearGradient id={`${id}-glintA`} gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="34" y2="5">
          <stop offset=".35" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".30" />
        </linearGradient>
        <linearGradient id={`${id}-glintB`} gradientUnits="userSpaceOnUse" x1="20" y1="20" x2="6" y2="35">
          <stop offset=".35" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".16" />
        </linearGradient>
        <mask id={`${id}-hole`} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
          <rect width="40" height="40" fill="#fff" />
          <circle cx="20" cy="20" r="1.4" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${id}-hole)`}>
        <circle cx="20" cy="20" r="19.5" fill={`url(#${id}-body)`} />
        {/* Rim light: keeps the record's edge on a dark placeholder. */}
        <circle cx="20" cy="20" r="19.1" fill="none" stroke="#fff" strokeOpacity=".22" strokeWidth=".7" />
        <g fill="none" stroke="#fff" strokeOpacity=".06" strokeWidth=".35">
          {[17.8, 17, 16.2, 15.4, 14.4, 13.6, 12.8, 11.8, 11].map((r) => <circle key={r} cx="20" cy="20" r={r} />)}
        </g>
        {/* Run-out groove around the label. */}
        <circle cx="20" cy="20" r="9.4" fill="none" stroke="#000" strokeOpacity=".5" strokeWidth="1.2" />
        <path d="M20 20 L26 1.5 A19.5 19.5 0 0 1 38.5 14 Z" fill={`url(#${id}-glintA)`} />
        <path d="M20 20 L14 38.5 A19.5 19.5 0 0 1 1.5 26 Z" fill={`url(#${id}-glintB)`} />
        <circle cx="20" cy="20" r="7.8" fill="currentColor" />
        <circle cx="20" cy="20" r="7.8" fill={`url(#${id}-sheen)`} opacity=".45" />
        <circle cx="20" cy="20" r="7.8" fill="none" stroke="#000" strokeOpacity=".35" strokeWidth=".5" />
        <circle cx="20" cy="20" r="2.4" fill="#000" fillOpacity=".18" />
      </g>
    </ArtSvg>
  );
}

/** A `currentColor` metal reel with film wound on it, seen through the flange windows. */
export function ReelArt(props: ArtProps) {
  const id = useArtId();
  return (
    <ArtSvg kind="reel" {...props}>
      <defs>
        <Sheen id={`${id}-sheen`} />
        <mask id={`${id}-holes`} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
          <rect width="40" height="40" fill="#fff" />
          {REEL_WINDOWS.map(([cx, cy]) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="3.7" fill="#000" />)}
          <circle cx="20" cy="20" r="1.5" fill="#000" />
        </mask>
      </defs>
      <circle cx="20" cy="20" r="14.5" fill="#24180f" />
      <g fill="none" stroke="#c8a27a" strokeOpacity=".18" strokeWidth=".35">
        {[13.5, 12.2, 10.9, 9.6, 8.3, 7].map((r) => <circle key={r} cx="20" cy="20" r={r} />)}
      </g>
      <g mask={`url(#${id}-holes)`}>
        <circle cx="20" cy="20" r="19.5" fill="currentColor" />
        <circle cx="20" cy="20" r="19.5" fill={`url(#${id}-sheen)`} />
        <circle cx="20" cy="20" r="19.1" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".7" />
        <circle cx="20" cy="20" r="17.6" fill="none" stroke="#000" strokeOpacity=".25" strokeWidth=".8" />
        <circle cx="20" cy="20" r="4.2" fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".5" />
      </g>
    </ArtSvg>
  );
}

/** The front figure's shoulders; the open form is its rim light, left open at the bottom where the frame cuts it. */
const FRONT_SHOULDERS = "M6 41 C7 34.2 13 27.2 20 27.2 S33 34.2 34 41";
/** The quiff on the front figure's head. */
const QUIFF = "M13.8 14.6 C13.4 10 16 7.6 19.6 7.4 C22.6 7.2 25.6 8 26.8 10.6 C27.4 12 26.6 13.2 26.2 13.6 C25 11.4 22.4 10.6 20 10.8 C17.4 11 15.4 12.4 13.8 14.6 Z";

/**
 * A band of three: long hair on the left, a beanie on the right, a quiff in
 * front — three people rather than three icons (owner's pick, 2026-10-30). The
 * two behind are the faded accent, the front one lit like the record and cut
 * out of them by a ring of the frame colour. The shoulders run past the bottom
 * edge and the CSS sits the drawing on the bottom of its box, so the frame
 * crops them the way it would a band photo.
 */
export function PersonArt(props: ArtProps) {
  const id = useArtId();
  const back = (
    <>
      <circle cx="9.5" cy="17" r="5.2" />
      <path d="M-1.5 41 C-0.5 34 4 27 9.5 27 S19.5 34 20.5 41 Z" />
      <circle cx="30.5" cy="17" r="5.2" />
      <path d="M19.5 41 C20.5 34 25 27 30.5 27 S40.5 34 41.5 41 Z" />
    </>
  );
  const front = (
    <>
      <circle cx="20" cy="15.5" r="6.4" />
      <path d={`${FRONT_SHOULDERS} Z`} />
    </>
  );
  return (
    <ArtSvg kind="person" {...props}>
      <defs>
        <Sheen id={`${id}-sheen`} />
      </defs>
      {/* Left: long hair, behind the head. */}
      <path
        d="M4 26 C3.6 19 3.8 11.6 9.5 11.6 C15.2 11.6 15.4 19 15 26 C14.2 24 13.6 20 13.4 18.5 C12 21 7 21 5.6 18.5 C5.4 20 4.8 24 4 26 Z"
        fill="currentColor"
        opacity=".62"
      />
      <g fill="currentColor" opacity=".38">{back}</g>
      {/* Right: a beanie with a pompom. */}
      <g fill="currentColor">
        <path d="M25.1 15.8 C25.1 10.4 35.9 10.4 35.9 15.8 Z" opacity=".7" />
        <rect x="24.6" y="14.9" width="11.8" height="2.2" rx="1.1" opacity=".85" />
        <circle cx="30.5" cy="10.2" r="1.5" opacity=".85" />
      </g>
      {/* Front: cut out of the two behind, then lit. */}
      <g className="placeholder-art-cut" fill="none" strokeWidth="1.4">{front}</g>
      <g fill="currentColor">{front}</g>
      <g fill={`url(#${id}-sheen)`} opacity=".6">{front}</g>
      <g fill="none" stroke="#fff" strokeOpacity=".3" strokeWidth=".6">
        <circle cx="20" cy="15.5" r="6.4" />
        <path d={FRONT_SHOULDERS} />
      </g>
      <path d={QUIFF} fill="currentColor" />
      <path d={QUIFF} fill="#000" fillOpacity=".38" />
    </ArtSvg>
  );
}
