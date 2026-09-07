import { getCurrentWindow } from "@tauri-apps/api/window";

// On Windows, entering borderless fullscreen while the undecorated window is
// MAXIMIZED leaves the taskbar visible and on top — tao's `WM_NCCALCSIZE`
// handler clamps an undecorated window's client area to the monitor *work
// area* whenever `IsZoomed`, so the fullscreen window ends up 48px short and
// the strip it doesn't paint is transparent, showing the taskbar through it.
// The fix is to unmaximize first, and restore the maximized state on exit so
// leaving fullscreen puts the user back where they were.
//
// Gated to Windows: on macOS `setFullscreen` drives the native fullscreen
// space and an unmaximize beforehand would add a visible resize for nothing.
const isWindows =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform || navigator.userAgent);

let restoreMaximized = false;

/** The one way to window-fullscreen the app window. Both fullscreen surfaces
 *  (the audio overlay and native mpv video) go through here so the Windows
 *  maximized-taskbar workaround cannot be missed by one of them. */
export async function applyWindowFullscreen(fullscreen: boolean): Promise<void> {
  const win = getCurrentWindow();
  // Best-effort, and deliberately isolated: the workaround is a *nicety* next
  // to the thing the user actually asked for. Letting it reject would skip the
  // `setFullscreen` below entirely, which is exactly how this shipped broken —
  // `unmaximize` was missing from the window capability, so on Windows every
  // fullscreen from a maximized window threw before it ever went fullscreen,
  // leaving the overlay filling a still-maximized window with the taskbar over
  // it. Any future failure here must cost the taskbar strip, not fullscreen.
  if (fullscreen && isWindows) {
    try {
      if (await win.isMaximized()) {
        await win.unmaximize();
        restoreMaximized = true;
      }
    } catch (e) {
      console.error("Failed to unmaximize before fullscreen:", e);
    }
  }
  await win.setFullscreen(fullscreen);
  if (!fullscreen && restoreMaximized) {
    restoreMaximized = false;
    try {
      await win.maximize();
    } catch (e) {
      console.error("Failed to restore the maximized window after fullscreen:", e);
    }
  }
}
