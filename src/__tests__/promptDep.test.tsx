// A plugin's `requestAction("require-dependency")` opens the install dialog
// through `useDependencies.promptDep`: only for a tool its manifest lists,
// named after the plugin, and "needed" rather than "required" for a tool its
// entry marks optional.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, render, screen, cleanup } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useDependencies } from "../hooks/useDependencies";
import { DependencyModal } from "../components/DependencyModal";
import type { PluginState } from "../types/plugin";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const FFMPEG_MISSING = {
  name: "ffmpeg",
  description: "Audio/video transcoding and format conversion",
  status: "notFound",
  internalConsumers: [],
  pluginConsumers: [{ name: "yt-dlp", reason: "Merge separate video+audio streams", required: false }],
  install: { macos: "brew install ffmpeg", windows: "winget install Gyan.FFmpeg", linux: "sudo apt install ffmpeg", url: "https://ffmpeg.org/download.html" },
  managedAvailable: false,
};

function plugin(required: boolean): PluginState {
  return {
    id: "ytdlp",
    enabled: true,
    status: "active",
    manifest: {
      id: "ytdlp",
      name: "yt-dlp",
      version: "1.0.0",
      binaryDependencies: [{ name: "ffmpeg", required, reason: "Merge separate video+audio streams" }],
    },
  } as unknown as PluginState;
}

function mockBackend() {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "check_dependencies") return [FFMPEG_MISSING];
    if (cmd === "dependency_registry_status") return { conflicts: [], pendingConsent: [], refused: [], unused: [] };
    return null;
  });
}

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe("promptDep", () => {
  it("opens the dialog for an optional tool under the plugin's name, marked not required", async () => {
    mockBackend();
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    await act(async () => {
      await result.current.promptDep("ffmpeg", undefined, "ytdlp");
    });
    expect(result.current.modalState).toMatchObject({ feature: "yt-dlp", required: false });
  });

  it("keeps a feature the plugin named and marks a required tool required", async () => {
    mockBackend();
    const { result } = renderHook(() => useDependencies([plugin(true)]));
    await act(async () => {
      await result.current.promptDep("ffmpeg", "Video downloads", "ytdlp");
    });
    expect(result.current.modalState).toMatchObject({ feature: "Video downloads", required: true });
  });

  it("refuses a tool the plugin's manifest doesn't list", async () => {
    mockBackend();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    let answer: boolean | undefined;
    await act(async () => {
      answer = await result.current.promptDep("yt-dlp", undefined, "ytdlp");
    });
    expect(answer).toBe(false);
    expect(result.current.modalState).toBeNull();
    spy.mockRestore();
  });

  it("asks again after a dismiss", async () => {
    mockBackend();
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    await act(async () => {
      await result.current.promptDep("ffmpeg", undefined, "ytdlp");
    });
    act(() => result.current.dismissModal());
    expect(result.current.modalState).toBeNull();
    await act(async () => {
      await result.current.promptDep("ffmpeg", undefined, "ytdlp");
    });
    expect(result.current.modalState).not.toBeNull();
  });
});

describe("DependencyModal wording", () => {
  const dep = { ...FFMPEG_MISSING, pluginConsumers: [{ name: "yt-dlp", reason: "Convert WebM downloads to M4A", required: false }] } as never;

  it("says needed, and that the plugin works without it, for an optional tool", () => {
    render(<DependencyModal dep={dep} feature="yt-dlp" required={false} onDismiss={() => {}} onRecheck={() => {}} />);
    expect(screen.getByRole("heading").textContent).toBe("ffmpeg is needed");
    expect(document.body.textContent).toContain("uses ffmpeg to convert WebM downloads to M4A.");
    expect(document.body.textContent).toContain("It works without it");
  });

  it("says required by default, keeping the case of names in the reason", () => {
    render(<DependencyModal dep={dep} feature="yt-dlp" onDismiss={() => {}} onRecheck={() => {}} />);
    expect(screen.getByRole("heading").textContent).toBe("ffmpeg is required");
    expect(document.body.textContent).toContain("requires ffmpeg to convert WebM downloads to M4A.");
  });
});
