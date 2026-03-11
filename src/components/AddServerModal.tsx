interface AddServerModalProps {
  form: { name: string; url: string; username: string; password: string };
  onChange: (form: { name: string; url: string; username: string; password: string }) => void;
  onConnect: () => void;
  onClose: () => void;
}

export function AddServerModal({ form, onChange, onConnect, onClose }: AddServerModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add Subsonic Server</h2>
        <div className="modal-field">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="My Server"
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
          />
        </div>
        <div className="modal-field">
          <label>Server URL</label>
          <input
            type="text"
            placeholder="https://music.example.com"
            value={form.url}
            onChange={(e) => onChange({ ...form, url: e.target.value })}
          />
        </div>
        <div className="modal-field">
          <label>Username</label>
          <input
            type="text"
            value={form.username}
            onChange={(e) => onChange({ ...form, username: e.target.value })}
          />
        </div>
        <div className="modal-field">
          <label>Password</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => onChange({ ...form, password: e.target.value })}
          />
        </div>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-confirm" onClick={onConnect}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
