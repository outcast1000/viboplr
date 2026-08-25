import { useState, useEffect } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { QueueTrack } from "../types";
import { isVideoTrack } from "../utils";
import { schemeOf, type Storyboard } from "../utils/storyboard";

interface StoryboardResult {
  status: string; // "ok" | "unavailable" | "unsupported" | "cancelled"
  storyboard: Storyboard | null;
}

/** Mirrors the Rust `StoryboardPartial` event payload (camelCase over IPC). */
interface StoryboardPartialEvent {
  path: string;
  framePaths: string[];
  startIndex: number;
  intervalSecs: number;
  count: number;
}

/** Frames extracted so far while the storyboard generates — `frames[i]` is an
 *  image URL depicting `(startIndex + i) * intervalSecs`; `count` is how many the
 *  finished board will carry. `startIndex` is 0 for a fresh pass and non-zero while
 *  the backend resumes one that was cancelled part-way (its frames start mid-video).
 *  Only ever non-null while `status` is "loading". */
export interface PartialStoryboard {
  frames: string[];
  startIndex: number;
  intervalSecs: number;
  count: number;
}

export interface StoryboardState {
  board: Storyboard | null;
  /** `unavailable` = ffmpeg missing (the filmstrip prompts to install it);
   *  `unsupported` = nothing can produce one for this source; `off` = generation is
   *  switched off in Settings and this video has no sheet cached; `idle` = not a
   *  video. */
  status: "idle" | "loading" | "ready" | "unavailable" | "unsupported" | "off";
  partial: PartialStoryboard | null;
}

/** Unique per generation attempt, so `cancel_storyboard` withdraws exactly this
 *  surface's interest and leaves any other surface's alive (see the Rust
 *  `storyboard::Runs`). */
let nextRequestId = 0;

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
 *
 * A pass in flight is abandoned as soon as it is no longer wanted — the track
 * changed, the view closed, or generation was switched off — which kills the ffmpeg
 * child rather than letting a full keyframe decode run for a video nobody is on any
 * more. Interest is ref counted in the backend, so the now-playing bar and the detail
 * page can want the same sheet without either one's teardown killing it.
 */
export function useStoryboard(
  track: QueueTrack | null,
  resolveByUri?: (scheme: string, id: string) => Promise<Storyboard | null>,
  /** Where the track's resolution actually landed on THIS disk
   *  (`effectiveLocalPath`), or null. Lets a plugin scheme whose file is local
   *  (qbt://…) fall back to the ordinary local ffmpeg pass when its plugin has
   *  no storyboard answer — same attribution rule as the source panel. Arrives
   *  async (a resolve must finish first), so the effect re-runs when it lands. */
  localPath?: string | null,
  /** Settings > Playback > "Generate video seek previews". False stops the local
   *  ffmpeg pass from ever starting (and cancels one in flight); sheets already
   *  cached, and sheets published by the source itself, cost nothing and are still
   *  served. */
  enabled: boolean = true,
): StoryboardState {
  const [state, setState] = useState<StoryboardState>({ board: null, status: "idle", partial: null });

  const path = track?.path ?? null;
  const isVideo = track ? isVideoTrack(track) : false;

  useEffect(() => {
    setState({ board: null, status: "idle", partial: null });
    if (!path || !isVideo) return;
    setState({ board: null, status: "loading", partial: null });

    let cancelled = false;
    let unlistenPartial: (() => void) | null = null;
    // The pass currently running on our behalf, so teardown can withdraw from it.
    let pending: { path: string; requestId: string } | null = null;

    // Local sheets need the asset protocol; plugin sheets may already be http/data
    // URLs, or local paths under the plugin's own storage.
    const withAssetUrls = (b: Storyboard): Storyboard => ({
      ...b,
      sheets: b.sheets.map(s => (/^(https?|data):/.test(s) ? s : convertFileSrc(s))),
    });

    // The one local ffmpeg pass: cache-read first, then generate on a miss.
    // `target` is a file:// URI — the track's own path, or (for a plugin scheme
    // whose file is on this disk) the resolved local path.
    const runLocal = async (target: string) => {
      try {
        const cached = await invoke<Storyboard | null>("get_storyboard", { path: target });
        if (cancelled) return;
        if (cached) {
          setState({ board: withAssetUrls(cached), status: "ready", partial: null });
          return;
        }
      } catch (e) {
        console.error("Failed to read storyboard cache:", e);
        // Fall through — a cache read failure shouldn't block generation.
      }

      if (cancelled) return;
      // Nothing cached and generation is switched off: report it and decode nothing.
      if (!enabled) {
        setState({ board: null, status: "off", partial: null });
        return;
      }
      // Generation streams the frames it has extracted so far, so the filmstrip can
      // fill in progressively. Subscribed before the extract invoke so no early
      // frame is missed; terminal setStates below clear `partial` (the frame files
      // are scratch — the backend deletes them once the sheet exists).
      try {
        const un = await listen<StoryboardPartialEvent>("storyboard-partial", ev => {
          if (ev.payload.path !== target) return;
          const partial: PartialStoryboard = {
            frames: ev.payload.framePaths.map(p => convertFileSrc(p)),
            startIndex: ev.payload.startIndex ?? 0,
            intervalSecs: ev.payload.intervalSecs,
            count: ev.payload.count,
          };
          setState(prev => (prev.status === "loading" ? { ...prev, partial } : prev));
        });
        if (cancelled) un();
        else unlistenPartial = un;
      } catch (e) {
        console.error("Failed to subscribe to storyboard progress:", e);
        // Progress is a nicety — generation still runs without it.
      }

      if (cancelled) return;
      const requestId = `sb${++nextRequestId}`;
      pending = { path: target, requestId };
      try {
        const result = await invoke<StoryboardResult>("extract_storyboard", { path: target, requestId });
        if (cancelled) return;
        if (result.status === "ok" && result.storyboard) {
          setState({ board: withAssetUrls(result.storyboard), status: "ready", partial: null });
        } else if (result.status === "cancelled") {
          // Another surface withdrew and the pass was killed while we were still
          // waiting on it; leave the state alone rather than claim "no preview".
        } else {
          // "unavailable" (no ffmpeg) / "unsupported" (not a local file) are expected.
          // The seek bar just shows no thumbnail; the filmstrip prompts for ffmpeg.
          setState({
            board: null,
            status: result.status === "unavailable" ? "unavailable" : "unsupported",
            partial: null,
          });
        }
      } catch (e) {
        console.error("Failed to generate storyboard:", e);
        if (!cancelled) setState({ board: null, status: "unsupported", partial: null });
      } finally {
        pending = null;
        unlistenPartial?.();
        unlistenPartial = null;
      }
    };

    (async () => {
      const parsed = schemeOf(path);

      // Plugin-owned scheme: the plugin answers first — a source's own published
      // storyboard (sprite sheets) costs nothing to fetch, where a local pass
      // decodes the file.
      if (parsed && parsed.scheme !== "file") {
        if (resolveByUri) {
          try {
            const fromPlugin = await resolveByUri(parsed.scheme, parsed.id);
            if (cancelled) return;
            if (fromPlugin) {
              setState({ board: withAssetUrls(fromPlugin), status: "ready", partial: null });
              return;
            }
          } catch (e) {
            console.error("Plugin storyboard resolve failed:", e);
            if (cancelled) return;
          }
        }
        // No plugin answer, but the resolution landed on a file on this disk
        // (qbt://… and friends): run the ordinary local pass on it. Until the
        // resolve completes localPath is null and this reports unsupported —
        // the effect re-runs when the path lands.
        if (localPath) {
          await runLocal("file://" + localPath);
          return;
        }
        setState({ board: null, status: "unsupported", partial: null });
        return;
      }

      await runLocal(path);
    })();

    return () => {
      cancelled = true;
      unlistenPartial?.();
      if (pending) {
        invoke("cancel_storyboard", pending).catch(e =>
          console.error("Failed to cancel storyboard generation:", e));
        pending = null;
      }
    };
  }, [path, isVideo, resolveByUri, localPath, enabled]);

  return state;
}
