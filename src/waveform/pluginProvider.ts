import type { TrackAudioFacts, WaveformAttempt, WaveformProvider, WaveformRequest } from "./types";

/** How long a plugin lookup may hold up the seek bar before the chain moves on
 *  (to computing it locally, or to no waveform for a stream). */
export const PLUGIN_WAVEFORM_TIMEOUT_MS = 3000;

/** The plugin side of the chain, as `usePlugins` exposes it. Read at call time,
 *  so plugins loading or unloading mid-session are picked up. */
export interface WaveformPluginBridge {
  /** Plugins that registered `api.waveforms.onLookup`, in load order. */
  lookupProviderIds(): string[];
  /** One plugin's answer: normalized per-second RMS, or null. Never throws. */
  lookup(pluginId: string, facts: TrackAudioFacts): Promise<number[] | null>;
  /** Hand a waveform the host computed to every plugin that registered
   *  `api.waveforms.onShare`. Fire-and-forget. */
  share(facts: TrackAudioFacts, rms: number[]): void;
  /** Whether any plugin would receive a share — so facts aren't built for nobody. */
  hasShareHandlers(): boolean;
}

/** Longest waveform accepted from a plugin: two hours, one value per second. */
export const PLUGIN_WAVEFORM_MAX_SECS = 7200;

/**
 * A plugin's answer, made safe to draw and cache: non-finite or negative values
 * read as silence, and an answer whose length doesn't fit the track (allowing
 * max(3s, 3%) for rounding and edit differences) or is absurdly long is refused
 * — it would misplace every bar, and the cache would keep it.
 */
export function sanitizePluginRms(rms: unknown, durationSecs: number): number[] | null {
  if (!Array.isArray(rms) || rms.length === 0 || rms.length > PLUGIN_WAVEFORM_MAX_SECS) return null;
  const expected = Math.ceil(durationSecs);
  if (Math.abs(rms.length - expected) > Math.max(3, expected * 0.03)) return null;
  return rms.map((v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0));
}

/** Provider ids are `plugin:<pluginId>`, so the chain's result names its source. */
export const PLUGIN_PROVIDER_PREFIX = "plugin:";

export function isPluginWaveformProvider(providerId: string): boolean {
  return providerId.startsWith(PLUGIN_PROVIDER_PREFIX);
}

/**
 * A provider that asks one plugin for a waveform someone already computed. It
 * never computes anything, so it is the one kind that works for streams. A miss,
 * a timeout or a failure is `skipped` — the next provider decides.
 */
export function pluginWaveformProvider(pluginId: string, bridge: WaveformPluginBridge): WaveformProvider {
  return {
    id: `${PLUGIN_PROVIDER_PREFIX}${pluginId}`,
    async analyze({ signal, facts }: WaveformRequest): Promise<WaveformAttempt> {
      if (signal.aborted) return { status: "cancelled" };
      const trackFacts = await facts();
      if (signal.aborted) return { status: "cancelled" };
      if (!trackFacts) return { status: "skipped", reason: "no duration to match on" };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const rms = await Promise.race([
        bridge.lookup(pluginId, trackFacts),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PLUGIN_WAVEFORM_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      if (signal.aborted) return { status: "cancelled" };
      return rms && rms.length > 0
        ? { status: "ok", rms }
        : { status: "skipped", reason: "the plugin has none for this track" };
    },
  };
}
