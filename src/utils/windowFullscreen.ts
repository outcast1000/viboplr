import { getCurrentWindow } from "@tauri-apps/api/window";

// On Windows, entering borderless fullscreen while the undecorated window is
// MAXIMIZED leaves the taskbar visible and on top — the maximized rect already
// excludes the taskbar area and tao's fullscreen transition never repositions
// the window over it (tao#1087: fullscreen + maximized don't compose). The fix
// is to unmaximize first, and restore the maximized state on exit so leaving
// fullscreen puts the user back where they were.
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
  if (fullscreen && isWindows && (await win.isMaximized())) {
    restoreMaximized = true;
    await win.unmaximize();
  }
  await win.setFullscreen(fullscreen);
  if (!fullscreen && restoreMaximized) {
    restoreMaximized = false;
    await win.maximize();
  }
}
