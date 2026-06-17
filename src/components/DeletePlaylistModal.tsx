import { ConfirmModal } from "./ConfirmModal";

interface DeletePlaylistModalProps {
  playlistName: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function DeletePlaylistModal({ playlistName, onConfirm, onClose }: DeletePlaylistModalProps) {
  return (
    <ConfirmModal
      title="Delete Playlist"
      messageClassName="delete-confirm-warning"
      message={<>Are you sure you want to delete <strong>{playlistName}</strong>? This cannot be undone.</>}
      destructive
      confirmLabel="Delete"
      onCancel={onClose}
      onConfirm={onConfirm}
    />
  );
}
