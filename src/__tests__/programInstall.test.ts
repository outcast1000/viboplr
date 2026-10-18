import { describe, expect, it } from "vitest";
import { describeProgramDownload, PROGRAM_LABEL_MAX } from "../utils/programInstall";

describe("describeProgramDownload", () => {
  const url = "https://github.com/slskd/slskd/releases/download/0.26.1/slskd-0.26.1-osx-arm64.zip";

  it("names the file and where it comes from, from the URL alone", () => {
    expect(describeProgramDownload(url, { sha256: "a".repeat(64), label: "slskd 0.26.1" })).toEqual({
      fileName: "slskd-0.26.1-osx-arm64.zip",
      host: "github.com",
      pinned: true,
      label: "slskd 0.26.1",
    });
  });

  it("says when no checksum is pinned and drops an empty label", () => {
    const facts = describeProgramDownload(url, { sha256: "  ", label: "   " });
    expect(facts.pinned).toBe(false);
    expect(facts.label).toBeNull();
    expect(describeProgramDownload(url).pinned).toBe(false);
  });

  it("decodes the file name, survives a malformed escape, and falls back to the host", () => {
    expect(describeProgramDownload("https://x.org/dl/My%20Tool.zip").fileName).toBe("My Tool.zip");
    expect(describeProgramDownload("https://x.org/dl/bad%E0.zip").fileName).toBe("bad%E0.zip");
    expect(describeProgramDownload("https://x.org/").fileName).toBe("x.org");
  });

  it("keeps the plugin's label to one short line", () => {
    const facts = describeProgramDownload(url, { label: `slskd\n\n${"x".repeat(500)}` });
    expect(facts.label!.length).toBe(PROGRAM_LABEL_MAX);
    expect(facts.label).not.toContain("\n");
    expect(describeProgramDownload(url, { label: 42 }).label).toBeNull();
  });

  it("refuses a URL that doesn't parse", () => {
    expect(() => describeProgramDownload("not a url")).toThrow(/Invalid URL/);
  });
});
