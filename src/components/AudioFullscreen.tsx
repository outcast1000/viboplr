import type { ReactNode } from "react";
import "./AudioFullscreen.css";

interface AudioFullscreenProps {
  /** The whole presentation — `NowPlayingView` in its `fullscreen` variant. */
  surface: ReactNode;
  /** `FullscreenControls`, the same bar the video path uses. */
  controls: ReactNode;
}

/**
 * Fullscreen presentation for a non-video track.
 *
 * Deliberately almost nothing: the surface *is* the Now Playing view, so what
 * fills the screen — blurred-art backdrop, visualizer-or-artwork stage, lyrics,
 * the corner action row — is rendered by one component in both places rather
 * than described twice. This container's whole job is to pin that surface over
 * the app grid and hang the control bar off the bottom of it.
 *
 * The video path can't join in: it fullscreens `.video-container`, and the shared
 * `<video>` element must never be remounted or moved out of it. So the container
 * differs there and the *controls* are what's shared. From the user's side there
 * is one fullscreen with one control bar.
 *
 * Window fullscreen (set by the caller), not DOM element fullscreen — the same
 * choice the native video path made. `requestFullscreen` in WKWebView is
 * activation-consuming and needs a re-entrancy guard to survive a double-press,
 * and on macOS it moves the webview to its own space.
 */
export function AudioFullscreen({ surface, controls }: AudioFullscreenProps) {
  return (
    <div className="audio-fs">
      {surface}
      {controls}
    </div>
  );
}
