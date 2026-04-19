---
name: release
description: Use when the user says "do a release", "release", "bump version", or wants to publish a new version of the app
---

# Release

Run the release orchestrator to bump the version, update docs, generate changelog, commit, tag, and push.

## Important

The bump script pushes to `origin main`. This must be run from the `main` branch, not a worktree or feature branch. If on a different branch, tell the user to switch first.

## Steps

1. **Ask release type.** Prompt the user:
   > What type of release? **patch** (0.9.5 → 0.9.6), **minor** (0.9.5 → 0.10.0), or **major** (0.9.5 → 1.0.0)?
   Read the current version from `package.json` and show the actual before → after in the prompt.

2. **Compute version.** Parse `version` from `package.json`, split into `[major, minor, patch]`, bump the chosen segment (reset lower segments to 0 for minor/major).

3. **Run the bump script:**
   ```bash
   node scripts/bump.mjs <computed-version> --autocommit
   ```
   This handles everything: version files, docs, changelog, commit, tag, and push.

4. **Report result.** Show the user the new version and confirm the tag was pushed.
