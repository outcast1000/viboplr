// Canvas painter for the `vinyl-deck` plugin view kind.
//
// Deliberately paints in BLACK AND WHITE ALPHA ONLY — no colour is read from
// anywhere. The disc body, sheen and accents are CSS layers under and over this
// canvas, which means:
//   * the surface never has to be repainted when the user changes skin, and
//   * it cannot hardcode a colour and break a skin (see conventions.md
//     "Skin System Compatibility").
// Grooves lighten (white at low alpha), land rings darken (black), and the CSS
// beneath decides what colour is being lightened or darkened.

import { type Band, type VinylGeometry, gapAfter } from "./geometry";

/** Base groove brightness. */
export const GROOVE_BASE = 0.125;

/**
 * How much the cached waveform shows in the groove texture.
 *
 * The studio-black surface keeps this subtle: grooves stay essentially uniform
 * and the track's dynamics only whisper through. Raising it slides toward an
 * overtly data-driven surface; 0 makes the grooves perfectly even.
 */
export const WAVE_PRESENCE = 0.075;

/** Radial distance between painted grooves, px. */
const GROOVE_PITCH = 1.15;
/** Radial distance between the coarser lead-in / run-out guide grooves, px. */
const GUIDE_PITCH = 1.5;

export type BandPeaks = ArrayLike<number> | null | undefined;

/**
 * Paint the record surface. Cheap enough to redraw on resize, but it only needs
 * to run when the size or the pressing changes — never on a skin change, and
 * never per animation frame (rotation is a CSS transform on a parent).
 */
export function paintVinylSurface(
  canvas: HTMLCanvasElement,
  geo: VinylGeometry,
  bands: Band[],
  peaks?: BandPeaks[],
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.max(1, Math.round(geo.size * dpr));
  canvas.height = Math.max(1, Math.round(geo.size * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, geo.size, geo.size);

  const { cx, cy, rEdge, rRim, rLeadIn, rProgIn, rDeadWax, rLabel } = geo;

  const ring = (r: number, w: number, colour: string) => {
    if (r <= 0.5) return;
    ctx.lineWidth = w;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  };
  const white = (a: number) => `rgba(255,255,255,${a})`;
  const black = (a: number) => `rgba(0,0,0,${a})`;

  // --- rim: the smooth raised lip. Lit on the outside, dark on the inside. ---
  ring(rEdge - 1, 2, white(0.17));
  ring(rRim, 1, black(0.9));

  // --- lead-in: one coarse guide spiral, ~2.5mm. Not a moat. ---
  for (let r = rRim - 1.2; r > rLeadIn; r -= GUIDE_PITCH) ring(r, 1, white(0.07));
  ring(rLeadIn + 0.6, 1, black(0.95));

  // --- program area: one grooved band per track ---
  bands.forEach((b, i) => {
    const p = peaks?.[i];
    const n = p ? p.length : 0;
    for (let r = b.outer; r >= b.inner; r -= GROOVE_PITCH) {
      // 0..1 through the track, so the waveform maps to the groove's radius
      const frac = b.width > 0 ? (b.outer - r) / b.width : 0;
      const amp = n > 0 ? p![Math.min(n - 1, Math.floor(frac * n))] : 0.5;
      ring(r, 0.85, white(GROOVE_BASE + amp * WAVE_PRESENCE));
    }

    // --- the land ring: smooth black, no grooves. ---
    // A real gap is read by its *specular* difference, not its brightness: the
    // grooved bands either side scatter the room light while the land reflects
    // it coherently. The fixed sheen layer above the canvas supplies that. At
    // ~2px the band is too thin to carry the read on width alone, so define its
    // boundary — the first groove wall catches the light — and leave the land
    // itself black.
    const gap = gapAfter(bands, i);
    if (gap > 0) {
      const gOut = b.inner;
      const gIn = b.inner - gap;
      ctx.fillStyle = black(1);
      ctx.beginPath();
      ctx.arc(cx, cy, gOut, 0, Math.PI * 2);
      ctx.arc(cx, cy, gIn, 0, Math.PI * 2, true);
      ctx.fill();
      ring(gOut - 0.5, 1, white(0.2));
      ring(gIn + 0.5, 1, white(0.05));
    }
  });

  // --- run-out + dead wax (where the matrix numbers are etched) ---
  ring(rProgIn - 1, 1.4, black(0.95));
  for (let r = rProgIn - 3; r > rDeadWax; r -= 3.2) ring(r, 1, white(0.04));
  ring(rLabel + 0.5, 1, white(0.09));
}
