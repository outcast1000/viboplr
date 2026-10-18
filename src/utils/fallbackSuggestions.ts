// "Couldn't play this track" → which plugins could have found a playable copy.
// Shown inside PlaybackFailureModal only (no popup of its own, so an unattended
// auto-skip run never gets interrupted). The choosing is the shared
// `suggestProviders` rule; this adds only what is specific to playback: when
// a suggestion makes sense at all, and which heading fits.

import type { GalleryPluginEntry, PluginState } from "../types/plugin";
import type { TrackFailure } from "../playback/trackFailures";
import { suggestProviders, type ProviderSuggestion } from "./providerSuggestions";

export type FallbackSuggestion = ProviderSuggestion;

export interface FallbackSuggestions {
  /** "none-ran": no plugin fallback was asked at all; "all-missed": the
   *  installed ones were asked and none had it. Decides the heading. */
  reason: "none-ran" | "all-missed";
  plugins: FallbackSuggestion[];
}

/**
 * Plugins worth pointing at after a track couldn't be played. Only for a
 * `resolve` failure — nothing found a source. A `playback` failure had a source
 * the engine couldn't open (another resolver wouldn't be asked), and an
 * `engine` failure means nothing can play anything. Returns null when there is
 * nothing to suggest, so the modal shows no empty section.
 */
export function suggestPlaybackFallbacks(args: {
  failure: TrackFailure;
  pluginStates: Array<Pick<PluginState, "id" | "enabled" | "status" | "manifest">>;
  gallery: GalleryPluginEntry[];
  appVersion?: string | null;
}): FallbackSuggestions | null {
  const { failure, pluginStates, gallery, appVersion } = args;
  if (failure.stage !== "resolve") return null;
  const plugins = suggestProviders({
    service: "playback-fallback",
    declares: (c) => (c.streamResolvers?.length ?? 0) > 0,
    pluginStates,
    gallery,
    appVersion,
  });
  if (!plugins.length) return null;
  const pluginAsked = failure.attempts.some((a) => a.fallback === true);
  return { reason: pluginAsked ? "all-missed" : "none-ran", plugins };
}
