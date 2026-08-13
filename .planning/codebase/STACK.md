# Technology Stack

**Analysis Date:** 2026-08-14

## Languages

**Primary:**
- Rust 2021 edition - Tauri 2 backend, native libmpv engine binding, platform-specific code
- TypeScript 5.8.3 - React frontend, Tauri command layer
- JavaScript - Build scripts, tooling

**Secondary:**
- Bash/PowerShell - Platform-specific deployment scripts
- HTML/CSS - UI templates and styling (grid-based with CSS custom properties)

## Runtime

**Environment:**
- Node.js - Frontend build and script execution
- Tauri 2 runtime - Embeds Chromium webview (WKWebView on macOS, WebView2 on Windows)
- Rust std + tokio 1.x - Backend async runtime

**Package Manager:**
- npm 10.x - JavaScript dependencies
- Cargo - Rust dependencies
- Lockfiles: `package-lock.json` (present), `Cargo.lock` (present)

## Frameworks

**Core:**
- React 19.1.0 - UI framework
- Tauri 2.11.0 - Desktop app framework (Rust backend + webview frontend)
- Vite 8.0.8 - Frontend bundler and dev server (HMR on port 1421, dev server on port 1420)
- TypeScript - Static type checking
- Tokio 1.x - Async Rust runtime

**Testing:**
- Vitest 4.1.0 - TypeScript unit tests (jsdom environment)
- @testing-library/react 16.3.2 - React component testing utilities
- Playwright 1.59.1 - E2E tests (config at `tests/e2e/playwright.config.js`)
- Cargo test - Rust unit and integration tests

**Build/Dev:**
- Tauri CLI 2.x - Desktop build and dev commands
- @tauri-apps/cli 2.x - Command-line interface
- @vitejs/plugin-react 6.0.1 - React JSX transformation

## Key Dependencies

**Critical:**
- @tauri-apps/api 2.11.0 - Tauri command invocation and event handling
- tauri-plugin-store 2.4.2 - Persistent application state storage (`app-state.json`)
- tauri-plugin-updater 2.10.0 - In-app app updates via GitHub releases
- tauri-plugin-global-shortcut 2.3.1 - OS media keys and global keyboard shortcuts
- tauri-plugin-dialog 2.7.0 - File/folder dialogs
- tauri-plugin-opener 2.x - Open URLs and files in external apps
- tauri-plugin-process 2.3.1 - Spawn subprocesses (plugins, binaries)
- tauri-plugin-deep-link 2.x - Deep linking (viboplr:// and subsonic:// schemes)
- tauri-plugin-aptabase 1.0.0 - Anonymous telemetry client

**Backend - Data & Storage:**
- rusqlite 0.39 - SQLite bindings with bundled libsqlite3 (`bundled` feature, `functions` for custom SQL functions)
- lofty 0.24 - Audio metadata tag reading (supports ID3, Vorbis, WMA, APEv2, etc.)
- unicode-normalization 0.1 - Diacritic-insensitive text normalization
- deunicode 1.x - Diacritic stripping for canonical slugs

**Backend - Network & Streaming:**
- reqwest 0.13 - HTTP client with blocking I/O (`blocking`, `json`, `multipart` features)
- axum 0.8 - Web framework for local transcode server
- tokio-util 0.7 - Tokio utilities for I/O (`io` feature)

**Backend - Media & Images:**
- image 0.25 - Image loading/manipulation (JPEG, PNG support, default-features off)
- arboard 3.x - Clipboard access for image paste
- zip 8.x - ZIP archive creation/reading (`deflate` compression only)
- sha2 0.10 - SHA-256 hashing (file integrity verification)
- base64 0.22 - Base64 encoding/decoding

**Backend - Platform-Specific:**
- cocoa 0.26 - macOS APIs (transparent window, native menu)
- objc 0.2 - Objective-C runtime access
- mslnk 0.1 - Windows .lnk shortcut creation
- libc 0.2 - POSIX process group operations (Unix only)

**Backend - Utilities:**
- serde 1.x - Serialization framework with derive macros
- serde_json 1.x - JSON serialization
- chrono 0.4 - Date/time handling
- regex 1.x - Regular expressions (fallback filename parsing)
- walkdir 2.x - Recursive directory traversal (library scanning)
- trash 5.x - Cross-platform file deletion to Recycle Bin/Trash
- md5 0.8 - MD5 hashing (Last.fm API signatures)
- urlencoding 2.x - URL encoding/decoding
- encoding_rs 0.8 - Character encoding detection
- log 0.4 - Logging facade
- env_logger 0.11 - Logging implementation with file output

## Configuration

**Environment:**
- Profile configuration via `VIBOPLR_PROFILE` env var or `--profile` CLI argument (defaults to `default`)
- Per-profile state in `{app_data_dir}/profiles/{name}/` (app-state.json, database, plugins, waveforms, etc.)
- Build-time secrets via env vars:
  - `APTABASE_APP_KEY` - Telemetry API key (optional; telemetry disabled if absent)
  - `APTABASE_HOST` - Self-hosted Aptabase instance URL (defaults to `https://analytics.viboplr.com`)

**Build:**
- `tauri.conf.json` - Main Tauri configuration (bundling, plugins, security, deep-link schemes)
- `tauri.macos.conf.json` - macOS-specific overrides (frameworks bundle)
- `tauri.windows.conf.json` - Windows-specific overrides (libmpv bundle)
- `tsconfig.json` - TypeScript compiler options (ES2020 target, strict mode, bundler module resolution)
- `vite.config.ts` - Vite bundler configuration (React plugin, jsdom test environment)
- `engine-component.lock.json` - Pinned libmpv engine versions and SHA-256 hashes per platform

## Platform Requirements

**Development:**
- Rust 1.70+ (Tauri 2 MSRV)
- Node.js 16+ (npm 8+)
- Platform-specific:
  - **macOS:** Xcode Command Line Tools (Cocoa APIs, codesigning)
  - **Windows:** MSVC build tools (WebView2 SDK)
  - **Linux:** GTK+ development headers (not currently bundled; Tauri uses native webview if available)

**Production:**
- **macOS 11+** - Tauri universal (x86_64 + arm64); transparent window via macOSPrivateApi, native libmpv render layer
- **Windows 10+** - WebView2 runtime (always present on Windows 11, auto-installed on Windows 10)
- **Linux** - Any distro with GTK+ 3.x and libmpv available via system package manager (no bundled runtime)

## Runtime Binaries

**Bundled:**
- libmpv - Native audio/video playback engine (macOS: `.dylib` in `Frameworks/`; Windows: `.dll` in exe dir)
  - Downloaded via `node scripts/fetch-libmpv.mjs` before build (pinned in `src-tauri/libmpv.lock.json`)
  - Compiled into every release
  - Also resolvable at runtime from downloaded engine component or system copy

**External (Optional, Managed Install):**
- yt-dlp - Stream extraction and format conversion (managed via `dependencies.rs`)
  - Installed to `{app_data_dir}/bin/yt-dlp` when needed
  - Falls back to system PATH copy if managed install is unavailable
  - Auto-updated by background daemon when `autoUpdateManagedDeps` is enabled

**External (System Only):**
- ffmpeg - Video frame extraction, transcoding
  - No managed install; users must provide via system package manager or `PATH`
  - Probed at startup; failure is non-fatal (video frames unavailable)

---

*Stack analysis: 2026-08-14*
