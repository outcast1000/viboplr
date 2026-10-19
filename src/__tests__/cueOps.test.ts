import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { saveCueSheet, type CueOpsDeps } from "../utils/cueOps";
import type { QueueTrack } from "../types";

const mockInvoke = vi.mocked(invoke);

const playing = { key: "q:1", title: "Song", artist_name: "Band", album_title: "Record", duration_secs: 200 } as QueueTrack;
const deps = (current: QueueTrack | null = playing, engineSecs: number | null = null): CueOpsDeps => ({
  currentTrack: () => current,
  currentDurationSecs: () => engineSecs,
  queue: () => [],
});
const song = { title: "Song", artistName: "Band" };

describe("saveCueSheet", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => (cmd === "cue_sheet_set" ? args : null));
  });

  it("rejects a cue past the song's end before reaching the backend", async () => {
    await expect(saveCueSheet(deps(), song, { cues: [{ at: 64500, kind: "text", text: "x" }] }))
      .rejects.toThrow(/cues\[0\]\.at is 64500s but the song is 200s long/);
    expect(mockInvoke).not.toHaveBeenCalledWith("cue_sheet_set", expect.anything());
  });

  it("fills album and length from the playing track when the caller declares none", async () => {
    await saveCueSheet(deps(playing, 201.5), song, { cues: [] });
    expect(mockInvoke).toHaveBeenCalledWith("cue_sheet_set", expect.objectContaining({
      title: "Song", artistName: "Band", albumName: "Record", durationSecs: 201.5,
    }));
  });

  it("keeps a declared length over the app's own — a shared sheet's timing", async () => {
    await saveCueSheet(deps(), song, { cues: [{ at: 230, kind: "text", text: "x" }] }, { durationSecs: 240, author: "Ann" });
    expect(mockInvoke).toHaveBeenCalledWith("cue_sheet_set", expect.objectContaining({ durationSecs: 240, author: "Ann" }));
  });

  it("takes the sheet's own track block only as a last resort, and strips it from the cues", async () => {
    await saveCueSheet(deps(null), song, { track: { title: "Song", durationSecs: 180, albumName: "Live" }, author: "Bo", cues: [] });
    expect(mockInvoke).toHaveBeenCalledWith("cue_sheet_set", {
      title: "Song", artistName: "Band", sheet: { cues: [] }, author: "Bo", albumName: "Live", durationSecs: 180,
    });
  });
});
