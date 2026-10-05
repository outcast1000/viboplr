// An install an AI assistant asked for: nothing is fetched until the user
// presses Install in the app's dialog, and the request resolves with what the
// user actually did there.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useAssistantInstall, type AssistantInstallOutcome } from "../hooks/useAssistantInstall";
import type { GalleryPluginEntry } from "../types/plugin";
import type { GallerySkinEntry } from "../types/skin";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../utils/tauriEvents", () => ({ subscribe: () => () => {} }));

const plugin: GalleryPluginEntry = {
  id: "lastfm",
  name: "Last.fm",
  author: "outcast1000",
  description: "Scrobbling and community tags",
  updateUrl: "https://example.test/update.json",
  stability: "experimental",
};
const skin = { id: "midnight", name: "Midnight", author: "someone" } as GallerySkinEntry;

function setup(overrides: Partial<Parameters<typeof useAssistantInstall>[0]> = {}) {
  const deps = {
    installPlugin: vi.fn(async () => ({ ok: true })),
    installSkin: vi.fn(async () => ({ ok: true })),
    togglePlugin: vi.fn(async () => undefined),
    approvePermissions: vi.fn(async () => undefined),
    permissionsToApprove: vi.fn(() => [] as string[]),
    ...overrides,
  };
  const hook = renderHook(() => useAssistantInstall(deps));
  return { deps, hook };
}

afterEach(cleanup);

describe("useAssistantInstall", () => {
  it("asks first, and a decline installs nothing", async () => {
    const { deps, hook } = setup();
    let outcome: Promise<AssistantInstallOutcome>;
    act(() => { outcome = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    expect(hook.result.current.flow).toMatchObject({
      phase: "confirm",
      name: "Last.fm",
      confirm: { kind: "plugin", author: "outcast1000", experimental: true },
    });
    act(() => hook.result.current.decline());
    await expect(outcome!).resolves.toEqual({ outcome: "declined" });
    expect(deps.installPlugin).not.toHaveBeenCalled();
    expect(hook.result.current.flow).toBeNull();
  });

  it("installs on Install, then grants the shown permissions and enables on Allow", async () => {
    const { deps, hook } = setup({ permissionsToApprove: vi.fn(() => ["network:ws.audioscrobbler.com"]) });
    let outcome: Promise<AssistantInstallOutcome>;
    act(() => { outcome = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await act(() => hook.result.current.confirm());
    expect(deps.installPlugin).toHaveBeenCalledWith(plugin);
    expect(hook.result.current.flow).toMatchObject({
      phase: "done",
      needsEnable: true,
      permissions: ["network:ws.audioscrobbler.com"],
    });
    await act(() => hook.result.current.enable());
    expect(deps.approvePermissions).toHaveBeenCalledWith("lastfm");
    expect(deps.togglePlugin).toHaveBeenCalledWith("lastfm", true);
    await expect(outcome!).resolves.toEqual({ outcome: "installed", enabled: true });
  });

  it("reports Not now as installed but off", async () => {
    const { deps, hook } = setup();
    let outcome: Promise<AssistantInstallOutcome>;
    act(() => { outcome = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await act(() => hook.result.current.confirm());
    act(() => hook.result.current.close());
    await expect(outcome!).resolves.toEqual({ outcome: "installed", enabled: false });
    expect(deps.togglePlugin).not.toHaveBeenCalled();
  });

  it("reports a failure the user closed on, and a retry that worked as success", async () => {
    const installPlugin = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "HTTP 504" })
      .mockResolvedValueOnce({ ok: false, error: "HTTP 504" })
      .mockResolvedValueOnce({ ok: true });
    const { hook } = setup({ installPlugin });
    let first: Promise<AssistantInstallOutcome>;
    act(() => { first = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await act(() => hook.result.current.confirm());
    expect(hook.result.current.flow?.phase).toBe("error");
    act(() => hook.result.current.close());
    await expect(first!).resolves.toEqual({ outcome: "failed", error: "HTTP 504" });

    let second: Promise<AssistantInstallOutcome>;
    act(() => { second = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await act(() => hook.result.current.confirm());
    await act(() => hook.result.current.retry());
    expect(hook.result.current.flow?.phase).toBe("done");
    act(() => hook.result.current.close());
    await expect(second!).resolves.toEqual({ outcome: "installed", enabled: false });
  });

  it("treats a cancelled download as cancelled, not failed", async () => {
    const { hook } = setup({ installPlugin: vi.fn(async () => ({ ok: false, error: "__install_cancelled__" })) });
    let outcome: Promise<AssistantInstallOutcome>;
    act(() => { outcome = hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await act(() => hook.result.current.confirm());
    await expect(outcome!).resolves.toEqual({ outcome: "cancelled" });
  });

  it("installs a skin (which applies it) and reports it on", async () => {
    const { deps, hook } = setup();
    let outcome: Promise<AssistantInstallOutcome>;
    act(() => { outcome = hook.result.current.requestInstall({ kind: "skin", entry: skin }); });
    await act(() => hook.result.current.confirm());
    expect(deps.installSkin).toHaveBeenCalledWith(skin);
    expect(hook.result.current.flow).toMatchObject({ phase: "done", needsEnable: false });
    act(() => hook.result.current.close());
    await expect(outcome!).resolves.toEqual({ outcome: "installed", enabled: true });
  });

  it("refuses a second request while one is waiting on the user", async () => {
    const { hook } = setup();
    act(() => { void hook.result.current.requestInstall({ kind: "plugin", entry: plugin }); });
    await expect(hook.result.current.requestInstall({ kind: "skin", entry: skin })).rejects.toThrow(/already waiting/);
  });
});
