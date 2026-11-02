import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { NotificationItem } from "../hooks/useToasts";
import { relativeTime } from "../utils/assistantActivity";
import { NoticeIcon } from "./NoticeIcon";
import "./NotificationBell.css";

/** Newest first, split at local midnight: "Today", then "Earlier". The list
 *  is memory-only and capped, so two groups are all it ever needs. */
export function groupByDay(items: NotificationItem[], now: number): { label: string; items: NotificationItem[] }[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = items.filter((i) => i.at >= midnight.getTime());
  const earlier = items.filter((i) => i.at < midnight.getTime());
  return [
    ...(today.length ? [{ label: "Today", items: today }] : []),
    ...(earlier.length ? [{ label: "Earlier", items: earlier }] : []),
  ];
}

interface Props {
  items: NotificationItem[];
  /** Ids that were unseen when the list opened — marked with a dot this once. */
  freshIds: ReadonlySet<number>;
  onClose: () => void;
  onAction: (id: number) => void;
  onRemove: (id: number) => void;
  onClearAll: () => void;
}

/**
 * The notifications list, dropped from the caption bar's bell. Newest first,
 * grouped Today / Earlier, one list — nothing has to be cleared row by row (opening it is what clears
 * the bell), an action keeps its button until it has run, and Clear all
 * empties it. An informational panel rather than a menu, so it is a React
 * popover like `EqPopover`; any ⋯ action it gains must be a native menu.
 *
 * `position: fixed` under the bell at the app root, so no stacking context in
 * the caption bar can cap it.
 */
export function NotificationsPanel({ items, freshIds, onClose, onAction, onRemove, onClearAll }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useLayoutEffect(() => {
    const place = () => {
      const bell = document.querySelector<HTMLElement>("[data-notification-bell]");
      if (!bell) return setAnchor({ top: 48, right: 10 });
      const r = bell.getBoundingClientRect();
      setAnchor({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, []);

  // "12s ago" labels, only while the list is open.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (ref.current?.contains(target) || target?.closest?.("[data-notification-bell]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="notifications-panel"
      role="dialog"
      aria-label="Notifications"
      style={anchor ? { top: anchor.top, right: anchor.right } : { visibility: "hidden" }}
    >
      <div className="notifications-head">
        <span className="notifications-title">Notifications</span>
        {items.length > 0 && (
          <button type="button" className="notifications-link" onClick={onClearAll}>
            Clear all
          </button>
        )}
        <button type="button" className="toast-close" onClick={onClose} aria-label="Close">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {items.length === 0 ? (
        <div className="notifications-empty">No notifications. Anything Vibo, a plugin or the assistant tells you ends up here.</div>
      ) : (
        <ul className="notifications-list">
          {groupByDay(items, now).map((group) => (
            <li key={group.label} className="notifications-group">
              <div className="notifications-group-label">{group.label}</div>
              <ul className="notifications-group-rows">
                {group.items.map((item) => {
                  const fresh = freshIds.has(item.id);
                  return (
                    <li key={item.id} className={`notifications-row notice-tone--${item.kind}${fresh ? " is-fresh" : ""}`}>
                      <NoticeIcon kind={item.kind} />
                      <div className="notifications-main">
                        <div className="notifications-message">
                          {item.message}
                          {item.count > 1 && <span className="toast-count">×{item.count}</span>}
                        </div>
                        <div className="notifications-meta">
                          {item.source && <span className="notifications-source">{item.source}</span>}
                          {item.source ? " · " : ""}
                          {relativeTime(item.at, now)}
                        </div>
                        {item.action && (
                          <div className="toast-actions">
                            <button type="button" className="ds-btn ds-btn--secondary ds-btn--sm" onClick={() => onAction(item.id)}>
                              {item.action.label}
                            </button>
                          </div>
                        )}
                      </div>
                      <span className="notifications-end">
                        {fresh && <span className="notifications-unread" aria-label="New" />}
                        <button type="button" className="toast-close" onClick={() => onRemove(item.id)} aria-label="Remove">
                          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                          </svg>
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
