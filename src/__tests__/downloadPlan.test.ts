import { describe, it, expect, vi } from "vitest";
import { decideDownload, BUILTIN_SUBSONIC_PROVIDER_ID } from "../utils/downloadPlan";
import type { DownloadProvider } from "../types/plugin";

const track = { title: "Song", artist_name: "Artist", album_title: "Album", duration_secs: 200 };

function makeProvider(over: Partial<DownloadProvider> & Pick<DownloadProvider, "id" | "source">): DownloadProvider {
  return {
    name: over.name ?? over.id,
    resolveByUri: over.resolveByUri ?? vi.fn(async () => null),
    resolveByMetadata: over.resolveByMetadata ?? vi.fn(async () => null),
    ...over,
  } as DownloadProvider;
}

const subsonic = makeProvider({ id: BUILTIN_SUBSONIC_PROVIDER_ID, name: "Subsonic", source: "__builtin" });
const youtube = makeProvider({ id: "youtube:youtube-fallback", name: "YouTube", source: "youtube" });
const tidal = makeProvider({ id: "tidal-browse:tidal-dl", name: "TIDAL", source: "tidal-browse" });
const ALL = [subsonic, youtube, tidal];

describe("decideDownload", () => {
  it("returns null for local (button hidden)", () => {
    expect(decideDownload({ kind: "local" }, track, ALL)).toBeNull();
  });

  it("returns null for a raw direct-url (no owning downloader)", () => {
    expect(decideDownload({ kind: "direct-url", uri: "https://x/a.mp3" }, track, ALL)).toBeNull();
  });

  it("maps subsonic to the built-in Subsonic provider, by uri", () => {
    const plan = decideDownload({ kind: "subsonic", uri: "subsonic://1/9" }, track, ALL);
    expect(plan).toMatchObject({ providerId: BUILTIN_SUBSONIC_PROVIDER_ID, providerName: "Subsonic", uri: "subsonic://1/9" });
    expect(plan!.resolveByUri).toBe(subsonic.resolveByUri);
  });

  it("returns null for subsonic when the built-in provider is absent", () => {
    expect(decideDownload({ kind: "subsonic", uri: "subsonic://1/9" }, track, [youtube, tidal])).toBeNull();
  });

  it("maps a native plugin scheme to its plugin's provider, by uri", () => {
    const plan = decideDownload({ kind: "plugin", pluginId: "tidal-browse", uri: "tidal://5" }, track, ALL);
    expect(plan).toMatchObject({ providerId: "tidal-browse:tidal-dl", providerName: "TIDAL", uri: "tidal://5" });
    expect(plan!.resolveByUri).toBe(tidal.resolveByUri);
  });

  it("maps a stream-resolver win (no uri) to the plugin's provider, resolving by metadata", async () => {
    const plan = decideDownload({ kind: "plugin", pluginId: "youtube" }, track, ALL);
    expect(plan).toMatchObject({ providerId: "youtube:youtube-fallback", providerName: "YouTube", uri: null });
    // resolveByUri is a metadata closure — it should not be the provider's own resolveByUri.
    expect(plan!.resolveByUri).not.toBe(youtube.resolveByUri);
    await plan!.resolveByUri("ignored", "flac");
    expect(youtube.resolveByMetadata).toHaveBeenCalledWith("Song", "Artist", "Album", 200, "flac");
  });

  it("returns null for a plugin source whose plugin contributes no downloader (hide)", () => {
    expect(decideDownload({ kind: "plugin", pluginId: "spotify" }, track, ALL)).toBeNull();
  });

  it("returns null for null/undefined source", () => {
    expect(decideDownload(null, track, ALL)).toBeNull();
    expect(decideDownload(undefined, track, ALL)).toBeNull();
  });
});
