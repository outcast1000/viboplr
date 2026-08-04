import { describe, it, expect } from "vitest";
import type { PluginSearchProvider, PluginTrack } from "../types/plugin";
import {
  buildPluginSearchSections,
  providerKeyOf,
  type ProviderRunState,
} from "../utils/centralSearchPlugins";

const provider = (over: Partial<PluginSearchProvider> = {}): PluginSearchProvider => ({
  pluginId: "ytdlp",
  providerId: "ytdlp-search",
  name: "yt-dlp",
  ...over,
});

const spotify = provider({ pluginId: "spotify-browse", providerId: "search", name: "Spotify" });

const trk = (title: string): PluginTrack => ({ title, artist_name: "A" });

describe("providerKeyOf", () => {
  it("keys on plugin + provider so two plugins can share a provider id", () => {
    expect(providerKeyOf(provider())).toBe("ytdlp:ytdlp-search");
    expect(providerKeyOf(spotify)).toBe("spotify-browse:search");
  });
});

describe("buildPluginSearchSections", () => {
  it("offers an unqueried provider exactly one selectable row", () => {
    // The host never queries a plugin catalog on its own, so the default state
    // is an offer, not results.
    const { sections, selectable } = buildPluginSearchSections([provider()], {}, 0);
    expect(sections).toHaveLength(1);
    expect(sections[0].rows.map((r) => r.kind)).toEqual(["run"]);
    expect(selectable).toEqual([
      { kind: "plugin-run", providerKey: "ytdlp:ytdlp-search", name: "yt-dlp" },
    ]);
  });

  it("numbers selectable rows from baseIndex, continuing the library items", () => {
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "done", tracks: [trk("One"), trk("Two")] },
    };
    const { sections, selectable } = buildPluginSearchSections([provider()], states, 5);
    expect(sections[0].rows.map((r) => r.itemIndex)).toEqual([5, 6]);
    // Every itemIndex must address its own entry in the appended item list.
    for (const row of sections[0].rows) {
      expect(selectable[row.itemIndex! - 5]).toMatchObject({ kind: "plugin-track" });
    }
  });

  it("keeps indices contiguous across providers in mixed states", () => {
    // A loading provider contributes a row but no item — the next provider's
    // indices must not skip a slot, or the arrow keys land on the wrong row.
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "loading" },
      "spotify-browse:search": { status: "done", tracks: [trk("One")] },
    };
    const { sections, selectable } = buildPluginSearchSections(
      [provider(), spotify],
      states,
      3,
    );
    expect(sections[0].rows.map((r) => r.itemIndex)).toEqual([null]);
    expect(sections[1].rows.map((r) => r.itemIndex)).toEqual([3]);
    expect(selectable).toHaveLength(1);
  });

  it("assigns every selectable row an index matching its position in the item list", () => {
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "done", tracks: [trk("One"), trk("Two")] },
      "spotify-browse:search": { status: "idle" },
    };
    const { sections, selectable } = buildPluginSearchSections(
      [provider(), spotify],
      states,
      0,
    );
    const indices = sections.flatMap((s) => s.rows).map((r) => r.itemIndex).filter((i) => i !== null);
    expect(indices).toEqual(selectable.map((_, i) => i));
  });

  it("makes loading, empty and error rows unselectable", () => {
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "error", message: "yt-dlp is not installed" },
    };
    const { sections, selectable } = buildPluginSearchSections([provider()], states, 0);
    expect(sections[0].rows[0]).toMatchObject({
      kind: "error",
      message: "yt-dlp is not installed",
      itemIndex: null,
    });
    expect(selectable).toHaveLength(0);
  });

  it("reports a provider that answered ok with nothing as empty", () => {
    // Guards against a section that renders a header and no explanation.
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "done", tracks: [] },
    };
    const { sections, selectable } = buildPluginSearchSections([provider()], states, 0);
    expect(sections[0].rows.map((r) => r.kind)).toEqual(["empty"]);
    expect(selectable).toHaveLength(0);
  });

  it("gives every row a distinct key", () => {
    const states: Record<string, ProviderRunState> = {
      "ytdlp:ytdlp-search": { status: "done", tracks: [trk("Dup"), trk("Dup")] },
      "spotify-browse:search": { status: "idle" },
    };
    const { sections } = buildPluginSearchSections([provider(), spotify], states, 0);
    const keys = sections.flatMap((s) => s.rows).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("returns nothing when no providers are registered", () => {
    expect(buildPluginSearchSections([], {}, 0)).toEqual({ sections: [], selectable: [] });
  });
});
