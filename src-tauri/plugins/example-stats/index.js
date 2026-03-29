// Example Stats Plugin for Viboplr
// Demonstrates: sidebar view, context menu action, event hooks, storage, library API

function activate(api) {
  // Track session plays
  var sessionPlays = [];

  // Load persisted total play count
  api.storage.get("totalPlays").then(function (count) {
    updateView(count || 0);
  });

  function updateView(totalPlays) {
    api.ui.setViewData("stats", {
      type: "layout",
      direction: "vertical",
      children: [
        {
          type: "stats-grid",
          items: [
            { label: "Session Plays", value: sessionPlays.length },
            { label: "Total Plays", value: totalPlays },
          ],
        },
        { type: "spacer" },
        {
          type: "text",
          content: "<h3>Recent Session Plays</h3>",
        },
        sessionPlays.length > 0
          ? {
              type: "track-list",
              tracks: sessionPlays.slice().reverse().slice(0, 20),
            }
          : {
              type: "text",
              content: "No tracks played yet this session. Start playing music!",
            },
        { type: "spacer" },
        {
          type: "button",
          label: "Load Most Played (All Time)",
          action: "load-most-played",
        },
      ],
    });
  }

  // Event: track played (scrobble threshold reached)
  api.playback.onTrackPlayed(function (track) {
    sessionPlays.push(track);
    api.storage.get("totalPlays").then(function (count) {
      var newCount = (count || 0) + 1;
      api.storage.set("totalPlays", newCount);
      updateView(newCount);
    });
  });

  // Event: track started
  api.playback.onTrackStarted(function (track) {
    console.log("[example-stats] Now playing:", track.title);
  });

  // Event: track liked
  api.playback.onTrackLiked(function (track, liked) {
    console.log("[example-stats] Track " + (liked ? "liked" : "unliked") + ":", track.title);
  });

  // UI action: load most played
  api.ui.onAction("load-most-played", function () {
    api.library.getMostPlayed({ limit: 20 }).then(function (mostPlayed) {
      api.storage.get("totalPlays").then(function (totalPlays) {
        api.ui.setViewData("stats", {
          type: "layout",
          direction: "vertical",
          children: [
            {
              type: "stats-grid",
              items: [
                { label: "Session Plays", value: sessionPlays.length },
                { label: "Total Plays", value: totalPlays || 0 },
              ],
            },
            { type: "spacer" },
            {
              type: "text",
              content: "<h3>Most Played Tracks (All Time)</h3>",
            },
            {
              type: "card-grid",
              items: mostPlayed.map(function (entry) {
                return {
                  id: String(entry.history_track_id),
                  title: entry.display_title,
                  subtitle:
                    (entry.display_artist || "Unknown") +
                    " \u2022 " +
                    entry.play_count +
                    " plays",
                };
              }),
            },
            { type: "spacer" },
            {
              type: "button",
              label: "Back to Session Stats",
              action: "back-to-session",
            },
          ],
        });
      });
    });
  });

  // UI action: back to session view
  api.ui.onAction("back-to-session", function () {
    api.storage.get("totalPlays").then(function (count) {
      updateView(count || 0);
    });
  });

  // Context menu action: show artist stats
  api.contextMenu.onAction("show-artist-stats", function (target) {
    if (target.artistName) {
      api.library
        .getTracks({ artistId: target.artistId, limit: 50 })
        .then(function (tracks) {
          api.ui.setViewData("stats", {
            type: "layout",
            direction: "vertical",
            children: [
              {
                type: "text",
                content:
                  "<h3>Tracks by " + target.artistName + "</h3>" +
                  "<p>" + tracks.length + " tracks in library</p>",
              },
              { type: "track-list", tracks: tracks },
              { type: "spacer" },
              {
                type: "button",
                label: "Back to Session Stats",
                action: "back-to-session",
              },
            ],
          });
        });
    }
  });
}

function deactivate() {
  console.log("[example-stats] Plugin deactivated");
}

return { activate: activate, deactivate: deactivate };
