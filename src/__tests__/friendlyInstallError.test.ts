import { describe, it, expect } from "vitest";
import { friendlyInstallError } from "../components/PluginInstallModal";

describe("friendlyInstallError", () => {
  it("maps GitHub 5xx to a transient-availability message", () => {
    for (const code of ["HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504"]) {
      expect(friendlyInstallError(code)).toMatch(/temporarily unavailable/i);
    }
  });

  it("maps timeouts to a timeout message", () => {
    expect(
      friendlyInstallError("HTTP error: error sending request for url (…): operation timed out"),
    ).toMatch(/timed out/i);
    expect(friendlyInstallError("Download failed: request timeout")).toMatch(/timed out/i);
  });

  it("maps send/connection failures to an unreachable message", () => {
    expect(friendlyInstallError("HTTP error: error sending request for url")).toMatch(
      /couldn't reach github/i,
    );
    expect(
      friendlyInstallError("Download failed: tcp connect error: connection refused"),
    ).toMatch(/couldn't reach github/i);
    expect(friendlyInstallError("Read error: connection reset by peer")).toMatch(
      /couldn't reach github/i,
    );
  });

  it("passes specific, actionable errors through unchanged", () => {
    const version = "This plugin requires app version 0.9.200 or newer (you have 0.9.172).";
    expect(friendlyInstallError(version)).toBe(version);
    const noUrl = "Gallery entry has no updateUrl; cannot install.";
    expect(friendlyInstallError(noUrl)).toBe(noUrl);
    // A 4xx is not the transient class we rewrite — it passes through verbatim.
    expect(friendlyInstallError("HTTP 404")).toBe("HTTP 404");
  });

  it("falls back to a generic message when the error is absent", () => {
    expect(friendlyInstallError()).toMatch(/something went wrong/i);
    expect(friendlyInstallError("")).toMatch(/something went wrong/i);
  });
});
