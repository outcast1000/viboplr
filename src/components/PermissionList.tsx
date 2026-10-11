import { describePermission } from "../pluginWorker/permissions";

// The plain-language list of what a worker plugin may do. One rendering for
// every place the user is asked or reminded: the plugin's detail pane, the
// install dialog's last step, and the prompt after an update that asks for
// more. The list IS the consent, so all three must show the same words.
//
// `reasons` is the plugin author's own "why" per permission (manifest
// `permissionReasons`, cleaned by `permissionReasons()`), shown under the
// host's description. The host's words stay first: they say what the grant
// allows, which an author's sentence must not be able to soften.
export function PermissionList({
  requested,
  pending,
  markNew = false,
  reasons,
}: {
  requested: readonly string[];
  /** Permissions not yet approved (highlighted). */
  pending?: ReadonlySet<string>;
  /** Badge the pending ones "new" — for an update that asks for more. */
  markNew?: boolean;
  /** Why the plugin needs each permission, in its author's words. */
  reasons?: Readonly<Record<string, string>>;
}) {
  return (
    <ul className="ext-perms-list">
      {requested.map((perm) => {
        const d = describePermission(perm);
        const isPending = pending?.has(perm) ?? false;
        const reason = reasons?.[perm];
        return (
          <li key={perm} className={`ext-perms-item${isPending ? " is-pending" : ""}`}>
            <div className="ext-perms-label">
              {d.label}
              {d.sensitive && <span className="ext-badge ext-badge--attention">sensitive</span>}
              {markNew && isPending && <span className="ext-badge ext-badge--update">new</span>}
            </div>
            <div className="ext-perms-detail">{d.detail}</div>
            {reason && <div className="ext-perms-reason">Why: {reason}</div>}
          </li>
        );
      })}
    </ul>
  );
}
