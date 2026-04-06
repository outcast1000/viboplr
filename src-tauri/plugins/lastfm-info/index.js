function activate(api) {
  api.informationTypes.onFetch("artist_bio", async (entity) => {
    if (entity.kind !== "artist") return { status: "not_found" };

    try {
      const data = await api.informationTypes.invoke("lastfm_get_artist_info_sync", {
        artistName: entity.name,
      });

      if (!data || !data.artist || !data.artist.bio || !data.artist.bio.summary) {
        return { status: "not_found" };
      }

      return {
        status: "ok",
        value: {
          summary: data.artist.bio.summary || "",
          full: data.artist.bio.content || undefined,
        },
      };
    } catch (e) {
      return { status: "error" };
    }
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
