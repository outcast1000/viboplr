function activate(api) {
  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function loadRandom() {
    api.library.getTracks({ limit: 100 }).then(function (tracks) {
      var picked = shuffle(tracks).slice(0, 10);
      api.ui.setViewData("random", {
        type: "layout",
        direction: "vertical",
        children: [
          { type: "track-list", tracks: picked, title: "10 Random Tracks" },
          { type: "spacer" },
          { type: "button", label: "Shuffle again", action: "reshuffle" },
        ],
      });
    });
  }

  api.ui.onAction("reshuffle", loadRandom);
  loadRandom();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
