import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track, QueueTrack } from "../types";
import type { PluginTrack } from "../types/plugin";
import { store } from "../store";
import { usePersistMirror } from "./usePersistedSetting";
import { isVideoTrack } from "../utils";
import { pluginTrackToQueueTrack, trackToQueueTrack } from "../queueEntry";
import { trackLikeId } from "../utils/likeReconcile";
import {
  coerceWeights,
  DEFAULT_AUTO_CONTINUE_WEIGHTS,
  pickPluginCandidate,
  pickStrategy,
  PLUGIN_STRATEGY,
  redistributeWeights,
  type AutoContinuePluginBridge,
  type AutoContinueWeights,
} from "../utils/autoContinue";

export type { AutoContinueWeights } from "../utils/autoContinue";
export { DEFAULT_AUTO_CONTINUE_WEIGHTS } from "../utils/autoContinue";

/** What the caller knows about the play session, for the plugins' sake: the
 *  queue so far (to skip what was just heard) and where the session began. */
export interface AutoContinueContext {
  recent?: QueueTrack[];
  sessionSeed?: QueueTrack | null;
  /** The library has no tracks: skip its two lookups and go straight to the
   *  plugins. */
  libraryEmpty?: boolean;
}

/** Suggestions asked of a plugin per pick; the first usable one plays. */
const PLUGIN_SUGGESTION_COUNT = 8;
const RECENT_LIMIT = 50;

/**
 * Auto-continue: what plays when the queue runs out.
 *
 * The library answers first (`get_auto_continue_track`, by weighted strategy,
 * falling back to random). Plugins (`api.playback.onAutoContinue`, e.g.
 * Last.fm's similar songs) are asked on the picks Settings gives "Similar
 * (plugins)", and whenever the library has nothing to offer — no library, or
 * nothing of the right format — which is what keeps a no-library setup
 * playing. Whatever answers comes back as a QueueTrack.
 *
 * `pluginBridgeRef` is filled by App once `usePlugins` exists.
 */
export function useAutoContinue(
  restoredRef: React.RefObject<boolean>,
  pluginBridgeRef?: React.RefObject<AutoContinuePluginBridge | null>,
) {
  const [enabled, setEnabled] = useState(false);
  const [sameFormat, setSameFormat] = useState(false);
  const [weights, setWeights] = useState<AutoContinueWeights>(DEFAULT_AUTO_CONTINUE_WEIGHTS);

  // Restore from store
  useEffect(() => {
    (async () => {
      const [en, w, sf] = await Promise.all([
        store.get<boolean>("autoContinueEnabled"),
        store.get<unknown>("autoContinueWeights"),
        store.get<boolean>("autoContinueSameFormat"),
      ]);
      if (en !== undefined && en !== null) setEnabled(en);
      if (w) setWeights(coerceWeights(w));
      if (sf !== undefined && sf !== null) setSameFormat(sf);
    })();
  }, []);

  // Persist
  usePersistMirror("autoContinueEnabled", enabled, restoredRef);
  usePersistMirror("autoContinueWeights", weights, restoredRef);
  usePersistMirror("autoContinueSameFormat", sameFormat, restoredRef);

  async function fromLibrary(strategy: string, current: QueueTrack, formatFilter: string | null): Promise<QueueTrack | null> {
    try {
      const track = await invoke<Track | null>("get_auto_continue_track", {
        strategy,
        currentTitle: current.title,
        currentArtist: current.artist_name,
        formatFilter,
      });
      return track ? trackToQueueTrack(track) : null;
    } catch (e) {
      console.error(`Auto-continue (${strategy}) failed to pick from the library:`, e);
      return null;
    }
  }

  async function fromPlugins(
    current: QueueTrack,
    formatFilter: "audio" | "video" | null,
    context: AutoContinueContext,
  ): Promise<QueueTrack | null> {
    const bridge = pluginBridgeRef?.current;
    if (!bridge || !bridge.hasProviders()) return null;
    const recent = [...(context.recent ?? []).slice(-RECENT_LIMIT), current];
    const recentIds = new Set(recent.map((t) => trackLikeId(t.title, t.artist_name)));
    // Each plugin's answer is filtered here; an answer with nothing usable
    // left returns null and the bridge asks the next plugin.
    const accept = async (pluginId: string, tracks: PluginTrack[]): Promise<QueueTrack | null> => {
      let likeStates: number[] = [];
      try {
        likeStates = await invoke<number[]>("get_track_like_states", {
          tracks: tracks.map((t) => ({ title: t?.title ?? "", artistName: t?.artist_name ?? null })),
        });
      } catch (e) {
        console.error("Auto-continue couldn't read like states for plugin suggestions:", e);
      }
      const index = pickPluginCandidate(tracks, { recentIds, likeStates, formatFilter });
      if (index === null) {
        console.debug(`[auto-continue] ${pluginId} suggested nothing usable`);
        return null;
      }
      console.debug(`[auto-continue] ${pluginId} suggested "${tracks[index].title}"`);
      return { ...pluginTrackToQueueTrack(tracks[index]), liked: likeStates[index] ?? 0 };
    };
    return bridge.suggest({
      current: {
        title: current.title,
        artistName: current.artist_name,
        albumTitle: current.album_title,
        durationSecs: current.duration_secs,
      },
      sessionSeed: context.sessionSeed
        ? { title: context.sessionSeed.title, artistName: context.sessionSeed.artist_name }
        : null,
      recent: recent.map((t) => ({ title: t.title, artistName: t.artist_name })),
      formatFilter,
      count: PLUGIN_SUGGESTION_COUNT,
    }, accept);
  }

  async function fetchTrack(current: QueueTrack, context: AutoContinueContext = {}): Promise<QueueTrack | null> {
    const strategy = pickStrategy(weights, Math.floor(Math.random() * 100));
    const formatFilter = sameFormat ? (isVideoTrack(current) ? "video" : "audio") : null;
    // Nothing to ask the library: two lookups that can only say "no".
    if (context.libraryEmpty) return fromPlugins(current, formatFilter, context);
    if (strategy === PLUGIN_STRATEGY) {
      // A plugin with nothing to say hands the pick back to the library.
      return (await fromPlugins(current, formatFilter, context)) ?? (await fromLibrary("random", current, formatFilter));
    }
    const fromLib = (await fromLibrary(strategy, current, formatFilter))
      ?? (strategy !== "random" ? await fromLibrary("random", current, formatFilter) : null);
    // Nothing in the library fits (none at all, or none of this format):
    // the plugins are what keeps the music going.
    return fromLib ?? (await fromPlugins(current, formatFilter, context));
  }

  function adjustWeight(key: keyof AutoContinueWeights, newValue: number) {
    setWeights((prev) => redistributeWeights(prev, key, newValue));
  }

  function resetWeights() {
    setWeights({ ...DEFAULT_AUTO_CONTINUE_WEIGHTS });
  }

  return {
    enabled, setEnabled,
    sameFormat, setSameFormat,
    weights, adjustWeight, resetWeights,
    fetchTrack,
  };
}
