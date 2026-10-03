// Per-platform command lines for `scripts/capture-site-media.mjs`.
//
// The runner drives the app the same way everywhere (the control API); only
// "where does the app live" and "how do we grab pixels" differ. Kept pure —
// argument lists, not processes — so both platforms' commands are asserted on
// any machine (`src/__tests__/capturePlatform.test.ts`), the same reason the
// perf probe keeps its plist parsing testable off macOS.
//
//   macOS    stills: screencapture -l<windowId>   videos: ffmpeg avfoundation
//   Windows  stills + videos: ffmpeg gdigrab cropped to the window's frame
//
// Windows has no CGWindowID equivalent the app reports, so both kinds crop the
// desktop to the window frame — which is why the window must be in front (the
// runner focuses it for every scene anyway).

import { join } from "node:path";

export const BUNDLE_ID = "com.alex.viboplr";

/** The profiles directory, mirroring the app's own layout (and the MCP
 *  server's `profilesDir`). */
export function profilesDir(platform, env, home) {
  if (platform === "darwin") return join(home, "Library", "Application Support", BUNDLE_ID, "profiles");
  if (platform === "win32") return join(env.APPDATA ?? join(home, "AppData", "Roaming"), BUNDLE_ID, "profiles");
  return join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), BUNDLE_ID, "profiles");
}

/** ffmpeg input arguments that record `rect` (screen pixels) for `seconds`.
 *  `device` is the avfoundation screen index (macOS only). */
export function grabInputArgs(platform, rect, { device = null, seconds = null, framerate = 30 } = {}) {
  const dur = seconds === null ? [] : ["-t", String(seconds)];
  if (platform === "darwin") {
    return {
      input: ["-f", "avfoundation", "-capture_cursor", "0", "-framerate", String(framerate), "-i", `${device}:none`, ...dur],
      // avfoundation records the whole screen; the crop happens in the filter.
      filter: `crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
    };
  }
  if (platform === "win32") {
    return {
      // gdigrab crops at the source, so no filter is needed.
      input: [
        "-f", "gdigrab", "-draw_mouse", "0", "-framerate", String(framerate),
        "-offset_x", String(rect.x), "-offset_y", String(rect.y),
        "-video_size", `${rect.width}x${rect.height}`, "-i", "desktop", ...dur,
      ],
      filter: null,
    };
  }
  throw new Error(`capture-site-media doesn't support ${platform} (macOS and Windows only)`);
}

/** One PNG of `rect` via gdigrab (the Windows still path). */
export function gdigrabStillArgs(rect, png) {
  const { input } = grabInputArgs("win32", rect, { framerate: 1 });
  return ["-y", "-hide_banner", ...input, "-frames:v", "1", png];
}

/** Encode a PNG to WebP. cwebp when available (macOS's Homebrew ffmpeg has no
 *  libwebp), otherwise ffmpeg's libwebp encoder (the Windows builds carry it).
 *  `cropBottom` trims that fraction off the bottom; cwebp needs the pixel
 *  size for it, ffmpeg does it in the filter. */
export function webpArgs(png, out, { quality = 90, cropBottom = 0, encoder = "cwebp", size = null } = {}) {
  if (encoder === "cwebp") {
    const crop = cropBottom && size
      ? ["-crop", "0", "0", String(size.width), String(Math.round(size.height * (1 - cropBottom)))]
      : [];
    return { cmd: "cwebp", args: ["-quiet", "-q", String(quality), ...crop, png, "-o", out] };
  }
  const vf = cropBottom ? ["-vf", `crop=iw:trunc(ih*${(1 - cropBottom).toFixed(4)}/2)*2:0:0`] : [];
  return { cmd: "ffmpeg", args: ["-y", "-hide_banner", "-loglevel", "error", "-i", png, ...vf, "-c:v", "libwebp", "-quality", String(quality), out] };
}

/** PowerShell that moves the pointer to the primary screen's right edge. */
export const WINDOWS_PARK_POINTER =
  "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; " +
  "$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; " +
  "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(($b.Right - 2), [int]($b.Top + $b.Height / 2))";
