import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { store } from "../store";
import { BUILTIN_SKINS } from "../skins";
import { generateSkinCSS } from "../skinUtils";
import type { SkinInfo, GallerySkinEntry } from "../types/skin";

const STYLE_ID = "viboplr-skin";
const GALLERY_BASE_URL = "https://raw.githubusercontent.com/outcast1000/viboplr-skins/main/";

function injectSkinCSS(skin: SkinInfo) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = generateSkinCSS(skin.colors, skin.customCSS);
  document.documentElement.dataset.skinType = skin.type;
}

export function useSkins() {
  const [activeSkinId, setActiveSkinId] = useState("default");
  const [userSkins, setUserSkins] = useState<SkinInfo[]>([]);
  const [gallerySkins, setGallerySkins] = useState<GallerySkinEntry[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);

  const installedSkins: SkinInfo[] = [...BUILTIN_SKINS, ...userSkins];
  const activeSkin = installedSkins.find(s => s.id === activeSkinId) || BUILTIN_SKINS[0];

  // Load saved skin ID and user skins on mount
  useEffect(() => {
    (async () => {
      const savedId = await store.get<string>("skin");
      if (savedId) setActiveSkinId(savedId);

      try {
        const list = await invoke<Record<string, unknown>[]>("list_user_skins");
        setUserSkins(list.map(s => ({ ...s, source: "user" } as SkinInfo)));
      } catch {
        // No user skins yet
      }
    })();
  }, []);

  // Apply skin whenever activeSkin changes
  useEffect(() => {
    injectSkinCSS(activeSkin);
  }, [activeSkin]);

  const applySkin = useCallback((id: string) => {
    setActiveSkinId(id);
    store.set("skin", id);
  }, []);

  const refreshUserSkins = useCallback(async () => {
    try {
      const list = await invoke<Record<string, unknown>[]>("list_user_skins");
      setUserSkins(list.map(s => ({ ...s, source: "user" } as SkinInfo)));
    } catch {
      // ignore
    }
  }, []);

  const importSkin = useCallback(async (path: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const id = await invoke<string>("import_skin_file", { path });
      await refreshUserSkins();
      applySkin(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, [applySkin, refreshUserSkins]);

  const deleteSkin = useCallback(async (id: string) => {
    await invoke("delete_user_skin", { id });
    await refreshUserSkins();
    if (activeSkinId === id) {
      applySkin("default");
    }
  }, [activeSkinId, applySkin, refreshUserSkins]);

  const fetchGallery = useCallback(async () => {
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const json = await invoke<string>("fetch_skin_gallery");
      const index = JSON.parse(json);
      setGallerySkins(index.skins || []);
    } catch (e) {
      setGalleryError(String(e));
    } finally {
      setGalleryLoading(false);
    }
  }, []);

  const installFromGallery = useCallback(async (entry: GallerySkinEntry): Promise<{ ok: boolean; error?: string }> => {
    try {
      const url = GALLERY_BASE_URL + entry.file;
      const id = await invoke<string>("install_gallery_skin", { url });
      await refreshUserSkins();
      applySkin(id);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }, [applySkin, refreshUserSkins]);

  return {
    activeSkinId,
    activeSkin,
    installedSkins,
    applySkin,
    importSkin,
    deleteSkin,
    gallerySkins,
    galleryLoading,
    galleryError,
    fetchGallery,
    installFromGallery,
  };
}
