// Web Search plugin for Viboplr
// Owns the user-configurable list of web search providers and contributes a
// dynamic "Search" submenu to artist/album/track context + detail menus.

// Shared across activate()/deactivate() (the factory runs once).
var menuUnsubs = [];

function clearMenuItems() {
  for (var i = 0; i < menuUnsubs.length; i++) {
    try { menuUnsubs[i](); } catch (e) { console.error("[search-providers] unregister failed:", e); }
  }
  menuUnsubs = [];
}

function activate(api) {
  var DEFAULT_PROVIDERS = [
    {
      id: "builtin-google",
      name: "Google",
      enabled: true,
      builtinIcon: "google",
      artistUrl: "https://www.google.com/search?q={artist}",
      albumUrl: "https://www.google.com/search?q={title}+{artist}",
      trackUrl: "https://www.google.com/search?q={title}+{artist}",
    },
    {
      id: "builtin-lastfm",
      name: "Last.fm",
      enabled: true,
      builtinIcon: "lastfm",
      artistUrl: "https://www.last.fm/music/{artist}",
      albumUrl: "https://www.last.fm/music/{artist}/{title}",
      trackUrl: "https://www.last.fm/music/{artist}/_/{title}",
    },
    {
      id: "builtin-x",
      name: "X",
      enabled: true,
      builtinIcon: "x",
      artistUrl: "https://x.com/search?q={artist}",
      albumUrl: "https://x.com/search?q={title}+{artist}",
      trackUrl: "https://x.com/search?q={title}+{artist}",
    },
    {
      id: "builtin-youtube",
      name: "YouTube",
      enabled: true,
      builtinIcon: "youtube",
      artistUrl: "https://www.youtube.com/results?search_query={artist}",
      albumUrl: "https://www.youtube.com/results?search_query={title}+{artist}",
      trackUrl: "https://www.youtube.com/results?search_query={title}+{artist}",
    },
    {
      id: "builtin-genius",
      name: "Genius",
      enabled: true,
      builtinIcon: "genius",
      trackUrl: "https://genius.com/search?q={title}+{artist}",
    },
  ];

  // -- ported helpers (kept in sync with the old host src/searchProviders.ts) --

  function buildSearchUrl(template, params) {
    var url = template;
    if (params.artist) {
      url = url.replace(/\{artist\}/g, encodeURIComponent(params.artist));
    } else {
      url = url.replace(/[+]?\{artist\}/g, "");
    }
    if (params.title) {
      url = url.replace(/\{title\}/g, encodeURIComponent(params.title));
    } else {
      url = url.replace(/[+]?\{title\}/g, "");
    }
    return url;
  }

  function urlKeyFor(context) {
    return context === "artist" ? "artistUrl" : context === "album" ? "albumUrl" : "trackUrl";
  }

  function getProvidersForContext(providers, context) {
    var key = urlKeyFor(context);
    var out = [];
    for (var i = 0; i < providers.length; i++) {
      if (providers[i].enabled && providers[i][key]) out.push(providers[i]);
    }
    return out;
  }

  function genId() {
    return "custom-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  }

  var state = {
    providers: DEFAULT_PROVIDERS.slice(),
    view: "list",   // "list" | "form"
    draft: null,    // { id, name, artistUrl, albumUrl, trackUrl }
    confirm: null,  // { kind: "reset" } | { kind: "delete", id }
  };

  function findProvider(id) {
    for (var i = 0; i < state.providers.length; i++) {
      if (state.providers[i].id === id) return state.providers[i];
    }
    return null;
  }

  function saveProviders() {
    return api.storage.set("providers", state.providers).catch(function (e) {
      console.error("[search-providers] failed to save providers:", e);
    });
  }

  // Persist, rebuild the context-menu items, and re-render the settings panel.
  function commit() {
    saveProviders();
    rebuildMenuItems();
    renderSettings();
  }

  // -- dynamic context-menu items --

  function registerProviderItem(provider, context, order) {
    var actionId = "search:" + context + ":" + provider.id;
    var key = urlKeyFor(context);
    api.contextMenu.onAction(actionId, function (target) {
      var params;
      if (context === "artist") params = { artist: target.artistName };
      else if (context === "album") params = { artist: target.artistName, title: target.albumTitle };
      else params = { artist: target.artistName, title: target.title };
      var url = buildSearchUrl(provider[key], params);
      if (url) {
        api.network.openUrl(url).catch(function (e) {
          console.error("[search-providers] failed to open URL:", e);
        });
      }
    });
    menuUnsubs.push(api.contextMenu.registerItem({
      id: actionId,
      label: provider.name,
      targets: [context],
      submenuLabel: "Search",
      order: order,
    }));
  }

  function rebuildMenuItems() {
    clearMenuItems();
    var contexts = ["artist", "album", "track"];
    for (var c = 0; c < contexts.length; c++) {
      var list = getProvidersForContext(state.providers, contexts[c]);
      for (var i = 0; i < list.length; i++) {
        registerProviderItem(list[i], contexts[c], i);
      }
    }
  }

  // -- settings panel --

  function providerRow(p) {
    var chips = [];
    if (p.artistUrl) chips.push("Artist");
    if (p.albumUrl) chips.push("Album");
    if (p.trackUrl) chips.push("Track");
    var isBuiltin = p.id.indexOf("builtin-") === 0;
    var controls = [
      { type: "toggle", label: "", action: "sp-toggle:" + p.id, checked: !!p.enabled },
      { type: "button", label: "Edit", action: "sp-edit", data: { id: p.id } },
    ];
    if (!isBuiltin) {
      controls.push({ type: "button", label: "Delete", action: "sp-delete", data: { id: p.id } });
    }
    return {
      type: "settings-row",
      label: p.name,
      description: chips.length ? chips.join(" · ") : "No search URLs configured",
      control: { type: "layout", direction: "horizontal", children: controls },
    };
  }

  function registerToggleHandlers() {
    for (var i = 0; i < state.providers.length; i++) {
      (function (p) {
        api.ui.onAction("sp-toggle:" + p.id, function (data) {
          setEnabled(p.id, !!(data && data.value));
        });
      })(state.providers[i]);
    }
  }

  function setEnabled(id, enabled) {
    var next = [];
    for (var i = 0; i < state.providers.length; i++) {
      var p = state.providers[i];
      if (p.id === id) {
        next.push({
          id: p.id, name: p.name, enabled: enabled, builtinIcon: p.builtinIcon,
          artistUrl: p.artistUrl, albumUrl: p.albumUrl, trackUrl: p.trackUrl,
        });
      } else {
        next.push(p);
      }
    }
    state.providers = next;
    commit();
  }

  function renderSettings() {
    registerToggleHandlers();
    var children = [];

    if (state.confirm) {
      var isReset = state.confirm.kind === "reset";
      children.push({
        type: "confirm",
        title: isReset ? "Reset providers" : "Remove provider",
        message: isReset
          ? "Reset to the default search providers? Your custom providers will be removed."
          : "Remove this search provider?",
        confirmLabel: isReset ? "Reset" : "Remove",
        cancelLabel: "Cancel",
        confirmVariant: "danger",
        confirmAction: "sp-confirm-yes",
        cancelAction: "sp-confirm-no",
      });
    } else if (state.view === "form" && state.draft) {
      var isEdit = !!state.draft.id;
      children.push({ type: "section", title: isEdit ? "Edit provider" : "Add provider", children: [
        { type: "settings-row", label: "Name",
          control: { type: "text-input", action: "sp-field-name", value: state.draft.name, placeholder: "My provider" } },
        { type: "settings-row", label: "Artist URL",
          control: { type: "text-input", action: "sp-field-artist", value: state.draft.artistUrl, placeholder: "https://example.com/search?q={artist}" } },
        { type: "settings-row", label: "Album URL",
          control: { type: "text-input", action: "sp-field-album", value: state.draft.albumUrl, placeholder: "https://example.com/search?q={title}+{artist}" } },
        { type: "settings-row", label: "Track URL",
          control: { type: "text-input", action: "sp-field-track", value: state.draft.trackUrl, placeholder: "https://example.com/search?q={title}+{artist}" } },
        { type: "text", content: "<p>Use <code>{artist}</code> and <code>{title}</code> as placeholders. Leave a URL blank to hide that context.</p>" },
        { type: "layout", direction: "horizontal", children: [
          { type: "button", label: "Cancel", action: "sp-cancel" },
          { type: "button", label: "Save", action: "sp-save", variant: "accent" },
        ]},
      ]});
    } else {
      var rows = [];
      for (var i = 0; i < state.providers.length; i++) {
        rows.push(providerRow(state.providers[i]));
      }
      if (rows.length === 0) {
        rows.push({ type: "text", content: "<p>No search providers. Add one below.</p>" });
      }
      children.push({ type: "section", title: "Search providers", children: rows });
      children.push({ type: "layout", direction: "horizontal", children: [
        { type: "button", label: "Add provider", action: "sp-add", variant: "accent" },
        { type: "button", label: "Reset to defaults", action: "sp-reset" },
      ]});
    }

    api.ui.setViewData("search-providers-settings", { type: "layout", direction: "vertical", children: children });
  }

  // -- settings actions --

  api.ui.onAction("sp-add", function () {
    state.draft = { id: null, name: "", artistUrl: "", albumUrl: "", trackUrl: "" };
    state.view = "form";
    renderSettings();
  });

  api.ui.onAction("sp-edit", function (data) {
    if (!data || !data.id) return;
    var p = findProvider(data.id);
    if (!p) return;
    state.draft = {
      id: p.id, name: p.name || "",
      artistUrl: p.artistUrl || "", albumUrl: p.albumUrl || "", trackUrl: p.trackUrl || "",
    };
    state.view = "form";
    renderSettings();
  });

  api.ui.onAction("sp-delete", function (data) {
    if (!data || !data.id) return;
    state.confirm = { kind: "delete", id: data.id };
    renderSettings();
  });

  api.ui.onAction("sp-cancel", function () {
    state.draft = null;
    state.view = "list";
    renderSettings();
  });

  // text-input fires on every change with { value }; update the draft without
  // re-rendering (re-rendering on each keystroke would steal input focus).
  api.ui.onAction("sp-field-name", function (data) { if (state.draft) state.draft.name = (data && data.value) || ""; });
  api.ui.onAction("sp-field-artist", function (data) { if (state.draft) state.draft.artistUrl = (data && data.value) || ""; });
  api.ui.onAction("sp-field-album", function (data) { if (state.draft) state.draft.albumUrl = (data && data.value) || ""; });
  api.ui.onAction("sp-field-track", function (data) { if (state.draft) state.draft.trackUrl = (data && data.value) || ""; });

  api.ui.onAction("sp-save", function () {
    if (!state.draft) return;
    var d = state.draft;
    var name = (d.name || "").trim();
    if (!name) {
      if (api.ui.showNotification) api.ui.showNotification("Provider name is required");
      return;
    }
    var artistUrl = (d.artistUrl || "").trim();
    var albumUrl = (d.albumUrl || "").trim();
    var trackUrl = (d.trackUrl || "").trim();
    var enabled = true;
    if (d.id) {
      var existing = findProvider(d.id);
      if (existing) enabled = existing.enabled;
    }
    var entry = {
      id: d.id || genId(),
      name: name,
      enabled: enabled,
      artistUrl: artistUrl || undefined,
      albumUrl: albumUrl || undefined,
      trackUrl: trackUrl || undefined,
    };
    if (d.id) {
      var next = [];
      for (var i = 0; i < state.providers.length; i++) {
        next.push(state.providers[i].id === d.id ? entry : state.providers[i]);
      }
      state.providers = next;
    } else {
      state.providers = state.providers.concat([entry]);
    }
    state.draft = null;
    state.view = "list";
    commit();
  });

  api.ui.onAction("sp-reset", function () {
    state.confirm = { kind: "reset" };
    renderSettings();
  });

  api.ui.onAction("sp-confirm-yes", function () {
    var c = state.confirm;
    state.confirm = null;
    if (!c) { renderSettings(); return; }
    if (c.kind === "reset") {
      state.providers = DEFAULT_PROVIDERS.slice();
    } else if (c.kind === "delete") {
      var next = [];
      for (var i = 0; i < state.providers.length; i++) {
        if (state.providers[i].id !== c.id) next.push(state.providers[i]);
      }
      state.providers = next;
    }
    commit();
  });

  api.ui.onAction("sp-confirm-no", function () {
    state.confirm = null;
    renderSettings();
  });

  // -- initialize --
  api.storage.get("providers").then(function (saved) {
    state.providers = (saved && saved.length) ? saved : DEFAULT_PROVIDERS.slice();
    rebuildMenuItems();
    renderSettings();
  }).catch(function (e) {
    console.error("[search-providers] failed to load providers:", e);
    state.providers = DEFAULT_PROVIDERS.slice();
    rebuildMenuItems();
    renderSettings();
  });
}

function deactivate() {
  // The host clears tracked unsubscribers on deactivate, but drop our dynamic
  // menu items explicitly too (idempotent).
  clearMenuItems();
}

return { activate: activate, deactivate: deactivate };
