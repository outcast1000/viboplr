import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TrackArtFallback, labelHue } from "../components/TrackArtFallback";

afterEach(cleanup);

describe("labelHue", () => {
  it("is stable per artist, ignoring case and surrounding space", () => {
    expect(labelHue("Low")).toBe(labelHue(" low "));
    expect(labelHue("Low")).not.toBe(labelHue("Björk"));
    expect(labelHue("Low")).toBeGreaterThanOrEqual(0);
    expect(labelHue("Low")).toBeLessThan(360);
  });
});

describe("TrackArtFallback", () => {
  it("draws a record with a plain, artist-coloured label for audio", () => {
    const { container } = render(<TrackArtFallback track={{ format: "flac", path: "file:///a.flac", artist_name: "Low" }} size={26} />);
    const svg = container.querySelector<SVGElement>("svg.track-art-fallback--audio");
    expect(svg).not.toBeNull();
    expect(svg!.style.color).not.toBe("");
    expect(container.textContent).toBe("");
  });

  it("draws a reel, with no letter, for video", () => {
    const { container } = render(<TrackArtFallback track={{ format: "mp4", path: "file:///v.mp4", artist_name: "Low" }} size={26} />);
    expect(container.querySelector("svg.track-art-fallback--video")).not.toBeNull();
    expect(container.textContent).toBe("");
  });

  it("gives every instance its own gradient and mask ids", () => {
    const { container } = render(
      <>
        <TrackArtFallback track={{ artist_name: "Low" }} size={26} />
        <TrackArtFallback track={{ artist_name: "Low" }} size={26} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of container.querySelectorAll("g[mask]")) {
      const ref = g.getAttribute("mask")!.match(/^url\(#(.+)\)$/)![1];
      expect(ids).toContain(ref);
    }
  });
});
