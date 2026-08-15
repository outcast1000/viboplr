const REMASTER_SUFFIX = /\s*-\s*.*remaster.*$/i;

export function stripRemasterSuffix(s: string | null | undefined): string | null {
  if (!s) return s as null;
  return s.replace(REMASTER_SUFFIX, "").trim() || s;
}

import type { StreamResolveResult } from "./types/plugin";

/** A resolver's answer as the host sees it: the plugin-facing result plus
 *  `format`, which only the built-in Library resolver sets (it names the real
 *  container of the local copy it matched, so a video-track fallback to an audio
 *  file can be reclassified). Plugins have no reason to send it. */
type ChainResult = StreamResolveResult & { format?: string | null };

export interface StreamResolver {
  id: string;
  name: string;
  source: string; // "built-in" or plugin ID
  resolve: (
    title: string,
    artistName: string | null,
    albumName: string | null,
    durationSecs: number | null,
    /** `externalAudio`: the native mpv engine will render this as video and can
     *  merge a separate audio stream, so a resolver with split hi-res streams
     *  should answer with `candidates`. Decided per *track* (not per resolver),
     *  which is why it is an argument rather than a ref the builder closes over
     *  — the same resolver serves an audio play and a video play in one session. */
    opts?: { externalAudio?: boolean; fresh?: boolean },
  ) => Promise<ChainResult | null>;
}

const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Iterate resolvers in order. First non-null result wins.
 * Each resolver gets a timeout; rejections are swallowed (skip to next).
 */
export async function resolveStreamChain(
  resolvers: StreamResolver[],
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null = null,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ChainResult | null> {
  for (const resolver of resolvers) {
    try {
      const result = await Promise.race([
        resolver.resolve(title, artistName, albumName, durationSecs),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (result) return result;
    } catch {
      // Resolver threw — skip to next
      continue;
    }
  }
  return null;
}
