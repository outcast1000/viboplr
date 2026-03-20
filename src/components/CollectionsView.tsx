import type { Collection } from "../types";
import { collectionKindLabel } from "../utils";

function formatSyncDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = Math.round(secs % 60);
  return `${mins}m ${remainSecs}s`;
}

function formatTimeAgo(ts: number): string {
  const diffSecs = Math.floor(Date.now() / 1000) - ts;
  if (diffSecs < 60) return "just now";
  if (diffSecs < 3600) return `${Math.floor(diffSecs / 60)}m ago`;
  if (diffSecs < 86400) return `${Math.floor(diffSecs / 3600)}h ago`;
  return `${Math.floor(diffSecs / 86400)}d ago`;
}

function getConnectionStatus(c: Collection): "connected" | "error" | "unknown" | null {
  if (c.kind !== "subsonic" && c.kind !== "tidal") return null;
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
  onAddFolder: () => void;
  onShowAddServer: () => void;
  onShowAddTidal: () => void;
}

export function CollectionsView({
  collections,
  onToggleEnabled,
  onCheckConnection,
  onResync,
  checkingConnectionId,
  connectionResult,
  onAddFolder,
  onShowAddServer,
  onShowAddTidal,
}: CollectionsViewProps) {
  return (
    <div className="collections-view">
      {collections.length === 0 ? (
        <div className="collections-empty">
          <p>No collections yet. Add a folder, server, or TIDAL connection to get started.</p>
        </div>
      ) : (
        <div className="collections-grid">
          {collections.map((c) => {
            const status = getConnectionStatus(c);
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
                  {c.path && <span className="collections-view-detail" title={c.path}>{c.path}</span>}
                  {c.url && <span className="collections-view-detail">{c.url}</span>}
                  {c.last_synced_at && (
                    <span className="collections-view-detail">
                      Synced {formatTimeAgo(c.last_synced_at)}
                      {c.last_sync_duration_secs != null && <> in {formatSyncDuration(c.last_sync_duration_secs)}</>}
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
                <div className="collections-view-card-actions">
                  <button
                    className="collections-view-action-btn"
                    onClick={() => onResync(c.id)}
                    title="Resync"
                  >
                    Resync
                  </button>
                  {(c.kind === "subsonic" || c.kind === "tidal") && (
                    <button
                      className={`collections-view-action-btn ${checkingConnectionId === c.id ? "collections-view-action-checking" : ""}`}
                      onClick={() => onCheckConnection(c.id)}
                      disabled={checkingConnectionId === c.id}
                      title="Check connection"
                    >
                      {checkingConnectionId === c.id ? "Checking..." : "Check Connection"}
                    </button>
                  )}
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
        <button className="add-folder-btn" onClick={onShowAddTidal}>+ Add TIDAL</button>
      </div>
    </div>
  );
}
