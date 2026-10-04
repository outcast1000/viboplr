// The host's Replace dialog for `api.library.replaceTrackFile`: a plugin found
// a better copy of a library track, and nothing changes on disk until the user
// says so here. Presentational — App.tsx stages the file, opens this, and runs
// the swap on Replace.
import { ConfirmModal } from "./ConfirmModal";
import { describeQuality, lengthWarning, type StagedReplacement } from "../utils/replaceTrackFile";

interface Props {
  staged: StagedReplacement;
  /** The plugin offering the copy, by its manifest name. */
  pluginName: string;
  /** Where the copy came from, as the plugin put it ("user123 on Soulseek"). */
  source?: string | null;
  /** The plugin's own one-line note on the copy. */
  note?: string | null;
  /** The track is playing: it will be swapped and resume where it is. */
  playing: boolean;
  trashLabel: string;
  onReplace: () => void;
  onKeep: () => void;
}

export function ReplaceTrackFileModal({ staged, pluginName, source, note, playing, trashLabel, onReplace, onKeep }: Props) {
  const by = staged.artistName ? ` by ${staged.artistName}` : "";
  const warning = lengthWarning(staged.current, staged.replacement);
  return (
    <ConfirmModal
      title={`Replace “${staged.title}”?`}
      message={<>{pluginName} found a better copy{by}{source ? <> from {source}</> : null}.</>}
      confirmLabel="Replace"
      cancelLabel="Keep current"
      autoFocusConfirm
      onConfirm={onReplace}
      onCancel={onKeep}
    >
      <dl className="replace-file-compare">
        <dt>Now</dt>
        <dd>{describeQuality(staged.current)}</dd>
        <dt>New</dt>
        <dd className="replace-file-compare__new">{describeQuality(staged.replacement)}</dd>
      </dl>
      {note && <p className="replace-file-note">{note}</p>}
      {warning && <p className="replace-file-warning">{warning}</p>}
      <p className="replace-file-note">
        The old file goes to {trashLabel}. Likes, playlists and play history stay with the track.
        {playing && " It's playing now, so it will carry on from the same spot in the new file."}
      </p>
    </ConfirmModal>
  );
}
