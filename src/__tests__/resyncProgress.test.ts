import { describe, it, expect } from "vitest";
import { resyncFraction, resyncModeLabel, resyncShortText, resyncStatusText } from "../utils/resyncProgress";

describe("resyncProgress", () => {
  it("counting has no fraction and says how many files were found", () => {
    const p = { kind: "scan" as const, scanned: 1234, total: 0, counting: true };
    expect(resyncFraction(p)).toBeNull();
    expect(resyncStatusText(p)).toBe(`Counting files… ${(1234).toLocaleString()} found`);
    expect(resyncStatusText({ ...p, scanned: 0 })).toBe("Counting files…");
  });

  it("counting names the folders walked, so it moves where no media is", () => {
    const p = { kind: "scan" as const, scanned: 0, total: 0, counting: true, folders: 1 };
    expect(resyncStatusText(p)).toBe("Counting files… 0 found in 1 folder");
    expect(resyncStatusText({ ...p, scanned: 1234, folders: 5600 })).toBe(
      `Counting files… ${(1234).toLocaleString()} found in ${(5600).toLocaleString()} folders`,
    );
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

  it("names what kind of run it is", () => {
    expect(resyncModeLabel({ kind: "scan", scanned: 0, total: 0, mode: "first" })).toBe("First scan");
    expect(resyncModeLabel({ kind: "scan", scanned: 0, total: 0, mode: "quick" })).toBe("Quick rescan");
    expect(resyncModeLabel({ kind: "scan", scanned: 0, total: 0, mode: "full" })).toBe("Full rescan");
    expect(resyncModeLabel({ kind: "scan", scanned: 0, total: 0 })).toBe("Scan");
    expect(resyncModeLabel({ kind: "sync", scanned: 0, total: 0 })).toBe("Sync");
  });

  it("the short step fits the caption bar", () => {
    expect(resyncShortText({ kind: "scan", scanned: 0, total: 0, counting: true })).toBe("Counting…");
    expect(resyncShortText({ kind: "scan", scanned: 0, total: 0, counting: true, folders: 3 })).toBe("0 found");
    expect(resyncShortText({ kind: "scan", scanned: 1000, total: 4000 })).toBe("25%");
    expect(resyncShortText({ kind: "sync", scanned: 0, total: 0 })).toBe("Preparing…");
  });
});
