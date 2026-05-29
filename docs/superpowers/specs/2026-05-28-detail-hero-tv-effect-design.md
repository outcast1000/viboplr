# Detail Hero Old-TV Effect — Design

**Date:** 2026-05-28
**Status:** Approved (design phase)

## Summary

Add a continuous, animated "old TV / degraded VHS" effect to the background of the
shared detail-page hero. The effect runs behind the hero art on all four detail
pages (Artist, Album, Track, Tag) and combines:

- **Background drift** — a slow Ken Burns pan + zoom on the existing hero background.
- **TV static / snow** — dense animated noise ("max snow" intensity).
- **VHS chroma bleed** — red/blue color fringing that drifts horizontally.
- **Rolling tracking band** — a soft horizontal band sweeping vertically (tape tracking).
- **Scanlines + vignette** — fine CRT scanlines and darkened phosphor edges.

A small checkbox in the **top-right corner of the hero** toggles the effect on/off.
The preference is global (one switch governs all four detail pages) and persisted.
The effect defaults **ON**.

## Goals

- A visually rich, "max snow" broken-TV look that plays continuously behind the hero.
- Full-strength across the entire hero (no easing behind text — the existing scrim
  provides the base legibility gradient).
- Cheap to render: GPU-composited only, no per-frame JavaScript.
- Never burns cycles when not visible (hero off-screen or window hidden).
- Respects the OS `prefers-reduced-motion` setting.
- Drops into all four detail pages with no per-page work, via the shared `DetailHero`.

## Non-Goals

- No per-page or per-entity configuration (single global toggle only).
- No user-tunable intensity (intensity is fixed at the approved "max snow" dial).
- No change to the existing multi-image hero background montage / edge feathering
  behavior — the drift is applied to the background container as a whole.
- Not applied to non-detail surfaces (Home hero, Now Playing, etc.).
- Video tracks: the Track detail hero shows a live video frame card in the art slot;
  the TV effect still applies to the hero background layer as on other pages. The
  effect does not alter video-frame behavior.

## Architecture

The hero is already unified: every detail page renders through
`src/components/DetailHero.tsx`, which wraps `DetailHeroBackground` (the moving/
montage background) and a content row. Z-order today:

```
.detail-hero (position: relative; overflow: hidden)
├── .detail-hero-bg            z-index 0   (DetailHeroBackground — montage images)
├── .detail-hero::after        z-index 0   (scrim: horizontal + vertical gradient)
└── .detail-hero-row           z-index 1   (art + title + actions)
```

### New / changed pieces

1. **`src/components/DetailHeroEffect.tsx`** (new)
   - Self-contained overlay that renders the stacked FX layers. Pure presentational;
     takes a single `active: boolean` prop (already gated by the caller).
   - Renders nothing (returns `null`) when `active` is false.
   - Layers (all `position: absolute; inset: 0; pointer-events: none`):
     - two noise layers (`.tv-noise`, `.tv-noise-2`) — tiled PNG, different scale/speed
     - two chroma-bleed gradients (`.tv-bleed`, `.tv-bleed-2`)
     - rolling tracking band (`.tv-track`)
     - scanlines (`.tv-scan`)
     - vignette (`.tv-vignette`)

2. **`src/components/DetailHeroEffect.css`** (new)
   - All keyframes + layer styles. References the noise asset.
   - Hosts the `prefers-reduced-motion` fallback and the off-screen pause hook.

3. **`src/assets/tv-noise.png`** (new asset, ~30 KB)
   - A 128×128 grayscale+alpha random-pixel PNG (genuine static). Committed to the
     repo and imported by the CSS/component. **Rationale:** WebKit (Tauri's webview)
     does not reliably rasterize SVG `feTurbulence` inside a `background-image` data
     URI — a real raster texture is required. Verified during brainstorming: the SVG
     approach rendered blank; a PNG texture rendered correctly.

4. **`src/components/DetailHero.tsx`** (changed)
   - Adds the Ken Burns drift to the background container (a `transform` keyframe
     applied to `.detail-hero-bg` as a whole, so the montage/feathering is undisturbed;
     the container is slightly inset/oversized so pan/zoom never reveals edges).
   - Mounts `<DetailHeroEffect active={effectOn} />` between the background and the scrim.
   - Renders the corner toggle (see below).
   - Bumps the content row above the FX so the title/actions stay crisp and interactive.

5. **`src/components/DetailHero.css`** (changed)
   - Ken Burns keyframe + the `will-change: transform` hint on the background container.
   - Corner-toggle styles.
   - Raised z-index for the effect overlay and content row.

### Z-order after change

```
.detail-hero-bg            z-index 0   (montage, now drifting)
.detail-hero-effect        z-index 1   (FX overlay — full strength)
.detail-hero::after        z-index 2   (existing scrim)
.detail-hero-row           z-index 3   (art + title + actions)
.detail-hero-tv-toggle     z-index 4   (corner checkbox)
```

The effect sits **below** the scrim, so the existing horizontal/vertical scrim
gradient still darkens the lower-left text zone for baseline legibility, while the
snow itself plays at full strength across the whole hero.

## The Corner Toggle

- **Placement:** pinned to the top-right corner of the hero (`position: absolute; top; right`).
- **Form:** a small, subtle pill — a TV glyph + a checkbox/check state — built from
  `.ds-*` classes and skin custom properties (semi-transparent background so it does
  not fight the art). Uses an accessible `<label>` + checkbox (or a button with
  `role="switch"` + `aria-checked`).
- **Visibility:** hover-reveal — fades in when the pointer is over the hero (matching
  the existing hover-overlay pattern, e.g. card play/like buttons: `opacity: 0` →
  `opacity: 1` on `:hover`), and is always rendered for keyboard focus
  (`:focus-visible` forces it visible).
- **Scope:** **global**. A single preference governs all four detail pages. Toggling
  it on the Album hero immediately affects Artist/Track/Tag heroes too.

### Preference & persistence

- New app-store key: **`heroTvEffect: boolean`**, default **`true`**.
- Persisted via the existing `tauri-plugin-store` `app-state.json` mechanism, debounced
  with the other UI state, and guarded by the existing `restoredRef` pattern so startup
  defaults never overwrite a saved value.
- Read once into app state on startup; the resolved boolean is threaded to `DetailHero`
  (the same way other UI prefs reach shared components). The toggle's `onChange` writes
  the new value to both app state and the store.

## Motion, Performance, Accessibility

### Performance

- **GPU-only.** Drift is a `transform` animation; snow is `background-position` hops on
  a tiled texture via `steps()`; bleed/band are `transform`/gradient animations. No
  `<canvas>`, no `requestAnimationFrame`, no per-frame JS.
- **Off-screen pause.** An `IntersectionObserver` on the hero toggles a
  `.tv-paused` class (sets `animation-play-state: paused`) when the hero is not
  intersecting the viewport. A `visibilitychange` listener pauses when the window/tab is
  hidden. This guarantees zero animation cost when the user is not looking at a hero.
  - This logic lives in `DetailHeroEffect.tsx` (effect cleans up observer/listener on
    unmount). When `active` is false the component is unmounted and there is nothing to
    pause.

### Accessibility — `prefers-reduced-motion`

- When the OS requests reduced motion, a CSS media query disables the drift and all
  animated layers and falls back to a **static** treatment: faint scanlines + vignette
  only (no movement, no animated snow). Implemented purely in CSS
  (`@media (prefers-reduced-motion: reduce)`), so it needs no JS branch.
- The user toggle composes on top: reduced-motion users who leave the effect ON get the
  static fallback; turning it OFF removes even that.

### Skin compatibility

- Vignette, scanline darkness, and the scrim continue to use skin RGB custom properties
  (`--bg-primary`, `--now-playing-bg-rgb`, `--hero-scrim-*`) where applicable.
- The chroma-bleed colors are intentionally fixed red/blue (the VHS look is not
  skin-derived), kept at low alpha so they read as fringing over any skin.
- The toggle pill uses `--bg-*`, `--text-*`, `--accent` so it adapts per skin.
- Verify the hero across multiple skins (light + dark) during implementation.

## Effect Parameters (approved "max snow" dial)

Captured from the approved brainstorming preview so implementation matches what was seen:

- **Noise layers:** two tiled copies of `tv-noise.png`.
  - Layer 1: `background-size: 128px`, `opacity ~0.85`, `mix-blend-mode: normal`,
    `animation: <position-hop> .35s steps(6) infinite`.
  - Layer 2: `background-size: 90px`, `opacity ~0.6`, `mix-blend-mode: normal`,
    `animation: <position-hop> .28s steps(5) infinite`.
  - `image-rendering: pixelated` so the grain stays crisp.
- **Chroma bleed:** two `mix-blend-mode: screen` gradient layers, alpha ~0.34
  (red from right, blue from left), drifting ±8px on a ~3s ease-in-out alternate.
- **Tracking band:** ~16px tall soft white band, `blur(1px)`, sweeping top→bottom over ~6s linear.
- **Scanlines:** `repeating-linear-gradient` 1px dark / 2px gap, `mix-blend-mode: multiply`,
  alpha ~0.16.
- **Vignette:** radial gradient, transparent center → ~0.55 black at edges.
- **Drift (Ken Burns):** background container `scale 1.08→1.16` with small
  `translate` excursions (±2–2.5%), ~28s ease-in-out infinite alternate. Container is
  inset (e.g. `inset: -8%`) so motion never exposes edges.

(Exact alpha/timing values may be nudged ±10% during implementation to match the
preview on real artwork; the look is the contract, these numbers are the starting point.)

## Testing

Per `testing.md`, tests target pure logic, not React components.

- **TypeScript unit:** the preference resolution (default-true, store read/write,
  `restoredRef` guard semantics) if it is extracted into a small pure helper. If the
  toggle logic stays inline in a component, no unit test is added (component behavior is
  out of scope for the unit suite).
- **E2E (Playwright, optional):** a smoke assertion that navigating to a detail page
  renders the hero and the toggle control, and that the effect overlay is present/absent
  according to the toggle. Gated on whether the existing E2E harness can reach a detail
  page with mocked data; if not trivially reachable, skip rather than over-invest.
- **Manual verification:** confirm in `npm run tauri dev` that (a) snow renders in the
  real webview (the WebKit PNG concern), (b) animations pause when scrolling the hero
  off-screen, (c) the reduced-motion fallback engages when the OS setting is on,
  (d) the toggle persists across app restart, (e) the look holds across at least two
  skins.

## Risks / Open Notes

- **WebKit texture rendering** — mitigated by using a real PNG asset (not SVG filter),
  verified during brainstorming.
- **Toggle discoverability** — hover-reveal means the control is hidden until the user
  hovers the hero. Accepted (matches existing hover-overlay conventions); `:focus-visible`
  keeps it keyboard-reachable. Revisit if it proves too hidden in practice.
- **Repo asset** — adds one ~30 KB binary to the bundle. Negligible.
