import { useState, useRef, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack, ResolvedTrackSource, ResolvedSource } from "../types";
import { parseUrlScheme, isRemoteScheme, classifyEffectiveSource, type EffectiveSource } from "../queueEntry";
import { type StreamResolver, stripRemasterSuffix } from "../streamResolvers";

const TRANSCODE_VIDEO_FORMATS = ["mkv", "avi", "wmv"];

/** Formats that the local `<video>` element can't play natively and that must be
 * routed through the on-the-fly transcode server. */
export function needsTranscode(track: { format: string | null }): boolean {
  return TRANSCODE_VIDEO_FORMATS.includes(track.format?.toLowerCase() ?? "");
}

interface TranscodeSession {
  sessionId: string;
  baseUrl: string;
  durationSecs: number | null;
  seekOffset: number;
}

interface UseStreamResolutionDeps {
  /** Created in App (must precede `usePlayback`, which consumes it). This hook
   * assigns its `.current` to the real resolver once plugins are available. */
  resolveTrackSrcRef: React.MutableRefObject<(track: QueueTrack) => Promise<ResolvedTrackSource>>;
  /** Created in App and shared with `usePlayback` for seek/offset math + cleanup. */
  transcodeSessionRef: React.MutableRefObject<TranscodeSession | null>;
  /** Created in App; kept fresh here from `resolveStreamByUri`. */
  resolveStreamByUriRef: React.MutableRefObject<(scheme: string, id: string, quality?: string | null) => Promise<string>>;
  /** Ordered, user-configured plugin stream resolvers (populated elsewhere in App). */
  streamResolversRef: React.MutableRefObject<StreamResolver[]>;
  /** Latest plugin stream-URI resolver (`plugins.resolveStreamByUri`). */
  resolveStreamByUri: (scheme: string, id: string, quality?: string | null) => Promise<string>;
  /** Maps a custom URL scheme to its owning plugin id (`plugins.streamUriResolverOwner`).
   *  Lets a native plugin scheme (e.g. `tidal://`) classify to `{ kind: "plugin", pluginId }`. */
  streamUriResolverOwner: (scheme: string) => string | null;
  /** Surfaces the platform-aware dependency install modal (`dependencies.requireDep`). */
  requireDep: (name: string, feature: string) => Promise<boolean>;
  /** Current queue — drives pruning of stale per-track resolve failures. */
  queue: QueueTrack[];
  /** Currently-playing track — drives transcode-session teardown. */
  currentTrack: QueueTrack | null;
}

/**
 * The playback source-resolution engine: builds the `resolveTrackSrcRef` resolver
 * chain (library copy → native scheme → user-ordered plugin stream resolvers),
 * manages the transcode-session lifecycle, and tracks per-track resolve status +
 * persistent failures. Extracted out of App.tsx; the refs it drives are created
 * there (so `usePlayback` can consume them) and passed in here.
 *
 * Returns the render-facing resolution state.
 */
export function useStreamResolution({
  resolveTrackSrcRef,
  transcodeSessionRef,
  resolveStreamByUriRef,
  streamResolversRef,
  resolveStreamByUri,
  streamUriResolverOwner,
  requireDep,
  queue,
  currentTrack,
}: UseStreamResolutionDeps) {
  const [resolvingStatus, setResolvingStatus] = useState<{ key: string; error: string | null; trying: string | null } | null>(null);
  // Persistent per-track resolve failures, keyed by QueueTrack.key. Survives track
  // changes so the failed row keeps explaining what happened until a later retry succeeds.
  const [resolveFailures, setResolveFailures] = useState<Record<string, string>>({});
  const [resolvedSource, setResolvedSource] = useState<ResolvedSource | null>(null);
  const resolveGenerationRef = useRef(0);

  // `requireDep` is read inside the build-once resolver below; keep it in a ref so
  // the resolver always calls the latest one without re-building the chain.
  const requireDepRef = useRef(requireDep);
  requireDepRef.current = requireDep;

  // Scheme→owner lookup, read inside the build-once resolver. Kept fresh in a ref
  // so the chain always sees the current plugin set without rebuilding.
  const ownerRef = useRef(streamUriResolverOwner);
  ownerRef.current = streamUriResolverOwner;

  useEffect(() => {
    resolveStreamByUriRef.current = resolveStreamByUri;
  }, [resolveStreamByUri, resolveStreamByUriRef]);

  // Build the resolver once. It closes only over stable refs/setters, so the
  // chain stays correct across renders without rebuilding.
  useEffect(() => {
    const resolveUrl = (url: string): Promise<string> => {
      if (url.startsWith("http://") || url.startsWith("https://")) return Promise.resolve(url);
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") return Promise.resolve(convertFileSrc(parsed.path));
      if (parsed.scheme === "plugin") return resolveStreamByUriRef.current(parsed.protocol, parsed.id, null).then(r => resolveUrl(r));
      if (parsed.scheme === "subsonic") return invoke<string>("resolve_subsonic_location", { location: url });
      return Promise.reject(new Error(`Unplayable URL scheme: ${url}`));
    };

    const nativeResolverName = (url: string): string => {
      if (url.startsWith("http://") || url.startsWith("https://")) return "Direct URL";
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") return "Local";
      if (parsed.scheme === "plugin") return parsed.protocol.charAt(0).toUpperCase() + parsed.protocol.slice(1);
      if (parsed.scheme === "subsonic") return "Subsonic";
      return "Unknown";
    };

    resolveTrackSrcRef.current = async (track: QueueTrack) => {
      const generation = ++resolveGenerationRef.current;
      setResolvedSource(null);
      const url = track.path;

      interface ResolverEntry { name: string; id: string | null; sourceUrl: string | null; effectiveSource: EffectiveSource | null; patch?: Partial<QueueTrack>; resolve: () => Promise<string> }
      const chain: ResolverEntry[] = [];

      // Pre-resolution: check if a local copy exists for remote OR path-less tracks
      if (!url || isRemoteScheme(url)) {
        try {
          const localMatch = await invoke<Track | null>("find_track_by_metadata", {
            title: stripRemasterSuffix(track.title) ?? track.title,
            artistName: track.artist_name ?? null,
            albumName: stripRemasterSuffix(track.album_title),
          });
          if (localMatch && localMatch.path?.startsWith("file://")) {
            const localPath = localMatch.path.substring(7);
            chain.push({
              name: "Library",
              id: null,
              sourceUrl: localPath,
              // Matched a local file copy → bytes are on disk → nothing to download.
              effectiveSource: { kind: "local" },
              // Carry the matched file's path + format so the play path can
              // re-classify a path-less track (e.g. a Home track-row) as video.
              patch: { path: localMatch.path, format: localMatch.format },
              resolve: () => Promise.resolve(convertFileSrc(localPath)),
            });
          }
        } catch (e) {
          console.error("Pre-resolution local copy check failed:", e);
        }
      }

      // Native resolver first (if track has a known URL)
      if (url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          chain.push({ name: "Direct URL", id: null, sourceUrl: url, effectiveSource: classifyEffectiveSource(url, ownerRef.current), resolve: () => Promise.resolve(url) });
        } else {
          chain.push({
            name: nativeResolverName(url),
            id: null,
            sourceUrl: url,
            effectiveSource: classifyEffectiveSource(url, ownerRef.current),
            resolve: async () => {
              const parsed = parseUrlScheme(url);
              if (parsed.scheme === "file" && needsTranscode(track)) {
                if (transcodeSessionRef.current) {
                  invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
                }
                try {
                  const result = await invoke<{ url: string; sessionId: string; durationSecs: number | null }>("start_transcode", { path: parsed.path });
                  transcodeSessionRef.current = {
                    sessionId: result.sessionId,
                    baseUrl: result.url.replace(/\?seek=.*$/, ""),
                    durationSecs: result.durationSecs ?? null,
                    seekOffset: 0,
                  };
                  return result.url;
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes("ffmpeg is not installed")) {
                    requireDepRef.current("ffmpeg", "Video playback");
                  }
                  throw e;
                }
              }
              return resolveUrl(url);
            },
          });
        }
      }

      // A track that already carries a plugin's native scheme (e.g.
      // youtube://{id}) gets that plugin's by-id resolver in the chain above.
      // Don't also append the SAME plugin's metadata stream resolver: if the
      // exact id fails to resolve, re-searching by title/artist just re-picks
      // the same item (often the same unavailable video) after a long delay.
      // Other plugins and the local-library copy still serve as real fallbacks.
      let nativeSchemeOwner: string | null = null;
      if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
        const parsedScheme = parseUrlScheme(url);
        if (parsedScheme.scheme === "plugin") nativeSchemeOwner = ownerRef.current(parsedScheme.protocol);
      }

      // Append user-configured stream resolvers
      for (const sr of streamResolversRef.current) {
        if (nativeSchemeOwner && sr.source === nativeSchemeOwner) continue;
        // A plugin resolver streams from its own plugin; the built-in Library
        // resolver streams from whatever the matched row points at (file/subsonic/
        // plugin), so it's classified from the resolved URL inside resolve().
        const isBuiltinLibrary = sr.source === "built-in";
        const entry: ResolverEntry = {
          name: sr.name,
          id: sr.id,
          sourceUrl: null,
          effectiveSource: isBuiltinLibrary ? null : { kind: "plugin", pluginId: sr.source },
          resolve: async () => {
            const result = await Promise.race([
              sr.resolve(track.title, track.artist_name, track.album_title, track.duration_secs ?? null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000)),
            ]);
            if (!result) throw new Error("No result");
            if (result.sourceUrl) entry.sourceUrl = result.sourceUrl;
            if (isBuiltinLibrary) entry.effectiveSource = classifyEffectiveSource(result.url, ownerRef.current);
            return resolveUrl(result.url);
          },
        };
        chain.push(entry);
      }

      if (chain.length === 0) {
        throw new Error(`No playback source for: ${track.title}`);
      }

      let lastError: string | null = null;
      for (const entry of chain) {
        if (resolveGenerationRef.current !== generation) return { src: "" };
        if (lastError || chain.length > 1) {
          setResolvingStatus({ key: track.key, error: lastError, trying: entry.name });
        }
        try {
          const src = await entry.resolve();
          if (resolveGenerationRef.current !== generation) return { src: "" };
          setResolvingStatus(null);
          // Resolved successfully — clear any prior persistent failure for this track.
          setResolveFailures(prev => {
            if (!(track.key in prev)) return prev;
            const next = { ...prev };
            delete next[track.key];
            return next;
          });
          setResolvedSource({ name: entry.name, url: src, sourceUrl: entry.sourceUrl, id: entry.id, effectiveSource: entry.effectiveSource ?? { kind: "direct-url", uri: src } });
          if (lastError) {
            console.debug(`Playing from ${entry.name} (original unavailable)`);
          }
          return { src, patch: entry.patch };
        } catch (e) {
          console.error(`Stream resolver "${entry.name}" failed:`, e);
          lastError = entry.name === "Library" ? "Not in library" : `${entry.name} failed`;
          continue;
        }
      }

      if (resolveGenerationRef.current === generation) {
        setResolvingStatus(null);
      }
      // Record a persistent failure for this track so the queue row keeps
      // explaining what happened even after playback moves to another track.
      setResolveFailures(prev => ({ ...prev, [track.key]: lastError ?? "no source found" }));
      throw new Error(`No playback source found for: ${track.title}`);
    };
  }, [resolveTrackSrcRef, transcodeSessionRef, resolveStreamByUriRef, streamResolversRef]);

  // Tear down the transcode session when playback leaves a track that needed it.
  useEffect(() => {
    if (transcodeSessionRef.current && (!currentTrack || !needsTranscode(currentTrack))) {
      invoke("stop_transcode", { sessionId: transcodeSessionRef.current.sessionId }).catch(console.error);
      transcodeSessionRef.current = null;
    }
  }, [currentTrack, transcodeSessionRef]);

  // Prune persistent resolve failures for tracks no longer in the queue, so the
  // map stays bounded and a recycled key can't inherit a stale error.
  useEffect(() => {
    setResolveFailures(prev => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const live = new Set(queue.map(t => t.key));
      const stale = keys.filter(k => !live.has(k));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [queue]);

  return { resolvingStatus, resolveFailures, resolvedSource };
}
