import { describe, it, expect, vi } from "vitest";

// useStreamResolution imports Tauri's invoke/convertFileSrc at module level;
// stub them so the pure failure-label helpers load without the Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import { entryFailureLabel, describeChainFailure } from "../hooks/useStreamResolution";

describe("entryFailureLabel", () => {
  it("names the failed resolver", () => {
    expect(entryFailureLabel("Subsonic")).toBe("Subsonic failed");
    expect(entryFailureLabel("Direct URL")).toBe("Direct URL failed");
  });

  it("phrases the Library resolver as a lookup miss, not a failure", () => {
    expect(entryFailureLabel("Library")).toBe("Not in library");
  });
});

describe("describeChainFailure", () => {
  it("blames the track's own source, not the last fallback resolver tried", () => {
    // A YouTube track that fails everywhere must not read "Subsonic Servers
    // failed" just because that plugin resolver sat last in the user's order.
    expect(
      describeChainFailure([
        { name: "Ytdlp", native: true },
        { name: "Library" },
        { name: "Subsonic Servers" },
      ]),
    ).toBe("Ytdlp failed");
  });

  it("blames the native source regardless of its position", () => {
    expect(
      describeChainFailure([
        { name: "Library" },
        { name: "Subsonic", native: true },
        { name: "Subsonic Servers" },
      ]),
    ).toBe("Subsonic failed");
  });

  it("uses a neutral label for path-less tracks with no native source", () => {
    expect(
      describeChainFailure([{ name: "Library" }, { name: "Subsonic Servers" }]),
    ).toBe("No playable source found");
  });
});
