import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AddTidalModalProps {
  onAdded: () => void;
  onClose: () => void;
}

export function AddTidalModal({ onAdded, onClose }: AddTidalModalProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function handleTest() {
    if (!url.trim()) return;
    setTesting(true);
    setStatus(null);
    try {
      console.log("Testing TIDAL connection:", url.trim());
      const version = await invoke<string>("tidal_test_connection", { url: url.trim() });
      console.log("TIDAL test success:", version);
      setStatus(`Connected (API v${version})`);
    } catch (e) {
      console.error("TIDAL test failed:", e);
      setStatus(`Failed: ${e}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    if (!url.trim()) return;
    try {
      await invoke("add_collection", {
        kind: "tidal",
        name: name.trim() || "TIDAL",
        url: url.trim(),
      });
      onAdded();
    } catch (e) {
      alert("Failed to add TIDAL instance: " + e);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add TIDAL Instance</h2>
        <div className="modal-field">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="TIDAL"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="modal-field">
          <label>API URL</label>
          <input
            type="text"
            placeholder="https://monochrome-api.samidy.com"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setStatus(null); }}
          />
        </div>
        {status && (
          <div className={`modal-status ${status.startsWith("Connected") ? "modal-status-ok" : "modal-status-err"}`}>
            {status}
          </div>
        )}
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-cancel" onClick={handleTest} disabled={testing || !url.trim()}>
            {testing ? "Testing..." : "Test"}
          </button>
          <button className="modal-btn modal-btn-confirm" onClick={handleConnect} disabled={!url.trim()}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
