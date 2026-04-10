// Lyrics Search Plugin for Viboplr
// Meta-search: queries DuckDuckGo, filters through whitelisted lyrics sites,
// fetches the first match, and extracts lyrics with site-specific scrapers.

function activate(api) {
  var DDG_URL = "https://html.duckduckgo.com/html/?q=";
  var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

  // Domain enabled state — all on by default, user can toggle in settings
  var domainEnabled = {};

  // --- HTML helpers ---

  function decodeEntities(str) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#8211;/g, "\u2013")
      .replace(/&#8217;/g, "\u2019")
      .replace(/&#x2019;/g, "\u2019")
      .replace(/&nbsp;/g, " ");
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  function brToNewline(html) {
    return html.replace(/<br\s*\/?>/gi, "\n");
  }

  function cleanLyrics(html) {
    var text = brToNewline(html);
    text = stripTags(text);
    text = decodeEntities(text);
    // Collapse multiple blank lines to max two newlines
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  }

  // --- Site-specific extractors ---
  // Each returns lyrics text or null from full page HTML.

  var extractors = {
    "stixoi.info": function (html) {
      // Mobile endpoint: <div class=moblyrics>...</div>
      var m = html.match(/class=moblyrics>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "stixoi.gr": function (html) {
      // WordPress/Elementor: theme-post-content widget
      var m = html.match(/data-widget_type="theme-post-content[^"]*"[\s\S]*?<div[^>]*class="elementor-widget-container"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      // Remove trailing metadata (starts with "Στοιχεία Τραγουδιού" or "Καλλιτέχνες:")
      text = text.replace(/\n\s*(Στοιχεία Τραγουδιού|Καλλιτέχνες:)[\s\S]*$/, "");
      return text || null;
    },

    "stichoi.gr": function (html) {
      // WordPress: <div class="entry-content">
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      // Remove header line "ΣΤΙΧΟΙ ..." and trailing metadata
      text = text.replace(/^ΣΤΙΧΟΙ\s[^\n]*\n/, "");
      text = text.replace(/\(adsbygoogle[\s\S]*?\)\s*;?\s*/g, "");
      text = text.replace(/\n\s*Στίχοι για το τραγούδι[\s\S]*$/, "");
      text = text.replace(/\n\s*Του ίδιου καλλιτέχνη[\s\S]*$/, "");
      return text.trim() || null;
    },

    "lyricstranslate.com": function (html) {
      // Lyric lines in div.ll-N-N elements inside translate__text
      var m = html.match(/class="translate__text[^"]*">([\s\S]*?)<\/div>\s*(?:<div class="translate__|<\/div>)/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "songlyrics.com": function (html) {
      // <p id="songLyricsDiv">
      var m = html.match(/id="songLyricsDiv"[^>]*>([\s\S]*?)<\/p>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "azlyrics.com": function (html) {
      // Lyrics in a div after <!-- Usage of azlyrics.com content... --> comment
      var m = html.match(/<!-- Usage of azlyrics[\s\S]*?-->\s*<div>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "lyrics.com": function (html) {
      // <pre id="lyric-body-text">
      var m = html.match(/id="lyric-body-text"[^>]*>([\s\S]*?)<\/pre>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "greeklyrics.gr": function (html) {
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      return cleanLyrics(m[1]);
    },

    "greekstixoi.gr": function (html) {
      var m = html.match(/class="entry-content"[^>]*>([\s\S]*?)<\/div>/);
      if (!m) return null;
      var text = cleanLyrics(m[1]);
      text = text.replace(/\n\s*Στίχοι για το τραγούδι[\s\S]*$/, "");
      return text.trim() || null;
    }
  };

  // Build domain list from extractor keys
  var allDomains = Object.keys(extractors);

  // --- Settings ---

  function loadSettings() {
    return api.storage.get("domain_settings").then(function (saved) {
      // Default: all domains enabled
      for (var i = 0; i < allDomains.length; i++) {
        domainEnabled[allDomains[i]] = true;
      }
      // Apply saved overrides
      if (saved) {
        for (var domain in saved) {
          if (saved.hasOwnProperty(domain) && domainEnabled.hasOwnProperty(domain)) {
            domainEnabled[domain] = saved[domain];
          }
        }
      }
    });
  }

  function saveSettings() {
    return api.storage.set("domain_settings", domainEnabled);
  }

  function renderSettings() {
    var rows = [];
    for (var i = 0; i < allDomains.length; i++) {
      var domain = allDomains[i];
      rows.push({
        type: "toggle",
        label: domain,
        checked: !!domainEnabled[domain],
        action: "toggle-domain:" + domain,
      });
    }

    api.ui.setViewData("lyrics-search-settings", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "section",
          title: "Whitelisted Domains",
          children: rows,
        },
      ],
    });
  }

  // Register a toggle action handler for each domain
  function makeToggleHandler(domain) {
    return function (data) {
      domainEnabled[domain] = !!(data && data.value);
      saveSettings();
      renderSettings();
    };
  }
  for (var i = 0; i < allDomains.length; i++) {
    api.ui.onAction("toggle-domain:" + allDomains[i], makeToggleHandler(allDomains[i]));
  }

  // Initialize settings on load
  loadSettings().then(function () {
    renderSettings();
  });

  // --- URL rewriting for better scraping ---

  function rewriteUrl(url) {
    // stixoi.info: rewrite desktop to mobile endpoint for cleaner HTML
    if (url.indexOf("stixoi.info") !== -1 && url.indexOf("act=details") !== -1) {
      return url.replace("act=details", "act=mobdetails");
    }
    return url;
  }

  // --- Search ---

  function searchDuckDuckGo(query) {
    var url = DDG_URL + encodeURIComponent(query);
    return api.network.fetch(url, {
      headers: { "User-Agent": USER_AGENT }
    }).then(function (resp) {
      if (resp.status !== 200) return [];
      return resp.text().then(function (html) {
        // Extract result URLs from DDG redirect links
        var results = [];
        var pattern = /uddg=([^&"]+)/g;
        var match;
        while ((match = pattern.exec(html)) !== null) {
          try {
            var decoded = decodeURIComponent(match[1]);
            results.push(decoded);
          } catch (e) {
            // skip malformed URLs
          }
        }
        return results;
      });
    });
  }

  function findWhitelistedUrl(results) {
    for (var i = 0; i < results.length; i++) {
      var url = results[i];
      for (var j = 0; j < allDomains.length; j++) {
        var domain = allDomains[j];
        if (domainEnabled[domain] && url.indexOf(domain) !== -1) {
          return { url: url, domain: domain };
        }
      }
    }
    return null;
  }

  // --- Fetch & extract ---

  function fetchAndExtract(url, domain) {
    var fetchUrl = rewriteUrl(url);
    return api.network.fetch(fetchUrl, {
      headers: { "User-Agent": USER_AGENT }
    }).then(function (resp) {
      if (resp.status !== 200) return null;
      return resp.text().then(function (html) {
        var extractor = extractors[domain];
        if (!extractor) return null;
        return extractor(html);
      });
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    // Build search query — include "στίχοι" for Greek results + "lyrics" for international
    var query = entity.artistName + " " + entity.name + " στίχοι lyrics";

    return searchDuckDuckGo(query).then(function (results) {
      var found = findWhitelistedUrl(results);
      if (!found) return { status: "not_found" };

      return fetchAndExtract(found.url, found.domain).then(function (text) {
        if (!text) return { status: "not_found" };
        return {
          status: "ok",
          value: { text: text, kind: "plain" },
        };
      });
    }).catch(function () {
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
