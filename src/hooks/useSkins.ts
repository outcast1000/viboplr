import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { store } from "../store";
import { BUILTIN_SKINS } from "../skins";
import { generateSkinCSS, buildStarterSkin, skinSubmissionUrl, validateSkin } from "../skinUtils";
import type { SkinInfo, SkinColors, GallerySkinEntry } from "../types/skin";
import defaultSkin from "../skins/default.json";

const STYLE_ID = "viboplr-skin";
const GALLERY_BASE_URL = "https://raw.githubusercontent.com/outcast1000/viboplr-skins/main/";
// Cache the gallery index so the Extensions panel can paint installable skins
// instantly on open (stale-while-revalidate), instead of waiting on the network.
const GALLERY_CACHE_KEY = "gallerySkinsCache";
// Within this window, reopening the panel serves the loaded index with no fetch.
const GALLERY_TTL_MS = 30 * 60 * 1000;

function injectSkinCSS(skin: SkinInfo) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const colors = { ...defaultSkin.colors, ...skin.colors } as SkinColors;
  el.textContent = generateSkinCSS(colors, skin.customCSS);
  document.documentElement.dataset.skinType = skin.type;
}

export function useSkins() {
  const [activeSkinId, setActiveSkinId] = useState("default");
  const [userSkins, setUserSkins] = useState<SkinInfo[]>([]);
  const [gallerySkins, setGallerySkins] = useState<GallerySkinEntry[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  // Refs backing the TTL guard (see fetchGallery) so reopening the panel is free.
  const gallerySkinsRef = useRef<GallerySkinEntry[]>([]);
  const lastGalleryFetchRef = useRef(0);
  useEffect(() => { gallerySkinsRef.current = gallerySkins; }, [gallerySkins]);

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

      // Hydrate the gallery from the last cached index so the Extensions panel
      // shows installable skins immediately; fetchGallery() then revalidates.
      try {
        const cached = await store.get<GallerySkinEntry[]>(GALLERY_CACHE_KEY);
        if (cached && cached.length) {
          setGallerySkins((prev) => (prev.length ? prev : cached));
        }
      } catch (e) {
        console.error("Failed to read cached skin gallery:", e);
      }
    })();
  }, []);

  // Apply skin whenever activeSkin changes. previewRef tracks a transient hover
  // preview so this effect doesn't clobber it on an unrelated re-render.
  const previewRef = useRef(false);
  useEffect(() => {
    if (previewRef.current) return;
    injectSkinCSS(activeSkin);
  }, [activeSkin]);

  // Live preview: inject a skin's CSS without persisting it as active. Used by
  // the Extensions skins grid on hover; clearPreview() restores the active skin.
  const previewSkin = useCallback((skin: SkinInfo) => {
    previewRef.current = true;
    injectSkinCSS(skin);
  }, []);

  const clearPreview = useCallback(() => {
    previewRef.current = false;
    injectSkinCSS(activeSkin);
  }, [activeSkin]);

  const applySkin = useCallback((id: string) => {
    // A click during hover-preview becomes the real selection; drop the preview
    // guard so the activeSkin effect can re-assert on later renders.
    previewRef.current = false;
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

  const fetchGallery = useCallback(async (force = false) => {
    // Within the TTL, keep the loaded index instead of re-hitting the network so
    // reopening the Skins tab is instant.
    if (
      !force &&
      gallerySkinsRef.current.length > 0 &&
      Date.now() - lastGalleryFetchRef.current < GALLERY_TTL_MS
    ) {
      return;
    }
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const json = await invoke<string>("fetch_skin_gallery");
      const index = JSON.parse(json);
      const entries: GallerySkinEntry[] = index.skins || [];
      setGallerySkins(entries);
      lastGalleryFetchRef.current = Date.now();
      store.set(GALLERY_CACHE_KEY, entries).catch((e) =>
        console.error("Failed to cache skin gallery:", e),
      );
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

  // Open a user skin's JSON file in the OS default editor for .json.
  const openSkinInEditor = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      await invoke("open_skin_in_editor", { id });
      return { ok: true };
    } catch (e) {
      console.error("Failed to open skin in editor:", e);
      return { ok: false, error: String(e) };
    }
  }, []);

  // Create a fresh user skin from the neutral starter template, make it active,
  // and open it in the editor so the author can start tweaking immediately.
  const createSkin = useCallback(async (): Promise<{ ok: boolean; id?: string; error?: string }> => {
    try {
      const skinJson = JSON.stringify(buildStarterSkin(), null, 2);
      const id = await invoke<string>("save_user_skin", { skinJson });
      await refreshUserSkins();
      applySkin(id);
      // Best-effort: a missing default .json handler shouldn't fail skin creation.
      await openSkinInEditor(id);
      return { ok: true, id };
    } catch (e) {
      console.error("Failed to create skin:", e);
      return { ok: false, error: String(e) };
    }
  }, [applySkin, refreshUserSkins, openSkinInEditor]);

  // Re-read a user skin from disk after an external edit, validate it, and
  // re-apply. On invalid edits we keep the previous render and surface the exact
  // validateSkin() reason instead of letting the skin silently vanish from the list.
  const refreshSkin = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const raw = await invoke<string>("read_user_skin", { id });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: `Invalid JSON: ${String(e)}` };
      }
      const v = validateSkin(parsed);
      if (!v.ok) return { ok: false, error: v.error };
      // Reloads all user skins; the activeSkin effect re-injects CSS when the
      // refreshed skin is the active one (new object identity → effect fires).
      await refreshUserSkins();
      return { ok: true };
    } catch (e) {
      console.error("Failed to refresh skin:", e);
      return { ok: false, error: String(e) };
    }
  }, [refreshUserSkins]);

  // Validate, copy the JSON to the clipboard (belt-and-suspenders for large
  // skins), and open the pre-filled gallery submission form.
  const submitSkin = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const raw = await invoke<string>("read_user_skin", { id });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return { ok: false, error: `Invalid JSON: ${String(e)}` };
      }
      const v = validateSkin(parsed);
      if (!v.ok) return { ok: false, error: v.error };
      try {
        await navigator.clipboard.writeText(raw);
      } catch (e) {
        // Non-fatal: the form may still be pre-filled from the URL.
        console.error("Failed to copy skin JSON to clipboard:", e);
      }
      await openUrl(skinSubmissionUrl(raw));
      return { ok: true };
    } catch (e) {
      console.error("Failed to submit skin:", e);
      return { ok: false, error: String(e) };
    }
  }, []);

  return {
    activeSkinId,
    activeSkin,
    installedSkins,
    applySkin,
    previewSkin,
    clearPreview,
    importSkin,
    deleteSkin,
    gallerySkins,
    galleryLoading,
    galleryError,
    fetchGallery,
    installFromGallery,
    createSkin,
    refreshSkin,
    submitSkin,
    openSkinInEditor,
  };
}
