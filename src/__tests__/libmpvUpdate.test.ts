// scripts/lib/libmpvUpdate.mjs decides what the weekly libmpv update proposes.
// A wrong decision here either re-pins to an archive fetch-libmpv.mjs can't
// unpack, ships a libmpv the engine refuses, or points the lock at an upstream
// link that will be deleted — the failure that broke the v1.0.94 Windows build.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { UPSTREAMS, archiveProblems, lockEntryFor, missingFiles, mirrorUrl, parseClientApiVersion, pickAsset, prBody, sameCommit } from "../../scripts/lib/libmpvUpdate.mjs";

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
    expect(body).toMatch(/Before merging/);
  });
});
