interface ProfileSwitchOverlayProps {
  profile: string;
  /** Mini player mode: the window is a 40px bar, so render a compact single-line status. */
  mini: boolean;
}

/**
 * Blocking layer shown from switch-start until the process exits (or the
 * switch aborts). No dismiss affordance by design — the app is about to
 * relaunch. aria-live so assistive tech announces the transition before the
 * window disappears.
 */
export default function ProfileSwitchOverlay({ profile, mini }: ProfileSwitchOverlayProps) {
  return (
    <div
      className={`profile-switch-overlay${mini ? " profile-switch-overlay--mini" : ""}`}
      role="status"
      aria-live="assertive"
    >
      <span className={`ds-spinner${mini ? " ds-spinner--sm" : " ds-spinner--lg"}`} />
      <span className="profile-switch-overlay-label">Switching to {profile}…</span>
    </div>
  );
}
