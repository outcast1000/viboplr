var ytDlpVersion = null;
var ffmpegVersion = null;
var latestYtDlp = null;
var latestFfmpeg = null;
var checking = false;
var downloadCache = {};

var YTDLP_INSTALL_URL = "https://github.com/yt-dlp/yt-dlp#installation";
var FFMPEG_INSTALL_URL = "https://ffmpeg.org/download.html";

async function fetchLatestVersions(api) {
  try {
    var ytRes = await api.network.fetch(
      "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
      { headers: { "Accept": "application/vnd.github.v3+json" } }
    );
    var ytData = await ytRes.json();
    if (ytData && ytData.tag_name) {
      latestYtDlp = ytData.tag_name;
    }
  } catch (e) {
    console.error("[youtube] failed to fetch yt-dlp latest version:", e);
  }
  try {
    var ffRes = await api.network.fetch(
      "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest",
      { headers: { "Accept": "application/vnd.github.v3+json" } }
    );
    var ffData = await ffRes.json();
    if (ffData && ffData.tag_name) {
      latestFfmpeg = ffData.tag_name;
    }
  } catch (e) {
    console.error("[youtube] failed to fetch ffmpeg latest version:", e);
  }
}

async function checkTools(api) {
  checking = true;
  renderSettings(api);
  try {
    var ytResult = await api.system.exec("yt-dlp", ["--version"]);
    ytDlpVersion = ytResult.exitCode === 0 ? ytResult.stdout.trim() : null;
  } catch (e) { ytDlpVersion = null; }
  try {
    var ffResult = await api.system.exec("ffmpeg", ["-version"]);
    if (ffResult.exitCode === 0) {
      var line = ffResult.stdout.split("\n")[0] || "";
      var m = line.match(/^ffmpeg version (\S+)/);
      ffmpegVersion = m ? m[1] : "unknown";
    } else { ffmpegVersion = null; }
  } catch (e) { ffmpegVersion = null; }
  await fetchLatestVersions(api);
  checking = false;
  renderSettings(api);
}

function parseDurationText(text) {
  var parts = text.split(":");
  if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  if (parts.length === 3) return parseInt(parts[0], 10) * 3600 + parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
  return null;
}

async function searchYoutube(api, title, artistName, durationSecs) {
  var query = artistName ? title + " " + artistName : title;
  var encoded = encodeURIComponent(query);
  var url = "https://www.youtube.com/results?search_query=" + encoded;
  var resp = await api.network.fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
  });
  var body = await resp.text();
  var match = body.match(/var ytInitialData = (\{.*?\});<\/script>/);
  if (!match) return null;
  var data;
  try { data = JSON.parse(match[1]); } catch (e) { return null; }
  var sections = ((((data.contents || {}).twoColumnSearchResultsRenderer || {}).primaryContents || {}).sectionListRenderer || {}).contents || [];
  var candidates = [];
  for (var s = 0; s < sections.length && candidates.length < 7; s++) {
    var items = ((sections[s].itemSectionRenderer || {}).contents) || [];
    for (var i = 0; i < items.length && candidates.length < 7; i++) {
      var vr = items[i].videoRenderer;
      if (!vr || !vr.videoId) continue;
      var vTitle = (((vr.title || {}).runs || [])[0] || {}).text || null;
      var durText = ((vr.lengthText || {}).simpleText) || null;
      candidates.push({ videoId: vr.videoId, title: vTitle, durationSecs: durText ? parseDurationText(durText) : null });
    }
  }
  if (candidates.length === 0) return null;
  var best = candidates[0];
  if (durationSecs) {
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c].durationSecs !== null && Math.abs(candidates[c].durationSecs - durationSecs) <= 3) {
        best = candidates[c]; break;
      }
    }
  }
  return { url: "https://www.youtube.com/watch?v=" + best.videoId, videoTitle: best.title };
}

async function searchAndDownload(api, title, artistName, durationSecs) {
  console.log("[youtube] searchAndDownload:", JSON.stringify({ title: title, artist: artistName, duration: durationSecs }));
  var result;
  try {
    result = await searchYoutube(api, title, artistName, durationSecs);
  } catch (e) {
    console.error("[youtube] searchYoutube failed:", e);
    return null;
  }
  if (!result || !result.url) {
    console.warn("[youtube] search returned no result for:", title);
    return null;
  }
  console.log("[youtube] search found:", result.url, result.videoTitle || "");

  var cached = downloadCache[result.url];
  if (cached) {
    console.log("[youtube] using cached file:", cached);
    return cached;
  }

  console.log("[youtube] downloading audio via yt-dlp:", result.url);
  var filePath;
  try {
    var destFile = Date.now() + ".%(ext)s";
    var dlResult = await api.system.exec("yt-dlp", [
      "-f", "bestaudio",
      "--no-warnings",
      "--quiet",
      "--no-simulate",
      "--print", "after_move:filepath",
      "-o", destFile,
      result.url
    ], { cwd: null });
    if (dlResult.exitCode !== 0) {
      console.error("[youtube] yt-dlp failed:", dlResult.stderr);
      return null;
    }
    filePath = dlResult.stdout.trim() || null;
  } catch (e) {
    console.error("[youtube] yt-dlp exec failed:", e);
    return null;
  }
  if (!filePath) {
    console.warn("[youtube] yt-dlp returned no file path");
    return null;
  }

  console.log("[youtube] downloaded to:", filePath);
  downloadCache[result.url] = filePath;
  return filePath;
}

async function activate(api) {
  try {
    var ytRes = await api.system.exec("yt-dlp", ["--version"]);
    ytDlpVersion = ytRes.exitCode === 0 ? ytRes.stdout.trim() : null;
  } catch (e) { ytDlpVersion = null; }
  try {
    var ffRes = await api.system.exec("ffmpeg", ["-version"]);
    if (ffRes.exitCode === 0) {
      var line = ffRes.stdout.split("\n")[0] || "";
      var m = line.match(/^ffmpeg version (\S+)/);
      ffmpegVersion = m ? m[1] : "unknown";
    } else { ffmpegVersion = null; }
  } catch (e) { ffmpegVersion = null; }

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName, durationSecs) {
    console.log("[youtube] stream resolve called:", JSON.stringify({ title: title, artist: artistName, duration: durationSecs }));
    if (!ytDlpVersion) {
      console.log("[youtube] skipping stream resolve — yt-dlp not available");
      return null;
    }

    try {
      var filePath = await searchAndDownload(api, title, artistName, durationSecs);
      if (!filePath) {
        console.warn("[youtube] stream resolve: no file returned for", title);
        return null;
      }
      console.log("[youtube] stream resolve success:", filePath);
      return { url: "file://" + filePath, label: "YouTube" };
    } catch (e) {
      console.error("[youtube] stream resolve failed:", e, e.stack || "");
      return null;
    }
  });

  api.downloads.onResolveByUri("youtube-download", async function(uri, format) {
    if (!uri.startsWith("external://")) return null;
    if (!ytDlpVersion) return null;
    return null;
  });

  api.downloads.onResolveByMetadata("youtube-download", async function(title, artistName, albumName, durationSecs, format) {
    if (!ytDlpVersion) {
      console.log("[youtube] skipping download resolve — yt-dlp not available");
      return null;
    }
    try {
      var webmPath = await searchAndDownload(api, title, artistName);
      if (!webmPath) {
        console.warn("[youtube] download resolve: no webm for", title);
        return null;
      }
      console.log("[youtube] converting", webmPath, "to format:", format || "aac");
      var finalPath;
      try {
        var fmt = format || "aac";
        var ext = (fmt === "aac" || fmt === "m4a") ? "m4a" : fmt === "mp3" ? "mp3" : fmt === "flac" ? "flac" : null;
        if (ext) {
          var destPath = webmPath.replace(/\.[^.]+$/, "." + ext);
          var codec = (fmt === "aac" || fmt === "m4a") ? "aac" : fmt === "mp3" ? "libmp3lame" : "flac";
          var convResult = await api.system.exec("ffmpeg", ["-i", webmPath, "-vn", "-c:a", codec, "-y", destPath]);
          finalPath = convResult.exitCode === 0 ? destPath : webmPath;
        } else {
          finalPath = webmPath;
        }
      } catch (convertErr) {
        console.error("[youtube] ffmpeg_convert_audio failed:", convertErr);
        console.log("[youtube] falling back to raw webm file");
        finalPath = webmPath;
      }
      console.log("[youtube] download resolve success:", finalPath);
      return {
        url: "file://" + finalPath,
        headers: null,
        metadata: {
          title: title,
          artist: artistName || undefined,
          album: albumName || undefined
        }
      };
    } catch (e) {
      console.error("[youtube] download resolve failed:", e, e.stack || "");
      return null;
    }
  });

  api.ui.onAction("youtube-refresh", async function() {
    await checkTools(api);
  });

  api.ui.onAction("youtube-install-ytdlp", function() {
    api.network.openUrl(YTDLP_INSTALL_URL);
  });

  api.ui.onAction("youtube-install-ffmpeg", function() {
    api.network.openUrl(FFMPEG_INSTALL_URL);
  });

  fetchLatestVersions(api).then(function() {
    renderSettings(api);
  });

  renderSettings(api);
}

function makeToolRow(name, localVersion, latestVersion, installAction) {
  var installed = !!localVersion;
  var desc;
  if (!installed) {
    desc = "Not installed";
  } else if (latestVersion && localVersion !== latestVersion) {
    desc = "Installed: " + localVersion + "  →  Latest: " + latestVersion;
  } else if (latestVersion) {
    desc = "Installed: " + localVersion + " (up to date)";
  } else {
    desc = "Installed: " + localVersion;
  }

  return {
    type: "settings-row",
    label: name,
    description: desc,
    control: {
      type: "button",
      label: installed ? "Installation Page" : "Install",
      action: installAction,
      variant: installed ? undefined : "accent"
    }
  };
}

function renderSettings(api) {
  api.ui.setViewData("youtube-settings", {
    type: "layout",
    direction: "vertical",
    children: [
      {
        type: "section",
        title: "Dependencies",
        children: [
          makeToolRow("yt-dlp", ytDlpVersion, latestYtDlp, "youtube-install-ytdlp"),
          makeToolRow("ffmpeg", ffmpegVersion, latestFfmpeg, "youtube-install-ffmpeg"),
        ]
      },
      { type: "spacer" },
      {
        type: "layout",
        direction: "horizontal",
        children: [
          {
            type: "button",
            label: checking ? "Checking..." : "Refresh",
            action: "youtube-refresh",
            disabled: checking
          }
        ]
      }
    ]
  });
}

function deactivate() {
  ytDlpVersion = null;
  ffmpegVersion = null;
  latestYtDlp = null;
  latestFfmpeg = null;
  checking = false;
  downloadCache = {};
}

return { activate: activate, deactivate: deactivate };
