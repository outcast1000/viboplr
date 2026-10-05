import { useCallback, useEffect, useRef, useState } from "react";
import { useLatestRef } from "./useLatestRef";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../utils/tauriEvents";
import { isExperimental } from "../utils/pluginStability";
import type { InstallFlowState } from "../components/PluginInstallModal";
import type { GalleryPluginEntry } from "../types/plugin";
import type { GallerySkinEntry } from "../types/skin";

// An extension install an AI assistant asked for (control API
// `extensions.install`). Only gallery entries can be named — never a URL — and
// nothing is fetched until the user presses Install in the app's own dialog
// (PluginInstallModal's "confirm" step). A "yes" in the chat is not consent:
// the assistant could claim one. From there it is the Extensions view's flow
// unchanged (progress, Cancel, then Enable with the permission list), and the
// request resolves when the user closes the dialog, with what actually happened.

/** Backend sentinel for a user-cancelled install (plugins.rs `INSTALL_CANCELLED`). */
const INSTALL_CANCELLED = "__install_cancelled__";

export type AssistantInstallOutcome =
  | { outcome: "declined" }
  | { outcome: "cancelled" }
  | { outcome: "failed"; error: string }
  | { outcome: "installed"; enabled: boolean };

export type AssistantInstallTarget =
  | { kind: "plugin"; entry: GalleryPluginEntry }
  | { kind: "skin"; entry: GallerySkinEntry };

interface Deps {
  installPlugin: (entry: GalleryPluginEntry) => Promise<{ ok: boolean; error?: string }>;
  /** Installs and applies (useSkins.installFromGallery). */
  installSkin: (entry: GallerySkinEntry) => Promise<{ ok: boolean; error?: string }>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void> | void;
  approvePermissions: (id: string) => Promise<void>;
  permissionsToApprove: (id: string) => string[];
}

interface Pending {
  target: AssistantInstallTarget;
  resolve: (o: AssistantInstallOutcome) => void;
  /** The last install error, reported if the user closes on it. */
  lastError?: string;
}

export function useAssistantInstall(deps: Deps) {
  const [flow, setFlow] = useState<InstallFlowState | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const depsRef = useLatestRef(deps);
  const flowRef = useLatestRef(flow);

  const finish = useCallback((o: AssistantInstallOutcome) => {
    const p = pendingRef.current;
    pendingRef.current = null;
    setFlow(null);
    p?.resolve(o);
  }, []);

  /** Asks the user; resolves once the dialog closes. One request at a time. */
  const requestInstall = useCallback((target: AssistantInstallTarget): Promise<AssistantInstallOutcome> => {
    if (pendingRef.current) {
      return Promise.reject(new Error("another install is already waiting for the user's answer in the app"));
    }
    const { entry } = target;
    return new Promise((resolve) => {
      pendingRef.current = { target, resolve };
      setFlow({
        id: entry.id,
        name: entry.name,
        phase: "confirm",
        confirm: {
          kind: target.kind,
          author: entry.author,
          description: "description" in entry ? entry.description : undefined,
          experimental: target.kind === "plugin" && isExperimental(target.entry.stability),
        },
      });
    });
  }, []);

  // Same progress feed the Extensions view's dialog reads.
  useEffect(() => {
    return subscribe<{ plugin_id: string; phase: string; downloaded: number; total: number | null }>(
      "plugin-install-progress",
      (e) => {
        const p = e.payload;
        setFlow((prev) => {
          if (!prev || prev.id !== p.plugin_id) return prev;
          if (prev.phase === "confirm" || prev.phase === "done" || prev.phase === "error") return prev;
          if (p.phase !== "resolving" && p.phase !== "downloading" && p.phase !== "installing") return prev;
          return { ...prev, phase: p.phase, downloaded: p.downloaded, total: p.total };
        });
      },
    );
  }, []);

  const runInstall = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    const { target } = p;
    const id = target.entry.id;
    p.lastError = undefined;
    setFlow((prev) => prev && { ...prev, phase: target.kind === "skin" ? "installing" : "resolving", error: undefined });
    const res = target.kind === "plugin"
      ? await depsRef.current.installPlugin(target.entry)
      : await depsRef.current.installSkin(target.entry);
    if (pendingRef.current !== p) return;
    if (res.ok) {
      const permissions = target.kind === "plugin" ? depsRef.current.permissionsToApprove(id) : undefined;
      setFlow((prev) => prev && { ...prev, phase: "done", needsEnable: target.kind === "plugin", permissions });
      return;
    }
    if (res.error === INSTALL_CANCELLED) {
      finish({ outcome: "cancelled" });
      return;
    }
    console.error(`Failed to install ${target.kind} ${id} for the assistant:`, res.error);
    p.lastError = res.error ?? "unknown error";
    setFlow((prev) => prev && { ...prev, phase: "error", error: res.error });
  }, [finish, depsRef]);

  const decline = useCallback(() => finish({ outcome: "declined" }), [finish]);

  const cancel = useCallback(() => {
    const current = flowRef.current;
    if (!current || (current.phase !== "resolving" && current.phase !== "downloading")) return;
    setFlow({ ...current, cancelling: true });
    invoke("cancel_plugin_install", { pluginId: current.id }).catch(console.error);
  }, [flowRef]);

  // "Allow and enable" / "Enable": grant exactly the list shown, then switch on.
  const enable = useCallback(async () => {
    const p = pendingRef.current;
    if (!p) return;
    const id = p.target.entry.id;
    try {
      if (depsRef.current.permissionsToApprove(id).length > 0) {
        await depsRef.current.approvePermissions(id);
      }
      await depsRef.current.togglePlugin(id, true);
      finish({ outcome: "installed", enabled: true });
    } catch (e) {
      console.error(`Failed to enable ${id} after an assistant install:`, e);
      finish({ outcome: "failed", error: `installed, but enabling failed: ${e instanceof Error ? e.message : String(e)}` });
    }
  }, [finish, depsRef]);

  // Done (skin) / Not now (plugin) / Close (error).
  const close = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    if (p.lastError !== undefined) finish({ outcome: "failed", error: p.lastError });
    else finish({ outcome: "installed", enabled: p.target.kind === "skin" });
  }, [finish]);

  return { flow, requestInstall, confirm: runInstall, decline, cancel, enable, close, retry: runInstall };
}
