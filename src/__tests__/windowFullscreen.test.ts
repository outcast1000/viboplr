import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const win = {
  isMaximized: vi.fn<() => Promise<boolean>>(),
  unmaximize: vi.fn<() => Promise<void>>(),
  maximize: vi.fn<() => Promise<void>>(),
  setFullscreen: vi.fn<(v: boolean) => Promise<void>>(),
};

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

// `applyWindowFullscreen` keeps module-level state (the maximized-on-exit
// flag), so each case re-imports it fresh.
async function load() {
  vi.resetModules();
  return (await import("../utils/windowFullscreen")).applyWindowFullscreen;
}

describe("applyWindowFullscreen on Windows", () => {
  beforeEach(() => {
    Object.values(win).forEach((fn) => fn.mockReset());
    win.isMaximized.mockResolvedValue(false);
    win.unmaximize.mockResolvedValue();
    win.maximize.mockResolvedValue();
    win.setFullscreen.mockResolvedValue();
    Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
  });

  it("unmaximizes before going fullscreen, and restores the maximized state on exit", async () => {
    const apply = await load();
    win.isMaximized.mockResolvedValue(true);

    await apply(true);
    expect(win.unmaximize).toHaveBeenCalled();
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(win.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(
      win.setFullscreen.mock.invocationCallOrder[0],
    );

    await apply(false);
    expect(win.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(win.maximize).toHaveBeenCalledTimes(1);
  });

  it("still goes fullscreen when the unmaximize workaround fails", async () => {
    // The regression this file exists for: `unmaximize` was missing from the
    // window capability, so it rejected and took the `setFullscreen` call down
    // with it — the window stayed maximized and the taskbar stayed on top.
    const apply = await load();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    win.isMaximized.mockResolvedValue(true);
    win.unmaximize.mockRejectedValue(new Error("window.unmaximize not allowed"));

    await apply(true);
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
    expect(err).toHaveBeenCalled();

    // Nothing was unmaximized, so nothing is re-maximized on the way out.
    await apply(false);
    expect(win.maximize).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("leaves a window that was not maximized alone", async () => {
    const apply = await load();
    await apply(true);
    expect(win.unmaximize).not.toHaveBeenCalled();
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });
});

describe("window capability", () => {
  // Every state-changing `core:window` command needs an explicit allow — the
  // capability's `core:default` covers the getters only. A call the manifest
  // doesn't grant rejects at runtime with nothing but a console error, which is
  // how the maximized-fullscreen bug shipped twice.
  const capability = JSON.parse(
    readFileSync("src-tauri/capabilities/default.json", "utf-8"),
  ) as { permissions: string[] };

  // Granted by `core:default` (the `core:window` default permission set).
  const GRANTED_BY_DEFAULT = new Set([
    "get-all-windows", "scale-factor", "inner-position", "outer-position", "inner-size",
    "outer-size", "is-fullscreen", "is-minimized", "is-maximized", "is-focused", "is-decorated",
    "is-resizable", "is-maximizable", "is-minimizable", "is-closable", "is-visible", "is-enabled",
    "title", "current-monitor", "primary-monitor", "monitor-from-point", "available-monitors",
    "cursor-position", "theme", "is-always-on-top", "activity-name", "scene-identifier",
    "internal-toggle-maximize",
  ]);

  // Event subscriptions, not IPC commands — no permission behind them.
  const LISTENERS = /^on[A-Z]/;

  const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });
  }

  it("allows every window command the frontend calls", () => {
    const missing = new Set<string>();
    for (const file of sources("src")) {
      const text = readFileSync(file, "utf-8");
      if (!text.includes("getCurrentWindow")) continue;
      for (const [, method] of text.matchAll(/\bwin\.([a-zA-Z]+)\(/g)) {
        if (LISTENERS.test(method)) continue;
        const command = kebab(method);
        if (GRANTED_BY_DEFAULT.has(command)) continue;
        if (!capability.permissions.includes(`core:window:allow-${command}`)) {
          missing.add(`${command} (${file})`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
