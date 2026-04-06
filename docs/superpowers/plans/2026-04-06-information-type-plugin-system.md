# Information Type Plugin System — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic information-type system that extends the existing plugin infrastructure, allowing plugins to declare, fetch, cache, and render structured information on entity detail pages.

**Architecture:** Extends the existing plugin manifest with `contributes.informationTypes`. New Tauri commands handle DB storage for cached info values. A new `useInformationTypes` hook manages the fetch lifecycle (lazy load, stale-while-revalidate, multi-provider fallback). Ten standard display-kind renderers render data in an `<InformationSections>` component that replaces bespoke detail view sections.

**Tech Stack:** Rust/SQLite (backend storage), TypeScript/React (frontend types, hooks, renderers), existing Tauri IPC + plugin system.

**Spec:** `docs/superpowers/specs/2026-04-06-information-type-plugin-system-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|---|---|
| `src/types/informationTypes.ts` | TypeScript interfaces for info types, entities, fetch results, display kind schemas |
| `src/hooks/useInformationTypes.ts` | Fetch lifecycle hook: query types, check cache, invoke plugin handlers, dedup, store results |
| `src/components/InformationSections.tsx` | Generic component that renders all info type sections for an entity |
| `src/components/InformationSections.css` | Styles for section containers, loading skeletons, error states |
| `src/components/renderers/RichTextRenderer.tsx` | `rich_text` display kind |
| `src/components/renderers/HtmlRenderer.tsx` | `html` display kind |
| `src/components/renderers/EntityListRenderer.tsx` | `entity_list` display kind |
| `src/components/renderers/StatGridRenderer.tsx` | `stat_grid` display kind |
| `src/components/renderers/TagListRenderer.tsx` | `tag_list` display kind |
| `src/components/renderers/RankedListRenderer.tsx` | `ranked_list` display kind |
| `src/components/renderers/AnnotatedTextRenderer.tsx` | `annotated_text` display kind |
| `src/components/renderers/KeyValueRenderer.tsx` | `key_value` display kind |
| `src/components/renderers/ImageGalleryRenderer.tsx` | `image_gallery` display kind |
| `src/components/renderers/LyricsRenderer.tsx` | `lyrics` display kind (wraps existing LyricsPanel) |
| `src/components/renderers/index.ts` | Renderer registry map |
| `src/components/renderers/renderers.css` | Shared renderer styles |
| `src/__tests__/informationTypes.test.ts` | Unit tests for cache logic, TTL, status decisions |
| `src-tauri/plugins/lastfm-info/manifest.json` | Internal Last.fm info plugin manifest |
| `src-tauri/plugins/lastfm-info/index.js` | Internal Last.fm info plugin — `artist_bio` handler (first migration) |

### Modified Files
| File | Changes |
|---|---|
| `src-tauri/src/db.rs` | Add `information_types`, `information_values`, `information_type_providers` tables + CRUD functions + migration |
| `src-tauri/src/commands.rs` | Add 6 new Tauri commands for info type storage |
| `src-tauri/src/lib.rs` | Register new commands in both debug/release invoke handlers |
| `src/types/plugin.ts` | Extend `PluginManifestContributes`, `ViboplrPluginAPI`, `LoadedPlugin` |
| `src/hooks/usePlugins.ts` | Add `infoFetchHandlers` to `LoadedPlugin`, wire `informationTypes` namespace in `buildAPI`, process manifest `informationTypes` in `loadPlugins` |
| `src/components/ArtistDetailContent.tsx` | Add `<InformationSections>` with `exclude` for non-migrated sections (first migration: artist_bio only) |

---

## Task 1: Database Schema — New Tables

**Files:**
- Modify: `src-tauri/src/db.rs` — add tables in `init_tables` (after `plugin_storage` table) and add migration in `run_migrations` (after the last `if version < N` block)

- [ ] **Step 1: Add new tables to `init_tables`**

In `src-tauri/src/db.rs`, inside the `conn.execute_batch(` string in `init_tables` (after the `plugin_storage` table at line 349), add:

```sql
CREATE TABLE IF NOT EXISTS information_types (
    id              TEXT NOT NULL,
    name            TEXT NOT NULL,
    entity          TEXT NOT NULL,
    display_kind    TEXT NOT NULL,
    plugin_id       TEXT NOT NULL,
    ttl             INTEGER NOT NULL,
    sort_order      INTEGER NOT NULL DEFAULT 500,
    priority        INTEGER NOT NULL DEFAULT 500,
    PRIMARY KEY (id, plugin_id)
);

CREATE TABLE IF NOT EXISTS information_values (
    information_type_id  TEXT NOT NULL,
    entity_key           TEXT NOT NULL,
    value                TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'ok',
    fetched_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (information_type_id, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_info_values_entity ON information_values(entity_key);

CREATE TABLE IF NOT EXISTS information_type_providers (
    information_type_id  TEXT NOT NULL,
    plugin_id            TEXT NOT NULL,
    user_priority        INTEGER NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (information_type_id, plugin_id)
);
```

- [ ] **Step 2: Add migration for existing databases**

In `run_migrations`, add a new migration block after the last existing one. **The current highest version is 15**, so use version 16:

```rust
if version < 16 {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS information_types (
            id              TEXT NOT NULL,
            name            TEXT NOT NULL,
            entity          TEXT NOT NULL,
            display_kind    TEXT NOT NULL,
            plugin_id       TEXT NOT NULL,
            ttl             INTEGER NOT NULL,
            sort_order      INTEGER NOT NULL DEFAULT 500,
            priority        INTEGER NOT NULL DEFAULT 500,
            PRIMARY KEY (id, plugin_id)
        );
        CREATE TABLE IF NOT EXISTS information_values (
            information_type_id  TEXT NOT NULL,
            entity_key           TEXT NOT NULL,
            value                TEXT NOT NULL,
            status               TEXT NOT NULL DEFAULT 'ok',
            fetched_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
            PRIMARY KEY (information_type_id, entity_key)
        );
        CREATE INDEX IF NOT EXISTS idx_info_values_entity ON information_values(entity_key);
        CREATE TABLE IF NOT EXISTS information_type_providers (
            information_type_id  TEXT NOT NULL,
            plugin_id            TEXT NOT NULL,
            user_priority        INTEGER NOT NULL,
            enabled              INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (information_type_id, plugin_id)
        );"
    )?;
    conn.execute("UPDATE db_version SET version = 16 WHERE rowid = 1", [])?;
}
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: add information_types, information_values, information_type_providers tables"
```

---

## Task 2: Database CRUD Functions

**Files:**
- Modify: `src-tauri/src/db.rs` (add functions inside `impl Database`, after the `plugin_storage_delete` function, before the closing `}` of the impl block)

- [ ] **Step 1: Write the Rust test for `info_upsert_value` and `info_get_value`**

At the bottom of `db.rs`, inside the `#[cfg(test)] mod tests` block (or create one if it doesn't exist), add:

```rust
#[cfg(test)]
mod info_tests {
    use super::*;

    fn test_db() -> Database {
        Database::new_in_memory().unwrap()
    }

    #[test]
    fn test_info_upsert_and_get() {
        let db = test_db();
        // No value yet
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_none());

        // Insert
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        let row = db.info_get_value("artist_bio", "artist:1").unwrap().unwrap();
        assert_eq!(row.0, r#"{"summary":"bio"}"#); // value
        assert_eq!(row.1, "ok"); // status
        assert!(row.2 > 0); // fetched_at

        // Upsert overwrites
        db.info_upsert_value("artist_bio", "artist:1", "{}", "not_found").unwrap();
        let row = db.info_get_value("artist_bio", "artist:1").unwrap().unwrap();
        assert_eq!(row.1, "not_found");
    }

    #[test]
    fn test_info_get_values_for_entity() {
        let db = test_db();
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value("similar_artists", "artist:1", r#"{"items":[]}"#, "ok").unwrap();
        db.info_upsert_value("artist_bio", "artist:2", r#"{"summary":"other"}"#, "ok").unwrap();

        let rows = db.info_get_values_for_entity("artist:1").unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn test_info_delete_value() {
        let db = test_db();
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_delete_value("artist_bio", "artist:1").unwrap();
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_none());
    }

    #[test]
    fn test_info_cleanup_orphans() {
        let db = test_db();
        // Insert a value with no matching info_type registration
        db.info_upsert_value("orphan_type", "artist:1", "{}", "ok").unwrap();
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_some());

        // Cleanup should remove it (no rows in information_types)
        db.info_cleanup_orphaned_values().unwrap();
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_none());
    }

    #[test]
    fn test_info_cleanup_preserves_registered_types() {
        let db = test_db();
        // Register an info type
        db.info_rebuild_types(&[
            ("artist_bio".into(), "About".into(), "artist".into(), "rich_text".into(),
             "lastfm-info".into(), 7776000, 200, 100),
        ]).unwrap();
        // Insert values: one for registered type, one orphan
        db.info_upsert_value("artist_bio", "artist:1", r#"{"summary":"bio"}"#, "ok").unwrap();
        db.info_upsert_value("orphan_type", "artist:1", "{}", "ok").unwrap();

        db.info_cleanup_orphaned_values().unwrap();

        // Registered type preserved, orphan deleted
        assert!(db.info_get_value("artist_bio", "artist:1").unwrap().is_some());
        assert!(db.info_get_value("orphan_type", "artist:1").unwrap().is_none());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test info_tests`
Expected: FAIL — functions don't exist yet.

- [ ] **Step 3: Implement CRUD functions**

Add these public functions to the `impl Database` block in `db.rs`, after the `plugin_storage_delete` function:

```rust
// ── Information Types ────────────────────────────────────────

/// Rebuild the information_types table from plugin manifests.
/// Called on startup after plugins are loaded.
pub fn info_rebuild_types(&self, types: &[(String, String, String, String, String, i64, i64, i64)]) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute("DELETE FROM information_types", [])?;
    let mut stmt = conn.prepare(
        "INSERT INTO information_types (id, name, entity, display_kind, plugin_id, ttl, sort_order, priority)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"
    )?;
    for t in types {
        stmt.execute(rusqlite::params![t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7])?;
    }
    Ok(())
}

/// Get all registered info types for an entity kind, ordered by sort_order.
pub fn info_get_types_for_entity(&self, entity: &str) -> SqlResult<Vec<(String, String, String, String, i64, i64, i64)>> {
    let conn = self.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, name, display_kind, plugin_id, ttl, sort_order, priority
         FROM information_types WHERE entity = ?1 ORDER BY sort_order, id"
    )?;
    let rows = stmt.query_map([entity], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?))
    })?.collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// Get a single cached info value.
/// Returns (value, status, fetched_at) or None.
pub fn info_get_value(&self, type_id: &str, entity_key: &str) -> SqlResult<Option<(String, String, i64)>> {
    let conn = self.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT value, status, fetched_at FROM information_values
         WHERE information_type_id = ?1 AND entity_key = ?2"
    )?;
    let result = stmt.query_row(rusqlite::params![type_id, entity_key], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    });
    match result {
        Ok(r) => Ok(Some(r)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Get all cached info values for an entity key.
/// Returns vec of (information_type_id, value, status, fetched_at).
pub fn info_get_values_for_entity(&self, entity_key: &str) -> SqlResult<Vec<(String, String, String, i64)>> {
    let conn = self.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT information_type_id, value, status, fetched_at FROM information_values
         WHERE entity_key = ?1"
    )?;
    let rows = stmt.query_map([entity_key], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?.collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// Upsert an info value (insert or update).
pub fn info_upsert_value(&self, type_id: &str, entity_key: &str, value: &str, status: &str) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO information_values (information_type_id, entity_key, value, status, fetched_at)
         VALUES (?1, ?2, ?3, ?4, strftime('%s', 'now'))
         ON CONFLICT(information_type_id, entity_key)
         DO UPDATE SET value = excluded.value, status = excluded.status, fetched_at = excluded.fetched_at",
        rusqlite::params![type_id, entity_key, value, status],
    )?;
    Ok(())
}

/// Delete a cached info value.
pub fn info_delete_value(&self, type_id: &str, entity_key: &str) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM information_values WHERE information_type_id = ?1 AND entity_key = ?2",
        rusqlite::params![type_id, entity_key],
    )?;
    Ok(())
}

/// Delete all cached values for an entity.
pub fn info_delete_all_for_entity(&self, entity_key: &str) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM information_values WHERE entity_key = ?1",
        [entity_key],
    )?;
    Ok(())
}

/// Cleanup orphaned values whose information_type_id has no matching registration.
pub fn info_cleanup_orphaned_values(&self) -> SqlResult<usize> {
    let conn = self.conn.lock().unwrap();
    let count = conn.execute(
        "DELETE FROM information_values
         WHERE information_type_id NOT IN (SELECT DISTINCT id FROM information_types)",
        [],
    )?;
    Ok(count)
}

/// Get provider ordering for an info type.
/// Returns vec of (plugin_id, user_priority, enabled).
pub fn info_get_providers(&self, type_id: &str) -> SqlResult<Vec<(String, i64, bool)>> {
    let conn = self.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT plugin_id, user_priority, enabled FROM information_type_providers
         WHERE information_type_id = ?1 ORDER BY user_priority"
    )?;
    let rows = stmt.query_map([type_id], |row| {
        Ok((row.get(0)?, row.get::<_, i64>(1)?, row.get::<_, bool>(2)?))
    })?.collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// Set user-configured provider ordering for an info type.
pub fn info_set_provider(&self, type_id: &str, plugin_id: &str, priority: i64, enabled: bool) -> SqlResult<()> {
    let conn = self.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO information_type_providers (information_type_id, plugin_id, user_priority, enabled)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(information_type_id, plugin_id)
         DO UPDATE SET user_priority = excluded.user_priority, enabled = excluded.enabled",
        rusqlite::params![type_id, plugin_id, priority, enabled as i32],
    )?;
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test info_tests`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "feat: add CRUD functions for information types and values"
```

---

## Task 3: Tauri IPC Commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add new commands after the existing plugin commands section)
- Modify: `src-tauri/src/lib.rs` (register new commands in both debug/release handlers)

- [ ] **Step 1: Add Tauri commands to `commands.rs`**

Add after the existing plugin commands:

```rust
// ── Information Type commands ────────────────────────────────

#[tauri::command]
pub fn info_rebuild_types(
    state: State<'_, AppState>,
    types: Vec<(String, String, String, String, String, i64, i64, i64)>,
) -> Result<(), String> {
    state.db.info_rebuild_types(&types).map_err(|e| e.to_string())?;
    state.db.info_cleanup_orphaned_values().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn info_get_types_for_entity(
    state: State<'_, AppState>,
    entity: String,
) -> Result<Vec<(String, String, String, String, i64, i64, i64)>, String> {
    state.db.info_get_types_for_entity(&entity).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_get_value(
    state: State<'_, AppState>,
    type_id: String,
    entity_key: String,
) -> Result<Option<(String, String, i64)>, String> {
    state.db.info_get_value(&type_id, &entity_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_get_values_for_entity(
    state: State<'_, AppState>,
    entity_key: String,
) -> Result<Vec<(String, String, String, i64)>, String> {
    state.db.info_get_values_for_entity(&entity_key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_upsert_value(
    state: State<'_, AppState>,
    type_id: String,
    entity_key: String,
    value: String,
    status: String,
) -> Result<(), String> {
    state.db.info_upsert_value(&type_id, &entity_key, &value, &status).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn info_delete_value(
    state: State<'_, AppState>,
    type_id: String,
    entity_key: String,
) -> Result<(), String> {
    state.db.info_delete_value(&type_id, &entity_key).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register commands in `lib.rs`**

In `src-tauri/src/lib.rs`, add these lines to BOTH `get_invoke_handler()` functions (debug at line ~33 and release at line ~171), alongside the existing plugin commands:

```rust
commands::info_rebuild_types,
commands::info_get_types_for_entity,
commands::info_get_value,
commands::info_get_values_for_entity,
commands::info_upsert_value,
commands::info_delete_value,
```

- [ ] **Step 3: Verify compilation**

Run: `cd src-tauri && cargo check`
Expected: Compiles without errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat: add Tauri IPC commands for information type storage"
```

---

## Task 4: TypeScript Type Definitions

**Files:**
- Create: `src/types/informationTypes.ts`
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Create `src/types/informationTypes.ts`**

```typescript
// Information Type system types

export type InfoEntityKind = "artist" | "album" | "track" | "tag";

export type InfoStatus = "ok" | "not_found" | "error";

export type DisplayKind =
  | "rich_text"
  | "html"
  | "entity_list"
  | "stat_grid"
  | "lyrics"
  | "tag_list"
  | "ranked_list"
  | "annotated_text"
  | "key_value"
  | "image_gallery";

/** Declared in plugin manifest contributes.informationTypes */
export interface InfoTypeDeclaration {
  id: string;
  name: string;
  entity: InfoEntityKind;
  displayKind: DisplayKind;
  ttl: number;
  order: number;
  priority: number;
}

/** Entity passed to plugin onFetch handlers */
export interface InfoEntity {
  kind: InfoEntityKind;
  name: string;
  id: number;
  artistName?: string;
  albumTitle?: string;
}

/** Result returned by plugin onFetch handlers */
export type InfoFetchResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "error" };

/** Registered info type (from DB, includes plugin_id) */
export interface RegisteredInfoType {
  id: string;
  name: string;
  displayKind: DisplayKind;
  pluginId: string;
  ttl: number;
  sortOrder: number;
  priority: number;
}

/** Cached info value (from DB) */
export interface CachedInfoValue {
  informationTypeId: string;
  value: string; // JSON string
  status: InfoStatus;
  fetchedAt: number; // unix timestamp
}

/** Resolved section state for rendering */
export interface InfoSection {
  typeId: string;
  name: string;
  displayKind: DisplayKind;
  state:
    | { kind: "loaded"; data: unknown; stale: boolean }
    | { kind: "loading" }
    | { kind: "hidden" }; // not_found or fresh error
}

// ── Display Kind Schemas ──────────────────────────────────

export interface RichTextData {
  summary: string;
  full?: string;
}

export interface HtmlData {
  content: string;
}

export interface EntityListItem {
  name: string;
  subtitle?: string;
  match?: number;
  image?: string;
  url?: string;
  libraryId?: number;
  libraryKind?: "track" | "artist" | "album";
}

export interface EntityListData {
  items: EntityListItem[];
}

export interface StatGridItem {
  label: string;
  value: string | number;
  unit?: string;
}

export interface StatGridData {
  items: StatGridItem[];
}

export interface LyricsData {
  text: string;
  kind: "plain" | "synced";
  lines?: Array<{ time: number; text: string }>;
}

export interface TagListData {
  tags: Array<{ name: string; url?: string }>;
  suggestable?: boolean;
}

export interface RankedListItem {
  name: string;
  subtitle?: string;
  value: number;
  maxValue?: number;
  libraryId?: number;
  libraryKind?: "track" | "artist" | "album";
}

export interface RankedListData {
  items: RankedListItem[];
}

export interface AnnotatedTextData {
  overview?: string;
  sections: Array<{ heading?: string; text: string }>;
}

export interface KeyValueData {
  items: Array<{ key: string; value: string }>;
}

export interface ImageGalleryImage {
  url: string;
  caption?: string;
  source?: string;
}

export interface ImageGalleryData {
  images: ImageGalleryImage[];
}
```

- [ ] **Step 2: Extend plugin types in `src/types/plugin.ts`**

Add to `PluginManifestContributes` (line 33-37):

```typescript
export interface PluginManifestContributes {
  sidebarItems?: PluginManifestSidebarItem[];
  contextMenuItems?: PluginManifestContextMenuItem[];
  eventHooks?: PluginEventName[];
  informationTypes?: PluginManifestInfoType[];
}
```

Add the new interface above `PluginManifestContributes`:

```typescript
export interface PluginManifestInfoType {
  id: string;
  name: string;
  entity: "artist" | "album" | "track" | "tag";
  displayKind: string;
  ttl: number;
  order: number;
  priority: number;
}
```

Extend `ViboplrPluginAPI` (line 251-260) to add the new namespace:

```typescript
export interface ViboplrPluginAPI {
  library: PluginLibraryAPI;
  playback: PluginPlaybackAPI;
  contextMenu: PluginContextMenuAPI;
  ui: PluginUIAPI;
  storage: PluginStorageAPI;
  network: PluginNetworkAPI;
  tidal: PluginTidalAPI;
  collections: PluginCollectionsAPI;
  informationTypes: PluginInformationTypesAPI;
}
```

Add the new API interface:

```typescript
export interface PluginInformationTypesAPI {
  onFetch(
    infoTypeId: string,
    handler: (entity: import("./informationTypes").InfoEntity) => Promise<import("./informationTypes").InfoFetchResult>,
  ): () => void;
  /** Call a Tauri command from within an info fetch handler. Allows internal
   *  plugins to reuse existing backend commands (e.g. lastfm_get_artist_info). */
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No type errors (may have pre-existing ones — verify no NEW errors).

- [ ] **Step 4: Commit**

```bash
git add src/types/informationTypes.ts src/types/plugin.ts
git commit -m "feat: add TypeScript types for information type system"
```

---

## Task 5: Extend usePlugins Hook

**Files:**
- Modify: `src/hooks/usePlugins.ts`

- [ ] **Step 1: Add `infoFetchHandlers` to `LoadedPlugin`**

In `src/hooks/usePlugins.ts`, update the `LoadedPlugin` interface (line 41-50):

```typescript
interface LoadedPlugin {
  id: string;
  manifest: PluginManifest;
  deactivate?: () => void;
  unsubscribers: Array<() => void>;
  contextMenuHandlers: Map<string, (target: PluginContextMenuTarget) => void>;
  uiActionHandlers: Map<string, (data: unknown) => void>;
  deepLinkHandlers: Array<(url: string) => void>;
  oauthCallbackHandlers: Array<(queryString: string) => void>;
  infoFetchHandlers: Map<string, (entity: InfoEntity) => Promise<InfoFetchResult>>;
}
```

Add the import at the top of the file:

```typescript
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
```

- [ ] **Step 2: Initialize `infoFetchHandlers` in `activatePlugin`**

In the `activatePlugin` function (line ~414), add `infoFetchHandlers` to the `LoadedPlugin` initialization:

```typescript
const loaded: LoadedPlugin = {
  id,
  manifest,
  unsubscribers: [],
  contextMenuHandlers: new Map(),
  uiActionHandlers: new Map(),
  deepLinkHandlers: [],
  oauthCallbackHandlers: [],
  infoFetchHandlers: new Map(),
};
```

- [ ] **Step 3: Wire `informationTypes` namespace in `buildAPI`**

In the `buildAPI` function (line ~111), add the `informationTypes` namespace to the returned API object. Find where the API object is returned (should be a `return { library, playback, ... }` block) and add:

```typescript
informationTypes: {
  onFetch(
    infoTypeId: string,
    handler: (entity: InfoEntity) => Promise<InfoFetchResult>,
  ): () => void {
    loaded.infoFetchHandlers.set(infoTypeId, handler);
    const unsub = () => {
      loaded.infoFetchHandlers.delete(infoTypeId);
    };
    trackUnsubscribe(unsub);
    return unsub;
  },
  async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    return invoke<T>(command, args);
  },
},
```

- [ ] **Step 4: Process `informationTypes` in `loadPlugins` and register types with backend**

In the `loadPlugins` function, after the existing contributes processing (line ~520-542), add info type collection. Then after all plugins are loaded, call the rebuild command:

```typescript
// Collect all info type registrations across plugins
const allInfoTypes: Array<[string, string, string, string, string, number, number, number]> = [];

// ... inside the for loop, after contrib.contextMenuItems processing:
if (contrib.informationTypes) {
  for (const it of contrib.informationTypes) {
    allInfoTypes.push([it.id, it.name, it.entity, it.displayKind, plugin.id, it.ttl, it.order, it.priority]);
  }
}

// ... after the for loop ends, before setPluginStates:
if (allInfoTypes.length > 0) {
  await invoke("info_rebuild_types", { types: allInfoTypes });
}
```

Note: `allInfoTypes` must be declared before the for loop and the `invoke` call after. Also need to handle the case where no plugins have info types (skip the call).

- [ ] **Step 5: Expose `invokeInfoFetch` for the hook consumer**

Add a new function to the hook's return value that allows the `useInformationTypes` hook to call a specific plugin's fetch handler:

```typescript
const invokeInfoFetch = useCallback(
  async (pluginId: string, infoTypeId: string, entity: InfoEntity): Promise<InfoFetchResult> => {
    const loaded = loadedPluginsRef.current.get(pluginId);
    if (!loaded) return { status: "error" };
    const handler = loaded.infoFetchHandlers.get(infoTypeId);
    if (!handler) return { status: "error" };
    return handler(entity);
  },
  [],
);
```

Add `invokeInfoFetch` to the hook's return object.

- [ ] **Step 6: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/usePlugins.ts
git commit -m "feat: extend usePlugins with informationTypes API namespace"
```

---

## Task 6: Unit Tests for Cache Logic

**Files:**
- Create: `src/__tests__/informationTypes.test.ts`

- [ ] **Step 1: Write tests for cache decision logic**

```typescript
import { describe, it, expect } from "vitest";

const ERROR_TTL = 3600; // 1 hour

type Status = "ok" | "not_found" | "error";

interface CacheEntry {
  status: Status;
  fetchedAt: number;
}

/** Pure function: given a cache entry and info type TTL, decide what to do */
function decideCacheAction(
  entry: CacheEntry | null,
  ttl: number,
  now: number,
): "render" | "render_and_refetch" | "loading" | "hidden" {
  if (!entry) return "loading";

  const age = now - entry.fetchedAt;
  const effectiveTtl = entry.status === "error" ? ERROR_TTL : ttl;
  const stale = age >= effectiveTtl;

  if (entry.status === "ok") {
    return stale ? "render_and_refetch" : "render";
  }
  if (entry.status === "not_found") {
    return stale ? "loading" : "hidden";
  }
  // error
  return stale ? "loading" : "hidden";
}

describe("decideCacheAction", () => {
  const now = 1000000;

  it("returns loading when no cache entry", () => {
    expect(decideCacheAction(null, 90 * 86400, now)).toBe("loading");
  });

  it("renders fresh ok data", () => {
    expect(decideCacheAction({ status: "ok", fetchedAt: now - 100 }, 90 * 86400, now)).toBe("render");
  });

  it("renders stale ok data and triggers refetch", () => {
    expect(decideCacheAction({ status: "ok", fetchedAt: now - 90 * 86400 - 1 }, 90 * 86400, now)).toBe("render_and_refetch");
  });

  it("hides fresh not_found", () => {
    expect(decideCacheAction({ status: "not_found", fetchedAt: now - 100 }, 90 * 86400, now)).toBe("hidden");
  });

  it("retries stale not_found", () => {
    expect(decideCacheAction({ status: "not_found", fetchedAt: now - 90 * 86400 - 1 }, 90 * 86400, now)).toBe("loading");
  });

  it("hides fresh error (within 1 hour)", () => {
    expect(decideCacheAction({ status: "error", fetchedAt: now - 1800 }, 90 * 86400, now)).toBe("hidden");
  });

  it("retries stale error (after 1 hour)", () => {
    expect(decideCacheAction({ status: "error", fetchedAt: now - 3601 }, 90 * 86400, now)).toBe("loading");
  });

  it("error TTL is independent of info type TTL", () => {
    // Even with a 30-day info type TTL, error retries after 1 hour
    expect(decideCacheAction({ status: "error", fetchedAt: now - 3601 }, 30 * 86400, now)).toBe("loading");
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- --run src/__tests__/informationTypes.test.ts`
Expected: All 8 tests PASS (tests are for a pure function defined inline in the test — no dependency on implementation yet).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/informationTypes.test.ts
git commit -m "test: add unit tests for information type cache decision logic"
```

---

## Task 7: useInformationTypes Hook

**Files:**
- Create: `src/hooks/useInformationTypes.ts`

- [ ] **Step 1: Implement the hook**

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  InfoEntity,
  InfoSection,
  RegisteredInfoType,
  DisplayKind,
  InfoFetchResult,
} from "../types/informationTypes";

const ERROR_TTL = 3600; // 1 hour in seconds

type CacheAction = "render" | "render_and_refetch" | "loading" | "hidden";

function decideCacheAction(
  status: string | null,
  fetchedAt: number | null,
  ttl: number,
  now: number,
): CacheAction {
  if (status === null || fetchedAt === null) return "loading";
  const age = now - fetchedAt;
  const effectiveTtl = status === "error" ? ERROR_TTL : ttl;
  const stale = age >= effectiveTtl;

  if (status === "ok") return stale ? "render_and_refetch" : "render";
  // not_found or error
  return stale ? "loading" : "hidden";
}

interface UseInformationTypesOpts {
  entity: InfoEntity | null;
  exclude?: string[];
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<InfoFetchResult>;
}

export function useInformationTypes({
  entity,
  exclude,
  invokeInfoFetch,
}: UseInformationTypesOpts) {
  const [sections, setSections] = useState<InfoSection[]>([]);
  const inFlightRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadSections = useCallback(async () => {
    if (!entity) {
      setSections([]);
      return;
    }

    // 1. Query registered info types for this entity kind
    const types = await invoke<Array<[string, string, string, string, number, number, number]>>(
      "info_get_types_for_entity",
      { entity: entity.kind },
    );

    // 2. Query all cached values for this entity
    const entityKey = `${entity.kind}:${entity.id}`;
    const cached = await invoke<Array<[string, string, string, number]>>(
      "info_get_values_for_entity",
      { entityKey },
    );
    const cacheMap = new Map(cached.map(([typeId, value, status, fetchedAt]) => [typeId, { value, status, fetchedAt }]));

    const now = Math.floor(Date.now() / 1000);

    // Deduplicate info types by id (pick lowest sort_order per id).
    // TODO: Multi-provider fallback — when multiple plugins register the same ID,
    // query info_get_providers for user-configured priority and try providers in order.
    // For now, uses the first provider (lowest sort_order) only.
    const seenIds = new Set<string>();
    const uniqueTypes: Array<{ id: string; name: string; displayKind: DisplayKind; pluginId: string; ttl: number }> = [];
    for (const [id, name, displayKind, pluginId, ttl] of types) {
      if (seenIds.has(id)) continue;
      if (exclude?.includes(id)) continue;
      seenIds.add(id);
      uniqueTypes.push({ id, name, displayKind: displayKind as DisplayKind, pluginId, ttl });
    }

    // 3. Build initial section states
    const newSections: InfoSection[] = [];
    const fetchNeeded: Array<{ typeId: string; pluginId: string; index: number }> = [];

    for (const t of uniqueTypes) {
      const entry = cacheMap.get(t.id);
      const action = decideCacheAction(
        entry?.status ?? null,
        entry?.fetchedAt ?? null,
        t.ttl,
        now,
      );

      if (action === "hidden") continue;

      const idx = newSections.length;

      if (action === "render" || action === "render_and_refetch") {
        let parsed: unknown;
        try { parsed = JSON.parse(entry!.value); } catch { parsed = null; }
        newSections.push({
          typeId: t.id,
          name: t.name,
          displayKind: t.displayKind,
          state: { kind: "loaded", data: parsed, stale: action === "render_and_refetch" },
        });
        if (action === "render_and_refetch") {
          fetchNeeded.push({ typeId: t.id, pluginId: t.pluginId, index: idx });
        }
      } else {
        // loading
        newSections.push({
          typeId: t.id,
          name: t.name,
          displayKind: t.displayKind,
          state: { kind: "loading" },
        });
        fetchNeeded.push({ typeId: t.id, pluginId: t.pluginId, index: idx });
      }
    }

    if (mountedRef.current) setSections(newSections);

    // 4. Fire fetches in parallel
    for (const { typeId, pluginId, index } of fetchNeeded) {
      const dedupKey = `${typeId}:${entityKey}`;
      if (inFlightRef.current.has(dedupKey)) continue;
      inFlightRef.current.add(dedupKey);

      (async () => {
        try {
          const result = await invokeInfoFetch(pluginId, typeId, entity);
          const value = result.status === "ok" ? JSON.stringify(result.value) : "{}";
          await invoke("info_upsert_value", {
            typeId,
            entityKey,
            value,
            status: result.status,
          });

          if (mountedRef.current && result.status === "ok") {
            setSections((prev) => {
              const next = [...prev];
              const existing = next.find((s) => s.typeId === typeId);
              if (existing) {
                existing.state = { kind: "loaded", data: result.value, stale: false };
              }
              return next;
            });
          } else if (mountedRef.current && result.status !== "ok") {
            // Remove section if fetch returned not_found or error
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } catch {
          await invoke("info_upsert_value", {
            typeId,
            entityKey,
            value: "{}",
            status: "error",
          }).catch(() => {});
          if (mountedRef.current) {
            setSections((prev) => prev.filter((s) => s.typeId !== typeId));
          }
        } finally {
          inFlightRef.current.delete(dedupKey);
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity?.kind, entity?.id, exclude, invokeInfoFetch]);
  // Note: entity.name deliberately excluded — cache is keyed by ID, not name.

  useEffect(() => {
    loadSections();
  }, [loadSections]);

  const refresh = useCallback(
    async (typeId: string) => {
      if (!entity) return;
      const entityKey = `${entity.kind}:${entity.id}`;
      // Delete cached value to force refetch
      await invoke("info_delete_value", { typeId, entityKey });
      loadSections();
    },
    [entity, loadSections],
  );

  return { sections, refresh };
}
```

- [ ] **Step 2: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useInformationTypes.ts
git commit -m "feat: add useInformationTypes hook with fetch lifecycle and caching"
```

---

## Task 8: Display Kind Renderers

**Files:**
- Create: `src/components/renderers/RichTextRenderer.tsx`
- Create: `src/components/renderers/HtmlRenderer.tsx`
- Create: `src/components/renderers/EntityListRenderer.tsx`
- Create: `src/components/renderers/StatGridRenderer.tsx`
- Create: `src/components/renderers/TagListRenderer.tsx`
- Create: `src/components/renderers/RankedListRenderer.tsx`
- Create: `src/components/renderers/AnnotatedTextRenderer.tsx`
- Create: `src/components/renderers/KeyValueRenderer.tsx`
- Create: `src/components/renderers/ImageGalleryRenderer.tsx`
- Create: `src/components/renderers/LyricsRenderer.tsx`
- Create: `src/components/renderers/index.ts`
- Create: `src/components/renderers/renderers.css`

This task creates the 10 renderers and the registry. Each renderer is a focused React component.

- [ ] **Step 0 (prerequisite): Export `sanitizeHTML` from `PluginViewRenderer.tsx`**

The function `sanitizeHTML` at line 273 of `src/components/PluginViewRenderer.tsx` is currently module-private. Export it so renderers can reuse it:

Change `function sanitizeHTML(` to `export function sanitizeHTML(`.

- [ ] **Step 1: Create renderer registry `src/components/renderers/index.ts`**

```typescript
import type { ComponentType } from "react";
import { RichTextRenderer } from "./RichTextRenderer";
import { HtmlRenderer } from "./HtmlRenderer";
import { EntityListRenderer } from "./EntityListRenderer";
import { StatGridRenderer } from "./StatGridRenderer";
import { TagListRenderer } from "./TagListRenderer";
import { RankedListRenderer } from "./RankedListRenderer";
import { AnnotatedTextRenderer } from "./AnnotatedTextRenderer";
import { KeyValueRenderer } from "./KeyValueRenderer";
import { ImageGalleryRenderer } from "./ImageGalleryRenderer";
import { LyricsRenderer } from "./LyricsRenderer";

export interface RendererProps {
  data: unknown;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
}

export const renderers: Record<string, ComponentType<RendererProps>> = {
  rich_text: RichTextRenderer,
  html: HtmlRenderer,
  entity_list: EntityListRenderer,
  stat_grid: StatGridRenderer,
  lyrics: LyricsRenderer,
  tag_list: TagListRenderer,
  ranked_list: RankedListRenderer,
  annotated_text: AnnotatedTextRenderer,
  key_value: KeyValueRenderer,
  image_gallery: ImageGalleryRenderer,
};
```

- [ ] **Step 2: Create `RichTextRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { RichTextData } from "../../types/informationTypes";
import { useState } from "react";
import { sanitizeHTML } from "../PluginViewRenderer";

export function RichTextRenderer({ data }: RendererProps) {
  const d = data as RichTextData;
  const [expanded, setExpanded] = useState(false);
  if (!d?.summary) return null;

  const html = expanded && d.full ? d.full : d.summary;
  return (
    <div className="renderer-rich-text">
      <div dangerouslySetInnerHTML={{ __html: sanitizeHTML(html) }} />
      {d.full && (
        <button className="text-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
```

Note: `sanitizeHTML` was exported in Step 0 above.

- [ ] **Step 3: Create `HtmlRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { HtmlData } from "../../types/informationTypes";
import { sanitizeHTML } from "../PluginViewRenderer";

export function HtmlRenderer({ data }: RendererProps) {
  const d = data as HtmlData;
  if (!d?.content) return null;
  return (
    <div className="renderer-html" dangerouslySetInnerHTML={{ __html: sanitizeHTML(d.content) }} />
  );
}
```

- [ ] **Step 4: Create `EntityListRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { EntityListData } from "../../types/informationTypes";

export function EntityListRenderer({ data, onEntityClick }: RendererProps) {
  const d = data as EntityListData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-entity-list">
      {d.items.map((item, i) => (
        <div
          key={i}
          className={`entity-list-item${item.libraryId ? " clickable" : ""}`}
          onClick={() => item.libraryId && onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name)}
        >
          {item.image && <img src={item.image} alt="" className="entity-list-image" />}
          <div className="entity-list-text">
            <span className="entity-list-name">{item.name}</span>
            {item.subtitle && <span className="entity-list-subtitle">{item.subtitle}</span>}
          </div>
          {item.match != null && (
            <div className="entity-list-match">
              <div className="match-bar" style={{ width: `${Math.round(item.match * 100)}%` }} />
            </div>
          )}
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer" className="entity-list-link" onClick={(e) => e.stopPropagation()}>
              ↗
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Create `StatGridRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { StatGridData } from "../../types/informationTypes";

export function StatGridRenderer({ data }: RendererProps) {
  const d = data as StatGridData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-stat-grid">
      {d.items.map((item, i) => (
        <div key={i} className="stat-grid-item">
          <span className="stat-grid-value">
            {typeof item.value === "number" ? item.value.toLocaleString() : item.value}
            {item.unit && <span className="stat-grid-unit"> {item.unit}</span>}
          </span>
          <span className="stat-grid-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Create `TagListRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { TagListData } from "../../types/informationTypes";

export function TagListRenderer({ data, onAction }: RendererProps) {
  const d = data as TagListData;
  if (!d?.tags?.length) return null;

  return (
    <div className="renderer-tag-list">
      {d.tags.map((tag, i) => (
        <span
          key={i}
          className={`tag-pill${d.suggestable ? " suggestable" : ""}`}
          onClick={() => d.suggestable && onAction?.("apply_tag", { name: tag.name })}
        >
          {tag.name}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Create `RankedListRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { RankedListData } from "../../types/informationTypes";

export function RankedListRenderer({ data, onEntityClick }: RendererProps) {
  const d = data as RankedListData;
  if (!d?.items?.length) return null;

  const maxVal = d.items.reduce((m, it) => Math.max(m, it.maxValue ?? it.value), 0);

  return (
    <div className="renderer-ranked-list">
      {d.items.map((item, i) => (
        <div
          key={i}
          className={`ranked-list-item${item.libraryId ? " clickable" : ""}`}
          onClick={() => item.libraryId && onEntityClick?.(item.libraryKind ?? "track", item.libraryId, item.name)}
        >
          <span className="ranked-list-rank">{i + 1}</span>
          <div className="ranked-list-text">
            <span className="ranked-list-name">{item.name}</span>
            {item.subtitle && <span className="ranked-list-subtitle">{item.subtitle}</span>}
          </div>
          <div className="ranked-list-bar-container">
            <div className="ranked-list-bar" style={{ width: maxVal > 0 ? `${(item.value / maxVal) * 100}%` : "0%" }} />
          </div>
          <span className="ranked-list-value">{item.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 8: Create `AnnotatedTextRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { AnnotatedTextData } from "../../types/informationTypes";
import { sanitizeHTML } from "../PluginViewRenderer";

export function AnnotatedTextRenderer({ data }: RendererProps) {
  const d = data as AnnotatedTextData;
  if (!d?.sections?.length && !d?.overview) return null;

  return (
    <div className="renderer-annotated-text">
      {d.overview && <p className="annotated-overview" dangerouslySetInnerHTML={{ __html: sanitizeHTML(d.overview) }} />}
      {d.sections?.map((s, i) => (
        <div key={i} className="annotated-section">
          {s.heading && <h4>{s.heading}</h4>}
          <p dangerouslySetInnerHTML={{ __html: sanitizeHTML(s.text) }} />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 9: Create `KeyValueRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { KeyValueData } from "../../types/informationTypes";

export function KeyValueRenderer({ data }: RendererProps) {
  const d = data as KeyValueData;
  if (!d?.items?.length) return null;

  return (
    <div className="renderer-key-value">
      {d.items.map((item, i) => (
        <div key={i} className="kv-row">
          <span className="kv-key">{item.key}</span>
          <span className="kv-value">{item.value}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 10: Create `ImageGalleryRenderer.tsx`**

```tsx
import type { RendererProps } from "./index";
import type { ImageGalleryData } from "../../types/informationTypes";
import { useState } from "react";

export function ImageGalleryRenderer({ data }: RendererProps) {
  const d = data as ImageGalleryData;
  const [activeIndex, setActiveIndex] = useState(0);
  if (!d?.images?.length) return null;

  const image = d.images[activeIndex];
  const isGallery = d.images.length > 1;

  return (
    <div className="renderer-image-gallery">
      <div className="gallery-main">
        <img src={image.url} alt={image.caption ?? ""} className="gallery-image" />
        {isGallery && (
          <>
            <button className="gallery-nav gallery-prev" onClick={() => setActiveIndex((activeIndex - 1 + d.images.length) % d.images.length)} disabled={d.images.length <= 1}>
              ‹
            </button>
            <button className="gallery-nav gallery-next" onClick={() => setActiveIndex((activeIndex + 1) % d.images.length)} disabled={d.images.length <= 1}>
              ›
            </button>
          </>
        )}
      </div>
      {image.caption && <p className="gallery-caption">{image.caption}</p>}
      {image.source && <span className="gallery-source">{image.source}</span>}
      {isGallery && (
        <div className="gallery-dots">
          {d.images.map((_, i) => (
            <button key={i} className={`gallery-dot${i === activeIndex ? " active" : ""}`} onClick={() => setActiveIndex(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11: Create `LyricsRenderer.tsx`**

This is a thin wrapper that will delegate to the existing `LyricsPanel` component. For now, create a placeholder that renders lyrics text:

```tsx
import type { RendererProps } from "./index";
import type { LyricsData } from "../../types/informationTypes";

export function LyricsRenderer({ data }: RendererProps) {
  const d = data as LyricsData;
  if (!d?.text) return null;

  return (
    <div className="renderer-lyrics">
      <pre className="lyrics-plain">{d.text}</pre>
    </div>
  );
}
```

Note: Full lyrics renderer with sync/editing will be built during the lyrics migration step (future work). This placeholder is sufficient for the renderer registry.

- [ ] **Step 12: Create `renderers.css`**

```css
/* -- Shared renderer styles -- */

.renderer-rich-text .text-toggle {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  padding: 4px 0;
  font-size: var(--fs-xs);
}

.renderer-entity-list { display: flex; flex-direction: column; gap: 2px; }
.entity-list-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.entity-list-item.clickable { cursor: pointer; }
.entity-list-item.clickable:hover { background: var(--bg-hover); }
.entity-list-image { width: 32px; height: 32px; border-radius: 4px; object-fit: cover; }
.entity-list-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.entity-list-name { font-size: var(--fs-sm); }
.entity-list-subtitle { font-size: var(--fs-xs); opacity: 0.6; }
.entity-list-match { width: 60px; height: 4px; background: var(--border-color); border-radius: 2px; }
.entity-list-match .match-bar { height: 100%; background: var(--accent); border-radius: 2px; }
.entity-list-link { font-size: var(--fs-xs); opacity: 0.5; text-decoration: none; }

.renderer-stat-grid { display: flex; gap: 16px; flex-wrap: wrap; }
.stat-grid-item { display: flex; flex-direction: column; }
.stat-grid-value { font-size: var(--fs-lg); font-weight: 600; }
.stat-grid-unit { font-size: var(--fs-xs); opacity: 0.6; }
.stat-grid-label { font-size: var(--fs-xs); opacity: 0.6; }

.renderer-tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
.tag-pill { padding: 2px 8px; border-radius: 10px; font-size: var(--fs-xs); background: var(--bg-secondary); }
.tag-pill.suggestable { cursor: pointer; }
.tag-pill.suggestable:hover { background: var(--accent); color: var(--bg-primary); }

.renderer-ranked-list { display: flex; flex-direction: column; gap: 2px; }
.ranked-list-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.ranked-list-item.clickable { cursor: pointer; }
.ranked-list-rank { width: 20px; text-align: right; font-size: var(--fs-xs); opacity: 0.5; }
.ranked-list-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ranked-list-name { font-size: var(--fs-sm); }
.ranked-list-subtitle { font-size: var(--fs-xs); opacity: 0.6; }
.ranked-list-bar-container { width: 80px; height: 4px; background: var(--border-color); border-radius: 2px; }
.ranked-list-bar { height: 100%; background: var(--accent); border-radius: 2px; }
.ranked-list-value { font-size: var(--fs-xs); opacity: 0.6; min-width: 50px; text-align: right; }

.renderer-annotated-text .annotated-overview { margin-bottom: 12px; }
.renderer-annotated-text .annotated-section { margin-bottom: 8px; }
.renderer-annotated-text h4 { margin: 0 0 4px; font-size: var(--fs-sm); }

.renderer-key-value { display: flex; flex-direction: column; gap: 4px; }
.kv-row { display: flex; gap: 12px; font-size: var(--fs-sm); }
.kv-key { opacity: 0.6; min-width: 100px; }
.kv-value { flex: 1; }

.renderer-image-gallery { position: relative; }
.gallery-main { position: relative; }
.gallery-image { width: 100%; max-height: 400px; object-fit: contain; border-radius: 4px; }
.gallery-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.5); color: white; border: none; padding: 8px 12px; cursor: pointer; font-size: 20px; border-radius: 4px; }
.gallery-prev { left: 4px; }
.gallery-next { right: 4px; }
.gallery-caption { font-size: var(--fs-sm); margin: 4px 0 0; }
.gallery-source { font-size: var(--fs-xs); opacity: 0.5; }
.gallery-dots { display: flex; justify-content: center; gap: 4px; margin-top: 8px; }
.gallery-dot { width: 8px; height: 8px; border-radius: 50%; border: none; background: var(--border-color); cursor: pointer; padding: 0; }
.gallery-dot.active { background: var(--accent); }

.renderer-lyrics .lyrics-plain { white-space: pre-wrap; font-size: var(--fs-sm); line-height: 1.6; }
```

- [ ] **Step 13: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new type errors (`sanitizeHTML` was exported in Step 0).

- [ ] **Step 14: Commit**

```bash
git add src/components/renderers/
git commit -m "feat: add 10 display kind renderers for information type system"
```

---

## Task 9: InformationSections Component

**Files:**
- Create: `src/components/InformationSections.tsx`
- Create: `src/components/InformationSections.css`

- [ ] **Step 1: Create `InformationSections.tsx`**

```tsx
import { renderers } from "./renderers";
import type { InfoEntity, InfoSection } from "../types/informationTypes";
import { useInformationTypes } from "../hooks/useInformationTypes";
import { useState } from "react";
import "./InformationSections.css";

interface InformationSectionsProps {
  entity: InfoEntity | null;
  exclude?: string[];
  invokeInfoFetch: (
    pluginId: string,
    infoTypeId: string,
    entity: InfoEntity,
  ) => Promise<import("../types/informationTypes").InfoFetchResult>;
  onEntityClick?: (kind: string, id?: number, name?: string) => void;
  onAction?: (actionId: string, payload?: unknown) => void;
}

export function InformationSections({
  entity,
  exclude,
  invokeInfoFetch,
  onEntityClick,
  onAction,
}: InformationSectionsProps) {
  const { sections, refresh } = useInformationTypes({ entity, exclude, invokeInfoFetch });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!sections.length) return null;

  const toggleCollapse = (typeId: string) => {
    setCollapsed((prev) => ({ ...prev, [typeId]: !prev[typeId] }));
  };

  return (
    <div className="information-sections">
      {sections.map((section) => {
        const Renderer = renderers[section.displayKind];
        if (!Renderer) return null;

        const isCollapsed = collapsed[section.typeId] === true;

        return (
          <div key={section.typeId} className="info-section">
            <div className="section-title section-header" onClick={() => toggleCollapse(section.typeId)}>
              <svg className={`section-chevron${isCollapsed ? " collapsed" : ""}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              {section.name}
            </div>
            {!isCollapsed && (
              <div className="info-section-content">
                {section.state.kind === "loading" && (
                  <div className="info-section-skeleton" />
                )}
                {section.state.kind === "loaded" && section.state.data && (
                  <Renderer data={section.state.data} onEntityClick={onEntityClick} onAction={onAction} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create `InformationSections.css`**

```css
.information-sections {
  display: flex;
  flex-direction: column;
}

.info-section {
  margin-bottom: 4px;
}

.info-section-content {
  padding: 8px 0;
}

.info-section-skeleton {
  height: 40px;
  background: var(--bg-secondary);
  border-radius: 4px;
  animation: skeleton-pulse 1.5s ease-in-out infinite;
}

@keyframes skeleton-pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 0.7; }
}
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: No new type errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/InformationSections.tsx src/components/InformationSections.css
git commit -m "feat: add InformationSections generic component"
```

---

## Task 10: First Internal Plugin — lastfm-info (artist_bio)

**Files:**
- Create: `src-tauri/plugins/lastfm-info/manifest.json`
- Create: `src-tauri/plugins/lastfm-info/index.js`

- [ ] **Step 1: Create `manifest.json`**

```json
{
  "id": "lastfm-info",
  "name": "Last.fm Info",
  "version": "1.0.0",
  "author": "Viboplr",
  "description": "Provides artist biographies, stats, and similar artists from Last.fm",
  "minAppVersion": "0.9.4",
  "contributes": {
    "informationTypes": [
      {
        "id": "artist_bio",
        "name": "About",
        "entity": "artist",
        "displayKind": "rich_text",
        "ttl": 7776000,
        "order": 200,
        "priority": 100
      }
    ]
  }
}
```

- [ ] **Step 2: Create `index.js`**

This plugin uses `api.informationTypes.invoke()` to call the existing `lastfm_get_artist_info` Tauri command, which already handles the Last.fm API key, request signing, and caching. It then transforms the response to the `rich_text` schema.

**Important:** Check how `lastfm_get_artist_info` currently works. If it emits events asynchronously instead of returning data, the implementer may need to add a new synchronous variant (e.g. `lastfm_get_artist_info_sync`) that returns the bio data directly instead of emitting it. Look at the command in `commands.rs` and `lastfm.rs` to determine this.

```js
function activate(api) {
  api.informationTypes.onFetch("artist_bio", async (entity) => {
    if (entity.kind !== "artist") return { status: "not_found" };

    try {
      // Call the existing Tauri command via the invoke bridge.
      // The implementer should verify the exact return shape of this command
      // and adjust the field access below accordingly.
      const data = await api.informationTypes.invoke("lastfm_get_artist_info", {
        artistName: entity.name,
      });

      // If the command returns the Last.fm API response:
      if (!data || !data.bio || !data.bio.summary) {
        return { status: "not_found" };
      }

      return {
        status: "ok",
        value: {
          summary: data.bio.summary || "",
          full: data.bio.content || undefined,
        },
      };
    } catch (e) {
      return { status: "error" };
    }
  });
}

module.exports = { activate };
```

**Note:** If `lastfm_get_artist_info` is async-only (emits events, doesn't return data), the implementer must either: (a) add a new `lastfm_get_artist_info_sync` command that returns the bio directly, or (b) have the plugin call the Last.fm API directly via `api.network.fetch()` using the API key from a new `lastfm_get_api_key` command. Option (a) is preferred — it keeps the API key server-side.

- [ ] **Step 3: Verify the plugin files are valid**

Run: `cat src-tauri/plugins/lastfm-info/manifest.json | python3 -m json.tool`
Expected: Valid JSON output.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/plugins/lastfm-info/
git commit -m "feat: add lastfm-info internal plugin with artist_bio info type"
```

---

## Task 11: Integration — Wire into Artist Detail View

**Files:**
- Modify: `src/components/ArtistDetailContent.tsx`
- Modify: `src/App.tsx` (pass `invokeInfoFetch` prop)

- [ ] **Step 1: Add `InformationSections` to `ArtistDetailContent.tsx`**

Import the component at the top:

```typescript
import { InformationSections } from "./InformationSections";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
```

Add the `InformationSections` component in the JSX, after the header section but before the existing bespoke sections. Pass `exclude` with all info types NOT yet migrated:

```tsx
<InformationSections
  entity={artist ? { kind: "artist", name: artist.name, id: artist.id } : null}
  exclude={["artist_stats", "artist_top_tracks", "similar_artists"]}
  invokeInfoFetch={invokeInfoFetch}
  onEntityClick={onEntityClick}
/>
```

The `invokeInfoFetch` and `onEntityClick` callbacks must be passed as props from `App.tsx`. Add these to the component's props interface.

- [ ] **Step 2: Wire `invokeInfoFetch` from App.tsx through usePlugins**

In `App.tsx`, where `usePlugins` is called, destructure the new `invokeInfoFetch` from the hook return:

```typescript
const { ..., invokeInfoFetch } = usePlugins(...);
```

Pass it down to `ArtistDetailContent` in the props.

- [ ] **Step 3: Test manually**

Run: `npm run tauri dev`

1. Enable the `lastfm-info` plugin in Settings > Plugins
2. Navigate to an artist detail page
3. Verify the "About" section appears via the new InformationSections component
4. Verify data is cached (navigate away and back — should load instantly)
5. Verify the existing bespoke "About" section (if still present) can be removed once the new one works

- [ ] **Step 4: Remove the old bespoke "About" section**

In `ArtistDetailContent.tsx`, find the existing "About" section (around line 211-229 which renders `artistBio`) and remove it. Remove `"artist_bio"` from the `exclude` array passed to `InformationSections`.

- [ ] **Step 5: Verify compilation and manual test**

Run: `npx tsc --noEmit && npm run tauri dev`
Expected: No errors. Artist bio now renders through the plugin system.

- [ ] **Step 6: Commit**

```bash
git add src/components/ArtistDetailContent.tsx src/App.tsx
git commit -m "feat: integrate InformationSections into artist detail view, migrate artist_bio"
```

---

## Task 12: Verify End-to-End

- [ ] **Step 1: Run all tests**

Run: `npm run test:all`
Expected: All tests pass.

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Check release build**

Run: `cd src-tauri && cargo check --release`
Expected: Compiles without errors.

- [ ] **Step 4: Manual smoke test**

1. `npm run tauri dev`
2. Add a music collection if not already present
3. Navigate to an artist → verify "About" section loads from lastfm-info plugin
4. Navigate away and back → verify cached data loads instantly
5. Disable the lastfm-info plugin → verify "About" section disappears
6. Re-enable → verify it reappears

- [ ] **Step 5: Final commit if any cleanup needed**

---

## Future Work (Not in This Plan)

These are handled in separate future plans, one info type at a time:

1. Migrate `similar_artists`, `similar_tracks`, `artist_top_tracks`, etc.
2. Migrate `lyrics` (requires special renderer work with LyricsPanel)
3. Migrate `explanation` (Genius)
4. Provider settings UI (drag-reorder providers per info type)
5. Drop `lastfm_cache` and `lyrics` tables after full migration
