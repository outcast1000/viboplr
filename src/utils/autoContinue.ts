// Auto-continue's pure decisions: the weighted strategy pick, the weight
// sliders' redistribution, when to prefetch, and which plugin suggestion to
// take. `useAutoContinue` owns the state and the I/O around them.
import type { PluginAutoContinueRequest, PluginTrack } from "../types/plugin";
import { trackLikeId } from "./likeReconcile";

/** Per-plugin budget for one suggestion (a Last.fm round trip is ~1s). */
export const PLUGIN_AUTO_CONTINUE_TIMEOUT_MS = 15_000;

/** What `usePlugins` hands auto-continue. A provider is a plugin that both
 *  declares `contributes.autoContinue` and registered a handler — the same set
 *  Settings lists. `suggest` asks them in load order and hands each answer to
 *  `accept`, moving on to the next plugin while `accept` returns null (every
 *  suggestion recent, disliked or the wrong format), so one plugin's unusable
 *  answer can't stop the rest from being asked. */
export interface AutoContinuePluginBridge {
  hasProviders(): boolean;
  suggest<T>(
    request: PluginAutoContinueRequest,
    accept: (pluginId: string, tracks: PluginTrack[]) => Promise<T | null>,
  ): Promise<T | null>;
}

export interface AutoContinueWeights {
  random: number;
  sameArtist: number;
  sameTag: number;
  mostPlayed: number;
  liked: number;
  /** "Similar (plugins)": ask the auto-continue plugins (Last.fm) for a song
   *  like the current one. Default 0 — plugins are otherwise only asked when
   *  the library has nothing to offer. */
  similar: number;
}

export const STRATEGY_KEYS: (keyof AutoContinueWeights)[] = [
  "random", "sameArtist", "sameTag", "mostPlayed", "liked", "similar",
];

/** The strategy that asks plugins rather than the library. */
export const PLUGIN_STRATEGY = "similar";

/** `get_auto_continue_track`'s strategy names, plus the plugin one. */
const STRATEGY_MAP: Record<keyof AutoContinueWeights, string> = {
  random: "random",
  sameArtist: "same_artist",
  sameTag: "same_tag",
  mostPlayed: "most_played",
  liked: "liked",
  similar: PLUGIN_STRATEGY,
};

export const DEFAULT_AUTO_CONTINUE_WEIGHTS: AutoContinueWeights = {
  random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10, similar: 0,
};

/** `roll` is 0–99. Weights that don't reach 100 fall through to random. */
export function pickStrategy(weights: AutoContinueWeights, roll: number): string {
  let cumulative = 0;
  for (const key of STRATEGY_KEYS) {
    cumulative += weights[key];
    if (roll < cumulative) return STRATEGY_MAP[key];
  }
  return "random";
}

/** A stored weights object, read defensively. A profile saved before the
 *  plugin strategy existed has five keys summing to 100: `similar` comes in at
 *  0, so its picks are exactly what they were. */
export function coerceWeights(stored: unknown): AutoContinueWeights {
  const out = { ...DEFAULT_AUTO_CONTINUE_WEIGHTS };
  if (!stored || typeof stored !== "object") return out;
  const s = stored as Record<string, unknown>;
  for (const key of STRATEGY_KEYS) {
    const v = s[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.max(0, Math.min(100, Math.round(v)));
    else if (key === "similar") out[key] = 0;
  }
  return out;
}

/** Set one weight and spread the difference over the others so they keep
 *  adding up to 100 — in proportion to their current values, or evenly when
 *  they are all 0.
 *
 *  A weight at 0 stays at 0 unless the user moves it: the rounding remainder
 *  goes to the largest of the others (it used to go to the last key, which is
 *  Similar — so dragging Random to 33 gave a plugin-less Similar 1%), and the
 *  even split leaves Similar out (it is opt-in; its slider can be greyed out). */
export function redistributeWeights(
  prev: AutoContinueWeights,
  key: keyof AutoContinueWeights,
  value: number,
): AutoContinueWeights {
  const clamped = Math.max(0, Math.min(100, value));
  if (clamped === prev[key]) return prev;
  const others = STRATEGY_KEYS.filter((k) => k !== key);
  const othersSum = others.reduce((s, k) => s + prev[k], 0);
  const next = { ...prev, [key]: clamped };
  const remaining = 100 - clamped;
  if (othersSum === 0) {
    const spread = others.filter((k) => k !== "similar");
    const each = Math.floor(remaining / spread.length);
    let leftover = remaining - each * spread.length;
    for (const k of others) next[k] = 0;
    for (const k of spread) {
      next[k] = each + (leftover > 0 ? 1 : 0);
      if (leftover > 0) leftover--;
    }
    return next;
  }
  let distributed = 0;
  for (const k of others) {
    next[k] = Math.round((prev[k] / othersSum) * remaining);
    distributed += next[k];
  }
  const largest = others.reduce((a, b) => (next[b] > next[a] ? b : a));
  next[largest] = Math.max(0, next[largest] + remaining - distributed);
  return next;
}

/** Seconds before a track ends to ask auto-continue for the next one. The
 *  library answers instantly, so 20s (the ordinary preload lead) is plenty. A
 *  plugin suggestion is a network lookup followed by a stream search
 *  (yt-dlp…) before the song is due, so when plugins may be asked the request
 *  goes out much earlier. */
export const LIBRARY_PREFETCH_LEAD_SECS = 20;
export const PLUGIN_PREFETCH_LEAD_SECS = 60;

export function prefetchLeadSecs(opts: {
  hasProviders: boolean;
  similarWeight: number;
  libraryEmpty: boolean;
}): number {
  if (!opts.hasProviders) return LIBRARY_PREFETCH_LEAD_SECS;
  return opts.similarWeight > 0 || opts.libraryEmpty ? PLUGIN_PREFETCH_LEAD_SECS : LIBRARY_PREFETCH_LEAD_SECS;
}

/** A prefetched pick can arrive seconds after it was asked for (a plugin
 *  lookup). Queue it only if it still continues what is playing: the same
 *  track, nothing queued after it meanwhile (an album the user started, the
 *  end-of-queue path's own pick), and no play session still filling its tail. */
export function prefetchStillWanted(s: {
  fetchedForKey: string;
  currentKey: string | null;
  hasNext: boolean;
  backfillPending: boolean;
}): boolean {
  return s.currentKey === s.fetchedForKey && !s.hasNext && !s.backfillPending;
}

/** The first plugin suggestion worth playing: it has a title, wasn't played
 *  recently, isn't the current song, isn't disliked (`likeStates[i] === -1`),
 *  and fits "Same format" — a suggestion that doesn't say it is video counts
 *  as audio. Returns its index, or null. */
export function pickPluginCandidate(
  candidates: PluginTrack[],
  opts: { recentIds: ReadonlySet<string>; likeStates: readonly number[]; formatFilter: "audio" | "video" | null },
): number | null {
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!c || typeof c.title !== "string" || c.title.trim() === "") continue;
    if (opts.recentIds.has(trackLikeId(c.title, c.artist_name ?? null))) continue;
    if (opts.likeStates[i] === -1) continue;
    const kind = c.kind === "video" ? "video" : "audio";
    if (opts.formatFilter && opts.formatFilter !== kind) continue;
    return i;
  }
  return null;
}
