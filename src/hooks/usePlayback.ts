import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, ResolvedTrackSource, EngineSource } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { parseUrlScheme, isLocalTrack } from "../queueEntry";
import { store } from "../store";
import { driveProgressMachine } from "../playback/progressMachine";
import { mediaErrorMessage, describePlaybackFailure, probeNetworkStatus } from "../playback/playbackErrors";
import {
  nativeEngine,
  type EnginePositionEvent,
  type EngineDurationEvent,
  type EngineTrackChangedEvent,
  type EngineEndedEvent,
  type EngineStateEvent,
  type EngineErrorEvent,
  type EngineIcyTitleEvent,
} from "../playback/nativeEngine";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { setPlaybackPosition, getPlaybackPosition, subscribePlaybackPosition } from "../playback/positionStore";
import {
  BANDS,
  BAND_Q,
  NUM_BANDS,
  SHELF_BASS_FREQ,
  SHELF_TREBLE_FREQ,
  applyGainsToFilters,
  type EqMode,
} from "../eqPresets";

function logPlayback(message: string) {
  invoke("write_frontend_log", { level: "info", message, section: "playback" }).catch(() => {});
}

// Master-bus limiter ceiling (dBFS) engaged for a simple-mode bass/treble boost.
// The limiter catches boosted peaks ~1 dB below full scale instead of clipping —
// so the boost stays loud rather than dropping the whole signal's level.
const LIMITER_CEILING_DB = -1;

// A play request is "current" only while no later request has started. Used to
// decide whether a caught playback error / loading-state reset belongs to the
// active track or to a superseded one whose play() was aborted by the newer
// request's pause/load. Pure so it can be unit-tested without the hook.
export function isCurrentPlayGeneration(captured: number, current: number): boolean {
  return captured === current;
}

export type HandlePlayOutcome = "play" | "bail" | "retry" | "fail";

// Decides what handlePlay should do once its stream resolution settles.
//
// `resolveTrackSrc` returns an empty-src sentinel whenever ITS resolve generation
// was bumped mid-flight — which happens not only on a newer play but also when a
// concurrent preload/prefetch resolves (or when a reused, already-superseded
// preload promise is awaited). Conflating "empty src" with "I was superseded by a
// newer play" is the bug behind the Next-stops-playback freeze: handlePlay pauses
// the outgoing audio up front, so a silent bail while THIS play is still current
// leaves the player paused with the now-playing bar stuck on the previous track
// and the queue index already advanced — and nothing logged.
//
//  - playStillCurrent=false → a newer handlePlay bumped playGeneration and owns
//    currentTrack; bail silently regardless of src.
//  - has src + still current → play.
//  - empty src + still current → the resolve (not the play) was superseded; no one
//    else will set currentTrack, so recover: re-resolve once (`retry`), then if it
//    is STILL empty surface it via the error path (`fail`) rather than freeze.
export function decideHandlePlayOutcome(
  playStillCurrent: boolean,
  hasSrc: boolean,
  alreadyRetried: boolean,
): HandlePlayOutcome {
  if (!playStillCurrent) return "bail";
  if (hasSrc) return "play";
  return alreadyRetried ? "fail" : "retry";
}

// Decides whether a media `error` event should surface as a user-facing playback
// failure. The error handler is attached to ALL media elements (audio slot A, slot
// B, and the <video>), but only the element currently driving playback represents a
// real failure of the current track. During a track change the outgoing element is
// torn down (pause → removeAttribute("src") → load()) and the inactive audio slot
// may still hold a preloaded source; either can fire a spurious `error` that, if
// surfaced, shows "Playback failed" while the active element plays the new track
// fine. Mirrors getMediaElement(): for a video track the <video> is the active
// surface; otherwise the active audio slot is. Pure so it can be unit-tested.
export function isActiveMediaElement(
  fired: "A" | "B" | "video",
  activeSlot: "A" | "B",
  currentIsVideo: boolean,
): boolean {
  if (fired === "video") return currentIsVideo;
  return !currentIsVideo && fired === activeSlot;
}

// Whether a `timeupdate` may drive the preload→crossfade transition machine. It
// runs only in the settled playing state: the firing element is the active slot
// AND no explicit play (handlePlay/handlePlayUrl) is mid-transition — i.e. between
// "user picked a track" and "the new source is installed and playing". During that
// window the outgoing element can keep firing `timeupdate` (WKWebView does not
// reliably honor pause()), and it is still the active slot because the swap hasn't
// happened yet; letting it start a crossfade hands a fade to a track the incoming
// explicit play doesn't own (the "started at very low volume" bug). Pure so it can
// be unit-tested without the hook.
export function canDriveTransitionMachine(firedIsActive: boolean, transitioning: boolean): boolean {
  return firedIsActive && !transitioning;
}

// Picks the [incoming, outgoing] crossfade gain nodes for the slot that just
// became active. Captured ONCE when a fade starts and reused for every tick — the
// interval must keep ramping the SAME pair even if `activeSlotRef` changes
// underneath it (e.g. an explicit play forces slot A mid-fade). Re-deriving the
// pair from the live ref each tick is what let a stray slot swap pump the incoming
// track's gain down to ~0. Pure/generic so it can be unit-tested with stand-in
// nodes.
export function crossfadeGainPair<T>(activeSlot: "A" | "B", gainA: T, gainB: T): { incoming: T; outgoing: T } {
  return activeSlot === "A" ? { incoming: gainA, outgoing: gainB } : { incoming: gainB, outgoing: gainA };
}

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => QueueTrack | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  trackVideoHistoryRef: React.RefObject<boolean>,
  resolveTrackSrcRef: React.RefObject<(track: QueueTrack) => Promise<ResolvedTrackSource>>,
  prefetchNextRef: React.RefObject<() => void>,
  transcodeSessionRef: React.RefObject<{ sessionId: string; baseUrl: string; durationSecs: number | null; seekOffset: number } | null>,
  // True when the mpv engine is compiled in AND the user selected it in
  // Settings. App owns the capability probe + setting; this ref combines them.
  useNativeEngineRef: React.RefObject<boolean>,
  // True when the engine can also render video natively (macOS full build,
  // engine selected). Gates routing video tracks to the engine.
  useNativeVideoRef: React.RefObject<boolean>,
  // App points this at `() => handleNext("auto")` — the engine-side equivalent
  // of the media elements' `ended` (fires when a native track ends with
  // nothing gapless-armed).
  onNativeAutoEndedRef: React.RefObject<() => void>,
) {
  const [currentTrack, setCurrentTrack] = useState<QueueTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  // The live position deliberately does NOT live in React state — it ticks
  // ~4×/sec and would re-render the whole tree from App down. It goes to the
  // external positionStore instead; display surfaces subscribe individually
  // via usePlaybackPosition().
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [muted, setMuted] = useState(false);
  const [activeSlot, setActiveSlot] = useState<"A" | "B">("A");
  const [eqEnabled, setEqEnabled] = useState(false);
  const [eqMode, setEqMode] = useState<EqMode>("advanced");
  const [eqPreset, setEqPreset] = useState<string>("flat");
  const [eqGains, setEqGains] = useState<number[]>(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [eqPreGainDb, setEqPreGainDb] = useState<number>(0);
  // Simple mode shelf gains (dB). Independent of the 10-band eqGains so switching
  // modes is non-destructive — each mode keeps its own settings.
  const [eqBassDb, setEqBassDb] = useState<number>(0);
  const [eqTrebleDb, setEqTrebleDb] = useState<number>(0);
  // ReplayGain: per-track loudness normalization applied via a per-chain gain node.
  // Mode "off" | "track" | "album"; preamp dB is added on top; preventClip caps the
  // gain so the (normalized) peak stays <= 0 dBFS.
  const [rgMode, setRgMode] = useState<"off" | "track" | "album">("off");
  const [rgPreampDb, setRgPreampDb] = useState<number>(0);
  const [rgPreventClip, setRgPreventClip] = useState<boolean>(true);
  const trackChangeSourceRef = useRef<"user" | "auto">("user");
  // Synchronous guard against concurrent transcode starts. transcodeSessionRef
  // is only set after `await start_transcode` resolves, so two callers firing
  // in the same tick (play().catch + onLoadedMetadata/onMediaError) could both
  // pass that guard. This ref is set synchronously before the await.
  const transcodeStartingRef = useRef(false);
  // Monotonic id bumped on every play request (handlePlay/handlePlayUrl). When a
  // newer request starts, it pauses/reloads the audio elements, which rejects the
  // previous request's pending `play()` promise with an AbortError ("The operation
  // was aborted."). That rejection is expected, not a real failure — by capturing
  // the id at the start of each request and comparing on completion, a superseded
  // request silently discards its outcome instead of flashing a playback-error modal.
  const playGenerationRef = useRef(0);
  // True while an explicit play (handlePlay/handlePlayUrl) is resolving and
  // installing its source. Set synchronously before the resolve await and cleared
  // once the new source is installed (or the attempt ends), guarded by play
  // generation so a superseded play can't clear a newer one's flag. While true the
  // timeupdate-driven preload→crossfade machine is gated off (canDriveTransitionMachine)
  // so a not-fully-stopped outgoing element can't start a fade the incoming play
  // doesn't own.
  const transitioningRef = useRef(false);
  // Synchronous re-entrancy guard for fullscreen toggling. requestFullscreen /
  // exitFullscreen are activation-consuming in WKWebView: a second call fired
  // before the first transition settles rejects with "Cannot request fullscreen
  // without transient activation". We set this on the first call and clear it on
  // the next `fullscreenchange` (or on rejection), so rapid double-clicks become
  // a no-op instead of an unhandled rejection.
  const fullscreenPendingRef = useRef(false);

  const audioRefA = useRef<HTMLAudioElement>(null);
  const audioRefB = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;
  // Mirror for the once-mounted engine-event subscriptions, which would
  // otherwise close over the first render's currentTrack.
  const currentTrackRef = useRef<QueueTrack | null>(currentTrack);
  currentTrackRef.current = currentTrack;

  // --- Native (mpv) engine session state ------------------------------------
  // Non-null while the mpv engine owns playback of `key` (the media elements
  // are all torn down for the session's duration). The key doubles as the
  // native play-generation guard: engine events carrying another key are stale.
  const nativeSessionRef = useRef<{ key: string } | null>(null);
  // Tracks that failed native playback this session — resolution/preload skip
  // them so they route through the browser engine (per-track fallback).
  const nativeBlockedKeysRef = useRef<Set<string>>(new Set());
  // Gapless-armed next track (mirrors preloadedTrackRef for the native path).
  // `src` keeps the webview URL so waveforms keep working after promotion.
  const nativePreloadedRef = useRef<{ key: string; track: QueueTrack; src: string | null } | null>(null);
  const nativePreloadingRef = useRef(false);
  // Last position reported by engine-position — the resume point for the
  // per-track browser fallback on engine-error.
  const nativeLastPositionRef = useRef(0);
  // True between issuing engine_start_crossfade and the engine's
  // track-changed (or any session reset) — stops the progress machine from
  // re-triggering the fade every position tick.
  const nativeFadingRef = useRef(false);
  // True while the native session is a VIDEO session: the engine renders into
  // a native layer under the webview and App punches the CSS hole + reports
  // the container bounds while this is set.
  const [nativeVideoActive, setNativeVideoActive] = useState(false);
  // Fullscreen for native video sessions = WINDOW fullscreen + the
  // `.video-container--native-fs` full-window pin (DOM element-fullscreen
  // would move the webview to its own space, away from the native layer).
  // This state is the source of truth; the window follows it.
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // Live stream title (ICY StreamTitle) for internet-radio sessions — the
  // song the station is currently playing. Null for ordinary tracks (the
  // engine's media-title then equals the track's own title and is dropped).
  const [icyTitle, setIcyTitle] = useState<string | null>(null);

  function setWindowFullscreen(fullscreen: boolean) {
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().setFullscreen(fullscreen))
      .catch((e) => console.error("Failed to set window fullscreen:", e));
  }

  // Leaving the native video session (track ended, fallback, stop) must also
  // leave fullscreen — otherwise the window stays fullscreen with the app
  // surfaces hidden by the native-fs CSS.
  useEffect(() => {
    if (!nativeVideoActive && nativeFullscreen) {
      setNativeFullscreen(false);
      setWindowFullscreen(false);
    }
  }, [nativeVideoActive, nativeFullscreen]);

  const pendingSrcRef = useRef<string | null>(null);
  const pendingAutoPlayRef = useRef(true);
  const pendingSeekRef = useRef(0);
  // Key of a video whose <video> element currently holds only a restored
  // first-frame preview (src loaded, never played) — see loadRestoredVideoPreview.
  // While set, handlePause routes the first play through handlePlay so stream
  // resolution + the transcode fallback run, instead of a bare el.play().
  const previewLoadedKeyRef = useRef<string | null>(null);
  const scrobbledRef = useRef(false);
  const [scrobbled, setScrobbled] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [failedTrack, setFailedTrack] = useState<QueueTrack | null>(null);
  const [currentAssetUrl, setCurrentAssetUrl] = useState<string | null>(null);
  // Last source URL handed to playWithSrc — read by the play-failure catch
  // blocks, where currentAssetUrl would be a stale closure.
  const lastPlaySrcRef = useRef<string | null>(null);
  const [loadingTrack, setLoadingTrack] = useState<QueueTrack | null>(null);
  const playStartedAtRef = useRef(0);

  // Preload state (refs for use in event handlers without stale closures)
  const preloadedTrackRef = useRef<QueueTrack | null>(null);
  const preloadReadyRef = useRef(false);
  const isPreloadingRef = useRef(false);
  const prefetchRequestedRef = useRef(false);
  const preloadPromiseRef = useRef<{ key: string; promise: Promise<ResolvedTrackSource> } | null>(null);

  // Crossfade state
  const isCrossfadingRef = useRef(false);
  const crossfadeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const crossfadeOutgoingRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const wasPlayingBeforeHideRef = useRef(false);

  function effectiveVolume(): number {
    return mutedRef.current ? 0 : volumeRef.current;
  }

  // DIAGNOSTIC (no behavior change): a "shadow" track is an audio element still
  // producing sound while it is NOT the active slot and no crossfade is running.
  // That orphan state is the suspected cause of the rare "two tracks at once /
  // pause leaves one playing" bug. We can't reproduce it on demand, so we log
  // full state the moment it appears in the wild to pin down the trigger.
  function diagnoseShadowPlayback(origin: string): void {
    const a = audioRefA.current;
    const b = audioRefB.current;
    if (!a || !b) return;
    const aPlaying = !a.paused && !a.ended;
    const bPlaying = !b.paused && !b.ended;
    if (aPlaying && bPlaying && !isCrossfadingRef.current) {
      logPlayback(
        `SHADOW DETECTED (${origin}): both A & B playing outside a crossfade. ` +
          `active=${activeSlotRef.current} ` +
          `A{src=${a.src ? "set" : "empty"} t=${a.currentTime.toFixed(1)} paused=${a.paused} ended=${a.ended}} ` +
          `B{src=${b.src ? "set" : "empty"} t=${b.currentTime.toFixed(1)} paused=${b.paused} ended=${b.ended}} ` +
          `crossfadeTimer=${crossfadeTimerRef.current !== null} ` +
          `preloaded=${preloadedTrackRef.current?.title ?? "none"} ` +
          `current=${currentTrack?.title ?? "none"}`,
      );
    }
  }

  // Diagnostic for the Next-stops-playback class of bug: a play request that does
  // NOT cleanly start its track. handlePlay pauses the outgoing audio up front, so
  // any non-"play" outcome means audio is stopped — and if it happened while the
  // queue index already advanced, the now-playing bar is left stale. Captures the
  // full generation/element snapshot so a recurrence is explainable from the log
  // instead of being invisible (the original bug logged nothing at all).
  //   bail  → superseded by a newer play (expected on rapid skipping): file log only.
  //   retry → resolve superseded but this play is still current (the regression
  //           condition): also surfaced in the devtools console.
  //   fail  → still no source after a fresh resolve: console + the catch's error.
  function diagnosePlayOutcome(
    outcome: HandlePlayOutcome,
    track: QueueTrack,
    capturedGen: number,
    reusedPreload: boolean,
    hadSrc: boolean,
  ): void {
    if (outcome === "play") return;
    const a = audioRefA.current;
    const b = audioRefB.current;
    const detail =
      `track="${track.artist_name ?? "?"} — ${track.title}" key=${track.key} ` +
      `playGen captured=${capturedGen} current=${playGenerationRef.current} ` +
      `reusedPreload=${reusedPreload} resolvedSrc=${hadSrc ? "set" : "EMPTY"} ` +
      `active=${activeSlotRef.current} ` +
      `A{paused=${a?.paused} ended=${a?.ended}} B{paused=${b?.paused} ended=${b?.ended}} ` +
      `crossfading=${isCrossfadingRef.current} nowPlaying="${currentTrack?.title ?? "none"}"`;
    logPlayback(`PLAY ${outcome.toUpperCase()}: ${detail}`);
    if (outcome === "retry" || outcome === "fail") {
      console.warn(`[playback] play ${outcome}: ${detail}`);
    }
  }

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceARef = useRef<MediaElementAudioSourceNode | null>(null);
  const sourceBRef = useRef<MediaElementAudioSourceNode | null>(null);
  const filtersARef = useRef<BiquadFilterNode[]>([]);
  const filtersBRef = useRef<BiquadFilterNode[]>([]);
  // Simple-mode shelf nodes, tuple [lowshelf (bass), highshelf (treble)] per chain.
  // Always present in the graph at 0 dB when unused, so switching modes is a gain
  // write — no graph rebuild, no audio glitch (even mid-crossfade).
  const shelvesARef = useRef<BiquadFilterNode[]>([]);
  const shelvesBRef = useRef<BiquadFilterNode[]>([]);
  const xfadeGainARef = useRef<GainNode | null>(null);
  const xfadeGainBRef = useRef<GainNode | null>(null);
  // ReplayGain gain node per chain (at the head of each chain, pre-EQ).
  const rgGainARef = useRef<GainNode | null>(null);
  const rgGainBRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  // Brick-wall limiter on the master bus, engaged only while a simple-mode boost
  // is active. Prevents shelf boosts from clipping without dropping overall level.
  const limiterRef = useRef<DynamicsCompressorNode | null>(null);
  const eqEnabledRef = useRef(eqEnabled);
  const eqModeRef = useRef<EqMode>(eqMode);
  const eqGainsRef = useRef<number[]>(eqGains);
  const eqPreGainDbRef = useRef<number>(eqPreGainDb);
  const eqBassDbRef = useRef<number>(eqBassDb);
  const eqTrebleDbRef = useRef<number>(eqTrebleDb);
  const rgModeRef = useRef(rgMode);
  const rgPreampDbRef = useRef(rgPreampDb);
  const rgPreventClipRef = useRef(rgPreventClip);
  eqEnabledRef.current = eqEnabled;
  eqModeRef.current = eqMode;
  eqGainsRef.current = eqGains;
  eqPreGainDbRef.current = eqPreGainDb;
  eqBassDbRef.current = eqBassDb;
  eqTrebleDbRef.current = eqTrebleDb;
  rgModeRef.current = rgMode;
  rgPreampDbRef.current = rgPreampDb;
  rgPreventClipRef.current = rgPreventClip;

  function masterGainValue(): number {
    // Advanced mode: the user sets pre-gain manually. Simple mode does NOT
    // attenuate — dropping the whole signal to make room for a boost is heard as
    // "quieter" (especially the bass on small speakers). Clip protection for
    // simple-mode boosts is handled by the master-bus limiter instead.
    const preGainDb = (eqEnabledRef.current && eqModeRef.current !== "simple")
      ? eqPreGainDbRef.current
      : 0;
    const linear = Math.pow(10, preGainDb / 20);
    return effectiveVolume() * linear;
  }

  // The limiter only needs to act when a simple-mode boost can push peaks past
  // the ceiling; cuts and the flat state can't clip, so it stays disengaged
  // (threshold at 0 dB → effectively transparent) to keep the dry path clean.
  function limiterThresholdDb(): number {
    const boosting = eqEnabledRef.current
      && eqModeRef.current === "simple"
      && Math.max(eqBassDbRef.current, eqTrebleDbRef.current) > 0;
    return boosting ? LIMITER_CEILING_DB : 0;
  }

  function applyLimiter(): void {
    const lim = limiterRef.current;
    if (!lim) return;
    const ctx = audioCtxRef.current;
    const t = ctx ? ctx.currentTime : 0;
    // Ramp the threshold so engaging/releasing the limiter doesn't click.
    lim.threshold.setTargetAtTime(limiterThresholdDb(), t, 0.02);
  }

  function applyEqToFilters(): void {
    const enabled = eqEnabledRef.current;
    const simple = enabled && eqModeRef.current === "simple";
    // Peaking bands carry advanced mode; they sit flat in simple/disabled.
    const gains = (enabled && !simple) ? eqGainsRef.current : new Array(NUM_BANDS).fill(0);
    if (filtersARef.current.length) applyGainsToFilters(filtersARef.current, gains);
    if (filtersBRef.current.length) applyGainsToFilters(filtersBRef.current, gains);
    // Shelves carry simple mode; they sit flat otherwise.
    const bass = simple ? eqBassDbRef.current : 0;
    const treble = simple ? eqTrebleDbRef.current : 0;
    if (shelvesARef.current.length) {
      shelvesARef.current[0].gain.value = bass;
      shelvesARef.current[1].gain.value = treble;
    }
    if (shelvesBRef.current.length) {
      shelvesBRef.current[0].gain.value = bass;
      shelvesBRef.current[1].gain.value = treble;
    }
  }

  function ensureAudioGraph(): AudioContext | null {
    if (audioCtxRef.current) {
      if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume().catch(console.error);
      }
      return audioCtxRef.current;
    }
    const elA = audioRefA.current;
    const elB = audioRefB.current;
    if (!elA || !elB) return null;
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      console.error("AudioContext not supported");
      return null;
    }
    const ctx = new Ctor();
    audioCtxRef.current = ctx;
    if (ctx.state === "suspended") {
      ctx.resume().catch(console.error);
    }

    // Master bus: [both chains] -> masterGain -> limiter -> destination.
    // The limiter is a DynamicsCompressorNode tuned as a near-brick-wall limiter
    // (high ratio, fast attack). It sits idle (threshold 0 dB) unless a simple-mode
    // boost engages it, so normal playback and advanced mode are unaffected.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = limiterThresholdDb();
    limiter.knee.value = 0;       // hard knee — true limiting, not soft compression
    limiter.ratio.value = 20;     // max ratio ≈ brick wall
    limiter.attack.value = 0.003; // 3 ms — catch transients before they clip
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    limiterRef.current = limiter;

    const masterGain = ctx.createGain();
    masterGain.gain.value = masterGainValue();
    masterGain.connect(limiter);
    masterGainRef.current = masterGain;

    function buildChain(el: HTMLAudioElement): {
      source: MediaElementAudioSourceNode;
      filters: BiquadFilterNode[];
      shelves: BiquadFilterNode[];
      xfadeGain: GainNode;
      rgGain: GainNode;
    } {
      const source = ctx.createMediaElementSource(el);
      const filters: BiquadFilterNode[] = [];
      for (let i = 0; i < NUM_BANDS; i++) {
        const f = ctx.createBiquadFilter();
        f.type = "peaking";
        f.frequency.value = BANDS[i];
        f.Q.value = BAND_Q;
        f.gain.value = 0;
        filters.push(f);
      }
      // Simple-mode shelves, after the peaking bank, at unity (0 dB) until engaged.
      const lowShelf = ctx.createBiquadFilter();
      lowShelf.type = "lowshelf";
      lowShelf.frequency.value = SHELF_BASS_FREQ;
      lowShelf.gain.value = 0;
      const highShelf = ctx.createBiquadFilter();
      highShelf.type = "highshelf";
      highShelf.frequency.value = SHELF_TREBLE_FREQ;
      highShelf.gain.value = 0;
      const shelves = [lowShelf, highShelf];

      const xfadeGain = ctx.createGain();
      xfadeGain.gain.value = 1;

      // ReplayGain node at the head of the chain (pre-EQ): a per-track loudness
      // adjustment on the source signal. Clipping from RG + EQ boosts is caught
      // by the shared master-bus limiter downstream.
      const rgGain = ctx.createGain();
      rgGain.gain.value = 1;

      source.connect(rgGain);
      rgGain.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(xfadeGain);
      xfadeGain.connect(masterGain);
      return { source, filters, shelves, xfadeGain, rgGain };
    }

    const a = buildChain(elA);
    const b = buildChain(elB);
    sourceARef.current = a.source;
    sourceBRef.current = b.source;
    filtersARef.current = a.filters;
    filtersBRef.current = b.filters;
    shelvesARef.current = a.shelves;
    shelvesBRef.current = b.shelves;
    xfadeGainARef.current = a.xfadeGain;
    xfadeGainBRef.current = b.xfadeGain;
    rgGainARef.current = a.rgGain;
    rgGainBRef.current = b.rgGain;

    applyEqToFilters();
    applyLimiter();
    return ctx;
  }

  function getActiveAudioElement(): HTMLAudioElement | null {
    return activeSlotRef.current === "A" ? audioRefA.current : audioRefB.current;
  }

  function getInactiveAudioElement(): HTMLAudioElement | null {
    return activeSlotRef.current === "A" ? audioRefB.current : audioRefA.current;
  }

  // Forcibly silence a media element. pause() alone is not reliable on WKWebView —
  // it can leave `.paused` false and keep the element emitting `timeupdate` / sound
  // (the cause behind the CROSSFADE WARN / SHADOW diagnostics). Detaching the source
  // and reloading drives the element to NETWORK_EMPTY, which also prevents a stray
  // `ended` from firing. Use this wherever an element must truly go quiet.
  function stopMediaElement(el: HTMLMediaElement | null) {
    if (!el) return;
    el.pause();
    el.removeAttribute("src");
    el.load();
  }

  // ReplayGain --------------------------------------------------------------
  type ReplayGainInfo = {
    track_gain_db: number | null;
    track_peak: number | null;
    album_gain_db: number | null;
    album_peak: number | null;
  };
  // Track key whose RG is (being) applied to each chain — guards against a slow
  // async resolve landing after the chain has already moved on to another track.
  const rgSlotKeyARef = useRef<string | null>(null);
  const rgSlotKeyBRef = useRef<string | null>(null);

  function setRgGain(slot: "A" | "B", linear: number): void {
    const node = slot === "A" ? rgGainARef.current : rgGainBRef.current;
    if (!node) return;
    const ctx = audioCtxRef.current;
    // Ramp to avoid a click when normalization changes between tracks.
    if (ctx) node.gain.setTargetAtTime(linear, ctx.currentTime, 0.05);
    else node.gain.value = linear;
  }

  // Resolve and apply ReplayGain for the track loaded on `slot`. No-op (unity
  // gain) when RG is off, the track has no path, or it carries no RG values.
  async function applyReplayGain(slot: "A" | "B", track: QueueTrack | null): Promise<void> {
    if (slot === "A") rgSlotKeyARef.current = track?.key ?? null;
    else rgSlotKeyBRef.current = track?.key ?? null;

    if (rgModeRef.current === "off" || !track || !track.path) {
      setRgGain(slot, 1);
      return;
    }
    let info: ReplayGainInfo | null = null;
    try {
      info = await invoke<ReplayGainInfo | null>("get_replaygain_by_path", { path: track.path });
    } catch (e) {
      console.error("Failed to resolve ReplayGain:", e);
      setRgGain(slot, 1);
      return;
    }
    // Bail if this chain moved on to another track while we awaited.
    const stillCurrent =
      (slot === "A" ? rgSlotKeyARef.current : rgSlotKeyBRef.current) === track.key;
    if (!stillCurrent) return;

    if (!info) {
      setRgGain(slot, 1);
      return;
    }
    const album = rgModeRef.current === "album";
    const gainDb = album
      ? info.album_gain_db ?? info.track_gain_db
      : info.track_gain_db ?? info.album_gain_db;
    if (gainDb == null) {
      setRgGain(slot, 1);
      return;
    }
    let linear = Math.pow(10, (gainDb + rgPreampDbRef.current) / 20);
    if (rgPreventClipRef.current) {
      const peak = album
        ? info.album_peak ?? info.track_peak
        : info.track_peak ?? info.album_peak;
      if (peak && peak > 0) linear = Math.min(linear, 1 / peak);
    }
    setRgGain(slot, linear);
  }

  function getMediaElement(): HTMLAudioElement | HTMLVideoElement | null {
    if (currentTrack && isVideoTrack(currentTrack)) {
      return videoRef.current;
    }
    return getActiveAudioElement();
  }

  // Sync volume/mute refs and media elements when either changes
  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    const out = effectiveVolume();
    // The mpv engine tracks volume/mute directly; no-op when it isn't running.
    nativeEngine.setVolume(volume, muted).catch(console.error);
    // Video bypasses Web Audio, so its volume is set directly.
    if (videoRef.current) videoRef.current.volume = out;
    if (masterGainRef.current) {
      masterGainRef.current.gain.value = masterGainValue();
      return;
    }
    // Pre-graph fallback: until ensureAudioGraph runs, the audio elements
    // play through their native path so el.volume still works.
    if (audioRefA.current) audioRefA.current.volume = out;
    if (audioRefB.current) audioRefB.current.volume = out;
  }, [volume, muted]);

  useEffect(() => {
    eqEnabledRef.current = eqEnabled;
    eqModeRef.current = eqMode;
    eqGainsRef.current = eqGains;
    eqPreGainDbRef.current = eqPreGainDb;
    eqBassDbRef.current = eqBassDb;
    eqTrebleDbRef.current = eqTrebleDb;
    // Lazily build the Web Audio graph the first time EQ is actually engaged.
    // Until then, audio plays through the native HTMLMediaElement path for
    // snappier play/pause/mute response.
    if (eqEnabled && !audioCtxRef.current) ensureAudioGraph();
    applyEqToFilters();
    applyLimiter();
    if (masterGainRef.current) masterGainRef.current.gain.value = masterGainValue();
    // Mirror to the mpv engine (cached backend-side until it runs; no-op on
    // incapable builds).
    nativeEngine.setEq({
      enabled: eqEnabled,
      mode: eqMode,
      gains: eqGains,
      preGainDb: eqPreGainDb,
      bassDb: eqBassDb,
      trebleDb: eqTrebleDb,
    }).catch(console.error);
  }, [eqEnabled, eqMode, eqGains, eqPreGainDb, eqBassDb, eqTrebleDb]);

  // Apply ReplayGain to the active chain when the current track changes or the RG
  // settings change. The inactive (preloaded) chain is handled in preloadNext.
  useEffect(() => {
    applyReplayGain(activeSlotRef.current, currentTrack);
  }, [currentTrack, rgMode, rgPreampDb, rgPreventClip]);

  // Mirror ReplayGain settings to the mpv engine, which reads the RG tags
  // natively (per deck, per file) — no per-track resolve needed there.
  useEffect(() => {
    nativeEngine.setReplayGain({
      mode: rgMode,
      preampDb: rgPreampDb,
      preventClip: rgPreventClip,
    }).catch(console.error);
  }, [rgMode, rgPreampDb, rgPreventClip]);

  // Load video source once the element is available after render
  useEffect(() => {
    if (pendingSrcRef.current && currentTrack && isVideoTrack(currentTrack) && videoRef.current) {
      const src = pendingSrcRef.current;
      const autoPlay = pendingAutoPlayRef.current;
      pendingSrcRef.current = null;
      pendingAutoPlayRef.current = true;
      const seekTo = pendingSeekRef.current;
      pendingSeekRef.current = 0;
      videoRef.current.src = src;
      videoRef.current.volume = effectiveVolume();
      if (seekTo > 0) videoRef.current.currentTime = seekTo;
      if (autoPlay) {
        videoRef.current.play().catch(e => console.error("Video play error:", e));
      }
    }
  }, [currentTrack]);

  // Paint the first frame of a video that was restored in the paused state on
  // startup. The restore path only sets currentTrack (no src resolution), so a
  // restored-paused video would show an empty/black <video> until the user
  // pressed play. Resolve the local source and load it without autoplay so the
  // element decodes a frame. Scoped to local (file://) video: remote/plugin
  // resolution can be slow (e.g. yt-dlp) and shouldn't run eagerly for a track
  // the user may never resume. Real playback still flows through handlePlay.
  async function loadRestoredVideoPreview(track: QueueTrack) {
    if (!isVideoTrack(track) || !isLocalTrack(track)) return;
    let resolved: ResolvedTrackSource;
    try {
      resolved = await resolveTrackSrcRef.current(track);
    } catch (e) {
      console.error("Failed to resolve restored video preview:", e);
      return;
    }
    if (!resolved.src) return;
    const el = videoRef.current;
    // Bail if the element vanished, this track is no longer current, or the user
    // already started playback (which sets src via handlePlay/playWithSrc) — don't
    // clobber a live session with a paused preview.
    if (!el || el.src) return;
    if (currentTrack && currentTrack.key !== track.key) return;
    el.src = resolved.src;
    el.preload = "auto";
    el.volume = effectiveVolume();
    previewLoadedKeyRef.current = track.key;
  }

  // Persist state
  // Resume playback if the browser auto-paused it when the page became hidden (e.g. window minimized)
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        const el = activeSlotRef.current === "A" ? audioRefA.current : audioRefB.current;
        const vid = videoRef.current;
        const anyPlaying = (el && !el.paused) || (vid && !vid.paused);
        wasPlayingBeforeHideRef.current = !!anyPlaying;
      } else if (document.visibilityState === "visible") {
        if (wasPlayingBeforeHideRef.current) {
          wasPlayingBeforeHideRef.current = false;
          const el = activeSlotRef.current === "A" ? audioRefA.current : audioRefB.current;
          const vid = videoRef.current;
          if (el && el.paused && el.src) el.play().catch(console.error);
          if (vid && vid.paused && vid.src) vid.play().catch(console.error);
        }
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // positionSecs persisted by its own effect below; currentTrack persisted by App.tsx as QueueEntry
  useEffect(() => {
    if (currentTrack) logPlayback(`Track changed: ${currentTrack.artist_name ?? "?"} — ${currentTrack.title} (key=${currentTrack.key})`);
  }, [currentTrack]);
  // Position persistence: subscribe to the external store (position is not
  // React state — see the comment at the top of the hook). store.set is
  // debounced by the store layer's autoSave, same as the old per-tick effect.
  useEffect(() => subscribePlaybackPosition(() => {
    if (restoredRef.current) store.set("positionSecs", getPlaybackPosition());
  }), []);
  useEffect(() => { if (restoredRef.current) store.set("volume", volume); }, [volume]);
  useEffect(() => { if (restoredRef.current) store.set("muted", muted); }, [muted]);

  function invalidatePreload() {
    cancelCrossfade();
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;
    isPreloadingRef.current = false;
    preloadPromiseRef.current = null;
    if (nativePreloadedRef.current) {
      nativePreloadedRef.current = null;
      nativeEngine.clearPreload().catch(console.error);
    }

    const inactiveEl = getInactiveAudioElement();
    if (inactiveEl) {
      inactiveEl.pause();
      inactiveEl.removeAttribute("src");
      inactiveEl.load();
    }
  }

  async function preloadNext(nextTrack: QueueTrack) {
    if (isPreloadingRef.current) return;
    if (isVideoTrack(nextTrack)) {
      preloadedTrackRef.current = null;
      preloadReadyRef.current = false;
      return;
    }

    isPreloadingRef.current = true;
    logPlayback(`Preload: resolving "${nextTrack.artist_name ?? "?"} — ${nextTrack.title}"`);
    const resolvePromise = resolveTrackSrcRef.current(nextTrack);
    preloadPromiseRef.current = { key: nextTrack.key, promise: resolvePromise };
    try {
      const resolved = await resolvePromise;
      logPlayback(`Preload: resolved "${nextTrack.title}"`);

      // Resolution can reveal that a path-less/remote next track is actually a
      // video (its local copy was matched here). The audio preload elements
      // can't play video, so abort — handlePlay will resolve again and route it
      // to the <video> element. handleGaplessNext only fires when a preload is
      // marked ready, so leaving it unset is enough to force the explicit path.
      const enriched = resolved.patch ? { ...nextTrack, ...resolved.patch } : nextTrack;
      if (isVideoTrack(enriched)) {
        preloadedTrackRef.current = null;
        preloadReadyRef.current = false;
        return;
      }

      const inactiveEl = getInactiveAudioElement();
      if (!inactiveEl) return;

      inactiveEl.src = resolved.src;
      // CRITICAL: a preloaded element must only buffer, never play, until
      // startCrossfade/handleGaplessNext plays it intentionally. The inactive
      // slot is usually a torn-down former-outgoing element whose `.paused` reads
      // stale-`false` on WKWebView (see stopMediaElement's note) — and assigning a
      // fresh `src` to an element whose paused flag is false makes WKWebView START
      // PLAYING on assignment. That auto-start is the "two tracks at once / pause
      // leaves one playing" bug: the preload sounds alongside the active track with
      // no crossfade, and handlePause (active slot only) can't reach it. pause() is
      // reliable now that a src is present, so force it back to paused immediately.
      inactiveEl.pause();
      inactiveEl.volume = effectiveVolume();
      inactiveEl.preload = "auto";
      // Pre-apply RG to the inactive chain so the gapless/crossfade swap is already
      // normalized when this track becomes active.
      applyReplayGain(activeSlotRef.current === "A" ? "B" : "A", nextTrack);

      preloadedTrackRef.current = nextTrack;
      preloadReadyRef.current = false;

      const onCanPlay = () => {
        logPlayback(`Preload: audio ready for "${nextTrack.title}"`);
        preloadReadyRef.current = true;
        // Belt-and-suspenders: WKWebView can (re)start a freshly-src'd element on
        // its own once it has buffered. A ready preload must still be silent until
        // it's intentionally played, so re-assert paused here too.
        if (!inactiveEl.paused) inactiveEl.pause();
        inactiveEl.removeEventListener("canplay", onCanPlay);
      };
      inactiveEl.addEventListener("canplay", onCanPlay);
    } catch (e) {
      console.error("Preload error:", e);
      logPlayback(`Preload: failed for "${nextTrack.title}" — ${e instanceof Error ? e.message : String(e)}`);
      preloadedTrackRef.current = null;
    } finally {
      isPreloadingRef.current = false;
      preloadPromiseRef.current = null;
    }
  }

  // --- Native (mpv) engine session -----------------------------------------
  // While a native session owns playback the media elements are torn down;
  // the `engine-*` events below stand in for timeupdate/ended/error. Only
  // reads refs, so the once-captured closure in the mount effect stays valid.

  async function nativePreloadNext(next: QueueTrack) {
    if (nativePreloadingRef.current) return;
    if (isVideoTrack(next) || nativeBlockedKeysRef.current.has(next.key)) return;
    nativePreloadingRef.current = true;
    logPlayback(`Native preload: resolving "${next.artist_name ?? "?"} — ${next.title}"`);
    try {
      const resolved = await resolveTrackSrcRef.current(next);
      if (!resolved.src) return;
      const enriched = resolved.patch ? { ...next, ...resolved.patch } : next;
      // Not natively playable (video / webview-only source): stay unarmed —
      // the engine's `engine-ended` then routes the next track through the
      // explicit handlePlay path, which picks the right surface.
      if (isVideoTrack(enriched) || !resolved.engineSource) return;
      if (!nativeSessionRef.current) return; // session ended while resolving
      await nativeEngine.preload({
        source: resolved.engineSource,
        trackKey: enriched.key,
        crossfade: crossfadeSecsRef.current > 0,
      });
      nativePreloadedRef.current = { key: enriched.key, track: enriched, src: resolved.src };
      logPlayback(`Native preload: armed "${enriched.title}"`);
    } catch (e) {
      console.error("Native preload error:", e);
    } finally {
      nativePreloadingRef.current = false;
    }
  }

  useEffect(() => {
    return combineUnlisten(
      subscribe<EnginePositionEvent>("engine-position", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        nativeLastPositionRef.current = payload.positionSecs;
        setPlaybackPosition(payload.positionSecs);

        // Scrobble threshold — mirrors onTimeUpdate (native sessions are
        // always audio, but keep the video-history gate for symmetry).
        const track = currentTrackRef.current;
        if (!scrobbledRef.current && track && (trackVideoHistoryRef.current || !isVideoTrack(track))) {
          if (shouldScrobble(payload.positionSecs, track.duration_secs)) {
            scrobbledRef.current = true;
            setScrobbled(true);
            invoke("record_play", { title: track.title, artistName: track.artist_name }).catch(console.error);
          }
        }

        const duration = payload.durationSecs ?? track?.duration_secs ?? 0;
        const actions = driveProgressMachine({
          position: payload.positionSecs,
          duration,
          crossfadeSecs: crossfadeSecsRef.current,
          next: peekNextRef.current(),
          preloadedKey: nativePreloadedRef.current?.key ?? null,
          preloadReady: nativePreloadedRef.current !== null,
          isPreloading: nativePreloadingRef.current,
          isCrossfading: nativeFadingRef.current,
          prefetchRequested: prefetchRequestedRef.current,
        });
        if (actions.requestPrefetch) {
          logPlayback(`Prefetch: requesting auto-continue (native, ${(duration - payload.positionSecs).toFixed(1)}s remaining)`);
          prefetchRequestedRef.current = true;
          prefetchNextRef.current();
        }
        if (actions.invalidatePreload && nativePreloadedRef.current) {
          nativePreloadedRef.current = null;
          nativeEngine.clearPreload().catch(console.error);
        }
        if (actions.preloadTrack) nativePreloadNext(actions.preloadTrack);
        if (actions.startCrossfade) {
          nativeFadingRef.current = true;
          nativeEngine.startCrossfade(crossfadeSecsRef.current).catch((e) => {
            console.error("Native crossfade failed to start:", e);
            nativeFadingRef.current = false;
          });
        }
      }),
      subscribe<EngineDurationEvent>("engine-duration", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        if (payload.durationSecs > 0) setDurationSecs(payload.durationSecs);
      }),
      subscribe<EngineTrackChangedEvent>("engine-track-changed", ({ payload }) => {
        const promoted = nativePreloadedRef.current;
        if (!promoted || promoted.key !== payload.trackKey) return;
        // Mirror of handleGaplessNext's state updates for an engine-side swap.
        // Armed tracks are always audio (video is never gapless/crossfade-armed).
        nativePreloadedRef.current = null;
        nativeSessionRef.current = { key: promoted.key };
        nativeLastPositionRef.current = 0;
        nativeFadingRef.current = false;
        setNativeVideoActive(false);
        setIcyTitle(null);
        trackChangeSourceRef.current = "auto";
        setCurrentTrack(promoted.track);
        prefetchRequestedRef.current = false;
        setCurrentAssetUrl(promoted.src);
        setPlaybackPosition(0);
        setDurationSecs(promoted.track.duration_secs ?? 0);
        scrobbledRef.current = false;
        setScrobbled(false);
        playStartedAtRef.current = Math.floor(Date.now() / 1000);
        advanceIndexRef.current();
      }),
      subscribe<EngineEndedEvent>("engine-ended", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        nativeSessionRef.current = null;
        nativePreloadedRef.current = null;
        nativeFadingRef.current = false;
        setNativeVideoActive(false);
        setIcyTitle(null);
        onNativeAutoEndedRef.current();
      }),
      subscribe<EngineStateEvent>("engine-state", ({ payload }) => {
        if (!nativeSessionRef.current) return;
        if (payload.trackKey && payload.trackKey !== nativeSessionRef.current.key) return;
        setPlaying(payload.playing);
      }),
      subscribe<EngineIcyTitleEvent>("engine-icy-title", ({ payload }) => {
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        const title = payload.title.trim();
        const track = currentTrackRef.current;
        // Only direct http(s) sources can be live streams; local/scheme tracks
        // report their own tag title (or filename) here — not a live feed.
        const isDirectStream = !!track?.path && (track.path.startsWith("http://") || track.path.startsWith("https://"));
        // Before real ICY data arrives, mpv reports the URL's basename — drop it.
        const urlBasename = track?.path?.split("/").pop() ?? "";
        if (!isDirectStream || !title || title === track?.title || title === track?.path || title === urlBasename) {
          setIcyTitle(null);
        } else {
          setIcyTitle(title);
        }
      }),
      subscribe<EngineErrorEvent>("engine-error", ({ payload }) => {
        // Blocklist regardless of which role the key held — a failed preload
        // must not be retried natively either.
        nativeBlockedKeysRef.current.add(payload.trackKey);
        if (nativePreloadedRef.current?.key === payload.trackKey) nativePreloadedRef.current = null;
        if (nativeSessionRef.current?.key !== payload.trackKey) return;
        nativeSessionRef.current = null;
        nativeFadingRef.current = false;
        setNativeVideoActive(false);
        setIcyTitle(null);
        logPlayback(`Native engine error (${payload.code}) key=${payload.trackKey} — falling back to browser engine: ${payload.message}`);
        const track = currentTrackRef.current;
        if (track && track.key === payload.trackKey) {
          // Replay the same track at the same position via the browser engine.
          pendingSeekRef.current = nativeLastPositionRef.current;
          handlePlayRef.current(track, "auto");
        }
      }),
    );
  }, []);

  function finishCrossfade() {
    const outgoing = crossfadeOutgoingRef.current;
    if (outgoing) {
      outgoing.pause();
      outgoing.removeAttribute("src");
      outgoing.load();
      // DIAGNOSTIC: verify the outgoing element actually stopped. If WKWebView
      // left it playing here, isCrossfadingRef is about to flip false and the
      // element becomes an untracked orphan (the shadow bug).
      if (!outgoing.paused) {
        logPlayback("CROSSFADE WARN (finish): outgoing element still playing after pause()/load()");
      }
    }

    // Set incoming element to full volume
    const activeEl = getActiveAudioElement();
    if (activeEl) activeEl.volume = effectiveVolume();
    if (xfadeGainARef.current) xfadeGainARef.current.gain.value = 1;
    if (xfadeGainBRef.current) xfadeGainBRef.current.gain.value = 1;

    if (crossfadeTimerRef.current !== null) {
      clearInterval(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }
    isCrossfadingRef.current = false;
    crossfadeOutgoingRef.current = null;
  }

  function cancelCrossfade() {
    if (!isCrossfadingRef.current) return;

    if (crossfadeTimerRef.current !== null) {
      clearInterval(crossfadeTimerRef.current);
      crossfadeTimerRef.current = null;
    }

    const outgoing = crossfadeOutgoingRef.current;
    if (outgoing) {
      outgoing.pause();
      outgoing.removeAttribute("src");
      outgoing.load();
      // DIAGNOSTIC: see finishCrossfade — same orphan risk on the cancel path.
      if (!outgoing.paused) {
        logPlayback("CROSSFADE WARN (cancel): outgoing element still playing after pause()/load()");
      }
    }

    // Snap incoming to full volume
    const activeEl = getActiveAudioElement();
    if (activeEl) activeEl.volume = effectiveVolume();
    if (xfadeGainARef.current) xfadeGainARef.current.gain.value = 1;
    if (xfadeGainBRef.current) xfadeGainBRef.current.gain.value = 1;

    isCrossfadingRef.current = false;
    crossfadeOutgoingRef.current = null;
  }

  function startCrossfade() {
    if (isCrossfadingRef.current) return;
    if (!preloadedTrackRef.current || !preloadReadyRef.current) return;

    const nextTrack = preloadedTrackRef.current;
    logPlayback(`Crossfade: starting into "${nextTrack.artist_name ?? "?"} — ${nextTrack.title}"`);
    const outgoingEl = getActiveAudioElement();
    const incomingEl = getInactiveAudioElement();

    if (!outgoingEl || !incomingEl) return;

    // Capture incomingEl in a const that TS knows is non-null for the closure
    const incoming = incomingEl;

    isCrossfadingRef.current = true;
    crossfadeOutgoingRef.current = outgoingEl;

    // Swap active slot immediately (ref + state)
    const newSlot = activeSlotRef.current === "A" ? "B" : "A";
    activeSlotRef.current = newSlot;
    setActiveSlot(newSlot);

    // Update track state for incoming
    trackChangeSourceRef.current = "auto";
    setCurrentTrack(nextTrack);
    prefetchRequestedRef.current = false;
    setCurrentAssetUrl(incoming.src);
    setPlaybackPosition(0);
    setDurationSecs(nextTrack.duration_secs ?? 0);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Start incoming element
    incoming.volume = effectiveVolume();
    // Capture the gain pair ONCE for the whole fade — the interval must keep
    // ramping these same nodes even if activeSlotRef changes underneath it (an
    // explicit play forces slot A mid-fade); re-deriving from the live ref each
    // tick is what pumped the incoming track's gain to ~0.
    const { incoming: incomingGain, outgoing: outgoingGain } =
      crossfadeGainPair(activeSlotRef.current, xfadeGainARef.current, xfadeGainBRef.current);
    if (incomingGain) incomingGain.gain.value = 0;
    if (outgoingGain) outgoingGain.gain.value = 1;
    // If the incoming element's play() rejects (WKWebView intermittently throws
    // AbortError/NotAllowedError when a racing load()/pause() interrupts it), the
    // crossfade machinery would otherwise fade the outgoing track to silence with
    // nothing taking its place — a silent stop mid-track-change. Recover by
    // cancelling the fade and re-playing the next track via the explicit path.
    incoming.play().catch((e) => {
      console.error("Crossfade incoming play failed, recovering:", e);
      cancelCrossfade();
      handlePlay(nextTrack, "auto");
    });

    advanceIndexRef.current();

    // Clear preload state
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;

    // setInterval crossfade loop (works when page is hidden, unlike rAF)
    const startTime = performance.now();
    const fadeDuration = crossfadeSecsRef.current * 1000;

    crossfadeTimerRef.current = setInterval(() => {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / fadeDuration, 1);

      if (audioCtxRef.current) {
        // Drive the captured pair, not whatever activeSlotRef currently points at.
        if (incomingGain) incomingGain.gain.value = progress;
        if (outgoingGain) outgoingGain.gain.value = 1 - progress;
      } else {
        const vol = effectiveVolume();
        if (crossfadeOutgoingRef.current) crossfadeOutgoingRef.current.volume = vol * (1 - progress);
        incoming.volume = vol * progress;
      }

      if (progress >= 1) {
        finishCrossfade();
      }
    }, 16);
  }

  function handleGaplessNext(): boolean {
    // If crossfade is already in progress, the transition is handled
    if (isCrossfadingRef.current) return true;

    if (!preloadedTrackRef.current || !preloadReadyRef.current) return false;

    const nextTrack = preloadedTrackRef.current;
    const inactiveEl = getInactiveAudioElement();
    const activeEl = getActiveAudioElement();

    if (!inactiveEl) return false;

    // Stop the old active element
    if (activeEl) {
      activeEl.pause();
      activeEl.removeAttribute("src");
      activeEl.load();
    }

    // Play the preloaded element immediately. If play() rejects (WKWebView can
    // throw AbortError/NotAllowedError when the load()/pause() above races it),
    // recover via the explicit play path instead of leaving the swap silent —
    // currentTrack has already advanced, so handlePlay re-plays the same track.
    inactiveEl.volume = effectiveVolume();
    inactiveEl.play().catch((e) => {
      console.error("Gapless next play failed, recovering:", e);
      handlePlay(nextTrack, "auto");
    });

    // Swap active slot
    const newSlot = activeSlotRef.current === "A" ? "B" : "A";
    setActiveSlot(newSlot);
    activeSlotRef.current = newSlot;

    trackChangeSourceRef.current = "auto";
    setCurrentTrack(nextTrack);
    prefetchRequestedRef.current = false;
    setCurrentAssetUrl(inactiveEl.src);
    setPlaybackPosition(0);
    setDurationSecs(nextTrack.duration_secs ?? 0);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Clear preload state
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;

    return true;
  }

  async function handlePlay(track: QueueTrack, source: "user" | "auto" = "user") {
    const generation = ++playGenerationRef.current;
    // Mark the explicit-play transition window: until the new source is installed,
    // the timeupdate-driven preload→crossfade machine must stay gated off so a
    // not-fully-stopped outgoing element can't start a fade against the replaced
    // track. Cleared in `finally` (guarded by generation).
    transitioningRef.current = true;
    // A real playback session supersedes any restored preview frame.
    previewLoadedKeyRef.current = null;
    if (eqEnabledRef.current) ensureAudioGraph();
    cancelCrossfade();
    // Forcibly tear down the outgoing media synchronously — not just pause(). The
    // resolveTrackSrc / playWithSrc await window can be long (plugin stream
    // resolvers), and a merely-paused element keeps firing `timeupdate` on WKWebView
    // (pause() is not reliably honored), which would drive the preload→crossfade
    // machine against a track that's being replaced — and could finish naturally,
    // firing onEnded → handleNext("auto") → addToQueueAndPlay against the
    // already-replaced queue. Detaching the source (stopMediaElement) removes both
    // the stray timeupdate and the stray `ended` at the source.
    [audioRefA.current, audioRefB.current].forEach(stopMediaElement);
    stopMediaElement(videoRef.current);
    // Reuse in-flight preload resolution for the same track instead of starting over
    const inflight = preloadPromiseRef.current;
    const reusePreload = inflight !== null && inflight.key === track.key;
    const resolvePromise = reusePreload ? inflight.promise : null;
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      // First resolution: reuse the in-flight preload promise for this track if we
      // have one, else resolve fresh.
      let resolved = resolvePromise
        ? await resolvePromise
        : await resolveTrackSrcRef.current(track);
      // resolveTrackSrc returns an empty-src sentinel whenever ITS resolve
      // generation was bumped mid-flight — by a newer play, but ALSO by a
      // concurrent preload/prefetch or by awaiting an already-superseded reused
      // preload promise. Only the first case (a newer *play*) is safe to bail on
      // silently (that play owns currentTrack). An empty src while THIS play is
      // still current means the *resolve* was superseded but nothing else will
      // start the track — and we've already paused the outgoing audio, so a silent
      // return would freeze playback on the previous track with the queue index
      // already advanced. Recover by re-resolving once.
      let decision = decideHandlePlayOutcome(
        isCurrentPlayGeneration(generation, playGenerationRef.current),
        !!resolved.src,
        false,
      );
      if (decision === "retry") {
        diagnosePlayOutcome("retry", track, generation, reusePreload, !!resolved.src);
        resolved = await resolveTrackSrcRef.current(track);
        decision = decideHandlePlayOutcome(
          isCurrentPlayGeneration(generation, playGenerationRef.current),
          !!resolved.src,
          true,
        );
      }
      // A newer play request superseded this one — it owns currentTrack/audio now.
      if (decision === "bail") {
        diagnosePlayOutcome("bail", track, generation, reusePreload, !!resolved.src);
        return;
      }
      // Still no source after a fresh resolve while we're the current play — a
      // genuine failure. Throw into the catch so the error modal / failed-track UI
      // surfaces it instead of leaving playback paused with a stale now-playing bar.
      if (decision === "fail") {
        diagnosePlayOutcome("fail", track, generation, reusePreload, !!resolved.src);
        throw new Error(`No playback source resolved for: ${track.title}`);
      }
      // Resolution may have discovered the real local file for a path-less /
      // remote track (e.g. a Home track-row that only carried title+artist).
      // Merge that metadata in so playWithSrc routes video → <video> and the
      // now-playing UI classifies it correctly via currentTrack.
      const playTrack = resolved.patch ? { ...track, ...resolved.patch } : track;
      await playWithSrc(playTrack, resolved.src, source, resolved.engineSource);
    } catch (e) {
      // A newer play request has superseded this one: its synchronous
      // pause/load aborted this request's in-flight play(). The rejection is
      // expected and belongs to a track that's no longer current — discard it.
      if (!isCurrentPlayGeneration(generation, playGenerationRef.current)) return;
      console.error("Playback error:", e);
      setCurrentTrack(track);
      surfacePlaybackFailure(e instanceof Error ? e.message : String(e), track, lastPlaySrcRef.current);
    } finally {
      // Only the current play closes the transition window — a superseded play
      // must not clear the newer one's flag (the newer play owns it and will clear
      // it in its own finally once its source is installed).
      if (isCurrentPlayGeneration(generation, playGenerationRef.current)) {
        setLoadingTrack(null);
        transitioningRef.current = false;
      }
    }
  }

  // Latest handlePlay for the once-mounted engine-event subscriptions (the
  // function is recreated every render; the effect's closure would go stale).
  const handlePlayRef = useRef(handlePlay);
  handlePlayRef.current = handlePlay;

  function setPendingSeek(secs: number) {
    pendingSeekRef.current = secs;
  }

  async function handlePlayUrl(track: QueueTrack, url: string) {
    const generation = ++playGenerationRef.current;
    transitioningRef.current = true;
    if (eqEnabledRef.current) ensureAudioGraph();
    cancelCrossfade();
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      await playWithSrc(track, url, "user", url.startsWith("http") ? { kind: "http", url } : null);
    } catch (e) {
      // Superseded by a newer play request — see handlePlay for details.
      if (!isCurrentPlayGeneration(generation, playGenerationRef.current)) return;
      console.error("Playback error:", e);
      setCurrentTrack(track);
      surfacePlaybackFailure(e instanceof Error ? e.message : String(e), track, lastPlaySrcRef.current);
    } finally {
      if (isCurrentPlayGeneration(generation, playGenerationRef.current)) {
        setLoadingTrack(null);
        transitioningRef.current = false;
      }
    }
  }

  async function attemptTranscodeFallback(track: QueueTrack): Promise<boolean> {
    if (!isVideoTrack(track)) return false;
    // A transcode is already starting in a racing caller (play().catch +
    // onLoadedMetadata/onMediaError can fire together). That path owns the
    // outcome — report "handled" so this caller doesn't show the error modal.
    if (transcodeStartingRef.current) return true;
    // We already established a transcode session and it's still erroring — the
    // fallback genuinely didn't help, so let the caller surface the modal.
    if (transcodeSessionRef.current) return false;
    const path = track.path;
    if (!path) return false;
    const parsed = parseUrlScheme(path);
    if (parsed.scheme !== "file") return false;

    transcodeStartingRef.current = true;
    let result: { url: string; sessionId: string; durationSecs: number | null };
    try {
      result = await invoke<{ url: string; sessionId: string; durationSecs: number | null }>("start_transcode", { path: parsed.path });
    } finally {
      transcodeStartingRef.current = false;
    }
    transcodeSessionRef.current = {
      sessionId: result.sessionId,
      baseUrl: result.url.replace(/\?seek=.*$/, ""),
      durationSecs: result.durationSecs ?? null,
      seekOffset: 0,
    };
    if (result.durationSecs && result.durationSecs > 0) {
      setDurationSecs(result.durationSecs);
    }
    if (videoRef.current) {
      videoRef.current.src = result.url;
      videoRef.current.volume = effectiveVolume();
      videoRef.current.play().catch(console.error);
      setPlaying(true);
      // Clear any "not supported" modal a racing detector may have shown —
      // the transcoded H.264 stream is now playing successfully.
      setPlaybackError(null);
      setFailedTrack(null);
    }
    return true;
  }

  async function playWithSrc(track: QueueTrack, src: string, source: "user" | "auto" = "user", engineSource?: EngineSource | null) {
    // Claim the crossfade machinery, not just the elements. A fade may have
    // (re)started during the caller's async resolve window, and since this function
    // forces slot A below, a surviving interval would keep ramping the active slot's
    // gain after we install the new source (→ "started at very low volume"). Idempotent
    // when no fade is running. (handlePlay/handlePlayUrl also gate the machine via
    // transitioningRef; this is the second line of defense at the moment of takeover.)
    cancelCrossfade();
    // Stop all elements
    [audioRefA.current, audioRefB.current].forEach(stopMediaElement);
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }

    const seekTo = pendingSeekRef.current;

    trackChangeSourceRef.current = source;
    setCurrentTrack(track);
    prefetchRequestedRef.current = false;
    setCurrentAssetUrl(src);
    // Recorded so a play() rejection's catch can probe the failing source's host
    // (state would be a stale closure there) — see surfacePlaybackFailure.
    lastPlaySrcRef.current = src;
    setPlaybackPosition(seekTo > 0 ? seekTo : 0);
    setDurationSecs(track.duration_secs ?? 0);
    setIcyTitle(null);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Always reset to slot A on explicit play
    setActiveSlot("A");
    activeSlotRef.current = "A";

    pendingSeekRef.current = 0;

    // Route eligible tracks to the native mpv engine — audio everywhere the
    // engine exists, video additionally gated on the platform's native video
    // capability. On a play-command failure fall straight through to the
    // browser engine (and blocklist the key so the gapless preload path skips
    // native for it too).
    const isVideo = isVideoTrack(track);
    if (
      useNativeEngineRef.current &&
      engineSource &&
      (!isVideo || useNativeVideoRef.current) &&
      !nativeBlockedKeysRef.current.has(track.key)
    ) {
      nativePreloadedRef.current = null;
      nativeFadingRef.current = false;
      nativeLastPositionRef.current = seekTo > 0 ? seekTo : 0;
      nativeSessionRef.current = { key: track.key };
      try {
        await nativeEngine.play({
          source: engineSource,
          trackKey: track.key,
          seekSecs: seekTo > 0 ? seekTo : null,
          volume: volumeRef.current,
          muted: mutedRef.current,
          video: isVideo,
        });
        setPlaying(true);
        setNativeVideoActive(isVideo);
        return;
      } catch (e) {
        console.error("Native engine play failed, falling back to browser engine:", e);
        logPlayback(`Native play failed for "${track.title}" — browser fallback: ${e instanceof Error ? e.message : String(e)}`);
        nativeSessionRef.current = null;
        nativeBlockedKeysRef.current.add(track.key);
      }
    }
    setNativeVideoActive(false);
    // Leaving a native session for the element path: silence the engine.
    if (nativeSessionRef.current) {
      nativeSessionRef.current = null;
      nativePreloadedRef.current = null;
      nativeEngine.stop().catch(console.error);
    }

    if (isVideoTrack(track)) {
      if (videoRef.current) {
        videoRef.current.src = src;
        videoRef.current.volume = effectiveVolume();
        if (seekTo > 0) videoRef.current.currentTime = seekTo;
        try {
          await videoRef.current.play();
        } catch (playErr) {
          const handled = await attemptTranscodeFallback(track);
          if (!handled) throw playErr;
        }
      } else {
        pendingSrcRef.current = src;
        if (seekTo > 0) pendingSeekRef.current = seekTo;
      }
    } else {
      if (audioRefA.current) {
        audioRefA.current.src = src;
        audioRefA.current.volume = effectiveVolume();
        if (seekTo > 0) audioRefA.current.currentTime = seekTo;
        await audioRefA.current.play();
      }
    }
  }

  function handlePause() {
    // Native session: the engine owns play/pause; the media elements are empty.
    // Optimistic UI flip as on the element path; engine-state reconciles.
    if (nativeSessionRef.current) {
      const shouldPause = playing;
      setPlaying(!shouldPause);
      nativeEngine.setPaused(shouldPause).catch((e) => {
        console.error("Native pause toggle failed:", e);
        setPlaying(shouldPause);
      });
      return;
    }
    const el = getMediaElement();
    if (!el) return;
    if (el.paused) {
      // If no source loaded (e.g. restored track), or the element only holds a
      // restored first-frame preview (loadRestoredVideoPreview set src but never
      // played), do a full play so stream resolution + transcode fallback run.
      if (!el.src || el.readyState === 0 || previewLoadedKeyRef.current) {
        if (currentTrack) handlePlay(currentTrack);
        return;
      }
      // If EQ is engaged the element plays through the Web Audio graph; an
      // idle AudioContext gets auto-suspended by WKWebView and stays silent
      // after el.play() until resumed. Resume it synchronously so audio comes
      // back immediately, not on the next graph nudge.
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume().catch(console.error);
      }
      // Flip the UI optimistically: the native 'play' event round-trips
      // through WKWebView's media pipeline tens of ms after we call play(),
      // which makes the button visibly lag the click. onPlay reconciles the
      // truth (idempotent); revert if play() actually rejects.
      setPlaying(true);
      el.play().catch(e => {
        console.error("Resume playback failed:", e);
        setPlaying(false);
      });
    } else {
      cancelCrossfade();
      // Optimistic pause for the same reason — don't wait for the 'pause'
      // event to flip the icon. pause() itself is synchronous.
      setPlaying(false);
      el.pause();
      // DIAGNOSTIC: the user-facing symptom is "I pressed pause and a track
      // kept playing". After pausing the active element, check whether the
      // OTHER element is still producing sound — that confirms an orphan that
      // handlePause can't reach (it only acts on the active slot).
      diagnoseShadowPlayback("handlePause");
    }
  }

  function handleStop() {
    cancelCrossfade();
    invalidatePreload();
    if (nativeSessionRef.current) {
      nativeSessionRef.current = null;
      nativePreloadedRef.current = null;
      nativeFadingRef.current = false;
      nativeEngine.stop().catch(console.error);
    }
    setNativeVideoActive(false);
    setIcyTitle(null);
    const el = getMediaElement();
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPlaying(false);
    setPlaybackPosition(0);
    setCurrentAssetUrl(null);
  }

  // Surface a playback failure to the user. The base message shows immediately;
  // for remote (network-streamed) tracks the network is then probed and the
  // message upgraded to a connectivity error when the connection — not the file —
  // is the real problem (WKWebView reports a failed source fetch as "not
  // supported", see playbackErrors.ts). The functional upgrade only replaces the
  // exact base message, so it never reopens a dismissed modal or clobbers a
  // newer failure.
  function surfacePlaybackFailure(base: string, track: QueueTrack | null, src: string | null) {
    setPlaybackError(base);
    setFailedTrack(track);
    setPlaying(false);
    if (!track || isLocalTrack(track)) return;
    probeNetworkStatus(src).then((network) => {
      const refined = describePlaybackFailure(base, true, network);
      if (refined === base) return;
      setPlaybackError(prev => (prev === base ? refined : prev));
    });
  }

  function onMediaError(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    const el = e.currentTarget;
    const err = el.error;
    if (!err) return;
    // Ignore errors from an element that isn't the one currently driving playback.
    // The handler is shared by audio slot A, slot B, and the <video>; during a track
    // change the outgoing element is torn down and the inactive audio slot may hold a
    // preloaded src, and either can fire a spurious error. Attributing those to the
    // now-current track shows a false "Playback failed" while the active element plays
    // fine. A genuine failure of the current track always fires on the active element.
    const fired: "A" | "B" | "video" =
      el === videoRef.current ? "video" : el === audioRefA.current ? "A" : "B";
    if (!isActiveMediaElement(fired, activeSlotRef.current, !!(currentTrack && isVideoTrack(currentTrack)))) {
      logPlayback(`Ignoring media error from non-active element ${fired} (code ${err.code}); active playback continues`);
      return;
    }
    const msg = mediaErrorMessage(err.code);
    console.error("Media error:", msg, err.message);
    const failingSrc = el.currentSrc || null;

    // Attempt transcode fallback for decode/format errors on local video tracks
    if ((err.code === 3 || err.code === 4) && currentTrack) {
      const track = currentTrack;
      attemptTranscodeFallback(track)
        .then((handled) => {
          if (!handled) surfacePlaybackFailure(msg, track, failingSrc);
        })
        .catch((te) => {
          console.error("Transcode fallback failed:", te);
          surfacePlaybackFailure(msg, track, failingSrc);
        });
      return;
    }

    surfacePlaybackFailure(msg, currentTrack, failingSrc);
  }

  function clearPlaybackError() {
    setPlaybackError(null);
    setFailedTrack(null);
  }

  function handleVolume(level: number) {
    setVolume(level);
  }

  function toggleMute() {
    setMuted(m => !m);
  }

  function handleSeek(secs: number) {
    if (nativeSessionRef.current) {
      nativeLastPositionRef.current = secs;
      nativeEngine.seek(secs).catch(console.error);
      setPlaybackPosition(secs);
      return;
    }
    const el = getMediaElement();
    if (!el) return;

    if (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack)) {
      transcodeSessionRef.current.seekOffset = secs;
      const url = `${transcodeSessionRef.current.baseUrl}?seek=${secs}`;
      (el as HTMLVideoElement).src = url;
      (el as HTMLVideoElement).play().catch(console.error);
      setPlaybackPosition(secs);
      return;
    }

    el.currentTime = secs;
    setPlaybackPosition(secs);
  }

  // Relative seek (skip forward/back). For a transcoded video the element's
  // currentTime is relative to the current ffmpeg segment, which restarts at 0
  // on every seek — so the true position is currentTime + seekOffset. Reading
  // el.currentTime directly here would make a skip-ahead jump back to the start.
  function seekBy(deltaSecs: number) {
    if (nativeSessionRef.current) {
      const current = nativeLastPositionRef.current;
      const target = durationSecs > 0
        ? Math.max(0, Math.min(durationSecs, current + deltaSecs))
        : Math.max(0, current + deltaSecs);
      handleSeek(target);
      return;
    }
    const el = getMediaElement();
    if (!el) return;

    const transcodeSession = (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack))
      ? transcodeSessionRef.current
      : null;
    const offset = transcodeSession ? transcodeSession.seekOffset : 0;
    const current = el.currentTime + offset;
    const duration = transcodeSession?.durationSecs ?? (isFinite(el.duration) ? el.duration : 0);
    const target = duration > 0
      ? Math.max(0, Math.min(duration, current + deltaSecs))
      : Math.max(0, current + deltaSecs);
    handleSeek(target);
  }

  function isActiveElement(el: HTMLMediaElement): boolean {
    if (currentTrack && isVideoTrack(currentTrack)) {
      return el === videoRef.current;
    }
    return el === getActiveAudioElement();
  }

  function onTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    const el = e.target as HTMLMediaElement;
    // Run shadow detection BEFORE the active-element guard: a timeupdate from
    // the INACTIVE element while it's playing (and no crossfade) is exactly the
    // orphan we're hunting. The active-element guard below would hide it.
    diagnoseShadowPlayback("timeupdate");
    const isActive = isActiveElement(el);
    if (!isActive) return;

    const transcodeSession = (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack))
      ? transcodeSessionRef.current
      : null;
    const transcodeOffset = transcodeSession ? transcodeSession.seekOffset : 0;
    const absolutePosition = el.currentTime + transcodeOffset;
    setPlaybackPosition(absolutePosition);

    // Scrobble threshold check (Last.FM rules) — optionally skip video tracks
    if (!scrobbledRef.current && currentTrack && (trackVideoHistoryRef.current || !isVideoTrack(currentTrack))) {
      if (shouldScrobble(absolutePosition, currentTrack.duration_secs)) {
        scrobbledRef.current = true;
        setScrobbled(true);
        invoke("record_play", { title: currentTrack.title, artistName: currentTrack.artist_name }).catch(console.error);
      }
    }

    const transcodeDuration = transcodeSession?.durationSecs ?? null;
    const effectiveDuration = transcodeDuration ?? (isFinite(el.duration) ? el.duration : 0);
    const effectivePosition = transcodeSession ? absolutePosition : el.currentTime;
    // Gate the preload→crossfade machine: only in the settled playing state (active
    // element + no explicit play mid-transition). During a transition the outgoing
    // element can keep firing timeupdate (WKWebView ignores pause()) while it's still
    // the active slot — letting it start a fade hands one to a track the incoming
    // explicit play doesn't own. Position/scrobble above still run; only the machine
    // is gated.
    if (canDriveTransitionMachine(isActive, transitioningRef.current)) {
      const actions = driveProgressMachine({
        position: effectivePosition,
        duration: effectiveDuration,
        crossfadeSecs: crossfadeSecsRef.current,
        next: peekNextRef.current(),
        preloadedKey: preloadedTrackRef.current?.key ?? null,
        preloadReady: preloadReadyRef.current,
        isPreloading: isPreloadingRef.current,
        isCrossfading: isCrossfadingRef.current,
        prefetchRequested: prefetchRequestedRef.current,
      });
      if (actions.requestPrefetch) {
        logPlayback(`Prefetch: requesting auto-continue (${(effectiveDuration - effectivePosition).toFixed(1)}s remaining)`);
        prefetchRequestedRef.current = true;
        prefetchNextRef.current();
      }
      if (actions.invalidatePreload) invalidatePreload();
      if (actions.preloadTrack) preloadNext(actions.preloadTrack);
      if (actions.startCrossfade) startCrossfade();
    }
  }

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    const el = e.target as HTMLMediaElement;
    if (!isActiveElement(el)) return;
    const transcodeDuration = (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack))
      ? transcodeSessionRef.current.durationSecs
      : null;
    if (transcodeDuration && transcodeDuration > 0) {
      setDurationSecs(transcodeDuration);
    } else if (isFinite(el.duration)) {
      setDurationSecs(el.duration);
    }

    // A zero-width video means the container parsed but the video stream
    // couldn't be decoded. If we're already playing a transcoded stream, the
    // output is valid H.264 — ignore. Otherwise, try the ffmpeg fallback first
    // and only surface the modal if that fails (mirrors onMediaError).
    if (el instanceof HTMLVideoElement && el.videoWidth === 0 && !transcodeSessionRef.current) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      if (currentTrack) {
        const track = currentTrack;
        attemptTranscodeFallback(track)
          .then((handled) => {
            if (!handled) {
              setPlaybackError("Video codec not supported");
              setFailedTrack(track);
              setPlaying(false);
            }
          })
          .catch((te) => {
            console.error("Transcode fallback failed:", te);
            setPlaybackError("Video codec not supported");
            setFailedTrack(track);
            setPlaying(false);
          });
      } else {
        setPlaybackError("Video codec not supported");
        setFailedTrack(currentTrack);
        setPlaying(false);
      }
    }
  }

  function onPlay() { setPlaying(true); }
  function onPause() {
    if (!wasPlayingBeforeHideRef.current) setPlaying(false);
  }

  // Slot-safe event handlers that use activeSlotRef (not stale state)
  function onEndedSlotA(callback: () => void) {
    if (activeSlotRef.current === "A") callback();
  }
  function onEndedSlotB(callback: () => void) {
    if (activeSlotRef.current === "B") callback();
  }
  function onPlaySlotA() {
    if (activeSlotRef.current === "A") onPlay();
  }
  function onPlaySlotB() {
    if (activeSlotRef.current === "B") onPlay();
  }
  function onPauseSlotA() {
    if (activeSlotRef.current === "A") onPause();
  }
  function onPauseSlotB() {
    if (activeSlotRef.current === "B") onPause();
  }

  function toggleFullscreen() {
    // Native video session: window fullscreen + the native-fs container pin
    // (see the nativeFullscreen state above).
    if (nativeSessionRef.current && currentTrack && isVideoTrack(currentTrack)) {
      const next = !nativeFullscreen;
      setNativeFullscreen(next);
      setWindowFullscreen(next);
      return;
    }
    const container = videoRef.current?.parentElement;
    if (!container) return;
    // Ignore a toggle while a previous enter/exit is still in flight — firing a
    // second activation-consuming call mid-transition is what triggers WKWebView's
    // "Cannot request fullscreen without transient activation" rejection.
    if (fullscreenPendingRef.current) return;
    fullscreenPendingRef.current = true;
    // Clear the guard exactly once, on whichever fires first: the transition's
    // `fullscreenchange`, a promise rejection, or a fail-safe timeout. The timeout
    // matters — if `fullscreenchange` never arrives (e.g. the macOS fullscreen
    // animation is interrupted/cancelled) the guard would otherwise stay stuck at
    // `true`, silently turning every later toggle into a no-op until some unrelated
    // fullscreenchange happened to clear it. 2s comfortably outlasts a real
    // transition, so by then it's either done (already cleared) or genuinely wedged.
    let cleared = false;
    let failSafe: ReturnType<typeof setTimeout>;
    const clear = () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(failSafe);
      document.removeEventListener("fullscreenchange", clear);
      fullscreenPendingRef.current = false;
    };
    document.addEventListener("fullscreenchange", clear, { once: true });
    failSafe = setTimeout(clear, 2000);
    const onError = (e: unknown) => {
      clear();
      console.error("Failed to toggle fullscreen:", e);
    };
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(onError);
    } else {
      container.requestFullscreen().catch(onError);
    }
  }

  return {
    currentTrack, setCurrentTrack,
    trackChangeSourceRef,
    currentAssetUrl,
    playing, setPlaying, scrobbled,
    durationSecs, setDurationSecs,
    volume, setVolume,
    muted, setMuted, toggleMute,
    activeSlot,
    audioRefA, audioRefB, videoRef,
    getMediaElement,
    handlePlay, setPendingSeek, handlePlayUrl, handlePause, handleStop,
    loadRestoredVideoPreview,
    handleVolume, handleSeek, seekBy,
    handleGaplessNext, invalidatePreload,
    onTimeUpdate, onLoadedMetadata, onPlay, onPause, onMediaError,
    isActiveElement,
    onEndedSlotA, onEndedSlotB,
    onPlaySlotA, onPlaySlotB,
    onPauseSlotA, onPauseSlotB,
    toggleFullscreen,
    nativeVideoActive,
    nativeFullscreen,
    icyTitle,
    playbackError, failedTrack, clearPlaybackError,
    loadingTrack,
    eqEnabled, setEqEnabled,
    eqMode, setEqMode,
    eqPreset, setEqPreset,
    eqGains, setEqGains,
    eqPreGainDb, setEqPreGainDb,
    eqBassDb, setEqBassDb,
    eqTrebleDb, setEqTrebleDb,
    rgMode, setRgMode,
    rgPreampDb, setRgPreampDb,
    rgPreventClip, setRgPreventClip,
  };
}
