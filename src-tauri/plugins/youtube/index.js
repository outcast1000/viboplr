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
  ytDlpVersion = await api.informationTypes.invoke("yt_dlp_check", {});
  ffmpegVersion = await api.informationTypes.invoke("ffmpeg_check", {});
  await fetchLatestVersions(api);
  checking = false;
  renderSettings(api);
}

async function searchAndDownload(api, title, artistName) {
  var result = await api.informationTypes.invoke("search_youtube", {
    title: title,
    artistName: artistName || null
  });
  if (!result || !result.url) return null;

  var cached = downloadCache[result.url];
  if (cached) {
    console.log("[youtube] using cached file:", cached);
    return cached;
  }

  console.log("[youtube] downloading audio via yt-dlp...");
  var filePath = await api.informationTypes.invoke("yt_dlp_stream_audio", {
    youtubeUrl: result.url
  });
  if (!filePath) return null;

  console.log("[youtube] downloaded to:", filePath);
  downloadCache[result.url] = filePath;
  return filePath;
}

async function activate(api) {
  ytDlpVersion = await api.informationTypes.invoke("yt_dlp_check", {});
  ffmpegVersion = await api.informationTypes.invoke("ffmpeg_check", {});

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName) {
    console.log("[youtube] stream resolve called:", title, "by", artistName);
    if (!ytDlpVersion) {
      console.log("[youtube] skipping — yt-dlp not available");
      return null;
    }

    try {
      var filePath = await searchAndDownload(api, title, artistName);
      if (!filePath) return null;
      return { url: "file://" + filePath, label: "YouTube" };
    } catch (e) {
      console.error("[youtube] stream resolve failed:", e);
      return null;
    }
  });

  api.downloads.onResolve("youtube-download", async function(title, artistName, albumName, sourceTrackId, format) {
    if (!ytDlpVersion) return null;

    try {
      var webmPath = await searchAndDownload(api, title, artistName);
      if (!webmPath) return null;

      var finalPath = await api.informationTypes.invoke("ffmpeg_convert_audio", {
        sourcePath: webmPath,
        audioFormat: format || "aac"
      });

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
      console.error("[youtube] download resolve failed:", e);
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
