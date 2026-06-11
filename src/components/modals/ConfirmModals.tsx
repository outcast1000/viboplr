// Presentational modal leaf components extracted from App.tsx.
// These render only — all state and side-effecting logic stay in App.tsx and
// are passed in as primitive props + callbacks, so the components are decoupled
// from the app's hooks.

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
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">
          {network ? `Permanently delete ${title}?` : `Move ${title} to ${trashLabel}?`}
        </h2>
        {network ? (
          <p className="delete-confirm-warning">
            {plural ? "These files are" : "This file is"} on a network share, which has no {trashLabel}.
            {plural ? " They" : " It"} will be <strong>permanently deleted</strong> and removed from your library. This cannot be undone.
          </p>
        ) : (
          <p className="delete-confirm-warning">This will move the file{plural ? "s" : ""} to {trashLabel} and remove from library.</p>
        )}
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="ds-btn ds-btn--danger" onClick={onConfirm} autoFocus>
            {network ? "Delete permanently" : `Move to ${trashLabel}`}
          </button>
        </div>
      </div>
    </div>
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
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">
          {tagCount === 1 ? `Delete tag "${firstTagName}"?` : `Delete ${tagCount} tags?`}
        </h2>
        <p className="delete-confirm-warning">
          {tagCount === 1
            ? "This will remove the tag from all tracks. The tracks themselves will not be deleted."
            : "This will remove these tags from all tracks. The tracks themselves will not be deleted."}
        </p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="ds-btn ds-btn--danger" onClick={onConfirm} autoFocus>Delete</button>
        </div>
      </div>
    </div>
  );
}

interface DeleteErrorModalProps {
  message: string;
  failures: { title: string; reason: string }[];
  onDismiss: () => void;
}

export function DeleteErrorModal({ message, failures, onDismiss }: DeleteErrorModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Delete Failed</h2>
        <p className="delete-confirm-warning">{message}</p>
        <ul className="delete-failure-list">
          {failures.map((f, i) => (
            <li key={i}>
              <span className="delete-failure-title">{f.title}</span>
              <span className="delete-failure-reason">{f.reason}</span>
            </li>
          ))}
        </ul>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onDismiss}>OK</button>
        </div>
      </div>
    </div>
  );
}

interface FolderErrorModalProps {
  message: string;
  onDismiss: () => void;
}

export function FolderErrorModal({ message, onDismiss }: FolderErrorModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Open Containing Folder</h2>
        <p className="delete-confirm-warning">{message}</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onDismiss}>OK</button>
        </div>
      </div>
    </div>
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
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Remove &ldquo;{name}&rdquo;?</h2>
        <p className="delete-confirm-warning">This will permanently remove this collection and all its tracks from the library.</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onCancel}>Cancel</button>
          <button className="ds-btn ds-btn--danger" onClick={onConfirm}>Remove</button>
        </div>
      </div>
    </div>
  );
}

interface NavErrorModalProps {
  message: string;
  onDismiss: () => void;
}

export function NavErrorModal({ message, onDismiss }: NavErrorModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Navigation Error</h2>
        <p>{message}</p>
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--primary" onClick={onDismiss}>OK</button>
        </div>
      </div>
    </div>
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
