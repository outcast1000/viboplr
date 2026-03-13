import { LazyStore } from "@tauri-apps/plugin-store";

export const store = new LazyStore("app-state.json", {
  autoSave: 500,
  defaults: {
    view: "all",
    searchQuery: "",
    selectedArtist: null,
    selectedAlbum: null,
    selectedTag: null,
    currentTrackId: null,
    volume: 1.0,
    queueTrackIds: [],
    queueIndex: -1,
    queueMode: "normal",
    positionSecs: 0,
    crossfadeSecs: 3,
    windowWidth: null,
    windowHeight: null,
    windowX: null,
    windowY: null,
  },
});
