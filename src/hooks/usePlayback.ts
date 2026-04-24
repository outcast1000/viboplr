import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { store } from "../store";

function logPlayback(message: string) {
  invoke("write_frontend_log", { level: "info", message, section: "playback" }).catch(() => {});
}

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => Track | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
  trackVideoHistoryRef: React.RefObject<boolean>,
  resolveTrackSrcRef: React.RefObject<(track: Track) => Promise<string>>,
  prefetchNextRef: React.RefObject<() => void>,
) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSecs, setPositionSecs] = useState(0);
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [activeSlot, setActiveSlot] = useState<"A" | "B">("A");
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
  const [failedTrack, setFailedTrack] = useState<Track | null>(null);
  const [currentAssetUrl, setCurrentAssetUrl] = useState<string | null>(null);
  const [loadingTrack, setLoadingTrack] = useState<Track | null>(null);
  const playStartedAtRef = useRef(0);

  // Preload state (refs for use in event handlers without stale closures)
  const preloadedTrackRef = useRef<Track | null>(null);
  const preloadReadyRef = useRef(false);
  const isPreloadingRef = useRef(false);
  const prefetchRequestedRef = useRef(false);

  // Crossfade state
  const isCrossfadingRef = useRef(false);
  const crossfadeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const crossfadeOutgoingRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef(volume);
  const wasPlayingBeforeHideRef = useRef(false);

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

  // Sync volume ref and media elements when volume changes
  useEffect(() => {
    volumeRef.current = volume;
    // During crossfade, rAF handles volume — skip direct sets
    if (isCrossfadingRef.current) return;
    if (audioRefA.current) audioRefA.current.volume = volume;
    if (audioRefB.current) audioRefB.current.volume = volume;
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

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
      videoRef.current.volume = volumeRef.current;
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
    if (currentTrack) logPlayback(`Track changed: ${currentTrack.artist_name ?? "?"} — ${currentTrack.title} (id=${currentTrack.id})`);
  }, [currentTrack]);
  useEffect(() => { if (restoredRef.current) store.set("positionSecs", positionSecs); }, [positionSecs]);
  useEffect(() => { if (restoredRef.current) store.set("volume", volume); }, [volume]);

  function invalidatePreload() {
    cancelCrossfade();
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;
    isPreloadingRef.current = false;

    const inactiveEl = getInactiveAudioElement();
    if (inactiveEl) {
      inactiveEl.pause();
      inactiveEl.removeAttribute("src");
      inactiveEl.load();
    }
  }

  async function preloadNext(nextTrack: Track) {
    if (isPreloadingRef.current) return;
    if (isVideoTrack(nextTrack)) {
      preloadedTrackRef.current = null;
      preloadReadyRef.current = false;
      return;
    }

    isPreloadingRef.current = true;
    logPlayback(`Preload: resolving "${nextTrack.artist_name ?? "?"} — ${nextTrack.title}"`);
    try {
      const src = await resolveTrackSrcRef.current(nextTrack);
      logPlayback(`Preload: resolved "${nextTrack.title}"`);

      const inactiveEl = getInactiveAudioElement();
      if (!inactiveEl) return;

      inactiveEl.src = src;
      inactiveEl.volume = volumeRef.current;
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
    if (activeEl) activeEl.volume = volumeRef.current;

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
    if (activeEl) activeEl.volume = volumeRef.current;

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
    incoming.volume = 0;
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

      const vol = volumeRef.current;
      if (crossfadeOutgoingRef.current) {
        crossfadeOutgoingRef.current.volume = vol * (1 - progress);
      }
      incoming.volume = vol * progress;

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
    inactiveEl.volume = volumeRef.current;
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

  async function handlePlay(track: Track, source: "user" | "auto" = "user") {
    cancelCrossfade();
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      const src = await resolveTrackSrcRef.current(track);
      await playWithSrc(track, src, source);
    } catch (e) {
      console.error("Playback error:", e);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      setLoadingTrack(null);
    }
  }

  async function handlePlayUrl(track: Track, url: string) {
    cancelCrossfade();
    invalidatePreload();
    setPlaybackError(null);
    setLoadingTrack(track);

    try {
      await playWithSrc(track, url);
    } catch (e) {
      console.error("Playback error:", e);
      setPlaybackError(e instanceof Error ? e.message : String(e));
      setFailedTrack(track);
    } finally {
      setLoadingTrack(null);
    }
  }

  async function playWithSrc(track: Track, src: string, source: "user" | "auto" = "user") {
    // Stop all elements
    [audioRefA.current, audioRefB.current].forEach(el => {
      if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
    });
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.removeAttribute("src");
      videoRef.current.load();
    }

    trackChangeSourceRef.current = source;
    setCurrentTrack(track);
    prefetchRequestedRef.current = false;
    setCurrentAssetUrl(src);
    setPositionSecs(0);
    setDurationSecs(track.duration_secs ?? 0);
    scrobbledRef.current = false;
    setScrobbled(false);
    playStartedAtRef.current = Math.floor(Date.now() / 1000);

    // Always reset to slot A on explicit play
    setActiveSlot("A");
    activeSlotRef.current = "A";

    if (isVideoTrack(track)) {
      if (videoRef.current) {
        videoRef.current.src = src;
        videoRef.current.volume = volumeRef.current;
        await videoRef.current.play();
      } else {
        pendingSrcRef.current = src;
      }
    } else {
      if (audioRefA.current) {
        audioRefA.current.src = src;
        audioRefA.current.volume = volumeRef.current;
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

  function handleSeek(secs: number) {
    const el = getMediaElement();
    if (el) {
      el.currentTime = secs;
      setPositionSecs(secs);
    }
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

    setPositionSecs(el.currentTime);

    // Scrobble threshold check (Last.FM rules) — optionally skip video tracks
    if (!scrobbledRef.current && currentTrack && (trackVideoHistoryRef.current || !isVideoTrack(currentTrack))) {
      if (shouldScrobble(el.currentTime, currentTrack.duration_secs)) {
        scrobbledRef.current = true;
        setScrobbled(true);
        invoke("record_play", { trackId: currentTrack.id }).catch(console.error);
      }
    }

    if (el.duration > 0 && el.duration - el.currentTime > 0) {
      const remaining = el.duration - el.currentTime;
      const cfSecs = crossfadeSecsRef.current;
      const preloadAt = 20;

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
          if (preloadedTrackRef.current?.id !== next.id) {
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
    setDurationSecs(el.duration);
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
    activeSlot,
    audioRefA, audioRefB, videoRef,
    getMediaElement,
    handlePlay, handlePlayUrl, handlePause, handleStop,
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
  };
}
