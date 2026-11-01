import { describe, it, expect, vi } from "vitest";
import { pluginDownloadModal } from "../utils/downloadModalState";
import type { DownloadProvider } from "../types/plugin";

/**
 * A plugin's `download-tracks` / `download-album` request becomes modal state
 * here. Every track is fetched by its own uri through the provider's by-URI
 * resolver — the batch used to go through the interactive-resolve handler,
 * which Soulseek and rqbit don't register, so their batches failed.
 */
function makeProvider(): DownloadProvider & { resolveByUri: ReturnType<typeof vi.fn>; resolveMatch: ReturnType<typeof vi.fn> } {
  return {
    id: "slskd:slskd",
    name: "Soulseek",
    source: "slskd",
    resolveByUri: vi.fn(async (uri: string) => ({ url: `file:///dl/${uri}`, headers: null, metadata: null })),
    resolveByMetadata: vi.fn(async () => null),
    resolveMatch: vi.fn(),
  } as never;
}

describe("pluginDownloadModal", () => {
  it("refuses a provider that isn't active", () => {
    expect(pluginDownloadModal(undefined, { providerId: "gone:x", providerName: "Gone", tracks: [{ title: "a", uri: "x://1" }] }))
      .toEqual({ error: "Gone isn't an active download provider." });
  });

  it("refuses a request with no track it can fetch", () => {
    expect(pluginDownloadModal(makeProvider(), { providerId: "slskd:slskd", tracks: [{ title: "a" }, { title: "b", uri: null }] }))
      .toEqual({ error: "Soulseek named no track to download." });
  });

  it("one track opens the single flow with a plan bound to its uri", async () => {
    const p = makeProvider();
    const state = pluginDownloadModal(p, { providerId: "slskd:slskd", providerName: "Soulseek (local)", tracks: [{ title: "Teardrop", artist_name: "Massive Attack", uri: "slskd://1" }] });
    if ("error" in state || state.kind !== "single") throw new Error("expected a single-track modal");
    expect(state.plan.providerName).toBe("Soulseek (local)");
    expect(state.track).toMatchObject({ title: "Teardrop", artistName: "Massive Attack", uri: "slskd://1", isVideo: false });
    await state.plan.resolve("original");
    expect(p.resolveByUri).toHaveBeenCalledWith("slskd://1", "original", undefined);
  });

  it("a replaced library row stands in as the track, while the plan still fetches the plugin's uri", async () => {
    const p = makeProvider();
    const state = pluginDownloadModal(p, {
      providerId: "slskd:slskd",
      tracks: [{ title: "Teardrop", uri: "slskd://1" }],
      upgradeOf: { id: 7, path: "file:///music/teardrop.mp3" },
    });
    if ("error" in state || state.kind !== "single") throw new Error("expected a single-track modal");
    expect(state.track).toMatchObject({ uri: "file:///music/teardrop.mp3", trackId: 7 });
    await state.plan.resolve("original");
    expect(p.resolveByUri).toHaveBeenCalledWith("slskd://1", "original", undefined);
  });

  it("several tracks open the batch, each resolved by its own uri — never the interactive resolve", async () => {
    const p = makeProvider();
    const state = pluginDownloadModal(p, {
      providerId: "slskd:slskd",
      tracks: [{ title: "a", uri: "slskd://1" }, { title: "no source" }, { title: "b", uri: "slskd://2" }],
      albumTitle: "Mezzanine",
      purpose: "import",
    });
    if ("error" in state || state.kind !== "batch") throw new Error("expected a batch modal");
    expect(state.items.map((i) => i.track.title)).toEqual(["a", "b"]);
    expect(state.items.every((i) => i.track.albumTitle === "Mezzanine")).toBe(true);
    expect(state.purpose).toBe("import");
    await state.items[1].resolve("flac");
    expect(p.resolveByUri).toHaveBeenCalledWith("slskd://2", "flac", undefined);
    expect(p.resolveMatch).not.toHaveBeenCalled();
  });
});
