// "The cached info value for this entity just changed" — so an open detail
// page or Now Playing view re-reads it. Those surfaces otherwise read the cache
// once per entity; a value written from elsewhere (a plugin's
// api.informationTypes.fetch, the control API's info.fetch) stayed invisible
// until the user navigated away and back — a lyrics import for the song that
// is playing showed nothing.
//
// In-process only (no Tauri event): every writer that announces lives in this
// webview, in `fetchInfoValue`.

type Listener = (entityKey: string, typeId: string) => void;

const listeners = new Set<Listener>();

/** Subscribe; returns the unsubscriber. */
export function onInfoValueChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitInfoValueChanged(entityKey: string, typeId: string): void {
  for (const listener of listeners) {
    try {
      listener(entityKey, typeId);
    } catch (e) {
      console.error("Info value listener failed:", e);
    }
  }
}
