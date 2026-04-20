# Contributing to Viboplr

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install) stable toolchain
- Platform dependencies for Tauri 2:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** Visual Studio Build Tools (C++ workload), WebView2 (pre-installed on Windows 11)
  - **Linux:** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev`

For full platform-specific details, see the [Tauri 2 prerequisites guide](https://v2.tauri.app/start/prerequisites/).

## Setup

```bash
git clone https://github.com/outcast1000/viboplr.git
cd viboplr
npm install
npm run tauri dev
```

## Development Workflow

1. Fork the repository
2. Create a branch from `main` (e.g., `fix/queue-duplicate-detection`)
3. Make your changes
4. Run checks locally (see below)
5. Open a PR against `main`

## Running Checks Locally

Before submitting a PR, ensure all checks pass:

```bash
npx tsc --noEmit              # TypeScript typecheck
cd src-tauri && cargo check   # Rust compilation check
npm test                      # TypeScript tests
npm run test:rust             # Rust tests
```

## Commit Style

We use conventional commits:

- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation only
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `test:` — adding or updating tests
- `release:` — version bumps and release prep

## PR Guidelines

- Keep PRs focused on a single change
- Describe what changed and why in the PR description
- Ensure CI passes before requesting review
- Link related issues if applicable

## Plugin Development

Plugins live in `src-tauri/plugins/`. Each plugin is a folder with:

- `manifest.json` — metadata and contributions
- `index.js` — plugin code (ES5, executed via `new Function("api", code)`)

See existing plugins for the pattern.
