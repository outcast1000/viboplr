import { useState, useRef, useCallback, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe, combineUnlisten } from "../utils/tauriEvents";
import { type PluginState } from "../types/plugin";

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
  };
}

export function useDependencies(pluginStates: PluginState[]) {
  const [deps, setDeps] = useState<DependencyInfo[]>([]);
  const [updates, setUpdates] = useState<DepUpdateInfo[]>([]);
  const [modalState, setModalState] = useState<DepModalState | null>(null);
  const [installing, setInstalling] = useState<Record<string, InstallProgress>>({});
  const checkedRef = useRef<Set<string>>(new Set());
  const shownModalsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const stopProgress = subscribe<{ name: string; downloaded: number; total: number | null }>(
      "dependency-install-progress",
      (event) => {
        const { name, downloaded, total } = event.payload;
        setInstalling((prev) => ({ ...prev, [name]: { downloaded, total } }));
      },
    );
    // Background auto-updater replaced a managed copy — drop the stale
    // cached check so the next look re-probes, and leave a log trail.
    const stopUpdated = subscribe<{ name: string; from: string; to: string }>(
      "dependency-updated",
      (event) => {
        const { name, from, to } = event.payload;
        checkedRef.current.delete(name);
        setDeps((prev) => prev.filter((d) => d.name !== name));
        setUpdates((prev) => prev.filter((u) => u.name !== name));
        invoke("write_frontend_log", {
          level: "info",
          message: `Auto-updated ${name} ${from} -> ${to}`,
          section: "dependencies",
        }).catch(() => {}); // Fire-and-forget: log-trail only, no user impact on failure
      },
    );
    return combineUnlisten(stopProgress, stopUpdated);
  }, []);

  const getPluginDeps = useCallback(() => {
    const result: { name: string; pluginName: string; reason: string; required: boolean }[] = [];
    for (const ps of pluginStates) {
      // Only enabled plugins' declarations count — a disabled plugin's missing
      // dependency isn't actionable and shouldn't drive the "needed by" list.
      if (!ps.enabled) continue;
      if (ps.manifest.binaryDependencies) {
        for (const bd of ps.manifest.binaryDependencies) {
          result.push({ name: bd.name, pluginName: ps.manifest.name, reason: bd.reason, required: !!bd.required });
        }
      }
    }
    return result;
  }, [pluginStates]);

  const checkAll = useCallback(
    async (forceRefresh = false) => {
      try {
        const results = (await invoke("check_dependencies", {
          names: null,
          pluginDeps: getPluginDeps(),
          forceRefresh,
        })) as Record<string, unknown>[];
        const parsed = results.map(parseDependencyInfo);
        setDeps(parsed);
        for (const d of parsed) {
          checkedRef.current.add(d.name);
        }
        return parsed;
      } catch (e) {
        console.error("Failed to check dependencies:", e);
        return [];
      }
    },
    [getPluginDeps],
  );

  const checkDep = useCallback(
    async (name: string): Promise<DependencyInfo | null> => {
      try {
        const results = (await invoke("check_dependencies", {
          names: [name],
          pluginDeps: getPluginDeps(),
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
  const checkUpdates = useCallback(async (): Promise<DepUpdateInfo[]> => {
    try {
      const results = (await invoke("dependency_check_updates")) as DepUpdateInfo[];
      setUpdates(results);
      return results;
    } catch (e) {
      console.error("Failed to check dependency updates:", e);
      return [];
    }
  }, []);

  // Install (or update — same backend path) the app-managed copy of a
  // dependency. Returns the installed version, or null on failure.
  const installDep = useCallback(
    async (name: string): Promise<string | null> => {
      setInstalling((prev) => ({ ...prev, [name]: { downloaded: 0, total: null } }));
      try {
        const version = (await invoke("dependency_install", { name })) as string;
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
    [checkDep],
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
      }
      return false;
    },
    [checkDep],
  );

  // Like requireDep, but always (re)shows the modal when the dependency is
  // missing — for explicit user requests (e.g. a plugin's "Install" button)
  // where the once-per-session guard of requireDep would otherwise swallow the
  // second click after a dismiss.
  const promptDep = useCallback(
    async (name: string, feature: string): Promise<boolean> => {
      const dep = await checkDep(name);
      if (!dep) return false;
      if (dep.status === "installed") return true;
      shownModalsRef.current.add(name);
      setModalState({ dep, feature });
      return false;
    },
    [checkDep],
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

  return {
    deps,
    updates,
    installing,
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
