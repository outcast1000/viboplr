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
  // Bumped by the host when a collection resync changes the library, so Home
  // re-fetches its content shelves (see useHome).
  libraryRevision: number;
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
  // Own hydration flag for visibility/order, separate from the app-wide
  // `restoredRef`. HomeView mounts (always-on, just display:none'd) well before
  // `restoredRef` flips — that guard can stay false for several seconds during
  // startup (e.g. the native-engine capability probe). If a user opens Customize
  // and toggles a shelf inside that window, gating the persist effects on the
  // slow global flag silently drops the edit (never retried), which reads as
  // "my shelf configuration got reset" on the next launch. This flag instead
  // reflects only this component's own (fast, local) restore read.
  const [configHydrated, setConfigHydrated] = useState(false);

  // Restore visibility + order on mount
  useEffect(() => {
    (async () => {
      try {
        const v = (await store.get<Record<string, boolean>>("homeShelfVisibility")) ?? {};
        setVisibility(v);
        const ord = await store.get<string[]>("homeShelfOrder");
        // Merge with defaults so brand-new built-ins (e.g. Radio) land in their
        // default position instead of disappearing or being tacked on the end.
        if (ord && ord.length) setShelfOrder(mergeShelfOrder(ord));
      } finally {
        setConfigHydrated(true);
      }
    })();
  }, []);

  // Persist visibility
  useEffect(() => {
    if (!configHydrated) return;
    store.set("homeShelfVisibility", visibility);
  }, [visibility, configHydrated]);

  // Persist order
  useEffect(() => {
    if (!configHydrated) return;
    store.set("homeShelfOrder", shelfOrder);
  }, [shelfOrder, configHydrated]);

  const { radioStations, shelves, refresh } = useHome({
    isVisible: props.isVisible,
    pluginShelves: props.pluginShelves,
    invokePluginShelf: props.invokePluginShelf,
    pluginsLoaded: props.pluginsLoaded,
    visibility,
    shelfOrder,
    restoredRef: props.restoredRef,
    libraryRevision: props.libraryRevision,
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
  //
  // `shelves` reflects the visibility filter as of the last refresh() — toggling
  // a shelf in Customize doesn't itself trigger a refetch (it would just re-fetch
  // data that's already in hand), so re-filter by the *current* visibility here.
  // Without this, toggling a shelf off leaves it on screen until the next
  // refresh (up to 24h later, or a manual ⟳), which reads as "Customize doesn't
  // do anything."
  const visibleShelves = shelves.filter((s) => isShelfVisible(s.id, visibility));
  const radioShelf = radioVisible && radioStations.length ? buildRadioShelf(radioStations) : null;
  const ordered = orderResolvedShelves(radioShelf ? [radioShelf, ...visibleShelves] : visibleShelves, shelfOrder);
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
