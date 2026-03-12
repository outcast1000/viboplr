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
  const pendingAutoPlayRef = useRef(true);
  const pendingSeekRef = useRef(0);

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

      invoke("record_play", { trackId: track.id }).catch(console.error);
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

  async function handleRestore(track: Track, position: number) {
    try {
      const pathOrUrl = await invoke<string>("get_track_path", { trackId: track.id });
      const src = track.subsonic_id ? pathOrUrl : convertFileSrc(pathOrUrl);

      setCurrentTrack(track);
      setPositionSecs(position);
      setDurationSecs(track.duration_secs ?? 0);

      const loadInto = (el: HTMLMediaElement) => {
        el.src = src;
        el.volume = volume;
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
        if (audioRef.current) {
          loadInto(audioRef.current);
        }
      }
    } catch (e) {
      console.error("Restore error:", e);
    }
  }

  function handleStop() {
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
    handlePlay, handlePause, handleStop, handleRestore,
    handleVolume, handleSeek,
    onTimeUpdate, onLoadedMetadata, onPlay, onPause,
  };
}
