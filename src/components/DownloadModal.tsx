import type { InteractiveSearchResult, DownloadResolveResult, DownloadQualityOption } from "../types/plugin";
import type { AppStore } from "../store";
import { SingleTrackDownload } from "./download/SingleTrackDownload";
import { MultiTrackDownload } from "./download/MultiTrackDownload";
import type { DownloadTrack } from "./download/types";
import "./DownloadModal.css";

export type { DownloadTrack } from "./download/types";

interface DownloadModalProps {
  tracks: DownloadTrack[];
  providerId: string;
  providerName: string;
  confirmed?: boolean;
  resolveByUri?: (uri: string, format: string) => Promise<DownloadResolveResult | null>;
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  onResolve: (matchId: string, format: string) => Promise<DownloadResolveResult>;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
}

export function DownloadModal({
  tracks,
  providerId,
  providerName,
  confirmed,
  resolveByUri,
  qualityOptions,
  collections,
  store,
  lastDest,
  onSearch,
  onResolve,
  onClose,
  onComplete,
  onPlay,
}: DownloadModalProps) {
  const isSingle = tracks.length === 1;

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal dl-modal" onClick={(e) => e.stopPropagation()}>
        {isSingle ? (
          <SingleTrackDownload
            track={tracks[0]}
            providerId={providerId}
            providerName={providerName}
            resolveByUri={resolveByUri}
            qualityOptions={qualityOptions}
            collections={collections}
            store={store}
            lastDest={lastDest}
            onSearch={onSearch}
            onResolve={onResolve}
            onClose={onClose}
            onComplete={onComplete}
            onPlay={onPlay}
          />
        ) : (
          <MultiTrackDownload
            tracks={tracks}
            providerId={providerId}
            providerName={providerName}
            confirmed={confirmed}
            qualityOptions={qualityOptions}
            collections={collections}
            store={store}
            lastDest={lastDest}
            onSearch={onSearch}
            onResolve={onResolve}
            onClose={onClose}
            onComplete={onComplete}
            onPlay={onPlay}
          />
        )}
      </div>
    </div>
  );
}
