// Named modal leaf components used by App.tsx. These are presentational only —
// all state/side-effecting logic stays in App.tsx and is passed in as primitive
// props + callbacks. Confirm-style leaves delegate to the shared ConfirmModal,
// error/dismiss leaves to AlertModal, so the `.ds-modal` shell lives in one place.
// The remaining leaves (DownloadAgain, PluginLoading, DeepLinkInstall) have shapes
// the shared shells don't cover (3 actions / spinner / small-variant + custom body)
// and stay bespoke.
import { ConfirmModal } from "../ConfirmModal";
import { AlertModal } from "../AlertModal";

interface DeleteTracksModalProps {
  title: string;
  trackCount: number;
  trashLabel: string;
  /** True when any selected track is on a network share (no Recycle Bin → permanent). */
  network?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteTracksModal({ title, trackCount, trashLabel, network, onCancel, onConfirm }: DeleteTracksModalProps) {
  const plural = trackCount > 1;
  return (
    <ConfirmModal
      title={network ? `Permanently delete ${title}?` : `Move ${title} to ${trashLabel}?`}
      messageClassName="delete-confirm-warning"
      message={network ? (
        <>{plural ? "These files are" : "This file is"} on a network share, which has no {trashLabel}.{plural ? " They" : " It"} will be <strong>permanently deleted</strong> and removed from your library. This cannot be undone.</>
      ) : (
        <>This will move the file{plural ? "s" : ""} to {trashLabel} and remove from library.</>
      )}
      destructive
      autoFocusConfirm
      confirmLabel={network ? "Delete permanently" : `Move to ${trashLabel}`}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

interface DeleteTagsModalProps {
  tagCount: number;
  firstTagName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteTagsModal({ tagCount, firstTagName, onCancel, onConfirm }: DeleteTagsModalProps) {
  return (
    <ConfirmModal
      title={tagCount === 1 ? `Delete tag "${firstTagName}"?` : `Delete ${tagCount} tags?`}
      messageClassName="delete-confirm-warning"
      message={tagCount === 1
        ? "This will remove the tag from all tracks. The tracks themselves will not be deleted."
        : "This will remove these tags from all tracks. The tracks themselves will not be deleted."}
      destructive
      autoFocusConfirm
      confirmLabel="Delete"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

interface DeleteErrorModalProps {
  message: string;
  failures: { title: string; reason: string }[];
  onDismiss: () => void;
}

export function DeleteErrorModal({ message, failures, onDismiss }: DeleteErrorModalProps) {
  return (
    <AlertModal title="Delete Failed" message={message} messageClassName="delete-confirm-warning" onDismiss={onDismiss}>
      <ul className="delete-failure-list">
        {failures.map((f, i) => (
          <li key={i}>
            <span className="delete-failure-title">{f.title}</span>
            <span className="delete-failure-reason">{f.reason}</span>
          </li>
        ))}
      </ul>
    </AlertModal>
  );
}

interface FolderErrorModalProps {
  message: string;
  onDismiss: () => void;
}

export function FolderErrorModal({ message, onDismiss }: FolderErrorModalProps) {
  return (
    <AlertModal title="Open Containing Folder" message={message} messageClassName="delete-confirm-warning" onDismiss={onDismiss} />
  );
}

interface DownloadAgainModalProps {
  localTitle: string;
  onCancel: () => void;
  onShowInFolder: () => void;
  onDownload: () => void;
}

export function DownloadAgainModal({ localTitle, onCancel, onShowInFolder, onDownload }: DownloadAgainModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Already Downloaded</h2>
        <p className="delete-confirm-warning">
          "{localTitle}" already exists in your local library. Download again?
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="ds-btn ds-btn--secondary" onClick={onShowInFolder}>Show in Folder</button>
          <button className="ds-btn ds-btn--primary" onClick={onDownload} autoFocus>Download</button>
        </div>
      </div>
    </div>
  );
}

interface RemoveCollectionModalProps {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RemoveCollectionModal({ name, onCancel, onConfirm }: RemoveCollectionModalProps) {
  return (
    <ConfirmModal
      title={`Remove “${name}”?`}
      messageClassName="delete-confirm-warning"
      message="This will permanently remove this collection and all its tracks from the library."
      destructive
      confirmLabel="Remove"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

interface NavErrorModalProps {
  message: string;
  onDismiss: () => void;
}

export function NavErrorModal({ message, onDismiss }: NavErrorModalProps) {
  return (
    <AlertModal title="Navigation Error" message={message} dismissVariant="primary" onDismiss={onDismiss} />
  );
}

interface PluginLoadingModalProps {
  message: string;
}

export function PluginLoadingModal({ message }: PluginLoadingModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="loading-card">
        <div className="loading-card-icon">
          <div className="loading-card-spinner" />
        </div>
        <div className="loading-card-text">
          <div className="loading-card-title">Loading...</div>
          <div className="loading-card-sub">{message}</div>
        </div>
      </div>
    </div>
  );
}

interface DeepLinkInstallModalProps {
  kind: "plugin" | "skin";
  url: string;
  onCancel: () => void;
  onInstall: () => void;
}

export function DeepLinkInstallModal({ kind, url, onCancel, onInstall }: DeepLinkInstallModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="ds-modal-title">Install {kind === "plugin" ? "Plugin" : "Skin"}</div>
        <p style={{ fontSize: "var(--fs-sm)", color: "var(--text-secondary)", margin: "12px 0" }}>
          Install from <strong style={{ color: "var(--text-primary)", wordBreak: "break-all" }}>{url}</strong>?
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onCancel}>Cancel</button>
          <button className="ds-btn ds-btn--primary ds-btn--sm" onClick={onInstall}>Install</button>
        </div>
      </div>
    </div>
  );
}
