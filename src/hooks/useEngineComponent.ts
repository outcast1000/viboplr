import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";
import {
  refreshEngineCapabilities,
  type EngineCapabilities,
  type EngineComponentStatus,
} from "../playback/nativeEngine";
import type { InstallProgress } from "./useDependencies";

/**
 * Install state + actions for the downloadable libmpv engine component
 * (Settings > Playback). Mirrors the managed-dependency flow in
 * `useDependencies`: streamed progress events, install/uninstall invokes,
 * and a capability re-probe on completion so the native engine becomes
 * selectable without a restart.
 */
export function useEngineComponent(onCapabilitiesChanged: (caps: EngineCapabilities) => void) {
  const [status, setStatus] = useState<EngineComponentStatus | null>(null);
  const [installing, setInstalling] = useState<InstallProgress | null>(null);

  useEffect(() => {
    invoke<EngineComponentStatus>("engine_component_status")
      .then(setStatus)
      .catch((e) => {
        console.error("Failed to read engine component status:", e);
      });
    return subscribe<{ downloaded: number; total: number | null }>(
      "engine-component-progress",
      (event) => {
        setInstalling({ downloaded: event.payload.downloaded, total: event.payload.total });
      },
    );
  }, []);

  const install = useCallback(async (): Promise<void> => {
    setInstalling({ downloaded: 0, total: null });
    try {
      const next = await invoke<EngineComponentStatus>("engine_component_install");
      setStatus(next);
      onCapabilitiesChanged(await refreshEngineCapabilities());
    } finally {
      setInstalling(null);
    }
  }, [onCapabilitiesChanged]);

  const uninstall = useCallback(async (): Promise<void> => {
    const next = await invoke<EngineComponentStatus>("engine_component_uninstall");
    setStatus(next);
    // An already-loaded copy stays usable until restart, so capabilities may
    // legitimately still report mpv: true here — surface whatever is real.
    onCapabilitiesChanged(await refreshEngineCapabilities());
  }, [onCapabilitiesChanged]);

  return { status, installing, install, uninstall };
}
