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
  };

  // ---- Helpers ----

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function cleanup() {
    if (browseHandle) { browseHandle.close(); browseHandle = null; }
  }

  // ---- Render ----

  function renderHome() {
    var ch = [];

    if (state.status === "idle") {
      ch.push({ type: "text", content: "<h3>Spotify &mdash; Made for You</h3>" });
      ch.push({ type: "text", content: "<p>Opens the Spotify web player so you can log in, then automatically grabs your <b>Made for You</b> playlists and all their tracks.</p>" });
      ch.push({ type: "spacer" });
      ch.push({ type: "button", label: "Open Spotify", action: "open-spotify" });
    } else if (state.status === "waiting-login") {
      ch.push({ type: "text", content: "<h3>Waiting for login\u2026</h3>" });
      ch.push({ type: "text", content: "<p>Log in to Spotify in the browser window. Click <b>Show Browser</b> to open it.</p>" });
      ch.push({ type: "spacer" });
      ch.push({
        type: "layout", direction: "horizontal", children: [
          { type: "button", label: state.browserVisible ? "Hide Browser" : "Show Browser", action: "toggle-browser" },
          { type: "button", label: "Cancel", action: "cancel", variant: "secondary" },
        ]
      });
    } else if (state.status === "finding-made-for-you") {
      ch.push({ type: "loading", message: "Navigating to Made for You\u2026" });
      ch.push({ type: "button", label: state.browserVisible ? "Hide Browser" : "Show Browser", action: "toggle-browser" });
    } else if (state.status === "scraping-playlists") {
      ch.push({ type: "loading", message: "Grabbing playlists\u2026" });
      ch.push({ type: "button", label: state.browserVisible ? "Hide Browser" : "Show Browser", action: "toggle-browser" });
    } else if (state.status === "scraping-tracks") {
      var lbl = "Grabbing tracks";
      if (state.scrapeProgress.name) lbl += ": " + state.scrapeProgress.name;
      if (state.scrapeProgress.total > 0) lbl += " (" + state.scrapeProgress.current + "/" + state.scrapeProgress.total + ")";
      ch.push({ type: "loading", message: lbl + "\u2026" });
      ch.push({ type: "button", label: state.browserVisible ? "Hide Browser" : "Show Browser", action: "toggle-browser" });
    } else if (state.status === "error") {
      ch.push({ type: "text", content: "<p style='color:var(--error)'>" + escapeHtml(state.errorMessage) + "</p>" });
      ch.push({ type: "spacer" });
      ch.push({ type: "button", label: "Try Again", action: "open-spotify" });
    }

    // Show playlists once we have them
    if (state.playlists.length > 0) {
      ch.push({ type: "spacer" });
      ch.push({ type: "text", content: "<h3>Made for You</h3>" });
      ch.push({ type: "text", content: "<p style='opacity:0.6'>" + state.playlists.length + " playlists</p>" });
      var cards = [];
      for (var i = 0; i < state.playlists.length; i++) {
        var p = state.playlists[i];
        var ts = state.playlistTracks[p.id];
        var sub = ts ? ts.length + " tracks" : (p.description || "");
        cards.push({
          id: "playlist:" + p.id,
          title: p.name,
          subtitle: sub,
          imageUrl: p.imageUrl,
          action: "view-playlist",
        });
      }
      ch.push({ type: "card-grid", items: cards });
      ch.push({ type: "spacer" });
      ch.push({ type: "button", label: "Refresh", action: "open-spotify" });
    }

    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
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

  // ---- Injected scripts (plain strings for eval) ----

  var SCRIPT_CHECK_LOGIN = '(function(){try{' +
    'var u=document.querySelector("[data-testid=\\"user-widget-link\\"]");' +
    'var a=document.querySelector(".main-userWidget-box");' +
    'var l=document.querySelector("[data-testid=\\"login-button\\"]");' +
    'var ok=!!(u||a)&&!l;' +
    'window.__viboplr.send("login-check",{loggedIn:ok});' +
    '}catch(e){window.__viboplr.send("login-check",{loggedIn:false})}})()';

  // Searches the page for a link whose visible text contains "Made for You"
  // (case-insensitive). If found, clicks it and reports the href. If not found,
  // reports back so the plugin can retry.
  var SCRIPT_FIND_MADE_FOR_YOU = '(function(){try{' +
    'var links=document.querySelectorAll("a");' +
    'for(var i=0;i<links.length;i++){' +
      'var txt=(links[i].textContent||"").trim().toLowerCase();' +
      'if(txt==="made for you"||txt.indexOf("made for you")!==-1){' +
        'var href=links[i].getAttribute("href")||"";' +
        'links[i].click();' +
        'window.__viboplr.send("made-for-you-found",{href:href});' +
        'return;' +
      '}' +
    '}' +
    // Also check section headings that might be clickable
    'var headings=document.querySelectorAll("h2, h3, span, p");' +
    'for(var j=0;j<headings.length;j++){' +
      'var h=headings[j];' +
      'var ht=(h.textContent||"").trim().toLowerCase();' +
      'if(ht==="made for you"||ht.indexOf("made for you")!==-1){' +
        'var parent=h.closest("a");' +
        'if(parent){' +
          'parent.click();' +
          'window.__viboplr.send("made-for-you-found",{href:parent.getAttribute("href")||""});' +
          'return;' +
        '}' +
        // Try clicking the heading itself (some sections use click handlers)
        'h.click();' +
        'window.__viboplr.send("made-for-you-found",{href:"clicked-heading"});' +
        'return;' +
      '}' +
    '}' +
    'window.__viboplr.send("made-for-you-not-found",{});' +
    '}catch(e){window.__viboplr.send("error",{message:"find link: "+e})}})()';

  // Helper inlined into scrape scripts: extracts the best image URL from an
  // element, handling lazy-loaded images, srcset, and CSS background-image.
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
      // Fallback: look for background-image on a div
      'var bgs=el.querySelectorAll("[style]");' +
      'for(var b=0;b<bgs.length;b++){' +
        'var bg=bgs[b].style.backgroundImage||"";' +
        'var bm=bg.match(/url\\([\\"\\\']*([^\\"\\\'\\)]+)/);' +
        'if(bm&&bm[1])return bm[1];' +
      '}' +
      'return null;' +
    '}';

  var SCRIPT_SCRAPE_PLAYLISTS = '(function(){try{' +
    IMG_HELPER +
    'var out=[];var seen={};' +
    'var cards=document.querySelectorAll("div[data-testid=\\"card\\"]");' +
    'if(!cards.length) cards=document.querySelectorAll("a[href*=\\"/playlist/\\"]");' +
    'for(var i=0;i<cards.length;i++){' +
      'var c=cards[i];' +
      'var a=c.tagName==="A"?c:c.querySelector("a[href*=\\"/playlist/\\"]");' +
      'if(!a)continue;' +
      'var m=(a.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!m||seen[m[1]])continue;seen[m[1]]=1;' +
      'var ne=c.querySelector("[data-testid=\\"card-title\\"]")||c.querySelector("p")||c.querySelector("span");' +
      'var nm=ne?ne.textContent.trim():"";' +
      'var de=c.querySelector("[data-testid=\\"card-subtitle\\"]");' +
      'var ds=de?de.textContent.trim():"";' +
      'var imgUrl=bestImg(c);' +
      'if(nm)out.push({id:m[1],name:nm,description:ds,imageUrl:imgUrl,uri:"spotify:playlist:"+m[1]});' +
    '}' +
    'window.__viboplr.send("playlists",out);' +
    '}catch(e){window.__viboplr.send("error",{message:""+e})}})()';

  function scriptNavigatePlaylist(id) {
    return '(function(){window.location.href="/playlist/' + id + '"})()';
  }

  function scriptScrollThenScrape(playlistId) {
    // Step 1: scroll the main container to bottom to force lazy-load all tracks.
    // Step 2: when scrolling stabilises, scrape every tracklist row.
    return '(function(){' +
      IMG_HELPER +
      // Grab the playlist cover image from the page header before scrolling
      'var coverUrl=null;' +
      'var hdr=document.querySelector("[data-testid=\\"playlist-image\\"]")' +
        '||document.querySelector("[data-testid=\\"entity-image\\"]")' +
        '||document.querySelector("header img")' +
        '||document.querySelector("[data-testid=\\"action-bar-row\\"]");' +
      'if(hdr){coverUrl=bestImg(hdr.closest("header")||hdr.parentElement||hdr)}' +
      // If nothing in header, try any large image near the top of main
      'if(!coverUrl){var mainImgs=document.querySelectorAll("main img");' +
        'for(var mi=0;mi<mainImgs.length&&mi<5;mi++){' +
          'var ms=mainImgs[mi].currentSrc||mainImgs[mi].src||"";' +
          'if(ms&&ms.indexOf("data:")!==0&&ms.indexOf("blob:")!==0){coverUrl=ms;break}' +
        '}}' +
      'var sc=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
        '||document.querySelector("main")||document.scrollingElement;' +
      'var ph=0,stable=0,n=0;' +
      'function tick(){' +
        'sc.scrollTop=sc.scrollHeight;n++;' +
        'if(sc.scrollHeight===ph){stable++}else{stable=0}' +
        'ph=sc.scrollHeight;' +
        'if(stable>=3||n>=50){scrape()}else{setTimeout(tick,800)}' +
      '}' +
      'function scrape(){try{' +
        'var out=[];' +
        'var rows=document.querySelectorAll("[data-testid=\\"tracklist-row\\"]");' +
        'if(!rows.length)rows=document.querySelectorAll("[role=\\"row\\"]");' +
        'for(var i=0;i<rows.length;i++){var r=rows[i];' +
          'var ne=r.querySelector("[data-testid=\\"internal-track-link\\"] div")||r.querySelector("a[href*=\\"/track/\\"]");' +
          'var nm=ne?ne.textContent.trim():"";if(!nm)continue;' +
          'var aLinks=r.querySelectorAll("a[href*=\\"/artist/\\"]");' +
          'var arts=[];for(var j=0;j<aLinks.length;j++){var at=aLinks[j].textContent.trim();if(at&&arts.indexOf(at)===-1)arts.push(at)}' +
          'var alEl=r.querySelector("a[href*=\\"/album/\\"]");' +
          'var al=alEl?alEl.textContent.trim():"";' +
          'var du=r.querySelector("[data-testid=\\"tracklist-duration\\"]");' +
          'var dur=du?du.textContent.trim():"";' +
          'var imgUrl=bestImg(r);' +
          'out.push({name:nm,artist:arts.join(", "),album:al,duration:dur,imageUrl:imgUrl})' +
        '}' +
        'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:out,coverUrl:coverUrl});' +
      '}catch(e){window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:[],error:""+e})}}' +
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
    console.log("[spotify] msg:", t);

    if (t === "login-check" && d && d.loggedIn) {
      // User logged in — stop polling, start looking for the Made for You link
      if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
      state.status = "finding-made-for-you";
      renderHome();
      // Give the home page a moment to render its sections
      madeForYouRetries = 0;
      setTimeout(findMadeForYouLink, 2000);
    }

    if (t === "made-for-you-found") {
      // Link was found and clicked — wait for the target page to render,
      // then start scraping playlists
      console.log("[spotify] Made for You link clicked, href:", d && d.href);
      if (madeForYouTimer) { clearTimeout(madeForYouTimer); madeForYouTimer = null; }
      setTimeout(function() {
        state.status = "scraping-playlists";
        renderHome();
        beginPlaylistScrape();
      }, 4000);
    }

    if (t === "made-for-you-not-found") {
      // Link not on the page yet — retry (the SPA may still be loading)
      retryFindMadeForYou();
    }

    if (t === "playlists") {
      if (Array.isArray(d) && d.length > 0) {
        state.playlists = d;
        if (playlistRetryTimer) { clearTimeout(playlistRetryTimer); playlistRetryTimer = null; }
        renderHome();
        beginTrackScrape();
      } else {
        retryPlaylistScrape();
      }
    }

    if (t === "tracks" && d) {
      state.playlistTracks[d.playlistId] = d.tracks || [];
      // Apply the cover image grabbed from the playlist detail page
      if (d.coverUrl) {
        for (var pi = 0; pi < state.playlists.length; pi++) {
          if (state.playlists[pi].id === d.playlistId) {
            state.playlists[pi].imageUrl = d.coverUrl;
            break;
          }
        }
      }
      renderHome();
      trackBusy = false;
      scrapeNextTrackPage();
    }

    if (t === "error") {
      console.warn("[spotify] error from browse window:", d && d.message);
    }
  }

  // ---- Find the Made for You link ----

  function findMadeForYouLink() {
    if (browseHandle) browseHandle.eval(SCRIPT_FIND_MADE_FOR_YOU);
  }

  function retryFindMadeForYou() {
    madeForYouRetries++;
    if (madeForYouRetries > 15) {
      // Give up — the link may not exist on this page
      state.status = "error";
      state.errorMessage = "Could not find a \u201cMade for You\u201d link on the Spotify home page. Try scrolling the browse window and clicking Refresh.";
      renderHome();
      return;
    }
    console.log("[spotify] Made for You link not found, retry " + madeForYouRetries + "/15");
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
    playlistRetries++;
    if (playlistRetries > 10) {
      state.status = state.playlists.length > 0 ? "done" : "error";
      state.errorMessage = "Could not find any playlists on the Made for You page.";
      renderHome();
      cleanup();
      return;
    }
    playlistRetryTimer = setTimeout(doPlaylistScrape, 2000);
  }

  function beginTrackScrape() {
    trackQueue = state.playlists.slice();
    state.scrapeProgress = { current: 0, total: trackQueue.length, name: "" };
    state.status = "scraping-tracks";
    trackBusy = false;
    renderHome();
    scrapeNextTrackPage();
  }

  function scrapeNextTrackPage() {
    if (trackQueue.length === 0) {
      state.status = "done";
      renderHome();
      saveToStorage();
      cleanup();
      return;
    }
    if (trackBusy) return;
    trackBusy = true;

    var pl = trackQueue.shift();
    state.scrapeProgress.current++;
    state.scrapeProgress.name = pl.name;
    renderHome();

    // Navigate to the playlist
    if (browseHandle) {
      browseHandle.eval(scriptNavigatePlaylist(pl.id));
    }

    // Wait for page to render, then scroll + scrape
    setTimeout(function() {
      if (browseHandle) {
        browseHandle.eval(scriptScrollThenScrape(pl.id));
      }
      // Safety timeout — don't hang forever
      setTimeout(function() {
        if (trackBusy) {
          console.warn("[spotify] timeout scraping tracks for " + pl.name);
          state.playlistTracks[pl.id] = [];
          trackBusy = false;
          scrapeNextTrackPage();
        }
      }, 45000);
    }, 4000);
  }

  function saveToStorage() {
    api.storage.set("spotify_browse_playlists", {
      playlists: state.playlists,
      tracks: state.playlistTracks,
      savedAt: Date.now(),
    }).catch(function() {});
  }

  // ---- Actions ----

  api.ui.onAction("open-spotify", function() {
    cleanup();
    resetTimers();
    state.playlists = [];
    state.playlistTracks = {};
    state.status = "waiting-login";
    state.errorMessage = "";
    renderHome();

    state.browserVisible = false;

    api.network.openBrowseWindow("https://open.spotify.com", {
      title: "Spotify \u2014 Log in",
      width: 1200,
      height: 800,
      visible: false,
    }).then(function(handle) {
      browseHandle = handle;
      handle.onMessage(onMessage);

      // Poll for login every 3 s
      loginPoll = setInterval(function() {
        if (browseHandle && state.status === "waiting-login") {
          browseHandle.eval(SCRIPT_CHECK_LOGIN);
        }
      }, 3000);

      // First check after 3 s
      setTimeout(function() {
        if (browseHandle && state.status === "waiting-login") {
          browseHandle.eval(SCRIPT_CHECK_LOGIN);
        }
      }, 3000);
    }).catch(function(err) {
      state.status = "error";
      state.errorMessage = "Failed to open browser: " + (err.message || err);
      renderHome();
    });
  });

  api.ui.onAction("toggle-browser", function() {
    if (!browseHandle) return;
    state.browserVisible = !state.browserVisible;
    if (state.browserVisible) {
      browseHandle.show();
    } else {
      browseHandle.hide();
    }
    renderHome();
  });

  api.ui.onAction("cancel", function() {
    cleanup();
    resetTimers();
    state.status = "idle";
    renderHome();
  });

  api.ui.onAction("go-home", function() {
    state.currentPlaylist = null;
    state.currentView = "home";
    renderHome();
  });

  api.ui.onAction("view-playlist", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) {
        state.currentPlaylist = state.playlists[i];
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

  // ---- Init: restore previous data ----

  api.storage.get("spotify_browse_playlists").then(function(saved) {
    if (saved && saved.playlists && saved.playlists.length > 0) {
      state.playlists = saved.playlists;
      state.playlistTracks = saved.tracks || {};
      state.status = "done";
    }
    renderHome();
  }).catch(function() { renderHome(); });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
