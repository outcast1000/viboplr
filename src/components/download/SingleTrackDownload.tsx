import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { subscribe } from "../../utils/tauriEvents";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  InteractiveSearchResult,
  DownloadResolveResult,
  DownloadQualityOption,
  DownloadResolveProgress,
  DownloadPreview,
} from "../../types/plugin";
import type { Track } from "../../types";
import { formatDuration, formatFileSize, isVideoTrack } from "../../utils";
import { defaultQualityValue } from "../../utils/downloadQuality";
import {
  DOWNLOAD_QUALITY_MEMORY_KEY,
  coerceQualityMemory,
  rememberQuality,
  rememberedQuality,
  type DownloadQualityMemory,
} from "../../utils/downloadQualityMemory";
import {
  describeFileQuality,
  formatLength,
  judgeUpgrade,
  numberedPath,
  type FileAudioFacts,
} from "../../utils/downloadCompare";
import type { AppStore } from "../../store";
import type { DownloadPlan, ResolveTrack } from "../../utils/downloadPlan";
import type { DownloadTrack, UpgradePreviewInfo, ConflictCheck, DownloadResult } from "./types";
import { ProviderChip } from "./ProviderChip";
import { QualitySelect } from "./QualitySelect";
import { DestField, DOWNLOAD_LAYOUT_KEY, coerceDownloadLayout, type DownloadLayout } from "./DestField";
import { IconDownload } from "../Icons";
import { TrackArtFallback } from "../TrackArtFallback";
import { resolveImageUrl, resolveImageSrc } from "../../utils/resolveImageUrl";

import { useAssignRef, useLatestRef } from "../../hooks/useLatestRef";
type SingleStep = "search" | "configure" | "conflict" | "downloading" | "result";

/** mm:ss for a live counter. Unlike `formatDuration`, zero is a real value here
 *  (a resolve that just started, an ETA of "any moment") rather than missing
 *  data, so it must not render as "--:--". */
function formatElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** A provider's `quality` line, or null. Plugin-supplied, so it is held to one
 *  short line of text whatever the provider sent. */
function qualityLine(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

/** Folder name of a path, for "Saving to Music". */
function lastSegment(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Same shape as the conflict check's own flat name, for when it can't answer. */
function flatFallbackPath(dir: string, artist: string, title: string, ext: string): string {
  const clean = (s: string) => s.replace(/[/\\:*?"<>|]/g, "_").trim() || "Unknown";
  return `${dir}/${clean(artist)} - ${clean(title)}.${ext}`;
}

export function SingleTrackDownload({
  track,
  providerId,
  providerName,
  resolveTrack,
  preview,
  resolveMatch,
  search,
  qualityOptions,
  collections,
  store,
  lastDest,
  onSearch,
  onResolve,
  onCancelResolve,
  onClose,
  onComplete,
  onPlay,
}: {
  track: DownloadTrack;
  /** Keys the remembered quality. */
  providerId?: string;
  providerName: string;
  /** How to fetch this exact track (a `DownloadPlan.resolve`). Present: start
   *  on the configure step and call it. Absent: the provider's interactive
   *  search. This prop alone decides the mode, never `track.uri`, which a
   *  metadata plan doesn't have (see `DownloadModalState.resolveTrack`). */
  resolveTrack?: ResolveTrack;
  /** The plan's preview / pick-another half (see `DownloadPlan`). Used with
   *  `resolveTrack` only — a plan-less modal has `onSearch` / `onResolve`. */
  preview?: DownloadPlan["preview"];
  resolveMatch?: DownloadPlan["resolveMatch"];
  search?: DownloadPlan["search"];
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  onSearch: (query: string, limit: number) => Promise<InteractiveSearchResult[]>;
  onResolve: (
    matchId: string,
    format: string,
    onProgress?: (progress: DownloadResolveProgress) => void,
  ) => Promise<DownloadResolveResult>;
  /** Stop whatever the provider is doing for an in-flight resolve. Required for
   *  providers that download the file themselves — without it, cancelling the
   *  modal leaves a yt-dlp/ffmpeg run going with nothing left to receive it. */
  onCancelResolve?: () => void;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
}) {
  const directUri = !!resolveTrack;
  // In plan mode the search and the match resolve are the plan's own (absent
  // when the provider has none); otherwise the modal's provider callbacks.
  const searchFn = directUri ? search : onSearch;
  const resolveMatchFn = directUri ? resolveMatch : onResolve;
  const [step, setStep] = useState<SingleStep>(directUri ? "configure" : "search");
  const [searchQuery, setSearchQuery] = useState(
    [track.title, track.artistName].filter(Boolean).join(" ")
  );
  const [results, setResults] = useState<InteractiveSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Configure state
  const [selectedMatch, setSelectedMatch] = useState<InteractiveSearchResult | null>(() => {
    if (directUri) {
      return {
        id: track.uri ?? "",
        title: track.title,
        artistName: track.artistName ?? undefined,
        albumTitle: track.albumTitle ?? undefined,
        durationSecs: track.durationSecs ?? undefined,
      };
    }
    return null;
  });
  // In plan mode: true once `selectedMatch` is an item the provider named (its
  // preview, or a pick from its search). The download then fetches exactly
  // that item instead of letting the plan look for one again.
  const [matchIsPicked, setMatchIsPicked] = useState(false);
  const [previewState, setPreviewState] = useState<"idle" | "loading" | "done">(directUri && preview ? "loading" : "idle");
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewQualities, setPreviewQualities] = useState<DownloadQualityOption[] | null>(null);

  // No provider declared quality options — offer the source as-is rather than a
  // re-encode this (direct) path can't actually perform. The saved extension is
  // the resolver's own `ext`; when it reports none the backend names the file
  // from its first bytes.
  const defaultQualities: DownloadQualityOption[] = [
    {
      value: "original",
      label: "Original (source format)",
      description: "Downloads the file exactly as the provider serves it — no re-encode.",
    },
  ];
  const providerQualities = previewQualities && previewQualities.length > 0
    ? previewQualities
    : qualityOptions && qualityOptions.length > 0 ? qualityOptions : null;
  const qualities = providerQualities ?? defaultQualities;
  const hasProviderQualities = !!providerQualities;
  // Last-resort extension when the resolver reports none. `download_to_path`
  // renames a `.bin` from the file's first bytes.
  const nativeFallback: string | null = hasProviderQualities ? null : "bin";

  // A video track defaults to the provider's video quality option (downloading a
  // video you're watching should yield the video, not its audio). The user's
  // last choice for this provider and kind wins over that default.
  const trackIsVideo = track.isVideo ?? isVideoTrack({ format: null, path: track.uri ?? null });
  const [qualityMemory, setQualityMemory] = useState<DownloadQualityMemory | null>(null);
  const qualityMemoryRef = useLatestRef(qualityMemory);
  const userPickedQualityRef = useRef(false);
  const pickDefaultQuality = (list: DownloadQualityOption[], memory: DownloadQualityMemory | null): string =>
    (providerId ? rememberedQuality(memory, providerId, trackIsVideo, list) : null)
      ?? defaultQualityValue(list, trackIsVideo)
      ?? "original";
  const [quality, setQualityState] = useState<string>(() => pickDefaultQuality(qualities, null));
  const setQuality = (q: string) => {
    userPickedQualityRef.current = true;
    setQualityState(q);
  };
  const remembered = providerId ? rememberedQuality(qualityMemory, providerId, trackIsVideo, qualities) : null;

  useEffect(() => {
    store.get<unknown>(DOWNLOAD_QUALITY_MEMORY_KEY)
      .then((raw) => setQualityMemory(coerceQualityMemory(raw)))
      .catch((e) => {
        console.error("Failed to read the remembered download quality:", e);
        setQualityMemory({});
      });
  }, [store]);

  // The option list can change under the picker (memory loaded, a preview
  // arrived with this item's real list). Until the user picks, follow the
  // default; after, keep their pick while the list still offers it.
  const qualityListKey = qualities.map((q) => q.value).join("|");
  useEffect(() => {
    setQualityState((cur) => {
      if (userPickedQualityRef.current && qualities.some((q) => q.value === cur)) return cur;
      return pickDefaultQuality(qualities, qualityMemory);
    });
  }, [qualityListKey, qualityMemory]); // eslint-disable-line react-hooks/exhaustive-deps

  // Determine if this is an upgrade flow. Replacing a track's file in place only
  // makes sense for a LOCAL library track (there's a real file on disk to compare
  // against and overwrite). A remote source — Subsonic (`subsonic://`) or a plugin
  // scheme — has no local file: `download_preview` errors ("Track has no local
  // file path"), so those are always a fresh download to a chosen destination.
  const trackIsLocal = !!track.uri && track.uri.startsWith("file://");
  const isUpgrade = track.trackId != null && trackIsLocal;
  const [showDestPicker, setShowDestPicker] = useState(!isUpgrade);
  const [destType, setDestType] = useState<"collection" | "path">("collection");
  const [destCollectionId, setDestCollectionId] = useState<number | null>(() => {
    if (lastDest) {
      const parsed = parseInt(lastDest, 10);
      if (!isNaN(parsed) && collections.some(c => c.id === parsed)) return parsed;
    }
    return collections.length > 0 ? collections[0].id : null;
  });
  const [destPath, setDestPath] = useState<string | null>(null);
  const [layout, setLayoutState] = useState<DownloadLayout>("artist-album");
  useEffect(() => {
    store.get<unknown>(DOWNLOAD_LAYOUT_KEY)
      .then((v) => setLayoutState(coerceDownloadLayout(v)))
      .catch((e) => console.error("Failed to read the download folder layout:", e));
  }, [store]);
  const setLayout = (l: DownloadLayout) => {
    setLayoutState(l);
    store.set(DOWNLOAD_LAYOUT_KEY, l);
  };

  // A copy the user already has, found by metadata — a warning, not a block.
  const [ownedCopy, setOwnedCopy] = useState<Track | null>(null);
  useEffect(() => {
    if (isUpgrade || track.trackId != null || !track.title) return;
    let cancelled = false;
    invoke<Track | null>("find_track_by_metadata", {
      title: track.title,
      artistName: track.artistName ?? null,
      albumName: null,
    })
      .then((t) => {
        if (cancelled || !t) return;
        if (track.uri && t.path === track.uri) return;
        setOwnedCopy(t);
      })
      .catch((e) => console.error("Failed to check the library for this track:", e));
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask the provider what it would fetch before fetching anything.
  useEffect(() => {
    if (!directUri || !preview) return;
    let cancelled = false;
    preview({ isVideo: trackIsVideo })
      .then((p: DownloadPreview | null) => {
        if (cancelled) return;
        if (p && p.match && resolveMatch) {
          const list = Array.isArray(p.qualities) && p.qualities.length > 0 ? p.qualities : null;
          setSelectedMatch(p.match);
          setMatchIsPicked(true);
          setPreviewNote(qualityLine(p.note));
          setPreviewQualities(list);
          // In the same update as the list, so Download can't fire in between
          // with an option the new list doesn't have.
          if (list && !userPickedQualityRef.current) setQualityState(pickDefaultQuality(list, qualityMemoryRef.current));
        }
        setPreviewState("done");
      })
      .catch((e) => {
        if (cancelled) return;
        // The download can still go ahead the old way; say why there's no preview.
        console.error("Download preview failed:", e);
        setPreviewNote(`Couldn't check what will be downloaded: ${e instanceof Error ? e.message : String(e)}`);
        setPreviewState("done");
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Conflict state
  const [conflict, setConflict] = useState<ConflictCheck | null>(null);
  const [resolvedStreamUrl, setResolvedStreamUrl] = useState<string | null>(null);
  const [resolvedCoverUrl, setResolvedCoverUrl] = useState<string | null>(null);
  const [resolvedTitle, setResolvedTitle] = useState<string | null>(null);
  const [resolvedArtist, setResolvedArtist] = useState<string | null>(null);
  const [resolvedAlbum, setResolvedAlbum] = useState<string | null>(null);
  const [resolvedTrackNumber, setResolvedTrackNumber] = useState<number | null>(null);
  // Synchronously-readable twin of the resolved* state above — handleDownload
  // resolves and then keeps working in the same tick, where the just-set state
  // is not yet visible.
  const resolvedMetaRef = useRef<{
    title: string;
    artist: string | null;
    album: string | null;
    trackNumber: number | null;
    coverUrl: string | null;
  } | null>(null);

  // Album/artist art resolved by metadata to fill the configure-step art slot
  // when the provider supplied no cover (e.g. direct-URI streaming downloads) —
  // otherwise the slot would be an empty box. Cache-only read; disc-glyph
  // placeholder when nothing is cached.
  const [metaCoverUrl, setMetaCoverUrl] = useState<string | null>(null);

  // Download state
  const [resolving, setResolving] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // The resolve already produced a file on this machine (yt-dlp, Soulseek), so
  // the "download" step only copies it into place: no second progress bar.
  const [savingLocal, setSavingLocal] = useState(false);
  // What the provider says it's doing. A provider that mints a URL reports
  // nothing and is over in a moment; one that downloads the file itself (yt-dlp
  // fetching a video and merging it with ffmpeg) can run for minutes, and this
  // is the only thing standing between the user and an unexplained spinner.
  const [resolveProgress, setResolveProgress] = useState<DownloadResolveProgress | null>(null);
  const [resolveElapsed, setResolveElapsed] = useState(0);
  // Bumped on every resolve start and on cancel, so a result that lands after
  // the user gave up is dropped instead of driving a download nobody wants.
  const resolveGenRef = useRef(0);

  // Result state
  const [upgradePreview, setUpgradePreview] = useState<UpgradePreviewInfo | null>(null);
  const [upgradeFacts, setUpgradeFacts] = useState<{ old: FileAudioFacts | null; new: FileAudioFacts | null } | null>(null);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  // The provider's own account of what it fetched (DownloadResolveResult.quality)
  // — the picker's option is often a cap the source fell short of.
  const [resolvedQuality, setResolvedQuality] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addedToLibrary, setAddedToLibrary] = useState(false);
  const [libraryAddError, setLibraryAddError] = useState<string | null>(null);

  // Callback refs to avoid stale closures
  const searchFnRef = useRef(searchFn);
  useAssignRef(searchFnRef, searchFn);
  const resolveMatchRef = useRef(resolveMatchFn);
  useAssignRef(resolveMatchRef, resolveMatchFn);

  // Adaptive column detection
  const hasArt = results.some(r => r.coverUrl);
  const hasArtist = results.some(r => r.artistName);
  const hasAlbum = results.some(r => r.albumTitle);
  const hasDuration = results.some(r => r.durationSecs);

  // Auto-search on mount (skipped in direct URI mode)
  const didAutoSearch = useRef(false);
  useEffect(() => {
    if (directUri) return;
    if (didAutoSearch.current) return;
    didAutoSearch.current = true;
    if (!searchQuery) {
      setSearchError("No title or artist to search for");
      return;
    }
    handleSearch(searchQuery);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSearch(query?: string) {
    const q = query ?? searchQuery;
    const fn = searchFnRef.current;
    if (!fn) return;
    setSearching(true);
    setSearchError(null);
    setResults([]);
    try {
      const r = await fn(q, 10);
      setResults(r);
    } catch (e) {
      setSearchError(String(e));
    } finally {
      setSearching(false);
    }
  }

  /** Plan mode: leave the previewed item for the provider's own search. */
  function handleChooseAnother() {
    setError(null);
    setStep("search");
    if (results.length === 0 && !searching) handleSearch(searchQuery);
  }

  // Bumped per picked match, so a slow quality lookup for an earlier pick
  // can't overwrite the list of a later one.
  const pickGenRef = useRef(0);

  function handleSelectMatch(match: InteractiveSearchResult) {
    setSelectedMatch(match);
    setMatchIsPicked(true);
    // The preview's note and option list described the previous item.
    setPreviewNote(null);
    setPreviewQualities(null);
    // A new match invalidates any metadata resolved for the previous one.
    clearResolvedMeta();
    setStep("configure");
    setError(null);
    // Ask what this item really offers, as the first preview did for its item.
    if (directUri && preview && match.id) {
      const gen = ++pickGenRef.current;
      setPreviewState("loading");
      preview({ isVideo: trackIsVideo, uri: match.id })
        .then((p) => {
          if (pickGenRef.current !== gen) return;
          const list = p && Array.isArray(p.qualities) && p.qualities.length > 0 ? p.qualities : null;
          setPreviewQualities(list);
          if (list && !userPickedQualityRef.current) setQualityState(pickDefaultQuality(list, qualityMemoryRef.current));
        })
        .catch((e) => {
          if (pickGenRef.current !== gen) return;
          // The fixed list still works; the download itself will say if the item can't be fetched.
          console.error("Failed to look up the picked match's qualities:", e);
        })
        .finally(() => { if (pickGenRef.current === gen) setPreviewState("done"); });
    }
  }

  function clearResolvedMeta() {
    resolvedMetaRef.current = null;
    setResolvedCoverUrl(null);
    setResolvedTitle(null);
    setResolvedArtist(null);
    setResolvedAlbum(null);
    setResolvedTrackNumber(null);
  }

  /** The names to tag the file with when the provider sends none. In plan mode
   *  that is the track's own: a previewed upload is titled like "Pearl Jam -
   *  Alive (Official Video)", but the file is the user's song. */
  function baseMeta(): { title: string; artist: string | null; album: string | null } {
    if (directUri) {
      return {
        title: track.title,
        artist: track.artistName ?? selectedMatch?.artistName ?? null,
        album: track.albumTitle ?? selectedMatch?.albumTitle ?? null,
      };
    }
    return {
      title: selectedMatch?.title || track.title,
      artist: selectedMatch?.artistName || track.artistName || null,
      album: selectedMatch?.albumTitle || null,
    };
  }

  // The ref is the synchronous source of truth (set in the same tick the
  // resolver answers); the resolved* state mirrors it for render-driven
  // consumers. Reading only the state here dropped the provider's metadata
  // corrections for everything that runs in the tick that resolved them.
  function getEffectiveTitle(): string {
    return resolvedMetaRef.current?.title || resolvedTitle || baseMeta().title;
  }

  function getEffectiveArtist(): string | null {
    return resolvedMetaRef.current?.artist || resolvedArtist || baseMeta().artist;
  }

  function getEffectiveAlbum(): string | null {
    return resolvedMetaRef.current?.album || resolvedAlbum || baseMeta().album;
  }

  function getEffectiveTrackNumber(): number | null {
    return resolvedMetaRef.current?.trackNumber ?? resolvedTrackNumber ?? selectedMatch?.trackNumber ?? null;
  }

  function getEffectiveCoverUrl(): string | null {
    return resolvedMetaRef.current?.coverUrl || resolvedCoverUrl || selectedMatch?.coverUrl || null;
  }

  const selectedOption = qualities.find((q) => q.value === quality);
  const downloadIsVideo = selectedOption?.video === true || (!hasProviderQualities && trackIsVideo);

  async function handleStartDownload() {
    if (!selectedMatch) return;
    setError(null);
    setResolving(true);
    setResolveProgress(null);
    setResolveElapsed(0);
    setResolvedQuality(null);
    setLibraryAddError(null);
    const gen = ++resolveGenRef.current;
    const reportProgress = (p: DownloadResolveProgress) => {
      if (resolveGenRef.current === gen) setResolveProgress(p);
    };
    if (providerId && hasProviderQualities) {
      const next = rememberQuality(qualityMemory, providerId, trackIsVideo, quality);
      if (next !== qualityMemory) {
        setQualityMemory(next);
        store.set(DOWNLOAD_QUALITY_MEMORY_KEY, next);
      }
    }

    // Resolve stream URL and metadata from the provider
    let streamUrl: string;
    let effectiveExt: string | null = null;
    let meta: DownloadResolveResult["metadata"] | undefined;
    try {
      let resolved: DownloadResolveResult | null;
      if (directUri && !matchIsPicked) {
        resolved = await resolveTrack!(quality, reportProgress);
      } else {
        const fn = resolveMatchRef.current;
        if (!fn) throw new Error(`${providerName} can't download a chosen match`);
        resolved = await fn(selectedMatch.id, quality, reportProgress);
      }
      if (resolveGenRef.current !== gen) return;
      if (!resolved) {
        setResolving(false);
        setError(`${providerName} couldn't find this track to download.`);
        return;
      }
      streamUrl = resolved.url;
      effectiveExt = resolved.ext ?? null;
      meta = resolved.metadata ?? undefined;
      setResolvedQuality(qualityLine(resolved.quality));
    } catch (e) {
      // A resolve the user cancelled fails by design — its process was killed.
      // Reporting that as a download error blames the provider for doing what
      // it was told, so the cancel path (which bumped the generation) is silent.
      if (resolveGenRef.current !== gen) return;
      setResolving(false);
      setResolveProgress(null);
      // Providers throw user-facing reasons (e.g. "YouTube rejected the
      // request with a sign-in / bot check") — show the message, not "Error:".
      setError(`Download failed: ${e instanceof Error ? e.message : String(e)}`);
      setStep("configure");
      return;
    }
    setResolveProgress(null);
    setSavingLocal(streamUrl.startsWith("file://"));

    // Effective metadata. Normally the resolver's corrections override the
    // selected match. A plan-mode pick (a preview or a search result) flips
    // that: the provider then describes the upload, and the track's own names
    // are the ones the user asked for. Computed from the response itself and
    // stored in the ref — the conflict check and download below run in this
    // same tick, where reading the just-set resolved* state would still see
    // the old values.
    const base = baseMeta();
    const trackFirst = directUri && matchIsPicked;
    const choose = <T,>(own: T | null | undefined, provided: T | null | undefined): T | null =>
      (trackFirst ? (own || provided) : (provided || own)) ?? null;
    const effective = {
      title: choose(base.title, meta?.title) ?? track.title,
      artist: choose(base.artist, meta?.artist),
      album: choose(base.album, meta?.album),
      trackNumber: meta?.trackNumber ?? selectedMatch.trackNumber ?? null,
      coverUrl: meta?.coverUrl || selectedMatch.coverUrl || null,
    };
    resolvedMetaRef.current = effective;
    setResolvedCoverUrl(effective.coverUrl);
    setResolvedTitle(effective.title);
    setResolvedArtist(effective.artist);
    setResolvedAlbum(effective.album);
    setResolvedTrackNumber(effective.trackNumber);

    // A concrete resolver-provided extension overrides the format default so the
    // saved file matches the real container (e.g. a Subsonic original, or the
    // provider's video container). "auto" means the backend names it from the
    // bytes, so we don't force a name here.
    const concreteExt = effectiveExt && effectiveExt !== "auto" ? effectiveExt : null;

    setResolvedStreamUrl(streamUrl);

    if (isUpgrade && !showDestPicker) {
      // Upgrade path: download preview next to original file
      setStep("downloading");
      setResolving(false);
      try {
        const info = await invoke<UpgradePreviewInfo>("download_preview", {
          trackId: track.trackId,
          streamUrl,
          format: quality,
          ext: concreteExt ?? nativeFallback,
          title: effective.title,
          artistName: effective.artist,
          albumTitle: effective.album,
          trackNumber: effective.trackNumber,
          coverUrl: effective.coverUrl,
        });
        setUpgradePreview(info);
        setStep("result");
        loadUpgradeFacts(info);
      } catch (e) {
        setError(String(e));
        setStep("configure");
      }
      return;
    }

    // Fresh download path: check for conflicts first
    const destDir = resolveDestDir();
    if (!destDir) {
      setResolving(false);
      setError("Please select a destination");
      return;
    }

    try {
      const check = await invoke<ConflictCheck>("check_dest_conflict", {
        artistName: effective.artist ?? "Unknown",
        trackTitle: effective.title,
        destDir,
        format: quality,
        ext: concreteExt ?? nativeFallback,
        albumTitle: effective.album,
        trackNumber: effective.trackNumber,
        isVideo: downloadIsVideo,
        layout,
      });

      if (check.has_conflict) {
        setResolving(false);
        setConflict(check);
        setStep("conflict");
      } else {
        await doFreshDownload(check.dest_path, false, streamUrl, effective.coverUrl ?? undefined);
      }
    } catch (e) {
      // The check failed (an unreadable folder): download to the flat name
      // and let the download itself report a real problem.
      console.error("Failed to check the download destination:", e);
      const ext = concreteExt ?? nativeFallback ?? (quality === "flac" ? "flac" : "m4a");
      await doFreshDownload(flatFallbackPath(destDir, effective.artist ?? "Unknown", effective.title, ext), false, streamUrl, effective.coverUrl ?? undefined);
    }
  }

  async function loadUpgradeFacts(info: UpgradePreviewInfo) {
    const read = (path: string) =>
      invoke<FileAudioFacts>("get_audio_properties_by_path", { path }).catch((e) => {
        console.error("Failed to read audio properties for the compare:", e);
        return null;
      });
    const [oldFacts, newFacts] = await Promise.all([read(info.old_path), read(info.new_path)]);
    setUpgradeFacts({ old: oldFacts, new: newFacts });
  }

  async function doFreshDownload(dp: string, overwrite: boolean, streamUrlArg?: string, coverUrlArg?: string) {
    if (!selectedMatch) return;
    const url = streamUrlArg || resolvedStreamUrl;
    if (!url) {
      setResolving(false);
      setError("No stream URL available");
      return;
    }
    setResolving(false);
    setStep("downloading");
    setDownloadProgress(0);

    // Save last used destination
    const collId = destType === "collection" ? destCollectionId : null;
    store.set("lastDownloadDest", collId != null ? String(collId) : null);

    const cover = coverUrlArg || getEffectiveCoverUrl();

    try {
      const result = await invoke<DownloadResult>("download_to_path", {
        streamUrl: url,
        destPath: dp,
        format: quality,
        overwrite,
        title: getEffectiveTitle(),
        artistName: getEffectiveArtist(),
        albumTitle: getEffectiveAlbum(),
        trackNumber: getEffectiveTrackNumber(),
        coverUrl: cover ?? null,
      });
      setDownloadResult(result);

      // If downloaded to a collection, index it
      if (destType === "collection" && destCollectionId != null) {
        try {
          await invoke("add_downloaded_track", {
            path: result.path,
            collectionId: destCollectionId,
          });
          setAddedToLibrary(true);
        } catch (e) {
          // The file is saved either way; say why it isn't in the library.
          console.error("Failed to add the downloaded file to the library:", e);
          setLibraryAddError(e instanceof Error ? e.message : String(e));
        }
      }

      setStep("result");
    } catch (e) {
      setError(String(e));
      setStep("configure");
    }
  }

  function resolveDestDir(): string | null {
    if (destType === "collection" && destCollectionId != null) {
      const coll = collections.find(c => c.id === destCollectionId);
      return coll?.path ?? null;
    }
    return destPath;
  }

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  function handleConflictReplace() {
    if (conflict) doFreshDownload(conflict.dest_path, true);
  }

  async function handleConflictKeepBoth() {
    if (!conflict) return;
    // The first free "(N)": a second Keep Both must not collide with the first.
    let candidate = numberedPath(conflict.dest_path, 2);
    for (let n = 2; n < 1000; n++) {
      candidate = numberedPath(conflict.dest_path, n);
      try {
        const c = await invoke<ConflictCheck>("check_path_conflict", { destPath: candidate });
        if (!c.has_conflict) break;
      } catch (e) {
        console.error("Failed to check a Keep Both name:", e);
        break;
      }
    }
    doFreshDownload(candidate, false);
  }

  async function handleCancel() {
    // Best-effort cleanup — modal is closing regardless
    if (resolving) {
      // Bump first: the generation guard is what makes the resolve's rejection
      // (and any late success) a no-op rather than an error banner on a modal
      // that is already gone.
      resolveGenRef.current++;
      setResolving(false);
      onCancelResolve?.();
    }
    if (step === "downloading") {
      await invoke("cancel_direct_download").catch(console.error);
    }
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(console.error);
    }
    onClose();
  }

  async function handleReplace() {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke("confirm_track_upgrade", {
        trackId: track.trackId,
        newPath: upgradePreview.new_path,
      });
      onComplete(`Track replaced with ${providerName} version`);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  async function handleSaveAsCopy() {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke("save_track_as_copy", {
        trackId: track.trackId,
        newPath: upgradePreview.new_path,
      });
      onComplete(`${providerName} copy saved alongside original`);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  /** "Back" from the compare or the configure step. A plan-mode modal goes back
   *  to its configure step: it has no search to return to (it never ran one),
   *  and sending it there showed "No matches found" on a track it could
   *  download. */
  async function handleBack() {
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(console.error);
      setUpgradePreview(null);
      setUpgradeFacts(null);
    }
    setResolvedStreamUrl(null);
    clearResolvedMeta();
    if (directUri) {
      setStep("configure");
      return;
    }
    setSelectedMatch(null);
    setStep("search");
  }

  // Fill the configure-step art slot from cached entity art when the provider
  // gave no cover. Cache-only reads via get_entity_image (album → artist),
  // mirroring the queue's name-based chain; failure/empty leaves the disc glyph.
  useEffect(() => {
    if (step !== "configure") { return; }
    if (selectedMatch?.coverUrl || resolvedCoverUrl) { setMetaCoverUrl(null); return; }
    const album = getEffectiveAlbum();
    const artist = getEffectiveArtist();
    if (!artist) { setMetaCoverUrl(null); return; }
    let canceled = false;
    (async () => {
      try {
        let path: string | null = null;
        if (album) {
          path = await invoke<string | null>("get_entity_image", { kind: "album", name: album, artistName: artist });
        }
        if (!path) {
          path = await invoke<string | null>("get_entity_image", { kind: "artist", name: artist, artistName: null });
        }
        if (!canceled) setMetaCoverUrl(resolveImageSrc(path));
      } catch (e) {
        console.error("Failed to resolve download cover art:", e);
      }
    })();
    return () => { canceled = true; };
  }, [step, selectedMatch, resolvedCoverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed seconds for the resolve. A provider that reports no percentage
  // (nothing forces one to) would otherwise leave a spinner that looks
  // identical at 3 seconds and at 3 minutes.
  useEffect(() => {
    if (!resolving) return;
    const started = Date.now();
    const id = setInterval(() => setResolveElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [resolving]);

  // Listen to progress events
  useEffect(() => {
    if (step !== "downloading") return;
    setDownloadProgress(0);
    const eventName = isUpgrade && !showDestPicker
      ? "upgrade-download-progress"
      : "direct-download-progress";
    return subscribe<number>(eventName, (event) => {
      setDownloadProgress(event.payload);
    });
  }, [step, isUpgrade, showDestPicker]);

  // Elapsed is always shown: it is the one fact available for every provider,
  // and it's what separates "slow but moving" from "stuck".
  const resolveDetailLine = [
    resolveProgress?.detail,
    resolveProgress?.etaSecs != null ? `${formatElapsed(resolveProgress.etaSecs)} left` : null,
    `${formatElapsed(resolveElapsed)} elapsed`,
  ].filter(Boolean).join(" · ");

  const destLabel = (() => {
    if (isUpgrade && !showDestPicker) return "your library";
    if (destType === "path" && destPath) return lastSegment(destPath);
    return collections.find((c) => c.id === destCollectionId)?.name ?? "the folder";
  })();

  const verdict = upgradePreview && upgradeFacts
    ? judgeUpgrade(upgradePreview.old_format, upgradeFacts.old, upgradePreview.new_format, upgradeFacts.new)
    : null;
  const oldQuality = upgradePreview ? describeFileQuality(upgradePreview.old_format, upgradeFacts?.old ?? null) : null;
  const newQuality = upgradePreview
    ? resolvedQuality ?? describeFileQuality(upgradePreview.new_format, upgradeFacts?.new ?? null)
    : null;
  const oldLength = formatLength(upgradeFacts?.old?.duration_secs);
  const newLength = formatLength(upgradeFacts?.new?.duration_secs);
  const canChooseAnother = directUri && !!search && !!resolveMatch;
  const checkingPreview = previewState === "loading";

  return (
    <>
      <div className="dl-head">
        <h2>{isUpgrade && !showDestPicker ? "Upgrade track" : "Download track"}</h2>
        <ProviderChip name={providerName} />
      </div>
      {step !== "configure" && (
        <p className="dl-track">
          {track.title}{track.artistName ? ` — ${track.artistName}` : ""}
        </p>
      )}

      {error && <div className="dl-error">{error}</div>}

      {/* SEARCH STEP */}
      {step === "search" && (
        <>
          <div className="dl-search-field">
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
              placeholder={`Search ${providerName}...`}
            />
            <button onClick={() => handleSearch()} disabled={searching}>Search</button>
          </div>
          {searching ? (
            <div className="dl-loading"><div className="ds-spinner" /><span>Searching {providerName}...</span></div>
          ) : searchError ? (
            <div className="dl-error">{searchError}</div>
          ) : results.length === 0 && !searching ? (
            <div className="dl-empty">No matches found on {providerName}</div>
          ) : (
            <div className="dl-results">
              {results.map((t) => (
                <div key={t.id} className="dl-result" onClick={() => handleSelectMatch(t)}>
                  {hasArt && (
                    <div className="dl-result-art">
                      {t.coverUrl ? (
                        <img src={resolveImageUrl(t.coverUrl) ?? undefined} alt="" />
                      ) : (
                        <div className="dl-art-placeholder">
                          <TrackArtFallback track={{ format: null, path: null }} size={18} />
                        </div>
                      )}
                    </div>
                  )}
                  <div className="dl-result-info">
                    <span className="dl-result-title">{t.title}</span>
                    {(hasArtist || hasAlbum) && (
                      <span className="dl-result-meta">
                        {t.artistName}{t.albumTitle ? ` — ${t.albumTitle}` : ""}
                      </span>
                    )}
                  </div>
                  {hasDuration && (
                    <span className="dl-result-duration">
                      {t.durationSecs ? formatDuration(t.durationSecs) : ""}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="dl-actions">
            {/* In plan mode the search is a detour from the configure step. */}
            <button onClick={directUri ? () => setStep("configure") : handleCancel}>
              {directUri ? "Back" : "Cancel"}
            </button>
          </div>
        </>
      )}

      {/* CONFIGURE STEP */}
      {step === "configure" && selectedMatch && (
        <>
          {ownedCopy && (
            <div className="dl-warn">
              You already have this song: {ownedCopy.title}{ownedCopy.artist_name ? ` — ${ownedCopy.artist_name}` : ""}
              {ownedCopy.format ? ` · ${ownedCopy.format.toUpperCase()}` : ""}
              {ownedCopy.collection_name ? ` · in ${ownedCopy.collection_name}` : ""}.
            </div>
          )}
          <div className="dl-selected">
            {(() => {
              const cover = resolveImageUrl(selectedMatch.coverUrl ?? undefined) ?? metaCoverUrl ?? undefined;
              return cover ? (
                <img src={cover} alt="" />
              ) : (
                <div className="dl-selected-ph">
                  <TrackArtFallback track={{ format: null, path: track.uri ?? null }} size={24} />
                </div>
              );
            })()}
            <div className="dl-selected-info">
              <span className="dl-result-title">{selectedMatch.title}</span>
              <span className="dl-result-meta">
                {[
                  selectedMatch.artistName,
                  selectedMatch.albumTitle,
                  matchIsPicked && selectedMatch.durationSecs ? formatDuration(selectedMatch.durationSecs) : null,
                ].filter(Boolean).join(" · ")}
              </span>
              {checkingPreview && (
                <span className="dl-preview-note">
                  <span className="ds-spinner ds-spinner--sm ds-motion-essential" />
                  Checking what {providerName} will download…
                </span>
              )}
              {!checkingPreview && (previewNote || canChooseAnother) && (
                <span className="dl-preview-note">
                  {previewNote}
                  {previewNote && canChooseAnother ? " · " : ""}
                  {canChooseAnother && (
                    <button type="button" className="dl-link" onClick={handleChooseAnother} disabled={resolving}>
                      Choose a different match…
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>

          <div className="dl-config-row">
            <label>Quality</label>
            <span className="dl-qual-stack">
              <QualitySelect qualities={qualities} value={quality} onChange={setQuality} />
              {remembered && remembered === quality && hasProviderQualities && (
                <span className="dl-qual-desc">Your last choice for {providerName} {trackIsVideo ? "videos" : "songs"}</span>
              )}
            </span>
          </div>

          {isUpgrade && !showDestPicker && (
            <button className="dl-save-elsewhere" onClick={() => setShowDestPicker(true)}>
              Save elsewhere instead...
            </button>
          )}

          {showDestPicker && (
            <div className="dl-config-row">
              <label>Save to</label>
              <DestField
                collections={collections}
                destType={destType}
                destCollectionId={destCollectionId}
                destPath={destPath}
                layout={layout}
                onPickCollection={(id) => { setDestType("collection"); setDestCollectionId(id); setDestPath(null); }}
                onBrowse={handleBrowseFolder}
                onLayout={setLayout}
              />
            </div>
          )}

          {resolving && (
            <div className="dl-resolving">
              {typeof resolveProgress?.percent === "number" ? (
                <div className="dl-progress">
                  <div className="dl-progress-bar">
                    <div
                      className="dl-progress-fill"
                      style={{ width: `${Math.max(0, Math.min(100, resolveProgress.percent))}%` }}
                    />
                  </div>
                  <span className="dl-progress-pct">{Math.round(resolveProgress.percent)}%</span>
                </div>
              ) : (
                <div className="ds-spinner ds-spinner--sm" />
              )}
              <span className="dl-resolving-label">
                {resolveProgress?.label || "Preparing download…"}
              </span>
              <span className="dl-resolving-detail">{resolveDetailLine}</span>
            </div>
          )}

          <div className="dl-actions">
            {/* Cancel stays live through the resolve. The provider may be
                downloading the whole file here (see `onCancelResolve`), so a
                disabled button is a trap, not a guard rail. */}
            <button onClick={resolving ? handleCancel : (directUri ? onClose : handleBack)}>
              {resolving || directUri ? "Cancel" : "Back"}
            </button>
            <button className="dl-btn-primary" onClick={handleStartDownload} disabled={resolving || checkingPreview}>
              {!resolving && <IconDownload size={15} />}
              {resolving ? "Working…" : ownedCopy ? "Download anyway" : "Download"}
            </button>
          </div>
        </>
      )}

      {/* CONFLICT STEP */}
      {step === "conflict" && conflict && (
        <>
          <div className="dl-conflict">
            <div className="dl-conflict-filename">
              &ldquo;{conflict.dest_path.split(/[\\/]/).pop()}&rdquo; already exists
            </div>
            <div className="dl-conflict-size">
              Existing file: {conflict.existing_format ?? "Unknown"}, {formatFileSize(conflict.existing_size)}
            </div>
          </div>
          <div className="dl-actions">
            <button onClick={() => { setConflict(null); setStep("configure"); }}>Cancel</button>
            <button className="dl-btn-secondary" onClick={handleConflictKeepBoth}>Keep Both</button>
            <button className="dl-btn-primary" onClick={handleConflictReplace}>Replace</button>
          </div>
        </>
      )}

      {/* DOWNLOADING STEP */}
      {step === "downloading" && (
        <div className="dl-downloading">
          {savingLocal ? (
            // The provider already fetched the file; this is a local copy plus
            // tags. A second 0→100% bar here read as the download starting over.
            <div className="dl-loading"><div className="ds-spinner" /><span>Saving to {destLabel}…</span></div>
          ) : (
            <>
              <div className="dl-loading"><div className="ds-spinner" /><span>Downloading from {providerName}...</span></div>
              <div className="dl-progress">
                <div className="dl-progress-bar">
                  <div className="dl-progress-fill" style={{ width: `${downloadProgress}%` }} />
                </div>
                <span className="dl-progress-pct">{downloadProgress}%</span>
              </div>
            </>
          )}
          <div className="dl-actions">
            <button onClick={handleCancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* RESULT STEP -- Upgrade compare */}
      {step === "result" && upgradePreview && (
        <>
          <h3>Compare files</h3>
          <div className="dl-compare">
            <div className="dl-compare-col">
              <h4>Current file</h4>
              <div className="dl-field">
                <span>Format</span>
                <span>{upgradePreview.old_format?.toUpperCase() ?? "—"}</span>
              </div>
              {oldQuality && (
                <div className="dl-field">
                  <span>Quality</span>
                  <span>{oldQuality}</span>
                </div>
              )}
              {oldLength && (
                <div className="dl-field">
                  <span>Length</span>
                  <span>{oldLength}</span>
                </div>
              )}
              <div className="dl-field">
                <span>Size</span>
                <span>{formatFileSize(upgradePreview.old_file_size)}</span>
              </div>
            </div>
            <div className="dl-compare-arrow">{"→"}</div>
            <div className="dl-compare-col">
              <h4>{providerName} version</h4>
              <div className="dl-field">
                <span>Format</span>
                <span>{upgradePreview.new_format?.toUpperCase() ?? "—"}</span>
              </div>
              {newQuality && (
                <div className="dl-field">
                  <span>Quality</span>
                  <span>{newQuality}</span>
                </div>
              )}
              {newLength && (
                <div className="dl-field">
                  <span>Length</span>
                  <span>{newLength}</span>
                </div>
              )}
              <div className="dl-field">
                <span>Size</span>
                <span>{formatFileSize(upgradePreview.new_file_size)}</span>
              </div>
            </div>
          </div>
          {verdict?.warning && <div className="dl-warn">{verdict.warning}</div>}
          <div className="dl-actions">
            <button onClick={handleBack}>Back</button>
            {/* A downgrade makes keeping both the default; Replace stays one click away. */}
            <button className={verdict?.downgrade ? "dl-btn-secondary" : "dl-btn-primary"} onClick={handleReplace} disabled={confirming}>
              {confirming ? "Replacing..." : "Replace"}
            </button>
            <button className={verdict?.downgrade ? "dl-btn-primary" : "dl-btn-secondary"} onClick={handleSaveAsCopy} disabled={confirming}>
              {confirming ? "Saving..." : "Save as Copy"}
            </button>
            <button onClick={handleCancel}>Cancel</button>
          </div>
        </>
      )}

      {/* RESULT STEP -- Fresh download success */}
      {step === "result" && downloadResult && (
        <>
          <div className="dl-success">
            <h3>Download complete</h3>
            <div className="dl-field">
              <span>Format</span>
              <span>{downloadResult.format}</span>
            </div>
            {resolvedQuality && (
              <div className="dl-field">
                <span>Quality</span>
                <span>{resolvedQuality}</span>
              </div>
            )}
            <div className="dl-field">
              <span>Size</span>
              <span>{formatFileSize(downloadResult.file_size)}</span>
            </div>
            {addedToLibrary && <p>Added to library.</p>}
            {libraryAddError && (
              <div className="dl-warn">
                Saved, but not added to the library: {libraryAddError}. A rescan of the collection picks it up once that's fixed.
              </div>
            )}
            <div className="dl-success-path">{downloadResult.path}</div>
          </div>
          <div className="dl-actions">
            <button onClick={() => invoke("show_in_folder_path", { filePath: downloadResult.path }).catch(console.error)}>
              Show in Folder
            </button>
            {onPlay && (
              <button onClick={() => { onPlay(downloadResult.path); onClose(); }}>
                Play
              </button>
            )}
            <button className="dl-btn-primary" onClick={() => addedToLibrary ? onComplete("Track added to library") : onClose()}>Done</button>
          </div>
        </>
      )}
    </>
  );
}
