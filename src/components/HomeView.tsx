import { useEffect, useState } from "react";
import type { HomeShelfItem, HomeShelfResult, HomeShelfDisplayKind } from "../types/plugin";
import type { ResolvedShelf, RadioStation } from "../hooks/useHome";
import { useHome, DEFAULT_SHELF_ORDER } from "../hooks/useHome";
import { useImageCache } from "../hooks/useImageCache";
import { HomeHero } from "./HomeHero";
import { HomeShelf } from "./HomeShelf";
import { CustomizeHomeModal } from "./CustomizeHomeModal";
import { store } from "../store";
import "./HomeView.css";

export interface HomeViewProps {
  style?: React.CSSProperties;
  isVisible: boolean;
  pluginShelves: Array<{
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
  }>;
  invokePluginShelf: (pluginId: string, shelfId: string, limit: number) => Promise<HomeShelfResult>;
  pluginsLoaded: boolean;
  restoredRef: React.RefObject<boolean>;
  onPlayStation: (station: RadioStation) => void;
  onShelfItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onShelfItemContextMenu: (shelf: ResolvedShelf, item: HomeShelfItem, e: React.MouseEvent) => void;
  onShelfItemPlay: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
}

export function HomeView(props: HomeViewProps) {
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");

  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  // User-defined order of the built-in shelves; plugin shelves always follow.
  const [shelfOrder, setShelfOrder] = useState<string[]>(DEFAULT_SHELF_ORDER);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  // Restore visibility + order on mount
  useEffect(() => {
    (async () => {
      const v = (await store.get<Record<string, boolean>>("homeShelfVisibility")) ?? {};
      setVisibility(v);
      const ord = await store.get<string[]>("homeShelfOrder");
      // Append any built-in ids missing from a saved order (e.g. shelves added in
      // a later release) so they don't silently disappear.
      if (ord && ord.length) {
        const merged = [...ord, ...DEFAULT_SHELF_ORDER.filter((id) => !ord.includes(id))];
        setShelfOrder(merged);
      }
    })();
  }, []);

  // Persist visibility
  useEffect(() => {
    if (!props.restoredRef.current) return;
    store.set("homeShelfVisibility", visibility);
  }, [visibility, props.restoredRef]);

  // Persist order
  useEffect(() => {
    if (!props.restoredRef.current) return;
    store.set("homeShelfOrder", shelfOrder);
  }, [shelfOrder, props.restoredRef]);

  const { radioStations, shelves, refresh } = useHome({
    isVisible: props.isVisible,
    pluginShelves: props.pluginShelves,
    invokePluginShelf: props.invokePluginShelf,
    pluginsLoaded: props.pluginsLoaded,
    visibility,
    shelfOrder,
    restoredRef: props.restoredRef,
  });

  function toggleShelf(id: string) {
    setVisibility((prev) => ({ ...prev, [id]: prev[id] === false }));
  }

  function resetCustomization() {
    setShelfOrder(DEFAULT_SHELF_ORDER);
    setVisibility({});
  }

  return (
    <div className="home-view" style={props.style}>
      <div className="home-view-header">
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={refresh} title="Refresh">⟳ Refresh</button>
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setCustomizeOpen(true)} title="Customize">⚙ Customize</button>
      </div>

      {customizeOpen && (
        <CustomizeHomeModal
          builtInOrder={shelfOrder}
          visibility={visibility}
          onReorder={setShelfOrder}
          onToggle={toggleShelf}
          onReset={resetCustomization}
          onClose={() => setCustomizeOpen(false)}
        />
      )}

      <HomeHero
        stations={radioStations}
        onPlayStation={props.onPlayStation}
      />

      {shelves.map((shelf) => (
        <HomeShelf
          key={shelf.id}
          shelf={shelf}
          albumImageFor={(name, artistName) => albumImages.getImage(name, artistName ?? null)}
          artistImageFor={(name) => artistImages.getImage(name)}
          onItemClick={props.onShelfItemClick}
          onItemContextMenu={props.onShelfItemContextMenu}
          onItemPlay={props.onShelfItemPlay}
        />
      ))}
    </div>
  );
}
