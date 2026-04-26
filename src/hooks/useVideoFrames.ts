import { useState, useEffect, useRef } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { Track } from "../types";
import { isVideoTrack } from "../utils";

interface VideoFrameResult {
  status: string;
  paths?: string[];
  timestamps?: number[];
}

export interface VideoFramesState {
  frames: string[] | null;
  timestamps: number[] | null;
  loading: boolean;
  unavailable: boolean;
}

export function useVideoFrames(track: Track | null): VideoFramesState {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [timestamps, setTimestamps] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const extractingRef = useRef<number | null>(null);

  useEffect(() => {
    setFrames(null);
    setTimestamps(null);
    setLoading(false);
    setUnavailable(false);

    if (!track || !isVideoTrack(track) || !track.path || track.path.startsWith("subsonic://") || track.path.startsWith("tidal://")) {
      return;
    }

    const trackId = track.id;
    let cancelled = false;
    extractingRef.current = trackId;

    (async () => {
      try {
        const cached = await invoke<VideoFrameResult | null>("get_video_frames", { trackId });
        if (cancelled) return;
        if (cached && cached.status === "ok" && cached.paths) {
          setFrames(cached.paths.map(p => convertFileSrc(p)));
          if (cached.timestamps) setTimestamps(cached.timestamps);
          return;
        }
      } catch (e) {
        console.error("Failed to check video frame cache:", e);
      }

      if (cancelled) return;
      setLoading(true);

      try {
        const result = await invoke<VideoFrameResult>("extract_video_frames", { trackId });
        if (cancelled) return;

        if (result.status === "unavailable") {
          setUnavailable(true);
        } else if (result.status === "ok" && result.paths) {
          setFrames(result.paths.map(p => convertFileSrc(p)));
          if (result.timestamps) setTimestamps(result.timestamps);
        }
      } catch (e) {
        console.error("Failed to extract video frames:", e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (extractingRef.current === trackId) extractingRef.current = null;
    };
  }, [track?.id, track?.path]);

  return { frames, timestamps, loading, unavailable };
}
