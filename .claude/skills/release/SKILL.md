---
name: release
description: Use when the user says "do a release", "release", "bump version", or wants to publish a new version of the app
---

# Release

Run the release orchestrator to bump the version, update docs, generate changelog, commit, tag, and push.

## Important

**Stable** releases push to `origin main` and must be run from the `main` branch (the script aborts otherwise). **Beta** releases (hyphenated version, e.g. `0.9.152-beta.1`) may be cut from ANY branch — the script pushes that branch, release.yml publishes a GitHub *prerelease* (invisible to the stable updater channel; only users who enabled "Beta updates" in Settings receive it), and all site updates are skipped so viboplr.com keeps advertising the current stable.

## Steps

1. **Ask release type.** Prompt the user:
   > What type of release? **patch** (0.9.5 → 0.9.6), **minor** (0.9.5 → 0.10.0), **major** (0.9.5 → 1.0.0), or **beta** (0.9.5 → 0.9.6-beta.1)?
   Read the current version from `package.json` and show the actual before → after in the prompt.

2. **Compute version.** Parse `version` from `package.json`, split into `[major, minor, patch]`, bump the chosen segment (reset lower segments to 0 for minor/major). For beta: bump patch and append `-beta.1`, or increment the trailing `.N` if a beta of that version already exists (check `git tag -l 'v*-beta*'`).

3. **Run the bump script:**
   ```bash
   node scripts/bump.mjs <computed-version> --autocommit
   ```
   This handles everything: version files, docs, changelog, commit, tag, and push.

4. **Report result.** Show the user the new version and confirm the tag was pushed.
