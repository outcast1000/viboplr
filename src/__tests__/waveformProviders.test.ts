import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

import { analyzeWaveform, shapePeaks, WAVEFORM_PROVIDERS } from "../waveform/providers";
import { ffmpegWaveformProvider } from "../waveform/ffmpegProvider";
import type { WaveformAttempt, WaveformProvider, WaveformRequest } from "../waveform/types";

function request(signal = new AbortController().signal): WaveformRequest {
  return { path: "file:///music/song.flac", title: "Song", assetUrl: "asset://song.flac", signal };
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
