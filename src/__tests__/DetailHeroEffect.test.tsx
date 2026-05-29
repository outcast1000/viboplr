import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { DetailHeroEffect, shouldPauseEffect } from "../components/DetailHeroEffect";
import { getLook } from "../heroLooks";

beforeEach(() => {
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

describe("DetailHeroEffect", () => {
  it("renders nothing when look is null", () => {
    const { container } = render(<DetailHeroEffect look={null} />);
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("renders nothing for a look with no overlay layers (minimal)", () => {
    const { container } = render(<DetailHeroEffect look={getLook("minimal")} />);
    expect(container.querySelector(".detail-hero-effect")).toBeNull();
  });

  it("renders the full VHS layer set for worn-tape", () => {
    const { container } = render(<DetailHeroEffect look={getLook("worn-tape")} />);
    const root = container.querySelector(".detail-hero-effect");
    expect(root).not.toBeNull();
    expect(root?.classList.contains("look-worn-tape")).toBe(true);
    expect(container.querySelector(".tv-bleed")).not.toBeNull();
    expect(container.querySelector(".tv-bleed-2")).not.toBeNull();
    expect(container.querySelector(".tv-scan")).not.toBeNull();
    expect(container.querySelector(".tv-track")).not.toBeNull();
    expect(container.querySelector(".tv-noise")).not.toBeNull();
    expect(container.querySelector(".tv-noise-2")).not.toBeNull();
    expect(container.querySelector(".tv-vignette")).not.toBeNull();
  });

  it("renders only the layers a look declares (late-night: scan+flicker+vignette)", () => {
    const { container } = render(<DetailHeroEffect look={getLook("late-night")} />);
    expect(container.querySelector(".tv-scan")).not.toBeNull();
    expect(container.querySelector(".tv-flicker")).not.toBeNull();
    expect(container.querySelector(".tv-vignette")).not.toBeNull();
    expect(container.querySelector(".tv-noise")).toBeNull();
    expect(container.querySelector(".tv-bleed")).toBeNull();
    expect(container.querySelector(".tv-track")).toBeNull();
  });

  it("renders the glitch slice for signal-lost", () => {
    const { container } = render(<DetailHeroEffect look={getLook("signal-lost")} />);
    expect(container.querySelector(".tv-slice")).not.toBeNull();
    expect(container.querySelector(".tv-bleed")).not.toBeNull();
  });

  it("sets the noise texture as a CSS custom property", () => {
    const { container } = render(<DetailHeroEffect look={getLook("worn-tape")} />);
    const root = container.querySelector(".detail-hero-effect") as HTMLElement;
    expect(root.style.getPropertyValue("--tv-noise")).toContain("url(");
  });
});

describe("shouldPauseEffect", () => {
  it("does not pause when on-screen and visible", () => {
    expect(shouldPauseEffect(true, true)).toBe(false);
  });
  it("pauses when off-screen", () => {
    expect(shouldPauseEffect(false, true)).toBe(true);
  });
  it("pauses when the page is hidden", () => {
    expect(shouldPauseEffect(true, false)).toBe(true);
  });
  it("pauses when both off-screen and hidden", () => {
    expect(shouldPauseEffect(false, false)).toBe(true);
  });
});
