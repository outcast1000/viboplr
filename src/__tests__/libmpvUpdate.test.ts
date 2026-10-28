// scripts/lib/libmpvUpdate.mjs decides what the weekly libmpv update proposes.
// A wrong decision here either re-pins to an archive fetch-libmpv.mjs can't
// unpack, ships a libmpv the engine refuses, or points the lock at an upstream
// link that will be deleted — the failure that broke the v1.0.94 Windows build.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { REQUIRED_CHECKS, UPSTREAMS, archiveProblems, hostPlatformKey, isSelfBuilt, libmpvAction, lockEntryFor, missingFiles, mirrorUrl, parseClientApiVersion, pickAsset, prBody, requiredChecksState, sameCommit, vendorState } from "../../scripts/lib/libmpvUpdate.mjs";

const win = UPSTREAMS["windows-x86_64"];
const mac = UPSTREAMS["macos-aarch64"];
const asset = (name: string) => ({ name, browser_download_url: `https://example.com/${name}` });

describe("pickAsset", () => {
  it("takes the plain x86_64 dev archive, never the v3 / aarch64 / i686 builds", () => {
    const release = {
      tag_name: "20261008",
      assets: [
        asset("mpv-x86_64-20261008-git-36bf3d5290.7z"),
        asset("mpv-dev-x86_64-v3-20261008-git-36bf3d5290.7z"),
        asset("mpv-dev-aarch64-20261008-git-36bf3d5290.7z"),
        asset("mpv-dev-i686-20261008-git-36bf3d5290.7z"),
        asset("mpv-dev-x86_64-20261008-git-36bf3d5290.7z"),
      ],
    };
    expect(pickAsset(release, win)).toEqual({
      name: "mpv-dev-x86_64-20261008-git-36bf3d5290.7z",
      url: "https://example.com/mpv-dev-x86_64-20261008-git-36bf3d5290.7z",
      gitHash: "36bf3d5290",
      tag: "20261008",
    });
  });

  it("takes the arm64 libmpv zip on macOS, not ffmpeg, the player or x86_64", () => {
    const release = {
      tag_name: "2026-10-05",
      assets: [
        asset("ffmpeg-arm64-a35c879992.zip"),
        asset("libmpv-x86_64-c152964208.zip"),
        asset("mpv-arm64-git-c152964208.zip"),
        asset("libmpv-arm64-c152964208.zip"),
      ],
    };
    expect(pickAsset(release, mac)?.name).toBe("libmpv-arm64-c152964208.zip");
    expect(pickAsset(release, mac)?.gitHash).toBe("c152964208");
  });

  it("is null when upstream renamed its files", () => {
    expect(pickAsset({ tag_name: "x", assets: [asset("libmpv-universal.zip")] }, mac)).toBeNull();
    expect(pickAsset(null, mac)).toBeNull();
  });
});

describe("sameCommit", () => {
  it("matches hashes shortened to different lengths, case-insensitively", () => {
    expect(sameCommit("304426c", "304426cab1")).toBe(true);
    expect(sameCommit("3F1B23ABD0", "3f1b23abd0")).toBe(true);
    expect(sameCommit("304426c", "36bf3d5")).toBe(false);
  });

  it("never matches on a too-short or missing hash", () => {
    expect(sameCommit("3f1b", "3f1b23abd0")).toBe(false);
    expect(sameCommit(undefined, "3f1b23abd0")).toBe(false);
  });
});

describe("archive checks", () => {
  const header = "#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(2, 5)\n";

  it("reads the client API version", () => {
    expect(parseClientApiVersion(header)).toEqual({ major: 2, minor: 5 });
    expect(parseClientApiVersion("nothing here")).toBeNull();
  });

  it("finds required files in a listing however the tool spells paths", () => {
    expect(missingFiles(["./libmpv-2.dll", "include/", "include/mpv/client.h", "libmpv.dll.a"], win.required)).toEqual([]);
    expect(missingFiles(["libmpv-2.dll"], win.required)).toEqual(["libmpv.dll.a", "include/mpv/client.h"]);
  });

  it("accepts a usable archive and explains each problem otherwise", () => {
    expect(archiveProblems(win, ["libmpv-2.dll", "libmpv.dll.a", "include/mpv/client.h"], header)).toEqual([]);
    const bad = archiveProblems(win, ["libmpv-2.dll"], "#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(3, 0)");
    expect(bad).toHaveLength(2);
    expect(bad[0]).toMatch(/libmpv\.dll\.a/);
    expect(bad[1]).toMatch(/needs major 2/);
    expect(archiveProblems(mac, ["libmpv/libmpv.2.dylib", "libmpv/include/client.h"], "")[0]).toMatch(/no MPV_CLIENT_API_VERSION/);
  });
});

describe("the new pin", () => {
  it("points at our mirror and records the upstream origin", () => {
    const picked = { name: "mpv-dev-x86_64-20261008-git-36bf3d5290.7z", url: "https://up/x.7z", gitHash: "36bf3d5290", tag: "20261008" };
    const entry = lockEntryFor(win, picked, "abc");
    expect(entry).toEqual({
      source: win.source,
      url: "https://github.com/outcast1000/viboplr/releases/download/vendor-libmpv/mpv-dev-x86_64-20261008-git-36bf3d5290.7z",
      upstream: "https://up/x.7z",
      sha256: "abc",
      mpvGitHash: "36bf3d5290",
    });
    expect(entry.url).toBe(mirrorUrl(picked.name));
  });

  it("the PR body names both commits, links the mpv diff, and asks for a playback check", () => {
    const body = prBody([
      {
        platform: "macos-aarch64",
        from: { mpvGitHash: "3f1b23abd0" },
        to: { mpvGitHash: "c152964208", upstream: "https://up/m.zip" },
        tag: "2026-10-05",
        api: { major: 2, minor: 5 },
      },
    ]);
    expect(body).toContain("`3f1b23abd0` | `c152964208`");
    expect(body).toContain("https://github.com/mpv-player/mpv/compare/3f1b23abd0...c152964208");
    expect(body).toContain("| 2.5 |");
    expect(body).toMatch(/Before releasing/);
  });
});

// What `npm run bump` does about a libmpv update, with nobody asked. A merge
// puts a new playback engine in front of every user of the release, so it must
// happen only for a PR whose engine tests passed (not a draft) AND whose CI
// passed, and only when the release is cut from main.
describe("libmpvAction", () => {
  const pr = { number: 7, title: "Update libmpv (macos-aarch64)", url: "https://github.com/o/r/pull/7", isDraft: false };

  it("merges a non-draft PR whose required checks passed, on main", () => {
    expect(libmpvAction({ pr, checks: "passed", behind: false, onMain: true }).action).toBe("merge");
  });

  it("never merges a draft — its engine tests failed", () => {
    const a = libmpvAction({ pr: { ...pr, isDraft: true }, checks: "passed", behind: false, onMain: true });
    expect(a.action).toBe("skip");
    expect(a.reason).toMatch(/draft/);
  });

  it("never merges while CI is pending or after it failed", () => {
    expect(libmpvAction({ pr, checks: "pending", behind: false, onMain: true }).action).toBe("skip");
    expect(libmpvAction({ pr, checks: "failed", behind: false, onMain: true }).action).toBe("skip");
    expect(libmpvAction({ pr, checks: null, behind: false, onMain: true }).action).toBe("skip");
  });

  it("never merges off main, where it wouldn't reach this release", () => {
    expect(libmpvAction({ pr, checks: "passed", behind: false, onMain: false }).action).toBe("skip");
  });

  it("starts the workflow when upstream is newer and no PR is open, and does nothing when current", () => {
    expect(libmpvAction({ pr: null, checks: null, behind: true, onMain: true }).action).toBe("run");
    expect(libmpvAction({ pr: null, checks: null, behind: false, onMain: true }).action).toBe("none");
  });
});

describe("requiredChecksState", () => {
  const ok = (name: string) => ({ name, status: "COMPLETED", conclusion: "SUCCESS" });

  it("passes only when every required check succeeded", () => {
    expect(requiredChecksState(REQUIRED_CHECKS.map(ok))).toBe("passed");
  });

  it("is pending when a required check never reported — CI started but not there yet", () => {
    expect(requiredChecksState([ok("typecheck"), ok("test-ts")])).toBe("pending");
    expect(requiredChecksState([])).toBe("pending");
    expect(requiredChecksState(undefined)).toBe("pending");
  });

  it("is pending while one is still running", () => {
    const rollup = [ok("typecheck"), ok("test-ts"), { name: "rust-check-and-test", status: "IN_PROGRESS", conclusion: "" }];
    expect(requiredChecksState(rollup)).toBe("pending");
  });

  it("fails when a required check failed, even if other checks are still running", () => {
    const rollup = [{ name: "typecheck", status: "COMPLETED", conclusion: "FAILURE" }, { name: "test-ts", status: "QUEUED", conclusion: "" }];
    expect(requiredChecksState(rollup)).toBe("failed");
  });

  it("reads REST check runs, which spell status and conclusion in lower case", () => {
    const rest = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
    expect(requiredChecksState(REQUIRED_CHECKS.map((n: string) => rest(n, "completed", "success")))).toBe("passed");
    expect(requiredChecksState([rest("typecheck", "in_progress", null), rest("rust-check-and-test", "completed", "success"), rest("test-ts", "completed", "success"), rest("rust-check-windows", "completed", "success")])).toBe("pending");
    expect(requiredChecksState([rest("typecheck", "completed", "failure"), rest("rust-check-and-test", "completed", "success"), rest("test-ts", "completed", "success"), rest("rust-check-windows", "completed", "success")])).toBe("failed");
  });

  it("ignores checks the ruleset doesn't require", () => {
    expect(requiredChecksState([...REQUIRED_CHECKS.map(ok), { name: "lint-extra", status: "COMPLETED", conclusion: "FAILURE" }])).toBe("passed");
  });
});

describe("hostPlatformKey", () => {
  it("names platforms the way the vendor dir and the lock do", () => {
    expect(hostPlatformKey("darwin", "arm64")).toBe("macos-aarch64");
    expect(hostPlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(hostPlatformKey("linux", "x64")).toBe("linux-x86_64");
  });
});

describe("vendorState", () => {
  const entry = { sha256: "abc123" };

  it("is current when the stamp is the pinned archive's hash", () => {
    expect(vendorState(entry, "abc123\n")).toBe("current");
  });

  it("is stale when a pull moved the pin past what is vendored", () => {
    expect(vendorState(entry, "0ld0ld\n")).toBe("stale");
  });

  it("is missing when nothing was ever vendored", () => {
    expect(vendorState(entry, null)).toBe("missing");
  });

  it("is unpinned on a platform the lock doesn't cover", () => {
    expect(vendorState(undefined, null)).toBe("unpinned");
    expect(vendorState(undefined, "abc123")).toBe("unpinned");
  });
});

describe("isSelfBuilt", () => {
  it("marks a pin to our own build, which the weekly upstream update must leave alone", () => {
    expect(isSelfBuilt({ selfBuilt: true, mpvGitHash: "41f6a64506" })).toBe(true);
  });

  it("treats an upstream pin, or a missing one, as updatable", () => {
    expect(isSelfBuilt({ source: "eko5624/mpv-mac", mpvGitHash: "baa3e11d42" })).toBe(false);
    expect(isSelfBuilt({ selfBuilt: "yes" })).toBe(false);
    expect(isSelfBuilt(undefined)).toBe(false);
  });
});
