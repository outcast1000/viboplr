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

// `state` answers `dependency_definition_state` — a function for an answer
// that changes (consent granted).
function mockBackend(state: unknown | (() => unknown) = { kind: "active" }, checkResult: unknown[] = [FFMPEG_MISSING]) {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "check_dependencies") return checkResult;
    if (cmd === "dependency_definition_state") return typeof state === "function" ? (state as () => unknown)() : state;
    if (cmd === "dependency_registry_status") return { conflicts: [], pendingConsent: [], refused: [], unused: [], ignored: [] };
    return null;
  });
}

const PENDING_FFMPEG = {
  pluginId: "ytdlp", pluginName: "yt-dlp", name: "ffmpeg", fingerprint: "fp1",
  repo: "someone/ffmpeg", verified: true, required: false,
};

async function rejectionOf(p: Promise<unknown>): Promise<string> {
  let message = "";
  await act(async () => {
    await p.catch((e) => { message = (e as Error).message; });
  });
  return message;
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

  it("refuses a tool the plugin's manifest doesn't list, with a reason", async () => {
    mockBackend();
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    expect(await rejectionOf(result.current.promptDep("yt-dlp", undefined, "ytdlp"))).toMatch(/doesn't list it/);
    expect(result.current.modalState).toBeNull();
  });

  it("says the plugin isn't running rather than blaming its manifest", async () => {
    mockBackend();
    const { result } = renderHook(() => useDependencies([]));
    expect(await rejectionOf(result.current.promptDep("ffmpeg", undefined, "ytdlp"))).toMatch(/isn't running/);
  });

  // The silent wait this replaced: no definition in force meant no dialog, no
  // message, and a plugin polling for five minutes for an install that could
  // never happen. The reason is the backend's, read when the plugin asks.
  it.each([
    [{ kind: "devFolderIgnored" }, /release build of Vibo ignores tool definitions there/],
    [{ kind: "refused", reason: "unknown key" }, /refused this plugin's definition of it \(unknown key\)/],
    [{ kind: "undefined" }, /no installed plugin tells Vibo where to get it/],
  ])("says why when %o, instead of doing nothing", async (state, reason) => {
    mockBackend(state);
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    expect(await rejectionOf(result.current.promptDep("ffmpeg", undefined, "ytdlp"))).toMatch(reason);
    expect(result.current.modalState).toBeNull();
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "check_dependencies")).toBe(false);
  });

  // A request before the first background check: the definition waiting for
  // consent is found anyway, because it's asked of the backend, not read off
  // the hook's not-yet-loaded registry copy.
  it("asks consent first, then reads the state again and opens the dialog", async () => {
    let consented = false;
    mockBackend(() => (consented ? { kind: "active" } : { kind: "pendingConsent", item: PENDING_FFMPEG }));
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = result.current.promptDep("ffmpeg", undefined, "ytdlp");
    });
    expect(result.current.consentRequest).toMatchObject({ pluginId: "ytdlp", items: [PENDING_FFMPEG] });
    consented = true;
    await act(async () => {
      result.current.answerConsent(true);
      await answer;
    });
    expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "dependency_definitions_consent")).toBe(true);
    expect(result.current.modalState).toMatchObject({ feature: "yt-dlp", required: false });
  });

  it("treats a declined consent as the user's answer: no dialog, no error", async () => {
    mockBackend({ kind: "pendingConsent", item: PENDING_FFMPEG });
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    let answer: Promise<boolean> | undefined;
    await act(async () => {
      answer = result.current.promptDep("ffmpeg", undefined, "ytdlp");
    });
    await act(async () => {
      result.current.answerConsent(false);
    });
    await expect(answer).resolves.toBe(false);
    expect(result.current.modalState).toBeNull();
  });

  it("names a failed check as one, not as a missing definition", async () => {
    mockBackend({ kind: "active" }, []);
    const { result } = renderHook(() => useDependencies([plugin(false)]));
    expect(await rejectionOf(result.current.promptDep("ffmpeg", undefined, "ytdlp"))).toMatch(/couldn't check whether it's installed/);
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
