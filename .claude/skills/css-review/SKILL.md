---
name: css-review
description: Use when the user wants to audit CSS for skin system compliance, check for hardcoded colors, review CSS variables usage, or run a CSS health check. Triggers on "css review", "css audit", "skin compliance", "hardcoded colors", "check css", or "/css-review".
---

# CSS Skin Compliance Review

On-demand audit of all CSS and inline styles for skin system compliance. Scans for hardcoded color values and proposes specific `var(--*)` replacements grounded in the project's skin system.

## Step 1: Read the Skin System

Before scanning, build a semantic model by reading these files:

1. **Read `src/types/skin.ts`** — extract `SKIN_COLOR_KEYS` to know every available CSS custom property
2. **Read `src/skinUtils.ts`** — note `RGB_DERIVED_KEYS` (which skin colors get `-rgb` variants: `accent`, `now-playing-bg`, `bg-primary`)
3. **Read `src/base.css`** — understand the default `:root` values and the overlay system:
   - `--overlay-base`: `255, 255, 255` (dark mode) / `0, 0, 0` (light mode) — used for same-theme glass highlights and translucent borders
   - `--overlay-inverse`: `0, 0, 0` (dark mode) / `255, 255, 255` (light mode) — used for overlays on contrasting surfaces
4. **Read 2-3 skin JSON files from `src/skins/`** — understand what hex values map to which variables across different skins (e.g., `#fff` might be `--text-primary` in a dark skin but `--bg-primary` in a light skin)

### Semantic Mapping

Use this mapping to propose correct replacements. The right variable depends on both the CSS property and the selector context:

| Variable | Semantic Role | Typical CSS Property Context |
|----------|--------------|------------------------------|
| `--bg-primary` | Main background | `background` on page/container |
| `--bg-secondary` | Card/panel backgrounds | Nested containers, cards |
| `--bg-tertiary` | Deeper nesting | Third-level containers |
| `--bg-surface` | Floating elements | Modals, dropdowns, popovers |
| `--bg-hover` | Hover states | `:hover` backgrounds |
| `--text-primary` | Primary text | `color` on body text, headings |
| `--text-secondary` | Muted text | Subtitles, metadata |
| `--text-tertiary` | Very muted text | Hints, placeholders |
| `--accent` | Interactive elements | Buttons, links, active states |
| `--accent-dim` | Accent hover variant | `:hover` on accent elements |
| `--accent-rgb` | Accent with opacity | `rgba(var(--accent-rgb), 0.x)` |
| `--overlay-base` | Glass highlights, translucent borders (white in dark, black in light) | `rgba(var(--overlay-base), 0.x)` for subtle borders, glass effects |
| `--overlay-inverse` | Cross-theme overlays (black in dark, white in light) | `rgba(var(--overlay-inverse), 0.x)` for overlays on contrasting surfaces |
| `--border` | Dividers, borders | `border-color`, `border` |
| `--error` | Error/danger state | Validation, alerts, destructive buttons |
| `--success` | Success state | Confirmation, positive feedback |
| `--warning` | Warning state | Caution indicators |
| `--now-playing-bg` | Now playing bar | Footer bar background |
| `--now-playing-bg-rgb` | Now playing with opacity | `rgba(var(--now-playing-bg-rgb), 0.x)` |
| `--bg-primary-rgb` | Background with opacity | `rgba(var(--bg-primary-rgb), 0.x)` |

**Important:** `--overlay-base` is NOT for shadows. It's white in dark mode — using it in `box-shadow` would produce white shadows. Shadows use hardcoded `rgba(0, 0, 0, ...)` and are allowlisted.

## Step 2: Scan for Violations

Use Grep to scan for hardcoded color values across all CSS and TSX files.

### Scan targets

- **CSS files:** `src/**/*.css`
- **TSX files:** `src/**/*.tsx` (for inline `style=` attributes and style objects)

### Patterns to detect

Run these Grep searches and collect all matches with file paths and line numbers:

1. **Hex colors:** Pattern `#[0-9a-fA-F]{3,8}` in CSS files — but exclude matches inside `var()` expressions
2. **rgb/rgba literals:** Pattern `rgba?\(\s*\d+` — matches `rgb(` or `rgba(` followed by a literal number (not `var(`)
3. **hsl/hsla literals:** Pattern `hsla?\(\s*\d+`
4. **Named CSS colors in properties:** Pattern `:\s*(white|black|red|blue|green|yellow|orange|purple|pink|gray|grey)\s*[;}]` — but NOT `transparent`, `inherit`, `currentColor`, `none`

### For TSX files specifically

Look for inline style objects with color-related properties:
- Pattern `(color|background|backgroundColor|borderColor|border)\s*:\s*["']#` 
- Pattern `(color|background|backgroundColor|borderColor|border)\s*:\s*["']rgb`

## Step 3: Apply Allowlist

Filter out known exceptions. For each match, check against this allowlist before counting it as a violation:

| Pattern | How to Detect | Reason |
|---------|--------------|--------|
| WindowControls.css traffic lights | File is `WindowControls.css` AND color is `#ff5f57`, `#febc2e`, or `#28c840` | System UI, not skinnable |
| Logo gradient | File is `CaptionBar.tsx`, `App.css`, or `SettingsPanel.tsx` AND color is `#FF6B6B` or `#E91E8A` | Brand identity |
| `transparent` / `rgba(0,0,0,0)` | Value is literally `transparent` or alpha is `0` | Not a color choice |
| Shadow colors | Property is `box-shadow`, `text-shadow`, or `filter` containing `drop-shadow` AND value is `rgba(0, 0, 0, ...)` | Shadows are always dark |
| `color-mix()` with `var()` | Line contains `color-mix(` AND `var(` | Already partially skinned |
| `:root` variable definitions | File is `base.css` AND line matches `--[a-z-]+:\s*#` | These ARE the skin system |
| Like-button pink | Color is `rgba(255, 77, 106, ...)` AND selector contains `.liked` or `.disliked` | Intentional hardcoded state color |
| Decorative/badge colors | Context suggests format-type badge or category indicator | Flag as "decorative — confirm" rather than a hard violation |
| `var()` fallback hex | Line matches `var\(--[^,]+,\s*#[0-9a-f]+\)` | Defensive CSS |
| Skin preview swatches | File is `SettingsPanel.tsx` AND line renders `skin.colors` or `entry.colors` | Preview must show literal colors |
| Status-color rgba without derived var | Color matches the success/error/warning hex values with alpha (e.g., `rgba(76, 175, 80, 0.15)`) | No `--success-rgb` exists — note as "needs new derived variable" |
| YouTube brand red | Color is `#FF0000` AND selector/class contains `youtube` | Brand identity (YouTube) |
| `@keyframes` internals | Line is inside a `@keyframes` block | Animation internals — may contain hardcoded values that are not skinnable |
| Mini close button red | File is `NowPlayingBar.css` AND color is `#ff5f57` | Reuses macOS close button red for mini player close |

## Step 4: Produce Report

Present a three-part report:

### Part 1: Summary Statistics

Count and categorize all findings:

```
CSS Skin Compliance Report
══════════════════════════
Files scanned:     N CSS + N TSX
Total violations:  N
  Hex colors:      N
  rgba() literals: N
  hsl() literals:  N
  Named colors:    N
Allowlisted:       N (skipped)
Decorative:        N (confirm with user)
Needs derived var: N (would need new --*-rgb variables)
Coverage:          ~X% (color declarations using var() / total color declarations)
```

Compute coverage by counting:
- Total color declarations: all lines with `color:`, `background:`, `background-color:`, `border-color:`, `border:` (with color values), `box-shadow:`, `text-shadow:`, `fill:`, `stroke:` in CSS files
- Skinned declarations: those using `var(--` in their values
- Coverage = skinned / total * 100

### Part 2: Violations by File

Sort by violation count, descending:

```
File                              Violations
──────────────────────────────────────────────
src/App.css                       N
src/components/TrackDetailView.css N
src/components/SettingsPanel.css   N
...
```

### Part 3: Proposed Fixes

For each violation, show the file, line number, current value, and proposed replacement:

```
src/App.css:309       color: #fff                    →  color: var(--text-primary)
src/App.css:747       border: rgba(255,255,255,0.08) →  border: rgba(var(--overlay-base), 0.08)
src/components/TrackDetailView.css:4
                      background: #000               →  background: var(--bg-primary)
```

**Fix selection logic:**
- `color: #fff` or `color: white` → `var(--text-primary)` (unless in a muted/subtitle context → `var(--text-secondary)`)
- `color: #fff` on an accent-colored background (adjacent `background: var(--accent)` or similar) → note as "needs `--accent-text` or similar" — white-on-accent is semantically distinct from `--text-primary`
- `color: #000` or `color: black` → `var(--text-primary)` (for light-skin contexts) — note ambiguity
- `background: #fff` → `var(--bg-surface)` or `var(--bg-primary)` depending on nesting level
- `background: #000` → `var(--bg-primary)`
- `rgba(255, 255, 255, 0.xx)` in borders/backgrounds → `rgba(var(--overlay-base), 0.xx)`
- `rgba(0, 0, 0, 0.xx)` in borders/backgrounds (NOT shadows) → `rgba(var(--overlay-inverse), 0.xx)` or leave if ambiguous
- `border-color: #xxx` → `var(--border)`
- Colors matching accent hex value → `var(--accent)`
- Colors matching error/success/warning hex → `var(--error)` / `var(--success)` / `var(--warning)`

When a fix is ambiguous, note alternatives:
```
src/App.css:1430  color: #fff  →  var(--text-primary)  [or --text-secondary if muted context]
```

## Step 5: Offer to Apply Fixes

After presenting the report, ask the user:

- **Apply all** — edit all violations with the proposed replacements
- **Apply per-file** — go file by file with review before each edit
- **Skip** — use the report as reference only

When applying fixes, use the Edit tool for each replacement. Group edits by file for efficiency.
