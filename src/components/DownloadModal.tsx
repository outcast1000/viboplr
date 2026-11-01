import type { DownloadQualityOption } from "../types/plugin";
import type { AppStore } from "../store";
import type { DownloadModalState } from "../utils/downloadModalState";
import { SingleTrackDownload } from "./download/SingleTrackDownload";
import { MultiTrackDownload } from "./download/MultiTrackDownload";
import "./DownloadModal.css";

export type { DownloadTrack } from "./download/types";

interface DownloadModalProps {
  modal: DownloadModalState;
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  /** Stop the provider's in-flight resolve work (see `SingleTrackDownload`). */
  onCancelResolve?: () => void;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
}

export function DownloadModal({ modal, ...shared }: DownloadModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal dl-modal" onClick={(e) => e.stopPropagation()}>
        {modal.kind === "single" ? (
          <SingleTrackDownload track={modal.track} plan={modal.plan} purpose={modal.purpose} {...shared} />
        ) : (
          <MultiTrackDownload
            items={modal.items}
            providerName={modal.providerName}
            purpose={modal.purpose}
            {...shared}
          />
        )}
      </div>
    </div>
  );
}
