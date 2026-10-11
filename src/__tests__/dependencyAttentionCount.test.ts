import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { dependencyAttentionCount } from "../components/DependenciesPanel";
import type { DependencyInfo, DepUpdateInfo } from "../hooks/useDependencies";

function dep(name: string, over: Partial<DependencyInfo> = {}): DependencyInfo {
  return {
    name,
    description: "",
    status: "installed",
    internalConsumers: [],
    pluginConsumers: [],
    install: { macos: "", windows: "", linux: "", url: "" },
    managedAvailable: true,
    ...over,
  };
}

describe("dependencyAttentionCount", () => {
  it("is zero when everything is installed and current", () => {
    expect(dependencyAttentionCount([dep("ffmpeg")], [{ name: "ffmpeg", outdated: false }])).toBe(0);
  });

  it("counts outdated tools", () => {
    const updates: DepUpdateInfo[] = [
      { name: "yt-dlp", outdated: true },
      { name: "ffmpeg", outdated: false },
    ];
    expect(dependencyAttentionCount([dep("yt-dlp"), dep("ffmpeg")], updates)).toBe(1);
  });

  it("counts a missing tool only when some consumer requires it", () => {
    const deps = [
      dep("rqbit", { status: "notFound", pluginConsumers: [{ name: "rqbit", reason: "", required: true }] }),
      dep("ffmpeg", { status: "notFound", internalConsumers: [{ name: "Vibo", reason: "", required: false }] }),
      dep("roadie", { status: "notFound" }),
    ];
    expect(dependencyAttentionCount(deps, [])).toBe(1);
  });
});
