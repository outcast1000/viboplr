import { describe, it, expect } from "vitest";
import { humanizeUpdateError, updateBadgeFor } from "../hooks/useAppUpdater";
import type { UpdateState } from "../hooks/useAppUpdater";

function makeState(patch: Partial<UpdateState> = {}): UpdateState {
  return {
    available: null,
    checking: false,
    downloading: false,
    progress: null,
    upToDate: false,
    error: null,
    ...patch,
  };
}

describe("humanizeUpdateError", () => {
  it("names GitHub's transient CDN failure rather than echoing the status", () => {
    const msg = humanizeUpdateError("Download request failed with status: 503", "install");
    expect(msg).toContain("temporarily unavailable");
    expect(msg).not.toContain("503");
  });

  it("treats the other gateway statuses the same way", () => {
    for (const status of ["502", "504"]) {
      expect(humanizeUpdateError(`Download request failed with status: ${status}`, "install"))
        .toContain("temporarily unavailable");
    }
  });

  it("distinguishes rate limiting from a plain outage", () => {
    expect(humanizeUpdateError("API rate limit exceeded", "check")).toContain("rate-limiting");
  });

  it("never suggests retrying a signature failure", () => {
    const msg = humanizeUpdateError("Minisign: signature verification failed", "install");
    expect(msg).toContain("signature");
    expect(msg).toContain("viboplr.com");
    expect(msg.toLowerCase()).not.toContain("try again");
  });

  it("blames the server, not the user's link, when the connection is dropped mid-request", () => {
    // The real chain the backend now surfaces for github.com's load-shedding.
    const h2 = "error sending request for url (https://github.com/…/latest.json): client error (SendRequest): http2 error: stream error received: refused stream before processing any application logic";
    expect(humanizeUpdateError(h2, "check")).toContain("dropped the connection");
    expect(humanizeUpdateError(h2, "check")).not.toContain("internet connection");
    const h1 = "error sending request for url (https://github.com/…/latest.json): client error (SendRequest): connection closed before message completed";
    expect(humanizeUpdateError(h1, "check")).toContain("dropped the connection");
    expect(humanizeUpdateError(h1, "check")).not.toContain("internet connection");
  });

  it("maps connection failures to a connectivity message", () => {
    expect(humanizeUpdateError("error sending request: dns error", "check")).toContain("internet connection");
    expect(humanizeUpdateError("operation timed out", "install")).toContain("internet connection");
  });

  it("explains a write failure as the read-only-mount case it usually is", () => {
    expect(humanizeUpdateError("Permission denied (os error 13)", "install")).toContain("Applications folder");
  });

  it("tells the user to re-check when the staged update is gone", () => {
    expect(humanizeUpdateError("no pending update — run app_update_check first", "install"))
      .toContain("Check for updates again");
  });

  it("falls back to a stage-specific sentence for unrecognised text", () => {
    expect(humanizeUpdateError("something inscrutable", "check")).toBe("Couldn't check for updates.");
    expect(humanizeUpdateError("something inscrutable", "install")).toBe("The update couldn't be installed.");
  });

  it("does not leak the raw backend text into the message", () => {
    const raw = "Download request failed with status: 503";
    expect(humanizeUpdateError(raw, "install")).not.toContain(raw);
  });
});

describe("updateBadgeFor", () => {
  const error = { stage: "check" as const, message: "m", detail: "d" };

  it("shows nothing when the updater is idle and healthy", () => {
    expect(updateBadgeFor(makeState())).toBeNull();
    expect(updateBadgeFor(makeState({ upToDate: true }))).toBeNull();
    expect(updateBadgeFor(makeState({ checking: true }))).toBeNull();
  });

  it("flags an available update", () => {
    expect(updateBadgeFor(makeState({ available: { version: "1.0.19", body: "" } }))).toBe("available");
  });

  it("flags a failure even with no update staged", () => {
    expect(updateBadgeFor(makeState({ error }))).toBe("error");
  });

  it("prefers the error when an update is also available", () => {
    expect(updateBadgeFor(makeState({
      available: { version: "1.0.19", body: "" },
      error: { stage: "install", message: "m", detail: "d", version: "1.0.19" },
    }))).toBe("error");
  });

  it("clears back to available once the error is dismissed", () => {
    const withError = makeState({ available: { version: "1.0.19", body: "" }, error });
    expect(updateBadgeFor({ ...withError, error: null })).toBe("available");
  });
});
