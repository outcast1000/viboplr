// Mock Info Plugin (debugOnly: loads only with Settings → Debug → Debug mode on)
//
// Answers the same two ranked_list info types Last.fm provides —
// `album_track_popularity` (an album's tracklist in album order) and
// `artist_top_tracks` (an artist's Top Songs in rank order) — with fake data
// built from the user's own library plus invented tracks. It exists so the
// album/artist "Not in library" merge can be exercised without a working
// Last.fm. Everything is deterministic per entity, so a page looks the same on
// every visit.
//
// What it produces, on purpose:
// - Album in the library: its real tracks in track-number order, one with a
//   "(Remastered)" suffix (must still count as owned), with invented tracks
//   before the first, between every second, and after the last (missing).
// - Album not in the library: ten invented tracks (the Tracks tab).
// - Artist in the library: up to 12 of their real tracks mixed with 8
//   invented ones, ranked by fake listener counts.
// - Artist not in the library: twelve invented songs.
//
// It sits after Last.fm in the provider chain (Settings → Providers), so it
// only answers when Last.fm can't. Move it first there to force fake data.

function activate(api) {
  var FAKE_WORDS = ["Midnight", "Glass", "River", "Static", "Echo", "Velvet", "Ember", "Hollow",
    "Signal", "Paper", "Neon", "Drift", "Silver", "Orbit", "Winter", "Lantern"];

  // Small deterministic string hash, so fake values are stable per entity.
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function fakeTitle(seed, n) {
    var a = FAKE_WORDS[(hash(seed + ":a" + n)) % FAKE_WORDS.length];
    var b = FAKE_WORDS[(hash(seed + ":b" + n)) % FAKE_WORDS.length];
    return a === b ? a + " (Mock " + n + ")" : a + " " + b + " (Mock)";
  }

  function listeners(seed, n, scale) {
    return 1000 + (hash(seed + ":v" + n) % scale);
  }

  function ok(items, providerUrl) {
    return { status: "ok", value: { items: items, _meta: { url: providerUrl, providerName: "Mock Info" } } };
  }

  function byTrackNumber(a, b) {
    return (a.track_number || 0) - (b.track_number || 0);
  }

  api.informationTypes.onFetch("album_track_popularity", function (entity) {
    if (entity.kind !== "album") return Promise.resolve({ status: "not_found" });
    var artist = entity.artistName || "Unknown Artist";
    var seed = "album:" + artist + ":" + entity.name;
    var url = "https://example.invalid/mock-info/album";

    var load = entity.id > 0 ? api.library.getTracks({ albumId: entity.id }) : Promise.resolve([]);
    return load.then(function (tracks) {
      var items = [];
      var fakeN = 0;
      function pushFake() {
        fakeN++;
        items.push({ name: fakeTitle(seed, fakeN), subtitle: artist, value: listeners(seed, fakeN, 400000), libraryKind: "track" });
      }

      if (!tracks || tracks.length === 0) {
        for (var k = 0; k < 10; k++) pushFake();
        return ok(items, url);
      }

      var sorted = tracks.slice().sort(byTrackNumber);
      pushFake(); // a missing opening track
      for (var i = 0; i < sorted.length; i++) {
        var title = sorted[i].title;
        // One owned track arrives with a suffix — it must still match.
        if (i === 0) title = title + " (Remastered)";
        items.push({ name: title, subtitle: artist, value: listeners(seed, 100 + i, 900000), libraryKind: "track" });
        if (i % 2 === 1) pushFake(); // gaps inside the album
      }
      pushFake(); // a bonus track at the end
      return ok(items, url);
    }).catch(function (e) {
      api.log && api.log("error", "mock-info album fetch failed: " + e);
      return { status: "error" };
    });
  });

  api.informationTypes.onFetch("artist_top_tracks", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    var seed = "artist:" + entity.name;
    var url = "https://example.invalid/mock-info/artist";

    var load = entity.id > 0 ? api.library.getTracks({ artistId: entity.id, limit: 200 }) : Promise.resolve([]);
    return load.then(function (tracks) {
      var rows = [];
      var owned = (tracks || []).slice(0, 12);
      for (var i = 0; i < owned.length; i++) {
        rows.push({ name: owned[i].title, value: listeners(seed, i, 2000000) });
      }
      var fakeCount = owned.length > 0 ? 8 : 12;
      for (var j = 1; j <= fakeCount; j++) {
        rows.push({ name: fakeTitle(seed, j), value: listeners(seed, 500 + j, 2000000) });
      }
      // A ranked list: highest listener count first, like artist.getTopTracks.
      rows.sort(function (a, b) { return b.value - a.value; });
      var items = rows.map(function (r) {
        return { name: r.name, subtitle: entity.name, value: r.value, libraryKind: "track" };
      });
      return ok(items, url);
    }).catch(function (e) {
      api.log && api.log("error", "mock-info artist fetch failed: " + e);
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
