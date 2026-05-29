import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { DetailHero } from "../components/DetailHero";
import { __resetHeroEffectModeForTest } from "../heroEffectMode";
import { EFFECT_MODE_OPTIONS } from "../heroLooks";

vi.mock("../store", () => ({
  store: {
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
  },
}));

beforeEach(() => {
  __resetHeroEffectModeForTest();
  // @ts-expect-error test stub
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // @ts-expect-error remove the IntersectionObserver test stub
  delete globalThis.IntersectionObserver;
});

function renderHero() {
  return render(
    <DetailHero
      bgImages={["/a.jpg"]}
      art={<div>art</div>}
      artShape="square"
      title="Test Title"
      entityLabel="album"
      meta={[]}
      overflowItems={[]}
    />,
  );
}

function getSelect(container: HTMLElement): HTMLSelectElement {
  return container.querySelector(".detail-hero-fx-select") as HTMLSelectElement;
}

describe("DetailHero effect picker", () => {
  it("renders a select with all 11 mode options", () => {
    const { container } = renderHero();
    const select = getSelect(container);
    expect(select).not.toBeNull();
    expect(select.querySelectorAll("option")).toHaveLength(EFFECT_MODE_OPTIONS.length);
    expect(EFFECT_MODE_OPTIONS).toHaveLength(11);
  });

  it("defaults to worn-tape and renders the effect overlay", () => {
    const { container } = renderHero();
    expect(getSelect(container).value).toBe("worn-tape");
    expect(container.querySelector(".detail-hero-effect")).not.toBeNull();
    expect(container.querySelector(".detail-hero.hero-motion-wander")).not.toBeNull();
  });

  it("Disabled removes the overlay and the motion class (static hero)", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "disabled" } });
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
    expect(container.querySelector(".detail-hero[class*='hero-motion-']")).toBeNull();
  });

  it("Minimal keeps motion (current) but renders no overlay", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "minimal" } });
    expect(container.querySelector(".detail-hero.hero-motion-current")).not.toBeNull();
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("a named look renders its overlay and motion class", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "late-night" } });
    expect(container.querySelector(".detail-hero-effect.look-late-night")).not.toBeNull();
    expect(container.querySelector(".detail-hero.hero-motion-breathe")).not.toBeNull();
  });

  it("silent-film adds the B&W root modifier", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "silent-film" } });
    expect(container.querySelector(".detail-hero.hero-bw")).not.toBeNull();
  });

  it("by-artist resolves to some motion class (non-null) deterministically", () => {
    const { container } = renderHero();
    fireEvent.change(getSelect(container), { target: { value: "by-artist" } });
    expect(container.querySelector(".detail-hero[class*='hero-motion-']")).not.toBeNull();
  });
});
