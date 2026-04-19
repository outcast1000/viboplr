import { useCallback, useEffect, useState } from "react";
import { getInitials } from "../utils";
import { InformationSections } from "./InformationSections";
import { TitleLineInfo } from "./TitleLineInfo";
import type { InfoEntity, InfoFetchResult } from "../types/informationTypes";
import { store } from "../store";

interface FallbackArtistDetailProps {
  name: string;
  invokeInfoFetch: (pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void) => Promise<InfoFetchResult>;
  pluginNames?: Map<string, string>;
  onNavigateToArtistByName?: (name: string) => void;
  onInfoTrackContextMenu?: (e: React.MouseEvent, trackInfo: { trackId?: number; title: string; artistName: string | null }) => void;
  onEntityContextMenu?: (e: React.MouseEvent, info: { kind: "track" | "artist" | "album"; id?: number; name: string; artistName?: string | null }) => void;
}

export function FallbackArtistDetail({
  name,
  invokeInfoFetch,
  pluginNames,
  onNavigateToArtistByName,
  onInfoTrackContextMenu,
  onEntityContextMenu,
}: FallbackArtistDetailProps) {
  const entity: InfoEntity = { kind: "artist", name, id: 0 };
  const [headerTabOrder, setHeaderTabOrder] = useState<string[]>([]);
  const [belowTabOrder, setBelowTabOrder] = useState<string[]>([]);

  useEffect(() => {
    store.get<string[]>("artistDetailHeaderTabOrder").then(saved => {
      if (saved && saved.length > 0) setHeaderTabOrder(saved);
    });
    store.get<string[]>("artistDetailBelowTabOrder").then(saved => {
      if (saved && saved.length > 0) setBelowTabOrder(saved);
    });
  }, []);

  const handleHeaderTabOrderChange = useCallback((order: string[]) => {
    setHeaderTabOrder(order);
    store.set("artistDetailHeaderTabOrder", order);
  }, []);

  const handleBelowTabOrderChange = useCallback((order: string[]) => {
    setBelowTabOrder(order);
    store.set("artistDetailBelowTabOrder", order);
  }, []);

  const handleEntityClick = useCallback((kind: string, _id?: number, entityName?: string) => {
    if (kind === "artist" && entityName && onNavigateToArtistByName) {
      onNavigateToArtistByName(entityName);
    }
  }, [onNavigateToArtistByName]);

  return (
    <div className="artist-detail">
      <div className="artist-detail-top">
        <div className="artist-header">
          <div className="artist-avatar">
            {getInitials(name)}
          </div>
          <div className="artist-header-info">
            <h2>{name}</h2>
            <span className="artist-bio-stats">
              <TitleLineInfo entity={entity} invokeInfoFetch={invokeInfoFetch} />
            </span>
          </div>
        </div>
      </div>
      <div className="section-wide">
        <InformationSections
          entity={entity}
          exclude={["artist_stats"]}
          placement="header"
          invokeInfoFetch={invokeInfoFetch}
          pluginNames={pluginNames}
          tabOrder={headerTabOrder}
          onTabOrderChange={handleHeaderTabOrderChange}
          onEntityClick={handleEntityClick}
          onTrackContextMenu={onInfoTrackContextMenu}
          onEntityContextMenu={onEntityContextMenu}
        />
      </div>
      <div className="section-wide">
        <InformationSections
          entity={entity}
          exclude={["artist_stats"]}
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
