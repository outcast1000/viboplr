import { useCallback, useEffect, useState } from "react";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface FallbackTrackDetailProps {
  name: string;
  artistName?: string;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onNavigateToArtistByName?: (name: string) => void;
  onNavigateToAlbumByName?: (name: string, artistName?: string) => void;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export function FallbackTrackDetail({
  name,
  artistName,
  invokeInfoFetch,
  pluginNames,
  onNavigateToArtistByName,
  onNavigateToAlbumByName,
  onInfoTrackContextMenu,
  onEntityContextMenu,
}: FallbackTrackDetailProps) {
  const entity: InfoEntity = { kind: "track", name, id: 0, artistName };
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("trackDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("trackDetailBelowTabOrder", order);
  }, []);

  const handleEntityClick = useCallback((kind: string, _id?: number, entityName?: string) => {
    if (kind === "artist" && entityName && onNavigateToArtistByName) {
      onNavigateToArtistByName(entityName);
    } else if (kind === "album" && entityName && onNavigateToAlbumByName) {
      onNavigateToAlbumByName(entityName, artistName);
    }
  }, [onNavigateToArtistByName, onNavigateToAlbumByName, artistName]);

  return (
    <div className="track-detail">
      <div className="track-detail-top">
        <div className="track-detail-header">
          <div className="track-detail-art">
            <svg className="track-detail-art-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <div className="track-detail-info">
            <h2>{name}</h2>
            <div className="track-detail-meta">
              {artistName && (
                <span
                  className="track-detail-link"
                  onClick={() => onNavigateToArtistByName?.(artistName)}
                  style={{ cursor: onNavigateToArtistByName ? "pointer" : undefined }}
                >{artistName}</span>
              )}
            </div>
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
