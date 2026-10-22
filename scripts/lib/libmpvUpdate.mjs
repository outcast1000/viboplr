// Pure decisions behind scripts/update-libmpv.mjs — which upstream build is the
// newest, whether it differs from the pin, whether its archive looks like the
// one fetch-libmpv.mjs knows how to unpack, and what the update PR says.
// No network, no filesystem: unit-tested in src/__tests__/libmpvUpdate.test.ts.
//
// The runner owns the side effects (GitHub API, download, mirror upload, the
// lock write); everything here decides.

/** Our mirror: the release every lock `url` must point at (see libmpv.lock.json). */
export const MIRROR_REPO = "outcast1000/viboplr";
export const MIRROR_TAG = "vendor-libmpv";

/**
 * Where each platform's builds come from, and what an archive must contain for
 * fetch-libmpv.mjs's post-processing to work (postProcessWindows /
 * postProcessMacos read exactly these paths).
 */
export const UPSTREAMS = {
  "windows-x86_64": {
    repo: "shinchiro/mpv-winbuild-cmake",
    source: "shinchiro/mpv-winbuild-cmake (libmpv-2.dll, ffmpeg statically linked, GPL)",
    // Plain x86_64 only: the `-v3-` variant needs AVX2-era CPUs.
    asset: /^mpv-dev-x86_64-\d{8}-git-([0-9a-f]{7,40})\.7z$/,
    required: ["libmpv-2.dll", "libmpv.dll.a", "include/mpv/client.h"],
    header: "include/mpv/client.h",
  },
  "macos-aarch64": {
    repo: "eko5624/mpv-mac",
    source: "eko5624/mpv-mac (self-contained libmpv.2.dylib, ffmpeg statically linked, GPL)",
    asset: /^libmpv-arm64-([0-9a-f]{7,40})\.zip$/,
    required: ["libmpv/libmpv.2.dylib", "libmpv/include/client.h"],
    header: "libmpv/include/client.h",
  },
};

/** The engine refuses any other client API major (mpv_engine/ffi.rs). */
export const REQUIRED_API_MAJOR = 2;

/**
 * The newest build's archive for one platform, from a GitHub release JSON
 * (`GET /repos/{repo}/releases/latest`). Null when the release carries no
 * matching asset — upstream renamed its files, which needs a human.
 */
export function pickAsset(release, upstream) {
  for (const a of release?.assets ?? []) {
    const m = upstream.asset.exec(a.name);
    if (m) return { name: a.name, url: a.browser_download_url, gitHash: m[1], tag: release.tag_name };
  }
  return null;
}

/** Same mpv commit? Builds shorten hashes to different lengths (304426c vs 3f1b23abd0). */
export function sameCommit(a, b) {
  if (!a || !b) return false;
  const x = String(a).toLowerCase();
  const y = String(b).toLowerCase();
  const n = Math.min(x.length, y.length);
  return n >= 7 && x.slice(0, n) === y.slice(0, n);
}

/** `#define MPV_CLIENT_API_VERSION MPV_MAKE_VERSION(2, 5)` → { major: 2, minor: 5 }, else null. */
export function parseClientApiVersion(headerText) {
  const m = /#define\s+MPV_CLIENT_API_VERSION\s+MPV_MAKE_VERSION\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(headerText || "");
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Required paths an archive listing lacks (listing: one path per entry; `./` and dir slashes tolerated). */
export function missingFiles(listing, required) {
  const have = new Set(
    listing
      .map((p) => p.trim().replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/$/, ""))
      .filter(Boolean),
  );
  return required.filter((r) => !have.has(r));
}

/**
 * Everything wrong with a candidate archive, as sentences; empty = usable.
 * `listing` and `headerText` come from the downloaded file.
 */
export function archiveProblems(upstream, listing, headerText) {
  const problems = [];
  const missing = missingFiles(listing, upstream.required);
  if (missing.length) problems.push(`archive lacks ${missing.join(", ")} — fetch-libmpv.mjs couldn't unpack it`);
  const api = parseClientApiVersion(headerText);
  if (!api) problems.push(`no MPV_CLIENT_API_VERSION in ${upstream.header}`);
  else if (api.major !== REQUIRED_API_MAJOR) {
    problems.push(`client API ${api.major}.${api.minor} — the engine needs major ${REQUIRED_API_MAJOR}`);
  }
  return problems;
}

export function mirrorUrl(assetName) {
  return `https://github.com/${MIRROR_REPO}/releases/download/${MIRROR_TAG}/${assetName}`;
}

/** The new lock entry for a mirrored build. */
export function lockEntryFor(upstream, asset, sha256) {
  return {
    source: upstream.source,
    url: mirrorUrl(asset.name),
    upstream: asset.url,
    sha256,
    mpvGitHash: asset.gitHash,
  };
}

export function mpvCompareUrl(fromHash, toHash) {
  return `https://github.com/mpv-player/mpv/compare/${fromHash}...${toHash}`;
}

/**
 * The pull request body. `changes`: [{ platform, from: lockEntry, to: lockEntry, tag, api }].
 * Test results are appended by the workflow, which knows them.
 */
export function prBody(changes) {
  const lines = [
    "Automated libmpv update (`.github/workflows/update-libmpv.yml`). The new archives are already mirrored, unchanged, on the [`vendor-libmpv`](https://github.com/" +
      MIRROR_REPO +
      "/releases/tag/" +
      MIRROR_TAG +
      ") release and pinned by SHA-256.",
    "",
    "| Platform | From | To | Upstream build | Client API | mpv changes |",
    "|---|---|---|---|---|---|",
  ];
  for (const c of changes) {
    lines.push(
      `| ${c.platform} | \`${c.from?.mpvGitHash ?? "—"}\` | \`${c.to.mpvGitHash}\` | [${c.tag}](${c.to.upstream}) | ${c.api ? `${c.api.major}.${c.api.minor}` : "?"} | ${
        c.from?.mpvGitHash ? `[compare](${mpvCompareUrl(c.from.mpvGitHash, c.to.mpvGitHash)})` : "—"
      } |`,
    );
  }
  lines.push(
    "",
    "**Before merging:** the engine tests below prove libmpv loads and plays, not that playback has no subtle regression. Play a few local and streamed tracks, and a video, on each changed platform.",
  );
  return lines.join("\n");
}

/**
 * The CI jobs main's ruleset requires before a merge ("Protect main"). The
 * update workflow starts CI on its branch so the PR can satisfy them; keep this
 * in step with the ruleset and with the job names in .github/workflows/ci.yml.
 */
export const REQUIRED_CHECKS = ["typecheck", "rust-check-and-test", "test-ts"];

/**
 * How the required checks stand on a PR, from `gh pr view --json statusCheckRollup`.
 * "passed" only when every required check has a successful run; a missing one
 * is "pending" (CI was started but hasn't reported), a non-success conclusion
 * is "failed".
 */
export function requiredChecksState(rollup, required = REQUIRED_CHECKS) {
  let pending = false;
  for (const name of required) {
    const runs = (rollup ?? []).filter((c) => c.name === name);
    if (!runs.length || runs.some((c) => c.status && c.status !== "COMPLETED")) {
      pending = true;
      continue;
    }
    if (!runs.some((c) => c.conclusion === "SUCCESS")) return "failed";
  }
  return pending ? "pending" : "passed";
}

/**
 * What `npm run bump` does about a libmpv update — no question asked. `pr`: the
 * open Update libmpv PR ({ number, title, url, isDraft }) or null; the workflow
 * keeps it a draft while its engine tests or the component publish fail.
 * `checks`: requiredChecksState of that PR. `behind`: upstream has a newer build
 * than the lock. `onMain`: a merge reaches this release only when it is cut from main.
 *   merge — merge, pull, vendor, release with it
 *   run   — no PR to take: start the workflow (it's for the next release)
 *   skip  — a PR exists but can't go in this release; `reason` says why
 *   none  — nothing pending
 */
export function libmpvAction({ pr, checks, behind, onMain }) {
  if (pr) {
    const what = `libmpv update PR #${pr.number} (${pr.title})`;
    if (pr.isDraft) return { action: "skip", reason: `${what} is a draft — its engine tests or the component publish failed: ${pr.url}` };
    if (!onMain) return { action: "skip", reason: `${what} is waiting, but this release isn't cut from main, so merging wouldn't reach it` };
    if (checks === "failed") return { action: "skip", reason: `${what}: CI failed on it: ${pr.url}` };
    if (checks !== "passed") return { action: "skip", reason: `${what}: CI hasn't finished on it yet: ${pr.url}` };
    return { action: "merge", reason: `merging ${what}` };
  }
  if (behind) return { action: "run", reason: "upstream has a newer libmpv and no update PR is open — starting the Update libmpv workflow" };
  return { action: "none", reason: "libmpv is current" };
}
