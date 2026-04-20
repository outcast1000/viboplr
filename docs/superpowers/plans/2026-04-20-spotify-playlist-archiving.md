# Spotify Playlist Auto-Refresh & Archiving Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Rust-backed plugin scheduler, a plugin badge API, and Spotify playlist auto-refresh with archiving of dynamic playlists.

**Architecture:** Three layers built bottom-up: (1) Rust scheduler with DB persistence and background thread, (2) frontend badge API and scheduler wiring in usePlugins/Sidebar, (3) Spotify plugin logic for auto-refresh, change detection, and archiving.

**Tech Stack:** Rust (Tauri 2, SQLite), TypeScript (React), ES5 plugin JS

**Spec:** `docs/superpowers/specs/2026-04-20-spotify-playlist-archiving-design.md`

---

## Task 1: Rust Scheduler — DB Schema & CRUD

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Write the `plugin_schedules` table migration**

In `run_migrations()` (after the version 26 block around line 564), add a version 27 migration:

```rust
if version < 27 {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS plugin_schedules (
            plugin_id  TEXT NOT NULL,
            task_id    TEXT NOT NULL,
            interval_ms INTEGER NOT NULL,
            last_run   INTEGER,
            PRIMARY KEY (plugin_id, task_id)
        );
        UPDATE db_version SET version = 27 WHERE rowid = 1;"
    ).map_err(|e| format!("Migration to v27 failed: {e}"))?;
}
```

Also update the initial schema version from 26 to 27 (line 391).

- [ ] **Step 2: Write CRUD functions**

Add these functions to `impl Database` (after the existing `plugin_storage_delete` around line 2699):

```rust
pub fn plugin_scheduler_register(&self, plugin_id: &str, task_id: &str, interval_ms: i64) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plugin_schedules (plugin_id, task_id, interval_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id, task_id) DO UPDATE SET interval_ms = excluded.interval_ms",
        params![plugin_id, task_id, interval_ms],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn plugin_scheduler_unregister(&self, plugin_id: &str, task_id: &str) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM plugin_schedules WHERE plugin_id = ?1 AND task_id = ?2",
        params![plugin_id, task_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn plugin_scheduler_unregister_all(&self, plugin_id: &str) -> Result<(), String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM plugin_schedules WHERE plugin_id = ?1",
        params![plugin_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn plugin_scheduler_complete(&self, plugin_id: &str, task_id: &str) -> Result<bool, String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as i64;
    let rows = conn.execute(
        "UPDATE plugin_schedules SET last_run = ?1 WHERE plugin_id = ?2 AND task_id = ?3",
        params![now, plugin_id, task_id],
    ).map_err(|e| e.to_string())?;
    Ok(rows > 0)
}

pub fn plugin_scheduler_get_all(&self) -> Result<Vec<(String, String, i64, Option<i64>)>, String> {
    let conn = self.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT plugin_id, task_id, interval_ms, last_run FROM plugin_schedules"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, Option<i64>>(3)?,
        ))
    }).map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Write tests for scheduler DB functions**

Add to the `#[cfg(test)] mod tests` block in `db.rs`:

```rust
#[test]
fn test_plugin_scheduler_register_and_get() {
    let db = test_db();
    db.plugin_scheduler_register("spotify", "refresh", 86400000).unwrap();
    let all = db.plugin_scheduler_get_all().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, "spotify");
    assert_eq!(all[0].1, "refresh");
    assert_eq!(all[0].2, 86400000);
    assert!(all[0].3.is_none());
}

#[test]
fn test_plugin_scheduler_complete() {
    let db = test_db();
    db.plugin_scheduler_register("spotify", "refresh", 86400000).unwrap();
    let updated = db.plugin_scheduler_complete("spotify", "refresh").unwrap();
    assert!(updated);
    let all = db.plugin_scheduler_get_all().unwrap();
    assert!(all[0].3.is_some());
}

#[test]
fn test_plugin_scheduler_complete_nonexistent() {
    let db = test_db();
    let updated = db.plugin_scheduler_complete("nope", "nope").unwrap();
    assert!(!updated);
}

#[test]
fn test_plugin_scheduler_unregister() {
    let db = test_db();
    db.plugin_scheduler_register("spotify", "refresh", 86400000).unwrap();
    db.plugin_scheduler_unregister("spotify", "refresh").unwrap();
    let all = db.plugin_scheduler_get_all().unwrap();
    assert!(all.is_empty());
}

#[test]
fn test_plugin_scheduler_unregister_all() {
    let db = test_db();
    db.plugin_scheduler_register("spotify", "a", 1000).unwrap();
    db.plugin_scheduler_register("spotify", "b", 2000).unwrap();
    db.plugin_scheduler_register("other", "c", 3000).unwrap();
    db.plugin_scheduler_unregister_all("spotify").unwrap();
    let all = db.plugin_scheduler_get_all().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].0, "other");
}
```

- [ ] **Step 4: Run Rust tests**

Run: `cd src-tauri && cargo test plugin_scheduler -- --nocapture`
Expected: all 5 tests pass

- [ ] **Step 5: Commit**

```
feat: add plugin_schedules DB table and CRUD functions
```

---

## Task 2: Rust Scheduler — Commands & Background Thread

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add Tauri commands**

In `commands.rs`, add after `delete_user_plugin` (around line 2904):

```rust
#[tauri::command]
pub fn plugin_scheduler_register(state: State<'_, AppState>, plugin_id: String, task_id: String, interval_ms: i64) -> Result<(), String> {
    state.db.plugin_scheduler_register(&plugin_id, &task_id, interval_ms)
}

#[tauri::command]
pub fn plugin_scheduler_unregister(state: State<'_, AppState>, plugin_id: String, task_id: String) -> Result<(), String> {
    state.db.plugin_scheduler_unregister(&plugin_id, &task_id)
}

#[tauri::command]
pub fn plugin_scheduler_complete(state: State<'_, AppState>, plugin_id: String, task_id: String) -> Result<bool, String> {
    state.db.plugin_scheduler_complete(&plugin_id, &task_id)
}
```

- [ ] **Step 2: Add scheduler cleanup to `delete_user_plugin`**

Modify `delete_user_plugin` in `commands.rs` to clean up schedules before deleting:

```rust
#[tauri::command]
pub fn delete_user_plugin(state: State<'_, AppState>, plugin_id: String) -> Result<(), String> {
    let user_dir = crate::plugins::plugins_dir(&state.app_dir).join(&plugin_id);
    if !user_dir.exists() {
        return Err(format!("Plugin '{}' is not a user plugin or does not exist", plugin_id));
    }
    let _ = state.db.plugin_scheduler_unregister_all(&plugin_id);
    crate::plugins::delete_plugin(&state.app_dir, &plugin_id)
}
```

- [ ] **Step 3: Register commands in `lib.rs`**

In the `invoke_handler` chain (both debug and release blocks), add the three new commands alongside the existing `plugin_storage_*` commands:

```rust
commands::plugin_scheduler_register,
commands::plugin_scheduler_unregister,
commands::plugin_scheduler_complete,
```

- [ ] **Step 4: Add scheduler background thread in `lib.rs`**

In the `.setup()` closure, after existing background thread spawns, add:

```rust
// Plugin scheduler background thread
{
    let app_handle = app.handle().clone();
    let db = Arc::clone(&db);
    std::thread::spawn(move || {
        use std::collections::HashSet;
        use std::time::{Duration, SystemTime, UNIX_EPOCH};

        let mut dispatched: HashSet<(String, String)> = HashSet::new();

        // Wait for frontend to be ready
        std::thread::sleep(Duration::from_secs(5));

        loop {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64;

            if let Ok(schedules) = db.plugin_scheduler_get_all() {
                // Clean up dispatched set: remove entries whose last_run is now recent
                dispatched.retain(|(pid, tid)| {
                    schedules.iter().any(|(p, t, interval, lr)| {
                        p == pid && t == tid && match lr {
                            Some(last) => (now - last) >= *interval,
                            None => true,
                        }
                    })
                });

                // Dispatch due tasks
                for (plugin_id, task_id, interval_ms, last_run) in &schedules {
                    let key = (plugin_id.clone(), task_id.clone());
                    if dispatched.contains(&key) {
                        continue;
                    }
                    let is_due = match last_run {
                        None => true,
                        Some(lr) => (now - lr) >= *interval_ms,
                    };
                    if is_due {
                        dispatched.insert(key);
                        let _ = app_handle.emit(
                            "plugin-scheduler-due",
                            serde_json::json!({
                                "pluginId": plugin_id,
                                "taskId": task_id,
                            }),
                        );
                    }
                }
            }

            std::thread::sleep(Duration::from_secs(60));
        }
    });
}
```

- [ ] **Step 5: Verify Rust compiles**

Run: `cd src-tauri && cargo check`
Expected: no errors

- [ ] **Step 6: Commit**

```
feat: add plugin scheduler commands and background thread
```

---

## Task 3: Frontend — Plugin Badge API

**Files:**
- Modify: `src/types/plugin.ts`
- Modify: `src/hooks/usePlugins.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/Sidebar.css`

- [ ] **Step 1: Add badge types to `plugin.ts`**

Add after the `PluginUIAPI` interface (around line 303):

```typescript
export type PluginBadge =
  | null
  | { type: "dot"; variant: "accent" | "error" }
  | { type: "count"; value: number; variant: "accent" | "error" };
```

Add `setBadge` to `PluginUIAPI`:

```typescript
setBadge(viewId: string, badge: PluginBadge): void;
```

- [ ] **Step 2: Implement badge state in `usePlugins.ts`**

Add a badge state ref and setter alongside the existing `viewDataRef` (around line 95):

```typescript
const badgeMapRef = useRef<Map<string, PluginBadge>>(new Map());
const [badgeMap, setBadgeMap] = useState<Map<string, PluginBadge>>(new Map());
```

Import `PluginBadge` from `../types/plugin`.

In `buildAPI`, inside the `ui` object (after `requestAction`), add:

```typescript
setBadge: (viewId: string, badge: PluginBadge) => {
  const key = `${pluginId}:${viewId}`;
  if (badge === null) {
    badgeMapRef.current.delete(key);
  } else {
    badgeMapRef.current.set(key, badge);
  }
  setBadgeMap(new Map(badgeMapRef.current));
},
```

In `deactivatePlugin`, clear badges for the plugin (alongside the existing view data cleanup):

```typescript
for (const key of badgeMapRef.current.keys()) {
  if (key.startsWith(`${pluginId}:`)) {
    badgeMapRef.current.delete(key);
  }
}
setBadgeMap(new Map(badgeMapRef.current));
```

Expose `badgeMap` in the hook's return value alongside existing returns.

- [ ] **Step 3: Render badges in `Sidebar.tsx`**

Add `badgeMap` to the Sidebar props (the `PluginBadge` type should be imported):

```typescript
badgeMap?: Map<string, PluginBadge>;
```

In the plugin sidebar item rendering section, after the icon/label, add badge rendering:

```typescript
{(() => {
  const badge = badgeMap?.get(`${item.pluginId}:${item.id}`);
  if (!badge) return null;
  if (badge.type === "dot") {
    return <span className={`plugin-badge-dot plugin-badge--${badge.variant}`} />;
  }
  if (badge.type === "count") {
    return (
      <span className={`plugin-badge-count plugin-badge--${badge.variant}`}>
        {badge.value > 99 ? "99+" : badge.value}
      </span>
    );
  }
  return null;
})()}
```

- [ ] **Step 4: Add badge CSS to `Sidebar.css`**

```css
.nav-btn {
  position: relative;
}

.plugin-badge-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  position: absolute;
  top: 4px;
  right: 4px;
}

.plugin-badge-count {
  position: absolute;
  top: 2px;
  right: 2px;
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
  padding: 1px 5px;
  border-radius: 8px;
  color: white;
}

.plugin-badge--accent {
  background: var(--accent);
}

.plugin-badge--error {
  background: var(--error);
}
```

- [ ] **Step 5: Pass badgeMap from App.tsx to Sidebar**

In `App.tsx`, pass `badgeMap={plugins.badgeMap}` to the `<Sidebar>` component.

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```
feat: add plugin badge API with dot and count variants
```

---

## Task 4: Frontend — Scheduler API Wiring

**Files:**
- Modify: `src/types/plugin.ts`
- Modify: `src/hooks/usePlugins.ts`

- [ ] **Step 1: Add scheduler types to `plugin.ts`**

Add the `PluginSchedulerAPI` interface:

```typescript
export interface PluginSchedulerAPI {
  register(taskId: string, intervalMs: number): Promise<void>;
  unregister(taskId: string): Promise<void>;
  complete(taskId: string): Promise<boolean>;
  onDue(taskId: string, handler: () => void): () => void;
}
```

Add `scheduler` to `ViboplrPluginAPI`:

```typescript
scheduler: PluginSchedulerAPI;
```

- [ ] **Step 2: Implement scheduler in `buildAPI` in `usePlugins.ts`**

Add a `schedulerHandlers` map to the `LoadedPlugin` interface:

```typescript
schedulerHandlers: Map<string, () => void>;
```

Initialize it in the plugin loading code where other handler maps are initialized:

```typescript
schedulerHandlers: new Map(),
```

In `buildAPI`, add the `scheduler` section:

```typescript
scheduler: {
  async register(taskId: string, intervalMs: number): Promise<void> {
    await invoke("plugin_scheduler_register", { pluginId, taskId, intervalMs });
  },
  async unregister(taskId: string): Promise<void> {
    await invoke("plugin_scheduler_unregister", { pluginId, taskId });
  },
  async complete(taskId: string): Promise<boolean> {
    return await invoke<boolean>("plugin_scheduler_complete", { pluginId, taskId });
  },
  onDue(taskId: string, handler: () => void): () => void {
    loaded.schedulerHandlers.set(taskId, handler);
    return () => { loaded.schedulerHandlers.delete(taskId); };
  },
},
```

- [ ] **Step 3: Listen for scheduler events**

Add a new `useEffect` block (similar to the OAuth callback listener pattern around line 594 in `usePlugins.ts`):

```typescript
useEffect(() => {
  const unlisten = listen<{ pluginId: string; taskId: string }>(
    "plugin-scheduler-due",
    (event) => {
      const { pluginId, taskId } = event.payload;
      const loaded = loadedPluginsRef.current.get(pluginId);
      if (!loaded) return;
      const handler = loaded.schedulerHandlers.get(taskId);
      if (handler) {
        try { handler(); } catch (e) { console.error(`Scheduler handler error [${pluginId}:${taskId}]:`, e); }
      }
    }
  );
  return () => { unlisten.then(fn => fn()); };
}, []);
```

- [ ] **Step 4: Clear scheduler handlers on deactivation**

In `deactivatePlugin`, add:

```typescript
loaded.schedulerHandlers.clear();
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```
feat: wire plugin scheduler API to frontend
```

---

## Task 5: Spotify Plugin — Refactor Scrape & Add Auto-Refresh

**Files:**
- Modify: `src-tauri/plugins/spotify-browse/index.js`

- [ ] **Step 1: Add new state fields**

Add to the state object (around line 8):

```javascript
archivedIds: [],
updatedPlaylistIds: {},  // object used as set (ES5), keys are playlist IDs
refreshing: false,
savedAt: null,
archiveIndex: [],
```

- [ ] **Step 2: Add helper functions**

Add after the state declaration, before the render functions:

```javascript
var DYNAMIC_PREFIXES = [
  "Discover Weekly", "Daily Mix", "Release Radar",
  "Repeat Rewind", "On Repeat", "Your Top Songs"
];

function isArchivable(playlist) {
  if (state.archivedIds.indexOf(playlist.id) !== -1) return true;
  for (var i = 0; i < DYNAMIC_PREFIXES.length; i++) {
    if (playlist.name.indexOf(DYNAMIC_PREFIXES[i]) === 0) return true;
  }
  return false;
}

function tracksChanged(oldTracks, newTracks) {
  if (!oldTracks || oldTracks.length !== newTracks.length) return true;
  var oldSet = {};
  for (var i = 0; i < oldTracks.length; i++) {
    oldSet[oldTracks[i].name + "\0" + oldTracks[i].artist] = true;
  }
  for (var j = 0; j < newTracks.length; j++) {
    if (!oldSet[newTracks[j].name + "\0" + newTracks[j].artist]) return true;
  }
  return false;
}

function generateArchiveId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function saveState() {
  state.savedAt = Date.now();
  api.storage.set("spotify_browse_state", {
    playlists: state.playlists,
    playlistTracks: state.playlistTracks,
    savedAt: state.savedAt,
    archivedIds: state.archivedIds,
  }).catch(console.error);
}
```

Also delete the existing `saveToStorage` function (around line 709) and replace all its call sites with `saveState()`.

- [ ] **Step 3: Extract `performScrape` from existing scrape flow**

The existing scrape flow is triggered by the `open-spotify` action handler. It uses callbacks: `browseHandle.onMessage` dispatches to functions that update state and call `render()`. To make this reusable, wrap it in a Promise.

Create `performScrape(showProgress)` that returns `Promise<{ playlists, tracks } | null>`:

```javascript
function performScrape(showProgress) {
  return new Promise(function(resolve, reject) {
    var scrapeResult = { playlists: [], tracks: {} };

    // Open hidden browse window
    api.network.openBrowseWindow("https://open.spotify.com", {
      width: 1200, height: 800, visible: false,
    }).then(function(handle) {
      browseHandle = handle;
      var loginRetries = 0;
      var loginTimer = null;

      function cleanup() {
        if (loginTimer) clearInterval(loginTimer);
        if (browseHandle) { browseHandle.close(); browseHandle = null; }
      }

      function fail(err) {
        cleanup();
        reject(err);
      }

      // Phase 1: Check login (poll every 3s, max 10 tries)
      if (showProgress) { state.status = "waiting-login"; render(); }
      loginTimer = setInterval(function() {
        loginRetries++;
        if (loginRetries > 10) {
          clearInterval(loginTimer);
          cleanup();
          resolve(null); // not logged in
          return;
        }
        handle.eval(SCRIPT_CHECK_LOGIN);
      }, 3000);

      handle.onMessage(function(type, data) {
        // Reuse existing message types: "login-status", "playlists", "tracks"
        if (type === "login-status") {
          if (data && data.loggedIn) {
            clearInterval(loginTimer);
            // Phase 2: Find Made for You
            if (showProgress) { state.status = "finding-made-for-you"; render(); }
            startMadeForYouSearch(handle, showProgress, scrapeResult, resolve, fail);
          } else if (loginRetries >= 10) {
            clearInterval(loginTimer);
            cleanup();
            resolve(null);
          }
        } else if (type === "playlists") {
          scrapeResult.playlists = data || [];
          if (showProgress) {
            state.status = "scraping-tracks";
            state.scrapeProgress = { current: 0, total: scrapeResult.playlists.length, name: "" };
            render();
          }
          startTrackScrape(handle, showProgress, scrapeResult, resolve, cleanup);
        } else if (type === "tracks") {
          if (data && data.playlistId) {
            scrapeResult.tracks[data.playlistId] = data.tracks || [];
          }
          // Track scrape progress handled by startTrackScrape
        }
      });
    }).catch(reject);
  });
}
```

The helper functions `startMadeForYouSearch` and `startTrackScrape` extract the retry loops from the existing code:

```javascript
function startMadeForYouSearch(handle, showProgress, result, resolve, fail) {
  var retries = 0;
  function attempt() {
    retries++;
    if (retries > 15) {
      // Fall back to scraping whatever playlists are visible
      handle.eval(SCRIPT_SCRAPE_PLAYLISTS);
      return;
    }
    handle.eval(SCRIPT_FIND_MADE_FOR_YOU);
    setTimeout(function() {
      // If playlists haven't arrived yet, retry
      if (result.playlists.length === 0) attempt();
    }, 2000);
  }
  // Wait for initial page load
  setTimeout(function() { attempt(); }, 2000);
}

function startTrackScrape(handle, showProgress, result, resolve, cleanup) {
  var queue = result.playlists.slice();
  var idx = 0;

  function scrapeNext() {
    if (idx >= queue.length) {
      cleanup();
      resolve(result);
      return;
    }
    var pl = queue[idx];
    idx++;
    if (showProgress) {
      state.scrapeProgress = { current: idx, total: queue.length, name: pl.name };
      render();
    }
    handle.eval(scriptNavigatePlaylist(pl.id));
    setTimeout(function() {
      handle.eval(scriptScrollThenScrape(pl.id, 0));
      // Wait for tracks message, then continue
      var trackTimeout = setTimeout(function() {
        scrapeNext(); // timeout: move on
      }, 45000);

      // The onMessage handler in performScrape will receive "tracks"
      // We need a way to know this specific playlist's tracks arrived.
      // Use a one-shot check: poll result.tracks for this playlist
      var checkInterval = setInterval(function() {
        if (result.tracks[pl.id]) {
          clearTimeout(trackTimeout);
          clearInterval(checkInterval);
          setTimeout(scrapeNext, 1000);
        }
      }, 500);
    }, 4000);
  }

  scrapeNext();
}
```

**Note:** The existing `open-spotify` action handler should be updated to call `performScrape(true)` instead of duplicating the scrape logic. The `state.browserVisible` toggle and debug log can remain for the manual "Open Spotify" flow but `performScrape` always uses a hidden window.

- [ ] **Step 4: Add change detection and archiving logic**

```javascript
function processRefreshResults(newPlaylists, newTracks) {
  var hasChanges = false;
  var archivedCount = 0;

  for (var i = 0; i < newPlaylists.length; i++) {
    var pl = newPlaylists[i];
    var oldTracks = state.playlistTracks[pl.id];
    var fresh = newTracks[pl.id] || [];

    if (tracksChanged(oldTracks, fresh)) {
      hasChanges = true;
      state.updatedPlaylistIds[pl.id] = true;

      if (isArchivable(pl) && oldTracks && oldTracks.length > 0) {
        archiveSnapshot(pl, oldTracks);
        archivedCount++;
      }
    }
  }

  state.playlists = newPlaylists;
  state.playlistTracks = newTracks;
  saveState();
  return { hasChanges: hasChanges, archivedCount: archivedCount };
}

function archiveSnapshot(playlist, tracks) {
  var archiveId = generateArchiveId();
  var dateStr = new Date(state.savedAt || Date.now())
    .toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  var name = playlist.name + " \u2014 " + dateStr;

  var snapshot = {
    name: name,
    playlistId: playlist.id,
    date: new Date().toISOString(),
    tracks: tracks,
  };
  api.storage.set("spotify_browse_archive:" + archiveId, snapshot).catch(console.error);

  // Update index (read-modify-write)
  api.storage.get("spotify_browse_archive_index").then(function(index) {
    var arr = index || [];
    arr.push({
      playlistId: playlist.id,
      name: name,
      date: snapshot.date,
      storageKey: archiveId,
      trackCount: tracks.length,
    });
    state.archiveIndex = arr;
    return api.storage.set("spotify_browse_archive_index", arr);
  }).catch(console.error);
}
```

- [ ] **Step 5: Add `silentRefresh` and `manualRefresh`**

```javascript
function silentRefresh() {
  if (state.refreshing) return;
  state.refreshing = true;

  performScrape(false).then(function(result) {
    state.refreshing = false;
    if (!result) {
      api.ui.setBadge("spotify", { type: "dot", variant: "error" });
      return;
    }
    var outcome = processRefreshResults(result.playlists, result.tracks);
    if (outcome.hasChanges) {
      api.ui.setBadge("spotify", { type: "dot", variant: "accent" });
    }
    api.scheduler.complete("auto-refresh").catch(console.error);
    state.status = "done";
    render();
  }).catch(function(err) {
    state.refreshing = false;
    console.error("Silent refresh failed:", err);
    api.ui.setBadge("spotify", { type: "dot", variant: "error" });
  });
}

api.ui.onAction("manual-refresh", function() {
  if (state.refreshing) return;
  state.refreshing = true;
  state.status = "waiting-login";
  render();

  performScrape(true).then(function(result) {
    state.refreshing = false;
    if (!result) {
      state.status = "error";
      state.errorMessage = "Not logged in to Spotify. Click 'Open Spotify' to log in.";
      render();
      return;
    }
    var outcome = processRefreshResults(result.playlists, result.tracks);
    state.status = "done";
    var updatedCount = Object.keys(state.updatedPlaylistIds).length;
    if (updatedCount > 0) {
      state.refreshSummary = "Updated " + updatedCount + " playlist" + (updatedCount > 1 ? "s" : "")
        + (outcome.archivedCount > 0 ? ", archived " + outcome.archivedCount + " snapshot" + (outcome.archivedCount > 1 ? "s" : "") : "");
    } else {
      state.refreshSummary = "No changes detected.";
    }
    render();
  }).catch(function(err) {
    state.refreshing = false;
    state.status = "error";
    state.errorMessage = "Refresh failed: " + (err.message || err);
    render();
  });
});
```

- [ ] **Step 6: Add storage migration and scheduler registration**

Replace the existing `api.storage.get("spotify_browse_playlists")` block at the bottom of `activate` with:

```javascript
// Restore state (with legacy migration)
api.storage.get("spotify_browse_state").then(function(saved) {
  if (saved && saved.playlists && saved.playlists.length > 0) {
    state.playlists = saved.playlists;
    state.playlistTracks = saved.playlistTracks || {};
    state.archivedIds = saved.archivedIds || [];
    state.savedAt = saved.savedAt || null;
    state.status = "done";
    render();
  } else {
    api.storage.get("spotify_browse_playlists").then(function(legacy) {
      if (legacy && legacy.playlists && legacy.playlists.length > 0) {
        state.playlists = legacy.playlists;
        state.playlistTracks = legacy.tracks || {};
        state.archivedIds = [];
        state.status = "done";
        saveState();
        api.storage.delete("spotify_browse_playlists").catch(console.error);
        render();
      }
    }).catch(console.error);
  }
}).catch(console.error);

// Load archive index
api.storage.get("spotify_browse_archive_index").then(function(index) {
  state.archiveIndex = index || [];
}).catch(console.error);

// Register 24h auto-refresh scheduler
api.scheduler.register("auto-refresh", 24 * 60 * 60 * 1000).catch(console.error);
api.scheduler.onDue("auto-refresh", function() {
  silentRefresh();
});
```

- [ ] **Step 7: Commit**

```
feat: add Spotify auto-refresh, change detection, and archiving
```

---

## Task 6: Spotify Plugin — Archive UI

**Files:**
- Modify: `src-tauri/plugins/spotify-browse/index.js`

- [ ] **Step 1: Add Refresh button to `renderHome`**

In the `renderHome` function, after the "Open Spotify" button in the header area, add a Refresh button:

```javascript
{
  type: "button",
  label: state.refreshing ? "Refreshing..." : "Refresh",
  action: "manual-refresh",
  disabled: state.refreshing,
  variant: "secondary",
}
```

- [ ] **Step 2: Add "updated" indicator to playlist cards**

In the card grid items mapping (inside `renderHome` where playlist cards are built), add a visual indicator for updated playlists. Prefix the subtitle with a bullet character when updated:

```javascript
subtitle: (state.updatedPlaylistIds.has(pl.id) ? "\u2022 Updated \u2014 " : "") + trackCount + " tracks",
```

- [ ] **Step 3: Add Archived section to `renderHome`**

The archive index is already loaded into `state.archiveIndex` during init (Task 5, Step 6). Render it directly in `renderHome` — no async loading needed:

```javascript
// Archived section (append to existing children array `ch`)
var archiveItems = (state.archiveIndex || []).map(function(entry) {
  return {
    id: "archive:" + entry.storageKey,
    title: entry.name,
    subtitle: entry.trackCount + " tracks",
    action: "view-archive",
  };
});

if (archiveItems.length > 0) {
  ch.push({ type: "text", content: "<h3>Archived</h3>" });
  ch.push({
    type: "track-row-list",
    items: archiveItems,
    actions: [
      { id: "delete-archive", label: "Delete", icon: "\u{1F5D1}" },
    ],
  });
}
```

- [ ] **Step 4: Add archive view and delete handlers**

```javascript
api.ui.onAction("view-archive", function(data) {
  if (!data || !data.itemId) return;
  var key = data.itemId.replace("archive:", "");
  api.storage.get("spotify_browse_archive:" + key).then(function(snapshot) {
    if (!snapshot) return;
    state.viewStack.push({ view: state.currentView });
    state.currentView = "archive-detail";
    state.currentArchive = snapshot;
    state.currentArchiveKey = key;
    render();
  }).catch(console.error);
});

api.ui.onAction("delete-archive", function(data) {
  if (!data || !data.selectedIds) return;
  // Collect keys to delete
  var keysToDelete = {};
  for (var i = 0; i < data.selectedIds.length; i++) {
    var key = data.selectedIds[i].replace("archive:", "");
    keysToDelete[key] = true;
  }
  // Delete individual snapshots
  var promises = Object.keys(keysToDelete).map(function(key) {
    return api.storage.delete("spotify_browse_archive:" + key);
  });
  // Batch-update the index (single read-filter-write)
  Promise.all(promises).then(function() {
    var filtered = (state.archiveIndex || []).filter(function(e) {
      return !keysToDelete[e.storageKey];
    });
    state.archiveIndex = filtered;
    return api.storage.set("spotify_browse_archive_index", filtered);
  }).then(function() {
    render();
  }).catch(console.error);
});
```

- [ ] **Step 5: Add archive detail rendering**

In the `render` function, add the archive-detail case:

```javascript
function renderArchiveDetail() {
  var archive = state.currentArchive;
  if (!archive) return;
  var ch = [
    {
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "\u2190 Back", action: "go-back", variant: "secondary" },
        { type: "text", content: "<strong>" + escapeHtml(archive.name) + "</strong> \u2014 " + archive.tracks.length + " tracks" },
      ],
    },
  ];

  if (archive.tracks.length > 0) {
    ch.push({
      type: "track-row-list",
      items: archive.tracks.map(function(t, i) {
        return {
          id: "archived-track:" + i,
          title: t.name,
          subtitle: t.artist + (t.album ? " \u2014 " + t.album : ""),
          duration: t.duration,
          imageUrl: t.imageUrl,
        };
      }),
    });
  }

  api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
}
```

Add to `render()`:

```javascript
else if (state.currentView === "archive-detail") renderArchiveDetail();
```

- [ ] **Step 6: Add archive toggle in playlist detail**

In `renderPlaylist`, add an "Archive snapshots" toggle for the current playlist:

```javascript
{
  type: "toggle",
  label: isArchivable(state.currentPlaylist)
    ? "Archive snapshots (auto-detected)"
    : "Archive snapshots",
  value: isArchivable(state.currentPlaylist),
  action: "toggle-archive",
}
```

Handler:

```javascript
api.ui.onAction("toggle-archive", function() {
  if (!state.currentPlaylist) return;
  var id = state.currentPlaylist.id;
  var idx = state.archivedIds.indexOf(id);
  if (idx === -1) {
    state.archivedIds.push(id);
  } else {
    state.archivedIds.splice(idx, 1);
  }
  saveState();
  render();
});
```

- [ ] **Step 7: Clear badge when user visits Spotify view**

Use `api.ui.onAction` with a navigation event, or add to the render function — when `state.currentView === "home"`, clear the badge:

At the top of `renderHome`:

```javascript
api.ui.setBadge("spotify", null);
```

- [ ] **Step 8: Commit**

```
feat: add Spotify archive UI, refresh button, and archive management
```

---

## Task 7: Integration Testing & Cleanup

**Files:**
- All modified files

- [ ] **Step 1: Run full Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: all tests pass

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Run frontend tests**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 4: Manual testing checklist**

Launch app with `npm run tauri dev` and verify:

1. Navigate to Spotify sidebar — badge should not be present initially
2. If previously logged in, auto-refresh should trigger silently after ~5 seconds
3. Click "Refresh" button — should show progress status
4. After refresh completes with changes — accent badge should appear on Spotify icon
5. Navigate to Spotify view — badge should clear
6. Check "Archived" section shows snapshots for dynamic playlists
7. Click an archived snapshot — should show read-only track list with back button
8. Delete an archived snapshot — should remove from list
9. Toggle "Archive snapshots" on a playlist detail view
10. Close and reopen app — schedules should persist, auto-refresh should fire if >24h

- [ ] **Step 5: Commit any fixes**

```
fix: integration testing fixes for spotify archiving
```
