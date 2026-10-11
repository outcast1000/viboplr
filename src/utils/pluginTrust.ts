// Who may run in the main realm, and on what grounds.
//
// A main-realm plugin (no `"runtime": "worker"`) can do anything the app can —
// see plugins.md → "Trust Model". Everything that can run in a worker is meant
// to move there; the main realm is kept for first-party plugins that can't
// (today only vinyl-deck: a visualizer needs a live ShadowRoot), and their
// releases are signed. `plugin_signing.rs` checks the signature and reports
// `signature` on each listed plugin; this decides what that means.
//
// The rollout is phased (owner decision, 2026-10-03): while the gallery's other
// plugins are moving to the worker runtime, an unsigned main-realm plugin still
// runs but is labelled "Unverified". Flipping ENFORCE_SIGNED_MAIN_REALM refuses
// it instead. A signature that is present but doesn't verify is refused even
// now — that is a plugin whose files changed after Vibo signed them.

/** What `plugin_list_installed` says about a plugin's signature. */
export type PluginSignature = "verified" | "unsigned" | "invalid" | "builtin";

/**
 * Refuse unsigned main-realm plugins. Off for the migration window: flipping it
 * while gallery plugins still ship main-realm builds would stop them working.
 */
export const ENFORCE_SIGNED_MAIN_REALM = false;

export interface TrustInput {
  runtime?: string;
  builtin?: boolean;
  dev?: boolean;
  signature?: PluginSignature | string | null;
  signatureError?: string | null;
}

export type MainRealmVerdict =
  | { allow: true; unverified: boolean }
  | { allow: false; reason: string };

export function mainRealmVerdict(
  p: TrustInput,
  opts: { debugMode: boolean; enforce?: boolean },
): MainRealmVerdict {
  const enforce = opts.enforce ?? ENFORCE_SIGNED_MAIN_REALM;
  // Worker plugins are bounded by their permissions, and built-ins ship inside
  // the signed app bundle — neither is this rule's business.
  if (p.runtime === "worker" || p.builtin) return { allow: true, unverified: false };
  if (p.signature === "verified") return { allow: true, unverified: false };
  if (p.signature === "invalid") {
    return {
      allow: false,
      reason:
        "This plugin's signature doesn't match its files, so it may have been modified after Vibo published it. " +
        "Reinstall it from the gallery." +
        (p.signatureError ? ` (${p.signatureError})` : ""),
    };
  }
  // Unsigned (or a listing that predates the field). A local dev folder is
  // unsigned by nature, and reaching it already took debug mode plus a path
  // the user typed in, so it runs — labelled — whatever the enforcement.
  if (p.dev && opts.debugMode) return { allow: true, unverified: true };
  if (enforce) {
    return {
      allow: false,
      reason:
        "This plugin isn't signed by Vibo, and unsigned plugins can't run with full app access. " +
        "Update it, or use a version built for the plugin worker runtime.",
    };
  }
  return { allow: true, unverified: true };
}

/**
 * Pre-approved plugins: built-ins, and anything whose release carries a
 * signature from a key in `TRUSTED_PLUGIN_KEYS` (the owner's one plugin-signing
 * key). The signature covers manifest.json and index.js, so an update that asks
 * for more permissions must be signed too. Their permissions are still enforced
 * by the bridge and in Rust — only the asking is skipped. `unsigned`, `invalid`
 * and unknown-key signatures (reported `unsigned`) are asked as usual.
 */
export function isFirstParty(p: Pick<TrustInput, "builtin" | "signature">): boolean {
  return !!p.builtin || p.signature === "verified";
}
