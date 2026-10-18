import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
const engineMock = vi.hoisted(() => ({ getMediaInfo: vi.fn() }));
vi.mock("../playback/nativeEngine", () => ({ nativeEngine: engineMock }));

import { analyzeWaveform, shapePeaks, WAVEFORM_PROVIDERS, waveformProviders } from "../waveform/providers";
import { ffmpegWaveformProvider } from "../waveform/ffmpegProvider";
import { fillCaptureGaps, isCaptureComplete } from "../waveform/engineCapture";
import { PLUGIN_WAVEFORM_TIMEOUT_MS, pluginWaveformProvider, sanitizePluginRms, type WaveformPluginBridge } from "../waveform/pluginProvider";
import { buildTrackAudioFacts, ENGINE_FACTS_WAIT_MS, resolveTrackAudioFacts } from "../hooks/useNowPlayingInfo";
import type { TrackAudioFacts, WaveformAttempt, WaveformProvider, WaveformRequest } from "../waveform/types";
import type { EngineMediaInfo } from "../playback/nativeEngine";

const FACTS: TrackAudioFacts = {
  title: "Song", artistName: "Artist", albumName: null, albumArtistName: null, durationSecs: 241,
  codec: "flac", sampleRate: 44100, bitDepth: 16, channels: 2, bitrateKbps: 900,
};

function request(signal = new AbortController().signal): WaveformRequest {
  return { path: "file:///music/song.flac", title: "Song", assetUrl: "asset://song.flac", signal, facts: async () => FACTS };
}

function provider(id: string, answer: WaveformAttempt | Error): WaveformProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    async analyze() {
      p.calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return p;
}

beforeEach(() => {
  invokeMock.mockReset();
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("WAVEFORM_PROVIDERS", () => {
  it("tries ffmpeg first and falls back to the browser", () => {
    expect(WAVEFORM_PROVIDERS.map((p) => p.id)).toEqual(["ffmpeg", "browser"]);
  });
});

describe("analyzeWaveform", () => {
  it("returns the first provider's RMS and never asks the fallback", async () => {
    const first = provider("a", { status: "ok", rms: [0.1, 0.2] });
    const second = provider("b", { status: "ok", rms: [9] });
    expect(await analyzeWaveform([first, second], request())).toEqual({ providerId: "a", rms: [0.1, 0.2] });
    expect(second.calls).toBe(0);
  });

  it("moves on when a provider skips", async () => {
    const first = provider("a", { status: "skipped", reason: "no ffmpeg" });
    const second = provider("b", { status: "ok", rms: [0.5] });
    expect(await analyzeWaveform([first, second], request())).toEqual({ providerId: "b", rms: [0.5] });
  });

  it("moves on when a provider throws, and logs it", async () => {
    const first = provider("a", new Error("decode failed"));
    const second = provider("b", { status: "ok", rms: [0.5] });
    expect(await analyzeWaveform([first, second], request())).toEqual({ providerId: "b", rms: [0.5] });
    expect(console.error).toHaveBeenCalled();
  });

  it("stops the chain on cancel", async () => {
    const first = provider("a", { status: "cancelled" });
    const second = provider("b", { status: "ok", rms: [0.5] });
    expect(await analyzeWaveform([first, second], request())).toBeNull();
    expect(second.calls).toBe(0);
  });

  it("asks nobody once the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const first = provider("a", { status: "ok", rms: [0.5] });
    expect(await analyzeWaveform([first], request(controller.signal))).toBeNull();
    expect(first.calls).toBe(0);
  });

  it("resolves null when every provider skips", async () => {
    const first = provider("a", { status: "skipped", reason: "x" });
    expect(await analyzeWaveform([first], request())).toBeNull();
  });
});

describe("shapePeaks", () => {
  it("normalizes to the loudest bucket and applies the curve with a floor", () => {
    const shaped = shapePeaks([0, 0.25, 0.5]);
    expect(shaped[0]).toBeCloseTo(0.03);
    expect(shaped[2]).toBeCloseTo(1);
    expect(shaped[1]).toBeCloseTo(0.03 + 0.97 * Math.pow(0.5, 1.8));
  });

  it("gives silence the floor instead of dividing by zero", () => {
    expect(shapePeaks([0, 0])).toEqual([0.03, 0.03]);
  });

  it("is scale-invariant, so providers with different absolute levels look the same", () => {
    const a = shapePeaks([0.1, 0.2, 0.4]);
    const b = shapePeaks([0.3, 0.6, 1.2]);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]));
  });

  it("keeps a building capture's unheard seconds unheard, scaled to the loudest heard", () => {
    const shaped = shapePeaks([0.25, null, 0.5, null]);
    expect(shaped[1]).toBeNull();
    expect(shaped[3]).toBeNull();
    expect(shaped[2]).toBeCloseTo(1);
    expect(shaped[0]).toBeCloseTo(0.03 + 0.97 * Math.pow(0.5, 1.8));
  });
});

describe("engine capture", () => {
  it("is complete at 99% heard, not before", () => {
    expect(isCaptureComplete({ rms: [0.1, 0.2], coverage: 0.99, durationSecs: 2 })).toBe(true);
    expect(isCaptureComplete({ rms: [0.1, 0.2], coverage: 0.989, durationSecs: 2 })).toBe(false);
    expect(isCaptureComplete({ rms: [null, null], coverage: 1, durationSecs: 2 })).toBe(false);
  });

  it("fills the few unheard seconds of a complete capture from their neighbours", () => {
    expect(fillCaptureGaps([0.2, null, null, 0.8])).toEqual([0.2, expect.closeTo(0.4), expect.closeTo(0.6), 0.8]);
    // Ends are held flat; a gap-free capture is unchanged.
    expect(fillCaptureGaps([null, 0.5, null])).toEqual([0.5, 0.5, 0.5]);
    expect(fillCaptureGaps([0.1, 0.2])).toEqual([0.1, 0.2]);
    expect(fillCaptureGaps([null, null])).toEqual([0, 0]);
  });
});

describe("ffmpegWaveformProvider", () => {
  it("maps the backend statuses onto attempts", async () => {
    invokeMock.mockResolvedValueOnce({ status: "ok", rms: [0.1] });
    expect(await ffmpegWaveformProvider.analyze(request())).toEqual({ status: "ok", rms: [0.1] });

    invokeMock.mockResolvedValueOnce({ status: "unavailable", rms: null });
    expect((await ffmpegWaveformProvider.analyze(request())).status).toBe("skipped");

    invokeMock.mockResolvedValueOnce({ status: "cancelled", rms: null });
    expect(await ffmpegWaveformProvider.analyze(request())).toEqual({ status: "cancelled" });
  });

  it("cancels the backend pass with the same request id when the signal aborts", async () => {
    const controller = new AbortController();
    let resolveAnalysis: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "analyze_waveform_ffmpeg") return new Promise((r) => { resolveAnalysis = r; });
      return Promise.resolve(null);
    });
    const pending = ffmpegWaveformProvider.analyze(request(controller.signal));
    controller.abort();
    resolveAnalysis({ status: "cancelled", rms: null });
    expect(await pending).toEqual({ status: "cancelled" });

    const analyzeCall = invokeMock.mock.calls.find((c) => c[0] === "analyze_waveform_ffmpeg");
    const cancelCall = invokeMock.mock.calls.find((c) => c[0] === "cancel_waveform_analysis");
    expect(cancelCall?.[1]).toEqual({ requestId: (analyzeCall?.[1] as { requestId: string }).requestId });
  });
});

function bridge(ids: string[], lookup: WaveformPluginBridge["lookup"] = async () => null): WaveformPluginBridge {
  return { lookupProviderIds: () => ids, lookup, share: vi.fn(), hasShareHandlers: () => false };
}

describe("sanitizePluginRms", () => {
  it("keeps an answer that fits the track, silencing junk values", () => {
    expect(sanitizePluginRms([0.5, NaN, -1, Infinity, 1], 5)).toEqual([0.5, 0, 0, 0, 1]);
  });

  it("refuses a waveform for a different length, or an absurd one", () => {
    expect(sanitizePluginRms(new Array(300).fill(0.5), 180)).toBeNull(); // a 5-minute take on a 3-minute track
    expect(sanitizePluginRms(new Array(183).fill(0.5), 180)).toEqual(new Array(183).fill(0.5)); // rounding slack
    expect(sanitizePluginRms(new Array(1_000_000).fill(0.5), 1_000_000)).toBeNull();
    expect(sanitizePluginRms("nope", 180)).toBeNull();
    expect(sanitizePluginRms([], 180)).toBeNull();
  });
});

describe("waveformProviders (the chain for one track)", () => {
  it("asks plugin lookups before computing a local file", () => {
    const ids = waveformProviders(bridge(["community"]), { canCompute: true }).map((p) => p.id);
    expect(ids).toEqual(["plugin:community", "ffmpeg", "browser"]);
  });

  it("gives a stream the lookups alone — nothing computes one", () => {
    const ids = waveformProviders(bridge(["community"]), { canCompute: false }).map((p) => p.id);
    expect(ids).toEqual(["plugin:community"]);
  });

  it("is the computing providers alone before plugins load", () => {
    expect(waveformProviders(null, { canCompute: true }).map((p) => p.id)).toEqual(["ffmpeg", "browser"]);
    expect(waveformProviders(null, { canCompute: false })).toEqual([]);
  });

  it("a lookup hit wins and the computing providers never run", async () => {
    const chain = waveformProviders(bridge(["community"], async () => [0.2, 1]), { canCompute: true });
    expect(await analyzeWaveform(chain, request())).toEqual({ providerId: "plugin:community", rms: [0.2, 1] });
    expect(invokeMock).not.toHaveBeenCalledWith("analyze_waveform_ffmpeg", expect.anything());
  });
});

describe("pluginWaveformProvider", () => {
  it("passes the track's facts to the plugin and returns its RMS", async () => {
    const lookup = vi.fn(async () => [0.5]);
    const p = pluginWaveformProvider("community", bridge([], lookup));
    expect(await p.analyze(request())).toEqual({ status: "ok", rms: [0.5] });
    expect(lookup).toHaveBeenCalledWith("community", FACTS);
  });

  it("skips on a miss or an empty answer", async () => {
    expect((await pluginWaveformProvider("c", bridge([], async () => null)).analyze(request())).status).toBe("skipped");
    expect((await pluginWaveformProvider("c", bridge([], async () => [])).analyze(request())).status).toBe("skipped");
  });

  it("skips without asking when there are no facts to match on", async () => {
    const lookup = vi.fn(async () => [0.5]);
    const p = pluginWaveformProvider("c", bridge([], lookup));
    expect((await p.analyze({ ...request(), facts: async () => null })).status).toBe("skipped");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("gives up on a slow plugin so the chain can compute it instead", async () => {
    vi.useFakeTimers();
    try {
      const p = pluginWaveformProvider("c", bridge([], () => new Promise(() => {})));
      const pending = p.analyze(request());
      await vi.advanceTimersByTimeAsync(PLUGIN_WAVEFORM_TIMEOUT_MS + 1);
      expect((await pending).status).toBe("skipped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers cancelled when the track changed meanwhile", async () => {
    const controller = new AbortController();
    const p = pluginWaveformProvider("c", bridge([], async () => { controller.abort(); return [0.5]; }));
    expect(await p.analyze(request(controller.signal))).toEqual({ status: "cancelled" });
  });
});

describe("buildTrackAudioFacts", () => {
  const track = {
    key: "q:1", path: "file:///m/a.flac", title: "Song", artist_name: "Artist", album_title: "Album",
    album_artist_name: null, duration_secs: 241, format: "FLAC", liked: 0,
  };
  const engine: EngineMediaInfo = {
    codec: "flac", sampleRate: 96000, format: "s32", bitrate: 2_800_000,
    videoCodec: null, width: null, height: null, videoBitrate: null, fps: null,
  };

  it("prefers the file's own tags and lowercases the codec", () => {
    const facts = buildTrackAudioFacts(track, 241, { sample_rate: 96000, bit_depth: 24, channels: 2, bitrate: 2800 }, engine);
    expect(facts).toEqual({
      title: "Song", artistName: "Artist", albumName: "Album", albumArtistName: null, durationSecs: 241,
      codec: "flac", sampleRate: 96000, bitDepth: 24, channels: 2, bitrateKbps: 2800,
    });
  });

  it("falls back to the engine for a stream, but never reads a depth off a wide decode format", () => {
    const stream = { ...track, path: "subsonic://c/1", format: null };
    const facts = buildTrackAudioFacts(stream, 241, null, engine);
    expect(facts.codec).toBe("flac");
    expect(facts.sampleRate).toBe(96000);
    expect(facts.bitDepth).toBeNull(); // s32 is what ffmpeg emits for a 24-bit FLAC
    expect(facts.bitrateKbps).toBe(2800);
    expect(buildTrackAudioFacts(stream, 241, null, { ...engine, format: "s16" }).bitDepth).toBe(16);
  });
});

describe("resolveTrackAudioFacts", () => {
  const stream = {
    key: "q:7", path: "subsonic://c/1", title: "Song", artist_name: "Artist", album_title: null,
    duration_secs: 200, format: null, liked: 0,
  };
  const engine: EngineMediaInfo = {
    codec: "opus", sampleRate: 48000, format: "floatp", bitrate: 160_000,
    videoCodec: null, width: null, height: null, videoBitrate: null, fps: null,
  };

  it("reads the engine only once it is decoding this track", async () => {
    engineMock.getMediaInfo.mockReset();
    engineMock.getMediaInfo.mockResolvedValue(engine);
    let onTrack = false;
    vi.useFakeTimers();
    try {
      const pending = resolveTrackAudioFacts(stream, 200, () => onTrack);
      await vi.advanceTimersByTimeAsync(400);
      expect(engineMock.getMediaInfo).not.toHaveBeenCalled(); // it would describe the previous track
      onTrack = true;
      await vi.advanceTimersByTimeAsync(400);
      expect((await pending).codec).toBe("opus");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the wait and sends no engine facts rather than wrong ones", async () => {
    engineMock.getMediaInfo.mockReset();
    vi.useFakeTimers();
    try {
      const pending = resolveTrackAudioFacts(stream, 200, () => false);
      await vi.advanceTimersByTimeAsync(ENGINE_FACTS_WAIT_MS + 500);
      const facts = await pending;
      expect(facts.codec).toBeNull();
      expect(facts.sampleRate).toBeNull();
      expect(engineMock.getMediaInfo).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
