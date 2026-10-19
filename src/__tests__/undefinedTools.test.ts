import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { undefinedTools, type DependencyInfo, type PendingDefinition } from "../hooks/useDependencies";
import { dependencyAttentionCount } from "../components/DependenciesPanel";

function dep(name: string): DependencyInfo {
  return {
    name,
    description: "",
    status: "installed",
    internalConsumers: [],
    pluginConsumers: [],
    install: { macos: "", windows: "", linux: "", url: "" },
    managedAvailable: true,
    declaredBy: [],
    signedDefinition: true,
    verified: true,
    sourceMismatch: false,
  };
}

const pending: PendingDefinition = {
  pluginId: "torrents", pluginName: "Torrents", name: "rqbit", fingerprint: "fp", repo: null, verified: true, required: true,
};

describe("undefinedTools", () => {
  const decls = [
    { name: "yt-dlp", pluginName: "Old YouTube", reason: "", required: true },
    { name: "yt-dlp", pluginName: "Completer", reason: "", required: false },
    { name: "ffmpeg", pluginName: "FFmpeg Tools", reason: "", required: true },
    { name: "rqbit", pluginName: "Torrents", reason: "", required: true },
  ];

  it("lists what enabled plugins use that nothing defines or is waiting to define", () => {
    expect(undefinedTools(decls, [dep("ffmpeg")], [pending])).toEqual([
      { name: "yt-dlp", plugins: ["Old YouTube", "Completer"], required: true },
    ]);
  });

  it("says nothing before the first check", () => {
    expect(undefinedTools(decls, [], [])).toEqual([]);
  });
});

describe("dependencyAttentionCount with plugin-defined tools", () => {
  it("counts each plugin waiting on a required OK once, and required undefined tools", () => {
    const optional = { ...pending, name: "extra", fingerprint: "fp2", required: false };
    const count = dependencyAttentionCount(
      [dep("ffmpeg")],
      [],
      { pendingConsent: [pending, { ...pending, name: "helper", fingerprint: "fp3" }, optional] },
      [
        { name: "yt-dlp", plugins: ["X"], required: true },
        { name: "maybe", plugins: ["Y"], required: false },
      ],
    );
    expect(count).toBe(2);
  });
});
