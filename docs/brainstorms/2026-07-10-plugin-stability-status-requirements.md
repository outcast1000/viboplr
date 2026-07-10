---
date: 2026-07-10
topic: plugin-stability-status
---

# Plugin Stability Status — Requirements

## Summary

Add an optional `stability` field to plugin gallery entries and plugin manifests (absent = stable), with `"experimental"` as the first recognized value. Experimental plugins carry an "Experimental" badge wherever they render, sit in a collapsed "Experimental" section at the bottom of the gallery with a one-line disclaimer, and never appear in onboarding recommendations. p2p-sharing and tidal-browse are the first plugins marked.

---

## Problem Frame

The gallery presents every plugin identically, so pre-release plugins like p2p-sharing and tidal-browse read as finished features. That creates three costs: users form wrong expectations and the rough edges reflect on the whole app; breakage generates bug reports and support noise; and once users treat a plugin as stable, redesigning or dropping it feels like taking something away. Neither the plugin manifest nor the gallery index has any way to express maturity today — the only related signals are `recommended` (a promotion flag) and `debugOnly` (a developer gate).

---

## Key Decisions

- **A lifecycle field, not a boolean flag.** One `stability` string field generalizes the concept: `"experimental"` is the only value with defined behavior now, but `"beta"` or `"deprecated"` can be added later without new fields or flag combinations.
- **Data-driven, not hardcoded.** Any plugin can be marked via its gallery entry and manifest; the host has no per-plugin id list.
- **Collapsed gallery section instead of a hidden settings toggle.** Expectation-setting happens where the install decision is made, and users who would deliberately opt in can still discover the plugins. A toggle buried in Settings would mostly guarantee the plugins get no users.
- **No install/enable warning.** The section's disclaimer is the consent moment; the user chose not to add a confirm step on top of it.

---

## Requirements

**Data model**

- R1. A plugin's maturity is expressed by an optional `stability` string field; the initial recognized value is `"experimental"`, and an absent field means stable.
- R2. The field lives in both the gallery index entry (drives gallery presentation and onboarding, pre-install) and the plugin manifest (drives the installed-copy badge), kept in sync the same way version and minAppVersion display metadata already are.
- R3. A `stability` value the app does not recognize is treated as experimental-tier, so future values fail safe rather than presenting as stable.

**Gallery presentation**

- R4. Experimental plugins render only inside a collapsed "Experimental" section at the bottom of the gallery list, opened by a click; the collapsed state is not a persisted setting.
- R5. The Experimental section carries a one-line disclaimer that these plugins may break, change, or be removed.
- R6. Experimental plugin cards show an "Experimental" badge alongside the existing badge set, in both the gallery and the installed-plugins list.

**Onboarding**

- R7. Experimental plugins never appear in the onboarding wizard's plugin step, regardless of their `recommended` or `profiles` values.

**Installed copies**

- R8. Marking a plugin experimental has no effect on already-installed copies beyond the badge: enable state is untouched, install/enable flows show no extra warning, and auto-update continues.

**Initial rollout**

- R9. p2p-sharing and tidal-browse are marked experimental in the gallery index and, via their next releases, in their manifests.

---

## Acceptance Examples

- AE1. **Covers R4, R6, R7.** Given tidal-browse's gallery entry declares `stability: "experimental"`, when the user browses the gallery, the plugin appears only inside the collapsed Experimental section with an Experimental badge — and when a new user runs the onboarding wizard, tidal-browse is not listed at all.
- AE2. **Covers R2, R6, R8.** Given p2p-sharing is already installed and enabled, when its next release ships the manifest `stability` field and auto-update applies it, the installed-plugins list shows the Experimental badge and the plugin stays enabled and keeps receiving updates.
- AE3. **Covers R3.** Given a future gallery entry declares `stability: "beta"` on an app version that only recognizes `"experimental"`, the entry renders as experimental-tier (badge, collapsed section), not as stable.

---

## Scope Boundaries

- No warning or confirmation dialog on install or enable of experimental plugins.
- No defined behavior for `"beta"` or `"deprecated"` — the field leaves room for them, nothing more.
- No "show experimental plugins" setting; visibility is handled entirely by the collapsed section.
- The skin gallery is untouched; this applies to plugins only.

---

## Dependencies / Assumptions

- Rollout spans three repos: a host app release (badge rendering, gallery grouping, onboarding filter), an edit to the gallery `index.json`, and releases of the p2p-sharing and tidal-browse plugin repos carrying the manifest field. Gallery-side effects land with the host release plus the index edit; installed-copy badges wait on the plugin releases.
- Verified: manifests pass through the Rust layer as untyped JSON, so the new manifest field needs no Rust change, and gallery/onboarding filtering is frontend-only.
- Verified: plugin auto-update reads installed manifests and each plugin's `update_url`, independent of gallery-list rendering, so grouping entries in the gallery cannot affect updates of installed copies.

---

## Sources

- `src/types/plugin.ts` — `PluginManifest` (existing `debugOnly` / `autoEnable` flags) and `GalleryPluginEntry` (existing `recommended` / `profiles` fields) that the new field sits beside.
- `src/hooks/useExtensions.ts` — builds the extensions list: installed items from manifests, not-installed items from gallery entries only.
- `src/components/ExtensionsView.tsx` — existing badge patterns (StatusBadge, DEV, Recommended) the Experimental badge joins.
- `src/components/firstRunSelection.ts` — `computeInitialSelection`, the onboarding pre-selection logic R7 filters ahead of.
- `src-tauri/src/update_checker.rs` — update loop that R8's no-effect-on-updates guarantee rests on.
