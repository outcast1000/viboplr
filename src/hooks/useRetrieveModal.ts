import { useCallback, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import type { InfoEntity, InfoFetchResult, DisplayKind } from "../types/informationTypes";
import { buildEntityKey } from "../types/informationTypes";
import type { ImageFetchResult } from "../types/plugin";

// Centered, cancelable "Retrieve" modal for user-triggered image & info fetches.
//
// Model (matches how the background chain already works, but visible + pausable):
//   - The modal runs the provider chain AUTOMATICALLY (auto-fallback). Each
//     provider is shown as a checklist row that ticks pending → fetching →
//     found / not found / error.
//   - When a provider returns a result the chain PAUSES, previews it, and starts
//     a grace countdown. Do nothing → it auto-applies & closes. "Try next"
//     rejects this result and resumes the chain at the next provider. "Apply now"
//     commits immediately. "Keep open" cancels the countdown so it waits.
//   - If every provider is exhausted with nothing usable → an "exhausted" state
//     with a close countdown (also defeatable via Keep open).
//
// Nothing is persisted until apply (auto or manual). A monotonic `genRef` stale-
// guards in-flight fetches across try-next / cancel / close.

const GRACE_SECS = 10;       // paused-with-result → auto-apply
const EXHAUSTED_SECS = 10;   // all providers failed → auto-close
const APPLIED_CLOSE_MS = 1400; // show "✓ Applied" briefly, then close

export type ProviderStatus = "pending" | "fetching" | "found" | "not_found" | "error";

export interface ProviderRow {
  id: string;
  name: string;
  pluginId?: string;
  integerId?: number;   // info: type integer id to upsert against
  embedded?: boolean;   // synthetic album "embedded artwork" source
  status: ProviderStatus;
}

/** A fetched-but-not-yet-saved image, ready to preview + apply. */
export interface ImagePreview {
  src: string;
  save:
    | { kind: "url"; url: string; headers?: Record<string, string> }
    | { kind: "data"; data: string }
    | { kind: "embedded" };
}

export type RetrievePhase =
  | "running"    // walking the chain, no result yet to show
  | "paused"     // a provider returned a result; previewing + grace countdown
  | "applying"   // committing the chosen result
  | "applied"    // done
  | "exhausted"; // all providers tried, nothing usable

export interface RetrieveModalData {
  kind: "image" | "info";
  label: string;
  title: string;
  entityKind: "artist" | "album" | "tag" | "track";
  name: string;
  artistName?: string | null;
  albumTitle?: string | null;
  displayKind?: DisplayKind;
  infoTypeId?: string;
  providers: ProviderRow[];
  currentIndex: number;
  phase: RetrievePhase;
  imagePreview?: ImagePreview;
  infoPreview?: Record<string, unknown>;
  /** Seconds left in the active countdown, or null when none is running. */
  countdown: number | null;
  keepOpen: boolean;
  message?: string;
}

type InvokeInfoFetch = (
  pluginId: string, infoTypeId: string, entity: InfoEntity, onFetchUrl?: (url: string) => void,
) => Promise<InfoFetchResult>;
type InvokeImageFetch = (
  pluginId: string, entity: "artist" | "album" | "tag", name: string, artistName?: string,
) => Promise<ImageFetchResult>;

export interface OpenImageArgs {
  kind: "artist" | "album" | "tag";
  name: string;
  artistName?: string | null;
  providers: Array<[string, number, number]>; // [pluginId, priority, integerId]
  pluginNames: Map<string, string>;
}
export interface OpenInfoArgs {
  infoTypeId: string;
  label: string;
  displayKind: DisplayKind;
  entity: InfoEntity;
  providers: Array<[string, number]>; // [pluginId, integerId]
  pluginNames: Map<string, string>;
}

export interface UseRetrieveModalReturn {
  modal: RetrieveModalData | null;
  openImage: (args: OpenImageArgs) => void;
  openInfo: (args: OpenInfoArgs) => void;
  tryNext: () => void;
  applyNow: () => void;
  cancel: () => void;
  setKeepOpen: (keep: boolean) => void;
}

function entityTitle(name: string, artistName?: string | null): string {
  return artistName ? `${name} · ${artistName}` : name;
}
function imageLabel(kind: "artist" | "album" | "tag"): string {
  if (kind === "album") return "Retrieve album art";
  if (kind === "artist") return "Retrieve artist image";
  return "Retrieve tag image";
}

interface FetchOutcome {
  ok: boolean;
  status: ProviderStatus;
  imagePreview?: ImagePreview;
  infoPreview?: Record<string, unknown>;
}

export function useRetrieveModal(
  invokeImageFetch: InvokeImageFetch,
  invokeInfoFetch: InvokeInfoFetch,
): UseRetrieveModalReturn {
  const [modal, setModal] = useState<RetrieveModalData | null>(null);
  const modalRef = useRef<RetrieveModalData | null>(null);
  modalRef.current = modal;

  const genRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const appliedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the active countdown does when it hits 0.
  const countdownModeRef = useRef<"apply" | "close" | null>(null);
  // Forward refs so the countdown tick can call the latest closures.
  const applyNowRef = useRef<() => void>(() => {});
  const closeRef = useRef<() => void>(() => {});

  const clearTick = useCallback(() => {
    if (tickRef.current) { clearInterval(tickRef.current); tickRef.current = null; }
    countdownModeRef.current = null;
  }, []);

  const clearAppliedTimer = useCallback(() => {
    if (appliedTimerRef.current) { clearTimeout(appliedTimerRef.current); appliedTimerRef.current = null; }
  }, []);

  const close = useCallback(() => {
    genRef.current++;
    clearTick();
    clearAppliedTimer();
    setModal(null);
  }, [clearTick, clearAppliedTimer]);
  closeRef.current = close;

  const startCountdown = useCallback((seconds: number, mode: "apply" | "close") => {
    clearTick();
    countdownModeRef.current = mode;
    setModal((m) => m && { ...m, countdown: seconds });
    tickRef.current = setInterval(() => {
      setModal((m) => {
        if (!m) return m;
        const next = (m.countdown ?? 0) - 1;
        if (next <= 0) {
          clearTick();
          const fire = mode;
          queueMicrotask(() => { if (fire === "apply") applyNowRef.current(); else closeRef.current(); });
          return { ...m, countdown: 0 };
        }
        return { ...m, countdown: next };
      });
    }, 1000);
  }, [clearTick]);

  // ── Single-provider fetch ─────────────────────────────────
  const fetchProvider = useCallback(async (data: RetrieveModalData, provider: ProviderRow, gen: number): Promise<FetchOutcome> => {
    try {
      if (data.kind === "image") {
        const k = data.entityKind as "artist" | "album" | "tag";
        if (provider.embedded) {
          const path = await invoke<string>("extract_embedded_album_image", {
            albumTitle: data.name, artistName: data.artistName ?? null,
          });
          if (gen !== genRef.current) return { ok: false, status: "error" };
          return { ok: true, status: "found", imagePreview: { src: `${convertFileSrc(path)}#g=${gen}`, save: { kind: "embedded" } } };
        }
        const result = await invokeImageFetch(provider.pluginId!, k, data.name, data.artistName ?? undefined);
        if (gen !== genRef.current) return { ok: false, status: "error" };
        if (result.status === "ok") {
          if ("data" in result) return { ok: true, status: "found", imagePreview: { src: `data:image/*;base64,${result.data}`, save: { kind: "data", data: result.data } } };
          return { ok: true, status: "found", imagePreview: { src: result.url, save: { kind: "url", url: result.url, headers: result.headers } } };
        }
        return { ok: false, status: result.status === "not_found" ? "not_found" : "error" };
      } else {
        const entity: InfoEntity = {
          kind: data.entityKind, name: data.name, id: 0,
          artistName: data.artistName ?? undefined, albumTitle: data.albumTitle ?? undefined,
        };
        const result = await invokeInfoFetch(provider.pluginId!, data.infoTypeId!, entity);
        if (gen !== genRef.current) return { ok: false, status: "error" };
        if (result.status === "ok") return { ok: true, status: "found", infoPreview: result.value };
        return { ok: false, status: result.status === "not_found" ? "not_found" : "error" };
      }
    } catch (e) {
      console.error("Retrieve provider fetch failed:", e);
      return { ok: false, status: "error" };
    }
  }, [invokeImageFetch, invokeInfoFetch]);

  const setProviderStatus = useCallback((index: number, status: ProviderStatus, gen: number) => {
    setModal((m) => {
      if (!m || gen !== genRef.current) return m;
      return { ...m, providers: m.providers.map((p, i) => (i === index ? { ...p, status } : p)) };
    });
  }, []);

  // ── Chain walker ──────────────────────────────────────────
  const advanceChain = useCallback(async (data: RetrieveModalData, startIndex: number, gen: number) => {
    for (let i = startIndex; i < data.providers.length; i++) {
      if (gen !== genRef.current) return;
      setModal((m) => m && { ...m, currentIndex: i, phase: "running", countdown: null });
      setProviderStatus(i, "fetching", gen);
      const outcome = await fetchProvider(data, data.providers[i], gen);
      if (gen !== genRef.current) return;
      setProviderStatus(i, outcome.status, gen);
      if (outcome.ok) {
        setModal((m) => m && {
          ...m,
          currentIndex: i,
          phase: "paused",
          imagePreview: outcome.imagePreview,
          infoPreview: outcome.infoPreview,
        });
        const keepOpen = modalRef.current?.keepOpen ?? false;
        if (keepOpen) setModal((m) => m && { ...m, countdown: null });
        else startCountdown(GRACE_SECS, "apply");
        return;
      }
    }
    // Exhausted — nothing usable from any provider.
    if (gen !== genRef.current) return;
    setModal((m) => m && { ...m, phase: "exhausted", imagePreview: undefined, infoPreview: undefined, message: "No result found from any provider" });
    const keepOpen = modalRef.current?.keepOpen ?? false;
    if (keepOpen) setModal((m) => m && { ...m, countdown: null });
    else startCountdown(EXHAUSTED_SECS, "close");
  }, [fetchProvider, setProviderStatus, startCountdown]);

  // ── Public openers ────────────────────────────────────────
  const openImage = useCallback((args: OpenImageArgs) => {
    const providers: ProviderRow[] = [];
    if (args.kind === "album") providers.push({ id: "__embedded__", name: "Embedded artwork (audio file)", embedded: true, status: "pending" });
    for (const [pluginId, , integerId] of args.providers) {
      providers.push({ id: pluginId, name: args.pluginNames.get(pluginId) ?? pluginId, pluginId, integerId, status: "pending" });
    }
    const data: RetrieveModalData = {
      kind: "image",
      label: imageLabel(args.kind),
      title: entityTitle(args.name, args.kind === "album" ? args.artistName : null),
      entityKind: args.kind, name: args.name, artistName: args.artistName ?? null,
      providers, currentIndex: 0,
      phase: providers.length ? "running" : "exhausted",
      countdown: null, keepOpen: false,
      message: providers.length ? undefined : "No image providers enabled",
    };
    const gen = ++genRef.current;
    clearTick(); clearAppliedTimer();
    setModal(data);
    if (providers.length) void advanceChain(data, 0, gen);
  }, [advanceChain, clearTick, clearAppliedTimer]);

  const openInfo = useCallback((args: OpenInfoArgs) => {
    const providers: ProviderRow[] = args.providers.map(([pluginId, integerId]) => ({
      id: pluginId, name: args.pluginNames.get(pluginId) ?? pluginId, pluginId, integerId, status: "pending",
    }));
    const data: RetrieveModalData = {
      kind: "info",
      label: `Retrieve ${args.label}`,
      title: entityTitle(args.entity.name, args.entity.artistName ?? null),
      entityKind: args.entity.kind, name: args.entity.name,
      artistName: args.entity.artistName ?? null, albumTitle: args.entity.albumTitle ?? null,
      displayKind: args.displayKind, infoTypeId: args.infoTypeId,
      providers, currentIndex: 0,
      phase: providers.length ? "running" : "exhausted",
      countdown: null, keepOpen: false,
      message: providers.length ? undefined : "No providers for this information",
    };
    const gen = ++genRef.current;
    clearTick(); clearAppliedTimer();
    setModal(data);
    if (providers.length) void advanceChain(data, 0, gen);
  }, [advanceChain, clearTick, clearAppliedTimer]);

  // ── Try next (reject current, resume chain) ───────────────
  const tryNext = useCallback(() => {
    const m = modalRef.current;
    if (!m || m.phase !== "paused") return;
    clearTick();
    const gen = ++genRef.current;
    void advanceChain({ ...m, countdown: null }, m.currentIndex + 1, gen);
  }, [clearTick, advanceChain]);

  // ── Apply (persist current paused result) ─────────────────
  const applyNow = useCallback(() => {
    const m = modalRef.current;
    if (!m || m.phase !== "paused") return;
    clearTick();
    const gen = ++genRef.current;
    setModal((cur) => cur && { ...cur, phase: "applying", countdown: null });
    void (async () => {
      try {
        if (m.kind === "image" && m.imagePreview) {
          const save = m.imagePreview.save;
          if (save.kind === "embedded") {
            const path = await invoke<string>("extract_embedded_album_image", { albumTitle: m.name, artistName: m.artistName ?? null });
            await invoke("set_entity_image", { kind: m.entityKind, name: m.name, artistName: m.artistName ?? null, sourcePath: path });
          } else {
            await invoke("save_entity_image_from_provider", {
              kind: m.entityKind, name: m.name, artistName: m.artistName ?? null,
              url: save.kind === "url" ? save.url : null,
              headers: save.kind === "url" ? (save.headers ?? null) : null,
              data: save.kind === "data" ? save.data : null,
            });
          }
          window.dispatchEvent(new CustomEvent("retrieve:image-applied", {
            detail: { kind: m.entityKind, name: m.name, artistName: m.artistName ?? null },
          }));
        } else if (m.kind === "info" && m.infoPreview) {
          const provider = m.providers[m.currentIndex];
          const entity: InfoEntity = {
            kind: m.entityKind, name: m.name, id: 0,
            artistName: m.artistName ?? undefined, albumTitle: m.albumTitle ?? undefined,
          };
          await invoke("info_upsert_value", {
            informationTypeId: provider?.integerId ?? 0,
            entityKey: buildEntityKey(entity),
            value: JSON.stringify(m.infoPreview),
            status: "ok",
          });
          window.dispatchEvent(new CustomEvent("retrieve:info-applied", {
            detail: { infoTypeId: m.infoTypeId, entityKey: buildEntityKey(entity) },
          }));
        }
        if (gen !== genRef.current) return;
        setModal((cur) => cur && { ...cur, phase: "applied", message: "Applied", countdown: null });
        appliedTimerRef.current = setTimeout(() => closeRef.current(), APPLIED_CLOSE_MS);
      } catch (e) {
        if (gen !== genRef.current) return;
        console.error("Retrieve apply failed:", e);
        setModal((cur) => cur && { ...cur, phase: "exhausted", message: e instanceof Error ? e.message : String(e), countdown: null });
      }
    })();
  }, [clearTick]);
  applyNowRef.current = applyNow;

  const setKeepOpen = useCallback((keep: boolean) => {
    setModal((m) => {
      if (!m) return m;
      if (keep) {
        clearTick();
        return { ...m, keepOpen: true, countdown: null };
      }
      // Re-arm the appropriate countdown for the current phase.
      if (m.phase === "paused") startCountdown(GRACE_SECS, "apply");
      else if (m.phase === "exhausted") startCountdown(EXHAUSTED_SECS, "close");
      return { ...m, keepOpen: false };
    });
  }, [clearTick, startCountdown]);

  return { modal, openImage, openInfo, tryNext, applyNow, cancel: close, setKeepOpen };
}
