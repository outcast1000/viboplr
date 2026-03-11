import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { isVideoTrack } from "../utils";
import { store } from "../store";

export function usePlayback(restoredRef: React.RefObject<boolean>) {
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionSecs, setPositionSecs] = useState(0);
  const [durationSecs, setDurationSecs] = useState(0);
  const [volume, setVolume] = useState(1.0);

  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pendingSrcRef = useRef<string | null>(null);

  function getMediaElement(): HTMLAudioElement | HTMLVideoElement | null {
    if (currentTrack && isVideoTrack(currentTrack)) {
      return videoRef.current;
    }
    return audioRef.current;
  }

  // Sync volume to media elements when it changes
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  // Start video playback once the element is available after render
  useEffect(() => {
    if (pendingSrcRef.current && currentTrack && isVideoTrack(currentTrack) && videoRef.current) {
      const src = pendingSrcRef.current;
      pendingSrcRef.current = null;
      videoRef.current.src = src;
      videoRef.current.volume = volume;
      videoRef.current.play().catch(e => console.error("Video play error:", e));
    }
  }, [currentTrack]);

  // Persist state
  useEffect(() => { if (restoredRef.current) store.set("currentTrackId", currentTrack?.id ?? null); }, [currentTrack]);
  useEffect(() => { if (restoredRef.current) store.set("positionSecs", positionSecs); }, [positionSecs]);
  useEffect(() => { if (restoredRef.current) store.set("volume", volume); }, [volume]);

  async function handlePlay(track: Track) {
    try {
      const pathOrUrl = await invoke<string>("get_track_path", { trackId: track.id });
      const src = track.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

      // Stop current playback on both elements
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.load();
      }

      setCurrentTrack(track);
      setPositionSecs(0);
      setDurationSecs(track.duration_secs ?? 0);

      if (isVideoTrack(track)) {
        if (videoRef.current) {
          videoRef.current.src = src;
          videoRef.current.volume = volume;
          await videoRef.current.play();
        } else {
          pendingSrcRef.current = src;
        }
      } else {
        if (audioRef.current) {
          audioRef.current.src = src;
          audioRef.current.volume = volume;
          await audioRef.current.play();
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
      el.pause();
    }
  }

  function handleStop() {
    const el = getMediaElement();
    if (el) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    setCurrentTrack(null);
    setPlaying(false);
    setPositionSecs(0);
    setDurationSecs(0);
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

  function onTimeUpdate(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    setPositionSecs((e.target as HTMLMediaElement).currentTime);
  }

  function onLoadedMetadata(e: React.SyntheticEvent<HTMLAudioElement | HTMLVideoElement>) {
    setDurationSecs((e.target as HTMLMediaElement).duration);
  }

  function onPlay() { setPlaying(true); }
  function onPause() { setPlaying(false); }

  return {
    currentTrack, setCurrentTrack,
    playing, setPlaying,
    positionSecs, setPositionSecs,
    durationSecs, setDurationSecs,
    volume, setVolume,
    audioRef, videoRef,
    getMediaElement,
    handlePlay, handlePause, handleStop,
    handleVolume, handleSeek,
    onTimeUpdate, onLoadedMetadata, onPlay, onPause,
  };
}
