var ytDlpVersion = null;

async function activate(api) {
  ytDlpVersion = await api.informationTypes.invoke("yt_dlp_check", {});

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName) {
    console.log("[youtube] stream resolve called:", title, "by", artistName);
    if (!ytDlpVersion) {
      console.log("[youtube] skipping — yt-dlp not available");
      return null;
    }

    try {
      console.log("[youtube] searching YouTube...");
      var result = await api.informationTypes.invoke("search_youtube", {
        title: title,
        artistName: artistName || null
      });
      console.log("[youtube] search result:", result);
      if (!result || !result.url) return null;

      console.log("[youtube] downloading audio via yt-dlp...");
      var filePath = await api.informationTypes.invoke("yt_dlp_stream_audio", {
        youtubeUrl: result.url
      });
      console.log("[youtube] downloaded to:", filePath);
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
      var result = await api.informationTypes.invoke("search_youtube", {
        title: title,
        artistName: artistName || null
      });
      if (!result || !result.url) return null;

      var filePath = await api.informationTypes.invoke("yt_dlp_stream_audio", {
        youtubeUrl: result.url
      });
      if (!filePath) return null;

      return {
        url: "file://" + filePath,
        headers: null,
        metadata: {
          title: title,
          artist: artistName || undefined,
          album: albumName || undefined
        }
      };
    } catch (e) {
      console.error("YouTube download resolve failed:", e);
      return null;
    }
  });

  api.ui.onAction("youtube-check-ytdlp", async function() {
    ytDlpVersion = await api.informationTypes.invoke("yt_dlp_check", {});
    renderSettings(api);
  });

  renderSettings(api);
}

function renderSettings(api) {
  api.ui.setViewData("youtube-settings", {
    type: "layout",
    direction: "vertical",
    children: [
      {
        type: "settings-row",
        label: "yt-dlp status",
        description: ytDlpVersion
          ? "Installed (v" + ytDlpVersion + ")"
          : "Not found \u2014 install yt-dlp to enable YouTube playback and downloads",
        child: {
          type: "button",
          label: "Check again",
          actionId: "youtube-check-ytdlp"
        }
      }
    ]
  });
}

function deactivate() {
  ytDlpVersion = null;
}

return { activate: activate, deactivate: deactivate };
