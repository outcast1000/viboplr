import { useState } from "react";
import type { Collection } from "../types";
import { collectionKindLabel } from "../utils";

interface EditCollectionModalProps {
  collection: Collection;
  onSave: (id: number, name: string, autoUpdate: boolean, autoUpdateIntervalMins: number, enabled: boolean) => void;
  onClose: () => void;
}

const INTERVAL_OPTIONS = [
  { value: 15, label: "15 minutes" },
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 180, label: "3 hours" },
  { value: 360, label: "6 hours" },
  { value: 720, label: "12 hours" },
  { value: 1440, label: "24 hours" },
];

export function EditCollectionModal({ collection, onSave, onClose }: EditCollectionModalProps) {
  const [name, setName] = useState(collection.name);
  const [autoUpdate, setAutoUpdate] = useState(collection.auto_update);
  const [intervalMins, setIntervalMins] = useState(collection.auto_update_interval_mins);
  const [enabled, setEnabled] = useState(collection.enabled);

  function formatDuration(secs: number): string {
    if (secs < 60) return `${secs.toFixed(1)}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = Math.round(secs % 60);
    return `${mins}m ${remainSecs}s`;
  }

  function handleSave() {
    if (!name.trim()) return;
    onSave(collection.id, name.trim(), autoUpdate, intervalMins, enabled);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Edit Collection</h2>

        <div className="modal-field">
          <label>Type</label>
          <div className="modal-field-static">{collectionKindLabel(collection.kind)}</div>
        </div>

        {collection.path && (
          <div className="modal-field">
            <label>Path</label>
            <div className="modal-field-static modal-field-path" title={collection.path}>{collection.path}</div>
          </div>
        )}

        {collection.url && (
          <div className="modal-field">
            <label>Server URL</label>
            <div className="modal-field-static">{collection.url}</div>
          </div>
        )}

        {collection.username && (
          <div className="modal-field">
            <label>Username</label>
            <div className="modal-field-static">{collection.username}</div>
          </div>
        )}

        <div className="modal-field">
          <label className="modal-checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>

        <div className="modal-field">
          <label>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
        </div>

        <div className="modal-field">
          <label className="modal-checkbox-label">
            <input
              type="checkbox"
              checked={autoUpdate}
              onChange={(e) => setAutoUpdate(e.target.checked)}
            />
            Auto-update
          </label>
        </div>

        {autoUpdate && (
          <div className="modal-field">
            <label>Update Frequency</label>
            <select
              value={intervalMins}
              onChange={(e) => setIntervalMins(Number(e.target.value))}
              className="modal-select"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
        )}

        {collection.last_synced_at && (
          <div className="modal-field">
            <label>Last Synced</label>
            <div className="modal-field-static">
              {new Date(collection.last_synced_at * 1000).toLocaleString()}
              {collection.last_sync_duration_secs != null && (
                <> ({formatDuration(collection.last_sync_duration_secs)})</>
              )}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="modal-btn modal-btn-confirm" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
