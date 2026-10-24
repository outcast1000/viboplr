import { describe, it, expect } from "vitest";
import { isMixtapePath } from "../hooks/useFileDrop";

// A dropped .mixtape is played by App; the queue's file-drop path must skip it,
// or it reports "No playable media found" over the mixtape that is starting.
describe("isMixtapePath", () => {
  it("matches the extension case-insensitively", () => {
    expect(isMixtapePath("/Music/Road Trip.mixtape")).toBe(true);
    expect(isMixtapePath("C:\\Music\\ROAD TRIP.MIXTAPE")).toBe(true);
  });

  it("leaves media and look-alikes alone", () => {
    expect(isMixtapePath("/Music/song.mp3")).toBe(false);
    expect(isMixtapePath("/Music/song.mixtape.mp3")).toBe(false);
    expect(isMixtapePath("/Music/mixtape")).toBe(false);
  });
});
