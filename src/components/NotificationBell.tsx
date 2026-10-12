import "./NotificationBell.css";

const SHORTCUT = navigator.platform.includes("Mac") ? "⌘⇧N" : "Ctrl+Shift+N";

interface Props {
  /** Items that lit the bell (an error, or an untaken action, that left the
   *  screen unhandled). Opening the list clears them. */
  unseenCount: number;
  /** Any of those is an error: the dot is red rather than accent. */
  unseenError: boolean;
  open: boolean;
  onToggle: () => void;
}

/**
 * The way into the notifications list, at the right end of the caption bar —
 * chrome every window already has, so it takes no room from the library and
 * doesn't care whether the sidebar is collapsed. Dim, with no count: a dot
 * appears only for something the user hasn't dealt with.
 */
export function NotificationBell({ unseenCount, unseenError, open, onToggle }: Props) {
  const label = unseenCount > 0 ? `Notifications, ${unseenCount} unseen` : "Notifications";
  return (
    <button
      type="button"
      className={`notification-bell${open ? " is-open" : ""}`}
      data-notification-bell
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={label}
      title={`${label} (${SHORTCUT})`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 16v-5a6 6 0 1 1 12 0v5l1.5 2h-15z" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {unseenCount > 0 && <span className={`notification-bell-dot${unseenError ? " is-error" : ""}`} aria-hidden="true" />}
    </button>
  );
}
