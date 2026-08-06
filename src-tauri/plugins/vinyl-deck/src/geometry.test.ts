import { describe, it, expect } from "vitest";
import {
  LP_MM,
  MIN_GAP_PX,
  buildGeometry,
  layoutBands,
  gapAfter,
  radiusToPosition,
  positionToRadius,
  clampToProgram,
  buildArmMount,
  armAngleDeg,
  buildCrop,
} from "./geometry";

const SIZE = 368;
const geo = buildGeometry(SIZE);

/** The queue used across the interaction tests: wildly uneven, on purpose. */
const DURATIONS = [112, 401, 187, 134, 483, 224, 91, 322];

describe("buildGeometry", () => {
  it("derives every radius from the real LP millimetres", () => {
    const ratio = (r: number) => r / geo.rEdge;
    expect(ratio(geo.rRim)).toBeCloseTo(LP_MM.rim / LP_MM.disc, 6);
    expect(ratio(geo.rLeadIn)).toBeCloseTo(LP_MM.maxRecorded / LP_MM.disc, 6);
    expect(ratio(geo.rProgIn)).toBeCloseTo(LP_MM.minRecorded / LP_MM.disc, 6);
    expect(ratio(geo.rDeadWax)).toBeCloseTo(LP_MM.deadWax / LP_MM.disc, 6);
    expect(ratio(geo.rLabel)).toBeCloseTo(LP_MM.label / LP_MM.disc, 6);
  });

  it("keeps the unplayable outer band at the real ~3.3% of the radius", () => {
    // This is the bug the geometry exists to prevent: an invented lead-in that
    // reads as a black moat. 5mm of 151mm is 3.3%.
    const blank = (geo.rEdge - geo.rLeadIn) / geo.rEdge;
    expect(blank).toBeGreaterThan(0.02);
    expect(blank).toBeLessThan(0.045);
  });

  it("orders the radii from the edge inwards", () => {
    expect(geo.rEdge).toBeGreaterThan(geo.rRim);
    expect(geo.rRim).toBeGreaterThan(geo.rLeadIn);
    expect(geo.rLeadIn).toBeGreaterThan(geo.rProgIn);
    expect(geo.rProgIn).toBeGreaterThan(geo.rDeadWax);
    expect(geo.rDeadWax).toBeGreaterThan(geo.rLabel);
  });

  it("clamps the gap to a visible floor on a small deck", () => {
    const small = buildGeometry(120);
    // true proportion here would be sub-pixel and simply disappear
    expect(small.rEdge * (LP_MM.gap / LP_MM.disc)).toBeLessThan(MIN_GAP_PX);
    expect(small.gap).toBe(MIN_GAP_PX);
  });

  it("uses the true proportion once the deck is big enough to show it", () => {
    const big = buildGeometry(1200);
    const trueGap = big.rEdge * (LP_MM.gap / LP_MM.disc);
    expect(trueGap).toBeGreaterThan(MIN_GAP_PX);
    expect(big.gap).toBeCloseTo(trueGap, 6);
  });
});

describe("layoutBands", () => {
  const bands = layoutBands(DURATIONS, geo);

  it("presses one band per track, outermost first", () => {
    expect(bands).toHaveLength(DURATIONS.length);
    expect(bands[0].outer).toBeCloseTo(geo.rLeadIn, 6);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].outer).toBeLessThan(bands[i - 1].inner + 1e-9);
    }
  });

  it("makes band width proportional to duration", () => {
    const total = DURATIONS.reduce((s, d) => s + d, 0);
    const usable = geo.rLeadIn - geo.rProgIn - geo.gap * (DURATIONS.length - 1);
    bands.forEach((b, i) => {
      expect(b.width).toBeCloseTo(usable * (DURATIONS[i] / total), 6);
    });
  });

  it("leaves exactly one gap between neighbours and none at the end", () => {
    for (let i = 0; i < bands.length - 1; i++) {
      expect(bands[i].inner - bands[i + 1].outer).toBeCloseTo(geo.gap, 6);
    }
    // the last band lands on the run-out, not short of it
    expect(bands[bands.length - 1].inner).toBeCloseTo(geo.rProgIn, 6);
  });

  it("gives a longer track a wider band than a shorter one", () => {
    const longest = bands[DURATIONS.indexOf(Math.max(...DURATIONS))];
    const shortest = bands[DURATIONS.indexOf(Math.min(...DURATIONS))];
    expect(longest.width).toBeGreaterThan(shortest.width);
  });

  it("splits evenly when no track has a usable duration", () => {
    // Real case: a queue of metadata-only plugin/streaming tracks.
    const unknown = layoutBands([null, undefined, 0, -5], geo);
    expect(unknown).toHaveLength(4);
    const w = unknown[0].width;
    expect(w).toBeGreaterThan(0);
    unknown.forEach((b) => expect(b.width).toBeCloseTo(w, 6));
  });

  it("handles a single track with no gaps", () => {
    const one = layoutBands([210], geo);
    expect(one).toHaveLength(1);
    expect(one[0].outer).toBeCloseTo(geo.rLeadIn, 6);
    expect(one[0].inner).toBeCloseTo(geo.rProgIn, 6);
  });

  it("returns nothing for an empty queue", () => {
    expect(layoutBands([], geo)).toEqual([]);
  });

  it("never overflows the program area, even with many tracks", () => {
    // A 60-track queue wants more total gap (59 x 2px) than the program area
    // has (~104px). Without the MAX_GAP_SHARE cap the bands ran straight
    // through the dead wax and into the label.
    const many = layoutBands(new Array(60).fill(180), geo);
    expect(many[many.length - 1].inner).toBeCloseTo(geo.rProgIn, 6);
    many.forEach((b) => {
      expect(b.width).toBeGreaterThanOrEqual(0);
      expect(b.inner).toBeGreaterThanOrEqual(geo.rProgIn - 1e-9);
      expect(b.outer).toBeLessThanOrEqual(geo.rLeadIn + 1e-9);
    });
  });

  it("shrinks the land rings rather than the program area when dense", () => {
    const dense = layoutBands(new Array(60).fill(180), geo);
    const g = gapAfter(dense, 0);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(geo.gap); // had to give up the full floor
    // gaps still take no more than their allowed share of the span
    const span = geo.rLeadIn - geo.rProgIn;
    expect(g * (dense.length - 1)).toBeLessThanOrEqual(span * 0.5 + 1e-9);
  });

  it("reports the real gap between neighbours via gapAfter", () => {
    const bs = layoutBands(DURATIONS, geo);
    for (let i = 0; i < bs.length - 1; i++) {
      expect(gapAfter(bs, i)).toBeCloseTo(geo.gap, 6);
    }
    expect(gapAfter(bs, bs.length - 1)).toBe(0); // nothing after the last band
  });
});

describe("radiusToPosition / positionToRadius", () => {
  const bands = layoutBands(DURATIONS, geo);

  it("round-trips a position through a radius", () => {
    for (const [index, pos] of [
      [0, 0],
      [1, 200],
      [4, 480],
      [7, 100],
    ] as const) {
      const r = positionToRadius(bands, index, pos, geo);
      const back = radiusToPosition(bands, r);
      expect(back?.index).toBe(index);
      expect(back?.positionSecs).toBeCloseTo(pos, 4);
    }
  });

  it("maps a band's outer edge to its start and inner edge to its end", () => {
    const b = bands[3];
    expect(radiusToPosition(bands, b.outer)?.index).toBe(3);
    expect(radiusToPosition(bands, b.outer)?.positionSecs).toBeCloseTo(0, 6);
    const end = radiusToPosition(bands, b.inner);
    expect(end?.index).toBe(3);
    expect(end?.positionSecs).toBeCloseTo(b.durationSecs, 4);
  });

  it("reports the track just left when the needle is in a land ring", () => {
    const b = bands[2];
    const inGap = radiusToPosition(bands, b.inner - geo.gap / 2);
    expect(inGap?.index).toBe(2);
    expect(inGap?.positionSecs).toBeCloseTo(b.durationSecs, 4);
  });

  it("clamps beyond the rim to the very start", () => {
    const p = radiusToPosition(bands, geo.rEdge + 50);
    expect(p).toEqual({ index: 0, positionSecs: 0 });
  });

  it("clamps inside the label to the very end", () => {
    const p = radiusToPosition(bands, 1);
    expect(p?.index).toBe(bands.length - 1);
    expect(p?.positionSecs).toBeCloseTo(DURATIONS[DURATIONS.length - 1], 4);
  });

  it("returns null for an empty pressing", () => {
    expect(radiusToPosition([], 100)).toBeNull();
  });

  it("resolves every radius across the program area to some band", () => {
    for (let r = geo.rProgIn; r <= geo.rLeadIn; r += 0.5) {
      const p = radiusToPosition(bands, r);
      expect(p).not.toBeNull();
      expect(p!.index).toBeGreaterThanOrEqual(0);
      expect(p!.index).toBeLessThan(bands.length);
      expect(p!.positionSecs).toBeGreaterThanOrEqual(0);
      expect(p!.positionSecs).toBeLessThanOrEqual(bands[p!.index].durationSecs + 1e-6);
    }
  });

  it("pins a zero-duration band to its outer edge instead of dividing by zero", () => {
    const odd = layoutBands([100, 0, 100], geo);
    const r = positionToRadius(odd, 1, 50, geo);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeCloseTo(odd[1].outer, 6);
  });
});

describe("clampToProgram", () => {
  it("keeps a radius inside the playable area", () => {
    expect(clampToProgram(geo.rEdge + 99, geo)).toBeCloseTo(geo.rLeadIn, 6);
    expect(clampToProgram(0, geo)).toBeCloseTo(geo.rProgIn, 6);
    expect(clampToProgram(120, geo)).toBe(120);
  });
});

describe("armAngleDeg", () => {
  const mount = buildArmMount(geo);

  it("mounts the pivot clear of the record", () => {
    const d = Math.hypot(mount.px - geo.cx, mount.py - geo.cy);
    expect(d).toBeGreaterThan(geo.rEdge);
  });

  it("can reach both ends of the program area", () => {
    // reachability: |D - L| <= r <= D + L
    const reach = Math.abs(mount.distance - mount.length);
    expect(reach).toBeLessThanOrEqual(geo.rProgIn);
    expect(mount.distance + mount.length).toBeGreaterThanOrEqual(geo.rLeadIn);
  });

  it("sweeps monotonically as the needle tracks inwards", () => {
    let prev = -Infinity;
    for (let r = geo.rLeadIn; r >= geo.rProgIn; r -= 2) {
      const a = armAngleDeg(r, geo, mount);
      expect(Number.isFinite(a)).toBe(true);
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it("puts the stylus on the requested radius", () => {
    for (const r of [geo.rLeadIn, 140, 110, geo.rProgIn]) {
      const deg = armAngleDeg(r, geo, mount);
      const rad = (deg * Math.PI) / 180;
      const sx = mount.px + mount.length * Math.cos(rad);
      const sy = mount.py + mount.length * Math.sin(rad);
      expect(Math.hypot(sx - geo.cx, sy - geo.cy)).toBeCloseTo(r, 4);
    }
  });

  it("stays finite for an unreachable radius instead of returning NaN", () => {
    expect(Number.isFinite(armAngleDeg(0, geo, mount))).toBe(true);
    expect(Number.isFinite(armAngleDeg(1e6, geo, mount))).toBe(true);
  });
});

describe("buildCrop", () => {
  it("shows the whole disc for the full composition", () => {
    const crop = buildCrop("full", geo);
    expect(crop.zoom).toBe(1);
    expect(crop.mirrorArm).toBe(false);
    expect(crop.width).toBeGreaterThanOrEqual(Math.round(geo.rEdge * 2));
  });

  it("drops the redundant right rim and magnifies for left-two-thirds", () => {
    const full = buildCrop("full", geo);
    const left = buildCrop("left-two-thirds", geo);
    expect(left.zoom).toBeGreaterThan(1);
    expect(left.mirrorArm).toBe(true);
    // narrower slice of the disc than the full view, despite being magnified
    expect(left.width / left.zoom).toBeLessThan(full.width / full.zoom);
    // the label is radially unique, not a duplicate, so it stays in frame
    expect(geo.cx + 0.36 * geo.rEdge).toBeGreaterThan(geo.cx + geo.rLabel * 0.9);
  });

  it("scales the viewport with the deck size", () => {
    const small = buildCrop("left-two-thirds", buildGeometry(200));
    const big = buildCrop("left-two-thirds", buildGeometry(600));
    expect(big.width).toBeGreaterThan(small.width);
    expect(big.width / small.width).toBeCloseTo(3, 1);
  });

  it("falls back to the full disc for an unknown composition", () => {
    // plugins are third-party: an unrecognised value must not blank the deck
    const crop = buildCrop("nonsense" as never, geo);
    expect(crop).toEqual(buildCrop("full", geo));
  });
});
