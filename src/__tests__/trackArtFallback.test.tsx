import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TrackArtFallback, labelHue, labelInitial } from "../components/TrackArtFallback";

afterEach(cleanup);

describe("labelInitial", () => {
  it("takes the artist's first letter or digit, skipping a leading article", () => {
    expect(labelInitial("Sofía Marín")).toBe("S");
    expect(labelInitial("The Weeknights")).toBe("W");
    expect(labelInitial("a-ha")).toBe("A");
    expect(labelInitial("björk")).toBe("B");
    expect(labelInitial("10cc")).toBe("1");
  });

  it("skips punctuation instead of printing it", () => {
    expect(labelInitial("[Hidden] Orchestra")).toBe("H");
    expect(labelInitial("(((")).toBeNull();
  });

  it("prints nothing for a missing or placeholder artist", () => {
    expect(labelInitial(null)).toBeNull();
    expect(labelInitial("")).toBeNull();
    expect(labelInitial("Unknown Artist")).toBeNull();
    expect(labelInitial("Various Artists")).toBeNull();
  });
});

describe("labelHue", () => {
  it("is stable per artist, ignoring case and surrounding space", () => {
    expect(labelHue("Low")).toBe(labelHue(" low "));
    expect(labelHue("Low")).not.toBe(labelHue("Björk"));
    expect(labelHue("Low")).toBeGreaterThanOrEqual(0);
    expect(labelHue("Low")).toBeLessThan(360);
  });
});

describe("TrackArtFallback", () => {
  it("draws a record with the artist's initial on the label for audio", () => {
    const { container } = render(<TrackArtFallback track={{ format: "flac", path: "file:///a.flac", artist_name: "Low" }} size={26} />);
    expect(container.querySelector("svg.track-art-fallback--audio")).not.toBeNull();
    expect(container.textContent).toBe("L");
  });

  it("leaves the initial off where it would be too small to read", () => {
    const { container } = render(<TrackArtFallback track={{ format: "mp3", artist_name: "Low" }} size={18} />);
    expect(container.querySelector("svg.track-art-fallback--audio")).not.toBeNull();
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
