import { useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { track as trackTelemetry } from "../telemetry";

interface SubsonicServerFormProps {
  onAdded: () => void;
  /** Extra buttons rendered before Test/Connect (e.g. the modal's Cancel). */
  leadingActions?: ReactNode;
  initialName?: string;
  initialUrl?: string;
  initialUsername?: string;
  initialPassword?: string;
}

/**
 * The Subsonic/Navidrome connect form (fields + test + connect), shared by
 * AddServerModal and the onboarding wizard's music-source step.
 */
export function SubsonicServerForm({
  onAdded,
  leadingActions,
  initialName = "",
  initialUrl = "",
  initialUsername = "",
  initialPassword = "",
}: SubsonicServerFormProps) {
  const [name, setName] = useState(initialName);
  const [url, setUrl] = useState(initialUrl);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState(initialPassword);
  const [testing, setTesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const canTest = url.trim() && username.trim() && password.trim();

  async function handleTest() {
    if (!canTest) return;
    setTesting(true);
    setStatus(null);
    try {
      await invoke<string>("subsonic_test_connection", {
        url: url.trim(),
        username: username.trim(),
        password: password.trim(),
      });
      setStatus("Connected successfully");
    } catch (e) {
      setStatus(`Failed: ${e}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    if (!canTest) return;
    setConnecting(true);
    try {
      await invoke("add_collection", {
        kind: "subsonic",
        name: name.trim() || url.trim(),
        url: url.trim(),
        username: username.trim(),
        password: password.trim(),
      });
      trackTelemetry("collection_added", { kind: "subsonic" });
      onAdded();
    } catch (e) {
      console.error("Failed to connect to Subsonic server:", e);
      setStatus(`Failed: ${e}`);
    } finally {
      setConnecting(false);
    }
  }

  function clearStatus() {
    setStatus(null);
  }

  return (
    <>
      <div className="modal-field">
        <label>Display Name</label>
        <input
          className="ds-input"
          type="text"
          placeholder="My Server"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="modal-field">
        <label>Server URL</label>
        <input
          className="ds-input"
          type="text"
          placeholder="https://music.example.com"
          value={url}
          onChange={(e) => { setUrl(e.target.value); clearStatus(); }}
        />
      </div>
      <div className="modal-field">
        <label>Username</label>
        <input
          className="ds-input"
          type="text"
          value={username}
          onChange={(e) => { setUsername(e.target.value); clearStatus(); }}
        />
      </div>
      <div className="modal-field">
        <label>Password</label>
        <input
          className="ds-input"
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); clearStatus(); }}
        />
      </div>
      {status && (
        <div className={`modal-status ${status.startsWith("Connected") ? "modal-status-ok" : "modal-status-err"}`}>
          {status}
        </div>
      )}
      <div className="ds-modal-actions">
        {leadingActions}
        <button className="ds-btn ds-btn--ghost" onClick={handleTest} disabled={testing || connecting || !canTest}>
          {testing ? "Testing..." : "Test"}
        </button>
        <button className="ds-btn ds-btn--primary" onClick={handleConnect} disabled={connecting || !canTest}>
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>
    </>
  );
}

interface AddServerModalProps {
  onAdded: () => void;
  onClose: () => void;
  initialName?: string;
  initialUrl?: string;
  initialUsername?: string;
  initialPassword?: string;
}

export function AddServerModal({ onAdded, onClose, ...initial }: AddServerModalProps) {
  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="ds-modal-title">Add Subsonic Server</h2>
        <SubsonicServerForm
          onAdded={onAdded}
          leadingActions={
            <button className="ds-btn ds-btn--ghost" onClick={onClose}>
              Cancel
            </button>
          }
          {...initial}
        />
      </div>
    </div>
  );
}
