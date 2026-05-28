import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { parseUrlScheme } from "../queueEntry";
import { store } from "../store";
import {
  BANDS,
  BAND_Q,
  NUM_BANDS,
  applyGainsToFilters,
} from "../eqPresets";

function logPlayback(message: string) {
  invoke("write_frontend_log", { level: "info", message, section: "playback" }).catch(() => {});
}

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => QueueTrack | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  trackVideoHistoryRef: React.RefObject<boolean>,
  resolveTrackSrcRef: React.RefObject<(track: QueueTrack) => Promise<string>>,
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
  const [eqPreset, setEqPreset] = useState<string>("flat");
  const [eqGains, setEqGains] = useState<number[]>(() => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const [eqPreGainDb, setEqPreGainDb] = useState<number>(0);
  const trackChangeSourceRef = useRef<"user" | "auto">("user");

  const audioRefA = useRef<HTMLAudioElement>(null);
  const audioRefB = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;

  const pendingSrcRef = useRef<string | null>(null);
  const pendingAutoPlayRef = useRef(true);
  const pendingSeekRef = useRef(0);
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
  const preloadPromiseRef = useRef<{ key: string; promise: Promise<string> } | null>(null);

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

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceARef = useRef<MediaElementAudioSourceNode | null>(null);
  const sourceBRef = useRef<MediaElementAudioSourceNode | null>(null);
  const filtersARef = useRef<BiquadFilterNode[]>([]);
  const filtersBRef = useRef<BiquadFilterNode[]>([]);
  const xfadeGainARef = useRef<GainNode | null>(null);
  const xfadeGainBRef = useRef<GainNode | null>(null);
  const masterGainRef = useRef<GainNode | null>(null);
  const eqEnabledRef = useRef(eqEnabled);
  const eqGainsRef = useRef<number[]>(eqGains);
  const eqPreGainDbRef = useRef<number>(eqPreGainDb);
  eqEnabledRef.current = eqEnabled;
  eqGainsRef.current = eqGains;
  eqPreGainDbRef.current = eqPreGainDb;

  function masterGainValue(): number {
    const linear = Math.pow(10, (eqEnabledRef.current ? eqPreGainDbRef.current : 0) / 20);
    return effectiveVolume() * linear;
  }

  function applyEqToFilters(): void {
    const gains = eqEnabledRef.current ? eqGainsRef.current : new Array(NUM_BANDS).fill(0);
    if (filtersARef.current.length) applyGainsToFilters(filtersARef.current, gains);
    if (filtersBRef.current.length) applyGainsToFilters(filtersBRef.current, gains);
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

    const masterGain = ctx.createGain();
    masterGain.gain.value = masterGainValue();
    masterGain.connect(ctx.destination);
    masterGainRef.current = masterGain;

    function buildChain(el: HTMLAudioElement): {
      source: MediaElementAudioSourceNode;
      filters: BiquadFilterNode[];
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
      const xfadeGain = ctx.createGain();
      xfadeGain.gain.value = 1;

      source.connect(filters[0]);
      for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
      filters[filters.length - 1].connect(xfadeGain);
      xfadeGain.connect(masterGain);
      return { source, filters, xfadeGain };
    }

    const a = buildChain(elA);
    const b = buildChain(elB);
    sourceARef.current = a.source;
    sourceBRef.current = b.source;
    filtersARef.current = a.filters;
    filtersBRef.current = b.filters;
    xfadeGainARef.current = a.xfadeGain;
    xfadeGainBRef.current = b.xfadeGain;

    applyEqToFilters();
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
    eqGainsRef.current = eqGains;
    eqPreGainDbRef.current = eqPreGainDb;
    // Lazily build the Web Audio graph the first time EQ is actually engaged.
    // Until then, audio plays through the native HTMLMediaElement path for
    // snappier play/pause/mute response.
    if (eqEnabled && !audioCtxRef.current) ensureAudioGraph();
    applyEqToFilters();
    if (masterGainRef.current) masterGainRef.current.gain.value = masterGainValue();
  }, [eqEnabled, eqGains, eqPreGainDb]);

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
      const src = await resolvePromise;
      logPlayback(`Preload: resolved "${nextTrack.title}"`);

      const inactiveEl = getInactiveAudioElement();
      if (!inactiveEl) return;

      inactiveEl.src = src;
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
    incoming.play().catch(console.error);

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

    // Play the preloaded element immediately
    inactiveEl.volume = effectiveVolume();
    inactiveEl.play().catch(console.error);

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
    const reusePreload = inflight && inflight.key === track.key;
    const resolvePromise = reusePreload ? inflight.promise : null;
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      const src = resolvePromise
        ? await resolvePromise
        : await resolveTrackSrcRef.current(track);
      await playWithSrc(track, src, source);
    } catch (e) {
      console.error("Playback error:", e);
      setCurrentTrack(track);
      setPlaying(false);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      setLoadingTrack(null);
    }
  }

  function setPendingSeek(secs: number) {
    pendingSeekRef.current = secs;
  }

  async function handlePlayUrl(track: QueueTrack, url: string) {
    if (eqEnabledRef.current) ensureAudioGraph();
    cancelCrossfade();
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      await playWithSrc(track, url);
    } catch (e) {
      console.error("Playback error:", e);
      setCurrentTrack(track);
      setPlaying(false);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      setLoadingTrack(null);
    }
  }

  async function attemptTranscodeFallback(track: QueueTrack): Promise<boolean> {
    if (!isVideoTrack(track) || transcodeSessionRef.current) return false;
    const path = track.path;
    if (!path) return false;
    const parsed = parseUrlScheme(path);
    if (parsed.scheme !== "file") return false;

    const result = await invoke<{ url: string; sessionId: string; durationSecs: number | null }>("start_transcode", { path: parsed.path });
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
      // If no source loaded (e.g. restored track), do a full play
      if (!el.src || el.readyState === 0) {
        if (currentTrack) handlePlay(currentTrack);
        return;
      }
      el.play();
    } else {
      cancelCrossfade();
      el.pause();
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

  function isActiveElement(el: HTMLMediaElement): boolean {
    if (currentTrack && isVideoTrack(currentTrack)) {
      return el === videoRef.current;
    }
    return el === getActiveAudioElement();
  }

  function onTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    const el = e.target as HTMLMediaElement;
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

    if (el instanceof HTMLVideoElement && el.videoWidth === 0) {
      el.pause();
      el.removeAttribute("src");
      el.load();
      setPlaybackError("Video codec not supported");
      setFailedTrack(currentTrack);
      setPlaying(false);
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
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
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
    handleVolume, handleSeek,
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
    eqPreset, setEqPreset,
    eqGains, setEqGains,
    eqPreGainDb, setEqPreGainDb,
  };
}
