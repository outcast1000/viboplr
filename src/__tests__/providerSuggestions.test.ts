// "These plugins could find it" after an image or info lookup came back empty.
// Pinned: the finer gallery ids decide who is offered (artist vs album images,
// lyrics vs bios), switched-off installed plugins come before gallery ones,
// and nothing installed-and-on is offered again.
import { describe, it, expect } from "vitest";
import { suggestImageProviders, suggestInfoProviders } from "../utils/providerSuggestions";
import type { GalleryPluginEntry, PluginManifestContributes, PluginState } from "../types/plugin";

const installed = (id: string, enabled: boolean, contributes: PluginManifestContributes) =>
  ({
    id, enabled, status: enabled ? "active" : "disabled",
    manifest: { id, name: id, version: "1.0.0", author: "x", description: "", contributes },
  }) as unknown as Pick<PluginState, "id" | "enabled" | "status" | "manifest">;

const gallery = (id: string, provides: string[], over: Partial<GalleryPluginEntry> = {}): GalleryPluginEntry => ({
  id, name: id, author: "x", description: `${id} desc`, provides, ...over,
});

const GALLERY = [
  gallery("duckduckgo", ["web-search", "images", "images:artist", "images:album"], { stability: "experimental" }),
  gallery("google", ["images", "images:artist", "images:album", "images:tag", "info:lyrics"]),
  gallery("genius", ["info:artist_bio", "info:lyrics"]),
  gallery("old-gallery-entry", ["images"]), // provides from before the finer ids: not offered
];

describe("suggestImageProviders", () => {
  it("offers the gallery plugins with images for that entity, stable first", () => {
    const out = suggestImageProviders({ entity: "artist", pluginStates: [], gallery: GALLERY });
    expect(out.map((p) => [p.id, p.action, p.experimental])).toEqual([
      ["google", "install", false],
      ["duckduckgo", "install", true],
    ]);
  });

  it("tag images come only from a plugin that declares them", () => {
    expect(suggestImageProviders({ entity: "tag", pluginStates: [], gallery: GALLERY }).map((p) => p.id)).toEqual(["google"]);
  });

  it("an installed plugin is offered only when it's switched off, and only for its own entities", () => {
    const states = [
      installed("artwork", false, { imageProviders: [{ entity: "album" }] }),
      installed("google", true, { imageProviders: [{ entity: "artist" }] }),
    ];
    expect(suggestImageProviders({ entity: "album", pluginStates: states, gallery: GALLERY }).map((p) => [p.id, p.action]))
      .toEqual([["artwork", "enable"], ["duckduckgo", "install"]]);
    expect(suggestImageProviders({ entity: "artist", pluginStates: states, gallery: GALLERY }).map((p) => p.id))
      .toEqual(["duckduckgo"]);
  });
});

describe("a plugin that can't be switched on", () => {
  it("is not offered when it is in error, and isn't sent to the gallery either", () => {
    const broken = {
      ...installed("google", false, { imageProviders: [{ entity: "artist" }] }),
      status: "error" as const,
    };
    expect(suggestImageProviders({ entity: "artist", pluginStates: [broken], gallery: GALLERY }).map((p) => p.id))
      .toEqual(["duckduckgo"]);
  });
});

describe("suggestInfoProviders", () => {
  it("matches the information type exactly", () => {
    expect(suggestInfoProviders({ typeId: "lyrics", pluginStates: [], gallery: GALLERY }).map((p) => p.id))
      .toEqual(["google", "genius"]);
    expect(suggestInfoProviders({ typeId: "artist_bio", pluginStates: [], gallery: GALLERY }).map((p) => p.id))
      .toEqual(["genius"]);
    expect(suggestInfoProviders({ typeId: "similar_artists", pluginStates: [], gallery: GALLERY })).toEqual([]);
  });

  it("offers a switched-off installed plugin that declares the type", () => {
    const states = [installed("lastfm", false, { informationTypes: [{ id: "artist_bio" } as never] })];
    expect(suggestInfoProviders({ typeId: "artist_bio", pluginStates: states, gallery: GALLERY }).map((p) => [p.id, p.action]))
      .toEqual([["lastfm", "enable"], ["genius", "install"]]);
  });
});

describe("minAppVersion", () => {
  // Same comparison plugin activation uses (utils/semver.ts): a "v" prefix and
  // a pre-release suffix don't change what an app can run.
  const entry = (min: string) => [gallery("google", ["images:artist"], { minAppVersion: min })];
  const offered = (app: string, min: string) =>
    suggestImageProviders({ entity: "artist", pluginStates: [], gallery: entry(min), appVersion: app }).length > 0;

  it("hides an entry that needs a newer app, prefix or not", () => {
    expect(offered("1.0.111", "1.0.112")).toBe(false);
    expect(offered("1.0.111", "v1.0.112")).toBe(false);
  });

  it("offers an entry whose minimum is a pre-release of this version", () => {
    expect(offered("1.0.111", "1.0.111-beta.1")).toBe(true);
    expect(offered("1.0.112", "1.0.111")).toBe(true);
  });
});
