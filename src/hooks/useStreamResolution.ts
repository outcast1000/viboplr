import { useState, useRef, useEffect, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { consumeResolveStale, streamLadderStep } from "../playback/playbackRetry";
import type { QueueTrack, ResolvedTrackSource, ResolvedSource, EngineSource } from "../types";
import { parseUrlScheme, classifyEffectiveSource, nativeResolverName, type EffectiveSource } from "../queueEntry";
import { isVideoTrack, videoContainerFromPath } from "../utils";
import { selectStream, selectedNeedsClassifying } from "../playback/selectStream";
import type { StreamCandidate } from "../types/plugin";
import { type StreamResolver } from "../streamResolvers";
import { track as trackTelemetry, sourceClass } from "../telemetry";
import { classifyErrorKind } from "../utils/errorKind";
import {
  CHAIN_EXHAUSTED_MESSAGE,
  mergeTrackFailure,
  type ResolverAttempt,
  type TrackFailure,
} from "../playback/trackFailures";

import { useAssignRef } from "./useLatestRef";
import type { Notify } from "./useToasts";

/** Reuse a just-resolved src for the SAME track within this window instead of
 *  hitting the resolver again. Short, because remote stream URLs (e.g.
 *  googlevideo) are short-lived — long enough to absorb the play + preload +
 *  fallback burst for one track, not so long that a genuinely new play reuses a
 *  dead URL. */
const RESOLVE_CACHE_TTL_MS = 12000;
const RESOLVE_CACHE_MAX = 64;

/** After a resolve throws, PRELOADS of the same entry fail fast for this long
 *  instead of re-running the chain. Failures weren't cached at all, and the
 *  progress machine re-asks for a preload on every tick of its 45s lead window
 *  while nothing is armed — so one unplayable next track meant ~25 back-to-back
 *  yt-dlp searches. Time-bounded rather than reset by hand: no hand-off
 *  (gapless, crossfade, engine swap) has to remember to clear it, and a
 *  transient failure still gets another try inside the window. A real play
 *  never reads it. */
const RESOLVE_FAILURE_TTL_MS = 15000;

/** Identity of a failed resolve: the queue key plus the metadata the resolvers
 *  search by, so an "Edit info…" fix to the entry earns a fresh try at once. */
function resolveFailureId(track: QueueTrack): string {
  return [track.key, track.title, track.artist_name ?? "", track.album_title ?? ""].join("\u0000");
}

/** How long one metadata stream resolver gets before the chain moves on. */
const RESOLVER_TIMEOUT_MS = 60000;
const RESOLVER_TIMED_OUT = Symbol("resolver-timed-out");

/** A metadata resolver that answered nothing or ran out of time — as opposed
 *  to one that threw. Carries which, so the failure label can say so. */
class ResolverMiss extends Error {
  constructor(readonly reason: "miss" | "timeout", message: string) {
    super(message);
  }
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
  /** How a fallback resolver failed: it answered nothing (`miss`), ran past
   *  the chain's per-resolver timeout (`timeout`), or threw (`error`). */
  reason?: "miss" | "timeout" | "error";
  /** A prefer-video pass entry. Its miss only means "no video", which says
   *  nothing about why the track couldn't play at all. */
  videoFirst?: boolean;
}

/** Wording for one failed fallback resolver, by how it failed. */
function fallbackFailureLabel(f: ChainFailure): string {
  if (f.name === "Library") return entryFailureLabel(f.name);
  if (f.reason === "miss") return `${f.name} found no match`;
  if (f.reason === "timeout") return `${f.name} timed out`;
  return `${f.name} failed`;
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
  // A native entry with a known-up-front label is a scheme nothing can play by
  // id (a spotify:// row): it was never going to work, so it isn't the cause.
  // When a plugin fallback (yt-dlp) actually tried, ITS outcome is the news —
  // blaming the unplayable link hid a live yt-dlp miss or timeout behind "No
  // installed plugin can play spotify:// links". With only the Library lookup
  // behind it, that label is the honest answer and stays.
  if (native.label) {
    const fallbacks = failures.filter((f) => !f.native && !f.videoFirst);
    if (fallbacks.some((f) => f.name !== "Library")) return fallbacks.map(fallbackFailureLabel).join(" · ");
    return native.label;
  }
  return entryFailureLabel(native.name);
}

/**
 * Build the `http` engine source for a direct URL, attaching request headers
 * only when there are any to attach.
 *
 * The emptiness check keeps the source honest: `{ headers: {} }` would claim
 * this stream carries request headers when the resolver reported none. The
 * engine treats both the same these days (`apply_http_headers` clears the
 * deck's `http-header-fields` before applying whatever is passed, absent or
 * empty), so this is about the `EngineSource` reading truthfully, not about
 * engine behavior. Only `StreamResolveResult.headers` reaches this; the
 * candidate path carries its own per-stream headers through `selectStream`.
 */
export function httpEngineSource(url: string, headers?: Record<string, string>): EngineSource {
  return headers && Object.keys(headers).length > 0
    ? { kind: "http", url, headers }
    : { kind: "http", url };
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
  /** Created in App; kept fresh here from `resolveStreamByUri`. */
  resolveStreamByUriRef: React.MutableRefObject<(scheme: string, id: string, quality?: string | null, opts?: { externalAudio?: boolean; fresh?: boolean; video?: boolean }) => Promise<{ url: string; candidates?: StreamCandidate[]; sourceUrl?: string }>>;
  /** Ordered, user-configured plugin stream resolvers (populated elsewhere in App). */
  streamResolversRef: React.MutableRefObject<StreamResolver[]>;
  /** Latest plugin stream-URI resolver (`plugins.resolveStreamByUri`). */
  resolveStreamByUri: (scheme: string, id: string, quality?: string | null, opts?: { externalAudio?: boolean; fresh?: boolean; video?: boolean }) => Promise<{ url: string; candidates?: StreamCandidate[]; sourceUrl?: string }>;
  /** Maps a custom URL scheme to its owning plugin id (`plugins.streamUriResolverOwner`).
   *  Lets a native plugin scheme (e.g. `tidal://`) classify to `{ kind: "plugin", pluginId }`. */
  streamUriResolverOwner: (scheme: string) => string | null;
  /** Plugin id → manifest name (`plugins.pluginNames`). Used only to name the
   *  native entry for a plugin scheme, so the source panel says "yt-dlp" rather
   *  than the capitalized protocol ("Ytdlp"). */
  pluginNames: Map<string, string>;
  /** True when the engine renders video (macOS and Windows). Video sources
   * are then asked for split streams the engine can merge. */
  useNativeVideoRef: React.MutableRefObject<boolean>;
  /** True when the user's "Prefer video" toggle is on. When set, every track
   * that isn't already a video is run through the stream resolvers (library
   * video copies included) for a video stream BEFORE its own (audio) source —
   * a video result plays in the theater, otherwise it falls through to normal
   * audio playback. */
  preferVideoRef: React.MutableRefObject<boolean>;
  /** Current queue — drives pruning of stale per-track resolve failures. */
  queue: QueueTrack[];
  /** Currently-playing track — whose source `resolvedSource` reports. */
  currentTrack: QueueTrack | null;
  /** Transient toast — surfaces silent fallbacks (video → library audio copy). */
  notify: Notify;
  /** A resolve revealed the track's real container (`patch.format`) — e.g. a
   * plugin-scheme URI with no extension (`qbt://<hash>/<n>`) that landed on a
   * video file. The patch otherwise only enriches `currentTrack`, so the queue
   * entry never learns it is a video and its row keeps the audio-disc icon.
   * Format ONLY — a resolve patch can also carry `path` (a local-copy
   * fallback), and rewriting an entry's source would change what
   * delete/download/export act on. `localPath` is where the resolution landed
   * on THIS disk (from the attributed file:// sourceUrl), or null — it lets the
   * caller grab a video frame for the queue row's thumb. */
  onTrackFormatResolved?: (key: string, format: string, localPath: string | null) => void;
}

/**
 * The playback source-resolution engine: builds the `resolveTrackSrcRef` resolver
 * chain (native scheme → user-ordered stream resolvers, where the built-in
 * Library resolver — serving local and network copies — sits first by default),
 * and tracks per-track resolve status + persistent failures. Extracted out of
 * App.tsx; the refs it drives are created
 * there (so `usePlayback` can consume them) and passed in here.
 *
 * Returns the render-facing resolution state.
 */
/**
 * What a native-scheme resolution should be attributed to, or null to keep the
 * entry's existing attribution (the track's own URI).
 *
 * A resolver's reported `sourceUrl` always wins — only it knows the page behind
 * an opaque id. But when it reports nothing and the resolution landed on a
 * **file**, the host already knows the answer: the engine source carries the
 * path. Deriving it here is what makes a plugin scheme that plays a local file
 * (qbt://…) show that path — with Open folder, and with the tag reader able to
 * state the file's real bit depth — instead of echoing its own unreadable URI.
 *
 * That matters because the plugin's own reporting is version-gated (an object
 * candidate breaks pre-1.0.28 hosts), so on any older build there is no
 * `sourceUrl` to read and the panel had nothing but the URI. The host needs no
 * gate: it is holding the resolved path either way.
 *
 * Pure + exported for tests.
 */
export function attributedSourceUrl(
  reported: string | undefined,
  engineSource: EngineSource | null,
): string | null {
  if (reported) return reported;
  if (engineSource?.kind === "file" && engineSource.path) return `file://${engineSource.path}`;
  return null;
}

export function useStreamResolution({
  resolveTrackSrcRef,
  resolveStreamByUriRef,
  streamResolversRef,
  resolveStreamByUri,
  streamUriResolverOwner,
  pluginNames,
  useNativeVideoRef,
  preferVideoRef,
  queue,
  currentTrack,
  notify,
  onTrackFormatResolved,
}: UseStreamResolutionDeps) {
  const [resolvingStatus, setResolvingStatus] = useState<{ key: string; error: string | null; trying: string | null } | null>(null);
  // Persistent per-track failures, keyed by QueueTrack.key — both stages (see
  // playback/trackFailures.ts). Survives track changes so the failed row keeps
  // explaining what happened. A `resolve` failure clears on a later successful
  // resolve; a `playback` one only once the engine actually plays the entry
  // (`clearTrackFailure`), since a resolve is exactly what preceded it.
  const [trackFailures, setTrackFailures] = useState<Record<string, TrackFailure>>({});
  const clearResolveStageFailure = useCallback((key: string) => {
    setTrackFailures(prev => {
      if (prev[key]?.stage !== "resolve") return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);
  // The chain's last walk per entry — what a playback failure reports as "what
  // was tried" (the walk that found the source the engine then refused).
  const attemptsByKeyRef = useRef<Map<string, ResolverAttempt[]>>(new Map());
  // The winning source per track, keyed by QueueTrack.key. The now-playing UI
  // reads the CURRENT track's entry (`resolvedSource` below), so a preload of the
  // next track can record its answer early without relabelling the one playing —
  // and when that preloaded track takes over (handlePlay reusing the preload, or
  // a gapless/crossfade hand-off that resolves nothing), its source is already here.
  const [sourcesByKey, setSourcesByKey] = useState<Record<string, ResolvedSource | null>>({});
  const setResolvedSource = useCallback((key: string, meta: ResolvedSource | null | undefined) => {
    setSourcesByKey(prev => {
      if (meta === undefined) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev[key] === meta ? prev : { ...prev, [key]: meta };
    });
  }, []);
  const resolvedSource = currentTrack ? sourcesByKey[currentTrack.key] ?? null : null;
  const sourcesByKeyRef = useRef(sourcesByKey);
  useAssignRef(sourcesByKeyRef, sourcesByKey);
  const resolveGenerationRef = useRef(0);

  // Single-flight + short-TTL success cache for track resolution, both keyed by
  // QueueTrack.key. Collapses the redundant slow-resolver (yt-dlp) calls that
  // otherwise fire for the SAME track when several paths resolve it at once or
  // in quick succession (a play, the per-tick video pre-resolve, and the
  // engine-error → handlePlay retry).
  const inFlightResolvesRef = useRef<Map<string, Promise<ResolvedTrackSource>>>(new Map());
  const resolveCacheRef = useRef<Map<string, { at: number; resolved: ResolvedTrackSource; meta: ResolvedSource | null }>>(new Map());
  // Negative counterpart, read by preloads only — see RESOLVE_FAILURE_TTL_MS.
  // Keyed by QueueTrack.key; the entry's `id` carries the metadata it failed with.
  const resolveFailedRef = useRef<Map<string, { at: number; id: string }>>(new Map());
  // "The last source for this key failed to play", and how far down the stream
  // ladder to pick next, both live in the shared `playbackRetry` store (written
  // by usePlayback on its way into the replay — see that module for why it isn't
  // derived from the engine-error event here).

  // Scheme→owner lookup, read inside the build-once resolver. Kept fresh in a ref
  // so the chain always sees the current plugin set without rebuilding.
  const ownerRef = useRef(streamUriResolverOwner);
  useAssignRef(ownerRef, streamUriResolverOwner);

  // Scheme → owning plugin's display name, for the same reason and read from the
  // same build-once resolver. Null when nothing owns the scheme, which leaves
  // `nativeResolverName` on its capitalized-protocol fallback.
  const pluginNamesRef = useRef(pluginNames);
  useAssignRef(pluginNamesRef, pluginNames);

  // Read inside the build-once resolver, like the refs above.
  const onTrackFormatResolvedRef = useRef(onTrackFormatResolved);
  useAssignRef(onTrackFormatResolvedRef, onTrackFormatResolved);
  const schemeDisplayName = (protocol: string): string | null => {
    const owner = ownerRef.current(protocol);
    return owner ? pluginNamesRef.current.get(owner) ?? null : null;
  };

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
    // `headers` applies to a DIRECT http(s) url only, and is deliberately not
    // forwarded into the recursive branches below: a `plugin://` url resolves to
    // its own candidates, each carrying the headers for the stream it names, and
    // a `file://` path has none. Forwarding would attach one stream's signed
    // headers to a different stream's request.
    const resolveUrlDetailed = (
      url: string,
      videoTrack = false,
      headers?: Record<string, string>,
      fresh = false,
      ladderStep = 0,
      // `sourceUrl` rides back out because only the resolver knows it: a plugin
      // scheme is an opaque id, so without this the chain can only attribute the
      // track to its own URI. The caller lifts it onto the chain entry, exactly
      // as the metadata path does with `StreamResolveResult.sourceUrl`.
    ): Promise<{ src: string; engineSource: EngineSource | null; sourceUrl?: string }> => {
      if (url.startsWith("http://") || url.startsWith("https://")) {
        return Promise.resolve({ src: url, engineSource: httpEngineSource(url, headers) });
      }
      const parsed = parseUrlScheme(url);
      if (parsed.scheme === "file") {
        return Promise.resolve({ src: convertFileSrc(parsed.path), engineSource: { kind: "file", path: parsed.path } });
      }
      if (parsed.scheme === "plugin") {
        // When the engine renders this as video it can attach a separate audio
        // stream, so hint the resolver to offer split candidates and let
        // selectStream pick a hi-res video-only + audio-only pair.
        const externalAudio = videoTrack && useNativeVideoRef.current;
        // `video` carries the request's intent now that a plugin ref no longer
        // encodes it in the URI (the ytdlp ".mp4" suffix is legacy): the track
        // classified as video — via PluginTrack.kind or a persisted format — so
        // the resolver must serve video, muxed when the engine can't merge.
        const opts = externalAudio || fresh || videoTrack ? { externalAudio, fresh, video: videoTrack } : undefined;
        return resolveStreamByUriRef.current(parsed.protocol, parsed.id, null, opts).then(r => {
          if (r.candidates && r.candidates.length) {
            const sel = selectStream(r.candidates, { video: videoTrack, skipTopVideo: ladderStep });
            if (sel) {
              // A candidate is just a URL, and not every plugin scheme resolves
              // to the network — one may name a file already on this disk (the
              // qBittorrent plugin's `qbt://` does). Classify it like any other
              // URL rather than assuming http, or mpv is told a local file is a
              // network stream.
              // Only the split-stream case has to stay here, because `audioUrl`
              // and `headers` have nowhere to ride through the recursion.
              if (selectedNeedsClassifying(sel)) {
                return resolveUrlDetailed(sel.url, videoTrack, sel.headers, fresh, ladderStep)
                  .then(inner => (r.sourceUrl ? { ...inner, sourceUrl: r.sourceUrl } : inner));
              }
              return { src: sel.url, engineSource: { kind: "http" as const, url: sel.url, audioUrl: sel.audioUrl, headers: sel.headers }, sourceUrl: r.sourceUrl };
            }
          }
          // Falling through to the self-contained URL must not drop the
          // attribution the resolver just gave us — same track, same page.
          return resolveUrlDetailed(r.url, videoTrack, undefined, fresh, ladderStep)
            .then(inner => (r.sourceUrl ? { ...inner, sourceUrl: r.sourceUrl } : inner));
        });
      }
      if (parsed.scheme === "subsonic") {
        return invoke<string>("resolve_subsonic_location", { location: url })
          .then(streamUrl => ({ src: streamUrl, engineSource: { kind: "http" as const, url: streamUrl } }));
      }
      return Promise.reject(new Error(`Unplayable URL scheme: ${url}`));
    };

    // Core resolution. `preload` runs it OFF the shared play-resolution
    // generation lane: pre-resolving the next track must not bump the counter,
    // or the currently-playing track's in-flight resolve returns the empty-src
    // sentinel and handlePlay "retries" it — firing yt-dlp again. Preload
    // results are still deduped/cached by the public wrapper below.
    const doResolve = async (
      track: QueueTrack,
      preload: boolean,
      // The previous answer for this track failed to play: bypass every cache on
      // the way down, including the resolving plugin's own.
      fresh: boolean,
    ): Promise<ResolvedTrackSource & { meta?: ResolvedSource | null }> => {
      // How many failed native attempts this track has already had — each one
      // steps the video pick down a rung (see playbackRetry).
      const ladderStep = streamLadderStep(track.key);
      const generation = preload ? -1 : ++resolveGenerationRef.current;
      // A real play re-resolving this track reads "unknown" until it answers; a
      // preload leaves whatever is known alone.
      if (!preload) setResolvedSource(track.key, undefined);
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

      // Native resolver first (if track has a known URL)
      if (url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          chain.push({ name: "Direct URL", id: null, native: true, sourceUrl: url, effectiveSource: classifyEffectiveSource(url, ownerRef.current), resolve: () => Promise.resolve({ src: url, engineSource: { kind: "http" as const, url } }) });
        } else {
          // Held in a variable rather than pushed inline so `resolve` can lift a
          // reported `sourceUrl` onto it — the same mutation the metadata-resolver
          // entry does below. `sourceUrl` starts as the track's own URI, which is
          // the honest answer for `file://` / `subsonic://` but only a placeholder
          // for a plugin scheme: an id like `ytdlp://https%3A%2F%2F…` names no page
          // a user can read or open, and only the resolver knows what it stands for.
          const nativeEntry: ResolverEntry = {
            name: nativeResolverName(url, schemeDisplayName),
            id: null,
            native: true,
            failureLabel: nativeFailureLabel,
            sourceUrl: url,
            effectiveSource: classifyEffectiveSource(url, ownerRef.current),
            resolve: async () => {
              const resolved = await resolveUrlDetailed(url, isVideoTrack(track), undefined, fresh, ladderStep);
              const attributed = attributedSourceUrl(resolved.sourceUrl, resolved.engineSource);
              if (attributed) nativeEntry.sourceUrl = attributed;
              // The resolution named a real file — let IT decide the surface, not
              // the opaque URI. A plugin scheme carries no extension, so a
              // downloaded video reached playWithSrc classified as audio and
              // played through the <audio> element: sound, no picture. Same
              // channel the prefer-video pass uses below (`patch: { format }`),
              // and `format` is authoritative in isVideoTrack, so this flips the
              // track before any element or engine is chosen (handlePlay merges
              // the patch, then playWithSrc routes).
              //
              // Deliberately only ADDS a classification: gated on the track not
              // already being video, and videoContainerFromPath ignores audio
              // containers, so a track whose format is already known keeps it.
              // That preserves "a known format is authoritative" — a real audio
              // file must not be reclassified by a misleading name.
              //
              // Needs no cooperation from the plugin: attributedSourceUrl derives
              // `file://<engineSource.path>` when the resolver reported no
              // sourceUrl, so this works on plugins that shipped before any of it.
              if (!isVideoTrack(track)) {
                const container = videoContainerFromPath(attributed);
                if (container) nativeEntry.patch = { ...nativeEntry.patch, format: container };
              }
              return resolved;
            },
          };
          chain.push(nativeEntry);
        }
      }

      // Library copies (local file or network) are served by the built-in
      // "Library" entry in the user-ordered resolver list below — first by
      // default, so behind the track's own source and ahead of the plugin
      // resolvers. There is deliberately no pinned pre-chain library entry any
      // more: it duplicated the same metadata lookup with subtly different
      // rules (local-file-only, kind-strict), and its one real safeguard — the
      // `file_exists` check that lets a row whose file is gone fall through —
      // now lives in the Library resolver itself, which walks every copy of
      // the match (local first, then network) instead of only the preferred
      // one. Playing the exact thing the user clicked still outranks a fuzzy
      // title+artist match, because the native entry above stays first.

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
        // What this entry is being asked to produce. The prefer-video pass is
        // asking for video on a track that isn't one yet, so `videoOnly` has to
        // count here as well as the track's own kind.
        const asVideo = videoOnly || isVideoTrack(track);
        // Same condition as the by-URI path in resolveUrlDetailed: only the
        // native engine rendering video can merge a separate audio stream.
        const externalAudio = asVideo && useNativeVideoRef.current;
        const entry: ResolverEntry = {
          name: sr.name,
          id: sr.id,
          sourceUrl: null,
          effectiveSource: isBuiltinLibrary ? null : { kind: "plugin", pluginId: sr.source },
          videoFirst: videoOnly,
          resolve: async () => {
            const result = await Promise.race([
              sr.resolve(track.title, track.artist_name, track.album_title, track.duration_secs ?? null, { externalAudio, fresh, preferVideo: videoOnly }),
              new Promise<typeof RESOLVER_TIMED_OUT>((resolve) => setTimeout(() => resolve(RESOLVER_TIMED_OUT), RESOLVER_TIMEOUT_MS)),
            ]);
            if (result === RESOLVER_TIMED_OUT) throw new ResolverMiss("timeout", `Timed out after ${RESOLVER_TIMEOUT_MS / 1000}s`);
            if (!result) throw new ResolverMiss("miss", "No result");
            // Prefer-video pass: only an actual video stream counts. A resolver
            // that ignored the hint (returned audio, or found nothing playable
            // as video) is a miss here, so the track keeps falling through to
            // its own source and plays as audio.
            if (videoOnly && !result.video) throw new ResolverMiss("miss", "No video stream");
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
            if (isBuiltinLibrary) {
              entry.effectiveSource = classifyEffectiveSource(result.url, ownerRef.current);
              // A local library match carries the file's path + real format so
              // the play path can enrich `currentTrack` (Show in folder, the
              // tag/audio-props probe) and re-classify a path-less track from
              // the copy that actually plays. The row's real container also
              // outranks the hardcoded "mp4" the video branch above guessed.
              if (result.url.startsWith("file://")) {
                entry.patch = {
                  ...entry.patch,
                  path: result.url,
                  ...(result.format ? { format: result.format } : {}),
                };
              }
            }
            // A resolver that enumerated the source's streams gets the same
            // treatment as the by-URI path: the host picks per its active engine,
            // so a native video play can take a hi-res video-only stream plus a
            // companion audio one instead of the single self-contained stream
            // `url` has to be (360p, on YouTube). `url` remains the fallback for
            // a candidate list nothing in it suits.
            if (result.candidates?.length) {
              const sel = selectStream(result.candidates, { video: asVideo, skipTopVideo: ladderStep });
              if (sel) {
                return { src: sel.url, engineSource: { kind: "http" as const, url: sel.url, audioUrl: sel.audioUrl, headers: sel.headers } };
              }
            }
            // In the prefer-video pass we've confirmed a video result, so resolve
            // the URL as video (drives split-stream selection for the native engine).
            const resolved = await resolveUrlDetailed(result.url, asVideo, result.headers, fresh, ladderStep);
            // Same attribution as the native-scheme entry: a resolver that
            // answered with a `file://` and reported no sourceUrl is playing a
            // real file, so the source panel shows its path + Open folder
            // instead of the `asset.localhost` hostname convertFileSrc minted
            // (the Soulseek playback fallback answers exactly this way).
            if (!entry.sourceUrl) {
              const attributed = attributedSourceUrl(undefined, resolved.engineSource);
              if (attributed) entry.sourceUrl = attributed;
            }
            return resolved;
          },
        };
        return entry;
      };

      // Append user-configured stream resolvers as fallbacks.
      for (const sr of streamResolversRef.current) {
        if (nativeSchemeOwner && sr.source === nativeSchemeOwner) continue;
        chain.push(buildResolverEntry(sr, false));
      }

      // "Prefer video": with the toggle on, try the stream resolvers for an
      // actual video stream BEFORE the track's own (audio) source — for every
      // track that isn't already a video (queued audio tracks + auto-continue
      // picks). Only a video result wins; if none is found the chain falls
      // through to the normal source and the track plays as audio, unchanged.
      // The built-in Library resolver participates: `preferVideo` on its
      // `resolve` opts makes it consider only VIDEO copies of the match, so a
      // user's own music-video file (first in the default order) beats
      // fetching one from the network — and with no video copy it answers
      // null and the pass moves on. A plugin that owns the track's own scheme
      // is skipped (its by-id entry already ran / would just re-search).
      let triedVideoFirst = false;
      if (preferVideoRef.current && !isVideoTrack(track)) {
        const videoFirst: ResolverEntry[] = [];
        for (const sr of streamResolversRef.current) {
          if (nativeSchemeOwner && sr.source === nativeSchemeOwner) continue;
          videoFirst.push(buildResolverEntry(sr, true));
        }
        chain.unshift(...videoFirst);
        triedVideoFirst = videoFirst.length > 0;
      }

      if (chain.length === 0) {
        throw new Error(CHAIN_EXHAUSTED_MESSAGE);
      }

      let lastError: string | null = null;
      // The raw throw from the last resolver that failed. Kept only to bucket
      // the failure for telemetry — `lastError` above is a display label, so
      // by the time the chain is exhausted the actual cause is otherwise gone.
      let lastThrown: unknown = null;
      const failures: ChainFailure[] = [];
      const attempts: ResolverAttempt[] = [];
      for (const entry of chain) {
        if (!preload && resolveGenerationRef.current !== generation) return { src: "" };
        if (lastError || chain.length > 1) {
          setResolvingStatus({ key: track.key, error: lastError, trying: entry.name });
        }
        try {
          const { src, engineSource } = await entry.resolve();
          if (!preload && resolveGenerationRef.current !== generation) return { src: "" };
          setResolvingStatus(null);
          attempts.push({ name: entry.name, outcome: "found" });
          attemptsByKeyRef.current.set(track.key, attempts);
          // Resolved — a "no source" note is now wrong. A playback-stage note
          // stays until the engine actually plays it.
          clearResolveStageFailure(track.key);
          const meta: ResolvedSource = { name: entry.name, url: src, sourceUrl: entry.sourceUrl, id: entry.id, effectiveSource: entry.effectiveSource ?? { kind: "direct-url", uri: src } };
          setResolvedSource(track.key, meta);
          if (entry.fellBackToAudio) {
            // The user asked for VIDEO and silently got audio — say why, or
            // "all my videos play as audio" reads as a bug instead of a fallback.
            notify(`Video source unavailable — playing the audio copy from ${entry.name}.`, { kind: "warning" });
          } else if (triedVideoFirst && !entry.videoFirst) {
            // "Prefer video" was on but no resolver had a video for this track,
            // so the chain fell through to its own audio source. Say so, or the
            // silent audio playback reads as "prefer video did nothing".
            notify("No video found — playing audio.", { kind: "warning" });
          }
          if (lastError) {
            console.debug(`Playing from ${entry.name} (original unavailable)`);
          }
          return { src, patch: entry.patch, engineSource, meta };
        } catch (e) {
          console.error(`Stream resolver "${entry.name}" failed:`, e);
          lastError = entry.failureLabel ?? entryFailureLabel(entry.name);
          lastThrown = e;
          attempts.push({
            name: entry.name,
            outcome: e instanceof ResolverMiss
              ? (entry.videoFirst && e.reason === "miss" ? "no-video" : e.reason)
              : "error",
            detail: e instanceof ResolverMiss && e.reason === "miss" ? null : e instanceof Error ? e.message : String(e),
          });
          failures.push({
            name: entry.name,
            native: entry.native,
            label: entry.failureLabel,
            reason: e instanceof ResolverMiss ? e.reason : "error",
            videoFirst: entry.videoFirst,
          });
          continue;
        }
      }

      if (preload || resolveGenerationRef.current === generation) {
        setResolvingStatus(null);
      }
      // Record a persistent failure for this track so the queue row keeps
      // explaining what happened even after playback moves to another track.
      // Blamed on the track's own source, not the last fallback resolver tried.
      attemptsByKeyRef.current.set(track.key, attempts);
      const failure: TrackFailure = { stage: "resolve", summary: describeChainFailure(failures), at: Date.now(), attempts };
      setTrackFailures(prev => ({ ...prev, [track.key]: failure }));
      // `providers_tried` separates "no resolver could play it" from "nothing
      // even offered to try", which are different bugs with the same symptom.
      trackTelemetry("stream_resolve_failed", {
        source: sourceClass(track.path),
        error_kind: classifyErrorKind(lastThrown),
        providers_tried: chain.length,
      });
      throw new Error(CHAIN_EXHAUSTED_MESSAGE);
    };

    // Public resolver: single-flight in-flight dedup + short-TTL success cache,
    // both keyed by QueueTrack.key. Concurrent callers (a play + the per-tick
    // video pre-resolve) share one promise; rapid sequential re-entries (the
    // engine-error → handlePlay retry, the preload guard resetting on every
    // handlePlay) reuse the just-resolved src instead of shelling out to yt-dlp
    // again for the same track.
    resolveTrackSrcRef.current = async (track, opts) => {
      const preload = !!opts?.preload;
      const key = track.key;

      // One-shot: consumed here so the retry re-resolves and a third attempt
      // (which would be re-answering an error we never saw) doesn't.
      const fresh = consumeResolveStale(key);
      if (fresh) {
        resolveCacheRef.current.delete(key);
        resolveFailedRef.current.delete(key);
      }

      if (preload) {
        const failed = resolveFailedRef.current.get(key);
        if (failed && failed.id === resolveFailureId(track) && Date.now() - failed.at < RESOLVE_FAILURE_TTL_MS) {
          // Empty src, not a throw: every preload caller already treats it as
          // "nothing to arm" quietly, and this answers ~4×/s for the whole TTL.
          return { src: "" };
        }
      }

      const cached = fresh ? undefined : resolveCacheRef.current.get(key);
      if (cached) {
        if (Date.now() - cached.at < RESOLVE_CACHE_TTL_MS && cached.resolved.src) {
          // A cache hit skips doResolve, which is what normally writes the
          // now-playing source UI — replay those side effects for a real play so
          // the source/quality label still updates. Preload must not touch the
          // playing track's UI.
          if (!preload) {
            setResolvingStatus(null);
            setResolvedSource(key, cached.meta);
            clearResolveStageFailure(key);
          }
          return cached.resolved;
        }
        resolveCacheRef.current.delete(key);
      }

      // A retry must not join the in-flight resolve it is retrying — that promise
      // is the answer that just failed.
      const existing = fresh ? undefined : inFlightResolvesRef.current.get(key);
      if (existing) return existing;

      const promise = (async () => {
        let out: Awaited<ReturnType<typeof doResolve>>;
        try {
          out = await doResolve(track, preload, fresh);
        } catch (e) {
          if (resolveFailedRef.current.size >= RESOLVE_CACHE_MAX) resolveFailedRef.current.clear();
          resolveFailedRef.current.set(key, { at: Date.now(), id: resolveFailureId(track) });
          throw e;
        }
        resolveFailedRef.current.delete(key);
        // Tell the queue entry its real container (see onTrackFormatResolved).
        // Preloads count too — the next row learning it is a video early is
        // exactly the point.
        if (out.patch?.format) {
          const su = out.meta?.sourceUrl ?? null;
          const localPath = su && su.startsWith("file://") ? su.slice("file://".length) || null : null;
          onTrackFormatResolvedRef.current?.(key, out.patch.format, localPath);
        }
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
  }, [resolveTrackSrcRef, resolveStreamByUriRef, streamResolversRef, preferVideoRef, clearResolveStageFailure]);

  /** The engine gave up on an entry (after its retries) or the play threw.
   *  Attaches what the chain tried and the source the engine was handed. */
  const recordPlaybackFailure = useCallback(
    (key: string, info: { summary: string; engineError?: string | null; tries?: number | null }) => {
      const meta = sourcesByKeyRef.current[key];
      const incoming: TrackFailure = {
        stage: "playback",
        summary: info.summary,
        at: Date.now(),
        attempts: attemptsByKeyRef.current.get(key) ?? [],
        source: meta ? { name: meta.name, url: meta.sourceUrl ?? meta.url ?? null } : null,
        engineError: info.engineError ?? null,
        tries: info.tries ?? null,
      };
      setTrackFailures(prev => {
        const merged = mergeTrackFailure(prev[key], incoming);
        return merged === prev[key] ? prev : { ...prev, [key]: merged };
      });
    },
    [],
  );

  /** The engine is playing this entry — whatever failed before no longer applies. */
  const clearTrackFailure = useCallback((key: string) => {
    setTrackFailures(prev => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Same for the per-track sources — except the playing track's, which is kept
  // even when it has left the queue (a cleared queue keeps playing).
  const currentKey = currentTrack?.key ?? null;
  useEffect(() => {
    setSourcesByKey(prev => {
      const live = new Set(queue.map(t => t.key));
      if (currentKey) live.add(currentKey);
      const stale = Object.keys(prev).filter(k => !live.has(k));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [queue, currentKey]);

  // Prune persistent failures (and the attempt log) for tracks no longer in the
  // queue, so both stay bounded and a recycled key can't inherit a stale error.
  useEffect(() => {
    const live = new Set(queue.map(t => t.key));
    if (currentKey) live.add(currentKey);
    for (const k of attemptsByKeyRef.current.keys()) {
      if (!live.has(k)) attemptsByKeyRef.current.delete(k);
    }
    setTrackFailures(prev => {
      const keys = Object.keys(prev);
      if (keys.length === 0) return prev;
      const stale = keys.filter(k => !live.has(k));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const k of stale) delete next[k];
      return next;
    });
  }, [queue, currentKey]);

  return { resolvingStatus, trackFailures, resolvedSource, recordPlaybackFailure, clearTrackFailure };
}
