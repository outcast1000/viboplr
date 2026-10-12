import { useState, useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { analyzeWaveform, shapePeaks, waveformProviders } from "../waveform/providers";
import { isPluginWaveformProvider, type WaveformPluginBridge } from "../waveform/pluginProvider";
import type { TrackAudioFacts } from "../waveform/types";
import { resolveTrackAudioFacts } from "./useNowPlayingInfo";
import { useLatestRef } from "./useLatestRef";

// Peaks are stored at a fixed one-bucket-per-second source resolution (width-
// independent), and WaveformSeekBar downsamples them to fit its render width —
// so one cached array serves both the now-playing bar and the fullscreen bar.
//
// On a cache miss the analysis runs through the provider chain in
// src/waveform/providers.ts: plugin lookups first (a waveform another listener
// already computed — e.g. Viboplr Community), then, for a local file only, ffmpeg
// and Web Audio. Each provider returns per-second RMS and `shapePeaks` turns it
// into bar heights. A local cache hit asks nobody anything.

interface WaveformCache {
  name: string;
  duration: number;
  peaks: number[];
}

/**
 * Cache key for a track's peaks. Exported because `VisualizerSlot` reads the same
 * cache to texture a visualizer's grooves — duplicating this format there would
 * silently miss every entry the moment either copy changed.
 */
export function waveformKey(artistName: string | null, title: string, durationSecs: number | null): string {
  const artist = (artistName ?? "unknown").toLowerCase().trim();
  const t = title.toLowerCase().trim();
  const d = Math.round(durationSecs ?? 0);
  return `v3::${artist}::${t}::${d}`;
}

export interface WaveformCandidate {
  path: string | null;
  title: string | null;
  isVideo: boolean;
  /** Known length, from the track or the player. Needed to match a shared waveform. */
  durationSecs?: number | null;
}

/**
 * Whether the app may *compute* a waveform for a track, judged from metadata alone
 * (no I/O). Each computing provider then applies its own limits (the Web Audio one
 * also caps file size). Video is excluded because it gets the filmstrip seek bar,
 * and decoding a whole container in the webview costs orders of magnitude more than
 * an audio file. Remote streams (subsonic / plugin schemes / direct http) are
 * excluded by design — analyzing one would mean downloading it a second time (the
 * Web Audio `fetch` is CORS-blocked for them anyway).
 */
export function isWaveformComputable(
  candidate: WaveformCandidate,
): candidate is WaveformCandidate & { path: string; title: string } {
  if (!candidate.path || !candidate.title) return false;
  if (candidate.isVideo) return false;
  return candidate.path.startsWith("file://");
}

/**
 * Whether a track can *show* a waveform at all: any computable one, plus any other
 * audio track with a known length — a stream can't be analyzed, but a waveform
 * someone else shared (or one already cached) still fits it, matched by
 * artist + title + duration.
 */
export function isWaveformShowable(
  candidate: WaveformCandidate,
): candidate is WaveformCandidate & { path: string; title: string } {
  if (isWaveformComputable(candidate)) return true;
  if (!candidate.path || !candidate.title || candidate.isVideo) return false;
  return (candidate.durationSecs ?? 0) > 0;
}

export function useWaveform(
  track: QueueTrack | null,
  {
    durationSecs,
    isVideo,
    assetUrl,
    plugins,
  }: {
    /** The track's length, falling back to the player's once it knows it. */
    durationSecs: number | null;
    isVideo: boolean;
    assetUrl: string | null;
    /** Plugin lookup/share bridge, read at call time; null before plugins load. */
    plugins: RefObject<WaveformPluginBridge | null>;
  },
): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The effect keys on the identity fields below; the rest (album, format…) is read
  // from here when the facts are built, so a like toggle doesn't re-run it.
  const trackRef = useLatestRef(track);
  const trackPath = track?.path ?? null;
  const trackName = track?.title ?? null;
  const trackArtist = track?.artist_name ?? null;

  useEffect(() => {
    setPeaks(null);

    const candidate = { path: trackPath, title: trackName, isVideo, durationSecs };
    if (!isWaveformShowable(candidate)) return;
    const { path, title } = candidate;
    const canCompute = isWaveformComputable(candidate);

    const cacheKey = waveformKey(trackArtist, title, durationSecs);
    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Built once, on first ask, and only when a plugin provider or a share needs them.
    let factsPromise: Promise<TrackAudioFacts | null> | null = null;
    const facts = (fallbackDuration?: number): Promise<TrackAudioFacts | null> => {
      factsPromise ??= (async () => {
        const current = trackRef.current;
        const duration = durationSecs ?? fallbackDuration ?? 0;
        if (!current || duration <= 0) return null;
        try {
          return await resolveTrackAudioFacts(current, duration);
        } catch (e) {
          console.error("Failed to resolve audio facts for the waveform:", e);
          return null;
        }
      })();
      return factsPromise;
    };

    (async () => {
      try {
        const cached = await invoke<WaveformCache | null>("get_cached_waveform", { key: cacheKey });
        if (cancelled) return;
        if (cached && cached.peaks && cached.peaks.length > 0) {
          console.debug(`[waveform] loaded cached: "${cached.name}" (${cached.duration}s, ${cached.peaks.length} buckets)`);
          setPeaks(cached.peaks);
          return;
        }
      } catch (e) {
        // A miss is `null`, not a throw; still worth analyzing after a read error.
        console.error("Failed to read cached waveform:", e);
      }

      const bridge = plugins.current;
      const result = await analyzeWaveform(waveformProviders(bridge, { canCompute }), {
        path,
        title,
        assetUrl,
        signal: controller.signal,
        facts: () => facts(),
      });
      if (cancelled || !result) return;

      const peaks = shapePeaks(result.rms);
      const duration = durationSecs || peaks.length;
      console.debug(`[waveform] created new via ${result.providerId}: "${title}" (${duration}s, ${peaks.length} buckets)`);
      setPeaks(peaks);

      const waveform: WaveformCache = { name: title, duration, peaks };
      // Fire-and-forget: the waveform is already rendered from memory; a failed
      // cache write only costs a recompute next time this track plays.
      invoke("cache_waveform", { key: cacheKey, waveform }).catch(() => {}); // eslint-disable-line no-restricted-syntax

      // Computed here, so nobody had it: offer it to the sharing plugins. One a
      // plugin handed us is not shared back.
      if (bridge && !isPluginWaveformProvider(result.providerId)) {
        const rms = result.rms;
        void facts(rms.length).then((f) => {
          if (f && !cancelled) bridge.share(f, rms);
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trackPath, trackName, trackArtist, durationSecs, isVideo, assetUrl, plugins, trackRef]);

  return peaks;
}
