// scripts/lib/libmpvPin.mjs decides what `npm run libmpv:adopt` pins and what
// `npm run bump` checks before a release. A wrong decision here pins an archive
// whose hash doesn't match what was built, names the wrong mpv commit, or lets
// a release ship an engine component that isn't the bundled libmpv.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { assetDigest, buildAssetNames, buildProblems, engineComponentMismatches, ffmpegVersion, hostPlatformKey, isMissingRefError, lockEntryFromBuild, newestBuild, pinnedBuild, samePin, sourceLine, unpublishedComponents, vendorState } from "../../scripts/lib/libmpvPin.mjs";

const TAG = "vibo-git-9028187538-bf60c362";
const SHA = "dda4514e0712aa49cbde3ec4721b36fc01e1a562f52006b764f2bdebf78e7b9c";
const base = `https://github.com/outcast1000/viboplr-libmpv/releases/download/${TAG}`;
const asset = (name: string, digest?: string) => ({ name, browser_download_url: `${base}/${name}`, ...(digest ? { digest } : {}) });

// The shape build-libmpv.yml publishes (taken from the real bf60c362 release).
const release = (assets = [
  asset(`libmpv-${TAG}-macos-aarch64.zip`, `sha256:${SHA}`),
  asset(`libmpv-${TAG}-macos-aarch64.json`),
]) => ({ tag_name: TAG, assets });
const info = (extra: Record<string, unknown> = {}) => ({
  name: `libmpv-${TAG}-macos-aarch64.zip`,
  sha256: SHA,
  recipe: "bf60c362",
  platform: "macos-aarch64",
  mpv_ref: "9028187538",
  sources: { mpv: "https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz", ffmpeg: "https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz" },
  ...extra,
});

describe("buildAssetNames", () => {
  it("names the archive and its build info the way build-libmpv.yml does", () => {
    expect(buildAssetNames(TAG, "windows-x86_64")).toEqual({
      zip: `libmpv-${TAG}-windows-x86_64.zip`,
      info: `libmpv-${TAG}-windows-x86_64.json`,
    });
  });
});

describe("buildProblems", () => {
  it("accepts a release whose build info matches its archive", () => {
    expect(buildProblems(release(), "macos-aarch64", info())).toEqual([]);
  });

  it("names a platform the release didn't build", () => {
    const problems = buildProblems(release(), "windows-x86_64", null);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain(`libmpv-${TAG}-windows-x86_64.zip`);
  });

  it("refuses build info that describes another platform or file", () => {
    expect(buildProblems(release(), "macos-aarch64", info({ platform: "windows-x86_64" }))[0]).toContain("describes windows-x86_64");
    expect(buildProblems(release(), "macos-aarch64", info({ name: "other.zip" }))[0]).toContain("describes other.zip");
  });

  it("refuses an archive whose GitHub digest isn't the hash the build recorded", () => {
    const other = "0".repeat(64);
    const problems = buildProblems(release([asset(`libmpv-${TAG}-macos-aarch64.zip`, `sha256:${other}`), asset(`libmpv-${TAG}-macos-aarch64.json`)]), "macos-aarch64", info());
    expect(problems).toEqual([expect.stringContaining(other)]);
  });

  it("refuses an archive GitHub recorded no digest for — the build info alone can't vouch for itself", () => {
    expect(buildProblems(release([asset(`libmpv-${TAG}-macos-aarch64.zip`), asset(`libmpv-${TAG}-macos-aarch64.json`)]), "macos-aarch64", info()))
      .toEqual([expect.stringContaining("no sha256 for")]);
  });

  it("refuses build info with no usable sha256", () => {
    expect(buildProblems(release(), "macos-aarch64", info({ sha256: "" }))).toEqual([expect.stringContaining("no sha256")]);
  });
});

describe("isMissingRefError", () => {
  it("is true only for GitHub's unknown-ref answers", () => {
    expect(isMissingRefError("gh: No commit found for SHA: 0.41.0 (HTTP 422)")).toBe(true);
    expect(isMissingRefError("gh: Not Found (HTTP 404)")).toBe(true);
  });

  it("is false for auth, rate limit and network failures, which must be shown as themselves", () => {
    expect(isMissingRefError("gh: API rate limit exceeded (HTTP 403)")).toBe(false);
    expect(isMissingRefError("To get started with GitHub CLI, please run:  gh auth login")).toBe(false);
    expect(isMissingRefError("error connecting to api.github.com")).toBe(false);
  });
});

describe("unpublishedComponents", () => {
  const entry = (name: string) => ({ version: "v", url: `https://github.com/outcast1000/viboplr/releases/download/engine-components/${name}`, sha256: "abc" });

  it("names a zip the lock points at that the release doesn't have (a failed or skipped publish)", () => {
    const lock = { platforms: { "macos-aarch64": entry("engine-libmpv-macos-aarch64-new.zip"), "windows-x86_64": entry("engine-libmpv-windows-x86_64-new.zip") } };
    expect(unpublishedComponents(lock, new Set(["engine-libmpv-windows-x86_64-new.zip"])))
      .toEqual([{ platform: "macos-aarch64", name: "engine-libmpv-macos-aarch64-new.zip" }]);
  });

  it("leaves placeholder entries (no url) to engineComponentMismatches", () => {
    expect(unpublishedComponents({ platforms: { "macos-aarch64": { version: "", url: "", sha256: "" } } }, new Set())).toEqual([]);
  });
});

describe("assetDigest", () => {
  it("reads GitHub's sha256 digest, and nothing else", () => {
    expect(assetDigest({ digest: `sha256:${SHA.toUpperCase()}` })).toBe(SHA);
    expect(assetDigest({ digest: "md5:abc" })).toBeNull();
    expect(assetDigest({})).toBeNull();
  });
});

describe("lockEntryFromBuild", () => {
  it("pins the release's own URLs, the recorded hash and the resolved mpv commit", () => {
    expect(lockEntryFromBuild(release(), "macos-aarch64", info(), "9028187538")).toEqual({
      source: "self-built: outcast1000/viboplr-libmpv (mpv 9028187538, recipe bf60c362, trimmed, FFmpeg 9.0.2 static, LuaJIT, GPL)",
      selfBuilt: true,
      build: TAG,
      url: `${base}/libmpv-${TAG}-macos-aarch64.zip`,
      upstream: `${base}/libmpv-${TAG}-macos-aarch64.json`,
      sha256: SHA,
      mpvGitHash: "9028187538",
    });
  });
});

describe("sourceLine / ffmpegVersion", () => {
  it("reads the FFmpeg version off its source URL, and says so when it can't", () => {
    expect(ffmpegVersion(info())).toBe("9.0.2");
    expect(ffmpegVersion(info({ sources: {} }))).toBeNull();
    expect(sourceLine(info({ sources: {} }), "abc1234567")).toContain("FFmpeg static");
  });
});

describe("newestBuild", () => {
  const r = (tag_name: string, published_at: string, extra = {}) => ({ tag_name, published_at, draft: false, prerelease: false, ...extra });

  it("is the most recently published build, whatever order the list comes in", () => {
    expect(newestBuild([r("old", "2026-11-05T19:37:10Z"), r("new", "2026-11-05T23:14:25Z")])).toBe("new");
    expect(newestBuild([r("new", "2026-11-05T23:14:25Z"), r("old", "2026-11-05T19:37:10Z")])).toBe("new");
  });

  it("skips drafts and prereleases, and is null with nothing published", () => {
    expect(newestBuild([r("old", "2026-11-01T00:00:00Z"), r("draft", "2026-11-09T00:00:00Z", { draft: true }), r("pre", "2026-11-09T00:00:00Z", { prerelease: true })])).toBe("old");
    expect(newestBuild([])).toBeNull();
  });
});

describe("samePin", () => {
  const entry = lockEntryFromBuild(release(), "macos-aarch64", info(), "9028187538");

  it("ignores the source line, which may have been written by hand", () => {
    expect(samePin({ ...entry, source: "self-built … + coreaudio patch (mpv #18772)" }, entry)).toBe(true);
  });

  it("is false for different bytes, or a missing entry", () => {
    expect(samePin({ ...entry, sha256: "0".repeat(64) }, entry)).toBe(false);
    expect(samePin(undefined, entry)).toBe(false);
  });
});

describe("pinnedBuild", () => {
  it("is the build every platform pins", () => {
    expect(pinnedBuild({ platforms: { a: { build: TAG }, b: { build: TAG } } })).toBe(TAG);
  });

  it("is null when the platforms pin different builds, or one names none", () => {
    expect(pinnedBuild({ platforms: { a: { build: TAG }, b: { build: "other" } } })).toBeNull();
    expect(pinnedBuild({ platforms: { a: { mpvGitHash: "baa3e11d42" } } })).toBeNull();
    expect(pinnedBuild({ platforms: {} })).toBeNull();
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

describe("engineComponentMismatches", () => {
  const libmpv = (build: string | undefined, mpvGitHash = "9028187538") => ({
    platforms: {
      "macos-aarch64": { build, mpvGitHash },
      "windows-x86_64": { build, mpvGitHash },
    },
  });
  const component = (version: string, extra: Record<string, unknown> = {}) => ({
    version, url: `https://example.com/engine-${version}.zip`, sha256: "abc", ...extra,
  });

  it("is empty when every component is the build the release bundles", () => {
    const b = "vibo-git-9028187538-bf60c362";
    expect(engineComponentMismatches(libmpv(b), {
      platforms: { "macos-aarch64": component(b), "windows-x86_64": component(b) },
    })).toEqual([]);
  });

  it("names a component left on an older build by a hand re-pin (the cd123f3b miss)", () => {
    expect(engineComponentMismatches(libmpv("vibo-git-dc4b285c93-84dbcf9b", "dc4b285c93"), {
      platforms: {
        "macos-aarch64": component("vibo-git-dc4b285c93-e05f6f9f"),
        "windows-x86_64": component("vibo-git-dc4b285c93-84dbcf9b"),
      },
    })).toEqual([
      { platform: "macos-aarch64", expected: "vibo-git-dc4b285c93-84dbcf9b", actual: "vibo-git-dc4b285c93-e05f6f9f" },
    ]);
  });

  it("expects the mpv hash for an upstream pin with no build name, as the packager names it", () => {
    expect(engineComponentMismatches(libmpv(undefined, "baa3e11d42"), {
      platforms: { "macos-aarch64": component("baa3e11d42") },
    })).toEqual([]);
  });

  it("treats a placeholder (no url or sha256) as nothing published", () => {
    expect(engineComponentMismatches(libmpv("vibo-x"), {
      platforms: { "macos-aarch64": component("vibo-x", { url: "", sha256: "" }) },
    })).toEqual([{ platform: "macos-aarch64", expected: "vibo-x", actual: null }]);
  });

  it("skips a platform that has no component at all", () => {
    expect(engineComponentMismatches(libmpv("vibo-x"), { platforms: {} })).toEqual([]);
  });
});
