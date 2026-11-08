// Pure decisions behind the libmpv pin (scripts/libmpv.lock.json): what a build
// release of outcast1000/viboplr-libmpv pins to, whether the vendored copy and
// the downloadable engine component match the pin, and which build is pinned.
// No network, no filesystem: unit-tested in src/__tests__/libmpvPin.test.ts.
//
// The side effects live in scripts/adopt-libmpv.mjs (re-pin from a build) and
// scripts/bump.mjs (the release-time checks).

/** Where our libmpv is built (build-libmpv.yml) and published, one release per
 *  build, tagged with the build name. Builds published before that repo existed
 *  stay on this repo's 'vendor-libmpv' release, which released apps pin. */
export const LIBMPV_BUILD_REPO = "outcast1000/viboplr-libmpv";

/** Where the downloadable engine component zips live (publish-engine-components.mjs). */
export const ENGINE_COMPONENTS_REPO = "outcast1000/viboplr";
export const ENGINE_COMPONENTS_TAG = "engine-components";

/** The two assets a build release carries per platform: the archive
 *  fetch-libmpv.mjs unpacks, and its build-info JSON (sha256, mpv_ref, recipe,
 *  platform, sources). Named by build-libmpv.yml. */
export function buildAssetNames(tag, platform) {
  const base = `libmpv-${tag}-${platform}`;
  return { zip: `${base}.zip`, info: `${base}.json` };
}

/** The FFmpeg version a build used, read off its source URL (ffmpeg-9.0.2.tar.xz → "9.0.2"). */
export function ffmpegVersion(info) {
  const m = /ffmpeg-(\d+(?:\.\d+)*)\.tar/.exec(info?.sources?.ffmpeg ?? "");
  return m ? m[1] : null;
}

/** The lock's human-readable `source` line for a build. Patches aren't listed:
 *  they live in the recipe, which the line names. */
export function sourceLine(info, mpvCommit) {
  const ffmpeg = ffmpegVersion(info);
  return `self-built: ${LIBMPV_BUILD_REPO} (mpv ${mpvCommit}, recipe ${info.recipe}, trimmed, ${
    ffmpeg ? `FFmpeg ${ffmpeg} static` : "FFmpeg static"
  }, LuaJIT, GPL)`;
}

/** The sha256 GitHub records for a release asset ("sha256:<hex>"), or null. */
export function assetDigest(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? "");
  return m ? m[1].toLowerCase() : null;
}

/**
 * Everything wrong with one platform of a build release, as sentences; empty =
 * usable. `release` is the GitHub release JSON, `info` the parsed build-info
 * JSON (null when it couldn't be read).
 */
export function buildProblems(release, platform, info) {
  const tag = release?.tag_name;
  const names = buildAssetNames(tag, platform);
  const assets = release?.assets ?? [];
  const zip = assets.find((a) => a.name === names.zip);
  const problems = [];
  if (!zip) problems.push(`${platform}: the release has no ${names.zip}`);
  if (!assets.some((a) => a.name === names.info)) problems.push(`${platform}: the release has no ${names.info}`);
  if (!info) return problems;
  if (info.platform !== platform) problems.push(`${platform}: ${names.info} describes ${info.platform}`);
  if (info.name !== names.zip) problems.push(`${platform}: ${names.info} describes ${info.name}`);
  if (!/^[0-9a-f]{64}$/i.test(info.sha256 ?? "")) problems.push(`${platform}: ${names.info} carries no sha256`);
  // GitHub's digest is the one hash that doesn't come from the build itself;
  // without it the pin would rest on the build info alone, so it is required.
  const digest = assetDigest(zip);
  if (zip && !digest) problems.push(`${platform}: GitHub recorded no sha256 for ${names.zip}, so it can't be checked`);
  else if (digest && info.sha256 && digest !== info.sha256.toLowerCase()) {
    problems.push(`${platform}: ${names.zip} is ${digest} on GitHub but ${info.sha256} in its build info`);
  }
  return problems;
}

/** Does a failed `gh api repos/mpv-player/mpv/commits/<ref>` mean "no such
 *  ref under this spelling" (GitHub answers 422 for an unknown ref, 404 for an
 *  unknown path), rather than auth, rate limit or network trouble? */
export function isMissingRefError(text) {
  return /\(HTTP (404|422)\)/.test(text ?? "");
}

/** The new lock entry for one platform of a build. `mpvCommit` is the mpv
 *  commit the build's mpv_ref resolves to, 10 hex chars (the lock's form). */
export function lockEntryFromBuild(release, platform, info, mpvCommit) {
  const names = buildAssetNames(release.tag_name, platform);
  const url = (name) => release.assets.find((a) => a.name === name).browser_download_url;
  return {
    source: sourceLine(info, mpvCommit),
    selfBuilt: true,
    build: release.tag_name,
    url: url(names.zip),
    upstream: url(names.info),
    sha256: info.sha256.toLowerCase(),
    mpvGitHash: mpvCommit,
  };
}

/** The newest published build in a release list (`GET /repos/{repo}/releases`):
 *  latest `published_at`, drafts and prereleases left out; null when none.
 *  Not GitHub's "Latest" flag — build-libmpv.yml creates every release with
 *  `--latest=false`, so that flag says nothing about which build is newest. */
export function newestBuild(releases) {
  const published = (releases ?? []).filter((r) => !r.draft && !r.prerelease && r.published_at);
  if (!published.length) return null;
  return published.reduce((a, b) => (Date.parse(b.published_at) > Date.parse(a.published_at) ? b : a)).tag_name;
}

/** Do two lock entries pin the same archive? Only what decides the download
 *  counts; the `source` line is a description. */
export function samePin(a, b) {
  return Boolean(a && b) && a.url === b.url && a.sha256 === b.sha256 && a.build === b.build && a.mpvGitHash === b.mpvGitHash;
}

/** The build every platform pins, or null when they differ or one has none. */
export function pinnedBuild(lock) {
  const builds = new Set(Object.values(lock?.platforms ?? {}).map((e) => e?.build ?? null));
  if (builds.size !== 1) return null;
  return [...builds][0];
}

/** The `<os>-<arch>` key of the vendor dir and the lock (fetch-libmpv.mjs's hostPlatform). */
export function hostPlatformKey(platform = process.platform, arch = process.arch) {
  const os = platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : arch;
  return `${os}-${cpu}`;
}

/**
 * Does the vendored libmpv match the lock? `stamp` is the text of the vendor
 * dir's `.stamp` (the pinned archive's sha256, written by fetch-libmpv.mjs), or
 * null when there is none. Nothing in the build reads the lock, so after a pull
 * that moved the pin, dev runs, tests and a local `tauri build` keep loading the
 * old copy until someone re-vendors.
 *   current  — the vendored archive is the pinned one
 *   stale    — vendored, but not what the lock pins
 *   missing  — nothing vendored
 *   unpinned — the lock has no entry for this platform (nothing to fetch)
 */
export function vendorState(lockEntry, stamp) {
  if (!lockEntry?.sha256) return "unpinned";
  if (stamp == null) return "missing";
  return stamp.trim() === lockEntry.sha256 ? "current" : "stale";
}

/** The platforms whose downloadable engine component (src-tauri/engine-component.lock.json)
 *  isn't the libmpv the release bundles (scripts/libmpv.lock.json). The packager
 *  names a component `build ?? mpvGitHash`, so that is what each must say, with a
 *  url and sha256 behind it. A platform with no component entry has no component
 *  at all and is not checked. Exists because a hand re-pin (cd123f3b) moved libmpv
 *  to the macOS 27 fix and left the component on the build without it, so
 *  Settings → "Try a replacement copy" would have installed the broken engine. */
export function engineComponentMismatches(libmpvLock, componentLock) {
  const out = [];
  for (const [platform, entry] of Object.entries(libmpvLock?.platforms ?? {})) {
    const component = componentLock?.platforms?.[platform];
    if (!component) continue;
    const expected = entry.build ?? entry.mpvGitHash;
    const published = Boolean(component.url && component.sha256);
    const actual = published ? component.version ?? null : null;
    if (actual !== expected) out.push({ platform, expected, actual });
  }
  return out;
}

/** The component entries whose zip isn't on the release. package-engine-component.mjs
 *  writes url + sha256 for its local zip before anything is uploaded, so after a
 *  failed publish (or `--no-publish`) the lock reads as complete while its url is a
 *  404 — only the release's own asset list can tell. `publishedNames`: the asset
 *  names of the 'engine-components' release. Entries with no url are left to
 *  engineComponentMismatches, which already reports them. */
export function unpublishedComponents(componentLock, publishedNames) {
  const out = [];
  for (const [platform, component] of Object.entries(componentLock?.platforms ?? {})) {
    if (!component?.url) continue;
    const name = component.url.split("/").pop();
    if (!publishedNames.has(name)) out.push({ platform, name });
  }
  return out;
}
