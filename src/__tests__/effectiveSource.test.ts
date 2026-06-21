import { describe, it, expect } from "vitest";
import { classifyEffectiveSource } from "../queueEntry";

// Owner map: tidal:// is owned by the tidal-browse plugin; everything else unknown.
const owner = (scheme: string): string | null => (scheme === "tidal" ? "tidal-browse" : null);

describe("classifyEffectiveSource", () => {
  it("classifies file:// as local", () => {
    expect(classifyEffectiveSource("file:///music/a.flac", owner)).toEqual({ kind: "local" });
  });

  it("classifies a plain path (no scheme) as local", () => {
    expect(classifyEffectiveSource("/music/a.flac", owner)).toEqual({ kind: "local" });
  });

  it("classifies subsonic:// as subsonic and keeps the uri", () => {
    expect(classifyEffectiveSource("subsonic://2/track-9", owner)).toEqual({
      kind: "subsonic",
      uri: "subsonic://2/track-9",
    });
  });

  it("classifies http(s):// as direct-url", () => {
    expect(classifyEffectiveSource("https://cdn.example/a.mp3", owner)).toEqual({
      kind: "direct-url",
      uri: "https://cdn.example/a.mp3",
    });
  });

  it("maps a known plugin scheme to its owning plugin id", () => {
    expect(classifyEffectiveSource("tidal://12345", owner)).toEqual({
      kind: "plugin",
      pluginId: "tidal-browse",
      uri: "tidal://12345",
    });
  });

  it("falls back to the scheme string when the owner is unknown", () => {
    expect(classifyEffectiveSource("spotify://abc", owner)).toEqual({
      kind: "plugin",
      pluginId: "spotify",
      uri: "spotify://abc",
    });
  });
});
