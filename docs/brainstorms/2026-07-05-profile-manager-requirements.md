---
date: 2026-07-05
topic: profile-manager
---

# In-App Profile Manager — Requirements

## Summary

Grow the read-only profile info in Settings → General into a Profiles manager: list existing profiles, switch into one (the app relaunches into it), create a new one, and generate a double-clickable shortcut that launches the app directly into a chosen profile. The `--profile` CLI arg and `VIBOPLR_PROFILE` env var keep working as overrides.

---

## Problem Frame

Profiles already isolate everything that matters (database, app store, images, playlist state) under `profiles/{name}/`, but they are launch-time only: the sole way to use a non-default profile is a terminal command or script. The existing Settings surface shows the current profile read-only. For anyone running separate libraries day-to-day, every profile session starts with a trip to the terminal.

---

## Key Decisions

- **Extend the existing Settings surface.** The manager lives in Settings → General where the current-profile rows already are — no caption-bar menu, picker window, or Chrome-style avatar UI.
- **Switching is session-only.** A plain launch (Dock icon, no args) always opens `default`. There is no remember-last-profile state shared across profiles; shortcuts are the way to boot straight into a specific profile.
- **Create switches immediately.** Creating a profile relaunches into it, where the onboarding wizard runs fresh (the existing per-profile `onboardingComplete` gate provides this for free).
- **Second launches are profile-aware.** Opening a profile-B shortcut while the app runs in profile A triggers the same relaunch-switch into B, instead of the current behavior of just focusing the running window.

---

## Requirements

**Profile list**

- R1. Settings → General shows all existing profiles (the subdirectories of `profiles/`), with the current profile marked.

**Switching**

- R2. Selecting another profile relaunches the app into it — equivalent to restarting with `--profile <name>`.
- R3. Before the relaunch, all pending debounced state (app store writes, queue/main-playlist persistence) is flushed so no data is lost.
- R4. The CLI arg and env var keep their current precedence and behavior; the manager adds no new launch-time state.

**Creation**

- R5. A new profile is created by name, validated with the existing backend rule (1–64 chars, alphanumeric/hyphens/underscores, starts alphanumeric); invalid or duplicate names are rejected with feedback.
- R6. After creation the app switches into the new profile (per R2), where onboarding runs as on any fresh profile.

**Shortcuts**

- R7. Each listed profile offers a "Create shortcut" action that writes a double-clickable launcher opening the app directly into that profile, on all supported desktop platforms.
- R8. Opening a profile shortcut from a cold start launches straight into that profile.
- R9. Opening a profile-B shortcut while the app is running in profile A triggers the switch flow into B (per R2/R3); opening a shortcut for the already-active profile just focuses the window.

---

## Key Flows

- F1. Switch profile
  - **Trigger:** User picks a profile in Settings → Profiles and confirms.
  - **Steps:** Pending state flushes → app relaunches into the chosen profile → window title reflects it (existing behavior).
  - **Outcome:** Playback stops as part of the relaunch; the previous profile's state is intact on next visit.
  - **Covers:** R2, R3.
- F2. Create profile
  - **Trigger:** User enters a name in the New Profile action.
  - **Steps:** Name validated (R5) → profile directory created → switch flow (F1) into it → onboarding wizard appears.
  - **Covers:** R5, R6.
- F3. Launch via shortcut
  - **Trigger:** User double-clicks a profile shortcut.
  - **Steps:** Cold start → app opens in that profile (R8). App already running in another profile → running instance flushes and relaunches into the requested profile (R9).
  - **Covers:** R7, R8, R9.

---

## Acceptance Examples

- AE1. **Covers R3.** Given the user liked a track 200ms ago (write still pending in the 500ms debounce), when they switch profiles, then the like is persisted before the relaunch and present when they return to that profile.
- AE2. **Covers R6.** Given the user creates profile `kids`, when the app relaunches, then it is running as `kids` with an empty library and the onboarding wizard showing.
- AE3. **Covers R9.** Given the app is running in `default`, when the user opens the `work` shortcut, then the app flushes, relaunches as `work`, and does not leave a second instance running.
- AE4. **Covers session-only switching.** Given the user last used profile `work` and quit, when they launch the app from the Dock with no args, then it opens `default`.

---

## Scope Boundaries

- Rename, delete, and duplicate profile operations.
- Profile identity: avatars, colors, caption-bar chip or menu (window title annotation stays as is).
- Remember-last-profile or any launch-time profile picker.
- Selective data sharing across profiles (likes, plugins, skins remain fully isolated).
- Running two profiles simultaneously.

---

## Dependencies / Assumptions

- Single-instance enforcement is release-builds only (`#[cfg(not(debug_assertions))]`); R9's handoff applies to release builds, and dev builds may run multiple instances.
- No backend command currently enumerates `profiles/` — the list in R1 needs a new command.
- Store and queue persistence are debounced at 500ms with no existing exit flush, which is why R3 is explicit.
- The onboarding gate (`onboardingComplete` in the per-profile store) already yields R6's wizard behavior with no extra work.

---

## Outstanding Questions

**Deferred to planning**

- Shortcut artifact per platform (macOS launcher bundle vs script, Windows `.lnk`, Linux `.desktop`) and where it is written (Desktop default vs save dialog).
- How the relaunch carries the profile (respawn with arg vs env var) and how the single-instance callback hands the requested profile to the running instance.
- Whether switching needs a confirmation when playback is active, or relaunches immediately.

---

## Sources

- `src-tauri/src/lib.rs:459-511` — profile resolution (env var → CLI arg → default) and name validation.
- `src-tauri/src/lib.rs:560-578` — single-instance callback (release-only; focuses window, deep links only, not profile-aware today).
- `src-tauri/src/lib.rs:607` and `:613` — per-profile data dir; shared managed-binaries dir.
- `src/components/SettingsPanel.tsx:1239-1258` — existing read-only profile rows the manager replaces.
- `src/store.ts:78-84` — per-profile store via `get_profile_info`, `autoSave: 500`.
- `src/hooks/useQueue.ts:72-81` — 500ms debounced queue persistence.
- `src-tauri/src/commands/app.rs:6-12,40-42` — the only existing profile commands (`get_profile_info`, `open_profile_folder`).
