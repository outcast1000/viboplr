interface DeletePlaylistModalProps {
  playlistName: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeletePlaylistModal({ playlistName, onConfirm, onClose }: DeletePlaylistModalProps) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Delete Playlist</h2>
        <p className="delete-confirm-warning">
          Are you sure you want to delete <strong>{playlistName}</strong>? This cannot be undone.
        </p>
        <div className="modal-actions">
          <button className="modal-btn modal-btn-cancel" onClick={onClose}>
            Cancel
          </button>
          <button className="modal-btn modal-btn-danger" onClick={onConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
