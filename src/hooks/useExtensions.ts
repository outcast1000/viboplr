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
  onTogglePlugin: (id: string) => void;
  onReloadPlugin: (id: string) => void;
  onDeletePlugin: (id: string) => Promise<void>;
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
  addLog: (msg: string, module?: string) => void;
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
    addLog,
  } = props;

  const [updates, setUpdates] = useState<ExtensionUpdate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

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
      checkForUpdates();
    });
    return () => {
      unlisten.then((f) => f());
      unlisten2.then((f) => f());
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    try {
      const result = await invoke<ExtensionUpdate[]>(
        "check_for_extension_updates",
      );
      setUpdates(result);
      setLastChecked(Date.now());
    } catch (e) {
      console.error("Failed to check for updates:", e);
      addLog("Failed to check for updates: " + String(e), "extensions");
    } finally {
      setChecking(false);
    }
  }, [addLog]);

  const updateExtension = useCallback(
    async (id: string) => {
      const update = updates.find((u) => u.id === id);
      if (!update || update.status !== "available") return;

      setInstalling((prev) => new Set(prev).add(id));
      try {
        if (update.kind === "plugin") {
          await invoke("download_and_install_plugin_update", {
            pluginId: id,
            downloadUrl: update.downloadUrl,
          });
          onReloadPlugin(id);
          addLog(`Updated ${update.name} to v${update.latestVersion}`, "extensions");
        } else {
          await invoke("download_and_install_skin_update", {
            skinId: id,
            downloadUrl: update.downloadUrl,
          });
          addLog(`Updated ${update.name} to v${update.latestVersion}`, "extensions");
        }
        setUpdates((prev) => prev.filter((u) => u.id !== id));
      } catch (e) {
        console.error("Failed to update extension:", e);
        addLog(`Failed to update ${update.name}: ${String(e)}`, "extensions");
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [updates, onReloadPlugin, addLog],
  );

  const updateAll = useCallback(async () => {
    const available = updates.filter((u) => u.status === "available");
    for (const update of available) {
      await updateExtension(update.id);
    }
  }, [updates, updateExtension]);

  const installFromGallery = useCallback(
    async (entry: GalleryPluginEntry | GallerySkinEntry) => {
      setInstalling((prev) => new Set(prev).add(entry.id));
      try {
        if ("files" in entry) {
          const result = await onInstallPluginFromGallery(
            entry as GalleryPluginEntry,
          );
          if (result.ok) {
            addLog(`Installed plugin ${entry.name}`, "extensions");
          } else {
            addLog(`Failed to install ${entry.name}: ${result.error}`, "extensions");
          }
        } else {
          const result = await onInstallSkinFromGallery(
            entry as GallerySkinEntry,
          );
          if (result.ok) {
            addLog(`Installed skin ${entry.name}`, "extensions");
          } else {
            addLog(`Failed to install ${entry.name}: ${result.error}`, "extensions");
          }
        }
      } finally {
        setInstalling((prev) => {
          const next = new Set(prev);
          next.delete(entry.id);
          return next;
        });
      }
    },
    [onInstallPluginFromGallery, onInstallSkinFromGallery, addLog],
  );

  const uninstall = useCallback(
    async (id: string, kind: "plugin" | "skin") => {
      try {
        if (kind === "plugin") {
          await onDeletePlugin(id);
          addLog(`Uninstalled plugin ${id}`, "extensions");
        } else {
          onDeleteSkin(id);
          addLog(`Uninstalled skin ${id}`, "extensions");
        }
      } catch (e) {
        console.error("Failed to uninstall:", e);
        addLog(`Failed to uninstall ${id}: ${String(e)}`, "extensions");
      }
    },
    [onDeletePlugin, onDeleteSkin, addLog],
  );

  const toggleEnabled = useCallback(
    (id: string, kind: "plugin" | "skin") => {
      if (kind === "plugin") {
        onTogglePlugin(id);
      } else {
        onApplySkin(id);
      }
    },
    [onTogglePlugin, onApplySkin],
  );

  const installFromUrl = useCallback(
    async (url: string) => {
      try {
        const pluginId = await invoke<string>("install_plugin_from_url", { url });
        addLog(`Installed plugin ${pluginId} from URL`, "extensions");
        onReloadAllPlugins();
      } catch (e) {
        console.error("Failed to install from URL:", e);
        addLog(`Failed to install from URL: ${String(e)}`, "extensions");
      }
    },
    [addLog, onReloadAllPlugins],
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
        source: ps.builtin ? "builtin" : "user",
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
