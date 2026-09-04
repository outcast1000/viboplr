const REMASTER_SUFFIX = /\s*-\s*.*remaster.*$/i;

export function stripRemasterSuffix(s: string | null | undefined): string | null {
  if (!s) return s as null;
  return s.replace(REMASTER_SUFFIX, "").trim() || s;
}

import { invoke } from "@tauri-apps/api/core";
import type { StreamResolveResult } from "./types/plugin";
import type { Track } from "./types";
import { isVideoTrack } from "./utils";

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
     *  — the same resolver serves an audio play and a video play in one session.
     *  `preferVideo`: this call is the prefer-video pass asking for an actual
     *  VIDEO stream — the built-in Library resolver then considers only video
     *  copies of the match (answering null when it has none) so the pass can
     *  fall through cleanly. Plugin resolvers receive the prefer-video hint
     *  through their own bridge and ignore this field. */
    opts?: { externalAudio?: boolean; fresh?: boolean; preferVideo?: boolean },
  ) => Promise<ChainResult | null>;
}

/**
 * The built-in "Library" stream resolver: plays a library copy of a track that
 * arrived from elsewhere (a Spotify playlist row, a Home track-row with no
 * source of its own). It walks EVERY copy of the best metadata match —
 * `find_tracks_by_metadata` returns them ordered local > subsonic > other — and
 * verifies a local copy still exists on disk before answering, so a row that
 * outlived its file falls through to the network copy (and, with no copy left,
 * to the resolvers behind it) instead of handing playback a dead path.
 */
export function createLibraryStreamResolver(): StreamResolver {
  return {
    id: "built-in:library",
    name: "Library",
    source: "built-in",
    resolve: async (title, artistName, albumName, _durationSecs, opts) => {
      const matches = await invoke<Track[]>("find_tracks_by_metadata", {
        title: stripRemasterSuffix(title) ?? title,
        artistName,
        albumName: stripRemasterSuffix(albumName),
      });
      // The prefer-video pass wants a VIDEO copy specifically — a user's own
      // music-video file should beat fetching one from the network. Only video
      // copies count there; with none playable the answer is null, so the pass
      // falls through (the normal-pass entry still serves the audio copy).
      const candidates = opts?.preferVideo ? matches.filter((t) => isVideoTrack(t)) : matches;
      for (const track of candidates) {
        if (!track.path) continue;
        if (track.path.startsWith("file://")) {
          // A library row is not proof the bytes are still there — a moved or
          // deleted file leaves the row behind, and a source that resolves
          // "successfully" and then won't load fails at *playback*, which
          // never advances the chain. Skipping here is what lets the network
          // copy (or a resolver further down the chain) play instead.
          const filePath = track.path.substring(7);
          if (!(await invoke<boolean>("file_exists", { path: filePath }))) {
            console.debug(`Library copy is no longer on disk, trying the next copy: ${filePath}`);
            continue;
          }
        }
        // Report the matched copy's media kind so the resolver layer can
        // reclassify the played track: a VIDEO track that falls back to a
        // library AUDIO copy (e.g. a VPN-blocked YouTube video → its local /
        // Subsonic audio version) must then play as audio. (See the
        // reclassify branch in useStreamResolution.)
        //
        // `sourceUrl` is the copy's own URI — `file://`-prefixed for a local
        // copy, which is what `effectiveLocalPath` and the queue-thumb
        // localPath derivation key on.
        return {
          url: track.path,
          label: "Library",
          sourceUrl: track.path,
          video: isVideoTrack(track),
          format: track.format,
        };
      }
      return null;
    },
  };
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
