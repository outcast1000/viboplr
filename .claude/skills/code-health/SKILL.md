---
name: code-health
description: Use when the user wants to audit the frontend (React/TS) and backend (Rust) for performance issues, convention violations, code reuse opportunities, duplication, and dead code. Triggers on "code health", "code review", "audit code", "find dead code", "find duplication", "perf review", "check conventions", "optimize", or "/code-health". Reports findings only — does NOT apply fixes unless explicitly asked in a follow-up.
---

# Code Health Review

On-demand audit of frontend and backend code for convention compliance, performance issues, code reuse / duplication, and dead code. **Reports findings only** — surfaces a prioritized list of issues with file:line references and concrete suggestions. The user decides what to fix.

This skill complements (does not replace) `css-review` (skin compliance) and `architect` (feature design). It focuses on cross-cutting code quality, not styling or new-feature planning.

## Scope

- **Frontend:** `src/**/*.{ts,tsx}` — React components, hooks, utilities
- **Backend:** `src-tauri/src/**/*.rs` — Tauri commands, DB layer, background tasks
- **Plugins:** `src-tauri/plugins/**/*.{js,json}` — plugin code when relevant to a finding

## Mandatory Pre-Scan Reading

Before scanning, build a model of the project's canonical patterns. **Do not skip this** — findings without grounding in these files are noise.

1. **`.claude/rules/conventions.md`** — canonical actions (Delete Tracks, Find in YouTube, Like/Unlike, Play/Enqueue, etc.) and behavioral rules (error logging, user feedback, skin compatibility, plugin-first)
2. **`.claude/rules/frontend.md`** — hook responsibilities, state persistence, keyboard shortcuts
3. **`.claude/rules/backend.md`** — file responsibilities, DB patterns, background task patterns
4. **`.claude/rules/plugins.md`** — plugin API surface, information types
5. **`.claude/rules/ui.md`** — entity system, context menu wiring, design system classes
6. **`src/hooks/useContextMenuActions.ts`, `src/hooks/useLikeActions.ts`, `src/hooks/useQueue.ts`, `src/hooks/useDownloads.ts`** — the canonical action implementations referenced by `conventions.md`

## Review Dimensions

Run all six passes. Collect findings into a single prioritized report at the end.

---

### Pass 1 — Canonical Action Violations

For each canonical action in `conventions.md`, find callers that reimplement the flow instead of routing through the canonical hook.

**How to detect:**
- **Delete Tracks:** Grep for `invoke("delete_tracks"` outside `useContextMenuActions.ts`. Flag each.
- **Find in YouTube:** Grep for `invoke("search_youtube"` or direct `youtube.com/results` URL construction outside `useContextMenuActions.ts`. Verify callers go through `watchOnYoutube`.
- **Like/Unlike:** Grep for `invoke("toggle_liked"` outside `useLikeActions.ts`. Flag each.
- **Play / Enqueue / Play Next:** Grep for direct queue mutation (`setQueue(`, `queue.push`) outside `useQueue.ts` and `usePlayback.ts`. Flag surfaces that bypass `playTracks` / `enqueueTracks` / `playNextInQueue`.
- **Show in Folder:** Grep for `invoke("show_in_folder"` outside `useContextMenuActions.ts`.
- **Download Track:** Grep for `invoke("download_track"` outside `useDownloads.ts`.
- **Record Play / Scrobble:** Grep for `invoke("record_play"` outside `usePlayback.ts` / `App.tsx`. Grep for duplicated scrobble-threshold logic (look for `>= 240` or `0.5 * duration` patterns).
- **Tag Operations:** Grep for `invoke("plugin_apply_tags"` or `invoke("replace_track_tags"` outside `TrackDetailView.tsx` / related tag entry points.

**Report format:** `file:line — <action> reimplemented; route through <canonical hook/function>`

---

### Pass 2 — Behavioral Rule Violations

**Error logging** (from `conventions.md`):
- Grep for `.catch(() => {})` and `.catch(()=>{})` — every match is a violation unless preceded by a comment explaining why.
- Grep for `} catch {` (silent catch, no binding) — flag.
- Grep for `} catch (e) {` blocks with no `console.error` inside — read each to confirm.
- Grep for `.catch(` without `console.error` in the handler.

**Skin compatibility** (from `conventions.md`):
- Grep TSX files for inline `style=` with color literals. Report via pointer to `/css-review` rather than duplicating its work.

**Plugin-first** (from `conventions.md`):
- Flag new information-section-like code added directly in components rather than as a plugin. Heuristic: look in `src/components/` for hardcoded sections fetching external data (look for `fetch(` calls to external domains inside React components). Genuine plugin APIs live in `src-tauri/plugins/`.

**Context menu wiring** (from `ui.md`):
- Any component rendering track/album/artist rows must pass `pluginMenuItems` and `onPluginAction` to `ContextMenu`. Grep for `<ContextMenu` usages; flag those missing these props.

**Report format:** `file:line — <rule> — <what's wrong>`

---

### Pass 3 — Code Reuse Opportunities

Find duplicated logic that should consolidate into a shared hook/util/module.

**Frontend heuristics:**
- Grep for repeated `invoke(` patterns with similar argument shapes across >2 files — candidates for a shared hook.
- Duplicate entity-key construction: look for patterns like `` `artist:${name}` ``, `` `album:${artist}:${name}` ``, `` `track:${artist}:${name}` `` — should live in one util.
- Duplicate time formatting / duration formatting — `utils.ts` has `formatDuration`; flag reimplementations.
- Duplicate URL-scheme parsing (`file://`, `subsonic://`, `tidal://`) — should live in `queueEntry.ts` helpers.
- Duplicate "is this a local track" checks (`track.path.startsWith("file://")`) scattered across components.
- Repeated `addLog(`...`)` error-handling patterns that could be wrapped.

**Backend heuristics:**
- Repeated SQL-building string concatenation across commands that could share a query builder.
- Duplicate Last.fm / Subsonic / TIDAL request signing code.
- Repeated `State<'_, AppState>` unwrap + `db.lock()` patterns that could collapse into helpers.
- Duplicate filename-parsing regex patterns (scanner.rs has 4 canonical ones — flag any parallel implementations).

**Report format:** `<pattern> — seen at file1:line, file2:line, file3:line — consolidate into <suggested location>`

---

### Pass 4 — Performance Issues

**Frontend:**
- Large list components (`TrackList`, `QueuePanel`, `HistoryView`, `AlbumListView`, `ArtistListView`) rendering without virtualization when list size is unbounded. Check if list length is user-controlled (library can have 100k+ tracks).
- Missing `React.memo` on row components inside long lists — check if parent re-renders propagate.
- Missing `useMemo` / `useCallback` for values passed into memoized children or into `useEffect` dep arrays (look for inline object/array/function literals as props or effect deps).
- `useEffect` with missing deps that would cause stale closures, OR with object/array deps declared inline (recreates every render).
- Grep for `.filter(...).map(...).filter(...)` chains on large arrays in render bodies — candidates for pre-computation.
- Grep for `invoke(` calls inside render bodies (not in `useEffect`) — indicates wasted fetches per render.
- Grep for `IntersectionObserver` duplication — image-card components should share.
- Check `useImageCache` dedup guards — multiple callers racing on the same key.
- Search inputs without debounce: grep for `onChange` handlers on search inputs that fire `invoke` or `setState` with search-heavy computation directly.

**Backend:**
- N+1 queries: Grep `db.rs` and `commands.rs` for patterns where a loop calls a per-row SQL query. Candidates: anywhere `for` loops iterate ids and issue `get_*_by_id` inside.
- Missing indexes: cross-check common WHERE clauses in `db.rs` against schema. Flag WHERE clauses on non-indexed columns when the table has >1k rows at runtime.
- Holding `db.lock()` across await/IO: grep for `let conn = db.lock()` followed by `.await` or HTTP calls in the same scope — holds the mutex during network I/O.
- `thread::spawn` without cancellation `AtomicBool` — `backend.md` requires this for long tasks.
- Background tasks emitting events without throttling on tight loops (look for `app.emit(` inside `for` loops without rate limiting).
- Unbounded channels / unbounded growth (e.g., `Vec::new()` that appends per-file and never drains in a scanner).
- String allocations in hot loops: `format!` inside tight parsing loops.

**Report format:** `file:line — <issue> — <suggested fix>`

---

### Pass 5 — Dead Code

**Frontend:**
- Unused exports: for each `export function`, `export const`, `export class` in `src/**/*.{ts,tsx}`, grep for imports. Zero imports = candidate (excluding entry points like `main.tsx`, `App.tsx`).
- Unused types in `types.ts` / `types/*.ts`.
- Unused hooks in `src/hooks/`.
- Dead branches: `if (false)`, unreachable code after early returns, commented-out blocks >3 lines.
- Reference `css-review` for dead CSS classes; do not duplicate.

**Backend:**
- `cargo check` already catches most unused items, but run `cargo check --message-format=short 2>&1 | grep "never used\|never read\|dead_code"` and surface findings.
- Unused Tauri commands: for each `#[tauri::command] fn foo`, grep TypeScript for `invoke("foo"` — zero hits = candidate. Exclude commands gated behind `#[cfg(debug_assertions)]` if user is in release-only mode.
- Unused DB functions in `db.rs`: grep `commands.rs` and the rest of the crate for the function name.
- Unused model structs / fields in `models.rs`.

**Plugins:**
- Unused plugins: for each dir in `src-tauri/plugins/`, check if its `id` appears in any active manifest references or is reachable via plugin discovery. Plugins are user-installable — flag only if clearly orphaned (e.g., no manifest or manifest missing required fields).

**Report format:** `file:line — <symbol> — no external references found`

---

### Pass 6 — Misc Smells

- `console.log` / `console.debug` left in production paths (allowed in dev helpers, but flag in committed components).
- `TODO` / `FIXME` / `HACK` / `XXX` comments — list with file:line for user awareness.
- Magic numbers that should be named constants (thresholds like scrobble time, rate limits) — check against the values already declared in `backend.md` / `frontend.md` (e.g., 1100ms image rate limit, 50%/4min scrobble threshold).
- Large components (>500 lines) in `src/components/` — candidates for extraction.
- Large Rust files (>800 lines) — candidates for splitting.
- Tests colocated where they shouldn't be (per `testing.md`: frontend tests in `src/__tests__/`, Rust tests in `#[cfg(test)] mod tests`).

---

## Running the Scan

Use Grep and Read tools. For large greps, batch multiple patterns in parallel. Keep each grep narrow (specific pattern + path filter) to avoid output overflow.

**Prefer `rg` via Bash** when scanning for multiple patterns with file-count aggregation:
```bash
rg -n "invoke\(\"toggle_liked\"" src/ --type ts --type tsx
```

**For cargo-based dead code:**
```bash
cd src-tauri && cargo check --message-format=short 2>&1 | grep -E "warning: (unused|dead|never)"
```

Do NOT run `cargo fix` or edit anything during scanning.

## Report Format

Produce a single markdown report with these sections, in this order:

```
Code Health Report
══════════════════
Files scanned: N frontend + N backend + N plugin
Findings: N total (H high / M medium / L low)

─── High Priority ───
1. [Canonical Action] file:line — <issue> — <fix>
2. [Performance]      file:line — <issue> — <fix>
...

─── Medium Priority ───
...

─── Low Priority ───
...

─── Summary by Dimension ───
Canonical Actions:   N findings
Behavioral Rules:    N findings
Code Reuse:          N findings
Performance:         N findings
Dead Code:           N findings
Misc:                N findings
```

**Priority rubric:**
- **High:** Canonical action violations, silent error handling in user-facing paths, performance issues affecting main-thread responsiveness (render-time invokes, unbounded lists, mutex-across-await).
- **Medium:** Code reuse opportunities with 3+ duplicates, missing memoization with measurable render cost, dead code in public-facing modules, missing context menu wiring.
- **Low:** TODOs, magic numbers, file-size smells, single-instance duplications, dead code in internal utilities.

## After the Report

Ask the user how to proceed:
- **Fix highest priority** — apply the top N findings with edits
- **Fix by dimension** — pick a pass (e.g., "fix all canonical action violations")
- **Fix by file** — walk through one file at a time
- **Report only** — use as reference, no edits

Do NOT start editing until the user picks an option.

## What This Skill Does NOT Do

- **Skin / CSS compliance** — delegate to `/css-review`.
- **New feature design** — delegate to `/architect`.
- **Release / version bumps** — delegate to `/release`.
- **Running benchmarks** — delegate to `/db-bench`.
- **Interactive refactors** — this is a review pass, not a pair-programming session.
- **Autofixing** — always produce the report first; only edit when explicitly asked.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Skipping the pre-scan reading | Findings without grounding are low-signal noise. Read the rule files first. |
| Flagging `SPEC.md`-documented exceptions as violations | Re-read `conventions.md`; some patterns have documented exceptions (e.g., fire-and-forget catches with comment). |
| Listing every `TODO` as high priority | TODOs are Low unless the comment itself says "critical" or marks a bug. |
| Editing during the scan | Never. Report first, edit only after user approval. |
| Duplicating `/css-review` findings | Point to `/css-review` instead. |
| Running Rust dead-code checks without reading `#[cfg(debug_assertions)]` gating | Debug-only commands are not "dead." |
| Treating unused plugin files as dead | Plugins are user-visible; only flag if manifest is clearly orphaned. |
