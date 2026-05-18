function activate(api) {
  var DEFAULT_STOPWORDS = [
    "the", "a", "an", "and", "or", "of", "in", "to", "for", "by", "with",
    "from", "at", "on", "is", "are", "was", "were", "be", "been", "am",
    "do", "does", "did", "has", "have", "had", "not", "no", "but", "so",
    "if", "it", "its", "he", "she", "we", "they", "i", "me", "my", "your",
    "his", "her", "our", "their", "you", "us", "them", "this", "that",
    "vol", "volume", "disc", "cd", "various", "artists",
    "various artists", "unknown", "misc", "other", "music", "feat", "ft", "featuring"
  ];

  var STRIP_CHARS_RE = /[()[\]{}<>!?@#$%^&*+=~`|;:'",\-]/g;
  var CATEGORIES = ["Tag", "Artist", "Album", "Year"];

  var state = {
    activeTab: "analyze",
    collections: [],
    selectedCollectionId: null,
    analyzing: false,
    candidates: [],
    analyzeSearch: "",
    threshold: 3,
    ngramSize: 3,
    stopwords: DEFAULT_STOPWORDS.slice(),
    autoAssign: true,
    autoAssignMetadata: true,
    approvedItems: [],
    processedTrackIds: {},
  };

  function loadSettings() {
    return Promise.all([
      api.storage.get("approved-items"),
      api.storage.get("approved-tags"),
      api.storage.get("stopwords"),
      api.storage.get("settings"),
    ]).then(function (results) {
      if (results[0]) {
        state.approvedItems = results[0];
      } else if (results[1]) {
        state.approvedItems = results[1].map(function (tag) {
          return { ngram: tag, type: "tag" };
        });
        api.storage.set("approved-items", state.approvedItems);
        api.storage.delete("approved-tags");
      }
      if (results[2]) state.stopwords = results[2];
      if (results[3]) {
        if (results[3].threshold != null) state.threshold = results[3].threshold;
        if (results[3].autoAssign != null) state.autoAssign = results[3].autoAssign;
        if (results[3].autoAssignMetadata != null) state.autoAssignMetadata = results[3].autoAssignMetadata;
        if (results[3].ngramSize != null) state.ngramSize = results[3].ngramSize;
      }
    });
  }

  function saveApprovedItems() {
    return api.storage.set("approved-items", state.approvedItems);
  }

  function saveStopwords() {
    return api.storage.set("stopwords", state.stopwords);
  }

  function saveSettings() {
    return api.storage.set("settings", {
      threshold: state.threshold,
      autoAssign: state.autoAssign,
      autoAssignMetadata: state.autoAssignMetadata,
      ngramSize: state.ngramSize,
    });
  }

  function normalizeStr(s) {
    return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
  }

  function stripExtension(filename) {
    return filename.replace(/\.[^.]+$/, "");
  }

  function stripTrackNumber(filename) {
    return filename.replace(/^\d{1,3}[\s.\-_]*(?:\d{1,3}[\s.\-_]*)?(?:\-\s*)?/, "").trim();
  }

  function splitSegmentOnDelimiters(segment) {
    var parts = segment.split(/\s-\s|_/);
    var result = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      var cleaned = part.replace(/[(\[][^\])]*[)\]]/g, "").trim();
      var bracketMatches = part.match(/[(\[]([^\])]+)[)\]]/g);
      if (cleaned) result.push(cleaned);
      if (bracketMatches) {
        for (var j = 0; j < bracketMatches.length; j++) {
          var inner = bracketMatches[j].slice(1, -1).trim();
          if (inner) result.push(inner);
        }
      }
    }
    return result;
  }

  function generateNgrams(words, n) {
    if (!n) n = 3;
    var ngrams = [];
    for (var i = 0; i <= words.length - n; i++) {
      ngrams.push(words.slice(i, i + n).join(" "));
    }
    return ngrams;
  }

  function tokenizeSegments(segments) {
    var stopwordsSet = {};
    for (var s = 0; s < state.stopwords.length; s++) {
      stopwordsSet[normalizeStr(state.stopwords[s])] = true;
    }
    var allNgrams = [];
    for (var i = 0; i < segments.length; i++) {
      var subSegments = splitSegmentOnDelimiters(segments[i]);
      for (var j = 0; j < subSegments.length; j++) {
        var cleaned = subSegments[j].replace(STRIP_CHARS_RE, " ");
        var words = cleaned.split(/\s+/).filter(function (w) {
          if (w.length === 0) return false;
          var norm = normalizeStr(w);
          if (norm.length <= 1) return false;
          if (/^\d+$/.test(norm)) return false;
          if (stopwordsSet[norm]) return false;
          return true;
        });
        var ngrams = generateNgrams(words, state.ngramSize);
        for (var k = 0; k < ngrams.length; k++) {
          var norm = normalizeStr(ngrams[k]);
          if (norm.length <= 1) continue;
          allNgrams.push(norm);
        }
      }
    }
    return allNgrams;
  }

  function tokenizePath(path, collectionRoot) {
    var cleaned = path.replace(/^file:\/\//, "");
    if (collectionRoot && cleaned.indexOf(collectionRoot) === 0) {
      cleaned = cleaned.slice(collectionRoot.length);
    }
    cleaned = cleaned.replace(/^\//, "");
    var segments = cleaned.split(/[/\\]/).filter(function (s) { return s.length > 0; });
    if (segments.length === 0) return [];
    var lastIdx = segments.length - 1;
    segments[lastIdx] = stripTrackNumber(stripExtension(segments[lastIdx]));
    if (!segments[lastIdx]) segments.pop();
    return tokenizeSegments(segments);
  }

  function tokenizeMetadata(title, artistName, albumTitle) {
    var parts = [title, artistName, albumTitle].filter(function (p) { return !!p; });
    return tokenizeSegments(parts);
  }

  function tokenizeTrack(track, collectionRoots) {
    if (track.path && track.path.indexOf("file://") === 0) {
      var root = collectionRoots[track.collection_id] || "";
      return tokenizePath(track.path, root);
    }
    return tokenizeMetadata(track.title || "", track.artist_name || null, track.album_title || null);
  }

  function getCollectionRoots() {
    var roots = {};
    for (var i = 0; i < state.collections.length; i++) {
      roots[state.collections[i].id] = state.collections[i].path || "";
    }
    return roots;
  }

  function fetchAllTracks() {
    var allTracks = [];
    var pageSize = 500;
    function fetchPage(offset) {
      return api.library.getTracks({ limit: pageSize, offset: offset }).then(function (tracks) {
        allTracks = allTracks.concat(tracks);
        if (tracks.length >= pageSize) {
          return fetchPage(offset + pageSize);
        }
        return allTracks;
      });
    }
    return fetchPage(0);
  }

  function findMatchingTrackIds(ngram, tracks, collectionRoots) {
    var normalizedNgram = normalizeStr(ngram);
    var matchingIds = [];
    for (var i = 0; i < tracks.length; i++) {
      var trackNgrams = tokenizeTrack(tracks[i], collectionRoots);
      for (var j = 0; j < trackNgrams.length; j++) {
        if (trackNgrams[j] === normalizedNgram) {
          matchingIds.push(tracks[i].id);
          break;
        }
      }
    }
    return matchingIds;
  }

  function analyzeCollection(collectionId) {
    state.analyzing = true;
    state.candidates = [];
    render();

    var collectionRoots = getCollectionRoots();

    fetchAllTracks().then(function (tracks) {
      if (collectionId != null) {
        tracks = tracks.filter(function (t) { return t.collection_id === collectionId; });
      }

      var globalFreq = {};
      for (var i = 0; i < tracks.length; i++) {
        var ngrams = tokenizeTrack(tracks[i], collectionRoots);
        var seen = {};
        for (var j = 0; j < ngrams.length; j++) {
          if (!seen[ngrams[j]]) {
            seen[ngrams[j]] = true;
            globalFreq[ngrams[j]] = (globalFreq[ngrams[j]] || 0) + 1;
          }
        }
        state.processedTrackIds[tracks[i].id] = true;
      }

      var candidateList = [];
      var keys = Object.keys(globalFreq);
      for (var k = 0; k < keys.length; k++) {
        if (globalFreq[keys[k]] >= state.threshold) {
          var wordCount = keys[k].split(/\s+/).length;
          candidateList.push({ ngram: keys[k], count: globalFreq[keys[k]], words: wordCount });
        }
      }
      candidateList.sort(function (a, b) {
        if (b.words !== a.words) return b.words - a.words;
        return b.count - a.count;
      });

      state.candidates = candidateList;
      state.analyzing = false;
      render();
    }).catch(function (err) {
      console.error("Auto-tagger analysis failed:", err);
      state.analyzing = false;
      render();
    });
  }

  function applyClassifications(itemsMap) {
    var keys = Object.keys(itemsMap);
    var added = 0;
    for (var i = 0; i < keys.length; i++) {
      var categories = itemsMap[keys[i]];
      if (!categories || categories.length === 0) continue;
      var ngram = keys[i];
      for (var c = 0; c < categories.length; c++) {
        state.approvedItems.push({ ngram: ngram, type: categories[c].toLowerCase() });
        added++;
      }
    }

    if (added === 0) return;
    saveApprovedItems();

    // Remove added candidates from the list
    var addedSet = {};
    for (var j = 0; j < keys.length; j++) {
      if (itemsMap[keys[j]] && itemsMap[keys[j]].length > 0) {
        addedSet[normalizeStr(keys[j])] = true;
      }
    }
    state.candidates = state.candidates.filter(function (c) {
      return !addedSet[normalizeStr(c.ngram)];
    });
    render();
  }

  function autoAssignTrack(trackData) {
    if (!state.autoAssign || state.approvedItems.length === 0) return;
    var collectionRoots = getCollectionRoots();
    var ngrams;
    if (trackData.path && trackData.path.indexOf("file://") === 0) {
      var root = collectionRoots[trackData.collectionId] || "";
      ngrams = tokenizePath(trackData.path, root);
    } else {
      ngrams = tokenizeMetadata(
        trackData.title || "",
        trackData.artistName || null,
        trackData.albumTitle || null
      );
    }

    var matchedTags = [];
    var matchedArtist = null;
    var matchedAlbum = null;
    var matchedYear = null;

    for (var i = 0; i < state.approvedItems.length; i++) {
      var item = state.approvedItems[i];
      var normalizedNgram = normalizeStr(item.ngram);
      var found = false;
      for (var j = 0; j < ngrams.length; j++) {
        if (ngrams[j] === normalizedNgram) {
          found = true;
          break;
        }
      }
      if (!found) continue;

      if (item.type === "tag") {
        matchedTags.push(item.ngram);
      } else if (item.type === "artist" && state.autoAssignMetadata) {
        if (!trackData.artistName) matchedArtist = item.ngram;
      } else if (item.type === "album" && state.autoAssignMetadata) {
        if (!trackData.albumTitle) matchedAlbum = item.ngram;
      } else if (item.type === "year" && state.autoAssignMetadata) {
        var yearVal = parseInt(item.ngram, 10);
        if (!isNaN(yearVal)) matchedYear = yearVal;
      }
    }

    if (matchedTags.length > 0) {
      api.library.applyTags(trackData.trackId, matchedTags).catch(function (err) {
        console.error("Auto-tagger: failed to apply tags to track " + trackData.trackId + ":", err);
      });
    }

    if (matchedArtist || matchedAlbum || matchedYear) {
      var fields = {};
      if (matchedArtist) fields.artist_name = matchedArtist;
      if (matchedAlbum) fields.album_title = matchedAlbum;
      if (matchedYear) fields.year = matchedYear;
      api.library.bulkUpdateTracks([trackData.trackId], fields).catch(function (err) {
        console.error("Auto-tagger: failed to update metadata for track " + trackData.trackId + ":", err);
      });
    }
  }

  api.library.onTrackAdded(function (trackData) {
    autoAssignTrack(trackData);
  });

  api.library.onScanComplete(function (result) {
    if (!state.autoAssign || state.approvedItems.length === 0) return;
    if ((result.newTracks || 0) <= 0) return;
    var collectionRoots = getCollectionRoots();

    fetchAllTracks().then(function (tracks) {
      if (result.collectionId != null) {
        tracks = tracks.filter(function (t) { return t.collection_id === result.collectionId; });
      }

      var tagAssignments = [];
      var artistBatches = {};
      var albumBatches = {};
      var yearBatches = {};

      for (var i = 0; i < tracks.length; i++) {
        if (state.processedTrackIds[tracks[i].id]) continue;
        var ngrams = tokenizeTrack(tracks[i], collectionRoots);

        var trackTags = [];
        for (var j = 0; j < state.approvedItems.length; j++) {
          var item = state.approvedItems[j];
          var normalizedNgram = normalizeStr(item.ngram);
          var found = false;
          for (var k = 0; k < ngrams.length; k++) {
            if (ngrams[k] === normalizedNgram) {
              found = true;
              break;
            }
          }
          if (!found) continue;

          if (item.type === "tag") {
            if (trackTags.indexOf(item.ngram) === -1) trackTags.push(item.ngram);
          } else if (item.type === "artist" && state.autoAssignMetadata) {
            if (!tracks[i].artist_name) {
              if (!artistBatches[item.ngram]) artistBatches[item.ngram] = [];
              artistBatches[item.ngram].push(tracks[i].id);
            }
          } else if (item.type === "album" && state.autoAssignMetadata) {
            if (!tracks[i].album_title) {
              if (!albumBatches[item.ngram]) albumBatches[item.ngram] = [];
              albumBatches[item.ngram].push(tracks[i].id);
            }
          } else if (item.type === "year" && state.autoAssignMetadata) {
            var yearVal = parseInt(item.ngram, 10);
            if (!isNaN(yearVal)) {
              if (!yearBatches[item.ngram]) yearBatches[item.ngram] = [];
              yearBatches[item.ngram].push(tracks[i].id);
            }
          }
        }

        if (trackTags.length > 0) {
          tagAssignments.push([tracks[i].id, trackTags]);
        }
        state.processedTrackIds[tracks[i].id] = true;
      }

      var promises = [];
      if (tagAssignments.length > 0) {
        promises.push(api.library.applyTagsBulk(tagAssignments));
      }

      var artistKeys = Object.keys(artistBatches);
      for (var ai = 0; ai < artistKeys.length; ai++) {
        promises.push(api.library.bulkUpdateTracks(artistBatches[artistKeys[ai]], { artist_name: artistKeys[ai] }));
      }

      var albumKeys = Object.keys(albumBatches);
      for (var bi = 0; bi < albumKeys.length; bi++) {
        promises.push(api.library.bulkUpdateTracks(albumBatches[albumKeys[bi]], { album_title: albumKeys[bi] }));
      }

      var yearKeys = Object.keys(yearBatches);
      for (var yi = 0; yi < yearKeys.length; yi++) {
        var yv = parseInt(yearKeys[yi], 10);
        if (!isNaN(yv)) {
          promises.push(api.library.bulkUpdateTracks(yearBatches[yearKeys[yi]], { year: yv }));
        }
      }

      if (promises.length > 0) {
        return Promise.all(promises);
      }
    }).catch(function (err) {
      console.error("Auto-tagger: scan:complete handler failed:", err);
    });
  });

  // --- UI Rendering ---

  function render() {
    if (state.activeTab === "analyze") {
      renderAnalyze();
    } else if (state.activeTab === "approved") {
      renderApproved();
    } else if (state.activeTab === "settings") {
      renderSettings();
    }
  }

  function buildTabs() {
    return {
      type: "tabs",
      activeTab: state.activeTab,
      action: "switch-tab",
      tabs: [
        { id: "analyze", label: "Analyze" },
        { id: "approved", label: "Approved", count: state.approvedItems.length || undefined },
        { id: "settings", label: "Settings" },
      ],
    };
  }

  function renderAnalyze() {
    var children = [buildTabs()];

    var collectionOptions = [{ value: "all", label: "All Collections" }];
    for (var i = 0; i < state.collections.length; i++) {
      collectionOptions.push({
        value: String(state.collections[i].id),
        label: state.collections[i].name,
      });
    }

    // Options row 1: Collection + N-gram + Min frequency
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        {
          type: "select",
          label: "Collection",
          value: state.selectedCollectionId != null ? String(state.selectedCollectionId) : "all",
          options: collectionOptions,
          action: "select-collection",
        },
        {
          type: "select",
          label: "N-gram",
          value: String(state.ngramSize),
          options: [
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "4", label: "4" },
          ],
          action: "set-ngram-size",
        },
        {
          type: "select",
          label: "Min freq",
          value: String(state.threshold),
          options: [
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "5", label: "5" },
            { value: "10", label: "10" },
            { value: "20", label: "20" },
            { value: "50", label: "50" },
          ],
          action: "set-threshold",
        },
      ],
    });

    // Options row 2: Search + Analyze button
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        {
          type: "search-input",
          value: state.analyzeSearch,
          placeholder: "Filter candidates...",
          action: "analyze-search",
        },
        {
          type: "button",
          label: state.analyzing ? "Analyzing..." : "Analyze",
          action: "run-analyze",
          disabled: state.analyzing,
          variant: "accent",
        },
      ],
    });

    if (state.analyzing) {
      children.push({ type: "loading", message: "Analyzing tracks..." });
    } else if (state.candidates.length > 0) {
      var approvedSet = {};
      for (var a = 0; a < state.approvedItems.length; a++) {
        approvedSet[normalizeStr(state.approvedItems[a].ngram)] = true;
      }
      var searchTerm = normalizeStr(state.analyzeSearch);
      var filtered = state.candidates.filter(function (c) {
        if (c.count < state.threshold) return false;
        if (approvedSet[normalizeStr(c.ngram)]) return false;
        if (searchTerm && normalizeStr(c.ngram).indexOf(searchTerm) === -1) return false;
        return true;
      });

      var items = [];
      for (var j = 0; j < filtered.length; j++) {
        items.push({
          id: filtered[j].ngram,
          title: filtered[j].ngram,
          subtitle: filtered[j].count + " tracks · " + filtered[j].words + "-gram",
        });
      }

      children.push({
        type: "track-row-list",
        items: items,
        categories: CATEGORIES,
        actions: [
          { id: "apply-classifications", label: "Add" },
        ],
      });

      if (filtered.length !== state.candidates.length) {
        children.push({ type: "text", content: filtered.length + " of " + state.candidates.length + " candidates shown" });
      }
    } else if (!state.analyzing) {
      children.push({
        type: "text",
        content: "Click Analyze to scan your library and discover recurring patterns in file paths and metadata.",
      });
    }

    api.ui.setViewData("auto-tagger-view", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderApproved() {
    var children = [buildTabs()];

    if (state.approvedItems.length === 0) {
      children.push({
        type: "text",
        content: "No approved items yet. Use the Analyze tab to classify candidates.",
      });
    } else {
      var items = [];
      for (var i = 0; i < state.approvedItems.length; i++) {
        var item = state.approvedItems[i];
        items.push({
          id: "item:" + i,
          title: item.ngram,
          subtitle: item.type.charAt(0).toUpperCase() + item.type.slice(1),
          checked: [item.type.charAt(0).toUpperCase() + item.type.slice(1)],
        });
      }
      children.push({
        type: "track-row-list",
        items: items,
        categories: CATEGORIES,
        actions: [
          { id: "save-approved", label: "Save" },
          { id: "remove-unchecked-approved", label: "Remove Unchecked" },
        ],
      });
    }

    api.ui.setViewData("auto-tagger-view", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderSettings() {
    var children = [buildTabs()];

    children.push({
      type: "settings-row",
      label: "Default frequency threshold",
      description: "Minimum number of tracks an n-gram must appear in",
      control: {
        type: "select",
        value: String(state.threshold),
        options: [
          { value: "2", label: "2" },
          { value: "3", label: "3" },
          { value: "5", label: "5" },
          { value: "10", label: "10" },
          { value: "20", label: "20" },
        ],
        action: "set-default-threshold",
      },
    });

    children.push({
      type: "settings-row",
      label: "Auto-assign tags on new tracks",
      description: "Apply rules when tracks are added",
      control: {
        type: "toggle",
        label: "Auto-assign",
        checked: state.autoAssign,
        action: "toggle-auto-assign",
      },
    });

    children.push({
      type: "settings-row",
      label: "Auto-assign artist/album/year",
      description: "Set metadata on new tracks with empty fields",
      control: {
        type: "toggle",
        label: "Auto-assign metadata",
        checked: state.autoAssignMetadata,
        action: "toggle-auto-assign-metadata",
      },
    });

    children.push({
      type: "section",
      title: "Stopwords",
      children: [
        { type: "text", content: "Words to exclude from 1-gram analysis (comma-separated):" },
        {
          type: "search-input",
          value: state.stopwords.join(", "),
          placeholder: "the, a, an, ...",
          action: "update-stopwords",
        },
      ],
    });

    api.ui.setViewData("auto-tagger-view", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  // --- Action Handlers ---

  api.ui.onAction("switch-tab", function (data) {
    if (data && data.tabId) {
      state.activeTab = data.tabId;
      render();
    }
  });

  api.ui.onAction("select-collection", function (data) {
    if (data && data.value) {
      state.selectedCollectionId = data.value === "all" ? null : parseInt(data.value, 10);
    }
  });

  api.ui.onAction("analyze-search", function (data) {
    if (data && typeof data.query === "string") {
      state.analyzeSearch = data.query;
      render();
    }
  });

  api.ui.onAction("run-analyze", function () {
    analyzeCollection(state.selectedCollectionId);
  });

  api.ui.onAction("set-threshold", function (data) {
    if (data && data.value) {
      state.threshold = parseInt(data.value, 10);
      render();
    }
  });

  api.ui.onAction("set-ngram-size", function (data) {
    if (data && data.value) {
      state.ngramSize = parseInt(data.value, 10);
      saveSettings();
      render();
    }
  });

  api.ui.onAction("apply-classifications", function (data) {
    if (data && data.items) {
      applyClassifications(data.items);
    }
  });


  api.ui.onAction("save-approved", function (data) {
    if (data && data.items) {
      var newItems = [];
      var keys = Object.keys(data.items);
      for (var i = 0; i < keys.length; i++) {
        var id = keys[i];
        var categories = data.items[id];
        if (!categories || categories.length === 0) continue;
        var match = id.match(/^item:(\d+)$/);
        if (match) {
          var idx = parseInt(match[1], 10);
          if (idx < state.approvedItems.length) {
            for (var c = 0; c < categories.length; c++) {
              newItems.push({ ngram: state.approvedItems[idx].ngram, type: categories[c].toLowerCase() });
            }
          }
        }
      }
      state.approvedItems = newItems;
      saveApprovedItems();
      render();
    }
  });

  api.ui.onAction("remove-unchecked-approved", function (data) {
    if (data && data.items) {
      var keepIndices = {};
      var keys = Object.keys(data.items);
      for (var i = 0; i < keys.length; i++) {
        var categories = data.items[keys[i]];
        if (categories && categories.length > 0) {
          var match = keys[i].match(/^item:(\d+)$/);
          if (match) keepIndices[parseInt(match[1], 10)] = true;
        }
      }
      var newItems = [];
      for (var j = 0; j < state.approvedItems.length; j++) {
        if (keepIndices[j]) newItems.push(state.approvedItems[j]);
      }
      state.approvedItems = newItems;
      saveApprovedItems();
      render();
    }
  });

  api.ui.onAction("set-default-threshold", function (data) {
    if (data && data.value) {
      state.threshold = parseInt(data.value, 10);
      saveSettings();
      render();
    }
  });

  api.ui.onAction("toggle-auto-assign", function () {
    state.autoAssign = !state.autoAssign;
    saveSettings();
    render();
  });

  api.ui.onAction("toggle-auto-assign-metadata", function () {
    state.autoAssignMetadata = !state.autoAssignMetadata;
    saveSettings();
    render();
  });

  api.ui.onAction("update-stopwords", function (data) {
    if (data && typeof data.query === "string") {
      state.stopwords = data.query.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      saveStopwords();
    }
  });

  // --- Init ---

  loadSettings().then(function () {
    return api.collections.getLocalCollections();
  }).then(function (collections) {
    state.collections = collections;
    render();
  }).catch(function (err) {
    console.error("Auto-tagger init failed:", err);
    render();
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
