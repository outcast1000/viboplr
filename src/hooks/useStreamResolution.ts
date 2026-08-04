import { useState, useRef, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track, QueueTrack, ResolvedTrackSource, ResolvedSource, EngineSource } from "../types";
import { parseUrlScheme, isRemoteScheme, classifyEffectiveSource, type EffectiveSource } from "../queueEntry";
import { isVideoTrack } from "../utils";
import { selectStream } from "../playback/selectStream";
import type { StreamCandidate } from "../types/plugin";
import { type StreamResolver, stripRemasterSuffix } from "../streamResolvers";
import { track as trackTelemetry, sourceClass } from "../telemetry";
import { classifyErrorKind } from "../utils/errorKind";

const TRANSCODE_VIDEO_FORMATS = ["mkv", "avi", "wmv"];

/** Reuse a just-resolved src for the SAME track within this window instead of
 *  hitting the resolver again. Short, because remote stream URLs (e.g.
 *  googlevideo) are short-lived — long enough to absorb the play + preload +
 *  fallback burst for one track, not so long that a genuinely new play reuses a
 *  dead URL. */
const RESOLVE_CACHE_TTL_MS = 12000;
const RESOLVE_CACHE_MAX = 64;

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

/** User-facing label for one failed resolver-chain entry. */
export function entryFailureLabel(name: string): string {
  return name === "Library" ? "Not in library" : `${name} failed`;
}

export interface ChainFailure {
  name: string;
  /** True for the entry that plays the track's own URL (its native source). */
  native?: boolean;
  /** Overrides the default "<name> failed" wording when the reason is known up
   *  front — e.g. a plugin scheme no installed plugin can resolve. */
  label?: string;
}

/**
 * Pick the user-facing blame once the whole resolver chain has failed. Blame
 * the track's own source (the native entry): the fallback resolvers that also
 * failed are incidental, and naming the last one pinned the failure on
 * whichever resolver happened to sit at the end of the user's order — e.g. a
 * dead local file or an unavailable YouTube video read "Subsonic Servers
 * failed". Tracks with no native source (path-less external rows) get a
 * neutral label instead of an arbitrary resolver name.
 */
export function describeChainFailure(failures: ChainFailure[]): string {
  const native = failures.find((f) => f.native);
  if (!native) return "No playable source found";
  return native.label ?? entryFailureLabel(native.name);
}

/**
 * Wording for a track whose own scheme belongs to no installed resolver — e.g. a
 * `spotify://` row from a browse-only plugin with no yt-dlp installed. Blaming
 * "Spotify failed" points at the plugin that produced the row and did nothing
 * wrong; the missing piece is a plugin that can turn that link into a stream.
 */
export function unownedSchemeLabel(scheme: string): string {
  return `No installed plugin can play ${scheme}:// links`;
}

interface UseStreamResolutionDeps {
  /** Created in App (must precede `usePlayback`, which consumes it). This hook
   * assigns its `.current` to the real resolver once plugins are available. */
  resolveTrackSrcRef: React.MutableRefObject<(track: QueueTrack, opts?: { preload?: boolean }) => Promise<ResolvedTrackSource>>;
  /** Created in App and shared with `usePlayback` for seek/offset math + cleanup. */
  transcodeSessionRef: React.MutableRefObject<TranscodeSession | null>;
  /** Created in App; kept fresh here from `resolveStreamByUri`. */
  resolveStreamByUriRef: React.MutableRefObject<(scheme: string, id: string, quality?: string | null, opts?: { externalAudio?: boolean }) => Promise<{ url: string; candidates?: StreamCandidate[] }>>;
  /** Ordered, user-configured plugin stream resolvers (populated elsewhere in App). */
  streamResolversRef: React.MutableRefObject<StreamResolver[]>;
  /** Latest plugin stream-URI resolver (`plugins.resolveStreamByUri`). */
  resolveStreamByUri: (scheme: string, id: string, quality?: string | null, opts?: { externalAudio?: boolean }) => Promise<{ url: string; candidates?: StreamCandidate[] }>;
  /** Maps a custom URL scheme to its owning plugin id (`plugins.streamUriResolverOwner`).
   *  Lets a native plugin scheme (e.g. `tidal://`) classify to `{ kind: "plugin", pluginId }`. */
  streamUriResolverOwner: (scheme: string) => string | null;
  /** Surfaces the platform-aware dependency install modal (`dependencies.requireDep`). */
  requireDep: (name: string, feature: string) => Promise<boolean>;
  /** True when the native mpv engine will render video (macOS full build,
   * engine selected) — mkv/avi/wmv then skip the ffmpeg transcode server and
   * resolve to a raw file `engineSource` instead. */
  useNativeVideoRef: React.MutableRefObject<boolean>;
  /** True when the user's "Prefer video" toggle is on. When set, every track
   * that isn't already a video is run through the plugin stream resolvers for a
   * video stream BEFORE its own (audio) source — a video result plays in the
   * theater, otherwise it falls through to normal audio playback. */
  preferVideoRef: React.MutableRefObject<boolean>;
  /** Current queue — drives pruning of stale per-track resolve failures. */
  queue: QueueTrack[];
  /** Currently-playing track — drives transcode-session teardown. */
  currentTrack: QueueTrack | null;
  /** Transient toast — surfaces silent fallbacks (video → library audio copy). */
  notify: (message: string) => void;
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
  preferVideoRef,
  queue,
  currentTrack,
  notify,
}: UseStreamResolutionDeps) {
  const [resolvingStatus, setResolvingStatus] = useState<{ key: string; error: string | null; trying: string | null } | null>(null);
  // Persistent per-track resolve failures, keyed by QueueTrack.key. Survives track
  // changes so the failed row keeps explaining what happened until a later retry succeeds.
  const [resolveFailures, setResolveFailures] = useState<Record<string, string>>({});
  const [resolvedSource, setResolvedSource] = useState<ResolvedSource | null>(null);
  const resolveGenerationRef = useRef(0);

  // Single-flight + short-TTL success cache for track resolution, both keyed by
  // QueueTrack.key. Collapses the redundant slow-resolver (yt-dlp) calls that
  // otherwise fire for the SAME track when several paths resolve it at once or
  // in quick succession (a play, the per-tick video pre-resolve, and the
  // engine-error → handlePlay fallback replay).
  const inFlightResolvesRef = useRef<Map<string, Promise<ResolvedTrackSource>>>(new Map());
  const resolveCacheRef = useRef<Map<string, { at: number; resolved: ResolvedTrackSource; meta: ResolvedSource | null }>>(new Map());

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
    const resolveUrlDetailed = (url: string, videoTrack = false): Promise<{ src: string; engineSource: EngineSource | null }> => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return Promise.resolve({ src: url, engineSource: { kind: "http", url } });
      }
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") {
        return Promise.resolve({ src: convertFileSrc(parsed.path), engineSource: { kind: "file", path: parsed.path } });
      }
      if (parsed.scheme === "plugin") {
        // When the native mpv engine will render this as video it can attach a
        // separate audio stream, so hint the resolver to offer split candidates
        // and let selectStream pick a hi-res video-only + audio-only pair. The
        // browser element can't merge, so it keeps getting a muxed stream — and
        // selectStream's `browserUrl` (always self-contained) is used as the
        // element src, which is also the safe fallback if the native play errors.
        const externalAudio = videoTrack && useNativeVideoRef.current;
        return resolveStreamByUriRef.current(parsed.protocol, parsed.id, null, externalAudio ? { externalAudio: true } : undefined).then(r => {
          if (r.candidates && r.candidates.length) {
            const sel = selectStream(r.candidates, { engine: externalAudio ? "native" : "browser", video: videoTrack });
            if (sel) {
              return { src: sel.browserUrl, engineSource: { kind: "http" as const, url: sel.url, audioUrl: sel.audioUrl } };
            }
          }
          return resolveUrlDetailed(r.url, videoTrack);
        });
      }
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

    // Core resolution. `preload` runs it OFF the shared play-resolution
    // generation lane: pre-resolving the next track must not bump the counter,
    // or the currently-playing track's in-flight resolve returns the empty-src
    // sentinel and handlePlay "retries" it — firing yt-dlp again. Preload
    // results are still deduped/cached by the public wrapper below.
    const doResolve = async (
      track: QueueTrack,
      preload: boolean,
    ): Promise<ResolvedTrackSource & { meta?: ResolvedSource | null }> => {
      const generation = preload ? -1 : ++resolveGenerationRef.current;
      setResolvedSource(null);
      const url = track.path;

      interface ResolverEntry { name: string; id: string | null; native?: boolean; failureLabel?: string; sourceUrl: string | null; effectiveSource: EffectiveSource | null; patch?: Partial<QueueTrack>; fellBackToAudio?: boolean; videoFirst?: boolean; resolve: () => Promise<{ src: string; engineSource: EngineSource | null }> }
      const chain: ResolverEntry[] = [];

      // Which plugin (if any) owns this track's own scheme. Drives two things:
      // the honest failure label below, and skipping that plugin's *metadata*
      // resolver later (see the comment at nativeSchemeOwner's use).
      const nativeScheme =
        url && !url.startsWith("http://") && !url.startsWith("https://")
          ? parseUrlScheme(url)
          : null;
      const nativeSchemeOwner =
        nativeScheme?.scheme === "plugin" ? ownerRef.current(nativeScheme.protocol) : null;
      // A plugin scheme nobody registered a resolver for can never resolve by id,
      // no matter how many times it's retried — say that instead of blaming the
      // plugin whose browse view produced the row.
      const nativeFailureLabel =
        nativeScheme?.scheme === "plugin" && !nativeSchemeOwner
          ? unownedSchemeLabel(nativeScheme.protocol)
          : undefined;

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
          chain.push({ name: "Direct URL", id: null, native: true, sourceUrl: url, effectiveSource: classifyEffectiveSource(url, ownerRef.current), resolve: () => Promise.resolve({ src: url, engineSource: { kind: "http" as const, url } }) });
        } else {
          chain.push({
            name: nativeResolverName(url),
            id: null,
            native: true,
            failureLabel: nativeFailureLabel,
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
              return resolveUrlDetailed(url, isVideoTrack(track));
            },
          });
        }
      }

      // `nativeSchemeOwner` (computed above) is also why a track that already
      // carries a plugin's native scheme (e.g. youtube://{id}) does NOT get that
      // same plugin's metadata stream resolver appended below: it already has the
      // plugin's by-id entry, and if the exact id fails to resolve, re-searching
      // by title/artist just re-picks the same item (often the same unavailable
      // video) after a long delay. Other plugins and the local-library copy still
      // serve as real fallbacks.

      // Build one resolver-chain entry for a user-configured stream resolver.
      // `videoOnly` marks the "prefer video" pass (below): that entry then
      // accepts ONLY an actual video stream and otherwise misses, so the chain
      // keeps falling through to the track's own source.
      const buildResolverEntry = (sr: StreamResolver, videoOnly: boolean): ResolverEntry => {
        // A plugin resolver streams from its own plugin; the built-in Library
        // resolver streams from whatever the matched row points at (file/subsonic/
        // plugin), so it's classified from the resolved URL inside resolve().
        const isBuiltinLibrary = sr.source === "built-in";
        const entry: ResolverEntry = {
          name: sr.name,
          id: sr.id,
          sourceUrl: null,
          effectiveSource: isBuiltinLibrary ? null : { kind: "plugin", pluginId: sr.source },
          videoFirst: videoOnly,
          resolve: async () => {
            const result = await Promise.race([
              sr.resolve(track.title, track.artist_name, track.album_title, track.duration_secs ?? null),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000)),
            ]);
            if (!result) throw new Error("No result");
            // Prefer-video pass: only an actual video stream counts. A resolver
            // that ignored the hint (returned audio, or found nothing playable
            // as video) is a miss here, so the track keeps falling through to
            // its own source and plays as audio.
            if (videoOnly && !result.video) throw new Error("No video stream");
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
              entry.fellBackToAudio = true;
            }
            if (isBuiltinLibrary) entry.effectiveSource = classifyEffectiveSource(result.url, ownerRef.current);
            // In the prefer-video pass we've confirmed a video result, so resolve
            // the URL as video (drives split-stream selection for the native engine).
            return resolveUrlDetailed(result.url, videoOnly ? true : isVideoTrack(track));
          },
        };
        return entry;
      };

      // Append user-configured stream resolvers as fallbacks.
      for (const sr of streamResolversRef.current) {
        if (nativeSchemeOwner && sr.source === nativeSchemeOwner) continue;
        chain.push(buildResolverEntry(sr, false));
      }

      // "Prefer video": with the toggle on, try the plugin stream resolvers for
      // an actual video stream BEFORE the track's own (audio) source — for every
      // track that isn't already a video (queued audio tracks + auto-continue
      // picks). Only a video result wins; if none is found the chain falls
      // through to the normal source and the track plays as audio, unchanged.
      // The built-in Library resolver is skipped (it's a local-copy source, not
      // a video source), and a plugin that owns the track's own scheme is
      // skipped (its by-id entry already ran / would just re-search).
      let triedVideoFirst = false;
      if (preferVideoRef.current && !isVideoTrack(track)) {
        const videoFirst: ResolverEntry[] = [];
        for (const sr of streamResolversRef.current) {
          if (sr.source === "built-in") continue;
          if (nativeSchemeOwner && sr.source === nativeSchemeOwner) continue;
          videoFirst.push(buildResolverEntry(sr, true));
        }
        chain.unshift(...videoFirst);
        triedVideoFirst = videoFirst.length > 0;
      }

      if (chain.length === 0) {
        throw new Error("Couldn't find a playable source for this track");
      }

      let lastError: string | null = null;
      // The raw throw from the last resolver that failed. Kept only to bucket
      // the failure for telemetry — `lastError` above is a display label, so
      // by the time the chain is exhausted the actual cause is otherwise gone.
      let lastThrown: unknown = null;
      const failures: ChainFailure[] = [];
      for (const entry of chain) {
        if (!preload && resolveGenerationRef.current !== generation) return { src: "" };
        if (lastError || chain.length > 1) {
          setResolvingStatus({ key: track.key, error: lastError, trying: entry.name });
        }
        try {
          const { src, engineSource } = await entry.resolve();
          if (!preload && resolveGenerationRef.current !== generation) return { src: "" };
          setResolvingStatus(null);
          // Resolved successfully — clear any prior persistent failure for this track.
          setResolveFailures(prev => {
            if (!(track.key in prev)) return prev;
            const next = { ...prev };
            delete next[track.key];
            return next;
          });
          const meta: ResolvedSource = { name: entry.name, url: src, sourceUrl: entry.sourceUrl, id: entry.id, effectiveSource: entry.effectiveSource ?? { kind: "direct-url", uri: src } };
          setResolvedSource(meta);
          if (entry.fellBackToAudio) {
            // The user asked for VIDEO and silently got audio — say why, or
            // "all my videos play as audio" reads as a bug instead of a fallback.
            notify(`Video source unavailable — playing the audio copy from ${entry.name}.`);
          } else if (triedVideoFirst && !entry.videoFirst) {
            // "Prefer video" was on but no resolver had a video for this track,
            // so the chain fell through to its own audio source. Say so, or the
            // silent audio playback reads as "prefer video did nothing".
            notify("No video found — playing audio.");
          }
          if (lastError) {
            console.debug(`Playing from ${entry.name} (original unavailable)`);
          }
          return { src, patch: entry.patch, engineSource, meta };
        } catch (e) {
          console.error(`Stream resolver "${entry.name}" failed:`, e);
          lastError = entry.failureLabel ?? entryFailureLabel(entry.name);
          lastThrown = e;
          failures.push({ name: entry.name, native: entry.native, label: entry.failureLabel });
          continue;
        }
      }

      if (preload || resolveGenerationRef.current === generation) {
        setResolvingStatus(null);
      }
      // Record a persistent failure for this track so the queue row keeps
      // explaining what happened even after playback moves to another track.
      // Blamed on the track's own source, not the last fallback resolver tried.
      setResolveFailures(prev => ({ ...prev, [track.key]: describeChainFailure(failures) }));
      // `providers_tried` separates "no resolver could play it" from "nothing
      // even offered to try", which are different bugs with the same symptom.
      trackTelemetry("stream_resolve_failed", {
        source: sourceClass(track.path),
        error_kind: classifyErrorKind(lastThrown),
        providers_tried: chain.length,
      });
      throw new Error("Couldn't find a playable source for this track");
    };

    // Public resolver: single-flight in-flight dedup + short-TTL success cache,
    // both keyed by QueueTrack.key. Concurrent callers (a play + the per-tick
    // video pre-resolve) share one promise; rapid sequential re-entries (the
    // engine-error → handlePlay fallback, the preload guard resetting on every
    // handlePlay) reuse the just-resolved src instead of shelling out to yt-dlp
    // again for the same track.
    resolveTrackSrcRef.current = async (track, opts) => {
      const preload = !!opts?.preload;
      const key = track.key;

      const cached = resolveCacheRef.current.get(key);
      if (cached) {
        if (Date.now() - cached.at < RESOLVE_CACHE_TTL_MS && cached.resolved.src) {
          // A cache hit skips doResolve, which is what normally writes the
          // now-playing source UI — replay those side effects for a real play so
          // the source/quality label still updates. Preload must not touch the
          // playing track's UI.
          if (!preload) {
            setResolvingStatus(null);
            setResolvedSource(cached.meta);
            setResolveFailures(prev => {
              if (!(key in prev)) return prev;
              const next = { ...prev };
              delete next[key];
              return next;
            });
          }
          return cached.resolved;
        }
        resolveCacheRef.current.delete(key);
      }

      const existing = inFlightResolvesRef.current.get(key);
      if (existing) return existing;

      const promise = (async () => {
        const out = await doResolve(track, preload);
        if (out.src) {
          if (resolveCacheRef.current.size >= RESOLVE_CACHE_MAX) resolveCacheRef.current.clear();
          resolveCacheRef.current.set(key, {
            at: Date.now(),
            resolved: { src: out.src, patch: out.patch, engineSource: out.engineSource },
            meta: out.meta ?? null,
          });
        }
        return { src: out.src, patch: out.patch, engineSource: out.engineSource };
      })().finally(() => {
        inFlightResolvesRef.current.delete(key);
      });
      inFlightResolvesRef.current.set(key, promise);
      return promise;
    };
  }, [resolveTrackSrcRef, transcodeSessionRef, resolveStreamByUriRef, streamResolversRef, preferVideoRef]);

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
