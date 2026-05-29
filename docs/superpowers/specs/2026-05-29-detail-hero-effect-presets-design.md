# Detail Hero Effect Presets — Design

**Date:** 2026-05-29
**Status:** Approved (design phase)
**Extends:** `2026-05-28-detail-hero-tv-effect-design.md` (the original single VHS effect + on/off toggle, already implemented)

## Summary

Replace the hero effect's boolean on/off toggle with a **multi-option preset picker**. The
corner control becomes a small hover-revealed `<select>` offering:

- **Disabled** — the hero as it was *before this feature existed*: the static blurred
  background montage + scrim, with **no Ken Burns drift and no effect layers**. The
  original pre-feature render path.
- **8 named "looks"**, each a bundled pairing of a background **motion** with a **TV effect**:
  Worn Tape · Late Night TV · Silent Film · Signal Lost · Daydream · Broadcast ·
  Channel Surf · Minimal.
- **Random** — picks one of the 8 looks fresh on each page visit (re-rolls per mount).
- **By artist** — deterministically derives a look from a hash of the page's primary name.

The persisted preference changes from boolean `heroTvEffect` to string `heroEffectMode`
(default `"worn-tape"`, which is the VHS "max snow" look already built). The old boolean
key is migrated on load.

## Goals

- Offer all 8 looks + Disabled + Random + By-artist as discrete dropdown choices.
- Keep the picker global and persisted (one choice governs all four detail pages), default
  to the existing VHS look so current behavior is unchanged for anyone who had it on.
- Random re-rolls each page visit; By-artist is deterministic from the page's own primary
  name; neither ever resolves to Disabled.
- Data-driven look definitions (no pile of conditionals); a pure, exhaustively-testable
  resolver.
- Reuse the existing GPU-only effect layers, off-screen pause, and `prefers-reduced-motion`
  fallback. No new performance or accessibility regressions.

## Non-Goals

- No two-axis UI (separate "effect" and "motion" dropdowns). A single flat list of named
  presets only.
- No per-page or per-entity override of the global choice.
- No user-editable / custom looks. The 8 are fixed.
- No truly-random-per-frame motion. "Random" picks a whole look once per mount.
- No new effect primitives beyond what the 6 motions and 5 effect-layer styles below
  already compose (the brainstorm previews are the contract).

## Background: what already exists

From the implemented `2026-05-28` feature:
- `src/components/DetailHeroEffect.tsx` + `.css` — overlay rendering the VHS layers
  (`tv-bleed`, `tv-bleed-2`, `tv-scan`, `tv-track`, `tv-noise`, `tv-noise-2`, `tv-vignette`),
  with IntersectionObserver/visibilitychange pause and a reduced-motion fallback.
- `src/heroTvEffect.ts` — external-store boolean preference (`useSyncExternalStore`),
  persisted via `store` under key `heroTvEffect`, default `true`.
- `src/components/DetailHero.tsx` — mounts the overlay + a corner checkbox.
- `src/components/DetailHero.css` — Ken Burns drift on `.detail-hero-bg`, z-order, toggle styles.
- `src/store.ts` — `heroTvEffect: true` default.
- `src/assets/tv-noise.png` — the noise texture.

This extension reshapes the preference from a boolean into a mode string and makes the
overlay render one of several looks. The effect primitives (the CSS layers + the noise
asset) are reused as-is; new motions and new layer combinations are added.

## Data Model

### Mode (persisted)

A new string key replaces the boolean:

```
heroEffectMode:
  "disabled" | "worn-tape" | "late-night" | "silent-film" | "signal-lost"
  | "daydream" | "broadcast" | "channel-surf" | "minimal" | "random" | "by-artist"
```

Default: `"worn-tape"` (the VHS "max snow" look the boolean-`true` state produced).

**Migration on load:** when reading the preference, if `heroEffectMode` is absent but the
legacy `heroTvEffect` boolean exists, map `true → "worn-tape"`, `false → "disabled"`, then
write the migrated string back. (If neither is present, use the default.) This preserves
behavior for anyone who already toggled it.

### Look definitions (static, in code)

Each of the 8 looks is a declarative record:

```ts
interface HeroLook {
  id: HeroLookId;          // "worn-tape" | ... | "minimal"
  label: string;           // dropdown label, e.g. "Worn Tape"
  motion: HeroMotion;      // "current" | "focal" | "breathe" | "push" | "sway" | "wander"
  layers: HeroLayerSet;    // which FX layers + intensities (see below)
}
```

The 8 looks (motion × effect), matching the approved gallery:

| id | label | motion | effect layers |
|---|---|---|---|
| `worn-tape` | Worn Tape | wander | full VHS (bleed×2, scan, track, noise .85 + noise2 .6, vignette) |
| `late-night` | Late Night TV | breathe | CRT (scan, flicker, vignette) |
| `silent-film` | Silent Film | push | B&W (bg grayscale/contrast, noise .5 screen, scan, flicker, vignette) |
| `signal-lost` | Signal Lost | focal | glitch (slice, strong bleed×2, noise .4, vignette) |
| `daydream` | Daydream | sway | ambient (noise .14 screen, soft vignette) |
| `broadcast` | Broadcast | push | light VHS (bleed×2 @ .2, scan, track, noise .45, vignette) |
| `channel-surf` | Channel Surf | wander | CRT (scan, flicker, vignette) |
| `minimal` | Minimal | current | none (drift only) |

`disabled` is **not** a look — it is the absence of both motion and overlay (handled by the
resolver returning `null`).

### Motions (CSS keyframes on `.detail-hero-bg`)

Six motion keyframe sets, applied via a motion class. The existing `current` drift stays;
five are added. All are pure CSS transforms (GPU-composited). Exact keyframes are carried
over verbatim from the approved brainstorm previews:

- `current` — gentle center pan+zoom, 28s (the existing Ken Burns).
- `focal` — 32s, jumps `transform-origin` between regions, dwelling/zooming on each.
- `breathe` — 12s, scale 1.06↔1.20 on center, no pan.
- `push` — 24s, slow continuous zoom-in then loop.
- `sway` — 20s, horizontal glide at fixed zoom.
- `wander` — 40s, 6 stops varying both scale and `transform-origin`.

### New effect-layer styles

The original overlay had the full-VHS layer set. This extension adds the styles needed by
the other looks (reusing the same noise asset and conventions):
- `tv-flicker` — full-bleed brightness flicker (`steps()` opacity animation).
- `tv-slice` — a horizontal band sampling the background, jumping vertically + offsetting
  horizontally (glitch slice).
- B&W treatment — a modifier class on `.detail-hero-bg` applying
  `filter: grayscale(1) contrast(1.25) brightness(.92)` (and matching the avatar per the
  preview), scoped so it only applies for the `silent-film` look.
- Per-look intensity/colour overrides (e.g. lighter noise opacity, glitch bleed colours)
  expressed as look-scoped CSS, not inline magic numbers.

All new layers remain `pointer-events: none`, GPU-composited, covered by the existing
`.tv-paused` pause rule and the `prefers-reduced-motion` fallback (the fallback hides the
animated layers and disables drift regardless of look).

## Resolving the active look

`DetailHero` already knows its hero's **primary name** (the `title` prop it renders). It
passes the persisted `mode` plus that `name` to a pure resolver:

```ts
function resolveHeroLook(mode: HeroEffectMode, name: string, seed: RollSeed): HeroLookId | null
```

- `"disabled"` → `null` (caller renders the original static hero: no drift class, no overlay).
- a named look id → that id.
- `"random"` → one of the 8 look ids, chosen from `seed` (a value generated once per
  `DetailHero` mount, so it is stable for the life of that page view and re-rolls on
  remount/navigation). Never `disabled`.
- `"by-artist"` → `LOOK_IDS[ hashString(name) % LOOK_IDS.length ]` where `LOOK_IDS` is the
  array of the 8 look ids. `hashString` is a small, stable string hash (sum/rolling hash of
  char codes). Deterministic for a given name; never `disabled`. Empty/whitespace name →
  hashes to a defined index (e.g. hash of `""` = 0), never throws.

**Primary name semantics (per the approved decision "always the page's primary name"):**
the resolver hashes whatever the hero's title is — artist name on artist pages, album title
on album pages, tag name on tag pages, track title on track pages. So an artist and their
albums get different looks under By-artist.

The resolver is pure and lives alongside the look definitions, so it is unit-tested
exhaustively (each mode, named look passthrough, random stays in-range and excludes
disabled, by-artist determinism + distribution + empty-string safety, migration mapping).

### "Random" seed mechanics

`DetailHero` generates a roll seed once on mount (e.g. a `useRef` initialized from a
module-level counter or a single `Math.random()` at mount — not on every render). This seed
feeds `resolveHeroLook` only when `mode === "random"`; for all other modes it is ignored.
Re-mounting the hero (navigating away and back) produces a new seed → a new roll. This keeps
random "per page visit" without re-rolling on every animation frame or re-render.

## Component & file changes

**New:**
- `src/heroLooks.ts` — `HeroLook`/`HeroLookId`/`HeroMotion` types, the `LOOKS` array,
  `LOOK_IDS`, `hashString`, and `resolveHeroLook`. Pure, no React.
- `src/__tests__/heroLooks.test.ts` — exhaustive resolver + hash tests.

**Renamed/reshaped:**
- `src/heroTvEffect.ts` → becomes a mode store (string, not boolean). Keep the file but
  change its contract: `getHeroEffectModeSnapshot()`, `setHeroEffectMode()`,
  `subscribeHeroEffectMode()`, `useHeroEffectMode()`, plus the boolean→string migration in
  its `load()`. (Rename the file to `heroEffectMode.ts` for accuracy; update imports.)
- `src/store.ts` — replace `heroTvEffect: true` default with `heroEffectMode: "worn-tape"`.
  (Leave no stale boolean default; migration handles old persisted values at runtime.)

**Modified:**
- `src/components/DetailHeroEffect.tsx` — take a `look: HeroLook | null` (or `lookId`) prop
  instead of `active: boolean`. Render the look's motion-independent FX layers; render
  nothing when `null`. Keep the pause effect and `shouldPauseEffect` helper.
- `src/components/DetailHeroEffect.css` — add the new layer styles (`tv-flicker`,
  `tv-slice`, B&W modifier) and per-look layer overrides; keep existing VHS layers, pause
  rule, reduced-motion fallback.
- `src/components/DetailHero.tsx` — replace the checkbox with a `<select>` of all 11 options;
  read `useHeroEffectMode()`; compute the per-mount random seed; call `resolveHeroLook(mode,
  title, seed)`; apply the resolved look's **motion class** to the background container and
  pass the look to `DetailHeroEffect`. When the resolver returns `null` (disabled), apply no
  motion class and render no overlay (original static path).
- `src/components/DetailHero.css` — move the Ken Burns animation off the bare `.detail-hero-bg`
  rule and onto motion classes (`.hero-motion-current`, `-focal`, `-breathe`, `-push`,
  `-sway`, `-wander`); add the 5 new motion keyframes; keep `inset:-8%` only when a motion
  class is present (disabled stays `inset:0`, no animation); restyle the toggle as
  `.ds-select`-based; keep z-order and reduced-motion handling.

**Note on Disabled and the background inset:** the `inset:-8%` oversize exists only to hide
edges during drift. For `disabled` (no motion) the background must use the original
`inset:0`. So the oversize+animation travel together on the motion classes; the base
`.detail-hero-bg` returns to its original static rule.

## Testing

Per `testing.md` (pure logic + light render tests; no heavy component testing):

- **`heroLooks.test.ts` (unit, primary coverage):**
  - `resolveHeroLook("disabled", …)` → `null`.
  - each named look id → itself.
  - `"random"` with many seeds → always one of the 8 look ids, never `disabled`/invalid.
  - `"by-artist"` → deterministic for a fixed name; same name twice = same id; differs
    across a spread of names (basic distribution sanity, not uniformity proof); empty and
    whitespace names resolve to a valid id without throwing.
  - `hashString` stable across calls.
  - migration mapping helper: `true → "worn-tape"`, `false → "disabled"`, unknown/missing →
    default.
- **`heroEffectMode` store tests** (adapt existing `heroTvEffect.test.ts`): default mode,
  set persists the string, no-op on same value, load reads a stored string, migration of a
  stored legacy boolean, ignore of malformed values.
- **`DetailHeroEffect` render tests** (adapt existing): renders the correct layer set for a
  representative look, renders nothing for `null`, pause helper unchanged.
- **`DetailHero` integration tests** (adapt existing): the `<select>` renders all 11 options;
  selecting "disabled" removes the overlay and the motion class; selecting a look renders the
  overlay; selecting "random"/"by-artist" renders some overlay (non-null).
- **Manual verification (Tauri webview):** dropdown lists all options; each look renders its
  intended motion+effect; Disabled returns the hero to its original static look (no drift, no
  overlay); Random changes on navigate-away-and-back; By-artist is stable per name and varies
  across artists; persistence across restart; migration from a previously-true/false install;
  reduced-motion still neutralizes motion; holds across at least one light and one dark skin.

## Risks / Open Notes

- **Migration correctness** — the one-time boolean→string mapping must run before the first
  persist of the new key, and must not clobber an explicitly-set new value. Covered by a
  unit test on the mapping and by load-order in the store module (read legacy only when the
  new key is absent).
- **`disabled` must equal the true pre-feature baseline** — verify the background uses
  `inset:0` and no animation in that mode (not merely a hidden overlay over a still-drifting
  background).
- **Random churn** — re-rolling on every mount means rapid back/forth navigation reshuffles
  the look. Accepted (matches "each page visit"). Not seeded to entity by design.
- **Label/order bikeshedding** — the 8 look names are provisional; trivially renamable in
  `heroLooks.ts` without touching logic.
