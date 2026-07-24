import type { DownloadQualityOption } from "../types/plugin";

/**
 * Pick which provider quality option the download modal should preselect.
 *
 * A video track defaults to the first option flagged `video: true` — so
 * downloading a video you're watching yields the video, not its audio — while
 * still letting the user pick any other option. Everything else (and any video
 * track whose provider offers no video option) defaults to the first option.
 *
 * Returns `null` only when `qualities` is empty; callers then fall back to their
 * own built-in default (this helper decides *among provider options* only).
 */
export function defaultQualityValue(
  qualities: DownloadQualityOption[],
  isVideo: boolean,
): string | null {
  if (qualities.length === 0) return null;
  if (isVideo) {
    const videoOption = qualities.find((q) => q.video);
    if (videoOption) return videoOption.value;
  }
  return qualities[0].value;
}
