# ViboPLR UI Guidelines

## Glass Button System

All interactive buttons use the `.g-btn` base class — a frosted-glass style with translucent background, backdrop blur, and subtle border. This is the single button primitive across the entire app.

### Size Variants (circular)

| Class | Size | Use case |
|---|---|---|
| `.g-btn-play` | 46px | Hero play/pause button (now-playing bar, fullscreen) |
| `.g-btn-md` | 34px | Primary transport (previous, next) |
| `.g-btn-sm` | 28px | Standard icon button (volume, mode toggles, sidebar, caption bar) |
| `.g-btn-xs` | 24px | Tertiary / de-emphasized (stop, dislike, sidebar collapse) |

### Shape Variants

| Class | Shape | Use case |
|---|---|---|
| *(default)* | Circle (`border-radius: 50%`) | Icon-only buttons |
| `.g-btn-rect` | Rounded rect (`border-radius: 6px`) | Buttons with text labels (e.g., mini-player toggle) |

### State Classes

| Class | Appearance | Use case |
|---|---|---|
| `.active` | Accent-tinted background + border | Toggle-on state (loop, shuffle, auto-continue, sync) |
| `.liked` | Red-tinted background | Liked track heart |
| `.disliked` | Slightly brighter overlay | Disliked track indicator |

### Markup Pattern

```tsx
{/* Icon-only circular button */}
<button className="g-btn g-btn-sm" onClick={handler} title="Label">
  <svg width="12" height="12" viewBox="0 0 24 24" ...>...</svg>
</button>

{/* Toggle button */}
<button className={`g-btn g-btn-sm${isActive ? " active" : ""}`} onClick={handler}>
  <svg .../>
</button>

{/* Text button */}
<button className="g-btn g-btn-rect" onClick={handler}>
  <svg .../> Label
</button>
```

### Icons

- Use inline SVGs, not unicode glyphs or `dangerouslySetInnerHTML`.
- Feather-style stroked icons for most controls (stroke="currentColor", strokeWidth="2").
- Filled SVGs for transport buttons (play, pause, prev, next, stop) and the liked heart.
- Standard icon sizes by button size: `g-btn-play` = 20px, `g-btn-md` = 14px, `g-btn-sm` = 12-13px, `g-btn-xs` = 9-10px.

## Skin-Aware Colors

The glass effect must work on both dark and light skins. Never hardcode `rgba(255,255,255,...)` or `rgba(0,0,0,...)` for overlay effects.

### Overlay Variables

| Variable | Dark skin value | Light skin value | Purpose |
|---|---|---|---|
| `--overlay-base` | `255, 255, 255` | `0, 0, 0` | Glass tint (bg, border, hover) |
| `--overlay-inverse` | `0, 0, 0` | `255, 255, 255` | Inverse overlay (rarely needed) |
| `--accent-rgb` | Auto-derived from `--accent` | Auto-derived | Accent tint for active/play states |

These are RGB triplets (no `rgb()` wrapper) — use inside `rgba()`:

```css
/* Correct */
background: rgba(var(--overlay-base), 0.05);
border: 1px solid rgba(var(--overlay-base), 0.08);

/* Wrong — breaks on light skins */
background: rgba(255, 255, 255, 0.05);
```

### Opacity Scale

| Purpose | Opacity |
|---|---|
| Resting background | `0.05` |
| Resting border | `0.08` |
| Hover background | `0.10` |
| Hover border | `0.15` |
| Active/toggle accent bg | `0.12` |
| Active accent border | `0.25` |

## Skinnable Color Keys

The skin system has 16 user-customizable color keys. `--overlay-base` and `--overlay-inverse` are **not** skinnable — they are hardcoded per dark/light mode in `App.css`. `--accent-rgb` is auto-derived from the skinnable `--accent` hex value via `hexToRgb()` in `skinUtils.ts`.

## Text Buttons (Settings, Modals)

For primary action buttons in settings/modals, use `.settings-btn` (solid accent background). For secondary actions, use `.settings-btn-secondary` (glass style matching `.g-btn`). These are rectangular, full-width or auto-width text buttons — distinct from the circular `.g-btn` icon buttons.

## Type Scale

Use the existing CSS custom property scale, never hardcoded `font-size` values:

| Variable | Size |
|---|---|
| `--fs-2xs` | Smallest |
| `--fs-xs` | |
| `--fs-sm` | |
| `--fs-base` | Default body |
| `--fs-lg` | |
| `--fs-xl` | |
| `--fs-2xl` | Largest headings |

## Transitions

Standard transition: `all 0.15s`. Used on all `.g-btn` variants for background, color, and border-color changes.

## Backdrop Filter

All glass buttons use `backdrop-filter: blur(8px)` (with `-webkit-` prefix). This creates the frosted-glass effect against album art, backgrounds, etc. If a button sits in a context where blur is unnecessary or causes performance issues, keep it — the visual consistency matters more.
