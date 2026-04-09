# Lyrics Plugin Migration Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate lyrics from a dedicated Rust-based system (table, provider module, commands) into the existing information types plugin system as a built-in JS plugin.

**Architecture:** Remove the `lyrics` table, `lyric_provider/` Rust module, 5 lyrics commands, and all frontend code that fetches/displays lyrics via the old system. Create a `lrclib` JS plugin that provides lyrics as an information type. Upgrade `LyricsRenderer` with synced-lyrics support (auto-scroll, line highlighting, editing). Thread `positionSecs` from playback into the renderer via a new `context` field on `RendererProps`.

**Tech Stack:** Rust/SQLite (backend), React/TypeScript (frontend), JavaScript (plugin)

**Spec:** `docs/superpowers/specs/2026-04-09-lyrics-plugin-migration-design.md`

---

## File Map

### Files to Delete
- `src-tauri/src/lyric_provider/mod.rs` — Rust lyric provider trait + fallback chain
- `src-tauri/src/lyric_provider/lrclib.rs` — Rust LRCLIB provider
- `src/components/LyricsPanel.tsx` — Dedicated lyrics component (synced scroll, editing)
- `src/components/LyricsPanel.css` — LyricsPanel styles

### Files to Create
- `src-tauri/plugins/lrclib/manifest.json` — Plugin manifest declaring `lyrics` info type
- `src-tauri/plugins/lrclib/index.js` — Plugin fetching lyrics from LRCLIB API

### Files to Modify
- `src-tauri/src/db.rs` — Drop lyrics table, remove lyrics_text from FTS, remove lyrics methods, add migration v21
- `src-tauri/src/commands.rs` — Remove 5 lyrics commands
- `src-tauri/src/lib.rs` — Remove `mod lyric_provider`, lyrics command registrations, lyric_provider/lyrics_fetching_track_id from AppState
- `src-tauri/src/models.rs` — Remove `Lyrics`, `LyricsLoaded`, `LyricsError` structs, `include_lyrics` from TrackQuery
- `src/components/renderers/LyricsRenderer.tsx` — Full rewrite with synced lyrics, editing, auto-scroll
- `src/components/renderers/index.ts` — Add `context` to `RendererProps`
- `src/components/renderers/renderers.css` — Replace `.renderer-lyrics .lyrics-plain` with synced lyrics styles
- `src/components/InformationSections.tsx` — Add `positionSecs` prop, thread `context` to renderers, handle `onAction("save-lyrics")`
- `src/components/TrackDetailView.tsx` — Remove lyrics state/fetch/handlers/listeners, remove LyricsPanel import, remove lyrics customTab, pass positionSecs to InformationSections
- `src/components/NowPlayingView.tsx` — Remove lyrics props, LyricsPanel import, hasLyrics layout logic
- `src/hooks/useLibrary.ts` — Remove `searchIncludeLyrics` state, persistence, and query field
- `src/components/AllTracksView.tsx` — Remove `searchIncludeLyrics` prop and lyrics toggle button
- `src/components/LikedTracksView.tsx` — Remove `searchIncludeLyrics` prop and lyrics toggle button
- `src/components/ViewSearchBar.css` — Remove `.search-lyrics-toggle` styles
- `src/App.tsx` — Remove lyrics restore logic and lyrics props passed to views

---

## Task 1: Backend — Migration v21 and lyrics table/FTS cleanup

**Files:**
- Modify: `src-tauri/src/db.rs:283-299` (init_tables lyrics table + tracks_fts)
- Modify: `src-tauri/src/db.rs:526-537` (migration v12 — lyrics table creation)
- Modify: `src-tauri/src/db.rs:688-696` (add migration v21 after v20)
- Modify: `src-tauri/src/db.rs:694-697` (FTS rebuild trigger)
- Modify: `src-tauri/src/db.rs:972-1001` (rebuild_fts — remove lyrics join)
- Modify: `src-tauri/src/db.rs:1091-1099` (search_tracks_inner — remove include_lyrics branch)
- Modify: `src-tauri/src/db.rs:1234-1239` (search_all — remove include_lyrics from TrackQuery)

- [ ] **Step 1: Add migration v21 to drop lyrics table and rebuild FTS**

In `db.rs`, after the `version < 20` migration block (line 692), add:

```rust
        if version < 21 {
            conn.execute_batch(
                "DROP TABLE IF EXISTS lyrics;"
            )?;
            conn.execute("UPDATE db_version SET version = 21 WHERE rowid = 1", [])?;
            migrated = true;
        }
```

- [ ] **Step 2: Update FTS rebuild trigger to include v21**

Change the FTS rebuild condition at line 695 from:

```rust
        if version < 12 || version < 16 {
```

To:

```rust
        if version < 12 || version < 16 || version < 21 {
```

- [ ] **Step 3: Remove lyrics table from init_tables**

In `init_tables`, remove lines 283-289 (the `CREATE TABLE IF NOT EXISTS lyrics` block).

- [ ] **Step 4: Remove lyrics_text from tracks_fts in init_tables**

Change the tracks_fts creation (lines 291-299) from:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title,
    artist_name,
    album_title,
    tag_names,
    lyrics_text,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
```

To:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
    title,
    artist_name,
    album_title,
    tag_names,
    content='',
    tokenize='unicode61 remove_diacritics 2'
);
```

- [ ] **Step 5: Update rebuild_fts to remove lyrics join and column**

Change `rebuild_fts` (lines 972-1001). The recreated FTS table should NOT have `lyrics_text`. The INSERT should NOT JOIN lyrics or select lyrics text:

```rust
    pub fn rebuild_fts(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        conn.execute_batch(
            &format!(
                "INSERT INTO tracks_fts (rowid, title, artist_name, album_title, tag_names)
                 SELECT t.id, strip_diacritics(t.title), strip_diacritics(COALESCE(ar.name, '')), strip_diacritics(COALESCE(al.title, '')),
                        strip_diacritics(COALESCE((SELECT GROUP_CONCAT(tg.name, ' ') FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tt.track_id = t.id), ''))
                 FROM tracks t
                 LEFT JOIN artists ar ON t.artist_id = ar.id
                 LEFT JOIN albums al ON t.album_id = al.id
                 WHERE 1=1 {};",
                ENABLED_COLLECTION_FILTER
            ),
        )?;
        Ok(())
    }
```

- [ ] **Step 6: Remove include_lyrics FTS column filter logic**

In `search_tracks_inner` (lines 1091-1099), replace the include_lyrics branching with just the column-restricted query (since lyrics_text no longer exists):

```rust
        let fts_query = if has_fts_words {
            format!("{{title artist_name album_title tag_names}}:{}", words)
        } else {
            String::new()
        };
```

- [ ] **Step 7: Remove include_lyrics from search_all**

In `search_all` (lines 1234-1239), change:

```rust
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            include_lyrics: true,
            ..Default::default()
        };
```

To:

```rust
        let track_opts = TrackQuery {
            limit: Some(track_limit),
            ..Default::default()
        };
```

- [ ] **Step 8: Update clear_database to remove lyrics references**

In `clear_database` (lines 945-970), remove `DELETE FROM lyrics;` (line 949) and remove `lyrics_text` from the recreated FTS table (line 964). The updated method:

```rust
    pub fn clear_database(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "DELETE FROM track_tags;
             DELETE FROM tracks;
             DELETE FROM albums;
             DELETE FROM artists;
             DELETE FROM tags;
             DELETE FROM history_plays;
             DELETE FROM history_tracks;
             DELETE FROM history_artists;
             DELETE FROM collections;
             DROP TABLE IF EXISTS tracks_fts;
             CREATE VIRTUAL TABLE tracks_fts USING fts5(
                 title,
                 artist_name,
                 album_title,
                 tag_names,
                 content='',
                 tokenize='unicode61 remove_diacritics 2'
             );"
        )?;
        Ok(())
    }
```

- [ ] **Step 9: Remove all lyrics DB methods**

Delete these methods from `db.rs`:
- `strip_lrc_timestamps` (lines 14-21)
- `get_lyrics` (lines 1835-1854)
- `save_lyrics` (lines 1856-1874)
- `delete_lyrics` (lines 1876-1880)
- `update_fts_for_track` (lines 1883-1921)
- `check_lyrics_match` (lines 1924-1952)

- [ ] **Step 10: Remove lyrics test functions**

Delete all 7 lyrics-related test functions from the `#[cfg(test)]` module (lines 3342-3449):
- `test_lyrics_table_exists`
- `test_save_and_get_lyrics`
- `test_save_lyrics_upsert`
- `test_delete_lyrics`
- `test_lyrics_cascade_on_track_delete`
- `test_strip_lrc_timestamps`
- `test_lyrics_in_fts_search`

- [ ] **Step 11: Verify Rust compilation**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2/src-tauri && cargo check`

This will fail because commands.rs and models.rs still reference deleted types — that's expected, we fix those in Task 2.

---

## Task 2: Backend — Remove lyrics commands, models, and lyric_provider module

**Files:**
- Modify: `src-tauri/src/models.rs:2,15-16,102-123`
- Modify: `src-tauri/src/commands.rs:2475-2593` (5 lyrics commands)
- Modify: `src-tauri/src/lib.rs:19,145-149,267-271,863-880`
- Delete: `src-tauri/src/lyric_provider/mod.rs`
- Delete: `src-tauri/src/lyric_provider/lrclib.rs`

- [ ] **Step 1: Remove lyrics structs from models.rs**

Delete `Lyrics` (lines 102-109), `LyricsLoaded` (lines 111-117), `LyricsError` (lines 119-123).

Remove `include_lyrics` field from `TrackQuery` (line 16) and the `default_true` function (line 2) if nothing else uses it:

```rust
    #[serde(default = "default_true")]
    pub include_lyrics: bool,
```

Check if `default_true` is used elsewhere. If not, delete line 2 as well.

- [ ] **Step 2: Remove 5 lyrics commands from commands.rs**

Delete these command functions from `commands.rs`:
- `get_lyrics` (lines 2475-2478)
- `fetch_lyrics` (lines 2480-2571)
- `save_manual_lyrics` (lines 2573-2579)
- `reset_lyrics` (lines 2581-2588)
- `check_lyrics_match` (lines 2590-2593)

Also remove the `lyric_provider` field and `lyrics_fetching_track_id` field from `AppState` (lines 47-48):

```rust
    pub lyric_provider: Arc<dyn crate::lyric_provider::LyricProvider>,
    pub lyrics_fetching_track_id: Arc<AtomicI64>,  // 0 = idle
```

And remove the `AtomicI64` import if no longer used.

Update the `test_state()` helper in the `#[cfg(test)]` module of `commands.rs` (lines 2278-2294) — remove the `lyric_provider` and `lyrics_fetching_track_id` fields from the `AppState` construction (lines 2292-2293).

- [ ] **Step 3: Remove lyric_provider module and lib.rs references**

Delete the entire `src-tauri/src/lyric_provider/` directory.

In `lib.rs`:
- Remove `mod lyric_provider;` (line 19)
- Remove the 5 lyrics commands from both handler registration lists (debug: lines 145-149, release: lines 267-271)
- Remove lyric_provider initialization and AppState fields (lines 863-880). Change from:

```rust
                let lyric_provider: Arc<dyn lyric_provider::LyricProvider> = Arc::new(
                    lyric_provider::LyricFallbackChain::new(vec![
                        Box::new(lyric_provider::lrclib::LrclibProvider),
                    ]),
                );

                app.manage(AppState {
                    db,
                    app_dir,
                    app_data_dir,
                    profile_name,
                    download_queue,
                    track_download_manager: dl_manager,
                    tidal_client,
                    native_plugins_dir,
                    lyric_provider,
                    lyrics_fetching_track_id: Arc::new(std::sync::atomic::AtomicI64::new(0)),
                });
```

To:

```rust
                app.manage(AppState {
                    db,
                    app_dir,
                    app_data_dir,
                    profile_name,
                    download_queue,
                    track_download_manager: dl_manager,
                    tidal_client,
                    native_plugins_dir,
                });
```

- [ ] **Step 4: Verify Rust compilation**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2/src-tauri && cargo check`
Expected: Clean compilation with no errors.

- [ ] **Step 5: Run Rust tests**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2/src-tauri && cargo test`
Expected: All tests pass. (Any lyrics-related tests will have been removed with the deleted methods.)

- [ ] **Step 6: Verify release build compiles**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2/src-tauri && cargo check --release`
Expected: Clean compilation.

- [ ] **Step 7: Commit backend changes**

```bash
git add -A
git commit -m "refactor: remove lyrics table, commands, and lyric_provider module

Drop lyrics table (migration v21), remove lyrics_text from FTS index,
delete lyric_provider/ Rust module, remove 5 lyrics commands, and clean
up TrackQuery. Lyrics will be provided by the lrclib JS plugin via the
information types system."
```

---

## Task 3: Create lrclib JS plugin

**Files:**
- Create: `src-tauri/plugins/lrclib/manifest.json`
- Create: `src-tauri/plugins/lrclib/index.js`

- [ ] **Step 1: Create manifest.json**

Create `src-tauri/plugins/lrclib/manifest.json`:

```json
{
  "id": "lrclib",
  "name": "LRCLIB",
  "version": "1.0.0",
  "author": "Viboplr",
  "description": "Synced and plain lyrics from LRCLIB",
  "minAppVersion": "0.9.5",
  "contributes": {
    "informationTypes": [
      {
        "id": "lyrics",
        "name": "Lyrics",
        "entity": "track",
        "displayKind": "lyrics",
        "ttl": 7776000,
        "order": 400,
        "priority": 100
      }
    ]
  }
}
```

- [ ] **Step 2: Create index.js**

Create `src-tauri/plugins/lrclib/index.js`:

```javascript
// LRCLIB Plugin for Viboplr
// Provides synced and plain lyrics from lrclib.net

function activate(api) {
  var BASE_URL = "https://lrclib.net/api/get";

  function lrclibFetch(url) {
    return api.network.fetch(url).then(function (resp) {
      if (resp.status === 404) return null;
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.json();
    });
  }

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var url = BASE_URL
      + "?artist_name=" + encodeURIComponent(entity.artistName)
      + "&track_name=" + encodeURIComponent(entity.name);

    return lrclibFetch(url).then(function (data) {
      if (!data) return { status: "not_found" };

      // Prefer synced lyrics, fall back to plain
      var syncedLyrics = data.syncedLyrics;
      var plainLyrics = data.plainLyrics;

      if (syncedLyrics && syncedLyrics.trim()) {
        return {
          status: "ok",
          value: { text: syncedLyrics, kind: "synced" },
        };
      }

      if (plainLyrics && plainLyrics.trim()) {
        return {
          status: "ok",
          value: { text: plainLyrics, kind: "plain" },
        };
      }

      return { status: "not_found" };
    }).catch(function () {
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
```

- [ ] **Step 3: Commit plugin**

```bash
git add src-tauri/plugins/lrclib/manifest.json src-tauri/plugins/lrclib/index.js
git commit -m "feat: add lrclib JS plugin for lyrics via information types"
```

---

## Task 4: Frontend — Extend RendererProps with context, upgrade LyricsRenderer

**Files:**
- Modify: `src/components/renderers/index.ts:17-22`
- Modify: `src/components/renderers/LyricsRenderer.tsx` (full rewrite)
- Modify: `src/components/renderers/renderers.css:67`

- [ ] **Step 1: Add `context` to RendererProps**

In `src/components/renderers/index.ts`, add `context` to the `RendererProps` interface (line 17-22):

```typescript
export interface RendererProps {
  data: unknown;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
  context?: { positionSecs?: number };
}
```

- [ ] **Step 2: Rewrite LyricsRenderer with synced lyrics support**

Replace `src/components/renderers/LyricsRenderer.tsx` entirely:

```typescript
import { useState, useEffect, useRef, useCallback } from "react";
import type { RendererProps } from "./index";
import type { LyricsData } from "../../types/informationTypes";

interface LrcLine {
  time: number;
  text: string;
}

function parseLrc(lrc: string): LrcLine[] {
  const lines: LrcLine[] = [];
  for (const line of lrc.split("\n")) {
    const match = line.match(/^\[(\d{2}):(\d{2})[.:]\d{2,3}\](.*)$/);
    if (match) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      const text = match[3].trim();
      if (text) lines.push({ time: mins * 60 + secs, text });
    }
  }
  return lines;
}

function getCurrentLineIndex(lines: LrcLine[], position: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= position) idx = i;
    else break;
  }
  return idx;
}

export function LyricsRenderer({ data, onAction, context }: RendererProps) {
  const d = data as LyricsData;

  // All hooks MUST be called before any conditional return (React rules of hooks)
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [editKind, setEditKind] = useState<"plain" | "synced">("plain");
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [userScrolled, setUserScrolled] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const activeLineRef = useRef<HTMLDivElement>(null);
  const userScrollTimeout = useRef<number>(0);

  const positionSecs = context?.positionSecs ?? 0;
  const lrcLines = d?.kind === "synced" && d?.text ? parseLrc(d.text) : null;
  const currentLineIdx = lrcLines ? getCurrentLineIndex(lrcLines, positionSecs) : -1;

  useEffect(() => {
    if (syncEnabled && !userScrolled && activeLineRef.current && scrollRef.current) {
      activeLineRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [currentLineIdx, userScrolled, syncEnabled]);

  const handleScroll = useCallback(() => {
    setUserScrolled(true);
    if (userScrollTimeout.current) clearTimeout(userScrollTimeout.current);
    userScrollTimeout.current = window.setTimeout(() => setUserScrolled(false), 5000);
  }, []);

  // Early return AFTER all hooks
  if (!d?.text) return null;

  const startEdit = () => {
    setEditText(d.text);
    setEditKind((d.kind as "plain" | "synced") ?? "plain");
    setEditing(true);
  };

  const handleSave = () => {
    if (onAction) onAction("save-lyrics", { text: editText, kind: editKind });
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="renderer-lyrics">
        <div className="lyrics-actions">
          <select value={editKind} onChange={e => setEditKind(e.target.value as "plain" | "synced")}>
            <option value="plain">Plain</option>
            <option value="synced">Synced (LRC)</option>
          </select>
          <button className="lyrics-action-btn" onClick={handleSave}>Save</button>
          <button className="lyrics-action-btn" onClick={() => setEditing(false)}>Cancel</button>
        </div>
        <textarea
          className="lyrics-editor"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div className="renderer-lyrics">
      <div className="lyrics-actions">
        <span className={`lyrics-badge${d.kind === "synced" ? " lyrics-badge-synced" : ""}`}>
          {d.kind}
        </span>
        {lrcLines && positionSecs > 0 && (
          <button
            className={`lyrics-action-btn${syncEnabled ? " active" : ""}`}
            onClick={() => setSyncEnabled(v => !v)}
            title={syncEnabled ? "Disable synced scroll" : "Enable synced scroll"}
          >&#9201;</button>
        )}
        <button className="lyrics-action-btn" onClick={startEdit} title="Edit lyrics">&#9998;</button>
      </div>
      <div className="lyrics-body" ref={scrollRef} onScroll={handleScroll}>
        {lrcLines ? (
          lrcLines.map((line, i) => (
            <div
              key={i}
              ref={i === currentLineIdx ? activeLineRef : undefined}
              className={`lyrics-line${i === currentLineIdx ? " lyrics-line-active" : ""}`}
            >
              {line.text}
            </div>
          ))
        ) : (
          <div className="lyrics-plain">{d.text}</div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Update lyrics styles in renderers.css**

Replace the single lyrics style line (line 67) with full synced lyrics styles:

```css
.renderer-lyrics { display: flex; flex-direction: column; gap: 4px; }
.lyrics-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.lyrics-badge { font-size: var(--fs-2xs); padding: 1px 6px; border-radius: 8px; background: var(--bg-secondary); opacity: 0.7; }
.lyrics-badge-synced { opacity: 1; color: var(--accent); }
.lyrics-action-btn { background: none; border: 1px solid var(--border-color); color: var(--text-secondary); font-size: var(--fs-xs); padding: 2px 8px; border-radius: 4px; cursor: pointer; }
.lyrics-action-btn:hover { color: var(--text-primary); }
.lyrics-action-btn.active { color: var(--accent); border-color: var(--accent); }
.lyrics-body { max-height: 400px; overflow-y: auto; scroll-behavior: smooth; }
.lyrics-line { padding: 2px 0; font-size: var(--fs-sm); line-height: 1.6; opacity: 0.5; transition: opacity 0.2s, font-weight 0.2s; }
.lyrics-line-active { opacity: 1; font-weight: 600; }
.lyrics-plain { white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.6; }
.lyrics-editor { width: 100%; min-height: 200px; background: var(--bg-secondary); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; font-family: monospace; font-size: var(--fs-sm); resize: vertical; }
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`

This will fail due to frontend files that still reference old lyrics infrastructure — that's expected, fixed in Task 5.

- [ ] **Step 5: Commit renderer changes**

```bash
git add src/components/renderers/index.ts src/components/renderers/LyricsRenderer.tsx src/components/renderers/renderers.css
git commit -m "feat: upgrade LyricsRenderer with synced lyrics, editing, and context support"
```

---

## Task 5: Frontend — Thread positionSecs through InformationSections, handle save-lyrics

**Files:**
- Modify: `src/hooks/useInformationTypes.ts:233` (expose `reloadCache`)
- Modify: `src/components/InformationSections.tsx:16-29,45,98-111`

- [ ] **Step 0: Expose reloadCache from useInformationTypes**

In `src/hooks/useInformationTypes.ts`, change the return statement (line 233) from:

```typescript
  return { sections, refresh };
```

To:

```typescript
  return { sections, refresh, reloadCache: loadSections };
```

This allows InformationSections to reload from cache after a manual lyrics save without triggering a delete+refetch cycle.

- [ ] **Step 1: Add positionSecs prop and thread context to renderers**

In `InformationSections.tsx`:

Add `positionSecs?: number` to `InformationSectionsProps` (after line 27):

```typescript
interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  placement?: InfoPlacement;
  customTabs?: CustomTab[];
  positionSecs?: number;
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
  resolveEntity?: (kind: string, name: string) => { id?: number; imageSrc?: string } | undefined;
}
```

Destructure `positionSecs` in the function signature.

Change the hook destructuring (line 45) from `const { sections } = useInformationTypes(...)` to `const { sections, refresh, reloadCache } = useInformationTypes(...)`.

Add `useCallback` to imports if not present. Add an `invoke` import from `@tauri-apps/api/core`.

Add a wrapped `handleAction` callback that intercepts `save-lyrics`:

```typescript
  const handleAction = useCallback(async (actionId: string, payload?: unknown) => {
    if (actionId === "save-lyrics" && entity) {
      const p = payload as { text: string; kind: string } | undefined;
      if (!p) return;
      // Find the active lyrics section's integer ID from cached values
      const entityKey = buildEntityKey(entity);
      const cached = await invoke<[number, string, string, string, number][]>(
        "info_get_values_for_entity",
        { entityKey },
      );
      const lyricsEntry = cached.find(([, typeId]) => typeId === "lyrics");
      if (lyricsEntry) {
        await invoke("info_upsert_value", {
          informationTypeId: lyricsEntry[0],
          entityKey,
          value: JSON.stringify({ text: p.text, kind: p.kind }),
          status: "ok",
        });
        // Update local section state
        setSections((prev) => {
          const next = [...prev];
          const s = next.find((sec) => sec.typeId === "lyrics");
          if (s) s.state = { kind: "loaded", data: { text: p.text, kind: p.kind }, stale: false };
          return next;
        });
      }
      return;
    }
    if (onAction) onAction(actionId, payload);
  }, [entity, onAction]);
```

**IMPORTANT:** The hook's `refresh(typeId)` function DELETES the cached value then re-fetches from the plugin. Using it after a manual save would overwrite the edit with fresh LRCLIB data. Instead, expose a `patchSection` callback from the hook for local-only state updates, OR use `loadSections` which reads from cache without deleting.

The simplest correct approach: add a `reloadCache` function to `useInformationTypes` that calls `loadSections()` without deleting anything. Then use it here:

First, in `src/hooks/useInformationTypes.ts`, expose `loadSections` by renaming the return:

```typescript
  return { sections, refresh, reloadCache: loadSections };
```

Then in InformationSections:

```typescript
  const { sections, refresh, reloadCache } = useInformationTypes({ entity, exclude, invokeInfoFetch });

  const handleAction = useCallback(async (actionId: string, payload?: unknown) => {
    if (actionId === "save-lyrics" && entity) {
      const p = payload as { text: string; kind: string } | undefined;
      if (!p) return;
      const entityKey = buildEntityKey(entity);
      const cached = await invoke<[number, string, string, string, number][]>(
        "info_get_values_for_entity",
        { entityKey },
      );
      const lyricsEntry = cached.find(([, typeId]) => typeId === "lyrics");
      if (lyricsEntry) {
        await invoke("info_upsert_value", {
          informationTypeId: lyricsEntry[0],
          entityKey,
          value: JSON.stringify({ text: p.text, kind: p.kind }),
          status: "ok",
        });
        // Reload from cache (does NOT delete+refetch like refresh does)
        reloadCache();
      }
      return;
    }
    if (onAction) onAction(actionId, payload);
  }, [entity, onAction, reloadCache]);
```

Pass `context` to the Renderer (line 109). Change:

```typescript
<Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={onAction} resolveEntity={resolveEntity} />
```

To:

```typescript
<Renderer data={s.state.data} onEntityClick={onEntityClick} onAction={handleAction} resolveEntity={resolveEntity} context={positionSecs != null ? { positionSecs } : undefined} />
```

- [ ] **Step 2: Add required imports**

Add to InformationSections.tsx imports:

```typescript
import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildEntityKey } from "../types/informationTypes";
```

(`useState` is already imported; add `useCallback` to the existing import.)

- [ ] **Step 3: Verify the change compiles in isolation**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`

(May still fail due to TrackDetailView / App.tsx — that's OK, we fix those next.)

- [ ] **Step 4: Commit**

```bash
git add src/components/InformationSections.tsx src/hooks/useInformationTypes.ts
git commit -m "feat: thread positionSecs context to renderers, handle save-lyrics action"
```

---

## Task 6: Frontend — Remove lyrics from TrackDetailView

**Files:**
- Modify: `src/components/TrackDetailView.tsx:9,194-195,212-235,271-285,287-304,532-549`

- [ ] **Step 1: Remove LyricsPanel import**

Delete line 9:

```typescript
import LyricsPanel from "./LyricsPanel";
```

- [ ] **Step 2: Remove lyrics state**

Remove `lyrics` and `lyricsLoading` state declarations (lines 194-195):

```typescript
  const [lyrics, setLyrics] = useState<{ text: string; kind: string; provider: string } | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
```

- [ ] **Step 3: Remove lyrics fetch/reset in data loading useEffect**

In the `useEffect` that fires on `trackId` change (starting ~line 212), remove:
- `setLyrics(null);` and `setLyricsLoading(true);` from the reset block
- The entire `invoke("get_lyrics")` / `invoke("fetch_lyrics")` block (lines 226-235)

- [ ] **Step 4: Remove lyrics event listeners**

Delete the entire `useEffect` with `listen("lyrics-loaded")` and `listen("lyrics-error")` (lines 271-285).

- [ ] **Step 5: Remove lyrics handler functions**

Delete:
- `handleSaveLyrics` (lines 287-292)
- `handleResetLyrics` (lines 294-298)
- `handleForceRefreshLyrics` (lines 300-304)

- [ ] **Step 6: Remove lyrics customTab**

In the `customTabs` array passed to `InformationSections` (lines 532-549), remove the entire lyrics tab entry:

```typescript
            {
              id: "lyrics",
              name: "Lyrics",
              content: (
                <LyricsPanel
                  trackId={trackId}
                  artistName={track.artist_name ?? ""}
                  title={track.title}
                  positionSecs={isCurrentTrack ? positionSecs : 0}
                  lyrics={lyrics}
                  loading={lyricsLoading}
                  onSave={handleSaveLyrics}
                  onReset={handleResetLyrics}
                  onForceRefresh={handleForceRefreshLyrics}
                  hideTitle
                />
              ),
            },
```

- [ ] **Step 7: Add right-placement InformationSections for lyrics**

The lyrics displayKind is in `RIGHT_DISPLAY_KINDS` (see `informationTypes.ts` line 180-185), so the existing `placement="below"` InformationSections will filter it out. Add a second `<InformationSections placement="right" .../>` to TrackDetailView, after the `placement="below"` one. This renders lyrics (and other right-placement types) in a side column.

Add right after the closing `/>` of the existing `<InformationSections placement="below" .../>`:

```tsx
        <InformationSections
          placement="right"
          entity={track.artist_name ? { kind: "track", name: track.title, id: trackId, artistName: track.artist_name, albumTitle: track.album_title ?? undefined } : null}
          invokeInfoFetch={invokeInfoFetch}
          positionSecs={isCurrentTrack ? positionSecs : 0}
          onEntityClick={(kind, id) => {
            if (kind === "artist" && id) onArtistClick(id);
            if (kind === "album" && id) onAlbumClick(id);
            if (kind === "tag" && id) onTagClick(id);
          }}
        />
```

Also pass `positionSecs={isCurrentTrack ? positionSecs : 0}` to the existing `placement="below"` InformationSections (for future-proofing, even though lyrics won't appear there).

- [ ] **Step 8: Remove unused `listen` import if no longer needed**

Check if `listen` from `@tauri-apps/api/event` is still used elsewhere in TrackDetailView. If not, remove the import.

- [ ] **Step 9: Commit**

```bash
git add src/components/TrackDetailView.tsx
git commit -m "refactor: remove lyrics state and LyricsPanel from TrackDetailView"
```

---

## Task 7: Frontend — Delete NowPlayingView (dead code)

**Files:**
- Delete: `src/components/NowPlayingView.tsx`

NowPlayingView is not imported or rendered anywhere in App.tsx — it is dead code. Rather than surgically editing its lyrics props, simply delete it.

- [ ] **Step 1: Delete NowPlayingView.tsx**

Delete `src/components/NowPlayingView.tsx`.

Verify it is not imported anywhere:

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && grep -r "NowPlayingView" src/ --include="*.tsx" --include="*.ts"`

Expected: Only the file itself matches (now deleted). If any imports exist, remove them.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "refactor: delete unused NowPlayingView component"
```

---

## Task 8: Frontend — Remove lyrics search toggle and delete LyricsPanel files

**Files:**
- Modify: `src/hooks/useLibrary.ts:83,134,182,243,598`
- Modify: `src/components/AllTracksView.tsx:21,46,63,148-156`
- Modify: `src/components/LikedTracksView.tsx:18,37,51,108-116`
- Modify: `src/components/ViewSearchBar.css:45-63`
- Modify: `src/App.tsx:630,780,1819,1840,1884,1899`
- Delete: `src/components/LyricsPanel.tsx`
- Delete: `src/components/LyricsPanel.css`

- [ ] **Step 1: Remove searchIncludeLyrics from useLibrary.ts**

Remove:
- State declaration (line 83): `const [searchIncludeLyrics, setSearchIncludeLyrics] = useState(true);`
- Persistence effect (line 134): `useEffect(() => { if (restoredRef.current) store.set("searchIncludeLyrics", searchIncludeLyrics); }, [searchIncludeLyrics]);`
- Query field (line 182): `includeLyrics: searchIncludeLyrics,`
- Dependency (line 243): remove `searchIncludeLyrics` from the deps array
- Export (line 598): remove `searchIncludeLyrics, setSearchIncludeLyrics,`

- [ ] **Step 2: Remove searchIncludeLyrics from AllTracksView**

Remove from props interface (lines 21, 46): `searchIncludeLyrics` and `onSetSearchIncludeLyrics`
Remove from destructuring (line 63): `searchIncludeLyrics`
Remove the lyrics toggle button (lines 148-156):

```tsx
        <button
          className={`search-lyrics-toggle${searchIncludeLyrics ? " active" : ""}`}
          onClick={() => onSetSearchIncludeLyrics(v => !v)}
          title={searchIncludeLyrics ? "Lyrics included in search" : "Lyrics excluded from search"}
        >
          Lyrics
        </button>
```

- [ ] **Step 3: Remove searchIncludeLyrics from LikedTracksView**

Same pattern as AllTracksView:
- Remove from props interface (lines 18, 37): `searchIncludeLyrics` and `onSetSearchIncludeLyrics`
- Remove from destructuring (line 51): `searchIncludeLyrics`
- Remove the lyrics toggle button (lines 108-116)

- [ ] **Step 4: Remove lyrics toggle CSS from ViewSearchBar.css**

Remove lines 45-63 (`.search-lyrics-toggle` and its `:hover` and `.active` variants).

- [ ] **Step 5: Remove lyrics references from App.tsx**

- Remove `savedSearchIncludeLyrics` from the `store.get` call (line 630) and the corresponding destructured variable in the Promise.all result
- Remove the lyrics restore logic (line 780): `if (savedSearchIncludeLyrics === false) library.setSearchIncludeLyrics(false);`
- Remove `searchIncludeLyrics` and `onSetSearchIncludeLyrics` props from AllTracksView (lines 1819, 1840)
- Remove `searchIncludeLyrics` and `onSetSearchIncludeLyrics` props from LikedTracksView (lines 1884, 1899)

- [ ] **Step 6: Delete LyricsPanel files**

Delete `src/components/LyricsPanel.tsx` and `src/components/LyricsPanel.css`.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: Clean compilation.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove lyrics search toggle and delete LyricsPanel component"
```

---

## Task 9: Final verification

- [ ] **Step 1: Run all tests**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npm run test:all`
Expected: All tests pass.

- [ ] **Step 2: Verify release build**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2/src-tauri && cargo check --release`
Expected: Clean compilation.

- [ ] **Step 3: Verify TypeScript**

Run: `cd /Users/alex/Code/viboplr/.claude/worktrees/2 && npx tsc --noEmit`
Expected: No errors.
