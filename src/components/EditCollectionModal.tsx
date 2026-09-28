import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Collection } from "../types";
import { collectionKindLabel, formatDurationCoarse } from "../utils";
import type { SubsonicConnectionEdit } from "../hooks/useCollectionActions";

interface EditCollectionModalProps {
  collection: Collection;
  /** Rejects with a user-facing message; the modal shows it and stays open. */
  onSave: (
    id: number,
    name: string,
    autoUpdate: boolean,
    autoUpdateIntervalMins: number,
    enabled: boolean,
    connection?: SubsonicConnectionEdit,
  ) => Promise<void>;
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

const stripTrailingSlash = (s: string) => s.replace(/\/+$/, "");

export function EditCollectionModal({ collection, onSave, onClose }: EditCollectionModalProps) {
  const [name, setName] = useState(collection.name);
  const [autoUpdate, setAutoUpdate] = useState(collection.auto_update);
  const [intervalMins, setIntervalMins] = useState(collection.auto_update_interval_mins);
  const [enabled, setEnabled] = useState(collection.enabled);
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isSubsonic = collection.kind === "subsonic";
  const [url, setUrl] = useState(collection.url ?? "");
  const [username, setUsername] = useState(collection.username ?? "");
  const [password, setPassword] = useState("");
  const connectionDirty = isSubsonic && (
    stripTrailingSlash(url.trim()) !== stripTrailingSlash(collection.url ?? "")
    || username.trim() !== (collection.username ?? "")
    || password !== ""
  );

  const canTest = isSubsonic;

  async function handleTest() {
    if (!canTest) return;
    setTesting(true);
    setTestStatus(null);
    try {
      const result = await invoke<string>("test_collection_connection", {
        collectionId: collection.id,
      });
      setTestStatus(result);
    } catch (e) {
      setTestStatus(`Failed: ${e}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!name.trim() || saving) return;
    if (connectionDirty && (!url.trim() || !username.trim())) {
      setSaveError("Server URL and username are required");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(
        collection.id, name.trim(), autoUpdate, intervalMins, enabled,
        connectionDirty ? { url: url.trim(), username: username.trim(), password } : undefined,
      );
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Edit Collection</h2>

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

        {isSubsonic ? (
          <>
            <div className="modal-field">
              <label>Server URL</label>
              <input
                className="ds-input"
                type="url"
                value={url}
                placeholder="https://music.example.com"
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="modal-field">
              <label>Username</label>
              <input
                className="ds-input"
                type="text"
                value={username}
                autoComplete="off"
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="modal-field">
              <label>Password</label>
              <input
                className="ds-input"
                type="password"
                value={password}
                placeholder="Unchanged"
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </>
        ) : (
          <>
            {collection.url && (
              <div className="modal-field">
                <label>{collection.kind === "manifest" ? "Manifest URL" : "Server URL"}</label>
                <div className="modal-field-static">{collection.url}</div>
              </div>
            )}

            {collection.username && (
              <div className="modal-field">
                <label>Username</label>
                <div className="modal-field-static">{collection.username}</div>
              </div>
            )}
          </>
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
            className="ds-input"
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
              className="ds-select"
              style={{ width: "100%" }}
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
                <> ({formatDurationCoarse(collection.last_sync_duration_secs)})</>
              )}
            </div>
          </div>
        )}

        {saveError && (
          <div className="modal-status modal-status-err">{saveError}</div>
        )}
        {testStatus && !saveError && (
          <div className={`modal-status ${testStatus.startsWith("Connected") ? "modal-status-ok" : "modal-status-err"}`}>
            {testStatus}
          </div>
        )}
        <div className="ds-modal-actions">
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>Cancel</button>
          {canTest && (
            // Tests the *saved* settings. With unsaved edits, Save verifies
            // them itself — testing the old ones would only mislead.
            <button
              className="ds-btn ds-btn--ghost"
              onClick={handleTest}
              disabled={testing || connectionDirty}
              title={connectionDirty ? "Save verifies the new connection settings" : undefined}
            >
              {testing ? "Testing..." : "Test Connection"}
            </button>
          )}
          <button className="ds-btn ds-btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? (connectionDirty ? "Connecting..." : "Saving...") : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
