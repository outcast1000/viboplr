# Development Guide

## Prerequisites

- Node.js 20+
- Rust stable (1.70+)
- Platform-specific Tauri requirements: [Tauri prerequisites](https://tauri.app/v2/guides/prerequisites/)

## Setup

```bash
npm install
```

## Development

Typically you would work on one or more worktrees:

```bash
claude --dangerously-skip-permissions --worktree 1
```

I usually use worktrees 1, 2, 3. All worktrees track `origin/main` and can be synced with:

```bash
git pull --rebase   # pull latest from main
git push            # push worktree commits to main
```


```bash
# Start Vite dev server + Tauri app with hot reload
npm run tauri dev

# With Rust debug logging
RUST_LOG=debug npm run tauri dev
RUST_LOG=info npm run tauri dev
```

## Building

```bash
# Full production build (frontend + Rust, outputs installer)
npm run tauri build

# Type-check frontend only
npx tsc --noEmit

# Check Rust compilation (faster iteration, no bundling)
cd src-tauri && cargo check

# Check release build (verifies cfg(debug_assertions) gating)
cd src-tauri && cargo check --release
```

## Debugging

- **Rust logs**: Set `RUST_LOG=debug` (or `trace`) before `npm run tauri dev`.
- **Frontend DevTools**: Right-click → Inspect in the Tauri window (dev mode only).
- **Seed data**: In dev mode, a seed button appears in the UI to populate the database with fake data. This is gated by `#[cfg(debug_assertions)]` on the backend and `import.meta.env.DEV` on the frontend.

## Testing

```bash
# Run all tests (Rust + TypeScript)
npm run test:all

# Run TypeScript tests only
npm test

# Run TypeScript tests in watch mode
npm run test:watch

# Run Rust tests only
npm run test:rust
```

Manual verification:

```bash
# Verify Rust compiles in release mode
cd src-tauri && cargo check --release

# Verify frontend types
npx tsc --noEmit
```

## Releasing

To do a release you should increase the release number and add the proper tags in the git. Bump script can help with that

```bash
npm run bump --autocommit
npm run bump v0.4.0 --autocommit
```

Releases are automated via GitHub Actions. Pushing a version tag triggers builds for macOS (ARM) and Windows, then creates a draft GitHub Release with the installer artifacts attached.
- The workflow is defined in `.github/workflows/release.yml`.

### macOS unsigned release

Builds are **unsigned**. On macOS, run this to clear the quarantine flag before first launch:

```bash
xattr -cr /Applications/Viboplr.app
```
