import { describe, it, expect } from "vitest";
import {
  summarizeContributes,
  skinMockColors,
  mixHex,
} from "../utils/extensionSummary";
import type { PluginManifestContributes } from "../types/plugin";

const info = (id: string, name = "X") => ({
  id,
  name,
  description: "",
  entity: "track" as const,
  displayKind: "rich_text",
  ttl: 0,
});

describe("summarizeContributes", () => {
  it("returns [] for undefined", () => {
    expect(summarizeContributes(undefined)).toEqual([]);
  });

  it("maps well-known information type ids to tidy labels", () => {
    const c: PluginManifestContributes = {
      informationTypes: [info("artist_bio"), info("lyrics_lrclib"), info("similar_tracks")],
    };
    const caps = summarizeContributes(c);
    expect(caps).toContain("Bio");
    expect(caps).toContain("Lyrics");
    expect(caps).toContain("Similar");
  });

  it("falls back to the declared name for unknown info types", () => {
    const c: PluginManifestContributes = {
      informationTypes: [info("weird_thing", "Cosmic Vibes")],
    };
    expect(summarizeContributes(c)).toEqual(["Cosmic Vibes"]);
  });

  it("surfaces stream/download/image capabilities first and de-dupes", () => {
    const c: PluginManifestContributes = {
      streamResolvers: [{ id: "yt", name: "YouTube" }],
      downloadProviders: [{ id: "yt-dl", name: "YouTube" }],
      imageProviders: [{ entity: "artist" }, { entity: "album" }],
    };
    const caps = summarizeContributes(c);
    expect(caps).toEqual(["Streaming", "Download", "Images"]);
  });

  it("includes Sidebar view, Menu actions and Settings", () => {
    const c: PluginManifestContributes = {
      sidebarItems: [{ id: "v", label: "L", icon: "i" }],
      contextMenuItems: [{ id: "a", label: "Do", targets: ["track"] }],
      settingsPanel: { id: "s", label: "S", order: 1 },
    };
    const caps = summarizeContributes(c);
    expect(caps).toContain("Sidebar view");
    expect(caps).toContain("Menu actions");
    expect(caps).toContain("Settings");
  });
});

describe("mixHex", () => {
  it("blends two colors at the given weight", () => {
    expect(mixHex("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixHex("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mixHex("#000000", "#ffffff", 1)).toBe("#ffffff");
  });

  it("clamps weight and tolerates missing hash", () => {
    expect(mixHex("000000", "ffffff", 2)).toBe("#ffffff");
    expect(mixHex("#000000", "#ffffff", -1)).toBe("#000000");
  });

  it("returns the first color when input is unparseable", () => {
    expect(mixHex("not-a-color", "#ffffff", 0.5)).toBe("not-a-color");
  });
});

describe("skinMockColors", () => {
  it("maps the 4-tuple to mock slots and derives surface/now-playing", () => {
    const m = skinMockColors(["#1a1a2e", "#53a8ff", "#16213e", "#e0e0e0"]);
    expect(m.bg).toBe("#1a1a2e");
    expect(m.accent).toBe("#53a8ff");
    expect(m.sidebar).toBe("#16213e");
    expect(m.text).toBe("#e0e0e0");
    // derived tones are valid hex and distinct from their bases
    expect(m.surface).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.nowPlaying).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.nowPlaying).not.toBe(m.bg);
  });

  it("falls back to sane defaults when tuple is missing", () => {
    const m = skinMockColors(undefined);
    expect(m.bg).toMatch(/^#[0-9a-f]{6}$/);
    expect(m.accent).toMatch(/^#[0-9a-f]{6}$/);
  });
});
