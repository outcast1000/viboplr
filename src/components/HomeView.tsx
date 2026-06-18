import { useEffect, useState } from "react";
import type { HomeShelfItem, HomeShelfResult, HomeShelfDisplayKind } from "../types/plugin";
import type { ResolvedShelf } from "../hooks/useHome";
import {
  useHome,
  DEFAULT_SHELF_ORDER,
  RADIO_SHELF_ID,
  buildRadioShelf,
  mergeShelfOrder,
  orderResolvedShelves,
  isShelfVisible,
} from "../hooks/useHome";
import { useImageCache } from "../hooks/useImageCache";
import { HeroCarousel } from "./HeroCarousel";
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
      // Merge with defaults so brand-new built-ins (e.g. Radio) land in their
      // default position instead of disappearing or being tacked on the end.
      if (ord && ord.length) setShelfOrder(mergeShelfOrder(ord));
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
    // Store the explicit opposite of the current effective visibility, so toggling
    // works whether the shelf was on/off by default or by a prior explicit setting.
    setVisibility((prev) => ({ ...prev, [id]: !isShelfVisible(id, prev) }));
  }

  const radioVisible = isShelfVisible(RADIO_SHELF_ID, visibility);

  function resetCustomization() {
    setShelfOrder(DEFAULT_SHELF_ORDER);
    setVisibility({});
  }

  // Radio is a shelf like any other (a playlist-cards shelf of stations). Fold it
  // in and order everything by the user's shelf order; whichever shelf lands first
  // is promoted to the hero carousel, the rest render as normal rows.
  const radioShelf = radioVisible && radioStations.length ? buildRadioShelf(radioStations) : null;
  const ordered = orderResolvedShelves(radioShelf ? [radioShelf, ...shelves] : shelves, shelfOrder);
  const [heroShelf, ...rowShelves] = ordered;

  const albumImageFor = (name: string, artistName?: string) => albumImages.getImage(name, artistName ?? null);
  const artistImageFor = (name: string) => artistImages.getImage(name);

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

      {heroShelf && (
        <HeroCarousel
          shelf={heroShelf}
          albumImageFor={albumImageFor}
          artistImageFor={artistImageFor}
          onItemClick={props.onShelfItemClick}
          onItemPlay={props.onShelfItemPlay}
        />
      )}

      {rowShelves.map((shelf) => (
        <HomeShelf
          key={shelf.id}
          shelf={shelf}
          albumImageFor={albumImageFor}
          artistImageFor={artistImageFor}
          onItemClick={props.onShelfItemClick}
          onItemContextMenu={props.onShelfItemContextMenu}
          onItemPlay={props.onShelfItemPlay}
        />
      ))}
    </div>
  );
}
