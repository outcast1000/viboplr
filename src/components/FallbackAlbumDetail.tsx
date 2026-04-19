import { useCallback, useEffect, useState } from "react";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface FallbackAlbumDetailProps {
  name: string;
  artistName?: string;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onNavigateToArtistByName?: (name: string) => void;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export function FallbackAlbumDetail({
  name,
  artistName,
  invokeInfoFetch,
  pluginNames,
  onNavigateToArtistByName,
  onInfoTrackContextMenu,
  onEntityContextMenu,
}: FallbackAlbumDetailProps) {
  const entity: InfoEntity = { kind: "album", name, id: 0, artistName };
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("albumDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("albumDetailBelowTabOrder", order);
  }, []);

  const handleEntityClick = useCallback((kind: string, _id?: number, entityName?: string) => {
    if (kind === "artist" && entityName && onNavigateToArtistByName) {
      onNavigateToArtistByName(entityName);
    }
  }, [onNavigateToArtistByName]);

  return (
    <div className="album-detail">
      <div className="album-detail-top">
        <div className="album-detail-header">
          <div className="album-detail-art">
            <svg className="album-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div className="album-detail-info">
            <h2>{name}</h2>
            {artistName && (
              <span
                className="album-detail-artist-name"
                onClick={() => onNavigateToArtistByName?.(artistName)}
                style={{ cursor: onNavigateToArtistByName ? "pointer" : undefined }}
              >{artistName}</span>
            )}
            <span className="artist-bio-stats">
              <TitleLineInfo entity={entity} invokeInfoFetch={invokeInfoFetch} />
            </span>
          </div>
        </div>
      </div>
      <div className="section-wide">
        <InformationSections
          entity={entity}
          exclude={[]}
          placement="below"
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={belowTabOrder}
          onTabOrderChange={handleBelowTabOrderChange}
          onEntityClick={handleEntityClick}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>
    </div>
  );
}
