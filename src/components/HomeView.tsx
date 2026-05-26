import { useEffect, useState } from "react";
import type { Track, QueueTrack } from "../types";
import type { HomeShelfItem, HomeShelfResult, HomeShelfDisplayKind } from "../types/plugin";
import type { ResolvedShelf } from "../hooks/useHome";
import { useHome, shelfKey } from "../hooks/useHome";
import { useImageCache } from "../hooks/useImageCache";
import { HomeHero } from "./HomeHero";
import { HomeShelf } from "./HomeShelf";
import { HomeShelvesPopover } from "./HomeShelvesPopover";
import { store } from "../store";
import "./HomeView.css";

export interface HomeViewProps {
  style?: React.CSSProperties;
  isVisible: boolean;
  currentTrack: QueueTrack | null;
  pluginShelves: Array<{
    pluginId: string;
    shelfId: string;
    title: string;
    displayKind: HomeShelfDisplayKind;
    limit: number;
  }>;
  invokePluginShelf: (pluginId: string, shelfId: string, limit: number) => Promise<HomeShelfResult>;
  restoredRef: React.RefObject<boolean>;
  onPlayTrack: (track: Track) => void;
  onEnqueueTrack: (track: Track) => void;
  onTrackContextMenu: (track: Track, e: React.MouseEvent) => void;
  onShelfItemClick: (shelf: ResolvedShelf, item: HomeShelfItem) => void;
  onShelfItemContextMenu: (shelf: ResolvedShelf, item: HomeShelfItem, e: React.MouseEvent) => void;
}

export function HomeView(props: HomeViewProps) {
  const albumImages = useImageCache("album");
  const artistImages = useImageCache("artist");

  const [visibility, setVisibility] = useState<Record<string, boolean>>({});
  const [popoverOpen, setPopoverOpen] = useState(false);

  // Restore visibility on mount
  useEffect(() => {
    (async () => {
      const v = (await store.get<Record<string, boolean>>("homeShelfVisibility")) ?? {};
      setVisibility(v);
    })();
  }, []);

  // Persist
  useEffect(() => {
    if (!props.restoredRef.current) return;
    store.set("homeShelfVisibility", visibility);
  }, [visibility, props.restoredRef]);

  const { featured, shelves, refresh } = useHome({
    isVisible: props.isVisible,
    currentTrack: props.currentTrack,
    pluginShelves: props.pluginShelves,
    invokePluginShelf: props.invokePluginShelf,
    visibility,
    restoredRef: props.restoredRef,
  });

  const allShelfDescriptors = [
    { id: "builtin:recently-played", title: "Recently played" },
    { id: "builtin:most-played-30d", title: "Most played · 30 days" },
    { id: "builtin:most-played-artists-30d", title: "Most played artists · 30 days" },
    { id: "builtin:recently-added", title: "Recently added" },
    { id: "builtin:liked-albums", title: "Liked albums" },
    { id: "builtin:liked-artists", title: "Liked artists" },
    { id: "builtin:radio-stations", title: "Radio stations" },
    { id: "builtin:jump-back-in", title: "Jump back in" },
    ...props.pluginShelves.map(p => ({ id: shelfKey(p.pluginId, p.shelfId), title: p.title })),
  ];

  return (
    <div className="home-view" style={props.style}>
      <div className="home-view-header">
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={refresh} title="Refresh">⟳ Refresh</button>
        <button className="ds-btn ds-btn--ghost ds-btn--sm" onClick={() => setPopoverOpen(true)} title="Shelves">⚙ Shelves</button>
      </div>

      <HomeHero
        tracks={featured}
        albumImageFor={(name, artistName) => albumImages.getImage(name, artistName ?? null)}
        onPlay={props.onPlayTrack}
        onEnqueue={props.onEnqueueTrack}
        onContextMenu={props.onTrackContextMenu}
      />

      {shelves.map((shelf) => (
        <HomeShelf
          key={shelf.id}
          shelf={shelf}
          albumImageFor={(name, artistName) => albumImages.getImage(name, artistName ?? null)}
          artistImageFor={(name) => artistImages.getImage(name)}
          onItemClick={props.onShelfItemClick}
          onItemContextMenu={props.onShelfItemContextMenu}
        />
      ))}

      {popoverOpen && (
        <HomeShelvesPopover
          shelves={allShelfDescriptors}
          visibility={visibility}
          onChange={(id, v) => setVisibility((prev) => ({ ...prev, [id]: v }))}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  );
}
