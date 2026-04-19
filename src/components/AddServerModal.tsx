import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AddServerModalProps {
  onAdded: () => void;
  onClose: () => void;
  initialUrl?: string;
  initialUsername?: string;
  initialPassword?: string;
}

export function AddServerModal({ onAdded, onClose, initialUrl = "", initialUsername = "", initialPassword = "" }: AddServerModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState(initialPassword);
  const [testing, setTesting] = useState(false);
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
    try {
      await invoke("add_collection", {
        kind: "subsonic",
        name: name.trim() || url.trim(),
        url: url.trim(),
        username: username.trim(),
        password: password.trim(),
      });
      onAdded();
    } catch (e) {
      alert("Failed to connect: " + e);
    }
  }

  function clearStatus() {
    setStatus(null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add Subsonic Server</h2>
        <div className="modal-field">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="My Server"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="modal-field">
          <label>Server URL</label>
          <input
            type="text"
            placeholder="https://music.example.com"
            value={url}
            onChange={(e) => { setUrl(e.target.value); clearStatus(); }}
          />
        </div>
        <div className="modal-field">
          <label>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => { setUsername(e.target.value); clearStatus(); }}
          />
        </div>
        <div className="modal-field">
          <label>Password</label>
          <input
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
          <button className="ds-btn ds-btn--ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="ds-btn ds-btn--ghost" onClick={handleTest} disabled={testing || !canTest}>
            {testing ? "Testing..." : "Test"}
          </button>
          <button className="ds-btn ds-btn--primary" onClick={handleConnect} disabled={!canTest}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
