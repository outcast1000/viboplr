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
    searchProviders: null,
    autoContinueEnabled: false,
    autoContinueWeights: { random: 40, sameArtist: 20, sameTag: 20, mostPlayed: 10, liked: 10 },
    showStatusBar: true,
  },
});
