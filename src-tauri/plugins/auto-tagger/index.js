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

  var state = {
    activeTab: "analyze",
    collections: [],
    selectedCollectionId: null,
    analyzing: false,
    candidates: [],
    analyzeSearch: "",
    threshold: 3,
    approvedTags: [],
    stopwords: DEFAULT_STOPWORDS.slice(),
    autoAssign: true,
    processedTrackIds: {},
  };

  function loadSettings() {
    return Promise.all([
      api.storage.get("approved-tags"),
      api.storage.get("stopwords"),
      api.storage.get("settings"),
    ]).then(function (results) {
      if (results[0]) state.approvedTags = results[0];
      if (results[1]) state.stopwords = results[1];
      if (results[2]) {
        if (results[2].threshold != null) state.threshold = results[2].threshold;
        if (results[2].autoAssign != null) state.autoAssign = results[2].autoAssign;
      }
    });
  }

  function saveApprovedTags() {
    return api.storage.set("approved-tags", state.approvedTags);
  }

  function saveStopwords() {
    return api.storage.set("stopwords", state.stopwords);
  }

  function saveSettings() {
    return api.storage.set("settings", {
      threshold: state.threshold,
      autoAssign: state.autoAssign,
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

  function generateNgrams(words, maxN) {
    if (!maxN) maxN = 3;
    var ngrams = [];
    for (var n = 1; n <= maxN; n++) {
      for (var i = 0; i <= words.length - n; i++) {
        ngrams.push(words.slice(i, i + n).join(" "));
      }
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
        var ngrams = generateNgrams(words);
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

  function analyzeCollection(collectionId) {
    state.analyzing = true;
    state.candidates = [];
    render();

    var collectionRoots = {};
    for (var i = 0; i < state.collections.length; i++) {
      collectionRoots[state.collections[i].id] = state.collections[i].path || "";
    }

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
          candidateList.push({ ngram: keys[k], count: globalFreq[keys[k]] });
        }
      }
      candidateList.sort(function (a, b) {
        var aWords = a.ngram.split(/\s+/).length;
        var bWords = b.ngram.split(/\s+/).length;
        if (bWords !== aWords) return bWords - aWords;
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

  function fetchAllTracks() {
    var allTracks = [];
    var pageSize = 500;
    function fetchPage(offset) {
      return api.informationTypes.invoke("get_tracks", {
        opts: { limit: pageSize, offset: offset },
      }).then(function (tracks) {
        allTracks = allTracks.concat(tracks);
        if (tracks.length >= pageSize) {
          return fetchPage(offset + pageSize);
        }
        return allTracks;
      });
    }
    return fetchPage(0);
  }

  function approveSelected(selectedNgrams) {
    var newTags = [];
    for (var i = 0; i < selectedNgrams.length; i++) {
      var ng = selectedNgrams[i];
      var alreadyApproved = false;
      for (var j = 0; j < state.approvedTags.length; j++) {
        if (normalizeStr(state.approvedTags[j]) === normalizeStr(ng)) {
          alreadyApproved = true;
          break;
        }
      }
      if (!alreadyApproved) {
        newTags.push(ng);
        state.approvedTags.push(ng);
      }
    }
    saveApprovedTags();
    if (newTags.length > 0) {
      applyTagsToMatchingTracks(newTags);
    }
    render();
  }

  function applyTagsToMatchingTracks(tagsToCheck) {
    var collectionRoots = {};
    for (var i = 0; i < state.collections.length; i++) {
      collectionRoots[state.collections[i].id] = state.collections[i].path || "";
    }
    var normalizedTags = {};
    for (var t = 0; t < tagsToCheck.length; t++) {
      normalizedTags[normalizeStr(tagsToCheck[t])] = tagsToCheck[t];
    }

    fetchAllTracks().then(function (tracks) {
      for (var i = 0; i < tracks.length; i++) {
        var ngrams = tokenizeTrack(tracks[i], collectionRoots);
        var matchedTags = [];
        for (var j = 0; j < ngrams.length; j++) {
          var original = normalizedTags[ngrams[j]];
          if (original && matchedTags.indexOf(original) === -1) {
            matchedTags.push(original);
          }
        }
        if (matchedTags.length > 0) {
          api.library.applyTags(tracks[i].id, matchedTags).catch(function (err) {
            console.error("Failed to apply tags:", err);
          });
        }
        state.processedTrackIds[tracks[i].id] = true;
      }
    }).catch(function (err) {
      console.error("Failed to apply tags to matching tracks:", err);
    });
  }

  function runNow() {
    applyTagsToMatchingTracks(state.approvedTags);
  }

  function autoAssignTrack(trackData) {
    if (!state.autoAssign || state.approvedTags.length === 0) return;
    var collectionRoots = {};
    for (var i = 0; i < state.collections.length; i++) {
      collectionRoots[state.collections[i].id] = state.collections[i].path || "";
    }
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
    var normalizedApproved = {};
    for (var t = 0; t < state.approvedTags.length; t++) {
      normalizedApproved[normalizeStr(state.approvedTags[t])] = state.approvedTags[t];
    }
    var matchedTags = [];
    for (var j = 0; j < ngrams.length; j++) {
      var original = normalizedApproved[ngrams[j]];
      if (original && matchedTags.indexOf(original) === -1) {
        matchedTags.push(original);
      }
    }
    if (matchedTags.length > 0) {
      api.library.applyTags(trackData.trackId, matchedTags).catch(function (err) {
        console.error("Auto-tagger: failed to apply tags to track " + trackData.trackId + ":", err);
      });
    }
  }

  api.library.onTrackAdded(function (trackData) {
    autoAssignTrack(trackData);
  });

  api.library.onScanComplete(function (result) {
    if (!state.autoAssign || state.approvedTags.length === 0) return;
    if ((result.newTracks || 0) <= 0) return;
    var collectionRoots = {};
    for (var i = 0; i < state.collections.length; i++) {
      collectionRoots[state.collections[i].id] = state.collections[i].path || "";
    }
    fetchAllTracks().then(function (tracks) {
      if (result.collectionId != null) {
        tracks = tracks.filter(function (t) { return t.collection_id === result.collectionId; });
      }
      var normalizedApproved = {};
      for (var t = 0; t < state.approvedTags.length; t++) {
        normalizedApproved[normalizeStr(state.approvedTags[t])] = state.approvedTags[t];
      }
      for (var i = 0; i < tracks.length; i++) {
        if (state.processedTrackIds[tracks[i].id]) continue;
        var ngrams = tokenizeTrack(tracks[i], collectionRoots);
        var matchedTags = [];
        for (var j = 0; j < ngrams.length; j++) {
          var original = normalizedApproved[ngrams[j]];
          if (original && matchedTags.indexOf(original) === -1) {
            matchedTags.push(original);
          }
        }
        if (matchedTags.length > 0) {
          api.library.applyTags(tracks[i].id, matchedTags).catch(function (err) {
            console.error("Auto-tagger: failed to apply tags:", err);
          });
        }
        state.processedTrackIds[tracks[i].id] = true;
      }
    }).catch(function (err) {
      console.error("Auto-tagger: scan:complete handler failed:", err);
    });
  });

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
        { id: "approved", label: "Approved Tags", count: state.approvedTags.length || undefined },
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
          type: "button",
          label: state.analyzing ? "Analyzing..." : "Analyze",
          action: "run-analyze",
          disabled: state.analyzing,
        },
      ],
    });

    if (state.analyzing) {
      children.push({ type: "loading", message: "Analyzing tracks..." });
    } else if (state.candidates.length > 0) {
      children.push({
        type: "settings-row",
        label: "Min frequency",
        description: "Only show n-grams appearing in at least this many tracks",
        control: {
          type: "select",
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
      });

      children.push({
        type: "search-input",
        value: state.analyzeSearch,
        placeholder: "Filter candidates...",
        action: "analyze-search",
      });

      var approvedSet = {};
      for (var a = 0; a < state.approvedTags.length; a++) {
        approvedSet[normalizeStr(state.approvedTags[a])] = true;
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
          subtitle: filtered[j].count + " tracks",
        });
      }
      children.push({
        type: "track-row-list",
        items: items,
        selectable: true,
        actions: [
          { id: "approve-selected", label: "Approve Selected" },
        ],
      });
      children.push({ type: "text", content: filtered.length + " candidates above threshold" });
    } else {
      children.push({ type: "text", content: "Select a collection and click Analyze to discover tag candidates." });
    }

    api.ui.setViewData("auto-tagger-view", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderApproved() {
    var children = [buildTabs()];

    if (state.approvedTags.length === 0) {
      children.push({ type: "text", content: "No approved tags yet. Use the Analyze tab to discover and approve tag candidates." });
    } else {
      var items = [];
      for (var i = 0; i < state.approvedTags.length; i++) {
        items.push({
          id: "tag:" + i,
          title: state.approvedTags[i],
        });
      }
      children.push({
        type: "track-row-list",
        items: items,
        selectable: true,
        actions: [
          { id: "remove-selected", label: "Remove Selected" },
        ],
      });
    }

    children.push({
      type: "button",
      label: "Run Now",
      action: "run-now",
      disabled: state.approvedTags.length === 0,
    });

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
      label: "Auto-assign on new tracks",
      description: "Automatically apply approved tags to new tracks when they are added",
      control: {
        type: "toggle",
        label: "Auto-assign",
        checked: state.autoAssign,
        action: "toggle-auto-assign",
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

  api.ui.onAction("switch-tab", function (data) {
    if (data && data.tabId) {
      state.activeTab = data.tabId;
      render();
    }
  });

  api.ui.onAction("select-collection", function (data) {
    if (data && data.value) {
      state.selectedCollectionId = data.value === "all" ? null : parseInt(data.value, 10);
      render();
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

  api.ui.onAction("approve-selected", function (data) {
    if (data && data.selectedIds && data.selectedIds.length > 0) {
      approveSelected(data.selectedIds);
    }
  });

  api.ui.onAction("remove-selected", function (data) {
    if (data && data.selectedIds && data.selectedIds.length > 0) {
      var indicesToRemove = [];
      for (var i = 0; i < data.selectedIds.length; i++) {
        var match = data.selectedIds[i].match(/^tag:(\d+)$/);
        if (match) indicesToRemove.push(parseInt(match[1], 10));
      }
      indicesToRemove.sort(function (a, b) { return b - a; });
      for (var j = 0; j < indicesToRemove.length; j++) {
        state.approvedTags.splice(indicesToRemove[j], 1);
      }
      saveApprovedTags();
      render();
    }
  });

  api.ui.onAction("run-now", function () {
    runNow();
    api.ui.showNotification("Applying approved tags to all matching tracks...");
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

  api.ui.onAction("update-stopwords", function (data) {
    if (data && typeof data.query === "string") {
      state.stopwords = data.query.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
      saveStopwords();
    }
  });

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
