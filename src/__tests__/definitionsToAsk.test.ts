import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { definitionsToAsk, type PendingDefinition } from "../hooks/useDependencies";

function pending(over: Partial<PendingDefinition> = {}): PendingDefinition {
  return {
    pluginId: "torrents",
    pluginName: "Torrents",
    name: "rqbit",
    fingerprint: "fp1",
    repo: "someone/rqbit",
    verified: false,
    required: true,
    ...over,
  };
}

describe("definitionsToAsk", () => {
  it("asks for required definitions only, grouped by plugin", () => {
    const asks = definitionsToAsk(
      [
        pending(),
        pending({ name: "helper", fingerprint: "fp2" }),
        pending({ name: "extra", fingerprint: "fp3", required: false }),
        pending({ pluginId: "other", pluginName: "Other", fingerprint: "fp4" }),
      ],
      new Set(),
    );
    expect(asks.map((a) => [a.pluginId, a.items.map((i) => i.name)])).toEqual([
      ["torrents", ["rqbit", "helper"]],
      ["other", ["rqbit"]],
    ]);
  });

  it("doesn't ask again for a definition already answered this session", () => {
    expect(definitionsToAsk([pending()], new Set(["torrents:fp1"]))).toEqual([]);
    // A changed definition (new fingerprint) is a new question.
    expect(definitionsToAsk([pending({ fingerprint: "fp9" })], new Set(["torrents:fp1"]))).toHaveLength(1);
  });
});
