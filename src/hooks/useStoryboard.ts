import { useState, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { QueueTrack } from "../types";
import { isVideoTrack } from "../utils";
import { schemeOf, type Storyboard } from "../utils/storyboard";

interface StoryboardResult {
  status: string; // "ok" | "unavailable" | "unsupported"
  storyboard: Storyboard | null;
}

export interface StoryboardState {
  board: Storyboard | null;
  /** `unavailable` = ffmpeg missing (the filmstrip prompts to install it);
   *  `unsupported` = nothing can produce one for this source; `idle` = not a video. */
  status: "idle" | "loading" | "ready" | "unavailable" | "unsupported";
}

/**
 * Resolves the seek-preview storyboard for the currently playing video track.
 *
 * Two producers, one shape (see docs/seek-preview-spec.md):
 * - Plugin schemes ask the owning plugin, which returns the source's own published
 *   storyboard (YouTube ships sprite sheets, so nothing is decoded or re-streamed).
 * - `file://` runs one local ffmpeg pass, cache-read first then generate on a miss.
 *
 * Generation starts when the track starts rather than on first hover — it's fast but
 * a user already hovering the seek bar wants the tile now.
 *
 * Returns null for audio, for sources with no storyboard, and when ffmpeg is missing.
 * Callers treat null as "no preview" and keep the plain time bubble.
 */
export function useStoryboard(
  track: QueueTrack | null,
  resolveByUri?: (scheme: string, id: string) => Promise<Storyboard | null>,
): StoryboardState {
  const [state, setState] = useState<StoryboardState>({ board: null, status: "idle" });

  const path = track?.path ?? null;
  const isVideo = track ? isVideoTrack(track) : false;

  useEffect(() => {
    setState({ board: null, status: "idle" });
    if (!path || !isVideo) return;
    setState({ board: null, status: "loading" });

    let cancelled = false;

    // Local sheets need the asset protocol; plugin sheets may already be http/data
    // URLs, or local paths under the plugin's own storage.
    const withAssetUrls = (b: Storyboard): Storyboard => ({
      ...b,
      sheets: b.sheets.map(s => (/^(https?|data):/.test(s) ? s : convertFileSrc(s))),
    });

    (async () => {
      const parsed = schemeOf(path);

      // Plugin-owned scheme: the plugin is the only thing that can answer, so don't
      // touch the local path at all.
      if (parsed && parsed.scheme !== "file") {
        if (!resolveByUri) {
          setState({ board: null, status: "unsupported" });
          return;
        }
        try {
          const fromPlugin = await resolveByUri(parsed.scheme, parsed.id);
          if (cancelled) return;
          setState(fromPlugin
            ? { board: withAssetUrls(fromPlugin), status: "ready" }
            : { board: null, status: "unsupported" });
        } catch (e) {
          console.error("Plugin storyboard resolve failed:", e);
          if (!cancelled) setState({ board: null, status: "unsupported" });
        }
        return;
      }

      try {
        const cached = await invoke<Storyboard | null>("get_storyboard", { path });
        if (cancelled) return;
        if (cached) {
          setState({ board: withAssetUrls(cached), status: "ready" });
          return;
        }
      } catch (e) {
        console.error("Failed to read storyboard cache:", e);
        // Fall through — a cache read failure shouldn't block generation.
      }

      if (cancelled) return;
      try {
        const result = await invoke<StoryboardResult>("extract_storyboard", { path });
        if (cancelled) return;
        if (result.status === "ok" && result.storyboard) {
          setState({ board: withAssetUrls(result.storyboard), status: "ready" });
        } else {
          // "unavailable" (no ffmpeg) / "unsupported" (not a local file) are expected.
          // The seek bar just shows no thumbnail; the filmstrip prompts for ffmpeg.
          setState({ board: null, status: result.status === "unavailable" ? "unavailable" : "unsupported" });
        }
      } catch (e) {
        console.error("Failed to generate storyboard:", e);
        if (!cancelled) setState({ board: null, status: "unsupported" });
      }
    })();

    return () => { cancelled = true; };
  }, [path, isVideo, resolveByUri]);

  return state;
}
