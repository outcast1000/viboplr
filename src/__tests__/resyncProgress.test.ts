import { describe, it, expect } from "vitest";
import { resyncFraction, resyncStatusText } from "../utils/resyncProgress";

describe("resyncProgress", () => {
  it("counting has no fraction and says how many files were found", () => {
    const p = { kind: "scan" as const, scanned: 1234, total: 0, counting: true };
    expect(resyncFraction(p)).toBeNull();
    expect(resyncStatusText(p)).toBe(`Counting files… ${(1234).toLocaleString()} found`);
    expect(resyncStatusText({ ...p, scanned: 0 })).toBe("Counting files…");
  });

  it("a scan with a total reports its fraction and count", () => {
    const p = { kind: "scan" as const, scanned: 1000, total: 4000 };
    expect(resyncFraction(p)).toBe(0.25);
    expect(resyncStatusText(p)).toBe(`Scanning… ${(1000).toLocaleString()} / ${(4000).toLocaleString()} files`);
  });

  it("a sync counts albums", () => {
    expect(resyncStatusText({ kind: "sync", scanned: 3, total: 10 })).toBe("Syncing… 3 / 10 albums");
  });

  it("no total yet is indeterminate, not 0%", () => {
    const p = { kind: "sync" as const, scanned: 0, total: 0 };
    expect(resyncFraction(p)).toBeNull();
    expect(resyncStatusText(p)).toBe("Preparing sync…");
  });

  it("clamps an overshoot", () => {
    expect(resyncFraction({ kind: "scan", scanned: 12, total: 10 })).toBe(1);
  });
});
