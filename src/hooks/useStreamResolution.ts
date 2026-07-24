import { useState, useRef, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack, ResolvedTrackSource, ResolvedSource, EngineSource } from "../types";
import { parseUrlScheme, isRemoteScheme, classifyEffectiveSource, type EffectiveSource } from "../queueEntry";
import { isVideoTrack } from "../utils";
import { type StreamResolver, stripRemasterSuffix } from "../streamResolvers";
import { track as trackTelemetry, sourceClass } from "../telemetry";

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
  /** True when the native mpv engine will render video (macOS full build,
   * engine selected) — mkv/avi/wmv then skip the ffmpeg transcode server and
   * resolve to a raw file `engineSource` instead. */
  useNativeVideoRef: React.MutableRefObject<boolean>;
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
  useNativeVideoRef,
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
    // Resolves a scheme-prefixed URL to both the webview src and the raw
    // origin (`engineSource`) the native mpv engine plays directly. Computed
    // here, at the branch points, because the final `src` alone can't be
    // classified — convertFileSrc yields `https://asset.localhost/…` on
    // Windows, which would look like a remote URL.
    const resolveUrlDetailed = (url: string): Promise<{ src: string; engineSource: EngineSource | null }> => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return Promise.resolve({ src: url, engineSource: { kind: "http", url } });
      }
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") {
        return Promise.resolve({ src: convertFileSrc(parsed.path), engineSource: { kind: "file", path: parsed.path } });
      }
      if (parsed.scheme === "plugin") return resolveStreamByUriRef.current(parsed.protocol, parsed.id, null).then(r => resolveUrlDetailed(r));
      if (parsed.scheme === "subsonic") {
        return invoke<string>("resolve_subsonic_location", { location: url })
          .then(streamUrl => ({ src: streamUrl, engineSource: { kind: "http" as const, url: streamUrl } }));
      }
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

      interface ResolverEntry { name: string; id: string | null; sourceUrl: string | null; effectiveSource: EffectiveSource | null; patch?: Partial<QueueTrack>; resolve: () => Promise<{ src: string; engineSource: EngineSource | null }> }
      const chain: ResolverEntry[] = [];

      // Pre-resolution: check if a local copy exists for remote OR path-less tracks
      if (!url || isRemoteScheme(url)) {
        try {
          const localMatch = await invoke<Track | null>("find_track_by_metadata", {
            title: stripRemasterSuffix(track.title) ?? track.title,
            artistName: track.artist_name ?? null,
            albumName: stripRemasterSuffix(track.album_title),
          });
          // Don't substitute a local copy across the audio/video boundary: a
          // "Watch" of a web video must stream the video, not the local audio
          // track that merely shares its title/artist (and vice-versa). Only
          // reuse a local copy when its media kind matches what was requested.
          if (localMatch && localMatch.path?.startsWith("file://") && isVideoTrack(track) === isVideoTrack(localMatch)) {
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
              resolve: () => Promise.resolve({ src: convertFileSrc(localPath), engineSource: { kind: "file" as const, path: localPath } }),
            });
          }
        } catch (e) {
          console.error("Pre-resolution local copy check failed:", e);
        }
      }

      // Native resolver first (if track has a known URL)
      if (url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          chain.push({ name: "Direct URL", id: null, sourceUrl: url, effectiveSource: classifyEffectiveSource(url, ownerRef.current), resolve: () => Promise.resolve({ src: url, engineSource: { kind: "http" as const, url } }) });
        } else {
          chain.push({
            name: nativeResolverName(url),
            id: null,
            sourceUrl: url,
            effectiveSource: classifyEffectiveSource(url, ownerRef.current),
            resolve: async () => {
              const parsed = parseUrlScheme(url);
              // The native engine plays mkv/avi/wmv directly — no transcode.
              if (parsed.scheme === "file" && needsTranscode(track) && !useNativeVideoRef.current) {
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
                  // Transcode-server streams are webview-only by design.
                  return { src: result.url, engineSource: null };
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes("ffmpeg is not installed")) {
                    requireDepRef.current("ffmpeg", "Video playback");
                  }
                  throw e;
                }
              }
              return resolveUrlDetailed(url);
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
            // A resolver that honored the "prefer video" hint flags its result
            // as video; reclassify the track (format → mp4) so it routes to the
            // theater. Resolvers that ignore the hint omit the flag → plays as
            // whatever it normally would (audio), no theater.
            if (result.video) {
              entry.patch = { ...entry.patch, format: "mp4" };
            } else if (result.video === false && isVideoTrack(track)) {
              // The exact video source was unavailable and this resolver fell
              // back to a NON-video copy (e.g. the library's audio version of a
              // VPN-blocked YouTube video). Reclassify the played track to audio
              // so it plays without the native video layer — otherwise the mpv
              // engine renders video:true over an audio stream and the video
              // window lingers showing black / the previous frame. `format` is
              // authoritative in isVideoTrack, so a real audio format flips it.
              entry.patch = { ...entry.patch, format: result.format || "m4a" };
            }
            if (isBuiltinLibrary) entry.effectiveSource = classifyEffectiveSource(result.url, ownerRef.current);
            return resolveUrlDetailed(result.url);
          },
        };
        chain.push(entry);
      }

      if (chain.length === 0) {
        throw new Error("Couldn't find a playable source for this track");
      }

      let lastError: string | null = null;
      for (const entry of chain) {
        if (resolveGenerationRef.current !== generation) return { src: "" };
        if (lastError || chain.length > 1) {
          setResolvingStatus({ key: track.key, error: lastError, trying: entry.name });
        }
        try {
          const { src, engineSource } = await entry.resolve();
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
          return { src, patch: entry.patch, engineSource };
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
      trackTelemetry("stream_resolve_failed", { source: sourceClass(track.path) });
      throw new Error("Couldn't find a playable source for this track");
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
