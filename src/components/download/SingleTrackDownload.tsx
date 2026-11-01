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
import { numberedPath, type FileAudioFacts } from "../../utils/downloadCompare";
import type { AppStore } from "../../store";
import type { DownloadPlan } from "../../utils/downloadPlan";
import type { DownloadTrack, UpgradePreviewInfo, ConflictCheck, DownloadResult, DownloadPurpose } from "./types";
import { downloadWording, SOURCE_AS_IS } from "./types";
import { ProviderChip } from "./ProviderChip";
import { QualitySelect } from "./QualitySelect";
import { DestField, DOWNLOAD_LAYOUT_KEY, coerceDownloadLayout, type DownloadLayout } from "./DestField";
import { MatchSearchStep, useMatchSearch } from "./MatchSearch";
import { ResolveProgress } from "./ResolveProgress";
import { UpgradeCompare } from "./UpgradeCompare";
import { IconDownload } from "../Icons";
import { TrackArtFallback } from "../TrackArtFallback";
import { resolveImageUrl, resolveImageSrc } from "../../utils/resolveImageUrl";
import { useLatestRef } from "../../hooks/useLatestRef";

/** `search` is only ever a detour from `configure` ("Choose a different match…"). */
type SingleStep = "configure" | "search" | "conflict" | "downloading" | "result";

/** The names, number and cover the file is tagged with. */
interface EffectiveMeta {
  title: string;
  artist: string | null;
  album: string | null;
  trackNumber: number | null;
  coverUrl: string | null;
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

/**
 * Download one track through a plan (`DownloadPlan`): the plan already knows
 * which track and how to fetch it, so the window opens on its configure step
 * and never has to search for the track. With a provider preview it shows the
 * exact item first; "Choose a different match…" is the only way into the
 * provider's search.
 */
export function SingleTrackDownload({
  track,
  plan,
  qualityOptions,
  collections,
  store,
  lastDest,
  onCancelResolve,
  onClose,
  onComplete,
  onPlay,
  purpose,
}: {
  track: DownloadTrack;
  plan: DownloadPlan;
  qualityOptions?: DownloadQualityOption[] | null;
  collections: { id: number; name: string; path: string }[];
  store: AppStore;
  lastDest: string | null;
  /** Stop whatever the provider is doing for an in-flight resolve. Required for
   *  providers that download the file themselves — without it, cancelling the
   *  modal leaves a yt-dlp/ffmpeg run going with nothing left to receive it. */
  onCancelResolve?: () => void;
  onClose: () => void;
  onComplete: (message: string) => void;
  onPlay?: (path: string) => void;
  /** See `DownloadPurpose` — only the words change. */
  purpose?: DownloadPurpose;
}) {
  const { providerId, providerName, preview, resolveMatch, search } = plan;
  const words = downloadWording(purpose);
  const [step, setStep] = useState<SingleStep>("configure");
  const [error, setError] = useState<string | null>(null);
  const matchSearch = useMatchSearch(search, [track.title, track.artistName].filter(Boolean).join(" "));

  // What will be downloaded. Until the provider names an item (its preview, or
  // a pick from its search) this is the track itself and the plan's own resolve
  // fetches it; once `matchIsPicked`, the download fetches exactly that item.
  const [selectedMatch, setSelectedMatch] = useState<InteractiveSearchResult>(() => ({
    id: track.uri ?? "",
    title: track.title,
    artistName: track.artistName ?? undefined,
    albumTitle: track.albumTitle ?? undefined,
    durationSecs: track.durationSecs ?? undefined,
  }));
  const [matchIsPicked, setMatchIsPicked] = useState(false);
  const [checkingPreview, setCheckingPreview] = useState(!!preview);
  const [previewNote, setPreviewNote] = useState<string | null>(null);
  const [previewQualities, setPreviewQualities] = useState<DownloadQualityOption[] | null>(null);

  // The quality list: the previewed item's own options, else the provider's
  // fixed list, else the source as-is.
  const providerQualities = previewQualities?.length ? previewQualities : qualityOptions?.length ? qualityOptions : null;
  const qualities = providerQualities ?? SOURCE_AS_IS;
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
    rememberedQuality(memory, providerId, trackIsVideo, list)
      ?? defaultQualityValue(list, trackIsVideo)
      ?? "original";
  const [quality, setQualityState] = useState<string>(() => pickDefaultQuality(qualities, null));
  const setQuality = (q: string) => {
    userPickedQualityRef.current = true;
    setQualityState(q);
  };
  /** Follow a new option list until the user picks; set in the same update as
   *  the list, so Download can't fire in between with an option it lacks. */
  const adoptQualities = (list: DownloadQualityOption[] | null) => {
    setPreviewQualities(list);
    if (list && !userPickedQualityRef.current) setQualityState(pickDefaultQuality(list, qualityMemoryRef.current));
  };
  const remembered = rememberedQuality(qualityMemory, providerId, trackIsVideo, qualities);

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

  // Replacing a track's file in place only makes sense for a LOCAL library track
  // (a real file to compare against and overwrite; `download_preview` errors
  // without one). Anything else is a fresh download to a chosen destination —
  // and so is a local one once the user asks to save it elsewhere.
  const isUpgrade = track.trackId != null && !!track.uri?.startsWith("file://");
  const [showDestPicker, setShowDestPicker] = useState(!isUpgrade);
  const inPlaceUpgrade = isUpgrade && !showDestPicker;
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
    if (track.trackId != null || !track.title) return;
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
    if (!preview) return;
    let cancelled = false;
    preview({ isVideo: trackIsVideo })
      .then((p: DownloadPreview | null) => {
        if (cancelled) return;
        if (p?.match && resolveMatch) {
          setSelectedMatch(p.match);
          setMatchIsPicked(true);
          setPreviewNote(qualityLine(p.note));
          adoptQualities(Array.isArray(p.qualities) && p.qualities.length > 0 ? p.qualities : null);
        }
        setCheckingPreview(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // The download can still go ahead the plan's way; say why there's no preview.
        console.error("Download preview failed:", e);
        setPreviewNote(`Couldn't check what will be downloaded: ${e instanceof Error ? e.message : String(e)}`);
        setCheckingPreview(false);
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Set from the provider's answer in the same tick the download continues in,
  // so it is a ref: the conflict check and the download read it right away.
  const resolvedMetaRef = useRef<EffectiveMeta | null>(null);
  const [conflict, setConflict] = useState<{ check: ConflictCheck; streamUrl: string } | null>(null);
  // Album/artist art by name for the configure step's art slot when the
  // provider supplied no cover. Cache-only; the disc glyph when nothing's cached.
  const [metaCoverUrl, setMetaCoverUrl] = useState<string | null>(null);

  const [resolving, setResolving] = useState(false);
  const [resolveProgress, setResolveProgress] = useState<DownloadResolveProgress | null>(null);
  // Bumped on every resolve start and on cancel, so a result that lands after
  // the user gave up is dropped instead of driving a download nobody wants.
  const resolveGenRef = useRef(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  // The resolve already produced a file on this machine (yt-dlp, Soulseek), so
  // the "download" step only copies it into place: no second progress bar.
  const [savingLocal, setSavingLocal] = useState(false);

  const [upgradePreview, setUpgradePreview] = useState<UpgradePreviewInfo | null>(null);
  const [upgradeFacts, setUpgradeFacts] = useState<{ old: FileAudioFacts | null; new: FileAudioFacts | null } | null>(null);
  const [downloadResult, setDownloadResult] = useState<DownloadResult | null>(null);
  // The provider's own account of what it fetched (DownloadResolveResult.quality)
  // — the picker's option is often a cap the source fell short of.
  const [resolvedQuality, setResolvedQuality] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [addedToLibrary, setAddedToLibrary] = useState(false);
  const [libraryAddError, setLibraryAddError] = useState<string | null>(null);

  function handleChooseAnother() {
    setError(null);
    setStep("search");
    matchSearch.open();
  }

  // Bumped per picked match, so a slow quality lookup for an earlier pick
  // can't overwrite the list of a later one.
  const pickGenRef = useRef(0);

  function handleSelectMatch(match: InteractiveSearchResult) {
    setSelectedMatch(match);
    setMatchIsPicked(true);
    // The preview's note and option list described the previous item, and any
    // metadata resolved for it is stale.
    setPreviewNote(null);
    setPreviewQualities(null);
    resolvedMetaRef.current = null;
    setStep("configure");
    setError(null);
    // Ask what this item really offers, as the first preview did for its item.
    if (preview && match.id) {
      const gen = ++pickGenRef.current;
      setCheckingPreview(true);
      preview({ isVideo: trackIsVideo, uri: match.id })
        .then((p) => {
          if (pickGenRef.current !== gen) return;
          adoptQualities(p && Array.isArray(p.qualities) && p.qualities.length > 0 ? p.qualities : null);
        })
        .catch((e) => {
          if (pickGenRef.current !== gen) return;
          // The fixed list still works; the download itself will say if the item can't be fetched.
          console.error("Failed to look up the picked match's qualities:", e);
        })
        .finally(() => { if (pickGenRef.current === gen) setCheckingPreview(false); });
    }
  }

  /** The track's own names: a previewed upload is titled like "Pearl Jam -
   *  Alive (Official Video)", but the file is the user's song. */
  function baseMeta(): EffectiveMeta {
    return {
      title: track.title,
      artist: track.artistName ?? selectedMatch.artistName ?? null,
      album: track.albumTitle ?? selectedMatch.albumTitle ?? null,
      trackNumber: selectedMatch.trackNumber ?? null,
      coverUrl: selectedMatch.coverUrl ?? null,
    };
  }

  const selectedOption = qualities.find((q) => q.value === quality);
  const downloadIsVideo = selectedOption?.video === true || (!hasProviderQualities && trackIsVideo);

  async function handleStartDownload() {
    setError(null);
    setResolving(true);
    setResolveProgress(null);
    setResolvedQuality(null);
    setLibraryAddError(null);
    const gen = ++resolveGenRef.current;
    const reportProgress = (p: DownloadResolveProgress) => {
      if (resolveGenRef.current === gen) setResolveProgress(p);
    };
    if (hasProviderQualities) {
      const next = rememberQuality(qualityMemory, providerId, trackIsVideo, quality);
      if (next !== qualityMemory) {
        setQualityMemory(next);
        store.set(DOWNLOAD_QUALITY_MEMORY_KEY, next);
      }
    }

    let resolved: DownloadResolveResult | null;
    try {
      if (!matchIsPicked) {
        resolved = await plan.resolve(quality, reportProgress);
      } else if (resolveMatch) {
        resolved = await resolveMatch(selectedMatch.id, quality, reportProgress);
      } else {
        throw new Error(`${providerName} can't download a chosen match`);
      }
    } catch (e) {
      // A resolve the user cancelled fails by design — its process was killed.
      // Reporting that as a download error blames the provider for doing what
      // it was told, so the cancel path (which bumped the generation) is silent.
      if (resolveGenRef.current !== gen) return;
      setResolving(false);
      setResolveProgress(null);
      // Providers throw user-facing reasons (e.g. "YouTube rejected the
      // request with a sign-in / bot check") — show the message, not "Error:".
      setError(`${words.failed}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (resolveGenRef.current !== gen) return;
    setResolveProgress(null);
    if (!resolved) {
      setResolving(false);
      setError(`${providerName} couldn't find this track to download.`);
      return;
    }
    const streamUrl = resolved.url;
    const meta = resolved.metadata ?? undefined;
    setResolvedQuality(qualityLine(resolved.quality));
    setSavingLocal(streamUrl.startsWith("file://"));

    // Normally the provider's names override the track's. A picked item flips
    // that: the provider then describes the upload, and the track's own names
    // are the ones the user asked for.
    const base = baseMeta();
    const choose = <T,>(own: T | null | undefined, provided: T | null | undefined): T | null =>
      (matchIsPicked ? (own || provided) : (provided || own)) ?? null;
    const effective: EffectiveMeta = {
      title: choose(base.title, meta?.title) ?? track.title,
      artist: choose(base.artist, meta?.artist),
      album: choose(base.album, meta?.album),
      trackNumber: meta?.trackNumber ?? base.trackNumber,
      coverUrl: meta?.coverUrl || base.coverUrl,
    };
    resolvedMetaRef.current = effective;

    // A concrete resolver-provided extension overrides the format default so
    // the saved file matches the real container. "auto" means the backend names
    // it from the bytes.
    const ext = (resolved.ext && resolved.ext !== "auto" ? resolved.ext : null) ?? nativeFallback;

    if (inPlaceUpgrade) {
      // Download next to the original, then compare.
      setStep("downloading");
      setResolving(false);
      try {
        const info = await invoke<UpgradePreviewInfo>("download_preview", {
          trackId: track.trackId,
          streamUrl,
          format: quality,
          ext,
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

    const destDir = destType === "collection"
      ? collections.find(c => c.id === destCollectionId)?.path ?? null
      : destPath;
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
        ext,
        albumTitle: effective.album,
        trackNumber: effective.trackNumber,
        isVideo: downloadIsVideo,
        layout,
      });
      if (check.has_conflict) {
        setResolving(false);
        setConflict({ check, streamUrl });
        setStep("conflict");
      } else {
        await doFreshDownload(check.dest_path, false, streamUrl);
      }
    } catch (e) {
      // The check failed (an unreadable folder): download to the flat name
      // and let the download itself report a real problem.
      console.error("Failed to check the download destination:", e);
      const flatExt = ext ?? (quality === "flac" ? "flac" : "m4a");
      await doFreshDownload(flatFallbackPath(destDir, effective.artist ?? "Unknown", effective.title, flatExt), false, streamUrl);
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

  async function doFreshDownload(dp: string, overwrite: boolean, streamUrl: string) {
    const m = resolvedMetaRef.current ?? baseMeta();
    setResolving(false);
    setStep("downloading");
    setDownloadProgress(0);
    store.set("lastDownloadDest", destType === "collection" && destCollectionId != null ? String(destCollectionId) : null);

    try {
      const result = await invoke<DownloadResult>("download_to_path", {
        streamUrl,
        destPath: dp,
        format: quality,
        overwrite,
        title: m.title,
        artistName: m.artist,
        albumTitle: m.album,
        trackNumber: m.trackNumber,
        coverUrl: m.coverUrl,
        isVideo: downloadIsVideo,
      });
      setDownloadResult(result);

      if (destType === "collection" && destCollectionId != null) {
        try {
          await invoke("add_downloaded_track", { path: result.path, collectionId: destCollectionId });
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

  async function handleBrowseFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setDestType("path");
      setDestPath(selected);
      setDestCollectionId(null);
    }
  }

  async function handleConflictKeepBoth() {
    if (!conflict) return;
    // The first free "(N)": a second Keep Both must not collide with the first.
    const taken = conflict.check.dest_path;
    let candidate = numberedPath(taken, 2);
    for (let n = 2; n < 1000; n++) {
      candidate = numberedPath(taken, n);
      try {
        const c = await invoke<ConflictCheck>("check_path_conflict", { destPath: candidate });
        if (!c.has_conflict) break;
      } catch (e) {
        console.error("Failed to check a Keep Both name:", e);
        break;
      }
    }
    doFreshDownload(candidate, false, conflict.streamUrl);
  }

  async function handleCancel() {
    // Best-effort cleanup — the modal is closing regardless.
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

  async function confirmUpgrade(command: "confirm_track_upgrade" | "save_track_as_copy", done: string) {
    if (!upgradePreview) return;
    setConfirming(true);
    try {
      await invoke(command, { trackId: track.trackId, newPath: upgradePreview.new_path });
      onComplete(done);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  /** "Back" from the compare: drop the downloaded copy and return to configure. */
  async function handleBackFromCompare() {
    if (upgradePreview) {
      await invoke("cancel_track_upgrade", { newPath: upgradePreview.new_path }).catch(console.error);
      setUpgradePreview(null);
      setUpgradeFacts(null);
    }
    resolvedMetaRef.current = null;
    setStep("configure");
  }

  // Fill the configure step's art slot from cached entity art when the provider
  // gave no cover (album → artist, the queue's name-based chain).
  useEffect(() => {
    if (step !== "configure") return;
    const m = resolvedMetaRef.current ?? baseMeta();
    if (m.coverUrl || !m.artist) { setMetaCoverUrl(null); return; }
    const artist = m.artist;
    let canceled = false;
    (async () => {
      try {
        let path: string | null = null;
        if (m.album) {
          path = await invoke<string | null>("get_entity_image", { kind: "album", name: m.album, artistName: artist });
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
  }, [step, selectedMatch]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (step !== "downloading") return;
    setDownloadProgress(0);
    return subscribe<number>(inPlaceUpgrade ? "upgrade-download-progress" : "direct-download-progress", (event) => {
      setDownloadProgress(event.payload);
    });
  }, [step, inPlaceUpgrade]);

  const destLabel = inPlaceUpgrade
    ? "your library"
    : destType === "path" && destPath
      ? lastSegment(destPath)
      : collections.find((c) => c.id === destCollectionId)?.name ?? "the folder";
  // A plugin's search / resolveMatch are always-present lazy wrappers, so ask
  // whether the handlers behind them are registered — otherwise the link leads
  // to a search that can't answer or a pick that can't download.
  const canChooseAnother = !!search && !!resolveMatch && (plan.canChooseAnother?.() ?? true);

  return (
    <>
      <div className="dl-head">
        <h2>{inPlaceUpgrade ? "Upgrade track" : words.singleTitle}</h2>
        <ProviderChip name={providerName} />
      </div>
      {step !== "configure" && (
        <p className="dl-track">
          {track.title}{track.artistName ? ` — ${track.artistName}` : ""}
        </p>
      )}

      {error && <div className="dl-error">{error}</div>}

      {step === "search" && (
        <MatchSearchStep
          providerName={providerName}
          state={matchSearch}
          onPick={handleSelectMatch}
          onBack={() => setStep("configure")}
        />
      )}

      {step === "configure" && (
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
              {checkingPreview ? (
                <span className="dl-preview-note">
                  <span className="ds-spinner ds-spinner--sm ds-motion-essential" />
                  Checking what {providerName} will download…
                </span>
              ) : (previewNote || canChooseAnother) && (
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

          {inPlaceUpgrade ? (
            <button className="dl-save-elsewhere" onClick={() => setShowDestPicker(true)}>
              Save elsewhere instead...
            </button>
          ) : (
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

          {resolving && <ResolveProgress progress={resolveProgress} />}

          <div className="dl-actions">
            {/* Cancel stays live through the resolve. The provider may be
                downloading the whole file here (see `onCancelResolve`), so a
                disabled button is a trap, not a guard rail. */}
            <button onClick={resolving ? handleCancel : onClose}>Cancel</button>
            <button className="dl-btn-primary" onClick={handleStartDownload} disabled={resolving || checkingPreview}>
              {!resolving && <IconDownload size={15} />}
              {resolving ? "Working…" : ownedCopy ? words.startAnyway : words.start}
            </button>
          </div>
        </>
      )}

      {step === "conflict" && conflict && (
        <>
          <div className="dl-conflict">
            <div className="dl-conflict-filename">
              &ldquo;{conflict.check.dest_path.split(/[\\/]/).pop()}&rdquo; already exists
            </div>
            <div className="dl-conflict-size">
              Existing file: {conflict.check.existing_format ?? "Unknown"}, {formatFileSize(conflict.check.existing_size)}
            </div>
          </div>
          <div className="dl-actions">
            <button onClick={() => { setConflict(null); setStep("configure"); }}>Cancel</button>
            <button className="dl-btn-secondary" onClick={handleConflictKeepBoth}>Keep Both</button>
            <button className="dl-btn-primary" onClick={() => doFreshDownload(conflict.check.dest_path, true, conflict.streamUrl)}>Replace</button>
          </div>
        </>
      )}

      {step === "downloading" && (
        <div className="dl-downloading">
          {savingLocal ? (
            // The provider already fetched the file; this is a local copy plus
            // tags. A second 0→100% bar here read as the download starting over.
            <div className="dl-loading"><div className="ds-spinner" /><span>Saving to {destLabel}…</span></div>
          ) : (
            <>
              <div className="dl-loading"><div className="ds-spinner" /><span>{words.working(providerName)}</span></div>
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

      {step === "result" && upgradePreview && (
        <UpgradeCompare
          preview={upgradePreview}
          facts={upgradeFacts}
          providerName={providerName}
          resolvedQuality={resolvedQuality}
          confirming={confirming}
          onBack={handleBackFromCompare}
          onReplace={() => confirmUpgrade("confirm_track_upgrade", `Track replaced with ${providerName} version`)}
          onSaveAsCopy={() => confirmUpgrade("save_track_as_copy", `${providerName} copy saved alongside original`)}
          onCancel={handleCancel}
        />
      )}

      {step === "result" && downloadResult && (
        <>
          <div className="dl-success">
            <h3>{words.done}</h3>
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
