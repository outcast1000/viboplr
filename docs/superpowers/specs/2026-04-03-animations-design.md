# Animation Design: Snappy UI + Playful Now Playing

**Date:** 2026-04-03
**Status:** Approved

## Goal

Add micro-interactions and motion design to make the app feel polished and joyful. General UI gets snappy, barely-noticeable transitions. The now-playing experience gets more expressive, playful animations.

## Constraints

- CSS-only for general UI; JS class toggles allowed for now-playing effects.
- All animations use GPU-composited properties (`transform`, `opacity`) except sort bar collapse (`max-height`).
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
- Context menu: `transform-origin` set to click position so it scales from where the user right-clicked.

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

### 1.5 Sidebar Active Item Indicator

A 3px-wide accent-colored bar on the left edge of the active sidebar item:

- Slides vertically using `transform: translateY()` with 200ms transition.
- Replaces the current background-color swap for active state.
- Uses `var(--accent)` color.

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

- `box-shadow` using `var(--accent-rgb)` with ~20px blur.
- Pulses between 50% and 80% opacity on a 3-second cycle.
- Active only when `.playing` class is present (toggled via JS in `NowPlayingBar.tsx`).
- When paused, glow holds at a static dim state (no abrupt disappear).
- `will-change: box-shadow` applied (persistent animation element).

```css
@keyframes glow-pulse {
  0%, 100% { box-shadow: 0 0 20px rgba(var(--accent-rgb), 0.5); }
  50%      { box-shadow: 0 0 20px rgba(var(--accent-rgb), 0.8); }
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

- Duration: 400ms per bar.
- Left-to-right stagger: each bar delayed by ~2ms (inline `animation-delay` style).
- Computed once on mount, not per-frame JS.

```css
@keyframes waveform-grow {
  from { transform: scaleY(0); opacity: 0; }
  to   { transform: scaleY(1); opacity: 1; }
}
```

---

## Section 3: Implementation Details

### JS Touchpoints (minimal)

| File | Change |
|------|--------|
| `NowPlayingBar.tsx` | Add/remove `.playing` class for glow pulse. Inline `<SlideText>` wrapper component (~20 lines). |
| `TrackList.tsx` | Swap track number for equalizer bars when `track.id === currentTrackId && isPlaying`. |
| `App.tsx` | Add `.anim-heart-bounce` class on like toggle, remove on `animationend`. |
| `WaveformSeekBar.tsx` | Add inline `animation-delay` per bar on waveform data load. |

### CSS Organization

- All new `@keyframes` go in a `/* === Animations === */` section at the end of `App.css`.
- Animation utility classes follow the pattern `.anim-{name}`.

### What's NOT Included

- No view transitions (finicky in Tauri webview).
- No album card stagger entrance.
- No canvas/WebGL effects.
- No `prefers-reduced-motion` (trivial to add later by wrapping keyframes section).
