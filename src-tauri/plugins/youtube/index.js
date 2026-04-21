var ytDlpVersion = null;

async function activate(api) {
  ytDlpVersion = await api.informationTypes.invoke("yt_dlp_check", {});

  api.playback.onStreamResolve("youtube-fallback", async function(title, artistName, albumName) {
    if (!ytDlpVersion) return null;

    try {
      var result = await api.informationTypes.invoke("search_youtube", {
        title: title,
        artistName: artistName || null
      });
      if (!result || !result.url) return null;

      var streamUrl = await api.informationTypes.invoke("yt_dlp_extract_audio_url", {
        url: result.url
      });
      if (!streamUrl) return null;

      return { url: streamUrl, label: "YouTube" };
    } catch (e) {
      console.error("YouTube stream resolve failed:", e);
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

      var streamUrl = await api.informationTypes.invoke("yt_dlp_extract_audio_url", {
        url: result.url
      });
      if (!streamUrl) return null;

      return {
        url: streamUrl,
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
