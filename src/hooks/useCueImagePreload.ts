import { useEffect } from "react";
import { cueImagesToPreload, type Cue } from "../utils/cueSheet";
import { getPlaybackPosition } from "../playback/positionStore";

/** Fetch and decode a cue sheet's images as soon as its overlay mounts, so
 *  each one is ready by the time its cue comes on screen. The decoded
 *  `Image` objects are held for as long as the sheet is up: that keeps them in
 *  the webview's memory cache, where the overlay's own `<img>` (same URL, same
 *  referrer policy) finds them without a second request or decode. */
export function useCueImagePreload(cues: Cue[]): void {
  useEffect(() => {
    const held = cueImagesToPreload(cues, getPlaybackPosition()).map((url) => {
      const img = new Image();
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.src = url;
      // eslint-disable-next-line no-restricted-syntax -- Fire-and-forget: a failed preload only means the cue fetches its image itself; the overlay's onError handles a dead URL.
      img.decode().catch(() => {});
      return img;
    });
    return () => {
      // Drop the in-flight requests of a sheet that is no longer shown.
      for (const img of held) img.src = "";
    };
  }, [cues]);
}
