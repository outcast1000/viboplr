import type { Collection, CollectionStats } from "../types";
import type { ResyncProgress, ResyncComplete } from "../hooks/useEventListeners";
import { collectionKindLabel, formatDurationCoarse, formatFileSize, formatRelativeTime } from "../utils";
import "./CollectionsView.css";

function formatResyncStats(added: number, removed: number): string {
  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (removed > 0) parts.push(`${removed} removed`);
  return parts.length > 0 ? parts.join(", ") : "no changes";
}

function getConnectionStatus(c: Collection): "connected" | "error" | "unknown" | null {
  if (c.kind !== "subsonic") return null;
  if (c.last_sync_error) return "error";
  if (c.last_synced_at !== null) return "connected";
  return "unknown";
}

interface CollectionsViewProps {
  collections: Collection[];
  onToggleEnabled: (collection: Collection) => void;
  onCheckConnection: (collectionId: number) => void;
  onResync: (collectionId: number) => void;
  checkingConnectionId: number | null;
  connectionResult: { collectionId: number; ok: boolean; message: string } | null;
  resyncProgress: ResyncProgress | null;
  resyncComplete: ResyncComplete | null;
  onEdit: (collection: Collection) => void;
  onRemove: (collection: Collection) => void;
  onAddFolder: () => void;
  onShowAddServer: () => void;
  onAddMusicSource: () => void;
  onPublish: (collection: Collection) => void;
  onOpenFolder: (path: string) => void;
  onOpenUrl: (url: string) => void;
  statsMap: Map<number, CollectionStats>;
}

export function CollectionsView({
  collections,
  onToggleEnabled,
  onCheckConnection,
  onResync,
  checkingConnectionId,
  connectionResult,
  resyncProgress,
  resyncComplete,
  onEdit,
  onRemove,
  onAddFolder,
  onShowAddServer,
  onAddMusicSource,
  onPublish,
  onOpenFolder,
  onOpenUrl,
  statsMap,
}: CollectionsViewProps) {
  return (
    <div className="collections-view">
      {collections.length === 0 ? (
        <div className="collections-empty">
          <p>No collections yet. Add a folder or server to get started.</p>
        </div>
      ) : (
        <div className="collections-grid">
          {collections.map((c) => {
            const status = getConnectionStatus(c);
            const stats = statsMap.get(c.id);
            return (
              <div key={c.id} className={`collections-view-card${!c.enabled ? " collections-view-card-disabled" : ""}`}>
                <div className="collections-view-card-header">
                  <button
                    className={`collection-enable-toggle ${c.enabled ? "collection-enable-toggle-on" : ""}`}
                    onClick={() => onToggleEnabled(c)}
                    title={c.enabled ? "Disable" : "Enable"}
                  >
                    {c.enabled ? "On" : "Off"}
                  </button>
                  <span className={`collection-kind collection-kind-${c.kind}`}>
                    {collectionKindLabel(c.kind)}
                  </span>
                  <span className="collections-view-card-name" title={c.path || c.url || c.name}>
                    {c.name}
                  </span>
                  {status && (
                    <span
                      className={`collections-view-status collections-view-status-${status}`}
                      title={c.last_sync_error ? `Error: ${c.last_sync_error}` : status === "connected" ? "Connected" : "Unknown"}
                    />
                  )}
                </div>
                <div className="collections-view-card-details">
                  {stats && stats.track_count > 0 && (
                    <span className="collections-view-detail">
                      {stats.track_count.toLocaleString()} tracks{stats.video_count > 0 && ` (${stats.video_count} video${stats.video_count !== 1 ? "s" : ""})`}
                      {" · "}{formatFileSize(stats.total_size)}
                      {" · "}{formatDurationCoarse(stats.total_duration)}
                    </span>
                  )}
                  {c.path && <span className="collections-view-detail" title={c.path}>{c.path}</span>}
                  {c.url && <span className="collections-view-detail">{c.url}</span>}
                  {c.last_synced_at && (
                    <span className="collections-view-detail">
                      Synced {formatRelativeTime(c.last_synced_at)}
                      {c.last_sync_duration_secs != null && <> in {formatDurationCoarse(c.last_sync_duration_secs)}</>}
                    </span>
                  )}
                  {c.last_sync_error && (
                    <span className="collections-view-detail collections-view-detail-error" title={c.last_sync_error}>
                      Error: {c.last_sync_error}
                    </span>
                  )}
                  {c.auto_update && (
                    <span className="collections-view-detail">Auto-update every {c.auto_update_interval_mins < 60 ? `${c.auto_update_interval_mins}m` : `${c.auto_update_interval_mins / 60}h`}</span>
                  )}
                </div>
                {(resyncProgress?.collectionId === c.id || resyncComplete?.collectionId === c.id) && (
                  <div className="collection-resync-status">
                    <div className={`collection-progress-bar-track${resyncComplete?.error ? " collection-progress-error" : resyncComplete ? " collection-progress-done" : ""}`}>
                      <div
                        className={`collection-progress-bar-fill${resyncProgress && resyncProgress.total === 0 ? " collection-progress-indeterminate" : ""}`}
                        style={{ width: resyncComplete ? "100%" : resyncProgress && resyncProgress.total > 0 ? `${Math.round((resyncProgress.scanned / resyncProgress.total) * 100)}%` : undefined }}
                      />
                    </div>
                    <span className="collection-progress-text">
                      {resyncComplete?.error
                        ? <span title={resyncComplete.error}>Error: {resyncComplete.error}</span>
                        : resyncComplete
                        ? `Complete — ${formatResyncStats(resyncComplete.newTracks, resyncComplete.removedTracks)}`
                        : resyncProgress && resyncProgress.total > 0
                        ? `${resyncProgress.kind === "scan" ? "Scanning" : "Syncing"}... ${resyncProgress.scanned}/${resyncProgress.total} ${resyncProgress.kind === "scan" ? "files" : "albums"}`
                        : `Preparing ${resyncProgress?.kind === "scan" ? "scan" : "sync"}...`}
                    </span>
                  </div>
                )}
                <div className="collections-view-card-actions">
                  {c.kind === "local" && c.path && (
                    <button
                      className="collections-view-action-btn"
                      onClick={() => onOpenFolder(c.path!)}
                      title="Open folder in file manager"
                    >
                      Open Folder
                    </button>
                  )}
                  {c.kind === "local" && (
                    <button
                      className="collections-view-action-btn"
                      onClick={() => onPublish(c)}
                      title="Publish as a shareable music source"
                    >
                      Publish
                    </button>
                  )}
                  {c.kind === "subsonic" && c.url && (
                    <button
                      className="collections-view-action-btn"
                      onClick={() => onOpenUrl(c.url!)}
                      title="Open server in browser"
                    >
                      Go to Server
                    </button>
                  )}
                  {(c.kind === "local" || c.kind === "subsonic" || c.kind === "manifest") && (
                    <button
                      className={`collections-view-action-btn ${resyncProgress?.collectionId === c.id || resyncComplete?.collectionId === c.id ? "collections-view-action-checking" : ""}`}
                      onClick={() => onResync(c.id)}
                      disabled={resyncProgress != null || (resyncComplete != null && !resyncComplete.error)}
                      title="Resync"
                    >
                      {resyncProgress?.collectionId === c.id ? "Resyncing..." : "Resync"}
                    </button>
                  )}
                  {c.kind === "subsonic" && (
                    <button
                      className={`collections-view-action-btn ${checkingConnectionId === c.id ? "collections-view-action-checking" : ""}`}
                      onClick={() => onCheckConnection(c.id)}
                      disabled={checkingConnectionId === c.id}
                      title="Check connection"
                    >
                      {checkingConnectionId === c.id ? "Checking..." : "Check Connection"}
                    </button>
                  )}
                  <button
                    className="collections-view-action-btn"
                    onClick={() => onEdit(c)}
                    title="Edit"
                  >
                    Edit
                  </button>
                  <button
                    className="collections-view-action-btn collections-view-action-btn-danger"
                    onClick={() => onRemove(c)}
                    title="Remove"
                  >
                    Remove
                  </button>
                </div>
                {connectionResult && connectionResult.collectionId === c.id && (
                  <div className={`collections-view-feedback ${connectionResult.ok ? "collections-view-feedback-ok" : "collections-view-feedback-err"}`}>
                    {connectionResult.message}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="collections-view-add-buttons">
        <button className="add-folder-btn" onClick={onAddFolder}>+ Add Folder</button>
        <button className="add-folder-btn" onClick={onShowAddServer}>+ Add Server</button>
        <button className="add-folder-btn" onClick={onAddMusicSource}>+ Add Music Source</button>
      </div>
    </div>
  );
}
