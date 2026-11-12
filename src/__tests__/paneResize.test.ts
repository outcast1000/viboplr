import { describe, it, expect } from "vitest";
import { MAIN_MIN_WIDTH, QUEUE_LIMITS, SIDEBAR_LIMITS, effectivePaneLimits, stepPaneDrag, type PaneLimits } from "../utils/paneResize";

describe("effectivePaneLimits", () => {
  it("keeps the main column at its minimum beside the other pane", () => {
    expect(effectivePaneLimits(QUEUE_LIMITS, 1000, 220).max).toBe(1000 - 220 - MAIN_MIN_WIDTH);
    expect(effectivePaneLimits(QUEUE_LIMITS, 3000, 220).max).toBe(600);
  });

  it("never caps below the pane's own minimum", () => {
    expect(effectivePaneLimits(SIDEBAR_LIMITS, 500, 300).max).toBe(SIDEBAR_LIMITS.min);
  });
});

const L: PaneLimits = SIDEBAR_LIMITS; // min 160, max 320, rail 56, collapse < 110, open > 130

describe("stepPaneDrag", () => {
  it("resizes between min and max", () => {
    expect(stepPaneDrag(250, false, 220, L)).toMatchObject({ collapsed: false, width: 250, phase: "resize" });
    expect(stepPaneDrag(900, false, 220, L)).toMatchObject({ collapsed: false, width: 320, phase: "resize" });
  });

  it("holds at min in the collapse zone and fills the meter toward the line", () => {
    const step = stepPaneDrag(135, false, 160, L);
    expect(step).toMatchObject({ collapsed: false, width: 160, phase: "zone-collapse" });
    expect(step.progress).toBeCloseTo(0.5);
  });

  it("collapses past the collapse line, keeping the open width for later", () => {
    expect(stepPaneDrag(100, false, 160, L)).toMatchObject({ collapsed: true, width: 160, phase: "collapsed" });
  });

  it("keeps saying 'release to collapse' on later moves of the drag that collapsed it", () => {
    expect(stepPaneDrag(60, true, 160, L, false)).toMatchObject({ collapsed: true, phase: "collapsed" });
    expect(stepPaneDrag(120, true, 160, L, false)).toMatchObject({ collapsed: true, phase: "collapsed" });
    expect(stepPaneDrag(60, true, 160, L, true).phase).toBe("rest");
  });

  it("does not flicker between the two lines (hysteresis)", () => {
    // Open at 120 stays open (above collapseAt); collapsed at 120 stays collapsed (below expandAt).
    expect(stepPaneDrag(120, false, 160, L).collapsed).toBe(false);
    expect(stepPaneDrag(120, true, 160, L).collapsed).toBe(true);
  });

  it("opens a collapsed pane once dragged past the open line, at least at min", () => {
    expect(stepPaneDrag(131, true, 240, L)).toMatchObject({ collapsed: false, width: 160, phase: "zone-collapse" });
    expect(stepPaneDrag(260, true, 240, L)).toMatchObject({ collapsed: false, width: 260, phase: "resize" });
  });

  it("reports the approach to the open line from the rail", () => {
    expect(stepPaneDrag(58, true, 240, L).phase).toBe("rest");
    const step = stepPaneDrag(93, true, 240, L);
    expect(step.phase).toBe("zone-expand");
    expect(step.progress).toBeCloseTo(37 / 74);
  });

  it("keeps the open line further out than the collapse line for both panes", () => {
    for (const l of [SIDEBAR_LIMITS, QUEUE_LIMITS]) {
      expect(l.rail).toBeLessThan(l.collapseAt);
      expect(l.collapseAt).toBeLessThan(l.expandAt);
      expect(l.expandAt).toBeLessThan(l.min);
    }
  });
});
