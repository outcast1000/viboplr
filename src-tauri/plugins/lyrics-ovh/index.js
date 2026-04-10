// Lyrics.ovh Plugin for Viboplr
// Provides plain lyrics from lyrics.ovh

function activate(api) {
  var BASE_URL = "https://api.lyrics.ovh/v1/";

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var url = BASE_URL
      + encodeURIComponent(entity.artistName)
      + "/" + encodeURIComponent(entity.name);

    return api.network.fetch(url).then(function (resp) {
      if (resp.status === 404) return { status: "not_found" };
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.json().then(function (data) {
        var lyrics = data && data.lyrics;
        if (!lyrics || !lyrics.trim()) return { status: "not_found" };
        return {
          status: "ok",
          value: { text: lyrics.trim(), kind: "plain", _meta: { providerName: "Lyrics.ovh", homepageUrl: "https://lyrics.ovh" } },
        };
      });
    }).catch(function () {
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
