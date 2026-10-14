// Artwork: the bundled image providers in one plugin. Each source is its own
// provider (contributes.providers) with its own row, priority and switch in
// Settings → Providers, so merging them costs the user no control — it only
// saves a worker per source and lets them share the helpers below.
// They used to be four plugins (audiodb, deezer, itunes, musicbrainz); the
// provider ids keep those names, which is what lets the database migration
// carry their rows (order, switches) across, and what keeps a pin like
// `pluginId=deezer` working.
function activate(api) {
  // ── Shared ──────────────────────────────────────────────────────────

  // Normalize a name the way the backend does (strip_diacritics + unicode_lower):
  // NFD decompose, drop combining marks, lowercase, and strip punctuation/whitespace
  // while preserving letters/numbers of all scripts (so non-latin names survive).
  function normName(s) {
    if (!s) return "";
    return String(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }
  function nameMatches(query, candidate) {
    var q = normName(query);
    var c = normName(candidate);
    return q.length > 0 && q === c;
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function clampLimit(raw) {
    return Math.min(10, Math.max(1, parseInt(raw, 10) || 5));
  }
  // A 404 is "nothing here" (the handlers turn null into not_found); any other
  // non-2xx is a failure worth naming — before this a blocked or rate-limited
  // source surfaced as a JSON parse error of its HTML error page.
  // Sent on every request, including the image downloads the host makes for
  // our answers: the host's default is a browser-style User-Agent, which some
  // filtering proxies block from a non-browser client, and archive.org serves
  // an HTML page instead of the image to it.
  var CLIENT_HEADERS = { "User-Agent": "Vibo" };
  async function getJson(url) {
    var resp = await api.network.fetch(url, { headers: CLIENT_HEADERS });
    if (resp.status === 404) return null;
    if (resp.status < 200 || resp.status >= 300) throw new Error("HTTP " + resp.status + " from " + hostOf(url));
    var data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error(hostOf(url) + " answered with something that isn't JSON");
    }
    // Deezer reports quota and service errors inside a 200.
    if (data && data.error && typeof data.error === "object") {
      throw new Error(hostOf(url) + ": " + (data.error.message || data.error.type || "error"));
    }
    return data;
  }
  function hostOf(url) {
    var m = /^https?:\/\/([^/]+)/.exec(url);
    return m ? m[1] : url;
  }

  // Every source's answer goes through `track`, which is what the status
  // panel (Extensions → Artwork → Configuration) reports from.
  var handlers = {};
  function provide(entity, provider, handler) {
    handlers[provider + ":" + entity] = handler;
    api.imageProviders.onFetch(entity, function (name, artistName) {
      return Promise.resolve(track(provider, entity, name, artistName, false)).then(function (result) {
        if (result && result.status === "ok" && result.url && !result.headers) {
          return Object.assign({}, result, { headers: CLIENT_HEADERS });
        }
        return result;
      });
    }, { provider: provider });
  }

  // ── TheAudioDB (artist) ─────────────────────────────────────────────

  provide("artist", "audiodb", async function (name) {
    // "123" is TheAudioDB's current public test key. The old "2" was retired:
    // it answers every search with a 404 {"Message":"Not found"}, which made
    // this provider a silent miss for every artist.
    var data = await getJson(
      "https://www.theaudiodb.com/api/v1/json/123/search.php?s=" + encodeURIComponent(name)
    );
    var artist = data && data.artists && data.artists[0];
    if (!artist || !artist.strArtistThumb) return { status: "not_found" };
    // Guard against a wrong first result by confirming the returned artist name
    // matches the query (normalized), so the chain can continue on a mismatch.
    if (!nameMatches(name, artist.strArtist)) return { status: "not_found" };
    return { status: "ok", url: artist.strArtistThumb };
  });

  // ── Deezer (artist + album) ─────────────────────────────────────────

  // Deezer always populates picture_xl/cover_xl, even when it has no real art for
  // a matched result. In that case it returns a placeholder URL whose md5-hash
  // segment is empty (".../images/artist//1000x1000-..." — note the double
  // slash). That URL 301-redirects to HTML, not an image, so it would be saved
  // as a "failed image". Treat an empty-hash URL as no image so the provider
  // chain continues to the next provider instead.
  function hasRealImage(url) {
    if (!url) return false;
    var m = /\/images\/[^/]+\/([^/]*)\//.exec(url);
    return !!(m && m[1]);
  }

  provide("artist", "deezer", async function (name) {
    var data = await getJson(
      "https://api.deezer.com/search/artist?q=" + encodeURIComponent(name) + "&limit=1"
    );
    var hit = data && data.data && data.data[0];
    if (!hit || !hasRealImage(hit.picture_xl)) return { status: "not_found" };
    // Deezer searches blindly with limit=1, so a wrong-but-popular artist can be
    // returned (e.g. "Girls" -> Spice Girls). Reject mismatches so the chain
    // continues to another provider instead of caching a wrong image.
    if (!nameMatches(name, hit.name)) return { status: "not_found" };
    return { status: "ok", url: hit.picture_xl };
  });

  provide("album", "deezer", async function (name, artistName) {
    var query = artistName ? artistName + " " + name : name;
    var data = await getJson(
      "https://api.deezer.com/search/album?q=" + encodeURIComponent(query) + "&limit=1"
    );
    var hit = data && data.data && data.data[0];
    if (!hit || !hasRealImage(hit.cover_xl)) return { status: "not_found" };
    // Gate on artist only (not title): a wrong artist means a wrong cover
    // (e.g. "Untitled" by Weezer -> Beau Wanzer), but the title legitimately
    // varies across reissues ("4" -> "4 (Expanded Edition)"), so matching the
    // title strictly would reject correct deluxe/remastered covers.
    var hitArtist = hit.artist && hit.artist.name;
    if (artistName && !nameMatches(artistName, hitArtist)) return { status: "not_found" };
    return { status: "ok", url: hit.cover_xl };
  });

  // ── iTunes (album) ──────────────────────────────────────────────────
  // iTunes Search does NOT provide artist photos: the `musicArtist` entity
  // returns no `artworkUrl100` field, so only album artwork comes from here.

  provide("album", "itunes", async function (name, artistName) {
    var term = artistName
      ? encodeURIComponent(artistName) + "+" + encodeURIComponent(name)
      : encodeURIComponent(name);
    var data = await getJson("https://itunes.apple.com/search?term=" + term + "&entity=album&limit=1");
    var result = data && data.results && data.results[0];
    if (!result || !result.artworkUrl100) return { status: "not_found" };
    // Gate on artist only (not title): a wrong artist means a wrong cover
    // (e.g. "Women" by Women -> a Chris Crack album), but the title legitimately
    // varies across reissues ("Homogenic" -> "Homogenic Live"), so matching the
    // title strictly would reject correct deluxe/live/remastered covers.
    if (artistName && !nameMatches(artistName, result.artistName)) return { status: "not_found" };
    return { status: "ok", url: result.artworkUrl100.replace("100x100", "600x600") };
  });

  // ── MusicBrainz + Cover Art Archive (artist + album) ────────────────

  async function resolveWikimediaThumbnail(commonsUrl) {
    var parts = commonsUrl.split("File:");
    var filename = parts[parts.length - 1];
    // MusicBrainz stores the Commons link already percent-encoded
    // ("Bj%C3%B6rk_1997.jpg"). Encoding that again sends "%25C3" and Wikipedia
    // rejects the title as invalid, so every non-ASCII filename missed.
    try {
      filename = decodeURIComponent(filename);
    } catch (e) {
      // Malformed escape: keep the raw name and let the lookup decide.
    }
    var data = await getJson(
      "https://en.wikipedia.org/w/api.php?action=query&titles=File:" +
        encodeURIComponent(filename) +
        "&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json"
    );
    var pages = data && data.query && data.query.pages;
    if (!pages) return null;
    var keys = Object.keys(pages);
    if (keys.length === 0) return null;
    var page = pages[keys[0]];
    var info = page && page.imageinfo && page.imageinfo[0];
    return info && info.thumburl ? info.thumburl : null;
  }

  provide("artist", "musicbrainz", async function (name) {
    var searchData = await getJson(
      "https://musicbrainz.org/ws/2/artist/?query=artist:" + encodeURIComponent(name) + "&limit=1&fmt=json"
    );
    var artists = searchData && searchData.artists;
    if (!artists || artists.length === 0) return { status: "not_found" };

    var artist = artists[0];
    if (!artist.score || artist.score < 80) return { status: "not_found" };
    // The score gate still lets fuzzy matches through (e.g. "Bush" -> Kate Bush,
    // "Wolf Alice" -> Alice Cooper). Require a normalized name match so the chain
    // continues instead of fetching a confidently-wrong image.
    if (!nameMatches(name, artist.name)) return { status: "not_found" };

    var mbid = artist.id;
    if (!mbid) return { status: "not_found" };

    // MusicBrainz rate limit: one request a second.
    await sleep(1000);
    var artistData = await getJson("https://musicbrainz.org/ws/2/artist/" + mbid + "?inc=url-rels&fmt=json");
    var relations = artistData && artistData.relations;
    if (!relations) return { status: "not_found" };

    var imageRel = null;
    for (var i = 0; i < relations.length; i++) {
      if (relations[i].type === "image") {
        imageRel = relations[i];
        break;
      }
    }
    if (!imageRel || !imageRel.url || !imageRel.url.resource) return { status: "not_found" };

    var imageUrl = imageRel.url.resource;
    if (imageUrl.indexOf("commons.wikimedia.org") !== -1) {
      await sleep(1000);
      var thumbUrl = await resolveWikimediaThumbnail(imageUrl);
      if (!thumbUrl) return { status: "not_found" };
      imageUrl = thumbUrl;
    }
    return { status: "ok", url: imageUrl };
  });

  provide("album", "musicbrainz", async function (name, artistName) {
    var query = artistName
      ? "releasegroup:" + name + " AND artist:" + artistName
      : "releasegroup:" + name;
    var searchData = await getJson(
      "https://musicbrainz.org/ws/2/release-group/?query=" + encodeURIComponent(query) + "&limit=1&fmt=json"
    );
    var groups = searchData && searchData["release-groups"];
    if (!groups || groups.length === 0) return { status: "not_found" };

    var group = groups[0];
    if (!group.score || group.score < 80) return { status: "not_found" };

    var mbid = group.id;
    if (!mbid) return { status: "not_found" };

    await sleep(1000);
    // CAA redirects to archive.org; CLIENT_HEADERS (added in `provide`) is what
    // gets the JPEG rather than an HTML page.
    return {
      status: "ok",
      url: "https://coverartarchive.org/release-group/" + mbid + "/front-500",
    };
  });

  // ── Status panel: what works, what fails ────────────────────────────
  //
  // Counts every answer each source gives (found / nothing found / failed)
  // with the last failure's reason, keeps the latest lookups, and can test
  // every source against a well-known artist and album on demand — the test
  // is what tells "the network blocks Deezer" apart from "Deezer has no photo
  // of this obscure band". Kept in plugin storage so it survives a restart.

  var SOURCES = [
    { id: "audiodb", name: "TheAudioDB", entities: ["artist"] },
    { id: "deezer", name: "Deezer", entities: ["artist", "album"] },
    { id: "itunes", name: "iTunes", entities: ["album"] },
    { id: "musicbrainz", name: "MusicBrainz", entities: ["artist", "album"] },
  ];
  var TEST_ITEMS = {
    artist: { name: "Radiohead" },
    album: { name: "OK Computer", artistName: "Radiohead" },
  };
  var PANEL = "artwork-status";
  var STORAGE_KEY = "status";
  var RECENT_MAX = 25;

  var status = { since: Date.now(), counts: {}, recent: [] };
  var testState = { running: false, at: null, results: {} };

  function sourceName(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i].name;
    return id;
  }
  function entityLabel(entity) {
    return entity === "artist" ? "Artist photos" : "Album covers";
  }
  function describeItem(entity, name, artistName) {
    return entity === "album" && artistName ? "“" + name + "” – " + artistName : "“" + name + "”";
  }
  function clock(at) {
    var d = new Date(at);
    var sameDay = new Date().toDateString() === d.toDateString();
    var time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  }
  function errorText(e) {
    return e && e.message ? e.message : String(e);
  }

  async function track(provider, entity, name, artistName, isTest) {
    var started = Date.now();
    var outcome;
    try {
      var result = await handlers[provider + ":" + entity](name, artistName);
      outcome = { status: result && result.status === "ok" ? "ok" : result && result.status === "error" ? "error" : "not_found",
                  message: result && result.message, url: result && result.status === "ok" && !result.headers ? result.url : null };
      record(provider, entity, name, artistName, outcome, Date.now() - started, isTest);
      return result;
    } catch (e) {
      outcome = { status: "error", message: errorText(e), url: null };
      record(provider, entity, name, artistName, outcome, Date.now() - started, isTest);
      api.log("warn", sourceName(provider) + " " + entity + " lookup for " + describeItem(entity, name, artistName) + " failed: " + outcome.message);
      throw e;
    }
  }

  function record(provider, entity, name, artistName, outcome, ms, isTest) {
    var key = provider + ":" + entity;
    var entry = { provider: provider, entity: entity, name: name, artistName: artistName || null,
                  status: outcome.status, message: outcome.message || null, url: outcome.url, ms: ms, at: Date.now(), test: !!isTest };
    if (isTest) {
      testState.results[key] = entry;
    } else {
      var c = status.counts[key] || (status.counts[key] = { ok: 0, notFound: 0, error: 0, last: null, lastError: null });
      if (outcome.status === "ok") c.ok++;
      else if (outcome.status === "error") c.error++;
      else c.notFound++;
      c.last = entry;
      if (outcome.status === "error") c.lastError = entry;
      status.recent.unshift(entry);
      if (status.recent.length > RECENT_MAX) status.recent.length = RECENT_MAX;
      schedulePersist();
    }
    scheduleRender();
  }

  // Lookups come in bursts (a library's worth of covers after a scan), so
  // both the storage write and the redraw are coalesced.
  var persistTimer = null;
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      api.storage.set(STORAGE_KEY, status).catch(function (e) {
        api.log("error", "Could not save the artwork status: " + errorText(e));
      });
    }, 5000);
  }
  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      render();
    }, 1000);
  }

  function badgeFor(entry) {
    if (!entry) return { label: "Not asked yet", variant: "muted" };
    if (entry.status === "ok") return { label: "Working", variant: "success" };
    if (entry.status === "error") return { label: "Failing", variant: "error" };
    // A test item every source should know coming back empty is suspicious;
    // an everyday "nothing found" is just an obscure name.
    return entry.test ? { label: "No match", variant: "warning" } : { label: "Working", variant: "success" };
  }

  function sourceRow(source, entity) {
    var key = source.id + ":" + entity;
    var c = status.counts[key];
    var t = testState.results[key];
    var latest = t && (!c || !c.last || t.at >= c.last.at) ? t : c && c.last;
    var parts = [];
    if (t) {
      parts.push("Test: " + (t.status === "ok" ? "found in " + t.ms + " ms"
        : t.status === "error" ? "failed — " + t.message
        : "nothing for " + describeItem(entity, TEST_ITEMS[entity].name, TEST_ITEMS[entity].artistName)));
    }
    if (c) {
      parts.push(c.ok + " found · " + c.notFound + " nothing · " + c.error + " failed");
      if (c.lastError) parts.push("last failure " + clock(c.lastError.at) + ": " + c.lastError.message);
    } else if (!t) {
      parts.push("No lookups yet");
    }
    var row = { id: key, title: source.name + " · " + entityLabel(entity), subtitle: parts.join(" · "), badge: badgeFor(latest) };
    var img = (t && t.url) || (c && c.last && c.last.url);
    if (img) row.imageUrl = img;
    return row;
  }

  function recentRow(entry, i) {
    var outcome = entry.status === "ok" ? "found" : entry.status === "error" ? "failed — " + entry.message : "nothing found";
    var row = {
      id: "recent-" + i + "-" + entry.at,
      title: sourceName(entry.provider) + " · " + describeItem(entry.entity, entry.name, entry.artistName),
      subtitle: outcome + " · " + entry.ms + " ms · " + clock(entry.at),
      badge: entry.status === "ok" ? { label: "Found", variant: "success" }
        : entry.status === "error" ? { label: "Failed", variant: "error" }
        : { label: "Nothing", variant: "muted" },
    };
    if (entry.url) row.imageUrl = entry.url;
    return row;
  }

  function render() {
    var rows = [];
    SOURCES.forEach(function (s) {
      s.entities.forEach(function (e) { rows.push(sourceRow(s, e)); });
    });
    var children = [
      { type: "text", content: "What each source answered since " + clock(status.since) + ". The order they are asked in, and which ones are on, is set in Settings → Providers — a source switched off there is never asked." },
      {
        type: "toolbar",
        title: "Sources",
        buttons: [
          { label: testState.running ? "Testing…" : "Test all sources", action: "artwork-test", variant: "accent", disabled: testState.running },
          { label: "Reset counts", action: "artwork-reset", variant: "secondary", disabled: testState.running },
        ],
        status: testState.at ? "Last test " + clock(testState.at) + " (Radiohead, OK Computer)" : undefined,
      },
      { type: "track-row-list", items: rows, contextMenu: false, artwork: "cached" },
    ];
    children.push({
      type: "section",
      title: "Recent lookups",
      children: status.recent.length > 0
        ? [{ type: "track-row-list", items: status.recent.map(recentRow), contextMenu: false, artwork: "cached" }]
        : [{ type: "text", content: "Nothing asked yet. Covers and photos are looked up when a page needs one the library doesn't have." }],
    });
    api.ui.setViewData(PANEL, { type: "layout", direction: "vertical", children: children });
  }

  async function runTests() {
    if (testState.running) return;
    testState.running = true;
    testState.results = {};
    render();
    // One source at a time, as the chain asks them — MusicBrainz is
    // rate-limited, and a burst would only test the rate limit.
    for (var i = 0; i < SOURCES.length; i++) {
      for (var j = 0; j < SOURCES[i].entities.length; j++) {
        var entity = SOURCES[i].entities[j];
        var item = TEST_ITEMS[entity];
        try {
          await track(SOURCES[i].id, entity, item.name, item.artistName, true);
        } catch (e) {
          // Recorded by track(); the next source still gets its test.
        }
        render();
      }
    }
    testState.running = false;
    testState.at = Date.now();
    render();
  }

  api.ui.onAction("artwork-test", function () {
    runTests();
  });
  api.ui.onAction("artwork-reset", function () {
    status = { since: Date.now(), counts: {}, recent: [] };
    testState.results = {};
    testState.at = null;
    schedulePersist();
    render();
  });

  render();
  api.storage.get(STORAGE_KEY).then(function (saved) {
    if (!saved || typeof saved !== "object" || !saved.counts) return;
    // Lookups may already have landed while this read was in flight (the
    // image worker starts asking as soon as the plugin is up): merge, don't
    // overwrite.
    Object.keys(saved.counts).forEach(function (key) {
      var s = saved.counts[key];
      var c = status.counts[key];
      if (!c) { status.counts[key] = s; return; }
      c.ok += s.ok || 0;
      c.notFound += s.notFound || 0;
      c.error += s.error || 0;
      if (!c.lastError) c.lastError = s.lastError || null;
    });
    status.since = Math.min(status.since, saved.since || status.since);
    status.recent = status.recent.concat(Array.isArray(saved.recent) ? saved.recent : []).slice(0, RECENT_MAX);
    render();
  }).catch(function (e) {
    api.log("error", "Could not read the saved artwork status: " + errorText(e));
  });

  // ── Assistant tools ─────────────────────────────────────────────────
  // Multi-candidate searches: the chain providers above auto-pick one hit; a
  // model disambiguating a reissue or a common name wants the choices.

  if (api.assistant) {
    api.assistant.onTool("search_art", async function (args) {
      var kind = args.kind;
      if (kind !== "artist" && kind !== "album") throw new Error('"kind" must be "artist" or "album"');
      var query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error('"query" (string) is required');
      var data = await getJson(
        "https://api.deezer.com/search/" + kind + "?q=" + encodeURIComponent(query) + "&limit=" + clampLimit(args.limit)
      );
      var hits = (data && data.data) || [];
      return {
        candidates: hits.map(function (h) {
          var url = kind === "artist" ? h.picture_xl : h.cover_xl;
          return {
            name: h.name || h.title,
            artist: (h.artist && h.artist.name) || null,
            imageUrl: hasRealImage(url) ? url : null,
          };
        }).filter(function (c) { return c.imageUrl; }),
      };
    });

    api.assistant.onTool("search_album_art", async function (args) {
      var query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error('"query" (string) is required');
      var data = await getJson(
        "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=album&limit=" + clampLimit(args.limit)
      );
      var hits = (data && data.results) || [];
      return {
        candidates: hits.filter(function (h) { return h.artworkUrl100; }).map(function (h) {
          return {
            album: h.collectionName,
            artist: h.artistName,
            year: h.releaseDate ? parseInt(h.releaseDate.slice(0, 4), 10) : null,
            imageUrl: h.artworkUrl100.replace("100x100", "600x600"),
          };
        }),
      };
    });
  }
}

return { activate: activate };
