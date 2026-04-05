# Information Type Plugin System

**Date:** 2026-04-06
**Status:** Draft

## Overview

A generic information-type system that extends Viboplr's existing plugin infrastructure. Plugins declare what information they can provide for which entities (artists, albums, tracks, tags), and the app handles storage, caching, rendering, and fallback. Internal and external plugins share the same contract.

## Goals

1. **Clean internal architecture** — replace bespoke per-source fetching/caching with a unified system
2. **External plugin API** — third-party JS plugins can add new information types without touching app code
3. **Incremental migration** — existing hardcoded info (Last.fm, Genius, lyrics) migrates one type at a time
4. **Multi-provider fallback** — multiple plugins can provide the same info type with user-configurable priority

## Plugin Manifest Extension

Plugins declare information types in `contributes.informationTypes`:

```json
{
  "id": "lastfm-info",
  "name": "Last.fm Info",
  "version": "1.0.0",
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

### Fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Family ID shared across plugins (e.g. `"lyrics"`, `"artist_bio"`) |
| `name` | string | Display name shown as section heading |
| `entity` | `"artist" \| "album" \| "track" \| "tag"` | Which entity type this attaches to |
| `displayKind` | string | Which generic renderer to use |
| `ttl` | number | Cache lifetime in seconds |
| `order` | number | Section position on detail page (lower = higher) |
| `priority` | number | Default provider priority when multiple plugins register the same ID (lower = tried first). Suggested range: 0-1000. Internal plugins use 100-200; external plugins should use 300+ to slot after built-in providers by default. |

**`order` vs `priority`:** `order` controls where the section appears on the detail page (visual layout). `priority` controls which provider is tried first when multiple plugins provide the same info type (fallback chain). They are independent. Suggested range for both: 0-1000.

## Plugin API Extension

New `informationTypes` namespace added to `ViboplrPluginAPI`:

```ts
interface ViboplrPluginAPI {
  // ... existing namespaces (library, playback, ui, storage, network, tidal, collections, contextMenu) ...
  informationTypes: InformationTypesAPI;
}

interface InformationTypesAPI {
  // Returns an unsubscribe function, consistent with existing plugin API pattern
  // (onTrackStarted, onDeepLink, etc. all return () => void)
  onFetch(
    infoTypeId: string,
    handler: (entity: InfoEntity) => Promise<InfoFetchResult>
  ): () => void;
}

interface InfoEntity {
  kind: "artist" | "album" | "track" | "tag";
  name: string;          // primary name
  id: number;            // library entity ID
  artistName?: string;   // for albums and tracks
  albumTitle?: string;   // for tracks
}

type InfoFetchResult =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "not_found" }
  | { status: "error" };
```

**Implementation note:** In `usePlugins.ts`, each `LoadedPlugin` gets a new field `infoFetchHandlers: Map<string, (entity: InfoEntity) => Promise<InfoFetchResult>>` to store registered handlers. The `onFetch` unsubscribe function removes the entry from this map and is tracked in the plugin's `unsubscribers` array for cleanup during `deactivatePlugin`.

Plugins register handlers during `activate(api)`:

```js
api.informationTypes.onFetch("artist_bio", async (entity) => {
  try {
    const data = await api.network.fetch(`https://.../${entity.name}`);
    if (!data) return { status: "not_found" };
    return { status: "ok", value: { summary: data.bio } };
  } catch (e) {
    return { status: "error" };
  }
});
```

## Database Schema

### information_types

Rebuilt from plugin manifests at startup. Not migrated — ephemeral.

```sql
CREATE TABLE information_types (
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
```

On startup, after rebuilding this table from manifests, the app runs a cleanup step: delete rows from `information_values` whose `information_type_id` has no matching registration in `information_types`. This prevents orphaned cache entries when plugins are removed or stop declaring an info type. If an info type's `display_kind` changes, its cached values are also purged (the old JSON may not match the new renderer's schema).

### information_values

Cached results. Persists across restarts.

```sql
CREATE TABLE information_values (
    information_type_id  TEXT NOT NULL,
    entity_key           TEXT NOT NULL,
    value                TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'ok',
    fetched_at           INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    PRIMARY KEY (information_type_id, entity_key)
);

CREATE INDEX idx_info_values_entity ON information_values(entity_key);
```

- **`entity_key`**: Uses entity database IDs for robustness. Format: `"artist:42"` for artists, `"album:17"` for albums, `"track:103"` for tracks, `"tag:8"` for tags. This avoids canonicalization edge cases (names containing separator characters, collisions after diacritic stripping).
- **`status`**: `"ok"` | `"not_found"` | `"error"`
- **`value`**: JSON blob matching the display kind's schema. Empty `"{}"` for `not_found`/`error` rows.

**Note:** This table stores only the final result of the provider fallback chain, not per-provider results. When cached data is stale, the full fallback chain is replayed from the top (not from a "previous winner"). This keeps the schema simple — a single row per info type per entity.

### information_type_providers

User-configured provider ordering. Created on first user customization; defaults come from manifest `priority`.

```sql
CREATE TABLE information_type_providers (
    information_type_id  TEXT NOT NULL,
    plugin_id            TEXT NOT NULL,
    user_priority        INTEGER NOT NULL,
    enabled              INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (information_type_id, plugin_id)
);
```

## Failure Handling

Three statuses with different TTL behavior:

| Status | Meaning | TTL | Behavior |
|---|---|---|---|
| `ok` | Data retrieved successfully | Info type's TTL | Render normally |
| `not_found` | Plugin searched, data doesn't exist | Info type's TTL | Hide section, don't retry until stale |
| `error` | Transient failure (network, API down) | 1 hour (hardcoded) | Hide section, retry after 1 hour |

Manual "Refresh" action bypasses both TTLs and forces a refetch.

## Fetch Lifecycle

When a user opens a detail page (e.g. artist "Radiohead"):

1. **Query info types**: `SELECT * FROM information_types WHERE entity = 'artist' ORDER BY sort_order`
2. **Query cached values**: For each type, look up `information_values WHERE entity_key = 'artist:42'`
3. **Render decision per type**:
   - `ok` + fresh: render immediately
   - `ok` + stale: render immediately, kick off background refetch
   - `not_found` + fresh: hide section
   - `not_found` + stale: show loading, refetch
   - `error` + fresh (< 1 hour): hide section
   - `error` + stale (> 1 hour): show loading, refetch
   - No cached value: show loading skeleton, fetch
4. **Fetch**: Call the registered plugin handler via the plugin API
5. **Validate**: Check returned JSON matches display kind schema
6. **Store**: Write to `information_values`
7. **Emit event**: Detail view re-renders the section

All fetches for a detail page fire in parallel.

**Concurrent fetch deduplication:** An in-flight map keyed by `(information_type_id, entity_key)` prevents duplicate fetches. If a fetch is already in progress for that key (e.g. user rapidly navigates to the same page), the duplicate is skipped. When the user navigates away, in-flight fetches continue to completion and write to cache (useful for next visit) but do not emit UI updates to the now-unmounted component.

## Multi-Provider Fallback

When multiple plugins register the same info type ID:

1. Get providers ordered by `user_priority` (from `information_type_providers`) or manifest `priority`
2. Try provider #1:
   - `ok`: store with that `plugin_id`, done
   - `not_found`: try provider #2
   - `error`: try provider #2 (log the error)
3. Try provider #2, and so on
4. All exhausted with `not_found`: store `not_found`
5. All exhausted with `error`: store `error`

When cached data is stale, the full fallback chain is replayed from the top. The `information_values` table stores only the final aggregate result, not per-provider results.

**Settings UI**: Plugins tab gets a "Providers" subsection where users can drag-reorder and enable/disable providers per info type.

## Display Kinds & Renderers

Eight generic renderers cover all existing and foreseeable information types:

| Display Kind | JSON Schema | Renders As | Covers |
|---|---|---|---|
| `rich_text` | `{ summary: string, full?: string }` (HTML) | Collapsible rich text block | Artist bio, album review |
| `entity_list` | `{ items: [{ name, subtitle?, match?, image?, url?, libraryId?, libraryKind? }] }` | List with optional match bars | Similar tracks, similar artists |
| `stat_grid` | `{ items: [{ label, value, unit? }] }` | Grid of stat cards | Listeners, scrobbles, play count |
| `lyrics` | `{ text: string, kind: "plain"\|"synced", lines?: [...] }` | Lyrics view with optional sync | Lyrics |
| `tag_list` | `{ tags: [{ name, url? }], suggestable?: boolean }` | Tag pills, optionally actionable | Community tags, top tags |
| `ranked_list` | `{ items: [{ name, subtitle?, value: number, maxValue?: number, libraryId?, libraryKind? }] }` | Rows with popularity bars | Top tracks, track popularity |
| `annotated_text` | `{ overview?: string, sections: [{ heading?, text }] }` | Structured text sections | Genius explanations |
| `key_value` | `{ items: [{ key, value }] }` | Two-column detail rows | Audio properties |

Renderer lookup is a static map:

```tsx
const renderers: Record<string, ComponentType<{ data: unknown }>> = {
  rich_text: RichTextRenderer,
  entity_list: EntityListRenderer,
  stat_grid: StatGridRenderer,
  lyrics: LyricsRenderer,
  tag_list: TagListRenderer,
  ranked_list: RankedListRenderer,
  annotated_text: AnnotatedTextRenderer,
  key_value: KeyValueRenderer,
};
```

### Renderer Interactivity

Renderers emit standardized callbacks:
- `onEntityClick(kind, id?, name?)` — navigate to entity
- `onAction(actionId, payload)` — trigger actions (play track, open URL, apply tags)

### Lyrics Renderer — Special Case

The `LyricsRenderer` wraps the existing `LyricsPanel` with these additional concerns:

- **Playback sync**: Receives playback position as a prop from the detail view for real-time line highlighting
- **Manual editing**: User edits write to `information_values` with `plugin_id: "manual"`, overriding the provider chain. Reset deletes the manual entry and triggers a normal provider fetch.
- **FTS indexing**: On any write where `information_type_id = "lyrics"`, the storage layer additionally updates the `tracks_fts` index (stripping LRC timestamps for synced lyrics).

These concerns are scoped to the renderer and storage layer, not the plugin system.

## Frontend: InformationSections Component

A generic component that replaces bespoke detail view sections:

```tsx
<InformationSections
  entity={{ kind: "artist", name: "Radiohead", id: 42 }}
  exclude={["similar_tracks"]}  // for incremental migration
/>
```

Behavior:
1. Queries registered info types for the entity kind, sorted by `sort_order`
2. For each type, looks up cached value + status
3. Renders a collapsible section with the info type's `name` as heading
4. Delegates to the appropriate display-kind renderer
5. Sections with `not_found` or fresh `error` are hidden entirely
6. Sections still loading show a skeleton placeholder
7. Stale sections render cached data immediately (refetch happens silently)

During incremental migration, `exclude` allows mixing old hardcoded sections with new plugin-driven ones.

## Internal Plugins

Existing hardcoded sources become bundled plugins in `src-tauri/plugins/`:

### lastfm-info

| Info Type ID | Entity | Display Kind |
|---|---|---|
| `artist_bio` | artist | `rich_text` |
| `artist_stats` | artist | `stat_grid` |
| `artist_top_tracks` | artist | `ranked_list` |
| `similar_artists` | artist | `entity_list` |
| `similar_tracks` | track | `entity_list` |
| `track_stats` | track | `stat_grid` |
| `community_tags` | track | `tag_list` |
| `album_review` | album | `rich_text` |
| `album_track_popularity` | album | `ranked_list` |

### lrclib-info (or genius-info)

| Info Type ID | Entity | Display Kind |
|---|---|---|
| `lyrics` | track | `lyrics` |
| `explanation` | track | `annotated_text` |

These plugins call existing Tauri commands (`lastfm_get_artist_info`, `fetch_lyrics`, etc.) via `invoke()` inside their `onFetch` handlers. No Rust refactoring needed initially.

## Migration Strategy

Incremental, one info type at a time:

1. **`artist_bio`** — simplest rich_text, validates the full pipeline end-to-end
2. **`similar_artists`** — validates entity_list renderer
3. **`similar_tracks`** — same renderer, different entity
4. **`artist_top_tracks`** + **`album_track_popularity`** — validates ranked_list
5. **`track_stats`** + **`artist_stats`** — validates stat_grid
6. **`community_tags`** — validates tag_list
7. **`lyrics`** — validates lyrics renderer, migrates off dedicated `lyrics` table. **FTS note:** the `rebuild_fts()` logic in `db.rs` must be updated to read lyrics from `information_values` (where `information_type_id = 'lyrics'`) instead of the `lyrics` table. LRC timestamps are still stripped before indexing.
8. **`explanation`** — validates annotated_text
9. **`album_review`** — final cleanup

Each step:
1. Create the internal plugin's `onFetch` handler calling the existing Tauri command
2. Add the info type to the plugin manifest
3. Remove the bespoke section from the detail view, let `<InformationSections>` render it
4. Migrate existing `lastfm_cache` / `lyrics` data to `information_values` (one-time DB migration)
5. After all types from a table are migrated, drop the old table

## Plugin Management

- **Directory-based**: Plugins are folders in `{app_dir}/plugins/` (already implemented)
- **Settings UI**: Existing Plugins tab handles enable/disable/configure (already implemented)
- **New addition**: Provider ordering UI in Settings > Plugins for info types with multiple providers

## Non-Goals

- Custom plugin-provided renderers (Approach B) — not needed now, can be added later
- Plugin-driven prefetching — all fetches are app-initiated on view
- Breaking changes to existing plugin API — this is purely additive
