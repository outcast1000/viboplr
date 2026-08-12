// Repo-facing half of the line counter: file discovery, git tree reads, and the
// benchmarks/loc-history.json series. The counting itself is in ./loc.mjs, which
// stays pure so it can be unit-tested without a git repo.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { countFiles, languageFor, summarize, formatReport } from "./loc.mjs";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HISTORY_PATH = join(REPO_ROOT, "benchmarks", "loc-history.json");

const MAX_BUFFER = 512 * 1024 * 1024;

function git(args, { encoding = "utf8" } = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding, maxBuffer: MAX_BUFFER });
}

const splitZ = (out) => out.split("\0").filter(Boolean);

// VSCodeCounter's own default excludes, which git knows nothing about. Keeping
// them is what makes this counter's output comparable to the snapshots in
// .VSCodeCounter/ — `.vscode/extensions.json` is tracked and *not* gitignored,
// yet the extension never counted it.
// ...plus the history file itself. That one is our own divergence: it is JSON
// the extension would happily count, and it grows by ~9 lines every release, so
// leaving it in would show the metric quietly inflating itself and list itself
// as a mover forever.
const STATIC_EXCLUDES = [
  /^\.vscode\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.gitignore$/,
  /(^|\/)\.DS_Store$/,
  /^\.VSCodeCounter\//,
  /^benchmarks\/loc-history\.json$/,
];

/**
 * Paths matching an ignore rule, including tracked ones. `--no-index` is the
 * load-bearing flag: without it git reports anything in the index as not
 * ignored, so the 37 tracked-but-ignored `docs/superpowers/` files would be
 * counted here and not by the extension.
 */
function ignoredPaths(files) {
  const opts = { cwd: REPO_ROOT, input: files.join("\0"), encoding: "utf8", maxBuffer: MAX_BUFFER };
  try {
    return new Set(splitZ(execFileSync("git", ["check-ignore", "--stdin", "--no-index", "-z"], opts)));
  } catch (e) {
    // Exit status 1 just means "nothing matched"; anything on stdout is still valid.
    return new Set(splitZ(e.stdout ?? ""));
  }
}

function selectFiles(files) {
  const candidates = files.filter((f) => !STATIC_EXCLUDES.some((rx) => rx.test(f)));
  const ignored = ignoredPaths(candidates);
  return candidates.filter((f) => !ignored.has(f)).sort();
}

/** Files git would include in a release commit: tracked + untracked-but-not-ignored. */
function worktreeFiles() {
  return selectFiles(splitZ(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])));
}

function treeFiles(ref) {
  return selectFiles(splitZ(git(["ls-tree", "-r", "--name-only", "-z", ref])));
}

/**
 * Read every path out of a git tree with one `cat-file --batch` process.
 * Per-file `git show` would be ~600 spawns and take longer than the count.
 */
function readTree(ref, files) {
  if (files.length === 0) return new Map();
  const stdout = execFileSync("git", ["cat-file", "--batch"], {
    cwd: REPO_ROOT,
    input: files.map((f) => `${ref}:${f}`).join("\n") + "\n",
    maxBuffer: MAX_BUFFER,
  });
  const contents = new Map();
  let pos = 0;
  for (const file of files) {
    const nl = stdout.indexOf(0x0a, pos);
    if (nl === -1) break;
    const header = stdout.toString("utf8", pos, nl);
    pos = nl + 1;
    // "<sha> <type> <size>" for a hit, "<spec> missing" otherwise.
    const parts = header.split(" ");
    if (parts.length < 3) continue;
    const size = Number(parts[2]);
    contents.set(file, stdout.toString("utf8", pos, pos + size));
    pos += size + 1; // trailing newline
  }
  return contents;
}

/**
 * Count the repo at `ref`, or the working tree when `ref` is null.
 * @returns {{files: Record<string, object>, skipped: Record<string, number>, summary: object}}
 */
export function countRepo(ref = null) {
  let result;
  if (ref) {
    const files = treeFiles(ref);
    // Prefetch only what will actually be counted — the tree also holds icons
    // and screenshots, and slurping those through cat-file costs megabytes.
    const contents = readTree(ref, files.filter((f) => languageFor(f)));
    result = countFiles(files, (f) => contents.get(f) ?? null);
  } else {
    result = countFiles(worktreeFiles(), (f) => {
      try {
        return readFileSync(join(REPO_ROOT, f), "utf8");
      } catch {
        return null; // deleted between listing and read, or unreadable
      }
    });
  }
  return { ...result, summary: summarize(result.files) };
}

export function readHistory() {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, "utf8"));
  } catch (e) {
    console.error("Failed to read loc-history.json:", e);
    return [];
  }
}

/**
 * Written with one line per language/directory map so a long series stays
 * readable in a diff — same reasoning as benchmarks/history.json.
 */
export function writeHistory(history) {
  // Sorted by date so a back-filled release lands in the timeline rather than
  // at the end, and so the newest entry is always the last one.
  const entries = [...history]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((e) => {
    const flat = (obj) =>
      "{" + Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(", ") + "}";
    return [
      "  {",
      `    "date": ${JSON.stringify(e.date)},`,
      `    "version": ${JSON.stringify(e.version)},`,
      `    "ref": ${JSON.stringify(e.ref)},`,
      `    "note": ${JSON.stringify(e.note ?? "")},`,
      `    "total": ${JSON.stringify(e.total)},`,
      `    "languages": ${flat(e.languages)},`,
      `    "directories": ${flat(e.directories)}`,
      "  }",
    ].join("\n");
  });
  writeFileSync(HISTORY_PATH, `[\n${entries.join(",\n")}\n]\n`);
}

function commitDate(ref) {
  try {
    return new Date(git(["log", "-1", "--format=%cI", ref]).trim()).toISOString().replace(/\.\d+Z$/, "Z");
  } catch {
    return new Date().toISOString().replace(/\.\d+Z$/, "Z");
  }
}

export function refExists(ref) {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Count the current tree, print a delta against the newest history entry, and
 * optionally append a new entry.
 *
 * @param {{version: string, ref?: string|null, save?: boolean, note?: string, countRef?: string|null}} options
 * @returns {{report: string, entry: object}}
 */
export function locStep({ version, ref = null, save = false, note = "", countRef = null }) {
  const { files, skipped, summary } = countRepo(countRef);
  const history = readHistory();
  // Skip any entry for the version being recorded: re-running a failed release
  // must still diff against the *previous* release, not against its own first
  // attempt (which would report a flat zero).
  const earlier = history.filter((e) => e.version !== version);
  const prev = earlier.length > 0 ? earlier[earlier.length - 1] : null;

  // Per-file movers need both trees. The previous entry stores only aggregates,
  // so re-count its ref — cheap, and it keeps the history file small.
  let prevFiles = null;
  if (prev?.ref && refExists(prev.ref)) {
    try {
      prevFiles = countRepo(prev.ref).files;
    } catch (e) {
      console.error(`Could not re-count ${prev.ref} for per-file deltas:`, e.message);
    }
  }

  const report = formatReport({
    label: prev ? `${prev.version} → ${version}` : version,
    prev,
    next: summary,
    prevFiles,
    nextFiles: files,
    skipped,
  });

  const entry = {
    // Back-filled entries carry the commit's own date so the series reads as a
    // timeline; a live release is stamped now, because its commit doesn't exist yet.
    date: countRef ? commitDate(countRef) : new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    version,
    ref: ref ?? countRef ?? null,
    note,
    total: summary.total,
    languages: summary.languages,
    directories: summary.directories,
  };

  // Recording the same version twice replaces it rather than appending, so a
  // retried release (or a back-fill run twice) can't leave the series doubled.
  if (save) writeHistory([...earlier, entry]);
  return { report, entry };
}
