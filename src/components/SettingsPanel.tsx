import { useState } from "react";
import type { Collection } from "../types";
import { collectionKindLabel } from "../utils";

interface SettingsPanelProps {
  collections: Collection[];
  sessionLog: { time: Date; message: string }[];
  onClose: () => void;
  onAddFolder: () => void;
  onShowAddServer: () => void;
  onRemoveCollection: (id: number) => void;
  onResyncCollection: (id: number) => void;
  onSeedDatabase: () => void;
  onClearDatabase: () => void;
  clearing: boolean;
  onClearImageFailures: () => void;
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
}

export function SettingsPanel({
  collections, sessionLog,
  onClose, onAddFolder, onShowAddServer,
  onRemoveCollection, onResyncCollection,
  onSeedDatabase, onClearDatabase, clearing,
  onClearImageFailures,
  crossfadeSecs,
  onCrossfadeChange,
}: SettingsPanelProps) {
  const [settingsTab, setSettingsTab] = useState<"main" | "collections" | "logging">("main");

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="settings-close" onClick={onClose}>{"\u00D7"}</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${settingsTab === "main" ? "active" : ""}`} onClick={() => setSettingsTab("main")}>Main</button>
          <button className={`settings-tab ${settingsTab === "collections" ? "active" : ""}`} onClick={() => setSettingsTab("collections")}>Collections</button>
          <button className={`settings-tab ${settingsTab === "logging" ? "active" : ""}`} onClick={() => setSettingsTab("logging")}>Logging</button>
        </div>

        {settingsTab === "main" && (
          <div className="settings-section">
            <div className="settings-row">
              <label className="settings-label">Crossfade</label>
              <input
                type="range"
                min={0}
                max={10}
                step={0.5}
                value={crossfadeSecs}
                onChange={e => onCrossfadeChange(parseFloat(e.target.value))}
                className="settings-slider"
              />
              <span className="settings-value">{crossfadeSecs === 0 ? "Off" : `${crossfadeSecs.toFixed(1)}s`}</span>
            </div>
            <button className="add-folder-btn" onClick={onClearImageFailures}>
              Retry Failed Image Downloads
            </button>
          </div>
        )}

        {settingsTab === "collections" && (
          <div className="settings-section">
            {collections.map((c) => (
              <div key={c.id} className="collection-item">
                <span className={`collection-kind collection-kind-${c.kind}`}>
                  {collectionKindLabel(c.kind)}
                </span>
                <span className="collection-name" title={c.path || c.url || c.name}>
                  {c.name}
                </span>
                <button
                  className="collection-action collection-resync"
                  onClick={() => onResyncCollection(c.id)}
                  title="Resync"
                >
                  {"\u21BB"}
                </button>
                <button
                  className="collection-action collection-remove"
                  onClick={() => onRemoveCollection(c.id)}
                  title="Remove"
                >
                  {"\u00D7"}
                </button>
              </div>
            ))}
            <button className="add-folder-btn" onClick={onAddFolder}>
              + Add Folder
            </button>
            <button className="add-folder-btn" onClick={onShowAddServer}>
              + Add Server
            </button>
            {import.meta.env.DEV && (
              <button className="add-folder-btn" onClick={onSeedDatabase}>
                Seed Test Data
              </button>
            )}
            {import.meta.env.DEV && (
              <button className="add-folder-btn" onClick={onClearDatabase} disabled={clearing}>
                {clearing ? "Clearing..." : "Clear Database"}
              </button>
            )}
          </div>
        )}

        {settingsTab === "logging" && (
          <div className="settings-section">
            <div className="session-log">
              {sessionLog.length === 0 && <div className="log-empty">No events yet</div>}
              {[...sessionLog].reverse().map((entry, i) => (
                <div key={i} className="log-entry">
                  <span className="log-time">{entry.time.toLocaleTimeString()}</span>
                  <span className="log-message">{entry.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
