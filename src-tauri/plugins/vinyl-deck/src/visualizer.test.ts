// Tests the SHIPPED visualizer against a fake host.
//
// This started life as a conformance harness with its own throwaway deck, which
// only proved the contract was expressible. Now that the deck really is a plugin
// it drives `createVinylDeckVisualizer` itself, so it proves the contract *and*
// the implementation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  PluginVisualizerHost,
  PluginVisualizerSize,
  PluginVisualizerState,
  PluginVisualizerTrack,
} from "../../../../src/types/pluginVisualizer";
import { createVinylDeckVisualizer, type DeckOptions } from "./visualizer";
import { buildGeometry, layoutBands, positionToRadius } from "./geometry";

const SIZE = 368;
const DURATIONS = [112, 401, 187, 134, 483, 224, 91, 322];
const QUEUE: PluginVisualizerTrack[] = DURATIONS.map((d, i) => ({
  title: `Track ${i + 1}`,
  artistName: "Halcyon Drift",
  albumTitle: "Sidereal",
  durationSecs: d,
  artUrl: null,
}));

/** Mirror of the geometry the deck will build, for computing where to click. */
const geo = buildGeometry(SIZE);
const bands = layoutBands(DURATIONS, geo);

function makeHost(over: Partial<PluginVisualizerHost> = {}) {
  const el = document.createElement("div");
  document.body.append(el);
  const root = el.attachShadow({ mode: "open" });
  const resizeHandlers: ((s: PluginVisualizerSize) => void)[] = [];
  const skinHandlers: (() => void)[] = [];
  const seek = vi.fn();
  const playQueueIndex = vi.fn();
  const token = vi.fn(() => "#6ea8ff");

  const host: PluginVisualizerHost = {
    root,
    size: { width: SIZE, height: SIZE },
    pixelRatio: 2,
    placement: "nowplaying",
    reducedMotion: false,
    token,
    useDesignSystem: vi.fn(),
    onResize: (h) => {
      resizeHandlers.push(h);
      return () => {
        const i = resizeHandlers.indexOf(h);
        if (i >= 0) resizeHandlers.splice(i, 1);
      };
    },
    onSkinChange: (h) => {
      skinHandlers.push(h);
      return () => {
        const i = skinHandlers.indexOf(h);
        if (i >= 0) skinHandlers.splice(i, 1);
      };
    },
    actions: { seek, playQueueIndex },
    ...over,
  };
  return { host, root, seek, playQueueIndex, token, resizeHandlers, skinHandlers };
}

function makeState(over: Partial<PluginVisualizerState> = {}): PluginVisualizerState {
  return {
    playing: true,
    positionSecs: 0,
    durationSecs: DURATIONS[0],
    queue: QUEUE,
    currentIndex: 0,
    queueRevision: 1,
    timeMs: 0,
    ...over,
  };
}

function opts(over: Partial<DeckOptions> = {}): DeckOptions {
  return { composition: "full", tilt: 0, emphasiseGaps: false, ...over };
}

let arcCount = 0;
const origRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  arcCount = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: () => {}, clearRect: () => {}, beginPath: () => {},
    arc: () => { arcCount++; }, stroke: () => {}, fill: () => {}, fillText: () => {},
    createRadialGradient: () => ({ addColorStop: () => {} }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
    lineWidth: 0, strokeStyle: "", fillStyle: "", font: "", textAlign: "",
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;

  // jsdom has no layout, and the deck converts screen px to deck units from the
  // PLATTER's rect. Stub that 1:1 so a client coordinate IS a deck coordinate.
  //
  // The canvas is deliberately given a WRONG rect here — the axis-aligned box of
  // a rotated square, which is what the real canvas reports because it lives
  // inside the spinning layer. Measuring the canvas instead of the platter
  // shipped as a bug that broke both cue gestures while the drawing still looked
  // perfect, and this stub is what keeps it from coming back.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this instanceof HTMLCanvasElement) {
      const spun = SIZE * Math.SQRT2; // as if mid-rotation
      return { x: 0, y: 0, left: -SIZE * 0.2, top: -SIZE * 0.2, width: spun, height: spun,
        right: spun, bottom: spun, toJSON: () => ({}) } as DOMRect;
    }
    if ((this as HTMLElement).classList?.contains("platter")) {
      return { x: 0, y: 0, left: 0, top: 0, width: SIZE, height: SIZE,
        right: SIZE, bottom: SIZE, toJSON: () => ({}) } as DOMRect;
    }
    return origRect.call(this);
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = origRect;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/** Press on the groove `secs` into track `index`, then release. */
function cue(root: ShadowRoot, index: number, secs: number) {
  const scrub = root.querySelector(".scrub") as HTMLElement;
  const r = positionToRadius(bands, index, secs, geo);
  const opt = { bubbles: true, button: 0, pointerId: 1, clientX: geo.cx - r, clientY: geo.cy };
  scrub.dispatchEvent(new MouseEvent("pointerdown", opt) as unknown as PointerEvent);
  scrub.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }) as unknown as PointerEvent);
}

describe("vinyl deck visualizer", () => {
  it("builds its DOM inside the shadow root", () => {
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    expect(root.querySelector("canvas")).toBeTruthy();
    expect(root.querySelector(".arm")).toBeTruthy();
    expect(root.querySelector(".label")).toBeTruthy();
  });

  it("takes its document from the shadow root, not an ambient global", () => {
    // The plugin sandbox passes `document: undefined`, so a visualizer reaching
    // for an ambient document would throw at mount. Proven by mounting with the
    // global shadowed.
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    const realDoc = globalThis.document;
    try {
      // @ts-expect-error deliberately simulating the sandbox
      globalThis.document = undefined;
      expect(() => v.mount(host)).not.toThrow();
    } finally {
      globalThis.document = realDoc;
    }
    expect(root.querySelector("canvas")).toBeTruthy();
  });

  it("presses the record once per queue change, not once per frame", () => {
    const { host } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);

    v.frame(makeState());
    const afterFirst = arcCount;
    expect(afterFirst).toBeGreaterThan(50); // a real pressing, not a stub

    for (let i = 1; i < 30; i++) v.frame(makeState({ positionSecs: i, timeMs: i * 16 }));
    expect(arcCount).toBe(afterFirst); // 30 frames, one repaint

    v.frame(makeState({ queueRevision: 2 }));
    expect(arcCount).toBeGreaterThan(afterFirst);
  });

  it("re-presses when a shared setting changes, since the host won't re-mount", () => {
    const o = opts();
    const { host } = makeHost();
    const v = createVinylDeckVisualizer(o);
    v.mount(host);
    v.frame(makeState());
    const before = arcCount;

    o.emphasiseGaps = true; // the plugin mutates the live object
    v.frame(makeState());
    expect(arcCount).toBeGreaterThan(before);
  });

  it("outlines one ring per inter-track gap, only when asked", () => {
    const o = opts();
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(o);
    v.mount(host);
    v.frame(makeState());
    expect(root.querySelectorAll(".gap-ring").length).toBe(0);

    o.emphasiseGaps = true;
    v.frame(makeState());
    expect(root.querySelectorAll(".gap-ring").length).toBe(DURATIONS.length - 1);
  });

  it("tracks the tonearm inwards as position advances", () => {
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    const arm = root.querySelector(".arm") as HTMLElement;

    v.frame(makeState({ currentIndex: 0, positionSecs: 0 }));
    const start = parseFloat(arm.style.getPropertyValue("--deg"));
    v.frame(makeState({ currentIndex: 5, positionSecs: 100 }));
    expect(parseFloat(arm.style.getPropertyValue("--deg"))).toBeGreaterThan(start);
  });

  it("lifts the arm when paused and keeps the platter turning", () => {
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    const deck = root.querySelector(".deck") as HTMLElement;
    const spin = root.querySelector(".spin") as HTMLElement;

    v.frame(makeState({ playing: true, timeMs: 0 }));
    expect(deck.classList.contains("lifted")).toBe(false);
    const a = spin.style.transform;

    v.frame(makeState({ playing: false, timeMs: 900 }));
    expect(deck.classList.contains("lifted")).toBe(true);
    expect(spin.style.transform).not.toBe(a); // still turning while paused
  });

  it("honours reduced motion, which no CSS guard can reach in a shadow root", () => {
    const { host, root } = makeHost({ reducedMotion: true });
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    const spin = root.querySelector(".spin") as HTMLElement;
    v.frame(makeState({ timeMs: 500 }));
    expect(spin.style.transform).toBe("");
  });

  it("plays another queue entry when cued onto a different band", () => {
    const { host, root, playQueueIndex, seek } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState({ currentIndex: 0 }));

    cue(root, 4, 240);
    expect(playQueueIndex).toHaveBeenCalledWith(4);
    expect(seek).not.toHaveBeenCalled();
  });

  it("seeks when cued inside the band already playing", () => {
    const { host, root, playQueueIndex, seek } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState({ currentIndex: 4, positionSecs: 10 }));

    cue(root, 4, 300);
    expect(seek).toHaveBeenCalledTimes(1);
    expect(seek.mock.calls[0][0]).toBeCloseTo(300, 0);
    expect(playQueueIndex).not.toHaveBeenCalled();
  });

  it("ignores a press on the label instead of jumping to track 1", () => {
    const { host, root, playQueueIndex, seek } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState());

    const scrub = root.querySelector(".scrub") as HTMLElement;
    scrub.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true, button: 0, clientX: geo.cx, clientY: geo.cy,
      }) as unknown as PointerEvent,
    );
    scrub.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }) as unknown as PointerEvent);
    expect(playQueueIndex).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
  });

  it("ignores non-primary buttons", () => {
    const { host, root, playQueueIndex } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState());

    const scrub = root.querySelector(".scrub") as HTMLElement;
    const r = positionToRadius(bands, 2, 60, geo);
    scrub.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true, button: 2, clientX: geo.cx - r, clientY: geo.cy,
      }) as unknown as PointerEvent,
    );
    scrub.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }) as unknown as PointerEvent);
    expect(playQueueIndex).not.toHaveBeenCalled();
  });

  it("mirrors the arm for the left-two-thirds crop", () => {
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts({ composition: "left-two-thirds" }));
    v.mount(host);
    v.frame(makeState());
    expect((root.querySelector(".deck") as HTMLElement).classList.contains("mirror-arm")).toBe(true);
  });

  it("survives an empty queue and unknown durations", () => {
    const { host } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    expect(() => v.frame(makeState({ queue: [], currentIndex: -1, queueRevision: 7 }))).not.toThrow();

    const unknown: PluginVisualizerTrack[] = [
      { title: "A", artistName: null, albumTitle: null, durationSecs: null, artUrl: null },
      { title: "B", artistName: null, albumTitle: null, durationSecs: null, artUrl: null },
    ];
    expect(() =>
      v.frame(makeState({ queue: unknown, currentIndex: 0, queueRevision: 8 })),
    ).not.toThrow();
  });

  it("survives a currentIndex past the end of the pressing", () => {
    const { host, root } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState({ currentIndex: 99 }));
    const deg = (root.querySelector(".arm") as HTMLElement).style.getPropertyValue("--deg");
    expect(Number.isFinite(parseFloat(deg))).toBe(true);
  });

  it("re-presses at the new size when the slot resizes", () => {
    const { host, resizeHandlers } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState());
    const before = arcCount;

    resizeHandlers.forEach((h) => h({ width: 200, height: 200 }));
    v.frame(makeState());
    expect(arcCount).toBeGreaterThan(before);
  });

  it("releases its subscriptions on destroy", () => {
    const { host, resizeHandlers, skinHandlers } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    expect(resizeHandlers.length).toBe(1);
    expect(skinHandlers.length).toBe(1);
    v.destroy();
    expect(resizeHandlers.length).toBe(0);
    expect(skinHandlers.length).toBe(0);
  });

  it("reads no skin token, so it cannot break a skin", () => {
    // The surface is painted in alpha only and every colour comes from CSS
    // inheriting through the shadow boundary. Structural skin-safety is gone
    // from the contract, but this deck keeps it by construction.
    const { host, token } = makeHost();
    const v = createVinylDeckVisualizer(opts());
    v.mount(host);
    v.frame(makeState());
    expect(token).not.toHaveBeenCalled();
  });
});
