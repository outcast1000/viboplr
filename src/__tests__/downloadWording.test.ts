import { describe, it, expect } from "vitest";
import { downloadWording } from "../components/download/types";

describe("downloadWording", () => {
  it("says Download by default", () => {
    const w = downloadWording(undefined);
    expect(w.singleTitle).toBe("Download track");
    expect(w.start).toBe("Download");
    expect(w.startMany(1)).toBe("Download 1 track");
    expect(w.done).toBe("Download complete");
    expect(w.summary(2, 3)).toBe("Downloaded 2 of 3 tracks");
  });

  it("an import never says Download — the files are already here", () => {
    const w = downloadWording("import");
    expect(w.singleTitle).toBe("Add to library");
    expect(w.start).toBe("Add to library");
    expect(w.startMany(4)).toBe("Add 4 tracks");
    expect(w.multiTitle(4)).toBe("Add 4 tracks to library");
    expect(w.done).toBe("Added to library");
    expect(w.summary(4, 4)).toBe("Added 4 of 4 tracks to the library");
    const all = [w.singleTitle, w.multiTitle(2), w.start, w.startMany(2), w.startAnyway, w.working("Soulseek"), w.workingMany, w.done, w.failed, w.summary(1, 2)];
    for (const s of all) expect(s).not.toMatch(/download/i);
  });
});
