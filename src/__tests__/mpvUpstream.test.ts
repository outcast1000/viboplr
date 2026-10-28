// scripts/lib/mpvUpstream.mjs decides what `npm run bump` reports about mpv
// master. Getting it wrong either hides commits the release could have had, or
// lists the wrong ones as "new" against a platform that already ships them.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs dev script, no type declarations
import { commitLine, compareUrl, furthestBehind, newestCommits, pinnedMpvCommits } from "../../scripts/lib/mpvUpstream.mjs";

const commit = (sha: string, subject: string, date = "2026-10-27T10:00:00Z") => ({
  sha,
  commit: { message: `${subject}\n\nbody text`, committer: { date } },
});

describe("pinnedMpvCommits", () => {
  it("groups platforms that pin the same commit and drops entries with no hash", () => {
    const lock = {
      platforms: {
        "macos-aarch64": { mpvGitHash: "baa3e11d42" },
        "windows-x86_64": { mpvGitHash: "e471496c56" },
        "linux-x86_64": { mpvGitHash: "baa3e11d42" },
        "other": { url: "x" },
      },
    };
    expect(pinnedMpvCommits(lock)).toEqual([
      { hash: "baa3e11d42", platforms: ["macos-aarch64", "linux-x86_64"] },
      { hash: "e471496c56", platforms: ["windows-x86_64"] },
    ]);
  });

  it("refuses a hash that isn't hex, since it becomes an API path", () => {
    expect(pinnedMpvCommits({ platforms: { a: { mpvGitHash: "../../x" } } })).toEqual([]);
  });
});

describe("furthestBehind", () => {
  it("reports from the platform that is furthest behind", () => {
    const base = furthestBehind([
      { hash: "aaaaaaa", platforms: ["macos-aarch64"], aheadBy: 38 },
      { hash: "bbbbbbb", platforms: ["windows-x86_64"], aheadBy: 119 },
    ]);
    expect(base.hash).toBe("bbbbbbb");
  });

  it("is null when master has nothing new for any platform", () => {
    expect(furthestBehind([{ hash: "aaaaaaa", platforms: [], aheadBy: 0 }])).toBeNull();
  });
});

describe("newestCommits", () => {
  it("lists the compare result newest first when it is complete", () => {
    const compareCommits = [commit("1".repeat(40), "oldest"), commit("2".repeat(40), "middle"), commit("3".repeat(40), "newest")];
    const { shown, more } = newestCommits({ aheadBy: 3, compareCommits, recent: [] }, 2);
    expect(shown.map((c: { sha: string }) => c.sha[0])).toEqual(["3", "2"]);
    expect(more).toBe(1);
  });

  it("falls back to the branch's newest commits when GitHub truncated the compare", () => {
    // GitHub caps the compare list at 250 commits; 1346 ahead can't be listed from it.
    const compareCommits = Array.from({ length: 250 }, (_, i) => commit(String(i).padStart(40, "0"), `old ${i}`));
    const recent = Array.from({ length: 25 }, (_, i) => commit(`f${i}`.padEnd(40, "0"), `new ${i}`));
    const { shown, more } = newestCommits({ aheadBy: 1346, compareCommits, recent });
    expect(shown[0].commit.message).toMatch(/^new 0/);
    expect(shown).toHaveLength(25);
    expect(more).toBe(1346 - 25);
  });

  it("never lists more commits than master is ahead by", () => {
    const recent = Array.from({ length: 25 }, (_, i) => commit(`a${i}`.padEnd(40, "0"), `c${i}`));
    const { shown, more } = newestCommits({ aheadBy: 4, compareCommits: [], recent });
    expect(shown).toHaveLength(4);
    expect(more).toBe(0);
  });
});

describe("commitLine / compareUrl", () => {
  it("shows a short sha, the date and the subject line only", () => {
    expect(commitLine(commit("abcdef1234567890".padEnd(40, "0"), "ao_coreaudio: fix a leak")))
      .toBe("abcdef1234 2026-10-27 ao_coreaudio: fix a leak");
  });

  it("links the whole range for a human", () => {
    expect(compareUrl("baa3e11d42")).toBe("https://github.com/mpv-player/mpv/compare/baa3e11d42...master");
  });
});
