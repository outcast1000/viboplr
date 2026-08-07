import type { ReactNode } from "react";
import "./AudioFullscreen.css";

interface AudioFullscreenProps {
  /** What fills the screen: the `fullscreen` visualizer slot, or the album art. */
  stage: ReactNode;
  /** `FullscreenControls`, the same bar the video path uses. */
  controls: ReactNode;
}

/**
 * Fullscreen presentation for a non-video track.
 *
 * The video path can't be reused directly — it fullscreens `.video-container`,
 * and the shared `<video>` element must never be remounted or moved out of it.
 * So audio gets its own container, and the *controls* are what's shared: this
 * renders the very same `FullscreenControls` the video overlay does, so the two
 * fullscreens differ only in what is behind the bar.
 *
 * Window fullscreen (set by the caller), not DOM element fullscreen — the same
 * choice the native video path made. `requestFullscreen` in WKWebView is
 * activation-consuming and needs a re-entrancy guard to survive a double-press,
 * and on macOS it moves the webview to its own space.
 */
export function AudioFullscreen({ stage, controls }: AudioFullscreenProps) {
  return (
    <div className="audio-fs">
      <div className="audio-fs-stage">{stage}</div>
      {controls}
    </div>
  );
}
