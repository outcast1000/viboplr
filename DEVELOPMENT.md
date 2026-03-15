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

```bash
# Start Vite dev server + Tauri app with hot reload
npm run tauri dev

# With Rust debug logging
RUST_LOG=debug npm run tauri dev
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

There are no automated tests in this project currently.

Manual verification:

```bash
# Verify Rust compiles in release mode
cd src-tauri && cargo check --release

# Verify frontend types
npx tsc --noEmit
```

## Scripts

### Version bump

`scripts/bump.mjs` updates the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` in one command:

```bash
npm run bump 0.2.0
```

## Releasing

Releases are automated via GitHub Actions. Pushing a version tag triggers builds for macOS (ARM) and Windows, then creates a draft GitHub Release with the installer artifacts attached.

### Steps to cut a release

1. **Bump the version**:
   ```bash
   npm run bump X.Y.Z
   ```

2. **Commit and tag**:
   ```bash
   git add -A
   git commit -m "release: vX.Y.Z"
   git tag vX.Y.Z
   ```

3. **Push with tags**:
   ```bash
   git push origin main --tags
   ```

4. **Review the draft release** on the GitHub Releases page. Add release notes, then publish.

### What the CI builds

| Platform | Runner | Artifacts |
|----------|--------|-----------|
| macOS (ARM) | `macos-latest` | `.dmg` |
| Windows | `windows-latest` | `.msi`, `.exe` |

### Notes

- Builds are **unsigned** — macOS users will need to right-click → Open on first launch. Add Apple Developer ID secrets to the repository to enable code signing later.
- Only version tags matching `v*` trigger the workflow.
- The release is created as a **draft** so you can review before publishing.
- The workflow is defined in `.github/workflows/release.yml`.
