// After a track couldn't be played, the failure dialog points at plugins that
// could find a playable copy. Pinned: only for "no source found", switched-off
// installed fallbacks before gallery ones, nothing already installed offered
// again, nothing that needs a newer app, and the heading's two cases told apart
// by what the chain actually asked.
import { describe, it, expect } from "vitest";
import { suggestPlaybackFallbacks } from "../utils/fallbackSuggestions";
import type { TrackFailure } from "../playback/trackFailures";
import type { GalleryPluginEntry, PluginState } from "../types/plugin";

const failure = (over: Partial<TrackFailure> = {}): TrackFailure => ({
  stage: "resolve",
  summary: "No playable source found",
  at: 0,
  attempts: [{ name: "Library", outcome: "miss" }],
  ...over,
});

const installed = (id: string, enabled: boolean, streamResolvers = true, stability?: string) =>
  ({
    id,
    enabled,
    status: enabled ? "active" : "disabled",
    manifest: {
      id, name: id.toUpperCase(), version: "1.0.0", author: "x", description: `${id} plugin`, stability,
      contributes: streamResolvers ? { streamResolvers: [{ id: "r", name: id }] } : {},
    },
  }) as unknown as Pick<PluginState, "id" | "enabled" | "status" | "manifest">;

const gallery = (id: string, over: Partial<GalleryPluginEntry> = {}): GalleryPluginEntry => ({
  id, name: id, author: "x", description: `${id} desc`, provides: ["playback-fallback"], ...over,
});

describe("suggestPlaybackFallbacks", () => {
  it("offers gallery playback fallbacks when none ran", () => {
    const out = suggestPlaybackFallbacks({
      failure: failure(),
      pluginStates: [],
      gallery: [gallery("ytdlp"), gallery("genius", { provides: ["assistant-tools"] })],
      appVersion: "1.0.112",
    });
    expect(out).toEqual({
      reason: "none-ran",
      plugins: [{ id: "ytdlp", name: "ytdlp", description: "ytdlp desc", action: "install", experimental: false }],
    });
  });

  it("puts switched-off installed fallbacks first, then gallery ones stable-before-experimental", () => {
    const out = suggestPlaybackFallbacks({
      failure: failure(),
      pluginStates: [installed("qbittorrent", false), installed("tidal", true), installed("lyrics", false, false)],
      gallery: [
        gallery("slskd", { stability: "experimental" }),
        gallery("ytdlp"),
        gallery("qbittorrent"), // installed — offered as "enable", not again as "install"
        gallery("tidal"), // installed and on — not offered
      ],
    });
    expect(out?.plugins.map((p) => [p.id, p.action, p.experimental])).toEqual([
      ["qbittorrent", "enable", false],
      ["ytdlp", "install", false],
      ["slskd", "install", true],
    ]);
  });

  it("leaves out gallery plugins that need a newer app", () => {
    const out = suggestPlaybackFallbacks({
      failure: failure(),
      pluginStates: [],
      gallery: [gallery("new", { minAppVersion: "1.0.120" }), gallery("ok", { minAppVersion: "1.0.99" })],
      appVersion: "1.0.112",
    });
    expect(out?.plugins.map((p) => p.id)).toEqual(["ok"]);
    // Unknown app version: don't filter on a guess.
    expect(
      suggestPlaybackFallbacks({ failure: failure(), pluginStates: [], gallery: [gallery("new", { minAppVersion: "9.0.0" })], appVersion: "" })
        ?.plugins.map((p) => p.id),
    ).toEqual(["new"]);
  });

  it("says 'none had it' when a plugin fallback was asked and missed", () => {
    const out = suggestPlaybackFallbacks({
      failure: failure({ attempts: [
        { name: "Library", outcome: "miss" },
        { name: "yt-dlp", outcome: "timeout", fallback: true },
      ] }),
      pluginStates: [installed("ytdlp", true)],
      gallery: [gallery("slskd")],
    });
    expect(out?.reason).toBe("all-missed");
  });

  it("the track's own source failing is not a fallback having been asked", () => {
    const out = suggestPlaybackFallbacks({
      failure: failure({ attempts: [
        { name: "Spotify", outcome: "error" },
        { name: "Library", outcome: "miss" },
      ] }),
      pluginStates: [],
      gallery: [gallery("ytdlp")],
    });
    expect(out?.reason).toBe("none-ran");
  });

  it("says nothing for a failure a fallback can't fix, or when there is nothing to offer", () => {
    for (const stage of ["engine", "playback"] as const) {
      expect(suggestPlaybackFallbacks({ failure: failure({ stage }), pluginStates: [], gallery: [gallery("ytdlp")] })).toBeNull();
    }
    expect(suggestPlaybackFallbacks({ failure: failure(), pluginStates: [installed("ytdlp", true)], gallery: [gallery("ytdlp")] })).toBeNull();
    expect(suggestPlaybackFallbacks({ failure: failure(), pluginStates: [], gallery: [gallery("x", { provides: undefined })] })).toBeNull();
  });
});
