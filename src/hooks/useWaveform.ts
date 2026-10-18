import { useState, useEffect, useRef, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { analyzeWaveform, shapePeaks, waveformProviders } from "../waveform/providers";
import { isPluginWaveformProvider, type WaveformPluginBridge } from "../waveform/pluginProvider";
import {
  CAPTURE_POLL_MS,
  ENGINE_CAPTURE_PROVIDER_ID,
  fillCaptureGaps,
  isCaptureComplete,
  readEngineCapture,
  type EngineWaveCapture,
} from "../waveform/engineCapture";
import type { TrackAudioFacts, WaveformPeaks } from "../waveform/types";
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
//
// When that chain comes back empty — a stream nobody shared — the waveform is
// built from what the engine hears while it plays (src/waveform/engineCapture.ts):
// drawn as it fills in, and cached and shared only once 99% of the track has
// been heard.

/** After the track changes, how long to wait before the last look at its
 *  capture: its final second lands as it ends, when the engine puts it away. */
const CAPTURE_FINAL_READ_MS = 1500;

/** Cache keys already saved from a capture, so the last look after a track
 *  change and the poll of a replayed copy don't save (and share) it twice. */
const savedCaptures = new Set<string>();

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
 * Web Audio `fetch` is CORS-blocked for them anyway). A stream gets its waveform
 * from the engine's capture instead, built from the samples it already decodes
 * for playback (see the hook below).
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
 * audio track with a title and a known length — a stream can't be analyzed, but a
 * waveform someone else shared (or one already cached) still fits it, matched by
 * artist + title + duration. No path needed: a metadata-only entry a stream
 * resolver plays (a radio seed, a "Not in library" row) has none.
 */
export function isWaveformShowable(
  candidate: WaveformCandidate,
): candidate is WaveformCandidate & { title: string } {
  if (isWaveformComputable(candidate)) return true;
  if (!candidate.title || candidate.isVideo) return false;
  return (candidate.durationSecs ?? 0) > 0;
}

export function useWaveform(
  track: QueueTrack | null,
  {
    durationSecs,
    isVideo,
    assetUrl,
    plugins,
    pluginsReady,
    isEngineDecoding,
  }: {
    /** The track's own length; for a stream, the player's once it knows it. */
    durationSecs: number | null;
    isVideo: boolean;
    assetUrl: string | null;
    /** Plugin lookup/share bridge, read at call time; null before plugins load. */
    plugins: RefObject<WaveformPluginBridge | null>;
    /** Plugins have activated. Until then nothing is computed — a lookup might
     *  have had it, and a waveform computed now would never be shared. */
    pluginsReady: boolean;
    /** Whether the native engine is decoding this track key (its live facts are about it). */
    isEngineDecoding: (trackKey: string) => boolean;
  },
): WaveformPeaks | null {
  const [peaks, setPeaks] = useState<WaveformPeaks | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The cache key whose peaks are on screen: a re-run for the same key (plugins
  // becoming ready) keeps them instead of blanking the bar.
  const shownKeyRef = useRef<string | null>(null);
  // The cache key whose capture, still building, is on screen — also kept
  // through a re-run, while the new run catches up with the engine.
  const buildingKeyRef = useRef<string | null>(null);
  // The effect keys on the identity fields below; the rest (album, format…) is read
  // from here when the facts are built, so a like toggle doesn't re-run it.
  const trackRef = useLatestRef(track);
  const engineRef = useLatestRef(isEngineDecoding);
  const trackKey = track?.key ?? null;
  const trackPath = track?.path ?? null;
  const trackName = track?.title ?? null;
  const trackArtist = track?.artist_name ?? null;

  useEffect(() => {
    const candidate = { path: trackPath, title: trackName, isVideo, durationSecs };
    const cacheKey = isWaveformShowable(candidate) ? waveformKey(trackArtist, candidate.title, durationSecs) : null;
    if (cacheKey === null || (cacheKey !== shownKeyRef.current && cacheKey !== buildingKeyRef.current)) {
      shownKeyRef.current = null;
      buildingKeyRef.current = null;
      setPeaks(null);
    }
    if (!isWaveformShowable(candidate) || cacheKey === null) return;
    if (shownKeyRef.current === cacheKey) return; // already drawn
    const { title } = candidate;
    const path = trackPath;
    const canCompute = isWaveformComputable(candidate);

    let cancelled = false;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Built on first ask, and only when a plugin provider or a share needs them.
    // Cached per duration and only when there is an answer: a lookup that found
    // no duration to match on must not stop the share that has one (rms length).
    const factsByDuration = new Map<number, Promise<TrackAudioFacts | null>>();
    const facts = (fallbackDuration?: number): Promise<TrackAudioFacts | null> => {
      const current = trackRef.current;
      const duration = durationSecs ?? fallbackDuration ?? 0;
      if (!current || duration <= 0) return Promise.resolve(null);
      let pending = factsByDuration.get(duration);
      if (!pending) {
        pending = resolveTrackAudioFacts(current, duration, () => engineRef.current(current.key), controller.signal)
          .catch((e) => {
            console.error("Failed to resolve audio facts for the waveform:", e);
            factsByDuration.delete(duration);
            return null;
          });
        factsByDuration.set(duration, pending);
      }
      return pending;
    };

    (async () => {
      try {
        const cached = await invoke<WaveformCache | null>("get_cached_waveform", { key: cacheKey });
        if (cancelled) return;
        if (cached && cached.peaks && cached.peaks.length > 0) {
          console.debug(`[waveform] loaded cached: "${cached.name}" (${cached.duration}s, ${cached.peaks.length} buckets)`);
          shownKeyRef.current = cacheKey;
          setPeaks(cached.peaks);
          return;
        }
      } catch (e) {
        // A miss is `null`, not a throw; still worth analyzing after a read error.
        console.error("Failed to read cached waveform:", e);
      }
      // A miss before plugins are up waits for them (this effect re-runs).
      if (!pluginsReady) return;

      const bridge = plugins.current;
      const result = await analyzeWaveform(waveformProviders(bridge, { canCompute }), {
        path,
        title,
        assetUrl,
        signal: controller.signal,
        facts: () => facts(),
      });
      if (cancelled) return;
      if (result) {
        const peaks = shapePeaks(result.rms);
        console.debug(`[waveform] created new via ${result.providerId}: "${title}" (${durationSecs || peaks.length}s, ${peaks.length} buckets)`);
        shownKeyRef.current = cacheKey;
        setPeaks(peaks);
        keep(result.providerId, result.rms, peaks, false);
        return;
      }

      // Nobody had it and nothing could compute it (a stream, or a local file
      // no computing provider could read): build it from what the engine hears.
      if (!trackKey) return;
      capturing = true;
      // Resolved now, while the engine still describes this track, so a capture
      // completed after the track ended can still be shared.
      if (bridge?.hasShareHandlers()) void facts();
      void pollCapture(trackKey);
    })();

    // Cache a finished waveform and — when the host made it, so nobody had it —
    // offer it to the sharing plugins. One a plugin handed us is not shared back.
    // `afterTrack`: saved after the effect moved on (a capture's last look).
    function keep(providerId: string, rms: number[], peaks: number[], afterTrack: boolean) {
      const waveform: WaveformCache = { name: title, duration: durationSecs || peaks.length, peaks };
      // Fire-and-forget: the waveform is already rendered from memory; a failed
      // cache write only costs a recompute next time this track plays.
      invoke("cache_waveform", { key: cacheKey, waveform }).catch(() => {}); // eslint-disable-line no-restricted-syntax
      const bridge = plugins.current;
      if (bridge && bridge.hasShareHandlers() && !isPluginWaveformProvider(providerId)) {
        void facts(rms.length).then((f) => {
          if (f && (afterTrack || !cancelled)) bridge.share(f, rms);
        });
      }
    }

    let capturing = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    function saveCapture(capture: EngineWaveCapture, afterTrack: boolean) {
      if (savedCaptures.has(cacheKey!)) return;
      savedCaptures.add(cacheKey!);
      const rms = fillCaptureGaps(capture.rms);
      const peaks = shapePeaks(rms);
      console.debug(`[waveform] captured while playing: "${title}" (${peaks.length} buckets, ${(capture.coverage * 100).toFixed(1)}% heard)`);
      if (!afterTrack) {
        shownKeyRef.current = cacheKey;
        buildingKeyRef.current = null;
        setPeaks(peaks);
      }
      keep(ENGINE_CAPTURE_PROVIDER_ID, rms, peaks, afterTrack);
    }

    async function pollCapture(key: string) {
      let capture: EngineWaveCapture | null = null;
      try {
        capture = await readEngineCapture(key);
      } catch (e) {
        console.error("Failed to read the engine's waveform capture:", e);
      }
      if (cancelled) return;
      if (capture && isCaptureComplete(capture)) {
        saveCapture(capture, false);
        return;
      }
      // Less than the whole track: draw what was heard, cache nothing.
      if (capture && capture.rms.some((v) => v !== null)) {
        buildingKeyRef.current = cacheKey;
        setPeaks(shapePeaks(capture.rms));
      }
      pollTimer = setTimeout(() => void pollCapture(key), CAPTURE_POLL_MS);
    }

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(pollTimer);
      if (capturing && trackKey && !savedCaptures.has(cacheKey)) {
        const key = trackKey;
        setTimeout(() => {
          readEngineCapture(key)
            .then((capture) => {
              if (capture && isCaptureComplete(capture)) saveCapture(capture, true);
            })
            .catch((e) => console.error("Failed to read the engine's waveform capture:", e));
        }, CAPTURE_FINAL_READ_MS);
      }
    };
  }, [trackKey, trackPath, trackName, trackArtist, durationSecs, isVideo, assetUrl, plugins, pluginsReady, trackRef, engineRef]);

  return peaks;
}
