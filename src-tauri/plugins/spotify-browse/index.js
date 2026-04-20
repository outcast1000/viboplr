// Spotify Browse Plugin for Viboplr
// Opens open.spotify.com in an internal browse window, navigates to Made for You,
// and scrapes all playlists and their tracks from the rendered DOM.

function activate(api) {
  var browseHandle = null;

  var state = {
    currentView: "home",
    // idle | waiting-login | finding-made-for-you | scraping-playlists |
    // scraping-tracks | done | error
    status: "idle",
    playlists: [],
    playlistTracks: {},   // playlistId -> [{ name, artist, album, duration, imageUrl }]
    currentPlaylist: null,
    scrapeProgress: { current: 0, total: 0, name: "" },
    errorMessage: "",
    browserVisible: false,
    debugLog: [],
    activeTab: "home",
    lastLoginCheck: null,
    archivedIds: [],
    updatedPlaylistIds: {},
    refreshing: false,
    showBrowserOnRefresh: false,
    savedAt: null,
    archiveIndex: [],
    refreshSummary: "",
    currentArchive: null,
    currentArchiveKey: null,
  };

  // ---- Helpers ----

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function dbg(tag, msg, data) {
    var ts = new Date().toLocaleTimeString();
    state.debugLog.push({ ts: ts, tag: tag, msg: msg, data: data });
    console.log("[spotify-dbg]", tag, msg, data !== undefined ? data : "");
  }

  function formatDebugData(data) {
    if (data === undefined || data === null) return "";
    try {
      return JSON.stringify(data, null, 2);
    } catch(e) {
      return "" + data;
    }
  }

  function cleanup() {
    if (browseHandle) {
      browseHandle.close().catch(function(err) {
        console.error("Failed to close browse window:", err);
      });
      browseHandle = null;
    }
    state.browserVisible = false;
  }

  // ---- Change detection & archiving helpers ----

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

  // ---- Render ----

  function render() {
    if (state.currentView === "playlist") { renderPlaylist(); return; }
    if (state.currentView === "archive-detail") { renderArchiveDetail(); return; }
    if (state.activeTab === "archive") { renderArchive(); return; }
    if (state.activeTab === "debug") { renderDebugLog(); return; }
    renderHome();
  }

  function getStatusText() {
    if (state.status === "waiting-login") return "Waiting for login\u2026";
    if (state.status === "finding-made-for-you") return "Navigating to Made for You\u2026";
    if (state.status === "scraping-playlists") return "Grabbing playlists\u2026";
    if (state.status === "scraping-tracks") {
      var lbl = "Grabbing tracks";
      if (state.scrapeProgress.name) lbl += ": " + state.scrapeProgress.name;
      if (state.scrapeProgress.total > 0) lbl += " (" + state.scrapeProgress.current + "/" + state.scrapeProgress.total + ")";
      return lbl + "\u2026";
    }
    if (state.status === "error") return state.errorMessage;
    if (state.refreshSummary) return state.refreshSummary;
    return "";
  }

  function buildHeader() {
    var headerChildren = [
      { type: "text", content: "<b style='font-size:var(--fs-sm)'>Spotify</b>" },
    ];

    if (state.status === "idle") {
      headerChildren.push({ type: "button", label: "Open Spotify", action: "open-spotify", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
    } else if (state.status === "waiting-login" || state.status === "finding-made-for-you" || state.status === "scraping-playlists" || state.status === "scraping-tracks") {
      headerChildren.push({ type: "button", label: state.browserVisible ? "Hide Browser" : "Show Browser", action: "toggle-browser", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
      headerChildren.push({ type: "button", label: "Cancel", action: "cancel", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
    } else {
      headerChildren.push({ type: "button", label: state.refreshing ? "Refreshing\u2026" : "Refresh", action: "manual-refresh", disabled: state.refreshing, variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } });
      headerChildren.push({ type: "toggle", label: "Show browser", checked: state.showBrowserOnRefresh, action: "toggle-show-browser" });
    }

    var header = [
      { type: "layout", direction: "horizontal", children: headerChildren },
    ];

    var statusText = getStatusText();
    if (statusText) {
      var color = state.status === "error" ? "var(--error)" : "var(--text-secondary)";
      header.push({ type: "text", content: "<p style='margin:0;font-size:var(--fs-xs);color:" + color + "'>" + escapeHtml(statusText) + "</p>" });
    }

    return header;
  }

  function renderHome() {
    api.ui.setBadge("spotify", null);
    var ch = [];

    if (state.playlists.length === 0 && state.status === "idle") {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>Click <b>Open Spotify</b> to log in and grab your Made for You playlists.</p>" });
    } else if (state.playlists.length > 0) {
      var cards = [];
      for (var i = 0; i < state.playlists.length; i++) {
        var p = state.playlists[i];
        var ts = state.playlistTracks[p.id];
        var sub = ts ? ts.length + " tracks" : (p.description || "");
        if (state.updatedPlaylistIds[p.id]) {
          sub = "\u2022 Updated \u2014 " + sub;
        }
        var cardTracks = [];
        if (ts) {
          for (var ti = 0; ti < ts.length; ti++) {
            cardTracks.push({
              title: ts[ti].name || "",
              artistName: ts[ti].artist || null,
              albumName: ts[ti].album || null,
            });
          }
        }
        cards.push({
          id: "playlist:" + p.id,
          title: p.name,
          subtitle: sub,
          imageUrl: p.imageUrl,
          action: "view-playlist",
          targetKind: "playlist",
          tracks: cardTracks,
          contextMenuActions: [
            { id: "play-playlist", label: "Play" },
            { id: "enqueue-playlist", label: "Enqueue" },
            { id: "view-playlist", label: "View / Edit" },
            { id: "sep", label: "", separator: true },
            { id: "save-playlist-ctx", label: "Save Playlist" },
          ],
        });
      }
      ch.push({ type: "card-grid", items: cards });
    }

    api.ui.setViewData("spotify", {
      type: "layout", direction: "vertical", children: buildHeader().concat([
        { type: "tabs", activeTab: "home", action: "switch-tab", tabs: [
          { id: "home", label: "Made for You", count: state.playlists.length || undefined },
          { id: "archive", label: "Archive", count: (state.archiveIndex && state.archiveIndex.length) || undefined },
          { id: "debug", label: "Debug Log", count: state.debugLog.length || undefined },
        ]},
        { type: "layout", direction: "vertical", children: ch },
      ])
    });
  }

  function renderPlaylist() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var ch = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "button", label: "Save Playlist", action: "save-playlist", variant: "accent" },
      { type: "spacer" },
      { type: "text", content: "<h2>" + escapeHtml(pl.name) + "</h2>" },
      { type: "text", content: "<p style='opacity:0.6'>" + tracks.length + " tracks</p>" },
    ];
    if (pl.imageUrl) {
      ch.push({ type: "card-grid", columns: 3, items: [{ id: "cover", title: "", imageUrl: pl.imageUrl }] });
      ch.push({ type: "spacer" });
    }
    ch.push({
      type: "toggle",
      label: isArchivable(state.currentPlaylist) ? "Archive snapshots (auto-detected)" : "Archive snapshots",
      checked: isArchivable(state.currentPlaylist),
      action: "toggle-archive",
    });
    if (tracks.length > 0) {
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        items.push({
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " \u2014 " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
        });
      }
      ch.push({ type: "track-row-list", items: items });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
  }

  function renderArchiveDetail() {
    var archive = state.currentArchive;
    if (!archive) return;
    var ch = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "spacer" },
      { type: "text", content: "<h2>" + escapeHtml(archive.name) + "</h2>" },
      { type: "text", content: "<p style='opacity:0.6'>" + archive.tracks.length + " tracks</p>" },
    ];

    if (archive.tracks.length > 0) {
      var items = [];
      for (var i = 0; i < archive.tracks.length; i++) {
        var t = archive.tracks[i];
        items.push({
          id: "archived-track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " \u2014 " + t.album : ""),
          duration: t.duration || "",
          imageUrl: t.imageUrl || undefined,
        });
      }
      ch.push({ type: "track-row-list", items: items });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks in this snapshot</p>" });
    }

    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
  }

  function renderArchive() {
    var ch = [];

    if (state.archiveIndex && state.archiveIndex.length > 0) {
      var archiveItems = [];
      for (var ai = 0; ai < state.archiveIndex.length; ai++) {
        var entry = state.archiveIndex[ai];
        archiveItems.push({
          id: "archive:" + entry.storageKey,
          title: entry.name,
          subtitle: entry.trackCount + " tracks",
          action: "view-archive",
        });
      }
      ch.push({
        type: "track-row-list",
        items: archiveItems,
        selectable: true,
        actions: [
          { id: "delete-archive", label: "Delete", icon: "\uD83D\uDDD1" },
        ],
      });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No archived playlists yet.</p>" });
    }

    api.ui.setViewData("spotify", {
      type: "layout", direction: "vertical", children: buildHeader().concat([
        { type: "tabs", activeTab: "archive", action: "switch-tab", tabs: [
          { id: "home", label: "Made for You", count: state.playlists.length || undefined },
          { id: "archive", label: "Archive", count: (state.archiveIndex && state.archiveIndex.length) || undefined },
          { id: "debug", label: "Debug Log", count: state.debugLog.length || undefined },
        ]},
        { type: "layout", direction: "vertical", children: ch },
      ])
    });
  }

  function renderDebugLog() {
    var ch = [];

    if (state.debugLog.length > 0) {
      ch.push({
        type: "layout", direction: "horizontal", children: [
          { type: "button", label: "Copy Log", action: "copy-debug-log", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
          { type: "button", label: "Clear", action: "clear-debug-log", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
        ]
      });

      var logLines = [];
      for (var li = 0; li < state.debugLog.length; li++) {
        var e = state.debugLog[li];
        var line = e.ts + " [" + e.tag.toUpperCase() + "] " + e.msg;
        if (e.data !== undefined) {
          line += "\n" + formatDebugData(e.data);
        }
        logLines.push(line);
      }
      var logText = logLines.join("\n\n");
      ch.push({ type: "text", content:
        "<pre style='" +
        "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;" +
        "font-size:11px;" +
        "line-height:1.6;" +
        "white-space:pre-wrap;" +
        "word-break:break-all;" +
        "padding:12px 16px;" +
        "margin:0;" +
        "overflow:auto;" +
        "background:rgba(0,0,0,0.25);" +
        "border-radius:6px;" +
        "border:1px solid rgba(255,255,255,0.08);" +
        "user-select:text;" +
        "-webkit-user-select:text;" +
        "cursor:text;" +
        "color:var(--text-primary);" +
        "'>" + escapeHtml(logText) + "</pre>"
      });
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No debug log entries yet.</p>" });
    }

    api.ui.setViewData("spotify", {
      type: "layout", direction: "vertical", children: buildHeader().concat([
        { type: "tabs", activeTab: "debug", action: "switch-tab", tabs: [
          { id: "home", label: "Made for You", count: state.playlists.length || undefined },
          { id: "archive", label: "Archive", count: (state.archiveIndex && state.archiveIndex.length) || undefined },
          { id: "debug", label: "Debug Log", count: state.debugLog.length || undefined },
        ]},
        { type: "layout", direction: "vertical", children: ch },
      ])
    });
  }

  // ---- Injected scripts (plain strings for eval) ----

  var DBG_HELPER =
    'function _dbg(tag,msg,data){' +
      'try{window.__viboplr.send("debug",{tag:tag,msg:msg,data:data})}catch(e){}' +
      'console.log("[spotify-dbg]",tag,msg,data)' +
    '}';

  var IMG_HELPER =
    'function bestImg(el){' +
      'var imgs=el.querySelectorAll("img");' +
      'for(var k=0;k<imgs.length;k++){' +
        'var s=imgs[k].currentSrc||imgs[k].src||"";' +
        'if(s&&s.indexOf("data:")!==0&&s.indexOf("blob:")!==0)return s;' +
        'var ss=imgs[k].getAttribute("srcset");' +
        'if(ss){var parts=ss.split(",");for(var p=parts.length-1;p>=0;p--){' +
          'var u=parts[p].trim().split(/\\s+/)[0];if(u)return u;' +
        '}}' +
        'var ds=imgs[k].getAttribute("data-src");' +
        'if(ds)return ds;' +
      '}' +
      'var bgs=el.querySelectorAll("[style]");' +
      'for(var b=0;b<bgs.length;b++){' +
        'var bg=bgs[b].style.backgroundImage||"";' +
        'var bm=bg.match(/url\\([\\"\\\']*([^\\"\\\'\\)]+)/);' +
        'if(bm&&bm[1])return bm[1];' +
      '}' +
      'return null;' +
    '}';

  var SCRIPT_CHECK_LOGIN = '(function(){' +
    'console.log("[viboplr-login] script start");' +
    'try{' +
    'function qs(sel){try{return document.querySelector(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return null}}' +
    'function qsa(sel){try{return document.querySelectorAll(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return[]}}' +
    'var signals={};' +
    'signals.userWidget=!!qs("[data-testid=\\"user-widget-link\\"]");' +
    'signals.userBox=!!qs(".main-userWidget-box");' +
    'signals.avatar=!!qs("img[alt*=\\"avatar\\"], img[alt*=\\"profile\\"]");' +
    'signals.accountLink=!!qs("a[href*=\\"/account\\"], button[data-testid=\\"user-widget-link\\"]");' +
    'signals.libraryBtn=!!qs("[aria-label=\\"Your Library\\"], [aria-label*=\\"library\\"]");' +
    'signals.createPlaylist=!!qs("[aria-label*=\\"Create\\"]");' +
    'signals.loginBtn=!!qs("[data-testid=\\"login-button\\"]");' +
    'signals.signupBtn=!!qs("[data-testid=\\"signup-button\\"], a[href*=\\"signup\\"]");' +
    'signals.loginLink=!!qs("a[href*=\\"/login\\"]");' +
    'console.log("[viboplr-login] signals:",JSON.stringify(signals));' +
    'var pos=signals.userWidget||signals.userBox||signals.avatar||signals.accountLink||signals.libraryBtn||signals.createPlaylist;' +
    'var neg=signals.loginBtn||signals.signupBtn||signals.loginLink;' +
    'var ok=pos&&!neg;' +
    'var pageDump=null;' +
    'if(!pos&&!neg){' +
      'var btns=qsa("button");' +
      'var btnTexts=[];for(var b=0;b<Math.min(btns.length,20);b++){btnTexts.push((btns[b].textContent||"").trim().substring(0,40)+"["+(btns[b].getAttribute("data-testid")||btns[b].getAttribute("aria-label")||"")+"]")}' +
      'var navs=qsa("nav a, nav button");' +
      'var navTexts=[];for(var n=0;n<Math.min(navs.length,20);n++){navTexts.push((navs[n].textContent||"").trim().substring(0,40))}' +
      'var testids=qsa("[data-testid]");' +
      'var tidList=[];for(var t=0;t<Math.min(testids.length,40);t++){tidList.push(testids[t].getAttribute("data-testid"))}' +
      'pageDump={buttons:btnTexts,navItems:navTexts,testids:tidList,bodyClasses:document.body.className,title:document.title};' +
      'console.log("[viboplr-login] NO CLEAR SIGNAL page dump:",JSON.stringify(pageDump));' +
    '}' +
    'console.log("[viboplr-login] result: loggedIn="+ok+" pos="+pos+" neg="+neg);' +
    'window.__viboplr.send("login-check",{loggedIn:ok,signals:signals,url:location.href,pageDump:pageDump});' +
    '}catch(e){' +
      'console.error("[viboplr-login] CAUGHT ERROR:",e,""+e,e.stack);' +
      'try{window.__viboplr.send("login-check",{loggedIn:false,error:""+e})}catch(e2){console.error("[viboplr-login] send also failed:",e2)}' +
    '}})()';

  // Searches the page for a link whose visible text contains "Made for You"
  // (case-insensitive). If found, clicks it and reports the href. If not found,
  // reports back so the plugin can retry.
  var SCRIPT_FIND_MADE_FOR_YOU = '(function(){try{' +
    DBG_HELPER +
    'var links=document.querySelectorAll("a");' +
    'var linkTexts=[];for(var x=0;x<Math.min(links.length,30);x++){linkTexts.push(links[x].textContent.trim().substring(0,60))}' +
    '_dbg("m4y","searching "+links.length+" links, first 30 texts:",linkTexts);' +
    'for(var i=0;i<links.length;i++){' +
      'var txt=(links[i].textContent||"").trim().toLowerCase();' +
      'if(txt==="made for you"||txt.indexOf("made for you")!==-1){' +
        'var href=links[i].getAttribute("href")||"";' +
        '_dbg("m4y","FOUND via link",{index:i,text:txt,href:href});' +
        'links[i].click();' +
        'window.__viboplr.send("made-for-you-found",{href:href});' +
        'return;' +
      '}' +
    '}' +
    'var headings=document.querySelectorAll("h2, h3, span, p");' +
    '_dbg("m4y","checking "+headings.length+" headings/spans");' +
    'for(var j=0;j<headings.length;j++){' +
      'var h=headings[j];' +
      'var ht=(h.textContent||"").trim().toLowerCase();' +
      'if(ht==="made for you"||ht.indexOf("made for you")!==-1){' +
        'var parent=h.closest("a");' +
        'if(parent){' +
          '_dbg("m4y","FOUND via heading>a",{tag:h.tagName,text:ht,href:parent.getAttribute("href")});' +
          'parent.click();' +
          'window.__viboplr.send("made-for-you-found",{href:parent.getAttribute("href")||""});' +
          'return;' +
        '}' +
        '_dbg("m4y","FOUND via heading click",{tag:h.tagName,text:ht});' +
        'h.click();' +
        'window.__viboplr.send("made-for-you-found",{href:"clicked-heading"});' +
        'return;' +
      '}' +
    '}' +
    '_dbg("m4y","NOT FOUND on page",{url:location.href});' +
    'window.__viboplr.send("made-for-you-not-found",{});' +
    '}catch(e){window.__viboplr.send("error",{message:"find link: "+e})}})()';

  var SCRIPT_SCRAPE_PLAYLISTS = '(function(){try{' +
    DBG_HELPER +
    IMG_HELPER +
    'var out=[];var seen={};' +
    '_dbg("playlists","starting scrape",{url:location.href});' +
    // Strategy 1: card-based layout (data-testid="card")
    'var cards=document.querySelectorAll("div[data-testid=\\"card\\"]");' +
    '_dbg("playlists","strategy1: cards",{count:cards.length});' +
    'for(var i=0;i<cards.length;i++){' +
      'var c=cards[i];' +
      'var a=c.querySelector("a[href*=\\"/playlist/\\"]");' +
      'if(!a){continue}' +
      'var m=(a.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!m||seen[m[1]])continue;seen[m[1]]=1;' +
      'var ne=c.querySelector("[data-testid=\\"card-title\\"]")||c.querySelector("p")||c.querySelector("span");' +
      'var nm=ne?ne.textContent.trim():"";' +
      'var de=c.querySelector("[data-testid=\\"card-subtitle\\"]");' +
      'var ds=de?de.textContent.trim():"";' +
      'var imgUrl=bestImg(c);' +
      '_dbg("playlists","card["+i+"] found",{id:m[1],name:nm,desc:ds,hasImg:!!imgUrl});' +
      'if(nm)out.push({id:m[1],name:nm,description:ds,imageUrl:imgUrl,uri:"spotify:playlist:"+m[1]});' +
    '}' +
    // Strategy 2: row-based layout (role="row" containing playlist links)
    'var rows=document.querySelectorAll("[role=\\"row\\"]");' +
    '_dbg("playlists","strategy2: rows",{count:rows.length});' +
    'for(var ri=0;ri<rows.length;ri++){' +
      'var rw=rows[ri];' +
      'var ra=rw.querySelector("a[href*=\\"/playlist/\\"]");' +
      'if(!ra)continue;' +
      'var rm=(ra.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!rm||seen[rm[1]])continue;seen[rm[1]]=1;' +
      'var rne=ra.querySelector("div")||ra.querySelector("span")||ra;' +
      'var rnm=rne?rne.textContent.trim():"";' +
      'var rds="";var rsub=rw.querySelector("span:not(:first-child)");' +
      'if(rsub)rds=rsub.textContent.trim();' +
      'var rimg=bestImg(rw);' +
      '_dbg("playlists","row["+ri+"] found",{id:rm[1],name:rnm,desc:rds,hasImg:!!rimg});' +
      'if(rnm)out.push({id:rm[1],name:rnm,description:rds,imageUrl:rimg,uri:"spotify:playlist:"+rm[1]});' +
    '}' +
    // Strategy 3: any remaining playlist links not caught above
    'function findImgContainer(el){' +
      'var node=el;' +
      'for(var up=0;up<6&&node;up++){' +
        'var img=bestImg(node);' +
        'if(img)return img;' +
        'node=node.parentElement;' +
      '}' +
      'return null;' +
    '}' +
    'var allLinks=document.querySelectorAll("a[href*=\\"/playlist/\\"]");' +
    '_dbg("playlists","strategy3: remaining links",{count:allLinks.length,alreadySeen:Object.keys(seen).length});' +
    'for(var li=0;li<allLinks.length;li++){' +
      'var la=allLinks[li];' +
      'var lm=(la.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!lm||seen[lm[1]])continue;seen[lm[1]]=1;' +
      'var lnm=la.textContent.trim();' +
      'var limg=findImgContainer(la);' +
      '_dbg("playlists","link["+li+"] found",{id:lm[1],name:lnm,href:la.getAttribute("href"),hasImg:!!limg});' +
      'if(lnm)out.push({id:lm[1],name:lnm,description:"",imageUrl:limg,uri:"spotify:playlist:"+lm[1]});' +
    '}' +
    '_dbg("playlists","DONE",{total:out.length,names:out.map(function(p){return p.name})});' +
    'window.__viboplr.send("playlists",out);' +
    '}catch(e){window.__viboplr.send("error",{message:""+e})}})()';

  function scriptNavigatePlaylist(id) {
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to /playlist/' + id + '");' +
      'window.location.href="/playlist/' + id + '"' +
    '})()';
  }

  function scriptScrollThenScrape(playlistId, gen) {
    return '(function(){' +
      DBG_HELPER +
      IMG_HELPER +
      'var _gen=' + gen + ';' +
      '_dbg("tracks","=== START scrape for ' + playlistId + '",{url:location.href,gen:_gen});' +
      // Scope to main content area to avoid sidebar rows
      'var mainEl=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
        '||document.querySelector("main")||document;' +
      'var sc=mainEl.closest?mainEl:document.scrollingElement;' +
      'if(mainEl.scrollHeight>mainEl.clientHeight){sc=mainEl}' +
      'else{sc=document.querySelector("main")||document.scrollingElement}' +
      '_dbg("tracks","scroll container",{tag:sc.tagName,testid:sc.getAttribute&&sc.getAttribute("data-testid"),scrollH:sc.scrollHeight});' +
      'var ph=0,stable=0,n=0;' +
      'function tick(){' +
        'sc.scrollTop=sc.scrollHeight;n++;' +
        'if(sc.scrollHeight===ph){stable++}else{stable=0}' +
        'ph=sc.scrollHeight;' +
        'if(n%10===0)_dbg("tracks","scrolling",{tick:n,stable:stable,scrollH:sc.scrollHeight});' +
        'if(stable>=3||n>=50){_dbg("tracks","scroll done",{ticks:n,finalH:sc.scrollHeight});scrape()}else{setTimeout(tick,800)}' +
      '}' +
      'function scrape(){try{' +
        'var out=[];var skipped=0;' +
        // Query rows only inside main content, not sidebar
        'var scope=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")||document.querySelector("main")||document;' +
        'var rows=scope.querySelectorAll("[role=\\"row\\"]");' +
        '_dbg("tracks","rows found (scoped to main)",{count:rows.length,scopeTag:scope.tagName,scopeTestid:scope.getAttribute&&scope.getAttribute("data-testid")});' +
        'for(var d=0;d<Math.min(rows.length,3);d++){' +
          'var dr=rows[d];' +
          'var gcells=dr.querySelectorAll("[role=\\"gridcell\\"]");' +
          'var cellInfo=[];for(var dc=0;dc<gcells.length;dc++){cellInfo.push({idx:dc,text:gcells[dc].textContent.trim().substring(0,80),childCount:gcells[dc].children.length})}' +
          '_dbg("tracks","row["+d+"] structure",{' +
            'gridcells:gcells.length,' +
            'cells:cellInfo,' +
            'hasTrackLink:!!dr.querySelector("a[href*=\\"/track/\\"]"),' +
            'hasArtistLink:!!dr.querySelector("a[href*=\\"/artist/\\"]"),' +
            'hasAlbumLink:!!dr.querySelector("a[href*=\\"/album/\\"]"),' +
            'hasInternalTrackLink:!!dr.querySelector("[data-testid=\\"internal-track-link\\"]"),' +
            'hasDuration:!!dr.querySelector("[data-testid=\\"tracklist-duration\\"]"),' +
            'outerHTML:dr.outerHTML.substring(0,300)' +
          '});' +
        '}' +
        'for(var i=0;i<rows.length;i++){var r=rows[i];' +
          'var ne=r.querySelector("[data-testid=\\"internal-track-link\\"] div")' +
            '||r.querySelector("a[href*=\\"/track/\\"]")' +
            '||r.querySelector("[data-testid=\\"tracklist-row\\"] a");' +
          'var nameSource="testid|track-link|tracklist-a";' +
          'if(!ne){var cells=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells.length>=2){ne=cells[1].querySelector("a")||cells[1].querySelector("div>div>span")||cells[1].querySelector("span");nameSource="gridcell[1]"}}' +
          'var nm=ne?ne.textContent.trim():"";' +
          'if(!nm){' +
            'if(i<5)_dbg("tracks","row["+i+"] SKIPPED no name",{' +
              'gridcells:r.querySelectorAll("[role=\\"gridcell\\"]").length,' +
              'allText:r.textContent.trim().substring(0,120),' +
              'innerHTML:r.innerHTML.substring(0,300)' +
            '});' +
            'skipped++;continue}' +
          'var aLinks=r.querySelectorAll("a[href*=\\"/artist/\\"]");' +
          'var arts=[];for(var j=0;j<aLinks.length;j++){var at=aLinks[j].textContent.trim();if(at&&arts.indexOf(at)===-1)arts.push(at)}' +
          'var artistSource="artist-links("+aLinks.length+")";' +
          'if(!arts.length){var cells2=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells2.length>=2){var spans=cells2[1].querySelectorAll("span");' +
              'for(var s=0;s<spans.length;s++){var st=spans[s].textContent.trim();' +
                'if(st&&st!==nm&&st.indexOf(nm)===-1&&nm.indexOf(st)===-1){arts.push(st);artistSource="gridcell-span";break}}}}' +
          'var alEl=r.querySelector("a[href*=\\"/album/\\"]");' +
          'var al=alEl?alEl.textContent.trim():"";' +
          'var du=r.querySelector("[data-testid=\\"tracklist-duration\\"]");' +
          'var durSource="testid";' +
          'if(!du){var cells3=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells3.length>0){du=cells3[cells3.length-1];durSource="last-gridcell"}}' +
          'var dur="";if(du){var dt=du.textContent.trim();if(/^\\d+:\\d{2}$/.test(dt))dur=dt}' +
          'var imgUrl=bestImg(r);' +
          'if(i<5)_dbg("tracks","row["+i+"] parsed",{name:nm,nameSource:nameSource,artist:arts.join(", "),artistSource:artistSource,album:al,dur:dur,durSource:durSource,hasImg:!!imgUrl});' +
          'out.push({name:nm,artist:arts.join(", "),album:al,duration:dur,imageUrl:imgUrl})' +
        '}' +
        '_dbg("tracks","=== DONE ' + playlistId + '",{parsed:out.length,skipped:skipped,total:rows.length,gen:_gen});' +
        'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:out,gen:_gen});' +
      '}catch(e){_dbg("tracks","ERROR",{error:""+e});window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:[],error:""+e,gen:_gen})}}' +
      'tick()' +
    '})()';
  }

  // ---- Flow control ----

  var loginPoll = null;
  var madeForYouRetries = 0;
  var madeForYouTimer = null;
  var playlistRetries = 0;
  var playlistRetryTimer = null;
  var trackQueue = [];
  var trackBusy = false;
  var scrapeGeneration = 0;

  function resetTimers() {
    if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
    if (madeForYouTimer) { clearTimeout(madeForYouTimer); madeForYouTimer = null; }
    if (playlistRetryTimer) { clearTimeout(playlistRetryTimer); playlistRetryTimer = null; }
    madeForYouRetries = 0;
    playlistRetries = 0;
    trackQueue = [];
    trackBusy = false;
  }

  function onMessage(msg) {
    var t = msg.type;
    var d = msg.data;

    if (t === "window-closed") {
      dbg("flow", "browse window was closed externally");
      browseHandle = null;
      state.browserVisible = false;
      if (state.status !== "done" && state.status !== "idle") {
        resetTimers();
        state.status = "error";
        state.errorMessage = "Browser window was closed. Click Try Again to restart.";
      }
      render();
      return;
    }

    if (t === "debug" && d) {
      dbg(d.tag || "browse", d.msg || "", d.data);
      render();
      return;
    }

    dbg("msg", t, d);

    if (t === "login-check" && d) {
      state.lastLoginCheck = d;
      if (d.loggedIn) {
        if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
        dbg("flow", "login detected, finding Made for You in 2s");
        state.status = "finding-made-for-you";
        render();
        madeForYouRetries = 0;
        setTimeout(findMadeForYouLink, 2000);
      } else {
        render();
      }
    }

    if (t === "made-for-you-found") {
      dbg("flow", "Made for You clicked, waiting 4s for page render", d);
      if (madeForYouTimer) { clearTimeout(madeForYouTimer); madeForYouTimer = null; }
      setTimeout(function() {
        state.status = "scraping-playlists";
        render();
        beginPlaylistScrape();
      }, 4000);
    }

    if (t === "made-for-you-not-found") {
      retryFindMadeForYou();
    }

    if (t === "playlists") {
      if (state.status !== "scraping-playlists") {
        dbg("flow", "IGNORING stale playlists message (status=" + state.status + ")");
        return;
      }
      if (Array.isArray(d) && d.length > 0) {
        dbg("flow", "playlists received", { count: d.length, names: d.map(function(p) { return p.name; }) });
        state.playlists = d;
        if (playlistRetryTimer) { clearTimeout(playlistRetryTimer); playlistRetryTimer = null; }
        render();
        beginTrackScrape();
      } else {
        dbg("flow", "no playlists found, retrying", { retry: playlistRetries + 1 });
        retryPlaylistScrape();
      }
    }

    if (t === "tracks" && d) {
      var tCount = (d.tracks || []).length;
      var msgGen = d.gen !== undefined ? d.gen : -1;
      dbg("flow", "tracks received for " + d.playlistId, { count: tCount, error: d.error || null, gen: msgGen, currentGen: scrapeGeneration });
      if (msgGen !== -1 && msgGen !== scrapeGeneration) {
        dbg("flow", "IGNORING stale tracks result (gen " + msgGen + " != current " + scrapeGeneration + ")");
        return;
      }
      if (tCount === 0) {
        dbg("flow", "WARNING: 0 tracks scraped for " + d.playlistId);
      }
      state.playlistTracks[d.playlistId] = d.tracks || [];
      render();
      trackBusy = false;
      scrapeNextTrackPage();
    }

    if (t === "error") {
      dbg("error", "from browse window", d);
    }
  }

  // ---- Find the Made for You link ----

  function findMadeForYouLink() {
    if (browseHandle) browseHandle.eval(SCRIPT_FIND_MADE_FOR_YOU);
  }

  function retryFindMadeForYou() {
    madeForYouRetries++;
    dbg("flow", "Made for You retry " + madeForYouRetries + "/15");
    if (madeForYouRetries > 15) {
      dbg("flow", "GAVE UP finding Made for You");
      state.status = "error";
      state.errorMessage = "Could not find a \u201cMade for You\u201d link on the Spotify home page. Try scrolling the browse window and clicking Refresh.";
      render();
      return;
    }
    madeForYouTimer = setTimeout(findMadeForYouLink, 2000);
  }

  // ---- Playlist scraping ----

  function beginPlaylistScrape() {
    playlistRetries = 0;
    doPlaylistScrape();
  }

  function doPlaylistScrape() {
    if (browseHandle) browseHandle.eval(SCRIPT_SCRAPE_PLAYLISTS);
  }

  function retryPlaylistScrape() {
    if (state.status !== "scraping-playlists") return;
    playlistRetries++;
    dbg("flow", "playlist scrape retry " + playlistRetries + "/10");
    if (playlistRetries > 10) {
      dbg("flow", "GAVE UP scraping playlists", { hadPlaylists: state.playlists.length });
      state.status = state.playlists.length > 0 ? "done" : "error";
      state.errorMessage = "Could not find any playlists on the Made for You page.";
      render();
      cleanup();
      return;
    }
    playlistRetryTimer = setTimeout(doPlaylistScrape, 5000);
  }

  function beginTrackScrape() {
    trackQueue = state.playlists.slice();
    state.scrapeProgress = { current: 0, total: trackQueue.length, name: "" };
    state.status = "scraping-tracks";
    trackBusy = false;
    render();
    scrapeNextTrackPage();
  }

  function scrapeNextTrackPage() {
    if (trackQueue.length === 0) {
      dbg("flow", "=== ALL PLAYLISTS DONE ===", { playlistCount: state.playlists.length, trackCounts: Object.keys(state.playlistTracks).map(function(k) { return k + ": " + (state.playlistTracks[k] || []).length; }) });
      state.status = "done";
      render();
      saveState();
      cleanup();
      return;
    }
    if (trackBusy) return;
    trackBusy = true;

    scrapeGeneration++;
    var gen = scrapeGeneration;
    var pl = trackQueue.shift();
    state.scrapeProgress.current++;
    state.scrapeProgress.name = pl.name;
    dbg("flow", "navigating to playlist " + state.scrapeProgress.current + "/" + state.scrapeProgress.total, { id: pl.id, name: pl.name, remaining: trackQueue.length, gen: gen });
    render();

    if (browseHandle) {
      browseHandle.eval(scriptNavigatePlaylist(pl.id));
    }

    setTimeout(function() {
      if (gen !== scrapeGeneration) return;
      dbg("flow", "injecting scroll+scrape for " + pl.name);
      if (browseHandle) {
        browseHandle.eval(scriptScrollThenScrape(pl.id, gen));
      }
      setTimeout(function() {
        if (trackBusy && gen === scrapeGeneration) {
          dbg("flow", "TIMEOUT scraping " + pl.name + " after 45s");
          state.playlistTracks[pl.id] = [];
          trackBusy = false;
          scrapeNextTrackPage();
        }
      }, 45000);
    }, 4000);
  }

  // ---- Standalone scrape (for refresh) ----

  function performScrape(showProgress, visible) {
    return new Promise(function(resolve, reject) {
      var result = { playlists: [], tracks: {} };
      var handle = null;
      var timer = null;
      var gen = ++scrapeGeneration;
      var trackIdx = 0;
      var trackList = [];
      var trackTimeout = null;
      var trackCheck = null;

      function done(val) {
        if (timer) { clearInterval(timer); timer = null; }
        if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
        if (trackCheck) { clearInterval(trackCheck); trackCheck = null; }
        if (handle) { handle.close().catch(console.error); handle = null; }
        resolve(val);
      }

      function fail(err) {
        if (timer) { clearInterval(timer); timer = null; }
        if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
        if (trackCheck) { clearInterval(trackCheck); trackCheck = null; }
        if (handle) { handle.close().catch(console.error); handle = null; }
        reject(err);
      }

      api.network.openBrowseWindow("https://open.spotify.com", {
        title: "Spotify",
        width: 1200,
        height: 800,
        visible: !!visible,
      }).then(function(h) {
        handle = h;
        var loginRetries = 0;
        var m4yRetries = 0;
        var plRetries = 0;

        h.onMessage(function(msg) {
          var t = msg.type;
          var d = msg.data;

          if (t === "window-closed") {
            done(null);
            return;
          }

          if (t === "debug" && d) {
            dbg(d.tag || "browse", d.msg || "", d.data);
            render();
            return;
          }

          dbg("msg", t, d);
          render();

          if (t === "login-check" && d) {
            if (d.loggedIn) {
              if (timer) { clearInterval(timer); timer = null; }
              if (showProgress) { state.status = "finding-made-for-you"; render(); }
              m4yRetries = 0;
              setTimeout(function tryM4Y() {
                m4yRetries++;
                if (m4yRetries > 15) {
                  h.eval(SCRIPT_SCRAPE_PLAYLISTS);
                  return;
                }
                h.eval(SCRIPT_FIND_MADE_FOR_YOU);
                setTimeout(function() {
                  if (result.playlists.length === 0 && m4yRetries <= 15) tryM4Y();
                }, 2000);
              }, 2000);
            }
            return;
          }

          if (t === "made-for-you-found") {
            if (showProgress) { state.status = "scraping-playlists"; render(); }
            setTimeout(function tryPl() {
              if (result.playlists.length > 0) return;
              plRetries++;
              h.eval(SCRIPT_SCRAPE_PLAYLISTS);
              setTimeout(function() {
                if (result.playlists.length === 0 && plRetries <= 10) tryPl();
              }, 5000);
            }, 4000);
            return;
          }

          if (t === "made-for-you-not-found") {
            // handled by tryM4Y retry loop
            return;
          }

          if (t === "playlists" && Array.isArray(d) && d.length > 0) {
            result.playlists = d;
            trackList = d.slice();
            trackIdx = 0;
            if (showProgress) {
              state.status = "scraping-tracks";
              state.scrapeProgress = { current: 0, total: trackList.length, name: "" };
              render();
            }
            scrapeNext();
            return;
          }

          if (t === "tracks" && d && d.playlistId) {
            result.tracks[d.playlistId] = d.tracks || [];
            if (trackCheck) { clearInterval(trackCheck); trackCheck = null; }
            if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
            setTimeout(scrapeNext, 1000);
            return;
          }
        });

        function scrapeNext() {
          if (trackIdx >= trackList.length) {
            done(result);
            return;
          }
          var pl = trackList[trackIdx];
          trackIdx++;
          if (showProgress) {
            state.scrapeProgress = { current: trackIdx, total: trackList.length, name: pl.name };
            render();
          }
          h.eval(scriptNavigatePlaylist(pl.id));
          setTimeout(function() {
            h.eval(scriptScrollThenScrape(pl.id, gen));
            trackTimeout = setTimeout(function() {
              result.tracks[pl.id] = result.tracks[pl.id] || [];
              scrapeNext();
            }, 45000);
          }, 4000);
        }

        // Phase 1: poll login
        if (showProgress) { state.status = "waiting-login"; render(); }
        timer = setInterval(function() {
          loginRetries++;
          if (loginRetries > 10) {
            clearInterval(timer); timer = null;
            done(null);
            return;
          }
          h.eval(SCRIPT_CHECK_LOGIN);
        }, 3000);
        // First check after 3s
        setTimeout(function() { h.eval(SCRIPT_CHECK_LOGIN); }, 3000);

      }).catch(fail);
    });
  }

  // ---- Change detection & archiving ----

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

  // ---- Refresh ----

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

  // ---- Actions ----

  api.ui.onAction("open-spotify", function() {
    cleanup();
    resetTimers();
    state.playlists = [];
    state.playlistTracks = {};
    state.lastLoginCheck = null;
    state.status = "waiting-login";
    state.errorMessage = "";
    dbg("flow", "opening Spotify browse window");
    render();

    state.browserVisible = false;
    var loginPollCount = 0;

    api.network.openBrowseWindow("https://open.spotify.com", {
      title: "Spotify \u2014 Log in",
      width: 1200,
      height: 800,
      visible: false,
    }).then(function(handle) {
      dbg("flow", "browse window opened, handle received", { hasHandle: !!handle, hasEval: !!(handle && handle.eval), hasOnMessage: !!(handle && handle.onMessage) });
      browseHandle = handle;
      handle.onMessage(onMessage);

      // Diagnostic: check if the bridge is working at all
      setTimeout(function() {
        if (browseHandle) {
          dbg("flow", "sending bridge diagnostic eval (2s after open)");
          browseHandle.eval(
            '(function(){' +
              'var diag={' +
                'hasViboplr:typeof window.__viboplr!=="undefined",' +
                'hasViboplrSend:typeof window.__viboplr!=="undefined"&&typeof window.__viboplr.send==="function",' +
                'hasTauriInternals:typeof window.__TAURI_INTERNALS__!=="undefined",' +
                'hasTauriInvoke:typeof window.__TAURI_INTERNALS__!=="undefined"&&typeof window.__TAURI_INTERNALS__.invoke==="function",' +
                'url:location.href,' +
                'title:document.title,' +
                'readyState:document.readyState' +
              '};' +
              'console.log("[viboplr-diag]",JSON.stringify(diag));' +
              'if(window.__viboplr&&window.__viboplr.send){' +
                'window.__viboplr.send("diag",diag);' +
              '}' +
            '})()'
          );
          render();
        }
      }, 2000);

      loginPoll = setInterval(function() {
        if (browseHandle && state.status === "waiting-login") {
          loginPollCount++;
          dbg("flow", "login poll #" + loginPollCount + " — eval'ing SCRIPT_CHECK_LOGIN", { hasHandle: !!browseHandle, status: state.status });
          try {
            browseHandle.eval(SCRIPT_CHECK_LOGIN);
          } catch(e) {
            dbg("error", "eval SCRIPT_CHECK_LOGIN threw", { error: "" + e });
          }
          render();
        }
      }, 3000);

      setTimeout(function() {
        if (browseHandle && state.status === "waiting-login") {
          dbg("flow", "first login check (3s after open)");
          try {
            browseHandle.eval(SCRIPT_CHECK_LOGIN);
          } catch(e) {
            dbg("error", "first eval threw", { error: "" + e });
          }
          render();
        }
      }, 3000);
    }).catch(function(err) {
      dbg("error", "openBrowseWindow failed", { error: "" + (err.message || err) });
      state.status = "error";
      state.errorMessage = "Failed to open browser: " + (err.message || err);
      render();
    });
  });

  api.ui.onAction("toggle-browser", function() {
    if (!browseHandle) {
      dbg("flow", "toggle-browser: no handle, ignoring");
      return;
    }
    state.browserVisible = !state.browserVisible;
    var p = state.browserVisible ? browseHandle.show() : browseHandle.hide();
    p.catch(function(err) {
      dbg("error", "toggle-browser failed (window gone?)", { error: "" + err });
      browseHandle = null;
      state.browserVisible = false;
      if (state.status !== "done" && state.status !== "idle") {
        resetTimers();
        state.status = "error";
        state.errorMessage = "Browser window was closed. Click Try Again to restart.";
      }
      render();
    });
    render();
  });

  api.ui.onAction("cancel", function() {
    cleanup();
    resetTimers();
    state.status = "idle";
    render();
  });

  api.ui.onAction("switch-tab", function(data) {
    if (!data || !data.tabId) return;
    state.activeTab = data.tabId;
    render();
  });

  api.ui.onAction("copy-debug-log", function() {
    var lines = [];
    for (var i = 0; i < state.debugLog.length; i++) {
      var e = state.debugLog[i];
      var line = e.ts + " [" + e.tag.toUpperCase() + "] " + e.msg;
      if (e.data !== undefined) line += " " + formatDebugData(e.data);
      lines.push(line);
    }
    var text = lines.join("\n");
    try {
      navigator.clipboard.writeText(text).then(function() {
        api.ui.showNotification("Debug log copied to clipboard");
      }).catch(function(err) {
        console.error("Failed to copy debug log:", err);
      });
    } catch(err) {
      console.error("Failed to copy debug log:", err);
    }
  });

  api.ui.onAction("clear-debug-log", function() {
    state.debugLog = [];
    renderDebugLog();
  });

  api.ui.onAction("go-home", function() {
    state.currentPlaylist = null;
    state.currentView = "home";
    state.activeTab = "home";
    render();
  });

  api.ui.onAction("view-playlist", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) {
        state.currentPlaylist = state.playlists[i];
        delete state.updatedPlaylistIds[pid];
        state.currentView = "playlist";
        renderPlaylist();
        return;
      }
    }
  });

  api.ui.onAction("save-playlist", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var dateStr = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear();
    var name = pl.name + " " + dateStr;

    var trackPayloads = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      // Parse duration string "M:SS" to seconds
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      trackPayloads.push({
        title: t.name || "Unknown",
        artistName: t.artist || null,
        albumName: t.album || null,
        durationSecs: durationSecs,
        source: null,
        imageUrl: t.imageUrl || null,
      });
    }

    api.playlists.save({
      name: name,
      source: "spotify-playlist://" + pl.id,
      imageUrl: pl.imageUrl || null,
      tracks: trackPayloads,
    }).then(function() {
      api.ui.showNotification("Playlist saved: " + name);
    }).catch(function(err) {
      console.error("Failed to save playlist:", err);
      api.ui.showNotification("Failed to save playlist");
    });
  });

  // ---- Context menu actions for playlist cards ----

  function findPlaylistFromData(data) {
    if (!data || !data.itemId) return null;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return null;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) return state.playlists[i];
    }
    return null;
  }

  function playlistTracksToPayload(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      out.push({
        title: t.name || "Unknown",
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: durationSecs,
        image_url: t.imageUrl || undefined,
      });
    }
    return out;
  }

  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.ui.requestAction("play-tracks", {
      tracks: playlistTracksToPayload(tracks),
      startIndex: 0,
      playlistName: pl.name,
      coverUrl: pl.imageUrl || undefined,
    });
  });

  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.ui.requestAction("enqueue-tracks", { tracks: playlistTracksToPayload(tracks) });
  });

  api.ui.onAction("save-playlist-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var dateStr = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear();
    var name = pl.name + " " + dateStr;

    var trackPayloads = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      var durationSecs = null;
      if (t.duration) {
        var parts = t.duration.split(":");
        if (parts.length === 2) {
          durationSecs = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        }
      }
      trackPayloads.push({
        title: t.name || "Unknown",
        artistName: t.artist || null,
        albumName: t.album || null,
        durationSecs: durationSecs,
        source: null,
        imageUrl: t.imageUrl || null,
      });
    }

    api.playlists.save({
      name: name,
      source: "spotify-playlist://" + pl.id,
      imageUrl: pl.imageUrl || null,
      tracks: trackPayloads,
    }).then(function() {
      api.ui.showNotification("Playlist saved: " + name);
    }).catch(function(err) {
      console.error("Failed to save playlist:", err);
      api.ui.showNotification("Failed to save playlist");
    });
  });

  api.ui.onAction("view-archive", function(data) {
    if (!data || !data.itemId) return;
    var key = data.itemId.replace("archive:", "");
    api.storage.get("spotify_browse_archive:" + key).then(function(snapshot) {
      if (!snapshot) return;
      state.currentView = "archive-detail";
      state.currentArchive = snapshot;
      state.currentArchiveKey = key;
      renderArchiveDetail();
    }).catch(console.error);
  });

  api.ui.onAction("delete-archive", function(data) {
    if (!data || !data.selectedIds) return;
    var keysToDelete = {};
    for (var i = 0; i < data.selectedIds.length; i++) {
      keysToDelete[data.selectedIds[i].replace("archive:", "")] = true;
    }
    var keys = Object.keys(keysToDelete);
    var promises = [];
    for (var k = 0; k < keys.length; k++) {
      promises.push(api.storage.delete("spotify_browse_archive:" + keys[k]));
    }
    Promise.all(promises).then(function() {
      var filtered = [];
      for (var f = 0; f < (state.archiveIndex || []).length; f++) {
        if (!keysToDelete[state.archiveIndex[f].storageKey]) {
          filtered.push(state.archiveIndex[f]);
        }
      }
      state.archiveIndex = filtered;
      return api.storage.set("spotify_browse_archive_index", filtered);
    }).then(function() {
      render();
    }).catch(console.error);
  });

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
    renderPlaylist();
  });

  api.ui.onAction("toggle-show-browser", function() {
    state.showBrowserOnRefresh = !state.showBrowserOnRefresh;
    render();
  });

  api.ui.onAction("manual-refresh", function() {
    if (state.refreshing) return;
    state.refreshing = true;
    state.updatedPlaylistIds = {};
    state.refreshSummary = "";
    state.status = "waiting-login";
    render();

    performScrape(true, state.showBrowserOnRefresh).then(function(result) {
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

  // ---- Init: restore previous data ----

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
        }
        render();
      }).catch(function(err) { console.error("Failed to load legacy state:", err); render(); });
    }
  }).catch(function(err) { console.error("Failed to load state:", err); render(); });

  // Load archive index
  api.storage.get("spotify_browse_archive_index").then(function(index) {
    state.archiveIndex = index || [];
  }).catch(console.error);

  // Register 24h auto-refresh scheduler
  api.scheduler.register("auto-refresh", 24 * 60 * 60 * 1000).catch(console.error);
  api.scheduler.onDue("auto-refresh", function() {
    silentRefresh();
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
