import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { type PluginState } from "../types/plugin";
import { useAssignRef, useLatestRef } from "./useLatestRef";
import { track as trackTelemetry } from "../telemetry";
import { setDependencyNames } from "../utils/errorKind";

export interface InstallInstructions {
  macos: string;
  windows: string;
  linux: string;
  url: string;
}

export interface ConsumerInfo {
  name: string;
  reason: string;
  /** Whether this consumer marks the dependency as required (vs optional). */
  required: boolean;
}

export interface DependencyInfo {
  name: string;
  description: string;
  status: "installed" | "notFound" | "error";
  version?: string;
  origin?: "managed" | "system";
  message?: string;
  internalConsumers: ConsumerInfo[];
  pluginConsumers: ConsumerInfo[];
  install: InstallInstructions;
  managedAvailable: boolean;
  latestVersion?: string;
  /** GitHub repo a managed copy comes from. */
  managedRepo?: string;
  /** Plugin ids whose manifest defines this tool; empty for one of Vibo's own. */
  declaredBy: string[];
  /** Defined by Vibo or a plugin Vibo signed — what may update silently. */
  signedDefinition: boolean;
  /** False when nothing checks the download (`checksum: { none: true }`). */
  verified: boolean;
  /** The managed copy came from another definition's source; reinstall to fix. */
  sourceMismatch: boolean;
}

/** An unsigned plugin's tool definition, waiting for the user's OK. */
export interface PendingDefinition {
  pluginId: string;
  pluginName: string;
  name: string;
  fingerprint: string;
  repo: string | null;
  verified: boolean;
  required: boolean;
}

export interface DependencyRegistry {
  pendingConsent: PendingDefinition[];
  conflicts: { name: string; kept: string; dropped: string; reason: string }[];
  refused: { pluginId: string; name: string; reason: string }[];
  /** Managed copies no installed plugin defines any more. */
  unused: string[];
}

const EMPTY_REGISTRY: DependencyRegistry = { pendingConsent: [], conflicts: [], refused: [], unused: [] };

/** What a consent dialog shows: one unsigned plugin's waiting definitions. */
export interface DefinitionConsentRequest {
  pluginId: string;
  pluginName: string;
  items: PendingDefinition[];
}

/** An install or update of a tool whose download nothing can check. */
export interface UnverifiedInstallRequest {
  name: string;
  repo: string | null;
  update: boolean;
}

export interface DepUpdateInfo {
  name: string;
  installed?: string;
  latest?: string;
  outdated: boolean;
  origin?: "managed" | "system";
}

export interface InstallProgress {
  downloaded: number;
  total: number | null;
}

interface DepModalState {
  dep: DependencyInfo;
  feature: string;
}

/** One declared "plugin X needs binary Y" pair, as sent to `check_dependencies`. */
export interface PluginDepDeclaration {
  name: string;
  pluginName: string;
  reason: string;
  required: boolean;
  /** The entry also defines the tool. Not sent to the backend (it reads
   *  definitions from disk); part of the signature so a changed definition
   *  re-checks. */
  definition?: string;
}

/**
 * Stable identity of a set of plugin dependency declarations. Every row's
 * `pluginConsumers` is derived from this set, so a change means the cached
 * consumer data is stale and has to be rebuilt. Order-insensitive: the plugin
 * list is rebuilt on every render and its order is not meaningful.
 */
export function pluginDepSignature(decls: PluginDepDeclaration[]): string {
  return decls
    .map((d) => `${d.name} ${d.pluginName} ${d.required ? 1 : 0} ${d.definition ?? ""}`)
    .sort()
    .join("");
}

function parseDependencyInfo(raw: Record<string, unknown>): DependencyInfo {
  const status = raw.status as string;
  return {
    name: raw.name as string,
    description: raw.description as string,
    status: status as DependencyInfo["status"],
    version: raw.version as string | undefined,
    origin: raw.origin as DependencyInfo["origin"],
    message: raw.message as string | undefined,
    internalConsumers: raw.internalConsumers as ConsumerInfo[],
    pluginConsumers: raw.pluginConsumers as ConsumerInfo[],
    install: raw.install as InstallInstructions,
    managedAvailable: (raw.managedAvailable as boolean) ?? false,
    latestVersion: (raw.latestVersion as string | null) ?? undefined,
    managedRepo: (raw.managedRepo as string | null) ?? undefined,
    declaredBy: (raw.declaredBy as string[] | undefined) ?? [],
    signedDefinition: (raw.signedDefinition as boolean | undefined) ?? true,
    verified: (raw.verified as boolean | undefined) ?? true,
    sourceMismatch: (raw.sourceMismatch as boolean | undefined) ?? false,
  };
}

/**
 * The consent dialogs to raise on their own: required definitions only (an
 * optional tool asks when the user goes to install it), one per plugin, and
 * never again for a set the user already answered this session.
 */
export function definitionsToAsk(pending: PendingDefinition[], answered: ReadonlySet<string>): DefinitionConsentRequest[] {
  const byPlugin = new Map<string, DefinitionConsentRequest>();
  for (const p of pending) {
    if (!p.required || answered.has(`${p.pluginId}:${p.fingerprint}`)) continue;
    const req = byPlugin.get(p.pluginId) ?? { pluginId: p.pluginId, pluginName: p.pluginName, items: [] };
    req.items.push(p);
    byPlugin.set(p.pluginId, req);
  }
  return [...byPlugin.values()];
}

export function useDependencies(pluginStates: PluginState[]) {
  const [deps, setDeps] = useState<DependencyInfo[]>([]);
  const [updates, setUpdates] = useState<DepUpdateInfo[]>([]);
  const [modalState, setModalState] = useState<DepModalState | null>(null);
  const [installing, setInstalling] = useState<Record<string, InstallProgress>>({});
  const [registry, setRegistry] = useState<DependencyRegistry>(EMPTY_REGISTRY);
  const [consentRequest, setConsentRequest] = useState<DefinitionConsentRequest | null>(null);
  const [unverifiedRequest, setUnverifiedRequest] = useState<UnverifiedInstallRequest | null>(null);
  // Answers for the two dialogs above, resolved by their buttons.
  const consentAnswerRef = useRef<((ok: boolean) => void) | null>(null);
  const unverifiedAnswerRef = useRef<((ok: boolean) => void) | null>(null);
  // Definition sets the user already answered this session (`pluginId:fingerprint`),
  // so a declined required definition doesn't come back on every check.
  const answeredRef = useRef<Set<string>>(new Set());
  // Plugins whose consent the user took back this session: their definitions
  // wait again, but asking straight away would undo the Revoke click.
  const revokedRef = useRef<Set<string>>(new Set());
  const checkAllRef = useRef<(force?: boolean) => Promise<DependencyInfo[]>>(async () => []);
  const registryRef = useLatestRef(registry);
  const pluginStatesRef = useLatestRef(pluginStates);
  const checkedRef = useRef<Set<string>>(new Set());
  const shownModalsRef = useRef<Set<string>>(new Set());
  // Plugin-declaration signature the current `deps` were built from; null until
  // the first successful `checkAll`. See the re-probe effect below.
  const checkedSignatureRef = useRef<string | null>(null);
  // Forward declarations for the `dependency-updated` listener below, which is
  // installed once and must re-probe the dep the background updater replaced.
  // Both are defined further down, hence the assign-later ref pattern.
  const checkDepRef = useRef<(name: string) => Promise<DependencyInfo | null>>(async () => null);
  const checkUpdatesRef = useRef<(force?: boolean) => Promise<DepUpdateInfo[]>>(async () => []);
  // Read by that listener to tell "the list is on screen, refresh this row"
  // from "nothing has ever run a check" — see the guard there.
  const depsRef = useLatestRef(deps);

  useEffect(() => {
    const stopProgress = subscribe<{ name: string; downloaded: number; total: number | null }>(
      "dependency-install-progress",
      (event) => {
        const { name, downloaded, total } = event.payload;
        setInstalling((prev) => ({ ...prev, [name]: { downloaded, total } }));
      },
    );
    // Background auto-updater replaced a managed copy — re-probe it so the row
    // shows the new version, and leave a log trail. It must be a re-probe, not
    // a removal: dropping the row was the whole state change here, and nothing
    // ever performed the "next look" it assumed, so a silently updated dep
    // vanished from the list until the user hit Refresh (DependenciesPanel's presence
    // check is gated on `deps.length === 0`, and ffmpeg keeps it non-empty).
    const stopUpdated = subscribe<{ name: string; from: string; to: string }>(
      "dependency-updated",
      (event) => {
        const { name, from, to } = event.payload;
        // Force a real probe: the binary changed under us.
        checkedRef.current.delete(name);
        // Only refresh a row that is already in the list. The updater fires 30s
        // after launch, typically before anything has run a check — probing here
        // would then *create* a one-row `deps`, and DependenciesPanel's presence check
        // (gated on `deps.length === 0`) would skip its full `checkAll`, leaving
        // the Tools tab showing yt-dlp and no ffmpeg.
        if (depsRef.current.some((d) => d.name === name)) {
          checkDepRef.current(name).catch(console.error);
          // Clears the now-stale "Update available" line for this dep.
          checkUpdatesRef.current().catch(console.error);
        }
        invoke("write_frontend_log", {
          level: "info",
          message: `Auto-updated ${name} ${from} -> ${to}`,
          section: "dependencies",
        }).catch(() => {}); // eslint-disable-line no-restricted-syntax -- Fire-and-forget: log-trail only, no user impact on failure
      },
    );
    // The set of tools in force moved (a plugin installed, updated or removed;
    // a consent given or taken back). Only once a first check set the baseline.
    const stopChanged = subscribe("dependencies-changed", () => {
      if (checkedSignatureRef.current === null) return;
      checkAllRef.current().catch(console.error);
    });
    return combineUnlisten(stopProgress, stopUpdated, stopChanged);
    // depsRef is a stable ref object; listed only to satisfy exhaustive-deps.
  }, [depsRef]);

  const getPluginDeps = useCallback((): PluginDepDeclaration[] => {
    const result: PluginDepDeclaration[] = [];
    for (const ps of pluginStates) {
      // Only enabled plugins' declarations count — a disabled plugin's missing
      // dependency isn't actionable and shouldn't drive the "needed by" list.
      if (!ps.enabled) continue;
      if (ps.manifest.binaryDependencies) {
        for (const bd of ps.manifest.binaryDependencies) {
          result.push({
            name: bd.name,
            pluginName: ps.manifest.name,
            reason: bd.reason,
            required: !!bd.required,
            definition: bd.definition ? JSON.stringify(bd.definition) : undefined,
          });
        }
      }
    }
    return result;
  }, [pluginStates]);

  const checkAll = useCallback(
    async (forceRefresh = false) => {
      const pluginDeps = getPluginDeps();
      try {
        const [results, reg] = await Promise.all([
          invoke("check_dependencies", {
            names: null,
            pluginDeps: pluginDeps.map(({ definition: _definition, ...d }) => d),
            forceRefresh,
          }) as Promise<Record<string, unknown>[]>,
          (invoke("dependency_registry_status") as Promise<DependencyRegistry>).catch((e) => {
            console.error("Failed to read the plugin-defined tools:", e);
            return EMPTY_REGISTRY;
          }),
        ]);
        const parsed = results.map(parseDependencyInfo);
        setDeps(parsed);
        setRegistry({ ...EMPTY_REGISTRY, ...(reg ?? {}) });
        setDependencyNames(parsed.map((d) => d.name));
        for (const d of parsed) {
          checkedRef.current.add(d.name);
        }
        // Record what this result actually describes, so the effect below can
        // tell "already current" from "the plugin set moved on since".
        checkedSignatureRef.current = pluginDepSignature(pluginDeps);
        return parsed;
      } catch (e) {
        console.error("Failed to check dependencies:", e);
        return [];
      }
    },
    [getPluginDeps],
  );

  // Re-probe when the enabled plugins' declared binary dependencies change.
  // `pluginConsumers` (and everything derived from it: the Tools tab "used by"
  // list, the onboarding wizard's missing-dependency step) comes from that
  // declaration set, not from the binaries themselves, so installing or enabling
  // a plugin mid-session otherwise leaves it describing the plugin set as it was
  // at startup. That is exactly the first-run case: the wizard installs the
  // yt-dlp plugin, and the "Companion tools" step that offers to install the
  // yt-dlp binary is gated on consumer data collected before it existed.
  //
  // Gated on a baseline existing: the first probe is deliberately deferred by
  // App (off the startup critical path) and this must not pull it forward. Not
  // forced, either, since only the declarations changed and the cached binary
  // probes are still good.
  const currentSignature = useMemo(() => pluginDepSignature(getPluginDeps()), [getPluginDeps]);
  useEffect(() => {
    if (checkedSignatureRef.current === null) return;
    if (checkedSignatureRef.current === currentSignature) return;
    checkAll().catch(console.error);
  }, [currentSignature, checkAll]);

  const checkDep = useCallback(
    async (name: string): Promise<DependencyInfo | null> => {
      try {
        const results = (await invoke("check_dependencies", {
          names: [name],
          pluginDeps: getPluginDeps().map(({ definition: _definition, ...d }) => d),
          forceRefresh: !checkedRef.current.has(name),
        })) as Record<string, unknown>[];
        if (results.length > 0) {
          const parsed = parseDependencyInfo(results[0]);
          checkedRef.current.add(name);
          setDeps((prev) => {
            const idx = prev.findIndex((d) => d.name === name);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = parsed;
              return next;
            }
            return [...prev, parsed];
          });
          return parsed;
        }
      } catch (e) {
        console.error("Failed to check dependency:", e);
      }
      return null;
    },
    [getPluginDeps],
  );

  // Latest-vs-installed for all managed deps (network, 24h TTL-cached backend-side).
  // `force` (the user's Refresh click) skips that cache.
  const checkUpdates = useCallback(async (force = false): Promise<DepUpdateInfo[]> => {
    try {
      const results = (await invoke("dependency_check_updates", { force })) as DepUpdateInfo[];
      setUpdates(results);
      return results;
    } catch (e) {
      console.error("Failed to check dependency updates:", e);
      return [];
    }
  }, []);

  // Fill the forward declarations the `dependency-updated` listener reads.
  useAssignRef(checkDepRef, checkDep);
  useAssignRef(checkUpdatesRef, checkUpdates);
  useAssignRef(checkAllRef, checkAll);

  /** Ask the user to let an unsigned plugin's definitions be used. Resolves
   *  true when they agreed and the consent was recorded. */
  const askConsent = useCallback(async (request: DefinitionConsentRequest): Promise<boolean> => {
    if (consentAnswerRef.current) return false; // one dialog at a time
    const ok = await new Promise<boolean>((resolve) => {
      consentAnswerRef.current = resolve;
      setConsentRequest(request);
    });
    consentAnswerRef.current = null;
    setConsentRequest(null);
    for (const item of request.items) answeredRef.current.add(`${item.pluginId}:${item.fingerprint}`);
    if (!ok) return false;
    try {
      await invoke("dependency_definitions_consent", {
        pluginId: request.pluginId,
        fingerprints: request.items.map((i) => i.fingerprint),
      });
      return true;
    } catch (e) {
      console.error("Failed to record consent for a plugin's tools:", e);
      return false;
    }
  }, []);

  const answerConsent = useCallback((ok: boolean) => consentAnswerRef.current?.(ok), []);

  /** The Tools tab's "Review" on a waiting definition (also optional ones). */
  const reviewDefinitions = useCallback(
    async (pluginId: string): Promise<boolean> => {
      const items = registry.pendingConsent.filter((p) => p.pluginId === pluginId);
      if (items.length === 0) return false;
      return askConsent({ pluginId, pluginName: items[0].pluginName, items });
    },
    [registry, askConsent],
  );

  const revokeDefinitions = useCallback(async (pluginId: string): Promise<void> => {
    revokedRef.current.add(pluginId);
    await invoke("dependency_definitions_revoke", { pluginId });
  }, []);

  // Required definitions are asked for on their own, once per session each.
  useEffect(() => {
    const waiting = registry.pendingConsent.filter((p) => !revokedRef.current.has(p.pluginId));
    const next = definitionsToAsk(waiting, answeredRef.current)[0];
    if (next && !consentAnswerRef.current) askConsent(next).catch(console.error);
  }, [registry, askConsent]);

  const answerUnverified = useCallback((ok: boolean) => unverifiedAnswerRef.current?.(ok), []);

  const removeUnused = useCallback(async (name: string): Promise<void> => {
    await invoke("dependency_remove_unused", { name });
    await checkAll();
  }, [checkAll]);

  // Install (or update — same backend path) the app-managed copy of a
  // dependency. Returns the installed version, or null on failure.
  const installDep = useCallback(
    async (name: string): Promise<string | null> => {
      // A download nothing can check is confirmed every time, update included.
      const dep = depsRef.current.find((d) => d.name === name);
      const unverified = dep ? !dep.verified : false;
      if (unverified) {
        const ok = await new Promise<boolean>((resolve) => {
          unverifiedAnswerRef.current = resolve;
          setUnverifiedRequest({ name, repo: dep?.managedRepo ?? null, update: dep?.status === "installed" });
        });
        unverifiedAnswerRef.current = null;
        setUnverifiedRequest(null);
        if (!ok) return null;
      }
      setInstalling((prev) => ({ ...prev, [name]: { downloaded: 0, total: null } }));
      try {
        const version = (await invoke("dependency_install", { name, confirmedUnverified: unverified })) as string;
        checkedRef.current.delete(name);
        await checkDep(name);
        setUpdates((prev) => prev.filter((u) => u.name !== name));
        return version;
      } catch (e) {
        console.error("Failed to install dependency:", e);
        throw e;
      } finally {
        setInstalling((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [checkDep, depsRef],
  );

  // Remove the app-managed copy; PATH falls back to any system copy. Refreshes
  // the row's status afterward.
  const uninstallManaged = useCallback(
    async (name: string): Promise<void> => {
      try {
        await invoke("dependency_uninstall_managed", { name });
        checkedRef.current.delete(name);
        await checkDep(name);
        await checkUpdates();
      } catch (e) {
        console.error("Failed to stop managing dependency:", e);
        throw e;
      }
    },
    [checkDep, checkUpdates],
  );

  const requireDep = useCallback(
    async (name: string, feature: string): Promise<boolean> => {
      const dep = await checkDep(name);
      if (!dep) return false;
      if (dep.status === "installed") return true;

      if (!shownModalsRef.current.has(name)) {
        shownModalsRef.current.add(name);
        setModalState({ dep, feature });
        trackTelemetry("dependency_missing", { name });
      }
      return false;
    },
    [checkDep],
  );

  // Like requireDep, but always (re)shows the modal when the dependency is
  // missing — for explicit user requests (e.g. a plugin's "Install" button)
  // where the once-per-session guard of requireDep would otherwise swallow the
  // second click after a dismiss.
  //
  // `pluginId` (a plugin's `requestAction("require-dependency")`): the plugin
  // may only ask for a tool its own manifest lists, and when that tool is one
  // of its unsigned definitions still waiting for consent, the consent dialog
  // comes first — this is where an optional tool gets asked.
  const promptDep = useCallback(
    async (name: string, feature: string, pluginId?: string): Promise<boolean> => {
      if (pluginId) {
        const plugin = pluginStatesRef.current.find((p) => p.id === pluginId);
        if (!plugin?.manifest.binaryDependencies?.some((b) => b.name === name)) {
          console.error(`Plugin ${pluginId} asked for ${name}, which its manifest doesn't list`);
          return false;
        }
        const items = registryRef.current.pendingConsent.filter((p) => p.pluginId === pluginId && p.name === name);
        if (items.length > 0) {
          const ok = await askConsent({ pluginId, pluginName: items[0].pluginName, items });
          if (!ok) return false;
          await checkAll();
        }
      }
      const dep = await checkDep(name);
      if (!dep) return false;
      if (dep.status === "installed") return true;
      shownModalsRef.current.add(name);
      setModalState({ dep, feature });
      trackTelemetry("dependency_missing", { name });
      return false;
    },
    [checkDep, checkAll, askConsent, pluginStatesRef, registryRef],
  );

  const dismissModal = useCallback(() => {
    setModalState(null);
  }, []);

  const recheckModal = useCallback(async () => {
    if (!modalState) return;
    checkedRef.current.delete(modalState.dep.name);
    const dep = await checkDep(modalState.dep.name);
    if (dep && dep.status === "installed") {
      setModalState(null);
    } else if (dep) {
      setModalState({ dep, feature: modalState.feature });
    }
  }, [modalState, checkDep]);

  const pluginNames = useMemo(
    () => Object.fromEntries(pluginStates.map((p) => [p.id, p.manifest.name])) as Record<string, string>,
    [pluginStates],
  );

  return {
    deps,
    updates,
    installing,
    registry,
    pluginNames,
    consentRequest,
    answerConsent,
    reviewDefinitions,
    revokeDefinitions,
    unverifiedRequest,
    answerUnverified,
    removeUnused,
    modalState,
    checkAll,
    checkDep,
    checkUpdates,
    installDep,
    uninstallManaged,
    requireDep,
    promptDep,
    dismissModal,
    recheckModal,
  };
}
