import { describe, it, expect, vi } from "vitest";
import type { DownloadProvider } from "../types/plugin";
import { resolveTrackDownload } from "../hooks/useDownloadOrchestration";

// A track enqueued by a plugin via api.downloads.enqueue carries the plugin's
// BARE provider id (e.g. "youtube-download") — all it knows of itself — while
// the host assembles provider ids as "${pluginId}:${providerId}"
// ("youtube:youtube-download"). resolveTrackDownload must match either form,
// without false-matching a same-named provider under a different plugin.

function makeProvider(over: Partial<DownloadProvider> & { id: string; source: string }): DownloadProvider {
  return {
    name: over.id,
    resolveByUri: vi.fn(async () => null),
    resolveByMetadata: vi.fn(async () => null),
    ...over,
  };
}

const HIT = { url: "file:///cache/x.m4a", headers: null, metadata: null };

describe("resolveTrackDownload provider matching", () => {
  it("matches the bare provider id a plugin passes to enqueue", async () => {
    const yt = makeProvider({
      id: "youtube:youtube-download",
      source: "youtube",
      resolveByUri: vi.fn(async () => HIT),
    });
    const result = await resolveTrackDownload(
      [yt], "youtube://abcdefghijk", "Song", "Artist", null, null, "aac", "youtube-download",
    );
    expect(result).toEqual(HIT);
    expect(yt.resolveByUri).toHaveBeenCalledWith("youtube://abcdefghijk", "aac");
  });

  it("still matches the fully-qualified provider id", async () => {
    const yt = makeProvider({
      id: "youtube:youtube-download",
      source: "youtube",
      resolveByUri: vi.fn(async () => HIT),
    });
    const result = await resolveTrackDownload(
      [yt], "youtube://abcdefghijk", "Song", "Artist", null, null, "aac", "youtube:youtube-download",
    );
    expect(result).toEqual(HIT);
  });

  it("does not match a provider with a different provider-id", async () => {
    // A bare id reconstructs against each provider's source, so it matches only
    // providers whose provider-id portion equals it — not an unrelated provider.
    const spotify = makeProvider({
      id: "spotify:spotify-download",
      source: "spotify",
      resolveByUri: vi.fn(async () => HIT),
    });
    const result = await resolveTrackDownload(
      [spotify], "youtube://abcdefghijk", "Song", "Artist", null, null, "aac", "youtube-download",
    );
    expect(spotify.resolveByUri).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("with no provider specified, walks all providers", async () => {
    const a = makeProvider({ id: "p1:a", source: "p1" });
    const b = makeProvider({ id: "p2:b", source: "p2", resolveByMetadata: vi.fn(async () => HIT) });
    const result = await resolveTrackDownload(
      [a, b], null, "Song", "Artist", null, null, "aac", null,
    );
    expect(result).toEqual(HIT);
  });
});
