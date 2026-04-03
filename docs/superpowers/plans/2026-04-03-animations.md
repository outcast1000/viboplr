# Animations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add snappy micro-interactions to the general UI and playful animations to the now-playing experience.

**Architecture:** Pure frontend changes — CSS keyframes for general UI, minimal JS class toggles for now-playing effects. All animations use GPU-composited properties (`transform`, `opacity`) except sort bar (`max-height`) and album art glow (`opacity` on a pseudo-element). No external libraries.

**Tech Stack:** CSS keyframes/transitions, React `useEffect`/`useRef`/`useCallback`, Canvas 2D API (waveform only)

**Spec:** `docs/superpowers/specs/2026-04-03-animations-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/App.css` | Modify | All new `@keyframes`, animation classes, modified modal/context-menu/status-bar/sort-bar/sidebar styles |
| `src/components/NowPlayingBar.tsx` | Modify | Album art glow (`.playing` class), `<SlideText>` wrapper, heart bounce |
| `src/components/TrackList.tsx` | Modify | Playing indicator (equalizer bars), heart bounce, new `playing` prop |
| `src/components/Sidebar.tsx` | Modify | Sliding active indicator element |
| `src/components/WaveformSeekBar.tsx` | Modify | Canvas grow-in animation on peak data load |
| `src/App.tsx` | Modify | Pass `playing` prop to TrackList, sort bar conditional→CSS-class rendering |

---

## Task 1: CSS Foundation — Keyframes and Animation Classes

All CSS animations are defined here. Later tasks reference these classes.

**Files:**
- Modify: `src/App.css` (append at end, ~line 6711)

- [ ] **Step 1: Add the `/* === Animations === */` section with all keyframes at the end of App.css**

```css
/* === Animations === */

/* Modal/Context menu entrance */
@keyframes scale-in {
  from { transform: scale(0.95); opacity: 0; }
  to   { transform: scale(1); opacity: 1; }
}

/* Heart bounce on like toggle */
@keyframes heart-bounce {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.3); }
  100% { transform: scale(1); }
}

@keyframes heart-bounce-subtle {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.15); }
  100% { transform: scale(1); }
}

/* Playing indicator equalizer bars */
@keyframes eq-bar-1 {
  0%, 100% { height: 30%; }
  50%      { height: 100%; }
}

@keyframes eq-bar-2 {
  0%, 100% { height: 60%; }
  50%      { height: 20%; }
}

@keyframes eq-bar-3 {
  0%, 100% { height: 40%; }
  50%      { height: 80%; }
}

/* Album art glow pulse */
@keyframes glow-pulse {
  0%, 100% { opacity: 0.5; }
  50%      { opacity: 0.8; }
}
```

- [ ] **Step 2: Add animation utility classes in the same section**

```css
/* Animation utility classes */
.anim-heart-bounce {
  animation: heart-bounce 300ms ease-out;
}

.anim-heart-bounce-subtle {
  animation: heart-bounce-subtle 300ms ease-out;
}
```

- [ ] **Step 3: Verify CSS parses correctly**

Run: `npx tsc --noEmit`
Expected: PASS (no TS errors from CSS changes)

- [ ] **Step 4: Commit**

```bash
git add src/App.css
git commit -m "feat: add animation keyframes and utility classes"
```

---

## Task 2: Modal & Context Menu Scale-in Entrance

**Files:**
- Modify: `src/App.css` — `.modal` (~line 4274), `.context-menu` (~line 1906)

- [ ] **Step 1: Add scale-in animation to modals**

Append these rules in the `/* === Animations === */` section (or near the existing `.modal` rule at ~line 4274):

```css
.modal-overlay .modal,
.shortcuts-modal {
  animation: scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1);
}
```

Note: `.modal-overlay` is at ~line 4264, `.modal` is at ~line 4274. The `.shortcuts-modal` is a standalone modal so it needs its own selector.

- [ ] **Step 2: Add scale-in animation to context menu with top-left origin**

Find `.context-menu` around line 1906 and add:

```css
.context-menu {
  animation: scale-in 150ms cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: 0 0;
}
```

- [ ] **Step 3: Visually verify in dev mode**

Run: `npm run tauri dev`
Test: Right-click a track → context menu should scale in from top-left. Open Settings → modal should scale in from center.

- [ ] **Step 4: Commit**

```bash
git add src/App.css
git commit -m "feat: add scale-in entrance for modals and context menus"
```

---

## Task 3: Like Heart Bounce

**Files:**
- Modify: `src/components/NowPlayingBar.tsx` (~lines 206-219)
- Modify: `src/components/TrackList.tsx` (~lines 362-368)

- [ ] **Step 1: Add heart bounce to NowPlayingBar like/dislike buttons**

In `NowPlayingBar.tsx`, add a ref and handler for the bounce animation. At the top of the component function:

```tsx
const likeBtnRef = useRef<HTMLSpanElement>(null);
const dislikeBtnRef = useRef<HTMLSpanElement>(null);
```

Wrap the existing `onToggleLike` call to add the animation class:

```tsx
<span
  ref={likeBtnRef}
  className={`now-like-btn${currentTrack.liked === 1 ? " liked" : ""}`}
  onClick={() => {
    likeBtnRef.current?.classList.add("anim-heart-bounce");
    onToggleLike();
  }}
  onAnimationEnd={() => likeBtnRef.current?.classList.remove("anim-heart-bounce")}
  title={`${currentTrack.liked === 1 ? "Unlike" : "Like"}`}
>{currentTrack.liked === 1 ? "\u2665" : "\u2661"}</span>
```

Do the same for the dislike button using `dislikeBtnRef` and `anim-heart-bounce-subtle`.

- [ ] **Step 2: Add heart bounce to TrackList like/dislike buttons**

In `TrackList.tsx`, the like button in the `renderCell` function (case `"like"`, ~line 362) uses inline `onClick`. Add the bounce via the same pattern — but since rows are mapped, use the event target directly:

```tsx
case "like":
  return (
    <span key="like" className="col-like">
      <span className={`like-btn${t.liked === 1 ? " active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).classList.add("anim-heart-bounce");
          onToggleLike(t);
        }}
        onAnimationEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("anim-heart-bounce")}
        title={t.liked === 1 ? "Unlike" : "Like"}>
        {t.liked === 1 ? "\u2665" : "\u2661"}
      </span>
      {onToggleDislike && <span className={`dislike-btn${t.liked === -1 ? " active" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).classList.add("anim-heart-bounce-subtle");
          onToggleDislike(t);
        }}
        onAnimationEnd={(e) => (e.currentTarget as HTMLElement).classList.remove("anim-heart-bounce-subtle")}
        title={t.liked === -1 ? "Remove dislike" : "Dislike"}>
        {t.liked === -1 ? "\u2716" : "\u2298"}
      </span>}
    </span>
  );
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Visually verify**

Run: `npm run tauri dev`
Test: Click a like heart in the track list → should bounce to 1.3x and back. Click dislike → subtler bounce. Click like in NowPlayingBar → same bounce.

- [ ] **Step 5: Commit**

```bash
git add src/components/NowPlayingBar.tsx src/components/TrackList.tsx
git commit -m "feat: add heart bounce animation on like/dislike toggle"
```

---

## Task 4: Status Bar Slide-up Entrance

**Files:**
- Modify: `src/App.css` — `.status-bar` styles (~line 1338)

- [ ] **Step 1: Update status bar entrance animation**

The status bar already has `transform: translateY(100%)` at line 1348 and a transition at line 1349. Verify the existing transition includes `transform` and `opacity`. The current rule at line 1349 is:

```css
transition: opacity 0.3s, transform 0.3s, left 0.2s ease, right 0.2s ease;
```

This already transitions `transform` and `opacity`. Verify the initial state at ~line 1348 has:

```css
transform: translateY(100%);
opacity: 0;
```

And the visible state at ~line 1369 has:

```css
transform: translateY(0);
opacity: 1;
```

If this is already correct, the status bar slide-up is already implemented. Check and confirm, then skip this step if already working.

- [ ] **Step 2: Visually verify**

Run: `npm run tauri dev`
Test: Delete a track (or trigger any status message) → status bar should slide up from below.

- [ ] **Step 3: Commit (if changes were needed)**

```bash
git add src/App.css
git commit -m "feat: refine status bar slide-up entrance"
```

---

## Task 5: Sort Bar Smooth Collapse/Expand

**Files:**
- Modify: `src/App.css` — add `.sort-bar` collapse transition styles
- Modify: `src/App.tsx` — change sort bar from conditional rendering to CSS-class-based (~line 2311)

- [ ] **Step 1: Add sort bar collapse CSS**

Add near the existing `.sort-bar` rules (~line 3639):

```css
.sort-bar-wrapper {
  max-height: 200px;
  opacity: 1;
  overflow: hidden;
  transition: max-height 200ms ease, opacity 200ms ease;
}

.sort-bar-wrapper.collapsed {
  max-height: 0;
  opacity: 0;
}
```

- [ ] **Step 2: Change conditional rendering to CSS-class in App.tsx**

Find the sort bar rendering around line 2311. The current pattern is:

```tsx
{!library.sortBarCollapsed && (
  <div className="sort-bar">
    ...
  </div>
)}
```

Change to always render, wrapping in a div with the collapsed class:

```tsx
<div className={`sort-bar-wrapper${library.sortBarCollapsed ? " collapsed" : ""}`}>
  <div className="sort-bar">
    ...
  </div>
</div>
```

There are **5 sort bar instances** in App.tsx that need this treatment, at lines:
- Line 2311 — All Tracks view sort bar
- Line 2584 — Artists view sort bar
- Line 2723 — Albums view sort bar
- Line 2954 — Tags view sort bar
- Line 3160 — Liked view sort bar

Each follows the same `{!library.sortBarCollapsed && (<div className="sort-bar">...</div>)}` pattern. Wrap each one in the `sort-bar-wrapper` div and remove the conditional rendering.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Visually verify**

Run: `npm run tauri dev`
Test: Click the sort bar collapse toggle (▲/▼) → sort bar should smoothly animate height and opacity instead of popping in/out.

- [ ] **Step 5: Commit**

```bash
git add src/App.css src/App.tsx
git commit -m "feat: smooth sort bar collapse/expand animation"
```

---

## Task 6: Sidebar Sliding Active Indicator

**Files:**
- Modify: `src/components/Sidebar.tsx` (~lines 76-98)
- Modify: `src/App.css` — `.nav-btn.active` (~line 178), new `.sidebar-indicator` styles

- [ ] **Step 1: Add sidebar indicator CSS**

Remove the `box-shadow: inset 3px 0 0 var(--accent);` from `.nav-btn.active` (line 182). Add `position: relative;` to the existing `.nav` rule (~line 140). Then add:

```css
.sidebar-indicator {
  position: absolute;
  left: 0;
  width: 3px;
  background: var(--accent);
  border-radius: 0 2px 2px 0;
  transition: transform 200ms ease, height 200ms ease;
  pointer-events: none;
}
```

- [ ] **Step 2: Add the indicator element in Sidebar.tsx**

Add a ref for the indicator and compute its position from the active nav item. In `Sidebar.tsx`:

```tsx
const navRef = useRef<HTMLDivElement>(null);
const indicatorRef = useRef<HTMLDivElement>(null);

useEffect(() => {
  if (!navRef.current || !indicatorRef.current) return;
  const activeBtn = navRef.current.querySelector(".nav-btn.active") as HTMLElement | null;
  if (activeBtn) {
    indicatorRef.current.style.transform = `translateY(${activeBtn.offsetTop}px)`;
    indicatorRef.current.style.height = `${activeBtn.offsetHeight}px`;
  }
}, [view, selectedArtist, selectedAlbum]);
```

The nav buttons are rendered inside an existing `<nav className="nav">` element (line 88 of Sidebar.tsx). Add `ref={navRef}` to this existing `<nav>` element and insert the indicator as its first child:

```tsx
<nav className="nav" ref={navRef}>
  <div className="sidebar-indicator" ref={indicatorRef} />
  {navItems.map((item) => (
    ...existing button rendering...
  ))}
</nav>
```

Note: The `navRef` type should be `useRef<HTMLElement>(null)` since it references a `<nav>` element. Plugin nav items are also inside this `<nav>` and will be correctly handled since the indicator positions based on `.nav-btn.active` regardless of which button is active.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Visually verify**

Run: `npm run tauri dev`
Test: Click through sidebar items (Tracks, Artists, Albums, etc.) → accent bar should smoothly slide vertically between items.

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx src/App.css
git commit -m "feat: add sliding sidebar active indicator"
```

---

## Task 7: Playing Indicator (Equalizer Bars)

**Files:**
- Modify: `src/components/TrackList.tsx` (~lines 99-121 props, 369-373 track number column)
- Modify: `src/App.tsx` — pass `playing` prop to TrackList (~lines 2543, 3032)
- Modify: `src/App.css` — add equalizer bar styles

- [ ] **Step 1: Add equalizer bar CSS**

Add in the `/* === Animations === */` section:

```css
.eq-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
  width: 14px;
}

.eq-bars .eq-bar {
  width: 3px;
  background: var(--accent);
  border-radius: 1px;
}

.eq-bars .eq-bar:nth-child(1) { animation: eq-bar-1 0.8s ease-in-out infinite; }
.eq-bars .eq-bar:nth-child(2) { animation: eq-bar-2 0.6s ease-in-out infinite; }
.eq-bars .eq-bar:nth-child(3) { animation: eq-bar-3 0.7s ease-in-out infinite; }

.eq-bars.paused .eq-bar {
  animation-play-state: paused;
}
```

- [ ] **Step 2: Add `playing` prop to TrackList**

In `TrackList.tsx`, add to the `TrackListProps` interface (~line 99):

```tsx
playing?: boolean;
```

Destructure it from props in the component function (~line 125):

```tsx
playing,
```

- [ ] **Step 3: Replace track number with equalizer bars for the playing track**

In the `renderCell` function, update the `"num"` case (~line 369):

```tsx
case "num": {
  const isCurrentTrack = currentTrack?.id === t.id;
  if (isCurrentTrack && playing != null) {
    return (
      <span key="num" className="col-num">
        <span className={`eq-bars${playing ? "" : " paused"}`}>
          <span className="eq-bar" />
          <span className="eq-bar" />
          <span className="eq-bar" />
        </span>
      </span>
    );
  }
  return (
    <span key="num" className="col-num">
      {isVideoTrack(t) ? "\uD83C\uDFAC" : (t.track_number || i + 1)}
    </span>
  );
}
```

- [ ] **Step 4: Pass `playing` from App.tsx to all TrackList instances**

Add `playing={playback.playing}` to all 4 `<TrackList` instances in App.tsx:
- Line 2529 — artist detail track list
- Line 3018 — all tracks view
- Line 3135 — album detail track list
- Line 3202 — liked tracks view

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Visually verify**

Run: `npm run tauri dev`
Test: Play a track → in the track list, the track number should be replaced by animated equalizer bars. Pause → bars freeze. Play again → bars resume.

- [ ] **Step 7: Commit**

```bash
git add src/App.css src/components/TrackList.tsx src/App.tsx
git commit -m "feat: add animated equalizer bars for playing track indicator"
```

---

## Task 8: Album Art Glow in Now Playing Bar

**Files:**
- Modify: `src/components/NowPlayingBar.tsx` (~line 186)
- Modify: `src/App.css` — `.now-art` styles (~line 2856)

- [ ] **Step 1: Add glow CSS**

Find `.now-art` around line 2856. Add a wrapper class and the pseudo-element glow:

```css
.now-art-wrapper {
  position: relative;
  flex-shrink: 0;
}

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
  transition: opacity 0.5s ease;
}

.now-art-wrapper.playing::before {
  animation: glow-pulse 3s ease-in-out infinite;
}
```

- [ ] **Step 2: Wrap album art in NowPlayingBar.tsx**

In `NowPlayingBar.tsx`, find the album art rendering (~line 186):

```tsx
{imagePath && <img className="now-art" src={convertFileSrc(imagePath)} alt="" />}
```

Wrap it (only in the full-mode branch, NOT mini mode):

```tsx
<div className={`now-art-wrapper${playing ? " playing" : ""}`}>
  {imagePath && <img className="now-art" src={convertFileSrc(imagePath)} alt="" />}
</div>
```

Make sure this wrapper is NOT added in the mini mode branch (lines 91-155).

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Visually verify**

Run: `npm run tauri dev`
Test: Play a track with album art → accent-colored glow should pulse gently behind the art. Pause → glow dims and holds. Different skins should produce different glow colors.

- [ ] **Step 5: Commit**

```bash
git add src/App.css src/components/NowPlayingBar.tsx
git commit -m "feat: add pulsing accent glow behind album art in now playing bar"
```

---

## Task 9: Track Info Slide on Change

**Files:**
- Modify: `src/components/NowPlayingBar.tsx` (~lines 188-205)
- Modify: `src/App.css` — add slide-text animation classes

- [ ] **Step 1: Add slide-text CSS**

Add in the `/* === Animations === */` section:

```css
.slide-text-container {
  position: relative;
  overflow: hidden;
}

.slide-text-enter {
  animation: slide-text-in 250ms ease-out forwards;
}

@keyframes slide-text-in {
  from { transform: translateY(60%); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
```

Note: We only animate the entrance of new text (slide in from below). A full enter/exit requires keeping both old and new text in the DOM simultaneously, which adds complexity. The single-direction slide-in is simpler and still feels polished — the new text replaces the old with a quick upward slide.

- [ ] **Step 2: Create SlideText wrapper inline in NowPlayingBar.tsx**

First, update the import at the top of `NowPlayingBar.tsx` to include `useState` and `useEffect` (currently only `useRef` is imported from React):

```tsx
import { useRef, useState, useEffect } from "react";
```

Then add `SlideText` above the main component function:

```tsx
function SlideText({ text, className }: { text: string; className?: string }) {
  const [key, setKey] = useState(0);
  const prevRef = useRef(text);

  useEffect(() => {
    if (text !== prevRef.current) {
      prevRef.current = text;
      setKey(k => k + 1);
    }
  }, [text]);

  return (
    <span key={key} className={`${className ?? ""} slide-text-enter`}>
      {text}
    </span>
  );
}
```

- [ ] **Step 3: Wrap track title and artist text with SlideText**

In the full-mode rendering (~lines 188-205), replace the static title/artist spans. Find:

```tsx
<span className={`now-title${currentTrack.album_id ? " now-link" : ""}`}>
  {currentTrack.title}
  ...
</span>
```

The title has additional content (rank badge, click handler). To keep it simple, wrap only the text node:

```tsx
<span className={`now-title${currentTrack.album_id ? " now-link" : ""}`} ...>
  <SlideText text={currentTrack.title} />
  {trackRank != null && trackRank <= 100 && <span className="now-rank-badge">#{trackRank}</span>}
</span>
```

Do the same for the artist/album subtitle line. Find the artist span and wrap its text:

```tsx
<SlideText text={currentTrack.artist_name || "Unknown"} />
```

Do NOT apply SlideText in mini mode.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Visually verify**

Run: `npm run tauri dev`
Test: Play a track, then skip to next → title and artist text should slide in from below. Going back should also animate.

- [ ] **Step 6: Commit**

```bash
git add src/App.css src/components/NowPlayingBar.tsx
git commit -m "feat: add slide-in animation for track info on track change"
```

---

## Task 10: Waveform Canvas Grow-in Animation

**Files:**
- Modify: `src/components/WaveformSeekBar.tsx` (~lines 14-55)

- [ ] **Step 1: Add grow-in animation state**

In `WaveformSeekBar.tsx`, add state to track the animation progress. Add near the top of the component:

```tsx
const growRef = useRef(0); // 0 to 1
const growStartRef = useRef(0);
const prevPeaksRef = useRef<number[]>([]);
const GROW_DURATION = 400;
const STAGGER_PER_BAR = 2; // ms
```

- [ ] **Step 2: Detect peak data change and trigger grow animation**

Add an effect that resets and starts the grow animation when peaks change. Use `peaks.length` as the dependency (not the array reference, which may be a new array each render):

```tsx
useEffect(() => {
  if (peaks.length > 0) {
    prevPeaksRef.current = peaks;
    growRef.current = 0;
    growStartRef.current = performance.now();
  }
}, [peaks.length]);
```

- [ ] **Step 3: Modify the draw function to apply grow factor**

In the existing `draw` callback, inside the bar-drawing loop (~line 33), compute a per-bar progress based on elapsed time and stagger:

```tsx
const elapsed = performance.now() - growStartRef.current;

// Inside the for loop, before computing barH:
const barProgress = Math.min(1, Math.max(0, (elapsed - i * STAGGER_PER_BAR) / GROW_DURATION));
const eased = barProgress < 1 ? 1 - Math.pow(1 - barProgress, 3) : 1; // ease-out cubic
const barH = Math.max(minBarHeight, peaks[i] * maxBarHeight * eased);
```

After the loop, if any bar hasn't reached full progress, request another frame:

```tsx
const allDone = elapsed >= GROW_DURATION + peaks.length * STAGGER_PER_BAR;
if (!allDone) {
  frameRef.current = requestAnimationFrame(draw);
}
```

Update `growRef.current = allDone ? 1 : elapsed / GROW_DURATION;` so subsequent redraws (from progress changes) use full height once the animation is done.

When `growRef.current >= 1`, skip the elapsed/stagger calculation and use `eased = 1` for all bars (no overhead after animation completes).

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Visually verify**

Run: `npm run tauri dev`
Test: Play a local audio track → waveform bars should grow upward with a left-to-right stagger. Skip to another track → new waveform grows in again.

- [ ] **Step 6: Commit**

```bash
git add src/components/WaveformSeekBar.tsx
git commit -m "feat: add waveform grow-in animation with stagger on peak data load"
```
