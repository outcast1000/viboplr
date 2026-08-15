import { describe, it, expect, vi } from "vitest";

// useStreamResolution imports Tauri's invoke/convertFileSrc at module level;
// stub them so the pure failure-label helpers load without the Tauri runtime.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (p: string) => `asset://${p}`,
}));

import {
  entryFailureLabel,
  describeChainFailure,
  unownedSchemeLabel,
  httpEngineSource,
} from "../hooks/useStreamResolution";

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

  it("prefers the native entry's own label over the generic wording", () => {
    // A spotify:// row from a browse-only plugin, with no resolver installed
    // that can turn it into a stream. "Spotify failed" would blame the plugin
    // that produced the row and did nothing wrong.
    expect(
      describeChainFailure([
        { name: "Spotify", native: true, label: unownedSchemeLabel("spotify") },
        { name: "Library" },
      ]),
    ).toBe("No installed plugin can play spotify:// links");
  });

  it("ignores a label on a non-native entry", () => {
    // Only the native entry decides the blame, so a fallback's label must not
    // leak into the message.
    expect(
      describeChainFailure([
        { name: "Subsonic", native: true },
        { name: "Ytdlp", label: "should not win" },
      ]),
    ).toBe("Subsonic failed");
  });
});

describe("httpEngineSource", () => {
  it("carries a metadata resolver's request headers through to the engine", () => {
    // A metadata resolver (onStreamResolve) returns ONE url, not a candidate
    // list, so this is its only route for the headers a signed CDN url needs.
    const headers = { "User-Agent": "Mozilla/5.0", Referer: "https://example/" };
    expect(httpEngineSource("https://cdn.example/a.m4a", headers)).toEqual({
      kind: "http",
      url: "https://cdn.example/a.m4a",
      headers,
    });
  });

  it("omits headers entirely when there are none", () => {
    // Absent must stay absent, not become `headers: {}`: the mpv engine passes
    // None through to leave its http-header-fields alone, and an empty map
    // would overwrite it instead.
    expect(httpEngineSource("https://cdn.example/a.m4a")).toEqual({
      kind: "http",
      url: "https://cdn.example/a.m4a",
    });
    expect(httpEngineSource("https://cdn.example/a.m4a", {})).toEqual({
      kind: "http",
      url: "https://cdn.example/a.m4a",
    });
  });
});
