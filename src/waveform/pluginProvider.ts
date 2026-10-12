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
