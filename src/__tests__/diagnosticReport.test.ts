import { describe, it, expect } from "vitest";
import {
  buildDiagnosticReport,
  scrubPaths,
  issueUrl,
  type DiagnosticInput,
} from "../utils/diagnosticReport";

function makeInput(overrides: Partial<DiagnosticInput> = {}): DiagnosticInput {
  return {
    environment: {
      appVersion: "1.0.14",
      channel: "stable",
      os: "macos",
      arch: "aarch64",
      profile: "default",
      engine: "native",
      mpvCapable: true,
      mpvVideo: true,
      loggingEnabled: true,
    },
    trackCount: 4212,
    collections: ["local", "subsonic"],
    plugins: [],
    dependencies: [],
    appErrors: [],
    resolverLog: [],
    logTail: [],
    context: null,
    homeDir: null,
    ...overrides,
  };
}

describe("scrubPaths", () => {
  it("replaces the home directory with ~", () => {
    expect(scrubPaths("/Users/alex/Music/a.flac", "/Users/alex")).toBe("~/Music/a.flac");
  });

  it("replaces every occurrence", () => {
    const text = "/Users/alex/a and /Users/alex/b";
    expect(scrubPaths(text, "/Users/alex")).toBe("~/a and ~/b");
  });

  it("handles Windows backslash home dirs in forward-slash form", () => {
    const text = "C:/Users/alex/Music/a.flac";
    expect(scrubPaths(text, "C:\\Users\\alex")).toBe("~/Music/a.flac");
  });

  it("handles percent-encoded paths from file:// URLs", () => {
    const text = "file:///Users/alex%20smith/a.flac";
    expect(scrubPaths(text, "/Users/alex smith")).toBe("file://~/a.flac");
  });

  it("is a no-op without a home dir", () => {
    expect(scrubPaths("/Users/alex/a", null)).toBe("/Users/alex/a");
    expect(scrubPaths("/Users/alex/a", "")).toBe("/Users/alex/a");
  });
});

describe("buildDiagnosticReport", () => {
  it("includes the environment facts", () => {
    const report = buildDiagnosticReport(makeInput());
    expect(report).toContain("1.0.14 (stable)");
    expect(report).toContain("macos aarch64");
    expect(report).toContain("4212 tracks");
    expect(report).toContain("local, subsonic");
    expect(report).toContain("libmpv loaded");
  });

  it("opens with a prompt for the user's own description", () => {
    expect(buildDiagnosticReport(makeInput())).toContain("### What happened");
  });

  it("scrubs the home directory out of every section", () => {
    const report = buildDiagnosticReport(
      makeInput({
        homeDir: "/Users/alex",
        logTail: ["[2026-08-05] ERROR scanner: failed on /Users/alex/Music/a.flac"],
        appErrors: [{ seq: 1, ts: "2026-08-05T10:00:00Z", scope: "window", message: "cannot read /Users/alex/x" }],
      }),
    );
    expect(report).not.toContain("/Users/alex");
    expect(report).toContain("~/Music/a.flac");
    expect(report).toContain("~/x");
  });

  it("lists only enabled plugins, with versions", () => {
    const report = buildDiagnosticReport(
      makeInput({
        plugins: [
          { id: "lastfm", version: "2.1.0", enabled: true, status: "active" },
          { id: "spotify", version: "0.9.0", enabled: false, status: "inactive" },
        ],
      }),
    );
    expect(report).toContain("Plugins enabled (1)");
    expect(report).toContain("lastfm 2.1.0");
    expect(report).not.toContain("spotify");
  });

  it("surfaces a plugin that failed to load", () => {
    const report = buildDiagnosticReport(
      makeInput({
        plugins: [{ id: "ytdlp", version: "1.7.0", enabled: true, status: "error", error: "manifest invalid" }],
      }),
    );
    expect(report).toContain("ytdlp 1.7.0 — error: manifest invalid");
  });

  it("reports missing companion binaries", () => {
    const report = buildDiagnosticReport(
      makeInput({
        dependencies: [
          { name: "yt-dlp", status: "installed", version: "2026.07.01", origin: "managed" },
          { name: "ffmpeg", status: "notFound" },
        ],
      }),
    );
    expect(report).toContain("yt-dlp 2026.07.01 (managed)");
    expect(report).toContain("ffmpeg — notFound");
  });

  it("includes an optional context block", () => {
    const report = buildDiagnosticReport(
      makeInput({ context: { title: "Playback failure", lines: ["Error: boom", "Source: web"] } }),
    );
    expect(report).toContain("### Playback failure");
    expect(report).toContain("- Error: boom");
  });

  it("tells the user to enable logging when there is no log", () => {
    const report = buildDiagnosticReport(
      makeInput({ environment: { ...makeInput().environment, loggingEnabled: false }, logTail: [] }),
    );
    expect(report).toContain("Enable logging");
  });

  it("omits the enable-logging nudge when a log tail is present", () => {
    const report = buildDiagnosticReport(makeInput({ logTail: ["[2026-08-05] INFO: started"] }));
    expect(report).not.toContain("Enable logging");
    expect(report).toContain("Log tail (1 lines)");
  });

  it("caps the resolver log so the report stays pasteable", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      seq: i,
      ts: "2026-08-05T10:00:00Z",
      kind: "stream" as const,
      provider: `p${i}`,
      input: { q: "x" },
      outcome: "error" as const,
      ms: 5,
      error: "boom",
    }));
    const report = buildDiagnosticReport(makeInput({ resolverLog: entries }));
    expect(report).toContain("Resolver activity (25)");
    // Keeps the most recent attempts — those are the ones near the failure.
    expect(report).toContain("p59");
    expect(report).not.toContain("p0 ");
  });

  it("survives an unserializable resolver input", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const report = buildDiagnosticReport(
      makeInput({
        resolverLog: [
          { seq: 1, ts: "2026-08-05T10:00:00Z", kind: "stream", provider: "p", input: circular, outcome: "ok", ms: 1 },
        ],
      }),
    );
    expect(report).toContain("[unserializable]");
  });

  it("reports an unknown track count rather than a misleading zero", () => {
    expect(buildDiagnosticReport(makeInput({ trackCount: null }))).toContain("unknown tracks");
  });

  it("says so when there are no music sources", () => {
    expect(buildDiagnosticReport(makeInput({ collections: [] }))).toContain("no sources");
  });
});

describe("issueUrl", () => {
  it("builds a prefilled new-issue URL", () => {
    const url = issueUrl("https://github.com/o/r/issues", "Playback failed");
    expect(url).toContain("https://github.com/o/r/issues/new?title=Playback%20failed");
    expect(url).toContain("body=");
  });

  // A whole bundle in the query string blows past the practical URL limit and
  // GitHub truncates it silently, so the body must stay a short instruction.
  it("does not embed the report in the URL", () => {
    expect(issueUrl("https://github.com/o/r/issues", "t").length).toBeLessThan(400);
  });
});
