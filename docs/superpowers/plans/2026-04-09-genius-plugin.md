# Genius Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a Genius plugin that provides song explanations (track), artist descriptions, and album descriptions through the information types plugin system, replacing the hardcoded Genius integration.

**Architecture:** A frontend JavaScript plugin under `src-tauri/plugins/genius/` declares 3 information types and registers `onFetch` handlers. All HTTP requests go through `api.network.fetch()` (Rust proxy). A new `annotations` displayKind with a dedicated renderer handles the track song explanation UI. The existing `genius.rs` Rust module and hardcoded `TrackDetailView.tsx` Genius code are removed.

**Tech Stack:** TypeScript/React (renderer + types), JavaScript (plugin), Rust (cleanup only)

---

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `src-tauri/plugins/genius/manifest.json` | Create: plugin metadata + 3 information type declarations |
| `src-tauri/plugins/genius/index.js` | Create: search + fetch + parse Genius API, register onFetch handlers |
| `src/types/informationTypes.ts` | Modify: add `annotations` to DisplayKind union, add `AnnotationsData` interface |
| `src/components/renderers/AnnotationsRenderer.tsx` | Create: renderer for annotations displayKind |
| `src/components/renderers/renderers.css` | Modify: add `.renderer-annotations` styles |
| `src/components/renderers/index.ts` | Modify: import + register AnnotationsRenderer |
| `src-tauri/src/genius.rs` | Delete: entire module |
| `src-tauri/src/lib.rs` | Modify: remove `mod genius;` line |
| `src-tauri/src/commands.rs` | Modify: remove `get_genius_explanation` function |
| `src/components/TrackDetailView.tsx` | Modify: remove Genius state, fetch, listener, rendering |
| `src/components/TrackDetailView.css` | Modify: remove `.genius-*` styles |
| `src/store.ts` | Modify: remove `geniusExplanations` from `trackSections` |

---

### Task 1: Add `annotations` DisplayKind and Data Type

**Files:**
- Modify: `src/types/informationTypes.ts`

- [ ] **Step 1: Add `annotations` to the DisplayKind union**

In `src/types/informationTypes.ts`, add `"annotations"` to the `DisplayKind` type union (after `"annotated_text"`):

```typescript
export type DisplayKind =
  | "rich_text"
  | "html"
  | "entity_list"
  | "entity_cards"
  | "stat_grid"
  | "lyrics"
  | "tag_list"
  | "ranked_list"
  | "annotated_text"
  | "annotations"
  | "key_value"
  | "image_gallery"
  | "title_line";
```

- [ ] **Step 2: Add the AnnotationsData interface**

After the `AnnotatedTextData` interface (around line 139), add:

```typescript
export interface AnnotationsData {
  overview?: string;
  annotations: Array<{ fragment: string; explanation: string }>;
}
```

No placement map change is needed — `annotations` defaults to `"below"` since it's not in `RIGHT_DISPLAY_KINDS`.

- [ ] **Step 3: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/types/informationTypes.ts
git commit -m "feat: add annotations displayKind and AnnotationsData type"
```

---

### Task 2: Create AnnotationsRenderer

**Files:**
- Create: `src/components/renderers/AnnotationsRenderer.tsx`
- Modify: `src/components/renderers/renderers.css`
- Modify: `src/components/renderers/index.ts`

- [ ] **Step 1: Create the AnnotationsRenderer component**

Create `src/components/renderers/AnnotationsRenderer.tsx`:

```tsx
import type { RendererProps } from "./index";
import type { AnnotationsData } from "../../types/informationTypes";

export function AnnotationsRenderer({ data }: RendererProps) {
  const d = data as AnnotationsData;
  if (!d?.annotations?.length && !d?.overview) return null;

  return (
    <div className="renderer-annotations">
      {d.overview && <p className="annotations-overview">{d.overview}</p>}
      {d.annotations?.length > 0 && (
        <div className="annotations-list">
          {d.annotations.map((ann, i) => (
            <div key={i} className="annotations-item">
              <div className="annotations-fragment">{ann.fragment}</div>
              <div className="annotations-explanation">{ann.explanation}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add CSS styles to renderers.css**

Append to `src/components/renderers/renderers.css`:

```css
.renderer-annotations .annotations-overview { font-size: var(--fs-sm); color: var(--text-secondary); line-height: 1.5; margin: 0 0 8px; }
.renderer-annotations .annotations-list { display: flex; flex-direction: column; gap: 12px; }
.renderer-annotations .annotations-item { border-left: 3px solid rgba(var(--accent-rgb), 0.4); padding-left: 10px; }
.renderer-annotations .annotations-fragment { font-size: var(--fs-sm); color: var(--text-primary); font-style: italic; line-height: 1.4; margin-bottom: 4px; }
.renderer-annotations .annotations-explanation { font-size: var(--fs-xs); color: var(--text-secondary); line-height: 1.5; }
```

- [ ] **Step 3: Register the renderer in index.ts**

In `src/components/renderers/index.ts`, add the import (after the AnnotatedTextRenderer import, line 10):

```typescript
import { AnnotationsRenderer } from "./AnnotationsRenderer";
```

Add to the `renderers` record (after the `annotated_text` entry):

```typescript
  annotations: AnnotationsRenderer,
```

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/components/renderers/AnnotationsRenderer.tsx src/components/renderers/renderers.css src/components/renderers/index.ts
git commit -m "feat: add AnnotationsRenderer for Genius song explanations"
```

---

### Task 3: Create Genius Plugin

**Files:**
- Create: `src-tauri/plugins/genius/manifest.json`
- Create: `src-tauri/plugins/genius/index.js`

- [ ] **Step 1: Create manifest.json**

Create `src-tauri/plugins/genius/manifest.json`:

```json
{
  "id": "genius",
  "name": "Genius",
  "version": "1.0.0",
  "author": "Viboplr",
  "description": "Song explanations, artist descriptions, and album descriptions from Genius",
  "minAppVersion": "0.9.4",
  "contributes": {
    "informationTypes": [
      {
        "id": "genius_song_explanation",
        "name": "Song Explanation",
        "entity": "track",
        "displayKind": "annotations",
        "ttl": 7776000,
        "order": 400,
        "priority": 100
      },
      {
        "id": "genius_artist_description",
        "name": "Description",
        "entity": "artist",
        "displayKind": "rich_text",
        "ttl": 7776000,
        "order": 250,
        "priority": 100
      },
      {
        "id": "genius_album_description",
        "name": "Description",
        "entity": "album",
        "displayKind": "rich_text",
        "ttl": 7776000,
        "order": 250,
        "priority": 100
      }
    ]
  }
}
```

- [ ] **Step 2: Create index.js**

Create `src-tauri/plugins/genius/index.js`. The plugin uses `api.network.fetch()` to call Genius's internal API endpoints. All parsing happens in JavaScript.

```javascript
// Genius Plugin for Viboplr
// Provides song explanations, artist descriptions, and album descriptions

function activate(api) {
  var BASE_SEARCH = "https://genius.com/api/search/multi?q=";
  var USER_AGENT_NOTE = ""; // Rust proxy handles User-Agent

  function geniusFetch(url) {
    return api.network.fetch(url).then(function (resp) {
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.json();
    });
  }

  // --- Search helpers ---

  function searchSong(artist, title) {
    var query = encodeURIComponent(title + " " + artist);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      var artistLower = artist.toLowerCase();
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "song") continue;
          var result = hit.result;
          if (!result) continue;
          var hitArtist = (result.artist_names || "").toLowerCase();
          if (!hitArtist.includes(artistLower) && !artistLower.includes(hitArtist)) continue;
          if (result.id && result.url) {
            return { id: result.id, url: result.url };
          }
        }
      }
      return null;
    });
  }

  function searchArtist(name) {
    var query = encodeURIComponent(name);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "artist") continue;
          var result = hit.result;
          if (!result || !result.id) continue;
          var url = result.url || ("https://genius.com/artists/" + result.id);
          return { id: result.id, url: url };
        }
      }
      return null;
    });
  }

  function searchAlbum(artist, title) {
    var query = encodeURIComponent(title + " " + artist);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "album") continue;
          var result = hit.result;
          if (!result || !result.id) continue;
          var url = result.url || ("https://genius.com/albums/" + result.id);
          return { id: result.id, url: url };
        }
      }
      return null;
    });
  }

  // --- Data fetchers ---

  function getSongExplanation(songId, songUrl) {
    var songP = geniusFetch("https://genius.com/api/songs/" + songId);
    var refsP = geniusFetch(
      "https://genius.com/api/referents?song_id=" + songId + "&per_page=50&text_format=plain"
    );
    return Promise.all([songP, refsP]).then(function (results) {
      var songData = results[0];
      var refsData = results[1];

      var song = (songData && songData.response && songData.response.song) || {};
      var about = song.description_preview || undefined;
      if (about === "?" || about === "") about = undefined;
      var url = song.url || songUrl;

      var referents = (refsData && refsData.response && refsData.response.referents) || [];
      var annotations = [];
      for (var r = 0; r < referents.length; r++) {
        var ref = referents[r];
        var fragment = ref.fragment || "";
        if (!fragment || (fragment.charAt(0) === "[" && fragment.charAt(fragment.length - 1) === "]")) {
          continue;
        }
        var anns = ref.annotations || [];
        for (var a = 0; a < anns.length; a++) {
          var body = anns[a].body;
          var plain = body && body.plain;
          if (plain) {
            annotations.push({ fragment: fragment, explanation: plain });
          }
        }
      }

      return {
        overview: about,
        annotations: annotations,
        _meta: { url: url, providerName: "Genius" },
      };
    });
  }

  function getArtistDescription(artistId, artistUrl) {
    return geniusFetch("https://genius.com/api/artists/" + artistId).then(function (data) {
      var artist = (data && data.response && data.response.artist) || {};
      var preview = artist.description_preview || undefined;
      if (preview === "?" || preview === "") preview = undefined;
      var desc = artist.description || {};
      var html = desc.html || undefined;
      if (html === "<p>?</p>" || html === "") html = undefined;
      var url = artist.url || artistUrl;

      if (!preview && !html) return null;

      return {
        summary: preview || "",
        full: html || undefined,
        _meta: { url: url, providerName: "Genius" },
      };
    });
  }

  function getAlbumDescription(albumId, albumUrl) {
    return geniusFetch("https://genius.com/api/albums/" + albumId).then(function (data) {
      var album = (data && data.response && data.response.album) || {};
      var preview = album.description_preview || undefined;
      if (preview === "?" || preview === "") preview = undefined;
      var desc = album.description || {};
      var html = desc.html || undefined;
      if (html === "<p>?</p>" || html === "") html = undefined;
      var url = album.url || albumUrl;

      if (!preview && !html) return null;

      return {
        summary: preview || "",
        full: html || undefined,
        _meta: { url: url, providerName: "Genius" },
      };
    });
  }

  // --- onFetch handlers ---

  api.informationTypes.onFetch("genius_song_explanation", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return searchSong(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getSongExplanation(found.id, found.url).then(function (result) {
        if (!result.overview && result.annotations.length === 0) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("genius_artist_description", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return searchArtist(entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getArtistDescription(found.id, found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("genius_album_description", function (entity) {
    if (entity.kind !== "album") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return searchAlbum(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getAlbumDescription(found.id, found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });
}

return { activate: activate };
```

- [ ] **Step 3: Verify the plugin directory exists**

Run: `ls src-tauri/plugins/genius/`
Expected: `index.js  manifest.json`

- [ ] **Step 4: Commit**

```bash
git add src-tauri/plugins/genius/manifest.json src-tauri/plugins/genius/index.js
git commit -m "feat: add Genius plugin with song explanation, artist/album descriptions"
```

---

### Task 4: Remove Hardcoded Genius from Frontend

**Files:**
- Modify: `src/components/TrackDetailView.tsx`
- Modify: `src/components/TrackDetailView.css`
- Modify: `src/store.ts`

- [ ] **Step 1: Remove Genius state from TrackDetailView.tsx**

In `src/components/TrackDetailView.tsx`, remove these two state declarations (lines 207-212):

```typescript
  const [geniusExplanation, setGeniusExplanation] = useState<{
    about?: string;
    annotations: { fragment: string; explanation: string }[];
    song_url: string;
  } | null>(null);
  const [geniusLoading, setGeniusLoading] = useState(false);
```

- [ ] **Step 2: Remove Genius fetch from useEffect**

In the same file, remove the Genius fetch block from the data-loading useEffect (lines 291-303):

```typescript
      if (sections.geniusExplanations !== false) {
        setGeniusLoading(true);
        invoke<any>("get_genius_explanation", { artistName: track.artist_name, trackTitle: track.title })
          .then(cached => {
            if (cached) {
              setGeniusExplanation(cached);
              setGeniusLoading(false);
            } else {
              setTimeout(() => setGeniusLoading(false), 15000);
            }
          })
          .catch(() => setGeniusLoading(false));
      }
```

- [ ] **Step 3: Remove Genius event listener**

Remove the `genius-explanation` listener and its cleanup (lines 317-322, 326):

```typescript
    const unlistenGenius = listen<any>("genius-explanation", (event) => {
      if (event.payload) {
        setGeniusExplanation(event.payload);
        setGeniusLoading(false);
      }
    });
```

And remove `unlistenGenius.then(f => f());` from the cleanup return.

- [ ] **Step 4: Remove Genius rendering block**

Remove the entire Genius rendering section (lines 542-580):

```tsx
        <div className="track-detail-genius">
          ...
        </div>
```

- [ ] **Step 5: Remove Genius CSS from TrackDetailView.css**

In `src/components/TrackDetailView.css`, remove lines 853-907 (the entire block from `/* Genius Song Explanation section */` through `.genius-annotation-explanation`).

- [ ] **Step 6: Remove geniusExplanations from store.ts**

In `src/store.ts` line 59, remove `geniusExplanations: true` from the `trackSections` default:

Before:
```typescript
  trackSections: { lyrics: true, tags: true, scrobbleHistory: true, similar: true, geniusExplanations: true },
```

After:
```typescript
  trackSections: { lyrics: true, tags: true, scrobbleHistory: true, similar: true },
```

- [ ] **Step 7: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: no errors (there may be unused import warnings for `listen` or `invoke` — only remove them if they are truly unused after the changes)

- [ ] **Step 8: Commit**

```bash
git add src/components/TrackDetailView.tsx src/components/TrackDetailView.css src/store.ts
git commit -m "refactor: remove hardcoded Genius integration from TrackDetailView"
```

---

### Task 5: Remove Genius Rust Backend

**Files:**
- Delete: `src-tauri/src/genius.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 1: Delete genius.rs**

```bash
rm src-tauri/src/genius.rs
```

- [ ] **Step 2: Remove `mod genius;` from lib.rs**

In `src-tauri/src/lib.rs` line 19, remove:

```rust
mod genius;
```

- [ ] **Step 3: Remove `get_genius_explanation` command from commands.rs**

In `src-tauri/src/commands.rs`, remove the entire function (lines 1468-1492):

```rust
#[tauri::command]
pub fn get_genius_explanation(state: State<'_, AppState>, app: AppHandle, artist_name: String, track_title: String) -> Option<serde_json::Value> {
    ...
}
```

- [ ] **Step 4: Remove command registration from lib.rs**

In `src-tauri/src/lib.rs`, remove `commands::get_genius_explanation,` from both the debug handler (line 104) and release handler (line 227).

Note: `urlencoding` crate is still used by `commands.rs` and `tidal.rs`, so it stays in `Cargo.toml`.

**Important:** Do NOT remove the `builtin-genius` search provider in `searchProviders.ts` or `IconGenius` in `Icons.tsx` — these belong to the web search provider system and are unrelated to this cleanup.

- [ ] **Step 5: Verify Rust compilation**

Run: `cd src-tauri && cargo check`
Expected: compiles without errors

- [ ] **Step 6: Commit**

```bash
git add -A src-tauri/src/genius.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "refactor: remove genius.rs backend module, now handled by plugin"
```

---

### Task 6: Verify Everything Works Together

- [ ] **Step 1: Run TypeScript type-check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2: Run all TypeScript tests**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 3: Run Rust tests**

Run: `cd src-tauri && cargo check --release`
Expected: compiles without errors (release build verifies no debug-gated code depends on genius)

- [ ] **Step 4: Run full test suite**

Run: `npm run test:all`
Expected: all tests pass
