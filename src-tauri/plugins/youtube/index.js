var ytDlpVersion = null;
var ffmpegVersion = null;
var latestYtDlp = null;
var latestFfmpeg = null;
var checking = false;
var cacheMaxMb = 100;

var REMASTER_SUFFIX = /\s*-\s*.*remaster.*$/i;
function stripRemasterSuffix(s) {
  if (!s) return s;
  return s.replace(REMASTER_SUFFIX, "").trim() || s;
}

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

// Probe an audio file via `ffmpeg -i`. Returns { codec, bitrateKbps } or null.
async function probeAudio(api, filePath) {
  try {
    var probe = await api.system.exec("ffmpeg", ["-i", filePath, "-hide_banner"]);
    // ffmpeg exits nonzero when no output is given, but still prints stream info to stderr
    var stderr = probe.stderr || "";
    var streamLine = null;
    var lines = stderr.split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf("Audio:") !== -1) { streamLine = lines[i]; break; }
    }
    if (!streamLine) return null;
    // Stream #0:0(eng): Audio: opus, 48000 Hz, stereo, fltp, 160 kb/s
    var codecMatch = streamLine.match(/Audio:\s*([a-zA-Z0-9_]+)/);
    var codec = codecMatch ? codecMatch[1].toLowerCase() : null;
    var brMatch = streamLine.match(/(\d+)\s*kb\/s/);
    var bitrateKbps = brMatch ? parseInt(brMatch[1], 10) : null;
    return { codec: codec, bitrateKbps: bitrateKbps };
  } catch (e) {
    api.log("warn", "probeAudio failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
}

// Decide ffmpeg args for converting src to target format. Remux when codec already matches.
function buildConvertArgs(srcPath, destPath, fmt, probe) {
  var codec = probe ? probe.codec : null;
  var bitrateKbps = probe && probe.bitrateKbps ? probe.bitrateKbps : 160;

  // Remux opportunities (codec copy, no re-encode)
  if ((fmt === "aac" || fmt === "m4a") && (codec === "aac")) {
    return ["-i", srcPath, "-vn", "-c:a", "copy", "-y", destPath];
  }
  if (fmt === "mp3" && codec === "mp3") {
    return ["-i", srcPath, "-vn", "-c:a", "copy", "-y", destPath];
  }
  if (fmt === "flac" && codec === "flac") {
    return ["-i", srcPath, "-vn", "-c:a", "copy", "-y", destPath];
  }

  // Re-encode, matching source bitrate (cap at 320k, floor at 96k for sanity)
  var targetKbps = Math.max(96, Math.min(320, bitrateKbps));
  if (fmt === "aac" || fmt === "m4a") {
    return ["-i", srcPath, "-vn", "-c:a", "aac", "-b:a", targetKbps + "k", "-y", destPath];
  }
  if (fmt === "mp3") {
    return ["-i", srcPath, "-vn", "-c:a", "libmp3lame", "-b:a", targetKbps + "k", "-y", destPath];
  }
  if (fmt === "flac") {
    return ["-i", srcPath, "-vn", "-c:a", "flac", "-y", destPath];
  }
  return null;
}

var VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Look up a cached download for a videoId. Returns absolute path or null.
async function findCachedDownload(api, videoId) {
  try {
    var entries = await api.storage.files.list(["cache"]);
    for (var i = 0; i < entries.length; i++) {
      var name = entries[i].name;
      var dot = name.lastIndexOf(".");
      if (dot > 0 && name.substring(0, dot) === videoId) {
        return await api.storage.files.getPath(["cache", name]);
      }
    }
  } catch (e) {
    // Directory may not exist yet — that's fine
  }
  return null;
}

// Remove temp files and evict oldest cache entries when over budget.
// `protectName` (optional) is a filename to never evict (the just-downloaded file).
async function cleanupCache(api, protectName) {
  var maxBytes = cacheMaxMb * 1024 * 1024;
  try {
    await api.storage.files.remove(["temp"]);
  } catch (e) {
    // temp dir may not exist — that's fine
  }
  var entries;
  try {
    entries = await api.storage.files.list(["cache"]);
  } catch (e) {
    // cache dir may not exist — that's fine
    return;
  }

  var validFiles = [];
  var removedStray = 0;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.isDir) continue;
    var name = entry.name;
    var dot = name.lastIndexOf(".");
    var stem = dot > 0 ? name.substring(0, dot) : name;
    if (!VIDEO_ID_RE.test(stem)) {
      try { await api.storage.files.remove(["cache", name]); removedStray++; } catch (e) {}
    } else {
      validFiles.push({ name: name, size: entry.size || 0, modifiedAt: entry.modifiedAt || 0 });
    }
  }

  // Sort by modifiedAt ascending (oldest first) for LRU eviction
  validFiles.sort(function(a, b) { return a.modifiedAt - b.modifiedAt; });

  var totalSize = 0;
  for (var j = 0; j < validFiles.length; j++) {
    totalSize += validFiles[j].size;
  }

  var evicted = 0;
  while (totalSize > maxBytes && validFiles.length > 0) {
    var oldest = validFiles[0];
    if (oldest.name === protectName) {
      // Don't evict the file we just downloaded — try the next oldest
      if (validFiles.length <= 1) break;
      validFiles.shift();
      continue;
    }
    validFiles.shift();
    totalSize -= oldest.size;
    try { await api.storage.files.remove(["cache", oldest.name]); evicted++; } catch (e) {}
  }

  if (removedStray > 0 || evicted > 0) {
    api.log("info", "Cache cleanup: evicted " + evicted + " file(s), removed " + removedStray + " stray file(s), " + Math.round(totalSize / 1024 / 1024) + " MB remaining", "youtube");
  }
}

async function searchAndDownload(api, title, artistName, durationSecs) {
  api.log("info", "Searching YouTube for: " + title + (artistName ? " — " + artistName : ""), "youtube");
  var result;
  try {
    result = await searchYoutube(api, title, artistName, durationSecs);
  } catch (e) {
    api.log("error", "YouTube search failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
  if (!result || !result.url) {
    api.log("warn", "YouTube search returned no result for: " + title, "youtube");
    return null;
  }
  api.log("info", "Matched " + (result.videoTitle || "(untitled)") + " — " + result.url, "youtube");

  var videoId = result.url.split("v=")[1];
  if (!videoId) {
    api.log("warn", "Could not extract videoId from: " + result.url, "youtube");
    return null;
  }

  var cached = await findCachedDownload(api, videoId);
  if (cached) {
    api.log("info", "Using cached download: " + cached, "youtube");
    return { filePath: cached, youtubeUrl: result.url };
  }

  api.log("info", "Downloading audio via yt-dlp: " + result.url, "youtube");
  var filePath;
  try {
    // Get the plugin's cache directory by writing a sentinel and reading its path
    var sentinelPath = await api.storage.files.writeText(["cache", ".init"], "");
    // sentinelPath is ".../plugin-cache/youtube/cache/.init" — strip filename for -P
    var cacheDir = sentinelPath.replace(/[\/\\][^\/\\]+$/, "");
    var outputTemplate = videoId + ".%(ext)s";
    var dlResult = await api.system.exec("yt-dlp", [
      "-f", "bestaudio",
      "--no-warnings",
      "--quiet",
      "--no-simulate",
      "--print", "after_move:filepath",
      "-P", cacheDir,
      "-o", outputTemplate,
      result.url
    ], { cwd: null });
    if (dlResult.exitCode !== 0) {
      api.log("error", "yt-dlp failed (exit " + dlResult.exitCode + "): " + (dlResult.stderr || "").trim(), "youtube");
      return null;
    }
    filePath = dlResult.stdout.trim() || null;
  } catch (e) {
    api.log("error", "yt-dlp exec failed: " + (e && e.message ? e.message : e), "youtube");
    return null;
  }
  if (!filePath) {
    api.log("warn", "yt-dlp returned no file path", "youtube");
    return null;
  }

  api.log("info", "Downloaded to: " + filePath, "youtube");
  var dlFilename = filePath.replace(/^.*[\/\\]/, "");
  cleanupCache(api, dlFilename).catch(function(e) {
    api.log("warn", "Post-download cache cleanup failed: " + (e && e.message ? e.message : e), "youtube");
  });
  return { filePath: filePath, youtubeUrl: result.url };
}

async function activate(api) {
  var storedMax = await api.storage.get("cacheMaxMb");
  if (storedMax != null && typeof storedMax === "number") cacheMaxMb = storedMax;

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

  // Startup cleanup: wipe transcoded/temp files; keep source downloads keyed by videoId.
  await cleanupCache(api);

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName, durationSecs) {
    if (!ytDlpVersion) {
      api.log("warn", "Stream resolve skipped — yt-dlp not available", "youtube");
      return null;
    }

    title = stripRemasterSuffix(title);
    try {
      var result = await searchAndDownload(api, title, artistName, durationSecs);
      if (!result) {
        api.log("warn", "Stream resolve: no file returned for " + title, "youtube");
        return null;
      }
      api.log("info", "Stream resolved to: " + result.filePath, "youtube");
      return { url: "file://" + result.filePath, label: "YouTube", sourceUrl: result.youtubeUrl };
    } catch (e) {
      api.log("error", "Stream resolve failed: " + (e && e.message ? e.message : e), "youtube");
      return null;
    }
  });

  api.downloads.onResolveByUri("youtube-download", async function(uri, format) {
    if (!uri.startsWith("external://")) return null;
    if (!ytDlpVersion) return null;
    return null;
  });

  api.downloads.onGetQualities("youtube-download", function() {
    return [{ value: "aac", label: "AAC (160kbps)" }];
  });

  api.downloads.onResolveByMetadata("youtube-download", async function(title, artistName, albumName, durationSecs, format) {
    if (!ytDlpVersion) {
      api.log("warn", "Download resolve skipped — yt-dlp not available", "youtube");
      return null;
    }
    title = stripRemasterSuffix(title);
    try {
      var dlResult = await searchAndDownload(api, title, artistName);
      if (!dlResult) {
        api.log("warn", "Download resolve: no source file for " + title, "youtube");
        return null;
      }
      var srcPath = dlResult.filePath;
      var fmt = format || "aac";
      api.log("info", "Preparing " + title + " as " + fmt, "youtube");
      var finalPath;
      try {
        var ext = (fmt === "aac" || fmt === "m4a") ? "m4a" : fmt === "mp3" ? "mp3" : fmt === "flac" ? "flac" : null;
        if (ext) {
          var probe = await probeAudio(api, srcPath);
          if (probe) {
            api.log("info", "Source: " + (probe.codec || "?") + " @ " + (probe.bitrateKbps || "?") + " kb/s", "youtube");
          } else {
            api.log("warn", "Could not probe source — falling back to transcode defaults", "youtube");
          }
          // Derive a destPath in the plugin's temp/ directory (wiped on startup) rather than next to the cached source.
          var srcName = srcPath.replace(/^.*[\/\\]/, "");
          var destName = srcName.replace(/\.[^.]+$/, "." + ext);
          var tempSentinel = await api.storage.files.writeText(["temp", destName], "");
          var destPath = tempSentinel;
          var srcExt = (srcPath.match(/\.([^.]+)$/) || [])[1];
          var args = buildConvertArgs(srcPath, destPath, fmt, probe);
          if (!args) {
            api.log("warn", "No conversion rule for format: " + fmt + " — using source as-is", "youtube");
            finalPath = srcPath;
          } else if (srcExt === ext && args[4] === "copy") {
            api.log("info", "Source already in target container — reusing without conversion", "youtube");
            finalPath = srcPath;
          } else if (args[4] === "copy") {
            api.log("info", "Remuxing (codec copy, no re-encode) -> " + destPath, "youtube");
            var remuxResult = await api.system.exec("ffmpeg", args);
            finalPath = remuxResult.exitCode === 0 ? destPath : srcPath;
            if (remuxResult.exitCode !== 0) {
              api.log("error", "Remux failed (exit " + remuxResult.exitCode + "): " + (remuxResult.stderr || "").trim(), "youtube");
            }
          } else {
            // Re-encode — find the -b:a arg to log bitrate
            var brIdx = args.indexOf("-b:a");
            var brLabel = brIdx >= 0 ? args[brIdx + 1] : "default";
            api.log("info", "Transcoding to " + fmt + " @ " + brLabel + " -> " + destPath, "youtube");
            var convResult = await api.system.exec("ffmpeg", args);
            if (convResult.exitCode === 0) {
              finalPath = destPath;
              api.log("info", "Transcode complete: " + destPath, "youtube");
            } else {
              finalPath = srcPath;
              api.log("error", "Transcode failed (exit " + convResult.exitCode + "): " + (convResult.stderr || "").trim(), "youtube");
            }
          }
        } else {
          api.log("warn", "Unknown target format: " + fmt + " — using source as-is", "youtube");
          finalPath = srcPath;
        }
      } catch (convertErr) {
        api.log("error", "Conversion error: " + (convertErr && convertErr.message ? convertErr.message : convertErr), "youtube");
        finalPath = srcPath;
      }
      api.log("info", "Download resolve -> " + finalPath, "youtube");
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

  api.ui.onAction("youtube-cache-size", async function(data) {
    var val = parseInt(data, 10);
    if (isNaN(val) || val < 0) return;
    cacheMaxMb = val;
    await api.storage.set("cacheMaxMb", val);
    renderSettings(api);
    cleanupCache(api).catch(console.error);
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
        type: "section",
        title: "Cache",
        children: [
          {
            type: "settings-row",
            label: "Cache size limit",
            description: cacheMaxMb === 0 ? "Files are deleted after playback" : cacheMaxMb + " MB",
            control: {
              type: "select",
              action: "youtube-cache-size",
              value: String(cacheMaxMb),
              options: [
                { value: "0", label: "Off (no caching)" },
                { value: "50", label: "50 MB" },
                { value: "100", label: "100 MB" },
                { value: "200", label: "200 MB" },
                { value: "500", label: "500 MB" },
                { value: "1000", label: "1 GB" }
              ]
            }
          }
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
}

return { activate: activate, deactivate: deactivate };
