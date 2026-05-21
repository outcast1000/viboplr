import { describe, it, expect, vi } from "vitest";
import { pickRelayFromList } from "../../src-tauri/plugins/p2p-sharing/picker.js";

describe("pickRelayFromList", () => {
  it("returns null for an empty list", () => {
    expect(pickRelayFromList([])).toBe(null);
  });

  it("returns null when every row has empty multiaddrs", () => {
    const rows = [{ peer_id: "a", multiaddrs: [] }];
    expect(pickRelayFromList(rows)).toBe(null);
  });

  it("returns the only multiaddr when there is one row", () => {
    const rows = [{ peer_id: "a", multiaddrs: ["/dns4/h/udp/4001/quic-v1/p2p/a"] }];
    const result = pickRelayFromList(rows);
    expect(result).toEqual({
      peerId: "a",
      multiaddr: "/dns4/h/udp/4001/quic-v1/p2p/a",
    });
  });

  it("picks a row at random across multiple healthy relays", () => {
    const rows = [
      { peer_id: "a", multiaddrs: ["/a"] },
      { peer_id: "b", multiaddrs: ["/b"] },
      { peer_id: "c", multiaddrs: ["/c"] },
    ];
    vi.spyOn(Math, "random").mockReturnValue(0.6); // floor(0.6*3) = 1 -> "b"
    expect(pickRelayFromList(rows)).toEqual({ peerId: "b", multiaddr: "/b" });
    vi.restoreAllMocks();
  });

  it("skips rows that have no multiaddrs", () => {
    const rows = [
      { peer_id: "a", multiaddrs: [] },
      { peer_id: "b", multiaddrs: ["/b"] },
    ];
    // Force the first random to pick row 0 (empty); function should fall through.
    let calls = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (calls++ === 0 ? 0 : 0.99));
    const result = pickRelayFromList(rows);
    expect(result).toEqual({ peerId: "b", multiaddr: "/b" });
    vi.restoreAllMocks();
  });
});
