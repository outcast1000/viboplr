// The vinyl deck as a plugin visualizer.
//
// It renders host state and owns none of it: the only writes are `seek` and
// `playQueueIndex`, which are exactly the two gestures a tonearm has.
//
// Geometry and painting come from ./geometry and ./surface — the same modules
// the tests exercise. Before this plugin had a build step both had to be
// re-derived by hand in ES5, which is precisely the duplication this replaces.

import type {
  PluginVisualizer,
  PluginVisualizerHost,
  PluginVisualizerSize,
  PluginVisualizerState,
} from "../../../../src/types/pluginVisualizer";
import {
  type Band,
  type VinylComposition,
  armAngleDeg,
  buildArmMount,
  buildCrop,
  buildGeometry,
  clampToProgram,
  layoutBands,
  positionToRadius,
  radiusToPosition,
} from "./geometry";
import { paintVinylSurface } from "./surface";
import { DECK_CSS } from "./style";

/**
 * Presentation-only options, shared **by reference** with the plugin.
 *
 * The host re-mounts a visualizer only when the slot's *selection* changes, so a
 * settings change can't arrive as a new mount. Handing over a live object the
 * plugin mutates is how a running deck picks up a new tilt on its next frame.
 */
export interface DeckOptions {
  composition: VinylComposition;
  tilt: number;
  emphasiseGaps: boolean;
}

export function createVinylDeckVisualizer(options: DeckOptions): PluginVisualizer {
  let host: PluginVisualizerHost;
  let root: ShadowRoot;
  let deck: HTMLElement;
  let platter: HTMLElement;
  let spin: HTMLElement;
  let canvas: HTMLCanvasElement;
  let label: HTMLElement;
  let arm: HTMLElement;
  let gapLayer: HTMLElement;

  /** The plugin sandbox passes `document: undefined` and a frozen `window`, so
   *  ambient DOM is unavailable by design. Everything comes through the one
   *  handle the contract grants: the shadow root. */
  let doc: Document;

  let geo = buildGeometry(2);
  let mountPoint = buildArmMount(geo);
  let bands: Band[] = [];
  let size: PluginVisualizerSize = { width: 0, height: 0 };

  let lastRevision = -1;
  let lastArt: string | null = null;
  let lastApplied = "";
  let currentIndex = -1;
  const unsubs: (() => void)[] = [];

  /** Lay out and repaint. Called on a queue or size change — never per frame. */
  function repress(durations: (number | null)[]) {
    const box = Math.max(40, Math.min(size.width, size.height));
    geo = buildGeometry(box);
    mountPoint = buildArmMount(geo);
    bands = layoutBands(durations, geo);

    const crop = buildCrop(options.composition, geo);
    // The crop trades the disc's redundant angular symmetry for magnification;
    // centre whatever window it produces inside the slot we were given.
    platter.style.width = `${geo.size}px`;
    platter.style.height = `${geo.size}px`;
    platter.style.transform =
      crop.zoom === 1
        ? ""
        : `scale(${crop.zoom}) translate(${crop.left / crop.zoom}px, ${crop.top / crop.zoom}px)`;

    canvas.style.width = `${geo.size}px`;
    canvas.style.height = `${geo.size}px`;
    label.style.width = `${geo.rLabel * 2}px`;
    label.style.height = `${geo.rLabel * 2}px`;

    // Everything in the CSS is authored against a 368px reference deck, so
    // publish the ratio and let those rules scale with calc(). Without this
    // the disc grows but the tonearm's pivot, tube and headshell stay at
    // their original pixel sizes and the arm looks like wire.
    deck.style.setProperty("--k", String(geo.size / 368));

    arm.style.left = `${mountPoint.px}px`;
    arm.style.top = `${mountPoint.py}px`;
    arm.style.width = `${mountPoint.length}px`;
    // Mirror the arm for a left-hand crop so the playhead survives it.
    deck.classList.toggle("mirror-arm", crop.mirrorArm);

    paintVinylSurface(canvas, geo, bands);
    renderGapRings();
  }

  function renderGapRings() {
    gapLayer.textContent = "";
    if (!options.emphasiseGaps) return;
    for (let i = 0; i < bands.length - 1; i++) {
      const d = (bands[i].inner - (bands[i].inner - bands[i + 1].outer) / 2) * 2;
      const ring = doc.createElement("div");
      ring.className = "gap-ring";
      ring.style.width = `${d}px`;
      ring.style.height = `${d}px`;
      gapLayer.append(ring);
    }
  }

  /**
   * Screen point → groove radius.
   *
   * Measure the PLATTER, never the canvas. The canvas lives inside the spinning
   * layer, and getBoundingClientRect() on a rotated element returns the
   * axis-aligned box of the rotated shape — so its width breathes by up to a
   * factor of root-2 and its origin drifts every frame. Measuring it made every
   * computed radius wrong by a varying amount, which silently broke both cue
   * gestures while the drawing still looked perfect.
   *
   * The platter carries the crop's scale, so one factor is still right for every
   * composition.
   */
  function radiusAt(clientX: number, clientY: number): number {
    const rect = platter.getBoundingClientRect();
    const unit = rect.width / geo.size || 1;
    const x = (clientX - rect.left) / unit - geo.cx;
    const y = (clientY - rect.top) / unit - geo.cy;
    return Math.hypot(x, y);
  }

  /**
   * Cue by dragging. Uses pointer capture on the element itself rather than
   * window listeners: the sandbox exposes no ambient `window`, and capture is
   * the right primitive regardless — the drag keeps tracking outside the disc
   * and can't be stolen by another element. (Pointer events, not HTML5 DnD,
   * which the repo bans in this webview.)
   */
  function onDown(e: PointerEvent, fromArm = false) {
    if (e.button !== 0 || bands.length === 0) return;
    const r0 = radiusAt(e.clientX, e.clientY);
    // The groove-radius guard applies to SCRUBBING only: a press on the label,
    // dead wax or rim is ignored rather than clamped, because clamping would
    // make a click on the album art silently jump to track 1.
    //
    // It must NOT gate grabbing the ARM. The headshell sits at (and visually
    // past) the rim, the tube runs out to a pivot beyond the disc entirely, and
    // while lifted the whole arm is offset — so nearly every real grab lands
    // outside the program area and this guard would reject it.
    if (!fromArm && (r0 < geo.rProgIn || r0 > geo.rLeadIn)) return;
    e.preventDefault();

    const target = e.currentTarget as HTMLElement;
    // Grabbing the arm resolves nothing until the pointer actually moves: the
    // press point on the arm graphic says nothing about a groove, so a click
    // without a drag must be a no-op rather than a jump to wherever it landed.
    let last = fromArm ? null : radiusToPosition(bands, r0);
    const move = (ev: PointerEvent) => {
      last = radiusToPosition(bands, clampToProgram(radiusAt(ev.clientX, ev.clientY), geo));
    };
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      if (!last) return;
      // Land on another band -> play it. Land inside the one already playing ->
      // seek within it. The two writes the contract allows, and the two a
      // tonearm needs.
      if (last.index === currentIndex) host.actions.seek(last.positionSecs);
      else host.actions.playQueueIndex(last.index);
    };
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // Capture is unavailable in some environments; the element-local
      // listeners still cover a drag that stays over the disc.
    }
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
  }

  return {
    mount(h) {
      host = h;
      root = h.root;
      size = h.size;

      doc = root.ownerDocument;
      const style = doc.createElement("style");
      style.textContent = DECK_CSS;
      root.append(style);

      deck = doc.createElement("div");
      deck.className = "deck lifted";
      // What rotates matters more than that something rotates. The canvas is
      // nothing but concentric rings, so it is rotationally symmetric and
      // spinning it alone is INVISIBLE. The label (asymmetric art) and the
      // anisotropic shimmer must turn with it — they are what the eye reads as
      // motion. The spindle, the specular sheen and the iridescence stay
      // outside: a real record's glint is fixed by the room light while the
      // grooves turn under it.
      deck.innerHTML =
        '<div class="platter">' +
        '<div class="body"></div>' +
        '<div class="spin">' +
        "<canvas></canvas>" +
        '<div class="shimmer"></div>' +
        '<div class="label"></div>' +
        "</div>" +
        '<div class="sheen"></div>' +
        '<div class="iris"></div>' +
        '<div class="gaps"></div>' +
        '<div class="hole"></div>' +
        '<div class="scrub"></div>' +
        // Four nested wrappers, one job each, because they need different
        // transforms AND different transitions: armwrap = mirror for a
        // left-hand crop, armrise = screen-space lift, arm = tracking
        // rotation (every frame), armlift = depth. Collapsing any two makes
        // the slow cue easing smear the per-frame tracking.
        '<div class="armwrap"><div class="armrise"><div class="arm"><div class="armlift">' +
        '<div class="counter"></div><div class="pivot"></div>' +
        '<div class="tube"></div><div class="shadow"></div><div class="head"></div>' +
        "</div></div></div></div>" +
        "</div>";
      root.append(deck);

      platter = deck.querySelector(".platter") as HTMLElement;
      spin = deck.querySelector(".spin") as HTMLElement;
      canvas = deck.querySelector("canvas") as HTMLCanvasElement;
      label = deck.querySelector(".label") as HTMLElement;
      arm = deck.querySelector(".arm") as HTMLElement;
      gapLayer = deck.querySelector(".gaps") as HTMLElement;

      (deck.querySelector(".scrub") as HTMLElement).addEventListener("pointerdown", onDown);
      arm.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); // don't also start a groove scrub
        onDown(e, true);
      });

      unsubs.push(
        h.onResize((s) => {
          size = s;
          lastRevision = -1; // re-press at the new size
        }),
      );
      // Nothing to re-bake: the surface is painted in alpha only, so a skin
      // change is handled entirely by CSS inheriting through the shadow root.
      unsubs.push(h.onSkinChange(() => {}));
    },

    frame(state: PluginVisualizerState) {
      // Settings are shared by reference, so fold them into the same cheap
      // "does the expensive work need redoing?" check as the queue.
      const applied = `${options.composition}|${options.emphasiseGaps}`;
      if (state.queueRevision !== lastRevision || applied !== lastApplied) {
        lastRevision = state.queueRevision;
        lastApplied = applied;
        repress(state.queue.map((t) => t.durationSecs));
      }
      deck.style.setProperty("--tilt", `${options.tilt}deg`);
      if (bands.length === 0) return;

      currentIndex = state.currentIndex;
      const art = state.queue[state.currentIndex]?.artUrl ?? null;
      if (art !== lastArt) {
        lastArt = art;
        label.style.backgroundImage = art ? `url("${art}")` : "";
      }

      const idx = Math.max(0, Math.min(bands.length - 1, state.currentIndex));
      const r = positionToRadius(bands, idx, state.positionSecs, geo);
      arm.style.setProperty("--deg", `${armAngleDeg(r, geo, mountPoint).toFixed(2)}deg`);
      // The cue lever lifts the arm on pause; the platter never stops.
      deck.classList.toggle("lifted", !state.playing);

      // A real platter turns whether or not it's playing. The app's global
      // reduced-motion CSS guard can't cross a shadow boundary, and could never
      // reach a JS-driven rotation, so honour the flag here.
      if (!host.reducedMotion) {
        spin.style.transform = `rotate(${((state.timeMs / 1800) * 360) % 360}deg)`;
      }
    },

    destroy() {
      for (const u of unsubs) {
        try {
          u();
        } catch {
          // Teardown is best-effort; a throw here would strand the rest.
        }
      }
      unsubs.length = 0;
    },
  };
}
