# Animation Design: Snappy UI + Playful Now Playing

**Date:** 2026-04-03
**Status:** Approved

## Goal

Add micro-interactions and motion design to make the app feel polished and joyful. General UI gets snappy, barely-noticeable transitions. The now-playing experience gets more expressive, playful animations.

## Constraints

- CSS-only for general UI; JS class toggles allowed for now-playing effects.
- All animations use GPU-composited properties (`transform`, `opacity`) except sort bar collapse (`max-height`) and album art glow (`opacity` on a pseudo-element with pre-rendered blur).
- All colors reference CSS custom properties (`var(--accent-rgb)`, etc.) for skin compatibility.
- No external animation libraries.
- No `prefers-reduced-motion` handling in this iteration (easy to add later).

---

## Section 1: General UI Micro-interactions (CSS-only)

### 1.1 Modal & Context Menu Scale-in

Modals and context menus currently appear instantly. Add entrance animation:

- `scale(0.95) + opacity: 0` to `scale(1) + opacity: 1`
- Duration: 150ms
- Easing: `cubic-bezier(0.16, 1, 0.3, 1)` (fast overshoot)
- Context menu: `transform-origin` set to `0 0` (top-left) since the menu is already positioned at the click point. After clamping (viewport overflow), the origin remains top-left — acceptable since clamping is an edge case.
- Exit animations are out of scope (would require delayed unmount patterns).

### 1.2 Like Heart Bounce

On like toggle, the heart icon gets a one-shot CSS keyframe animation:

```css
@keyframes heart-bounce {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.3); }
  100% { transform: scale(1); }
}
```

- Duration: 300ms
- Dislike button gets a subtler version (peak scale 1.15).
- Applied via `.anim-heart-bounce` class, added on click and removed on `animationend` event.
- Applies to like/dislike buttons in both the NowPlayingBar and TrackList rows. The animation class is managed locally in each component where the button element exists (not centrally in `App.tsx`).

### 1.3 Status Bar Slide-up

The status bar entrance changes from fade-in to slide-up:

- `translateY(100%) + opacity: 0` to `translateY(0) + opacity: 1`
- Duration: 300ms
- Partially exists in current CSS (line 1348), just needs to be made consistent.

### 1.4 Sort Bar Collapse/Expand

Smooth collapse/expand instead of instant toggle:

- Animate `max-height` + `opacity`
- Duration: 200ms
- `max-height` transitions from a fixed value (e.g., 200px) to 0.
- **Implementation note:** The sort bar currently uses conditional rendering (`{!collapsed && <div>}`). Must change to always-rendered with a `.collapsed` CSS class that sets `max-height: 0; opacity: 0; overflow: hidden`.

### 1.5 Sidebar Active Item Indicator

The sidebar already has a 3px accent-colored left-edge indicator via `box-shadow: inset 3px 0 0 var(--accent)` on the active item. Replace this per-item approach with a single absolutely-positioned element that slides vertically between items:

- A single `.sidebar-indicator` element positioned absolutely within the sidebar nav.
- Position computed from the active item's offset, animated via `transform: translateY()` with 200ms transition.
- Uses `var(--accent)` background color.

---

## Section 2: Now Playing — Playful Personality

### 2.1 Playing Indicator (Equalizer Bars)

A 3-bar animated icon that replaces the track number in the track list when a track is actively playing.

- 3 thin rectangles, each oscillating at different speeds/heights via CSS keyframes.
- Fits in the existing `#` column (~14px wide).
- `animation-play-state: paused` when playback is paused (not removed/re-added).
- Bars run at a relaxed pace (~30fps equivalent) to avoid CPU waste.

```css
@keyframes eq-bar-1 { 0%,100% { height: 30%; } 50% { height: 100%; } }
@keyframes eq-bar-2 { 0%,100% { height: 60%; } 50% { height: 20%; } }
@keyframes eq-bar-3 { 0%,100% { height: 40%; } 50% { height: 80%; } }
```

### 2.2 Album Art Glow

A pulsing accent-colored glow behind the album art thumbnail in the NowPlayingBar:

- Uses a `::before` pseudo-element on the art wrapper with `background: rgba(var(--accent-rgb), 0.7)` and `filter: blur(20px)`. The blur is pre-rendered; only `opacity` is animated (GPU-composited).
- Pulses between 50% and 80% opacity on a 3-second cycle.
- Active only when `.playing` class is present (toggled via JS in `NowPlayingBar.tsx`).
- When paused, glow holds at a static dim state (no abrupt disappear).
- `will-change: opacity` on the pseudo-element.
- Excluded from mini mode (52px height makes the glow disproportionate).

```css
.now-art-wrapper { position: relative; }
.now-art-wrapper::before {
  content: '';
  position: absolute;
  inset: -10px;
  background: rgba(var(--accent-rgb), 0.7);
  filter: blur(20px);
  border-radius: 8px;
  z-index: -1;
  opacity: 0.3;
  will-change: opacity;
}
.now-art-wrapper.playing::before {
  animation: glow-pulse 3s ease-in-out infinite;
}
@keyframes glow-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 0.8; }
}
```

### 2.3 Track Info Slide on Change

When `currentTrack` changes, the track title + artist/album text in the NowPlayingBar transitions:

- Old text slides up + fades out.
- New text slides in from below + fades in.
- Duration: 250ms.
- Implementation: a `<SlideText>` wrapper (~20 lines) inline in `NowPlayingBar.tsx`. Uses `useEffect` that detects content change via `key` prop and toggles enter/exit CSS classes.

```css
.slide-text-exit  { transform: translateY(0); opacity: 1; }
.slide-text-exit-active { transform: translateY(-100%); opacity: 0; transition: all 250ms; }
.slide-text-enter { transform: translateY(100%); opacity: 0; }
.slide-text-enter-active { transform: translateY(0); opacity: 1; transition: all 250ms; }
```

### 2.4 Waveform Fade-in

When waveform peak data loads, bars grow upward from zero height + fade in:

- Duration: 400ms total.
- Left-to-right stagger with per-bar delay.
- **Implementation note:** `WaveformSeekBar.tsx` draws bars on a `<canvas>` via `ctx.fillRect()`, not as DOM elements. The grow-in effect is implemented as a JS-driven animation in the canvas draw loop: a progress variable ramps from 0 to 1 over 400ms (via `requestAnimationFrame`), each bar's rendered height is `peak * easeProgress(barIndex)` where `easeProgress` includes a per-bar stagger offset (~2ms per bar). Computed once on waveform data change, not on every frame after completion.

---

## Section 3: Implementation Details

### JS Touchpoints (minimal)

| File | Change |
|------|--------|
| `NowPlayingBar.tsx` | Add `.playing` class on art wrapper for glow pulse. Inline `<SlideText>` wrapper (~20 lines). Heart bounce animation class on like/dislike buttons. Exclude glow from mini mode. |
| `TrackList.tsx` | Accept new `playing: boolean` prop. Swap track number for equalizer bars when `track.id === currentTrackId && playing`. Heart bounce on like/dislike buttons. |
| `App.tsx` | Pass `playing` prop to TrackList. Change sort bar from conditional rendering to CSS-class-based visibility. |
| `Sidebar.tsx` | Add `.sidebar-indicator` element, compute position from active item offset. |
| `WaveformSeekBar.tsx` | JS-driven canvas grow-in animation on waveform data load (rAF loop, 400ms). |

### CSS Organization

- All new `@keyframes` go in a `/* === Animations === */` section at the end of `App.css`.
- Animation utility classes follow the pattern `.anim-{name}`.

### What's NOT Included

- No view transitions (finicky in Tauri webview).
- No album card stagger entrance.
- No canvas/WebGL effects.
- No modal/context menu exit animations (would require delayed unmount patterns).
- No `prefers-reduced-motion` (trivial to add later by wrapping keyframes section in `@media (prefers-reduced-motion: reduce) { ... }`).
