import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { isVideoTrack, shouldScrobble } from "../utils";
import { store } from "../store";

export function usePlayback(
  restoredRef: React.RefObject<boolean>,
  peekNextRef: React.RefObject<() => Track | null>,
  crossfadeSecsRef: React.RefObject<number>,
  advanceIndexRef: React.RefObject<() => void>,
) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSecs, setPositionSecs] = useState(0);
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [activeSlot, setActiveSlot] = useState<"A" | "B">("A");

  const audioRefA = useRef<HTMLAudioElement>(null);
  const audioRefB = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeSlotRef = useRef(activeSlot);
  activeSlotRef.current = activeSlot;

  const pendingSrcRef = useRef<string | null>(null);
  const pendingAutoPlayRef = useRef(true);
  const pendingSeekRef = useRef(0);
  const scrobbledRef = useRef(false);

  // Preload state (refs for use in event handlers without stale closures)
  const preloadedTrackRef = useRef<Track | null>(null);
  const preloadReadyRef = useRef(false);
  const isPreloadingRef = useRef(false);

  // Crossfade state
  const isCrossfadingRef = useRef(false);
  const crossfadeRafRef = useRef<number | null>(null);
  const crossfadeOutgoingRef = useRef<HTMLAudioElement | null>(null);
  const volumeRef = useRef(volume);

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
      videoRef.current.volume = volume;
      if (seekTo > 0) videoRef.current.currentTime = seekTo;
      if (autoPlay) {
        videoRef.current.play().catch(e => console.error("Video play error:", e));
      }
    }
  }, [currentTrack]);

  // Persist state
  useEffect(() => { if (restoredRef.current) store.set("currentTrackId", currentTrack?.id ?? null); }, [currentTrack]);
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
    try {
      const pathOrUrl = await invoke<string>("get_track_path", { trackId: nextTrack.id });
      const src = nextTrack.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

      const inactiveEl = getInactiveAudioElement();
      if (!inactiveEl) return;

      inactiveEl.src = src;
      inactiveEl.volume = volume;
      inactiveEl.preload = "auto";

      preloadedTrackRef.current = nextTrack;
      preloadReadyRef.current = false;

      const onCanPlay = () => {
        preloadReadyRef.current = true;
        inactiveEl.removeEventListener("canplay", onCanPlay);
      };
      inactiveEl.addEventListener("canplay", onCanPlay);
    } catch (e) {
      console.error("Preload error:", e);
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

    isCrossfadingRef.current = false;
    crossfadeRafRef.current = null;
    crossfadeOutgoingRef.current = null;
  }

  function cancelCrossfade() {
    if (!isCrossfadingRef.current) return;

    if (crossfadeRafRef.current !== null) {
      cancelAnimationFrame(crossfadeRafRef.current);
      crossfadeRafRef.current = null;
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
    setCurrentTrack(nextTrack);
    setPositionSecs(0);
    setDurationSecs(nextTrack.duration_secs ?? 0);
    scrobbledRef.current = false;

    // Start incoming element
    incoming.volume = 0;
    incoming.play().catch(console.error);

    advanceIndexRef.current();

    // Clear preload state
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;

    // rAF crossfade loop
    const startTime = performance.now();
    const fadeDuration = crossfadeSecsRef.current * 1000;

    function tick() {
      const elapsed = performance.now() - startTime;
      const progress = Math.min(elapsed / fadeDuration, 1);

      const vol = volumeRef.current;
      if (crossfadeOutgoingRef.current) {
        crossfadeOutgoingRef.current.volume = vol * (1 - progress);
      }
      incoming.volume = vol * progress;

      if (progress >= 1) {
        finishCrossfade();
      } else {
        crossfadeRafRef.current = requestAnimationFrame(tick);
      }
    }

    crossfadeRafRef.current = requestAnimationFrame(tick);
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
    inactiveEl.volume = volume;
    inactiveEl.play().catch(console.error);

    // Swap active slot
    const newSlot = activeSlotRef.current === "A" ? "B" : "A";
    setActiveSlot(newSlot);
    activeSlotRef.current = newSlot;

    setCurrentTrack(nextTrack);
    setPositionSecs(0);
    setDurationSecs(nextTrack.duration_secs ?? 0);
    scrobbledRef.current = false;

    // Clear preload state
    preloadedTrackRef.current = null;
    preloadReadyRef.current = false;

    return true;
  }

  async function handlePlay(track: Track) {
    cancelCrossfade();
    invalidatePreload();

    try {
      const pathOrUrl = await invoke<string>("get_track_path", { trackId: track.id });
      const src = track.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

      // Stop all elements
      [audioRefA.current, audioRefB.current].forEach(el => {
        if (el) { el.pause(); el.removeAttribute("src"); el.load(); }
      });
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }

      setCurrentTrack(track);
      setPositionSecs(0);
      setDurationSecs(track.duration_secs ?? 0);
      scrobbledRef.current = false;

      // Always reset to slot A on explicit play
      setActiveSlot("A");
      activeSlotRef.current = "A";

      if (isVideoTrack(track)) {
        if (videoRef.current) {
          videoRef.current.src = src;
          videoRef.current.volume = volume;
          await videoRef.current.play();
        } else {
          pendingSrcRef.current = src;
        }
      } else {
        if (audioRefA.current) {
          audioRefA.current.src = src;
          audioRefA.current.volume = volume;
          await audioRefA.current.play();
        }
      }
    } catch (e) {
      console.error("Playback error:", e);
    }
  }

  function handlePause() {
    const el = getMediaElement();
    if (!el) return;
    if (el.paused) {
      el.play();
    } else {
      cancelCrossfade();
      el.pause();
    }
  }

  async function handleRestore(track: Track, position: number, pathOverride?: string) {
    try {
      const pathOrUrl = pathOverride ?? await invoke<string>("get_track_path", { trackId: track.id });
      const src = track.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

      setCurrentTrack(track);
      setPositionSecs(position);
      setDurationSecs(track.duration_secs ?? 0);
      scrobbledRef.current = false;

      // Always restore to slot A
      setActiveSlot("A");
      activeSlotRef.current = "A";

      const loadInto = (el: HTMLMediaElement) => {
        el.src = src;
        el.volume = volumeRef.current;
        el.currentTime = position;
      };

      if (isVideoTrack(track)) {
        if (videoRef.current) {
          loadInto(videoRef.current);
        } else {
          pendingSrcRef.current = src;
          pendingAutoPlayRef.current = false;
          pendingSeekRef.current = position;
        }
      } else {
        if (audioRefA.current) {
          loadInto(audioRefA.current);
        }
      }
    } catch (e) {
      console.error("Restore error:", e);
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

    // Scrobble threshold check (Last.FM rules)
    if (!scrobbledRef.current && currentTrack) {
      if (shouldScrobble(el.currentTime, currentTrack.duration_secs)) {
        scrobbledRef.current = true;
        invoke("record_play", { trackId: currentTrack.id }).catch(console.error);
      }
    }

    if (el.duration > 0 && el.duration - el.currentTime > 0) {
      const remaining = el.duration - el.currentTime;
      const cfSecs = crossfadeSecsRef.current;
      const preloadAt = Math.max(5, cfSecs + 2);

      // Preload trigger
      if (remaining <= preloadAt) {
        const next = peekNextRef.current();
        if (!next) return;

        if (preloadedTrackRef.current?.id === next.id) {
          // Already preloaded the right track — check crossfade trigger
        } else {
          if (preloadedTrackRef.current && preloadedTrackRef.current.id !== next.id) {
            invalidatePreload();
          }
          if (!isPreloadingRef.current) {
            preloadNext(next);
          }
          return;
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
  function onPause() { setPlaying(false); }

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
    playing, setPlaying,
    positionSecs, setPositionSecs,
    durationSecs, setDurationSecs,
    volume, setVolume,
    activeSlot,
    audioRefA, audioRefB, videoRef,
    getMediaElement,
    handlePlay, handlePause, handleStop, handleRestore,
    handleVolume, handleSeek,
    handleGaplessNext, invalidatePreload,
    onTimeUpdate, onLoadedMetadata, onPlay, onPause,
    isActiveElement,
    onEndedSlotA, onEndedSlotB,
    onPlaySlotA, onPlaySlotB,
    onPauseSlotA, onPauseSlotB,
    toggleFullscreen,
  };
}
