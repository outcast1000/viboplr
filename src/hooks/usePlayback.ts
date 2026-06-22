import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack, ResolvedTrackSource } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { parseUrlScheme, isLocalTrack } from "../queueEntry";
import { store } from "../store";
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

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => QueueTrack | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  trackVideoHistoryRef: React.RefObject<boolean>,
  resolveTrackSrcRef: React.RefObject<(track: QueueTrack) => Promise<ResolvedTrackSource>>,
  prefetchNextRef: React.RefObject<() => void>,
  transcodeSessionRef: React.RefObject<{ sessionId: string; baseUrl: string; durationSecs: number | null; seekOffset: number } | null>,
) {
  const [currentTrack, setCurrentTrack] = useState<QueueTrack | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSecs, setPositionSecs] = useState(0);
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
  eqEnabledRef.current = eqEnabled;
  eqModeRef.current = eqMode;
  eqGainsRef.current = eqGains;
  eqPreGainDbRef.current = eqPreGainDb;
  eqBassDbRef.current = eqBassDb;
  eqTrebleDbRef.current = eqTrebleDb;

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

      source.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(lowShelf);
      lowShelf.connect(highShelf);
      highShelf.connect(xfadeGain);
      xfadeGain.connect(masterGain);
      return { source, filters, shelves, xfadeGain };
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
  }, [eqEnabled, eqMode, eqGains, eqPreGainDb, eqBassDb, eqTrebleDb]);

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
  useEffect(() => { if (restoredRef.current) store.set("positionSecs", positionSecs); }, [positionSecs]);
  useEffect(() => { if (restoredRef.current) store.set("volume", volume); }, [volume]);

  function invalidatePreload() {
    cancelCrossfade();
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;
    isPreloadingRef.current = false;
    preloadPromiseRef.current = null;

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
      inactiveEl.volume = effectiveVolume();
      inactiveEl.preload = "auto";

      preloadedTrackRef.current = nextTrack;
      preloadReadyRef.current = false;

      const onCanPlay = () => {
        logPlayback(`Preload: audio ready for "${nextTrack.title}"`);
        preloadReadyRef.current = true;
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
    setPositionSecs(0);
    setDurationSecs(nextTrack.duration_secs ?? 0);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Start incoming element
    incoming.volume = effectiveVolume();
    const incomingGain = activeSlotRef.current === "A" ? xfadeGainARef.current : xfadeGainBRef.current;
    const outgoingGain = activeSlotRef.current === "A" ? xfadeGainBRef.current : xfadeGainARef.current;
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
        const inGain = activeSlotRef.current === "A" ? xfadeGainARef.current : xfadeGainBRef.current;
        const outGain = activeSlotRef.current === "A" ? xfadeGainBRef.current : xfadeGainARef.current;
        if (inGain) inGain.gain.value = progress;
        if (outGain) outGain.gain.value = 1 - progress;
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
    setPositionSecs(0);
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
    // A real playback session supersedes any restored preview frame.
    previewLoadedKeyRef.current = null;
    if (eqEnabledRef.current) ensureAudioGraph();
    cancelCrossfade();
    // Pause the outgoing audio synchronously so its `ended` event can't fire
    // during the async resolveTrackSrc / playWithSrc await window. Without this
    // pause, the previously-playing track can finish naturally between the user
    // initiating a new play and `playWithSrc` actually swapping the source —
    // that fires onEnded → handleNext("auto") → addToQueueAndPlay against the
    // already-replaced queue, leaking the old track or a stray auto-continue
    // pick into the new queue.
    [audioRefA.current, audioRefB.current].forEach(el => { if (el) el.pause(); });
    if (videoRef.current) videoRef.current.pause();
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
      await playWithSrc(playTrack, resolved.src, source);
    } catch (e) {
      // A newer play request has superseded this one: its synchronous
      // pause/load aborted this request's in-flight play(). The rejection is
      // expected and belongs to a track that's no longer current — discard it.
      if (!isCurrentPlayGeneration(generation, playGenerationRef.current)) return;
      console.error("Playback error:", e);
      setCurrentTrack(track);
      setPlaying(false);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      if (isCurrentPlayGeneration(generation, playGenerationRef.current)) setLoadingTrack(null);
    }
  }

  function setPendingSeek(secs: number) {
    pendingSeekRef.current = secs;
  }

  async function handlePlayUrl(track: QueueTrack, url: string) {
    const generation = ++playGenerationRef.current;
    if (eqEnabledRef.current) ensureAudioGraph();
    cancelCrossfade();
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      await playWithSrc(track, url);
    } catch (e) {
      // Superseded by a newer play request — see handlePlay for details.
      if (!isCurrentPlayGeneration(generation, playGenerationRef.current)) return;
      console.error("Playback error:", e);
      setCurrentTrack(track);
      setPlaying(false);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      if (isCurrentPlayGeneration(generation, playGenerationRef.current)) setLoadingTrack(null);
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

  async function playWithSrc(track: QueueTrack, src: string, source: "user" | "auto" = "user") {
    // Stop all elements
    [audioRefA.current, audioRefB.current].forEach(el => {
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
    });
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
    setPositionSecs(seekTo > 0 ? seekTo : 0);
    setDurationSecs(track.duration_secs ?? 0);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Always reset to slot A on explicit play
    setActiveSlot("A");
    activeSlotRef.current = "A";

    pendingSeekRef.current = 0;

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
    const el = getMediaElement();
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPlaying(false);
    setPositionSecs(0);
    setCurrentAssetUrl(null);
  }

  function onMediaError(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    const el = e.currentTarget;
    const err = el.error;
    if (!err) return;
    const messages: Record<number, string> = {
      1: "Playback aborted",
      2: "Network error during playback",
      3: "File could not be decoded — format may not be supported",
      4: "File format not supported",
    };
    const msg = messages[err.code] || `Playback error (code ${err.code})`;
    console.error("Media error:", msg, err.message);

    // Attempt transcode fallback for decode/format errors on local video tracks
    if ((err.code === 3 || err.code === 4) && currentTrack) {
      attemptTranscodeFallback(currentTrack)
        .then((handled) => {
          if (!handled) {
            setPlaybackError(msg);
            setFailedTrack(currentTrack);
            setPlaying(false);
          }
        })
        .catch((te) => {
          console.error("Transcode fallback failed:", te);
          setPlaybackError(msg);
          setFailedTrack(currentTrack);
          setPlaying(false);
        });
      return;
    }

    setPlaybackError(msg);
    setFailedTrack(currentTrack);
    setPlaying(false);
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
    const el = getMediaElement();
    if (!el) return;

    if (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack)) {
      transcodeSessionRef.current.seekOffset = secs;
      const url = `${transcodeSessionRef.current.baseUrl}?seek=${secs}`;
      (el as HTMLVideoElement).src = url;
      (el as HTMLVideoElement).play().catch(console.error);
      setPositionSecs(secs);
      return;
    }

    el.currentTime = secs;
    setPositionSecs(secs);
  }

  // Relative seek (skip forward/back). For a transcoded video the element's
  // currentTime is relative to the current ffmpeg segment, which restarts at 0
  // on every seek — so the true position is currentTime + seekOffset. Reading
  // el.currentTime directly here would make a skip-ahead jump back to the start.
  function seekBy(deltaSecs: number) {
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
    if (!isActiveElement(el)) return;

    const transcodeSession = (transcodeSessionRef.current && currentTrack && isVideoTrack(currentTrack))
      ? transcodeSessionRef.current
      : null;
    const transcodeOffset = transcodeSession ? transcodeSession.seekOffset : 0;
    const absolutePosition = el.currentTime + transcodeOffset;
    setPositionSecs(absolutePosition);

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
    if (effectiveDuration > 0 && effectiveDuration - effectivePosition > 0) {
      const remaining = effectiveDuration - effectivePosition;
      const cfSecs = crossfadeSecsRef.current;
      const nextPeek = peekNextRef.current();
      const needsStreamResolve = nextPeek && (!nextPeek.path || (!nextPeek.path.startsWith("file://") && !nextPeek.path.startsWith("http")));
      const preloadAt = needsStreamResolve ? 45 : 20;

      if (remaining <= preloadAt) {
        // If no next track in queue, request auto-continue prefetch
        if (!prefetchRequestedRef.current && !peekNextRef.current()) {
          logPlayback(`Prefetch: requesting auto-continue (${remaining.toFixed(1)}s remaining)`);
          prefetchRequestedRef.current = true;
          prefetchNextRef.current();
        }

        // Preload the next track if available
        const next = peekNextRef.current();
        if (next) {
          if (preloadedTrackRef.current?.key !== next.key) {
            if (preloadedTrackRef.current) invalidatePreload();
            if (!isPreloadingRef.current) preloadNext(next);
            return;
          }
        }
      }

      // Crossfade trigger
      if (
        remaining <= cfSecs &&
        cfSecs > 0 &&
        preloadReadyRef.current &&
        !isCrossfadingRef.current
      ) {
        startCrossfade();
      }
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
    positionSecs, setPositionSecs,
    durationSecs, setDurationSecs,
    volume, setVolume,
    muted, toggleMute,
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
    playbackError, failedTrack, clearPlaybackError,
    loadingTrack,
    eqEnabled, setEqEnabled,
    eqMode, setEqMode,
    eqPreset, setEqPreset,
    eqGains, setEqGains,
    eqPreGainDb, setEqPreGainDb,
    eqBassDb, setEqBassDb,
    eqTrebleDb, setEqTrebleDb,
  };
}
