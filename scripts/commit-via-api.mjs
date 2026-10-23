#!/usr/bin/env node
// Commits files to a branch through GitHub's Git Data API instead of
// `git commit` + `git push`, for the workflows that commit as the bot.
//
//   node scripts/commit-via-api.mjs --branch bot/libmpv-update --parent <sha> \
//     --message "build(libmpv): …" [--force] <file>...
//
// Why: a commit GitHub creates for a GITHUB_TOKEN is signed by GitHub, so it is
// a *verified* commit by github-actions[bot]. One pushed with `git` carries no
// signature — "unattributed" to main's ruleset, which then wants an approval
// nobody gives, so the bot's own PR could never merge (#140).
//
// Each file is committed with its current working-tree contents on top of
// <parent>'s tree. --force moves the branch even when that isn't a
// fast-forward (the update workflow rebuilds its branch from main every run);
// a branch that doesn't exist yet is created. Needs GH_TOKEN and
// GITHUB_REPOSITORY (both set on Actions). Prints the new commit's sha.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const out = { files: [], force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--branch") out.branch = argv[++i];
    else if (a === "--parent") out.parent = argv[++i];
    else if (a === "--message") out.message = argv[++i];
    else if (a === "--force") out.force = true;
    else out.files.push(a);
  }
  return out;
}

const { branch, parent, message, force, files } = parseArgs(process.argv.slice(2));
const repo = process.env.GITHUB_REPOSITORY;
if (!branch || !parent || !message || !files.length || !repo) {
  console.error("usage: commit-via-api.mjs --branch B --parent SHA --message M [--force] FILE... (needs GITHUB_REPOSITORY)");
  process.exit(2);
}

// `gh api` with a JSON body on stdin; returns the parsed response.
function api(method, path, body) {
  const args = ["api", "--method", method, `repos/${repo}/${path}`];
  if (body !== undefined) args.push("--input", "-");
  const out = execFileSync("gh", args, {
    input: body === undefined ? undefined : JSON.stringify(body),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return out.trim() ? JSON.parse(out) : null;
}

const baseTree = api("GET", `git/commits/${parent}`).tree.sha;
const tree = api("POST", "git/trees", {
  base_tree: baseTree,
  tree: files.map((path) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: api("POST", "git/blobs", { content: readFileSync(path).toString("base64"), encoding: "base64" }).sha,
  })),
}).sha;
// No author/committer: GitHub fills in the token's identity and signs it. It
// signs for an app token (GITHUB_TOKEN is one); a personal token's commit comes
// back unsigned, so the verdict is logged — the run shows which it got.
const created = api("POST", "git/commits", { message, tree, parents: [parent] });
const commit = created.sha;
const { verified, reason } = created.verification ?? {};
if (verified) console.error(`commit ${commit} is verified`);
else console.error(`::warning::commit ${commit} is NOT verified (${reason}) — main's ruleset will hold the PR for an approval`);

try {
  api("PATCH", `git/refs/heads/${branch}`, { sha: commit, force });
} catch (e) {
  // 422 "Reference does not exist": first run, or the branch was deleted on merge.
  if (!String(e.stderr ?? "").includes("Reference does not exist")) throw e;
  api("POST", "git/refs", { ref: `refs/heads/${branch}`, sha: commit });
}
console.log(commit);
