import { useState, useCallback, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ExtensionUpdate,
  ExtensionItem,
  ExtensionFilter,
  PluginState,
  GalleryPluginEntry,
} from "../types/plugin";
import type { SkinInfo, GallerySkinEntry } from "../types/skin";

interface UseExtensionsProps {
  pluginStates: PluginState[];
  installedSkins: SkinInfo[];
  activeSkinId: string;
  gallerySkins: GallerySkinEntry[];
  galleryPlugins: GalleryPluginEntry[];
  onTogglePlugin: (id: string) => void | Promise<void>;
  onReloadPlugin: (id: string) => void;
  onDeletePlugin: (id: string) => Promise<{ ok: boolean; error?: string }>;
  onInstallPluginFromGallery: (
    entry: GalleryPluginEntry,
  ) => Promise<{ ok: boolean; error?: string }>;
  onInstallSkinFromGallery: (
    entry: GallerySkinEntry,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDeleteSkin: (id: string) => void;
  onApplySkin: (id: string) => void;
  onFetchPluginGallery: () => void;
  onFetchSkinGallery: () => void;
  onReloadAllPlugins: () => void;
}

export function useExtensions(props: UseExtensionsProps) {
  const {
    pluginStates,
    installedSkins,
    activeSkinId,
    gallerySkins,
    galleryPlugins,
    onTogglePlugin,
    onReloadPlugin,
    onDeletePlugin,
    onInstallPluginFromGallery,
    onInstallSkinFromGallery,
    onDeleteSkin,
    onApplySkin,
    onFetchPluginGallery,
    onFetchSkinGallery,
    onReloadAllPlugins,
  } = props;

  const [updates, setUpdates] = useState<ExtensionUpdate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  // Non-null while a blocking extension operation (check/update/enable) is in
  // flight. Drives the shared PluginLoadingModal so the user knows something is
  // happening — these operations otherwise run silently with no on-screen change.
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  // Result of the last user-initiated check/update, shown via the shared
  // AlertModal once the busy spinner clears. Without this, a check that finds
  // nothing (or an update that succeeds/fails) gives the user no visible outcome.
  const [resultModal, setResultModal] = useState<
    { title: string; message: string } | null
  >(null);
  const dismissResult = useCallback(() => setResultModal(null), []);

  // Listen for background update events
  useEffect(() => {
    const unlisten = listen<ExtensionUpdate[]>(
      "extensions-updates-available",
      (event) => {
        setUpdates(event.payload);
        setLastChecked(Date.now());
      },
    );
    const unlisten2 = listen<string>("extension-update-installed", () => {
      // Background re-check — silent so it never pops a modal unprompted.
      checkForUpdates({ silent: true });
    });
    return () => {
      unlisten.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, []);

  const checkForUpdates = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
      setChecking(true);
      if (!silent) setBusyMessage("Checking for extension updates…");
      try {
        const result = await invoke<ExtensionUpdate[]>(
          "check_for_extension_updates",
        );
        setUpdates(result);
        setLastChecked(Date.now());
        if (!silent) {
          const n = result.filter((u) => u.status === "available").length;
          setResultModal(
            n > 0
              ? {
                  title: "Updates Available",
                  message: `${n} extension update${n !== 1 ? "s are" : " is"} available. Use "Update All" or open an extension to install.`,
                }
              : {
                  title: "Up to Date",
                  message: "All your extensions are up to date.",
                },
          );
        }
      } catch (e) {
        console.error("Failed to check for updates:", e);
        if (!silent) {
          setResultModal({
            title: "Check Failed",
            message: "Couldn't check for updates. Please try again later.",
          });
        }
      } finally {
        setChecking(false);
        if (!silent) setBusyMessage(null);
      }
    },
    [],
  );

  // Installs a single update; returns whether it succeeded. No busy/result UI —
  // callers own the user-facing feedback so single-update and Update-All can
  // present one coherent message instead of one per item.
  const performUpdate = useCallback(
    async (id: string): Promise<boolean> => {
      const update = updates.find((u) => u.id === id);
      if (!update || update.status !== "available") return false;

      setInstalling((prev) => new Set(prev).add(id));
      try {
        if (update.kind === "plugin") {
          await invoke("download_and_install_plugin_update", {
            pluginId: id,
            downloadUrl: update.downloadUrl,
          });
          onReloadPlugin(id);
        } else {
          await invoke("download_and_install_skin_update", {
            skinId: id,
            downloadUrl: update.downloadUrl,
          });
        }
        setUpdates((prev) => prev.filter((u) => u.id !== id));
        return true;
      } catch (e) {
        console.error("Failed to update extension:", e);
        return false;
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [updates, onReloadPlugin],
  );

  const updateExtension = useCallback(
    async (id: string) => {
      const name = updates.find((u) => u.id === id)?.name ?? "the extension";
      setBusyMessage(`Updating ${name}…`);
      let ok = false;
      try {
        ok = await performUpdate(id);
      } finally {
        setBusyMessage(null);
      }
      setResultModal(
        ok
          ? { title: "Update Complete", message: `${name} was updated successfully.` }
          : {
              title: "Update Failed",
              message: `Couldn't update ${name}. Please try again later.`,
            },
      );
    },
    [updates, performUpdate],
  );

  const updateAll = useCallback(async () => {
    const available = updates.filter((u) => u.status === "available");
    if (available.length === 0) return;
    let succeeded = 0;
    const failed: string[] = [];
    try {
      for (let i = 0; i < available.length; i++) {
        setBusyMessage(
          `Updating ${available[i].name} (${i + 1}/${available.length})…`,
        );
        if (await performUpdate(available[i].id)) succeeded++;
        else failed.push(available[i].name);
      }
    } finally {
      setBusyMessage(null);
    }
    if (failed.length === 0) {
      setResultModal({
        title: "Updates Complete",
        message: `${succeeded} extension${succeeded !== 1 ? "s were" : " was"} updated successfully.`,
      });
    } else {
      setResultModal({
        title: "Some Updates Failed",
        message: `${succeeded} of ${available.length} updated. Failed: ${failed.join(", ")}.`,
      });
    }
  }, [updates, performUpdate]);

  const installFromGallery = useCallback(
    async (
      entry: GalleryPluginEntry | GallerySkinEntry,
    ): Promise<{ ok: boolean; kind: "plugin" | "skin"; error?: string }> => {
      setInstalling((prev) => new Set(prev).add(entry.id));
      // Discriminate by a skin-only field. Plugin gallery entries no longer
      // carry `files` (index-only gallery), so "colors" (skins only) is the
      // reliable discriminator.
      const isSkin = "colors" in entry;
      try {
        const res = isSkin
          ? await onInstallSkinFromGallery(entry as GallerySkinEntry)
          : await onInstallPluginFromGallery(entry as GalleryPluginEntry);
        return { ok: res.ok, kind: isSkin ? "skin" : "plugin", error: res.error };
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [onInstallPluginFromGallery, onInstallSkinFromGallery],
  );

  const uninstall = useCallback(
    async (id: string, kind: "plugin" | "skin") => {
      try {
        if (kind === "plugin") {
          const res = await onDeletePlugin(id);
          if (!res.ok) {
            console.error(`Failed to uninstall plugin "${id}":`, res.error);
          }
        } else {
          onDeleteSkin(id);
        }
      } catch (e) {
        console.error("Failed to uninstall:", e);
      }
    },
    [onDeletePlugin, onDeleteSkin],
  );

  const toggleEnabled = useCallback(
    async (id: string, kind: "plugin" | "skin") => {
      if (kind === "skin") {
        onApplySkin(id);
        return;
      }
      // Enabling/disabling a plugin reloads the whole plugin runtime
      // (deactivate-all → re-activate sequentially), which can take a moment
      // with no on-screen change. Block with the shared modal until it settles
      // so the button press has visible, awaited feedback.
      const enabling =
        pluginStates.find((p) => p.id === id)?.status !== "active";
      setBusyMessage(enabling ? "Enabling plugin…" : "Disabling plugin…");
      try {
        await onTogglePlugin(id);
      } catch (e) {
        console.error("Failed to toggle plugin:", e);
      } finally {
        setBusyMessage(null);
      }
    },
    [onTogglePlugin, onApplySkin, pluginStates],
  );

  const installFromUrl = useCallback(
    async (url: string) => {
      try {
        await invoke<string>("install_plugin_from_url", { url });
        onReloadAllPlugins();
      } catch (e) {
        console.error("Failed to install from URL:", e);
      }
    },
    [onReloadAllPlugins],
  );

  const extensions: ExtensionItem[] = useMemo(() => {
    const items: ExtensionItem[] = [];

    for (const ps of pluginStates) {
      const update = updates.find(
        (u) => u.id === ps.id && u.kind === "plugin",
      );
      items.push({
        id: ps.id,
        kind: "plugin",
        name: ps.manifest.name,
        author: ps.manifest.author || "Unknown",
        version: ps.manifest.version,
        description: ps.manifest.description || "",
        status:
          ps.status === "active"
            ? "active"
            : ps.status === "incompatible"
              ? "incompatible"
              : ps.status === "error"
                ? "error"
                : "disabled",
        updateAvailable: update,
        source: ps.dev ? "dev" : ps.builtin ? "builtin" : "user",
        devPath: ps.devPath,
        icon: ps.manifest.icon,
        contributes: ps.manifest.contributes,
        apiUsage: ps.manifest.apiUsage,
        homepage: ps.manifest.homepage,
        minAppVersion: ps.manifest.minAppVersion,
        updateUrl: ps.manifest.updateUrl,
      });
    }

    for (const skin of installedSkins) {
      const update = updates.find(
        (u) => u.id === skin.id && u.kind === "skin",
      );
      const colors: [string, string, string, string] = [
        skin.colors["bg-primary"] || "#000",
        skin.colors["accent"] || "#fff",
        skin.colors["bg-secondary"] || "#111",
        skin.colors["text-primary"] || "#eee",
      ];
      items.push({
        id: skin.id,
        kind: "skin",
        name: skin.name,
        author: skin.author,
        version: skin.version,
        description: `${skin.type === "dark" ? "Dark" : "Light"} theme`,
        status: skin.id === activeSkinId ? "active" : "disabled",
        updateAvailable: update,
        source: skin.source,
        skinColors: colors,
        skinType: skin.type,
        isActiveSkin: skin.id === activeSkinId,
        updateUrl: skin.updateUrl,
      });
    }

    const installedPluginIds = new Set(pluginStates.map((p) => p.id));
    for (const entry of galleryPlugins) {
      if (installedPluginIds.has(entry.id)) continue;
      items.push({
        id: entry.id,
        kind: "plugin",
        name: entry.name,
        author: entry.author,
        version: entry.version,
        description: entry.description,
        status: "not_installed",
        source: "gallery",
        minAppVersion: entry.minAppVersion,
        updateUrl: entry.updateUrl,
        recommended: entry.recommended === true,
      });
    }

    const installedSkinIds = new Set(installedSkins.map((s) => s.id));
    for (const entry of gallerySkins) {
      if (installedSkinIds.has(entry.id)) continue;
      items.push({
        id: entry.id,
        kind: "skin",
        name: entry.name,
        author: entry.author,
        version: entry.version,
        description: `${entry.type === "dark" ? "Dark" : "Light"} theme`,
        status: "not_installed",
        source: "gallery",
        skinColors: entry.colors,
        skinType: entry.type,
        recommended: entry.recommended === true,
      });
    }

    return items;
  }, [
    pluginStates,
    installedSkins,
    activeSkinId,
    updates,
    galleryPlugins,
    gallerySkins,
  ]);

  const filteredExtensions = useMemo(() => {
    let filtered = extensions;

    switch (filter) {
      case "plugins":
        filtered = filtered.filter((e) => e.kind === "plugin");
        break;
      case "skins":
        filtered = filtered.filter((e) => e.kind === "skin");
        break;
      case "installed":
        filtered = filtered.filter((e) => e.status !== "not_installed");
        break;
      case "updates":
        filtered = filtered.filter((e) => e.updateAvailable);
        break;
      case "gallery":
        filtered = filtered.filter((e) => e.status === "not_installed");
        break;
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.description.toLowerCase().includes(q) ||
          e.author.toLowerCase().includes(q),
      );
    }

    return filtered;
  }, [extensions, filter, searchQuery]);

  const updateCount = updates.filter(
    (u) => u.status === "available",
  ).length;

  return {
    extensions: filteredExtensions,
    allExtensions: extensions,
    updates,
    updateCount,
    selectedId,
    setSelectedId,
    filter,
    setFilter,
    searchQuery,
    setSearchQuery,
    installing,
    checking,
    busyMessage,
    resultModal,
    dismissResult,
    lastChecked,
    checkForUpdates,
    updateExtension,
    updateAll,
    installFromGallery,
    installFromUrl,
    uninstall,
    toggleEnabled,
    onFetchPluginGallery,
    onFetchSkinGallery,
    onReloadAllPlugins,
  };
}
