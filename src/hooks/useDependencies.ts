import { useState, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
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
}

export interface DependencyInfo {
  name: string;
  description: string;
  status: "installed" | "notFound" | "error";
  version?: string;
  message?: string;
  internalConsumers: ConsumerInfo[];
  pluginConsumers: ConsumerInfo[];
  install: InstallInstructions;
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
    message: raw.message as string | undefined,
    internalConsumers: raw.internalConsumers as ConsumerInfo[],
    pluginConsumers: raw.pluginConsumers as ConsumerInfo[],
    install: raw.install as InstallInstructions,
  };
}

export function useDependencies(pluginStates: PluginState[]) {
  const [deps, setDeps] = useState<DependencyInfo[]>([]);
  const [modalState, setModalState] = useState<DepModalState | null>(null);
  const checkedRef = useRef<Set<string>>(new Set());
  const shownModalsRef = useRef<Set<string>>(new Set());

  const getPluginDeps = useCallback(() => {
    const result: { name: string; pluginName: string; reason: string }[] = [];
    for (const ps of pluginStates) {
      if (ps.manifest.binaryDependencies) {
        for (const bd of ps.manifest.binaryDependencies) {
          result.push({ name: bd.name, pluginName: ps.manifest.name, reason: bd.reason });
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
    modalState,
    checkAll,
    checkDep,
    requireDep,
    promptDep,
    dismissModal,
    recheckModal,
  };
}
