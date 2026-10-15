// The first batch of cheap motion (frontend.md → "New motion must be cheap"):
// the turntable spin-down, the staggered shuffle and the row-removal fade.
// jsdom has no Element.animate and no layout, so the visual half is verified in
// a real browser; these pin the maths, the stagger wiring and the fallbacks.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { rampDegrees, SPIN_RAMP_MS } from "../hooks/useSpin";
import { useFlipList } from "../hooks/useFlipList";
import { SpinningDisc } from "../components/SpinningDisc";
import { fadeOutTrackRows } from "../utils/rowRemoval";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSpin ramp", () => {
  it("travels a distance whose fast end matches one turn per period", () => {
    // Ease-out/in cubic peak at 3× the average speed: 3 · d / T must equal 360 / period.
    for (const period of [1800, 1900]) {
      const d = rampDegrees(period);
      expect((3 * d) / SPIN_RAMP_MS).toBeCloseTo(360 / period, 10);
    }
    expect(rampDegrees(1800)).toBe(40);
  });

  it("renders and toggles without Element.animate (jsdom) and keeps the playing class", () => {
    const { container, rerender } = render(<SpinningDisc playing={false} />);
    rerender(<SpinningDisc playing />);
    expect(container.querySelector(".spinning-disc.playing")).not.toBeNull();
    rerender(<SpinningDisc playing={false} />);
    expect(container.querySelector(".spinning-disc.playing")).toBeNull();
  });
});

describe("useSpin state machine (fake Element.animate)", () => {
  type Call = { keyframes: Keyframe[]; options: KeyframeAnimationOptions };
  function installFakeAnimate() {
    const calls: Call[] = [];
    const original = (Element.prototype as { animate?: unknown }).animate;
    (Element.prototype as unknown as { animate: unknown }).animate = function (keyframes: Keyframe[], options: KeyframeAnimationOptions) {
      calls.push({ keyframes, options });
      return { cancel: vi.fn(), onfinish: null } as unknown as Animation;
    };
    return { calls, restore: () => { (Element.prototype as { animate?: unknown }).animate = original; } };
  }

  it("allocates nothing — no animation, no reduce-motion listener — for a disc that never plays", () => {
    const fake = installFakeAnimate();
    const listen = vi.spyOn(window, "addEventListener");
    render(<SpinningDisc playing={false} />);
    expect(fake.calls).toHaveLength(0);
    expect(listen.mock.calls.some(([type]) => String(type) === "viboplr:reduce-motion-change")).toBe(false);
    fake.restore();
  });

  it("a pause/play blip during the spin-up neither brakes nor restarts the ramp", () => {
    vi.useFakeTimers();
    const fake = installFakeAnimate();
    const { rerender } = render(<SpinningDisc playing={false} />);
    rerender(<SpinningDisc playing />);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].options.duration).toBe(SPIN_RAMP_MS); // the spin-up ramp
    rerender(<SpinningDisc playing={false} />);
    act(() => { vi.advanceTimersByTime(60); });
    rerender(<SpinningDisc playing />);
    act(() => { vi.advanceTimersByTime(500); });
    expect(fake.calls).toHaveLength(1); // still the same ramp
    // A real pause (past the grace) does slow it down.
    rerender(<SpinningDisc playing={false} />);
    act(() => { vi.advanceTimersByTime(200); });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].options.easing).toContain("0.33, 1, 0.68, 1"); // ease-out: the spin-down
    fake.restore();
    vi.useRealTimers();
  });
});

function ShuffleList({ initial }: { initial: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [order, setOrder] = useState(initial);
  const flip = useFlipList(ref);
  return (
    <div ref={ref}>
      <button data-testid="shuffle" onClick={() => { flip.staggerNext(); setOrder([...order].reverse()); }} />
      <button data-testid="reverse" onClick={() => setOrder([...order].reverse())} />
      {order.map((k) => <div key={k} data-flip-key={k}>{k}</div>)}
    </div>
  );
}

/** Lay rows out 30px apart in DOM order so FLIP sees real moves. */
function mockRowLayout() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const siblings = Array.from(this.parentElement?.children ?? []).filter((c) => (c as HTMLElement).dataset.flipKey);
    const top = siblings.indexOf(this) * 30;
    return { top, bottom: top + 30, left: 0, right: 100, width: 100, height: 30, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
}

function transitionDelays(container: HTMLElement): number[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-flip-key]")).map((el) => {
    const m = /(\d+)ms\s*$/.exec(el.style.transition);
    return m ? Number(m[1]) : 0;
  });
}

describe("useFlipList stagger", () => {
  it("staggers only the reorder that follows staggerNext()", async () => {
    mockRowLayout();
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { cb(0); return 0; });
    const { container, getByTestId } = render(<ShuffleList initial={["a", "b", "c", "d", "e", "f"]} />);

    act(() => { getByTestId("shuffle").click(); });
    const staggered = transitionDelays(container);
    expect(staggered[0]).toBe(0);
    expect(staggered.at(-1)!).toBeGreaterThan(0);
    expect(staggered.at(-1)!).toBeLessThanOrEqual(220); // the whole cascade starts within the span
    expect([...staggered].sort((x, y) => x - y)).toEqual(staggered); // dealt in order

    // Clear the inline styles the way transitionend would, then a plain reorder.
    container.querySelectorAll<HTMLElement>("[data-flip-key]").forEach((el) => { el.style.transition = ""; });
    act(() => { getByTestId("reverse").click(); });
    expect(transitionDelays(container).every((d) => d === 0)).toBe(true);
    raf.mockRestore();
  });
});

describe("fadeOutTrackRows", () => {
  it("is a no-op without Element.animate (jsdom), so deletes still commit", async () => {
    const row = document.createElement("div");
    row.dataset.trackId = "7";
    document.body.appendChild(row);
    const settle = await fadeOutTrackRows([7]);
    expect(() => settle()).not.toThrow();
    row.remove();
  });

  it("is a no-op for an empty id list", async () => {
    const settle = await fadeOutTrackRows([]);
    expect(() => settle()).not.toThrow();
  });
});
