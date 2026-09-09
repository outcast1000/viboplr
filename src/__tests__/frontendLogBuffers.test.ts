import { describe, expect, it } from "vitest";
import { recordPluginLog, pluginLogEntries } from "../utils/pluginLog";
import { recordNotification, notificationLogEntries } from "../utils/notificationLog";

// These buffers are the durable trace behind fire-and-forget flows (plugin
// actions whose only feedback is a toast, plugin api.log lines whose file log
// is off by default). What matters: entries are retained in order, snapshots
// are copies, and the ring caps instead of growing forever.

describe("pluginLog ring buffer", () => {
  it("retains entries in order with level/section/message", () => {
    recordPluginLog("error", "Watch video failed: network timeout", "ytdlp");
    recordPluginLog("warn", "yt-dlp search parsed 0 valid candidates", "ytdlp");
    const entries = pluginLogEntries();
    const last = entries[entries.length - 1];
    expect(last.level).toBe("warn");
    expect(last.section).toBe("ytdlp");
    expect(last.message).toContain("0 valid candidates");
    expect(entries[entries.length - 2].level).toBe("error");
    expect(last.seq).toBeGreaterThan(entries[entries.length - 2].seq);
  });

  it("caps at 200 entries and returns snapshots, not the live buffer", () => {
    for (let i = 0; i < 250; i++) recordPluginLog("info", `line ${i}`, "test");
    const snap = pluginLogEntries();
    expect(snap.length).toBe(200);
    snap.pop();
    expect(pluginLogEntries().length).toBe(200);
  });
});

describe("notification ring buffer", () => {
  it("retains toast messages in order and caps at 50", () => {
    for (let i = 0; i < 60; i++) recordNotification(`toast ${i}`);
    const entries = notificationLogEntries();
    expect(entries.length).toBe(50);
    expect(entries[entries.length - 1].message).toBe("toast 59");
    expect(entries[0].message).toBe("toast 10");
  });
});
