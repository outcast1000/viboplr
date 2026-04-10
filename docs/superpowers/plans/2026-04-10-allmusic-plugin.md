# AllMusic Plugin Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AllMusic plugin that provides artist biographies as a priority-300 fallback in the existing `artist_bio` provider chain.

**Architecture:** A self-contained plugin (manifest.json + index.js) that searches AllMusic for an artist, fetches the biography via an AJAX endpoint, parses the HTML with regex, and returns `rich_text` data. No backend or frontend changes needed.

**Tech Stack:** Plugin JS (ES5-compatible, no modules), AllMusic public web scraping, existing plugin system APIs.

**Spec:** `docs/superpowers/specs/2026-04-10-allmusic-plugin-design.md`

---

### Task 1: Create plugin manifest

**Files:**
- Create: `src-tauri/plugins/allmusic/manifest.json`

- [ ] **Step 1: Create the manifest file**

```json
{
  "id": "allmusic",
  "name": "AllMusic",
  "version": "1.0.0",
  "author": "Viboplr",
  "description": "Artist biographies from AllMusic",
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
        "priority": 300
      }
    ]
  }
}
```

- [ ] **Step 2: Verify manifest is valid JSON**

Run: `cat src-tauri/plugins/allmusic/manifest.json | python3 -m json.tool > /dev/null && echo "valid"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/plugins/allmusic/manifest.json
git commit -m "feat(allmusic): add plugin manifest for artist bio fallback"
```

---

### Task 2: Create plugin with search and fetch helpers

**Files:**
- Create: `src-tauri/plugins/allmusic/index.js`

**Reference:** Follow the Genius plugin pattern at `src-tauri/plugins/genius/index.js` — ES5 style, `activate(api)` entry point, `return { activate: activate }` at the bottom.

- [ ] **Step 1: Write the complete plugin**

```js
// AllMusic Plugin for Viboplr
// Provides artist biographies from AllMusic as a fallback provider

function activate(api) {
  var BASE_SEARCH = "https://www.allmusic.com/search/artists/";
  var BASE_ARTIST = "https://www.allmusic.com/artist/";

  function allMusicFetch(url) {
    return api.network.fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    }).then(function (resp) {
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.text();
    });
  }

  // --- Search ---

  function searchArtist(name) {
    var url = BASE_SEARCH + encodeURIComponent(name);
    return allMusicFetch(url).then(function (html) {
      var match = html.match(/href="\/artist\/([^"]*-(mn\d{10}))"/);
      if (!match) return null;
      return { id: match[2], url: BASE_ARTIST + match[1] };
    });
  }

  // --- HTML parsing helpers ---

  function stripInlineImages(html) {
    return html.replace(/<span class="inlineImage[\s\S]*?<\/span>/g, "");
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // --- Bio fetcher ---

  function getArtistBio(artistId, artistUrl) {
    var url = BASE_ARTIST + artistId + "/biographyAjax";
    return allMusicFetch(url).then(function (html) {
      // Isolate biography div
      var bioMatch = html.match(/<div id="biography"[^>]*>([\s\S]*?)(?:<\/div>\s*<div|$)/);
      if (!bioMatch) return null;
      var content = bioMatch[1];

      // Remove inline album images
      content = stripInlineImages(content);

      // Extract and remove heading
      content = content.replace(/<h2>[\s\S]*?<\/h2>/, "");

      // Extract paragraphs
      var paragraphs = [];
      var pRegex = /<p[^>]*>([\s\S]*?)<\/p>/g;
      var pMatch;
      while ((pMatch = pRegex.exec(content)) !== null) {
        var text = cleanText(stripTags(pMatch[1]));
        if (text) paragraphs.push(text);
      }

      if (paragraphs.length === 0) return null;

      var summary = paragraphs[0];
      var full = paragraphs.join("\n\n");

      return {
        summary: summary,
        full: full,
        _meta: { url: artistUrl, providerName: "AllMusic" },
      };
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("artist_bio", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return searchArtist(entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getArtistBio(found.id, found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });
}

return { activate: activate };
```

- [ ] **Step 2: Verify syntax is valid**

Run: `node -c src-tauri/plugins/allmusic/index.js && echo "syntax ok"`
Expected: `syntax ok`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/plugins/allmusic/index.js
git commit -m "feat(allmusic): implement artist bio scraping plugin"
```

---

### Task 3: Manual integration test

No automated test infrastructure exists for plugins. Test manually in the running app.

- [ ] **Step 1: Start the app**

Run: `npm run tauri dev`

- [ ] **Step 2: Verify plugin loads**

Open Settings > Providers tab. Confirm "AllMusic" appears under the artist "About" info type row, listed after Last.fm and Genius.

- [ ] **Step 3: Test with an artist that has an AllMusic bio**

Navigate to an artist detail view (e.g., search for "Radiohead"). The "About" section should show a biography. Check the provider attribution — if Last.fm or Genius provided the data, the AllMusic fallback won't fire (expected behavior).

- [ ] **Step 4: Test the fallback scenario**

To confirm AllMusic works as a fallback, temporarily disable Last.fm and Genius `artist_bio` providers in Settings > Providers, then navigate to an artist. The "About" section should now show the AllMusic biography with an "AllMusic" attribution link.

- [ ] **Step 5: Re-enable Last.fm and Genius providers**

Re-enable both in Settings > Providers.
