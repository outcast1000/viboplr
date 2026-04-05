# Now Playing Bar — Glass Control Redesign

## Summary

Replace the current unicode-glyph transport controls and plain utility buttons in the now playing bar with a unified glass/frosted button system using proper SVG icons. The play/pause button becomes a prominent hero element; all other interactive elements get a consistent translucent treatment.

## Motivation

The current controls use raw unicode characters (⏮ ⏸ ⏭ ⏹ ♡ ➡ ∞) which render inconsistently across platforms and look unpolished. Buttons have no backgrounds or borders, making them feel like plain text rather than interactive elements. The right-side utility buttons (queue mode, auto-continue, volume) look disconnected from the transport controls.

## Scope

**In scope:**
- Transport controls (prev, play/pause, next, stop)
- Like / dislike buttons
- Queue mode and auto-continue buttons
- Volume icon and slider

**Out of scope:**
- Overall bar height and layout (stays 100px, three-zone)
- Seek bar / waveform appearance
- Track info text styling
- Album art and glow pulse effect
- Mini mode controls (keep current unicode glyphs and plain style — separate redesign later)

## Design

### Glass Button Base

All interactive buttons share a common glass style:

```css
background: rgba(255, 255, 255, 0.05);
backdrop-filter: blur(8px);
-webkit-backdrop-filter: blur(8px);
border: 1px solid rgba(255, 255, 255, 0.08);
border-radius: 50%;
transition: all 0.15s;
```

Hover state:
```css
background: rgba(255, 255, 255, 0.1);
color: #fff;
border-color: rgba(255, 255, 255, 0.15);
```

Focus state (keyboard navigation):
```css
.g-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

### Size Hierarchy & CSS Class Mapping

The existing `.ctrl-btn` class is replaced by `.g-btn` with size modifiers. Old classes (`.ctrl-btn`, `.play-btn`, `.mode-btn`, `.auto-continue-btn`) are removed.

| Button | Size | CSS Class | Notes |
|--------|------|-----------|-------|
| Play/Pause | 46px | `.g-btn.g-btn-play` | Accent-tinted glass, glow shadow |
| Prev / Next | 34px | `.g-btn.g-btn-md` | Neutral glass |
| Stop | 24px | `.g-btn.g-btn-xs` | Very subtle glass, muted color |
| Like | 28px | `.g-btn.g-btn-sm` | Pink/red tint when active |
| Dislike | 24px | `.g-btn.g-btn-xs` | Subtle, muted |
| Queue mode | 28px | `.g-btn.g-btn-sm` | Accent tint when active |
| Auto-continue | 28px | `.g-btn.g-btn-sm` | Accent tint when active |
| Volume icon | 28px | `.g-btn.g-btn-sm` | Neutral glass |

### Hero Play/Pause Button

```css
background: rgba(83, 168, 255, 0.18);
border: 1px solid rgba(83, 168, 255, 0.3);
color: var(--accent);
box-shadow: 0 0 16px rgba(83, 168, 255, 0.12),
            inset 0 1px 0 rgba(255, 255, 255, 0.08);
```

Hover:
```css
background: rgba(83, 168, 255, 0.28);
color: #fff;
box-shadow: 0 0 24px rgba(83, 168, 255, 0.2);
```

### Active/Toggle State

For buttons with on/off state (queue mode, auto-continue, like):

```css
background: rgba(83, 168, 255, 0.12);
border-color: rgba(83, 168, 255, 0.25);
color: var(--accent);
```

Like button when liked:
```css
color: var(--error); /* existing pink/red */
background: rgba(255, 77, 106, 0.1);
border-color: rgba(255, 77, 106, 0.2);
```

### SVG Icons

All unicode glyphs are replaced with custom inline SVGs. Icons use `fill="currentColor"` so they inherit the button's text color. No icon library — hand-authored minimal SVGs consistent with the existing volume icon style (stroke-based Feather/Lucide aesthetic for utility icons, filled for transport).

| Current | Replacement | Size | Style |
|---------|-------------|------|-------|
| ⏮ (prev) | Skip-back: vertical bar + left-pointing triangle | 14px | filled |
| ⏸ (pause) | Two rounded vertical bars | 20px | filled |
| ▶ (play) | Right-pointing triangle | 20px | filled |
| ⏭ (next) | Skip-forward: right-pointing triangle + vertical bar | 14px | filled |
| ⏹ (stop) | Rounded square | 10px | filled |
| ♡ / ♥ (like) | Heart outline / filled heart | 13px | stroke / filled |
| ⊘ (dislike) | Circle with diagonal slash | 9px | stroke |
| ➡ (normal mode) | Right arrow | 12px | stroke |
| 🔀 (shuffle) | Crossing arrows | 12px | stroke |
| 🔁 (loop) | Circular arrows | 12px | stroke |
| ∞ (auto-continue) | Infinity loop | 14px | stroke |
| Volume icons | Keep existing SVGs as-is | 13px | stroke (already SVG) |

All SVGs use `viewBox="0 0 24 24"` and scale via `width`/`height` attributes. Stroke-based icons use `stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.

### Volume Slider Enhancement

- Wrap the volume speaker icon in a glass button (28px)
- Add a knob dot on the slider thumb:
  - 10px circle, white fill
  - `box-shadow: 0 0 6px rgba(83, 168, 255, 0.4)`
- Add subtle border to the slider track background: `border: 1px solid rgba(255, 255, 255, 0.04)`
- Keep the existing gradient fill and track height

### Existing Animations

- The like button's `anim-heart-bounce` animation remains — it triggers on click regardless of glass styling
- Active/toggle state changes (like, queue mode, auto-continue) animate via the existing `transition: all 0.15s` on `.g-btn`

## Skinning Compatibility

All glass button colors use CSS custom properties where possible:
- `var(--accent)` and `rgba(var(--accent-rgb), ...)` for accent tints
- `var(--error)` for like button active state
- `var(--text-primary)`, `var(--text-secondary)`, `var(--text-tertiary)` for icon colors

The glass effect (backdrop-filter, translucent backgrounds) is additive and works on top of any skin's `--now-playing-bg`.

## Files to Modify

- `src/components/NowPlayingBar.tsx` — replace unicode with SVG icons, add glass button classes, restructure button markup
- `src/App.css` — add glass button styles (`.g-btn`, `.g-btn-sm`, `.g-btn-md`, `.g-btn-xs`, `.g-btn-play`), update `.now-like-btn`, `.now-dislike-btn`, `.ctrl-btn`, volume styles. Remove old unicode-specific sizing rules.

## What Stays the Same

- Overall bar structure: 100px height, seek bar on top, three-zone main row
- `NowPlayingBar` component props and callback interface
- Waveform seek bar rendering
- Track info text (title, artist, album)
- Album art with glow pulse
- Mini mode (separate redesign if desired later)
- Keyboard shortcuts
