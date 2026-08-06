// Geometry for the `vinyl-deck` plugin view kind.
//
// Everything here is pure and unit-tested: the canvas painter, the tonearm
// angle and the cue hit-testing all read from these functions, so the picture
// and the pointer can never disagree about where a track's band sits.
//
// Radii are in the same units the deck is rendered at (CSS px), so a geometry
// built for a 368px deck is measured in that deck's own pixels.

/**
 * A real 12" LP, in millimetres of disc *radius*.
 *
 * These are the numbers the whole surface derives from. The unplayable outer
 * band is only `disc - maxRecorded` = ~5mm, i.e. 3.3% of the radius — inventing
 * a wider one reads as a black moat that no record actually has.
 */
export const LP_MM = {
  disc: 151,
  rim: 148.5,
  maxRecorded: 146,
  minRecorded: 60,
  deadWax: 55,
  label: 50,
  /** Inter-track land. ~1mm on a real pressing. */
  gap: 1,
} as const;

/**
 * Floor for the painted inter-track gap.
 *
 * At true proportions the gap is ~1.2px on a 368px deck and sub-pixel on a
 * small one, so it would simply vanish — and the gap is the one thing the
 * surface exists to show. Same rule (and the same reason) as
 * `MIN_BAR_WIDTH_PX` in WaveformSeekBar and `MIN_SEG_WIDTH` in
 * SegmentedSeekBar: keep true proportions while they're legible, clamp when
 * they aren't.
 */
export const MIN_GAP_PX = 2;

/**
 * Ceiling on the share of the program area the inter-track lands may consume.
 *
 * `MIN_GAP_PX` is a floor per gap, so a long enough queue would demand more
 * total land than the program area has — a 60-track queue wants 118px of gap in
 * a 104px span — and the bands would run straight through the label. Capping
 * the total and dividing it down keeps the pressing inside its geometry. Past
 * this density the deck is unreadable anyway; the contract it must not break is
 * that the last band ends exactly on the run-out.
 */
export const MAX_GAP_SHARE = 0.5;

/** Tonearm mounting, as multiples of the disc radius. */
export const ARM = {
  /** Where the pivot sits, measured from the disc centre. Negative = above. */
  pivotAngleDeg: -38,
  /** Pivot distance from centre. >1 puts it clear of the record. */
  pivotDistance: 1.12,
  /** Effective arm length, pivot to stylus. */
  length: 1.28,
} as const;

export interface VinylGeometry {
  /** Deck width/height in px; the disc is inscribed in it. */
  size: number;
  cx: number;
  cy: number;
  /** Outer edge of the disc. */
  rEdge: number;
  /** Inner edge of the smooth raised rim. */
  rRim: number;
  /** Outer edge of the program area (where track 1 begins). */
  rLeadIn: number;
  /** Inner edge of the program area (where the last track ends). */
  rProgIn: number;
  /** Inner edge of the dead wax. */
  rDeadWax: number;
  /** Label radius. */
  rLabel: number;
  /** Painted width of one inter-track land ring. */
  gap: number;
}

/** Build the radii for a deck rendered `size` px across. */
export function buildGeometry(size: number): VinylGeometry {
  const rEdge = Math.max(1, size / 2 - 2);
  const mm = (v: number) => rEdge * (v / LP_MM.disc);
  return {
    size,
    cx: size / 2,
    cy: size / 2,
    rEdge,
    rRim: mm(LP_MM.rim),
    rLeadIn: mm(LP_MM.maxRecorded),
    rProgIn: mm(LP_MM.minRecorded),
    rDeadWax: mm(LP_MM.deadWax),
    rLabel: mm(LP_MM.label),
    gap: Math.max(MIN_GAP_PX, mm(LP_MM.gap)),
  };
}

export interface Band {
  index: number;
  /** Outer radius — where the track starts. */
  outer: number;
  /** Inner radius — where the track ends. */
  inner: number;
  /** `outer - inner`. Proportional to the track's duration. */
  width: number;
  /** Duration used for the layout (see `layoutBands` on unknown durations). */
  durationSecs: number;
}

/**
 * Width of the land ring below `bands[i]`, derived from the band table rather
 * than from `geo.gap` — `layoutBands` shrinks the gap when a dense queue can't
 * afford the full one, so the table is the only truthful source.
 */
export function gapAfter(bands: Band[], i: number): number {
  const next = bands[i + 1];
  return next ? Math.max(0, bands[i].inner - next.outer) : 0;
}

/**
 * Press a list of track durations into concentric bands, outermost first.
 *
 * Unknown durations are real and common — a metadata-only plugin or streaming
 * track often has none — so when *no* track carries a usable duration the
 * bands are split evenly rather than collapsing to zero width. A partially
 * known list keeps the known proportions and gives the unknown tracks nothing,
 * which is the honest reading: we don't know how long they are.
 */
export function layoutBands(
  durations: (number | null | undefined)[],
  geo: VinylGeometry,
): Band[] {
  const n = durations.length;
  if (n === 0) return [];

  const safe = durations.map((d) =>
    typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0,
  );
  const total = safe.reduce((s, d) => s + d, 0);
  // Nothing usable at all → equal bands, so the record still presses.
  const weights =
    total > 0 ? safe.map((d) => d / total) : safe.map(() => 1 / n);

  const span = geo.rLeadIn - geo.rProgIn;
  // Shrink the land rings if the queue is too dense to afford them, so the
  // pressing always ends exactly on the run-out instead of overrunning it.
  const gap =
    n > 1 ? Math.min(geo.gap, (span * MAX_GAP_SHARE) / (n - 1)) : 0;
  const usable = Math.max(0, span - gap * (n - 1));

  const bands: Band[] = [];
  let r = geo.rLeadIn;
  for (let i = 0; i < n; i++) {
    const width = usable * weights[i];
    bands.push({
      index: i,
      outer: r,
      inner: r - width,
      width,
      durationSecs: safe[i],
    });
    r = r - width - (i < n - 1 ? gap : 0);
  }
  return bands;
}

export interface VinylPosition {
  index: number;
  positionSecs: number;
}

/**
 * Which track, and how far into it, sits at radius `r`.
 *
 * A radius inside a land ring resolves to the *end* of the band above it: the
 * needle is physically between tracks, and reporting the track it just left is
 * less surprising than reporting the one it hasn't reached.
 */
export function radiusToPosition(bands: Band[], r: number): VinylPosition | null {
  if (bands.length === 0) return null;

  const first = bands[0];
  if (r >= first.outer) return { index: 0, positionSecs: 0 };

  for (const b of bands) {
    if (r <= b.outer && r >= b.inner) {
      const frac = b.width > 0 ? (b.outer - r) / b.width : 0;
      return { index: b.index, positionSecs: frac * b.durationSecs };
    }
    // in the land ring below this band
    if (r < b.inner && b.index < bands.length - 1) {
      const next = bands[b.index + 1];
      if (r > next.outer) return { index: b.index, positionSecs: b.durationSecs };
    }
  }

  const last = bands[bands.length - 1];
  return { index: last.index, positionSecs: last.durationSecs };
}

/** Radius of the groove `positionSecs` into track `index`. */
export function positionToRadius(
  bands: Band[],
  index: number,
  positionSecs: number,
  geo: VinylGeometry,
): number {
  const b = bands[index];
  if (!b) return geo.rLeadIn;
  if (b.durationSecs <= 0) return b.outer;
  const frac = Math.max(0, Math.min(1, positionSecs / b.durationSecs));
  return b.outer - frac * b.width;
}

/** Clamp a radius to the playable program area. */
export function clampToProgram(r: number, geo: VinylGeometry): number {
  return Math.max(geo.rProgIn, Math.min(geo.rLeadIn, r));
}

export interface ArmMount {
  /** Pivot position, in deck coordinates. */
  px: number;
  py: number;
  /** Effective arm length in px. */
  length: number;
  /** Distance from disc centre to pivot. */
  distance: number;
}

export function buildArmMount(geo: VinylGeometry): ArmMount {
  const ang = (ARM.pivotAngleDeg * Math.PI) / 180;
  const distance = geo.rEdge * ARM.pivotDistance;
  return {
    px: geo.cx + distance * Math.cos(ang),
    py: geo.cy + distance * Math.sin(ang),
    length: geo.rEdge * ARM.length,
    distance,
  };
}

/**
 * Rotation (deg, CSS-positive = clockwise) that puts the stylus on radius `r`.
 *
 * Law of cosines on the triangle centre-pivot-stylus. Two solutions exist; we
 * take the one that keeps the arm on the same side as its pivot rather than
 * sweeping it across the label.
 *
 * CONTRACT: this solves for a stylus at exactly `mount.length` from the pivot —
 * i.e. at the arm element's FAR END. Whatever renders the arm must draw the
 * contact point there. Drawing the cartridge partway back along the headshell
 * (the natural way to draw one) silently shortens the effective arm and puts the
 * needle inside its true radius — most visibly at track 1, position 0, where it
 * should be sitting on the very rim. See the `.head` rules in style.ts.
 */
export function armAngleDeg(r: number, geo: VinylGeometry, mount: ArmMount): number {
  const { distance: D, length: L } = mount;
  const cos = (D * D + L * L - r * r) / (2 * D * L);
  const alpha = Math.acos(Math.max(-1, Math.min(1, cos)));
  const toCentre = Math.atan2(geo.cy - mount.py, geo.cx - mount.px);
  return ((toCentre - alpha) * 180) / Math.PI;
}

/**
 * Crop windows, in units of the disc radius relative to its centre.
 *
 * A record is radially symmetric: the angular dimension carries no playlist
 * information, only rotation and the glint. One radial slice already holds
 * every band and every gap, so `left-two-thirds` drops the mirror-image right
 * rim and spends the pixels on magnification instead.
 */
export const COMPOSITIONS = {
  full: { x0: -1.05, x1: 1.05, y0: -1.05, y1: 1.05, zoom: 1, mirrorArm: false },
  "left-two-thirds": { x0: -1.06, x1: 0.36, y0: -0.76, y1: 0.76, zoom: 1.3, mirrorArm: true },
} as const;

export type VinylComposition = keyof typeof COMPOSITIONS;

export interface CropBox {
  /** Viewport size in px. */
  width: number;
  height: number;
  /** Offset to apply to the (scaled) deck so the region lands at 0,0. */
  left: number;
  top: number;
  zoom: number;
  mirrorArm: boolean;
}

/**
 * Size the viewport *from* the crop region rather than hardcoding pixels, so a
 * composition stays correct when the geometry or deck size changes.
 */
export function buildCrop(composition: VinylComposition, geo: VinylGeometry): CropBox {
  const c = COMPOSITIONS[composition] ?? COMPOSITIONS.full;
  const R = geo.rEdge;
  const sx0 = geo.cx + c.x0 * R;
  const sx1 = geo.cx + c.x1 * R;
  const sy0 = geo.cy + c.y0 * R;
  const sy1 = geo.cy + c.y1 * R;
  return {
    width: Math.round((sx1 - sx0) * c.zoom),
    height: Math.round((sy1 - sy0) * c.zoom),
    left: -sx0 * c.zoom,
    top: -sy0 * c.zoom,
    zoom: c.zoom,
    mirrorArm: c.mirrorArm,
  };
}
