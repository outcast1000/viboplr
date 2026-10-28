// What `npm run bump` reports about mpv master: is it ahead of the mpv the
// release ships, and by which commits? Pure — bump.mjs does the GitHub calls
// (compare + commit list) and the prompts; this decides what they mean.

export const MPV_REPO = "mpv-player/mpv";
export const MPV_BRANCH = "master";
// Shown newest first; the rest are counted and linked, not listed.
export const SHOWN_COMMITS = 25;

/** The mpv commits the lock ships, one entry per distinct commit:
 *  [{ hash, platforms: [...] }]. Entries with no recorded hash are left out. */
export function pinnedMpvCommits(lock) {
  const byHash = new Map();
  for (const [platform, entry] of Object.entries(lock?.platforms ?? {})) {
    const hash = entry?.mpvGitHash;
    if (typeof hash !== "string" || !/^[0-9a-f]{7,40}$/i.test(hash)) continue;
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(platform);
  }
  return [...byHash].map(([hash, platforms]) => ({ hash, platforms }));
}

/** One display line per commit: "abcdef1234 2026-10-27 subject". */
export function commitLine(c) {
  const subject = (c?.commit?.message ?? "").split("\n")[0].trim();
  const date = (c?.commit?.committer?.date ?? c?.commit?.author?.date ?? "").slice(0, 10);
  return `${(c?.sha ?? "").slice(0, 10)} ${date} ${subject}`.trim();
}

/** The base to report from: the pinned commit furthest behind master (the
 *  platforms can pin different upstream builds). `compares` is
 *  [{ hash, platforms, aheadBy }]; null when nothing is behind. */
export function furthestBehind(compares) {
  const behind = compares.filter((c) => c.aheadBy > 0);
  if (behind.length === 0) return null;
  return behind.reduce((a, b) => (b.aheadBy > a.aheadBy ? b : a));
}

/** The newest `limit` commits master has past the base, newest first.
 *  `compareCommits` is the compare API's list (oldest first, capped at 250 by
 *  GitHub); when it is complete it is the exact set, otherwise `recent` (the
 *  branch's newest commits, newest first) stands in — the history is linear,
 *  so the newest `aheadBy` of it are the same commits. */
export function newestCommits({ aheadBy, compareCommits, recent }, limit = SHOWN_COMMITS) {
  const exact = Array.isArray(compareCommits) && compareCommits.length === aheadBy;
  const newestFirst = exact ? [...compareCommits].reverse() : (recent ?? []).slice(0, aheadBy);
  return { shown: newestFirst.slice(0, limit), more: Math.max(0, aheadBy - Math.min(limit, newestFirst.length)) };
}

/** The compare page for a human: everything between the base and master. */
export function compareUrl(base) {
  return `https://github.com/${MPV_REPO}/compare/${base}...${MPV_BRANCH}`;
}
