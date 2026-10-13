import { describe, expect, it } from "vitest";
import { handlerKey, matchesProviderRef, parseProviderKey, providerKey, providerNames } from "../utils/providerKey";
import { migrateMergedPlugins, providerRowsFor } from "../utils/mergedPlugins";

describe("provider keys", () => {
  it("a plugin with one provider keeps its bare id", () => {
    expect(providerKey("lastfm")).toBe("lastfm");
    expect(providerKey("lastfm", null)).toBe("lastfm");
    expect(parseProviderKey("lastfm")).toEqual({ pluginId: "lastfm", provider: null });
  });

  it("a declared provider is keyed under its plugin and parses back", () => {
    expect(providerKey("artwork", "deezer")).toBe("artwork/deezer");
    expect(parseProviderKey("artwork/deezer")).toEqual({ pluginId: "artwork", provider: "deezer" });
  });

  it("core rows are not mistaken for a plugin's provider", () => {
    expect(parseProviderKey("core:local-lyrics")).toEqual({ pluginId: "core:local-lyrics", provider: null });
  });

  it("handler keys keep two providers of one entity apart", () => {
    expect(handlerKey("album", "deezer")).not.toBe(handlerKey("album", "itunes"));
    expect(handlerKey("album")).toBe("album");
  });

  it("a pin may name the key, the plugin, or the old bare provider id", () => {
    expect(matchesProviderRef("artwork/deezer", "artwork/deezer")).toBe(true);
    expect(matchesProviderRef("artwork/deezer", "artwork")).toBe(true);
    expect(matchesProviderRef("artwork/deezer", "deezer")).toBe(true);
    expect(matchesProviderRef("artwork/deezer", "itunes")).toBe(false);
    expect(matchesProviderRef("lastfm", "lastfm")).toBe(true);
    expect(matchesProviderRef("lastfm", "genius")).toBe(false);
  });

  it("names a provider row by its provider, and a plugin by the plugin", () => {
    const names = providerNames([
      {
        id: "artwork",
        manifest: { name: "Artwork", contributes: { providers: [{ id: "deezer", name: "Deezer" }] } },
      },
      { id: "lastfm", manifest: { name: "Last.fm" } },
    ]);
    expect(names.get("artwork/deezer")).toBe("Deezer");
    expect(names.get("artwork")).toBe("Artwork");
    expect(names.get("lastfm")).toBe("Last.fm");
  });
});

describe("merged bundled plugins", () => {
  it("everything on: the merged plugins replace the old ids, no source switched off", () => {
    const out = migrateMergedPlugins(["lastfm", "audiodb", "deezer", "itunes", "musicbrainz", "lrclib", "lyrics-ovh"]);
    expect(out.enabled.sort()).toEqual(["artwork", "lastfm", "lyrics"]);
    expect(out.disabledProviders).toEqual([]);
  });

  it("a source whose plugin was off stays off, as a switched-off provider", () => {
    const out = migrateMergedPlugins(["deezer", "itunes", "lrclib"]);
    expect(out.enabled.sort()).toEqual(["artwork", "lyrics"]);
    expect(out.disabledProviders.sort()).toEqual(["artwork/audiodb", "artwork/musicbrainz", "lyrics/lyrics-ovh"]);
  });

  it("a group turned off entirely stays off", () => {
    const out = migrateMergedPlugins(["lastfm", "lrclib"]);
    expect(out.enabled.sort()).toEqual(["lastfm", "lyrics"]);
    expect(out.disabledProviders).toEqual(["lyrics/lyrics-ovh"]);
  });

  it("finds the rows behind a provider key in the merged manifest", () => {
    const rows = providerRowsFor(
      "artwork",
      {
        contributes: {
          imageProviders: [
            { entity: "artist", provider: "deezer" },
            { entity: "album", provider: "deezer" },
            { entity: "album", provider: "itunes" },
          ],
        },
      },
      ["artwork/deezer"],
    );
    expect(rows.images).toEqual([["artwork/deezer", "artist"], ["artwork/deezer", "album"]]);
    expect(rows.info).toEqual([]);
  });
});
