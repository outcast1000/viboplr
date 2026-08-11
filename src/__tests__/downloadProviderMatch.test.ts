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
    // The third argument is the liveness callback — a provider that reports
    // progress through it holds the idle timeout open (see the budget tests).
    expect(yt.resolveByUri).toHaveBeenCalledWith("youtube://abcdefghijk", "aac", expect.any(Function));
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

// The per-provider budget is an IDLE timeout, not a deadline. A provider that
// downloads the file inside its resolve (yt-dlp) runs for minutes; under the old
// fixed race it was cut off and reported as "no provider could resolve this
// track" — the batch counterpart of the modal hanging on "Preparing download".
describe("resolveTrackDownload provider budget", () => {
  it("keeps waiting past the budget while the provider reports progress", async () => {
    vi.useFakeTimers();
    try {
      const slow = makeProvider({
        id: "yt:dl",
        source: "yt",
        // Reports every 30s and answers at 150s — well past the 60s budget, but
        // never silent for it.
        resolveByUri: vi.fn(async (_uri, _fmt, onProgress) => {
          for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(30000);
            onProgress?.({ percent: i * 20 });
          }
          return HIT;
        }),
      });
      const pending = resolveTrackDownload([slow], "yt://x", "Song", null, null, null, "video", null);
      await expect(pending).resolves.toEqual(HIT);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a provider that goes silent for the whole budget", async () => {
    vi.useFakeTimers();
    try {
      const wedged = makeProvider({
        id: "yt:dl",
        source: "yt",
        resolveByUri: vi.fn(() => new Promise(() => {})), // never settles, never reports
      });
      const pending = resolveTrackDownload([wedged], "yt://x", "Song", null, null, null, "video", null);
      await vi.advanceTimersByTimeAsync(61000);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
