import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { audioDir } from "@tauri-apps/api/path";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Collection } from "../types";
import type { GalleryPluginEntry, PluginViewData } from "../types/plugin";
import type { SkinInfo } from "../types/skin";
import type { DependencyInfo, InstallProgress } from "../hooks/useDependencies";
import { PluginViewRenderer } from "./PluginViewRenderer";
import { SubsonicServerForm } from "./AddServerModal";
import { getPlatform, getPlatformLabel, formatBytes } from "./DependencyModal";
import { computeInitialSelection, computeInstallEntries } from "./firstRunSelection";
import {
  type OnboardingStepId,
  type OnboardingProfile,
  type ProfilePreset,
  ONBOARDING_PROFILES,
  PROFILE_PRESETS,
  visibleSteps,
  missingPluginDeps,
  stepsForDisplay,
  nextStepId,
  prevStepId,
} from "./onboardingSteps";

interface ScanActivity {
  collectionId: number;
  collectionName: string;
  kind: "scan" | "sync";
  scanned: number;
  total: number;
}

interface ScanDone {
  collectionId: number;
  collectionName: string;
  newTracks: number;
  removedTracks: number;
}

interface SkinsApi {
  installedSkins: SkinInfo[];
  activeSkinId: string;
  applySkin: (id: string) => void;
  previewSkin: (skin: SkinInfo) => void;
  clearPreview: () => void;
}

interface OnboardingWizardProps {
  skins: SkinsApi;
  collections: Collection[];
  onCollectionAdded: () => void;
  galleryPlugins: GalleryPluginEntry[];
  installedPluginIds: Set<string>;
  onFetchGallery: () => Promise<GalleryPluginEntry[]>;
  onInstallPlugin: (entry: GalleryPluginEntry) => Promise<{ ok: boolean; error?: string }>;
  onEnablePlugin: (pluginId: string) => Promise<void>;
  lastfmInstalled: boolean;
  lastfmActive: boolean;
  lastfmPanelData: PluginViewData | undefined;
  onLastfmAction: (actionId: string, data?: unknown) => void;
  deps: DependencyInfo[];
  depInstalling: Record<string, InstallProgress>;
  onInstallDep: (name: string) => Promise<string | null>;
  onRecheckDeps: () => void;
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
  autoContinueEnabled: boolean;
  onAutoContinueEnabledChange: (enabled: boolean) => void;
  trackVideoHistory: boolean;
  onTrackVideoHistoryChange: (enabled: boolean) => void;
  resyncProgress: ScanActivity | null;
  resyncComplete: ScanDone | null;
  /** Profile preselected on open (stored choice on re-runs, else "normal"). */
  initialProfile: OnboardingProfile;
  /** Marks onboarding complete, persists the chosen profile, and closes the wizard. */
  onClose: (profile: OnboardingProfile) => void;
}

const STEP_TITLES: Record<OnboardingStepId, string> = {
  profile: "Welcome to Viboplr",
  welcome: "Pick your look",
  music: "Add your music",
  plugins: "Recommended plugins",
  dependencies: "Companion tools",
  lastfm: "Connect Last.fm",
  playback: "Playback",
  finish: "You're all set",
};

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [stepId, setStepId] = useState<OnboardingStepId>("profile");
  const [profile, setProfile] = useState<OnboardingProfile>(props.initialProfile);
  const [busy, setBusy] = useState(false);
  const { onClose } = props;

  const missingDepNames = useMemo(() => missingPluginDeps(props.deps), [props.deps]);
  const steps = useMemo(
    () => visibleSteps({ missingDepNames, lastfmInstalled: props.lastfmInstalled, profile }),
    [missingDepNames, props.lastfmInstalled, profile],
  );
  const displaySteps = stepsForDisplay(steps, stepId);
  const next = nextStepId(stepId, steps);
  const prev = prevStepId(stepId, steps);

  // Escape finishes setup, like "Skip setup" — but never mid-install.
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose(profile);
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [busy, onClose, profile]);

  return (
    <div className="ds-modal-overlay">
      <div className="ds-modal ds-modal--xl onboarding-modal" onClick={(e) => e.stopPropagation()}>
        <div className="onboarding-header">
          <h2 className="ds-modal-title">{STEP_TITLES[stepId]}</h2>
          <div className="onboarding-dots">
            {displaySteps.map((id) => {
              const state =
                id === stepId
                  ? " active"
                  : displaySteps.indexOf(id) < displaySteps.indexOf(stepId)
                    ? " done"
                    : "";
              return <span key={id} className={`onboarding-dot${state}`} title={STEP_TITLES[id]} />;
            })}
          </div>
        </div>

        <div className="onboarding-body">
          {stepId === "profile" && <ProfileStep profile={profile} onSelect={setProfile} />}
          {stepId === "welcome" && <WelcomeStep skins={props.skins} />}
          {stepId === "music" && (
            <MusicStep
              preset={PROFILE_PRESETS[profile]}
              collections={props.collections}
              resync={props.resyncProgress}
              onCollectionAdded={props.onCollectionAdded}
            />
          )}
          {stepId === "plugins" && (
            <PluginsStep
              profile={profile}
              entries={props.galleryPlugins}
              installedIds={props.installedPluginIds}
              onInstall={props.onInstallPlugin}
              onEnable={props.onEnablePlugin}
              onFetchGallery={props.onFetchGallery}
              onRecheckDeps={props.onRecheckDeps}
              setBusy={setBusy}
            />
          )}
          {stepId === "dependencies" && (
            <DependenciesStep
              deps={props.deps}
              installing={props.depInstalling}
              onInstallDep={props.onInstallDep}
              onRecheckDeps={props.onRecheckDeps}
              setBusy={setBusy}
            />
          )}
          {stepId === "lastfm" && (
            <LastfmStep
              active={props.lastfmActive}
              panelData={props.lastfmPanelData}
              onAction={props.onLastfmAction}
              onEnable={() => props.onEnablePlugin("lastfm")}
            />
          )}
          {stepId === "playback" && (
            <PlaybackStep
              crossfadeSecs={props.crossfadeSecs}
              onCrossfadeChange={props.onCrossfadeChange}
              autoContinueEnabled={props.autoContinueEnabled}
              onAutoContinueEnabledChange={props.onAutoContinueEnabledChange}
              showVideoHistoryToggle={PROFILE_PRESETS[profile].showVideoHistoryToggle}
              trackVideoHistory={props.trackVideoHistory}
              onTrackVideoHistoryChange={props.onTrackVideoHistoryChange}
            />
          )}
          {stepId === "finish" && (
            <FinishStep resync={props.resyncProgress} resyncDone={props.resyncComplete} />
          )}
        </div>

        <div className="onboarding-footer">
          {stepId !== "finish" ? (
            <button className="ds-btn ds-btn--ghost" onClick={() => onClose(profile)} disabled={busy}>
              Skip setup
            </button>
          ) : (
            <span />
          )}
          <div className="onboarding-footer-nav">
            {prev && (
              <button className="ds-btn ds-btn--ghost" onClick={() => setStepId(prev)} disabled={busy}>
                Back
              </button>
            )}
            {next ? (
              <button className="ds-btn ds-btn--primary" onClick={() => setStepId(next)} disabled={busy}>
                Continue
              </button>
            ) : (
              <button className="ds-btn ds-btn--primary" onClick={() => onClose(profile)} disabled={busy}>
                Start listening
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps

function WelcomeStep({ skins }: { skins: SkinsApi }) {
  // The wizard is unmounted per-step-switch, so make sure a lingering hover
  // preview never outlives the step.
  useEffect(() => () => skins.clearPreview(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <p className="onboarding-step-desc">
        Pick a look. Hover to preview, click to apply; you can change it anytime
        in Settings.
      </p>
      <div className="onboarding-skin-grid">
        {skins.installedSkins.map((skin) => (
          <button
            key={skin.id}
            className={`onboarding-skin-card${skin.id === skins.activeSkinId ? " active" : ""}`}
            onMouseEnter={() => skins.previewSkin(skin)}
            onMouseLeave={() => skins.clearPreview()}
            onClick={() => skins.applySkin(skin.id)}
          >
            {/* Inline colors here are skin *data* (the swatch preview), not UI styling. */}
            <span className="onboarding-skin-swatch" style={{ background: skin.colors["bg-primary"] }}>
              <span style={{ background: skin.colors["bg-secondary"] }} />
              <span style={{ background: skin.colors["accent"] }} />
              <span style={{ background: skin.colors["text-primary"] }} />
            </span>
            <span className="onboarding-skin-name">{skin.name}</span>
            <span className="onboarding-skin-type">{skin.type}</span>
          </button>
        ))}
      </div>
    </>
  );
}

const PROFILE_ICONS: Record<OnboardingProfile, ReactNode> = {
  normal: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  ),
  video: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    </svg>
  ),
  streaming: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.55a11 11 0 0 1 14.08 0" />
      <path d="M1.42 9a16 16 0 0 1 21.16 0" />
      <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
      <line x1="12" y1="20" x2="12.01" y2="20" />
    </svg>
  ),
  server: (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
      <line x1="6" y1="6" x2="6.01" y2="6" />
      <line x1="6" y1="18" x2="6.01" y2="18" />
    </svg>
  ),
};

function ProfileStep({
  profile,
  onSelect,
}: {
  profile: OnboardingProfile;
  onSelect: (p: OnboardingProfile) => void;
}) {
  return (
    <>
      <p className="onboarding-step-desc">
        Let's set things up — it only takes a minute, and every step is optional.
        First, how will you use Viboplr? Your pick just tailors the suggestions
        in the next steps — every feature stays available no matter what you
        choose, and you can change anything later.
      </p>
      <div className="onboarding-profile-grid">
        {ONBOARDING_PROFILES.map((id) => {
          const preset = PROFILE_PRESETS[id];
          return (
            <button
              key={id}
              className={`onboarding-profile-card${id === profile ? " active" : ""}`}
              aria-pressed={id === profile}
              onClick={() => onSelect(id)}
            >
              <span className="onboarding-profile-icon">{PROFILE_ICONS[id]}</span>
              <span className="onboarding-profile-title">{preset.title}</span>
              <span className="onboarding-profile-desc">{preset.description}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function stripTrailingSlashes(path: string): string {
  return path.replace(/[\\/]+$/, "");
}

function MusicStep({
  preset,
  collections,
  resync,
  onCollectionAdded,
}: {
  preset: ProfilePreset;
  collections: Collection[];
  resync: ScanActivity | null;
  onCollectionAdded: () => void;
}) {
  const [musicDir, setMusicDir] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<"subsonic" | "manifest" | null>(
    preset.subsonicAutoExpand ? "subsonic" : null,
  );
  const [manifestUrl, setManifestUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    audioDir()
      .then((dir) => setMusicDir(stripTrailingSlashes(dir)))
      .catch((e) => console.error("Failed to resolve OS music directory:", e));
  }, []);

  const musicDirAdded =
    musicDir != null && collections.some((c) => c.path && stripTrailingSlashes(c.path) === musicDir);

  async function addLocal(path: string) {
    const clean = stripTrailingSlashes(path);
    const folderName = clean.split("/").pop() || clean.split("\\").pop() || clean;
    setAdding(true);
    setError(null);
    try {
      await invoke("add_collection", { kind: "local", name: folderName, path: clean });
      onCollectionAdded();
    } catch (e) {
      console.error("Failed to add local collection:", e);
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handlePickFolder() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") await addLocal(selected);
    } catch (e) {
      console.error("Failed to open folder picker:", e);
    }
  }

  async function handleAddManifest() {
    const url = manifestUrl.trim();
    if (!url) return;
    setAdding(true);
    setError(null);
    try {
      const name = new URL(url).host;
      await invoke("add_collection", { kind: "manifest", name, url });
      setManifestUrl("");
      setExpanded(null);
      onCollectionAdded();
    } catch (e) {
      console.error("Failed to add music source:", e);
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  const subsonicOption = (
    <div className="onboarding-option">
      <div className="onboarding-option-header">
        <div>
          <div className="onboarding-option-title">Subsonic / Navidrome server</div>
          <div className="onboarding-option-desc">Stream from your own music server</div>
        </div>
        <button
          className="ds-btn ds-btn--secondary ds-btn--sm"
          onClick={() => setExpanded(expanded === "subsonic" ? null : "subsonic")}
        >
          {expanded === "subsonic" ? "Hide" : "Connect…"}
        </button>
      </div>
      {expanded === "subsonic" && (
        <div className="onboarding-option-body">
          <SubsonicServerForm
            onAdded={() => {
              setExpanded(null);
              onCollectionAdded();
            }}
          />
        </div>
      )}
    </div>
  );

  return (
    <>
      <p className="onboarding-step-desc">{preset.musicDesc}</p>
      <div className="onboarding-options">
        {preset.subsonicFirst && subsonicOption}
        {musicDir && !musicDirAdded && (
          <div className="onboarding-option">
            <div className="onboarding-option-header">
              <div>
                <div className="onboarding-option-title">Your Music folder</div>
                <div className="onboarding-option-desc">{musicDir}</div>
              </div>
              <button
                className="ds-btn ds-btn--primary ds-btn--sm"
                onClick={() => addLocal(musicDir)}
                disabled={adding}
              >
                Add
              </button>
            </div>
          </div>
        )}
        <div className="onboarding-option">
          <div className="onboarding-option-header">
            <div>
              <div className="onboarding-option-title">A local folder</div>
              <div className="onboarding-option-desc">Scan any folder of audio or video files</div>
            </div>
            <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={handlePickFolder} disabled={adding}>
              Choose folder…
            </button>
          </div>
        </div>
        {!preset.subsonicFirst && subsonicOption}
        <div className="onboarding-option">
          <div className="onboarding-option-header">
            <div>
              <div className="onboarding-option-title">Music source URL</div>
              <div className="onboarding-option-desc">Subscribe to a published music catalog</div>
            </div>
            <button
              className="ds-btn ds-btn--secondary ds-btn--sm"
              onClick={() => setExpanded(expanded === "manifest" ? null : "manifest")}
            >
              {expanded === "manifest" ? "Hide" : "Subscribe…"}
            </button>
          </div>
          {expanded === "manifest" && (
            <div className="onboarding-option-body">
              <div className="modal-field">
                <label>Catalog URL</label>
                <input
                  className="ds-input"
                  type="text"
                  placeholder="https://example.com/manifest.json"
                  value={manifestUrl}
                  onChange={(e) => setManifestUrl(e.target.value)}
                />
              </div>
              <div className="ds-modal-actions">
                <button
                  className="ds-btn ds-btn--primary ds-btn--sm"
                  onClick={handleAddManifest}
                  disabled={adding || !manifestUrl.trim()}
                >
                  {adding ? "Adding…" : "Add source"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      {error && <div className="onboarding-error">{error}</div>}
      {collections.length > 0 && (
        <div className="onboarding-collections">
          {collections.map((c) => (
            <div key={c.id} className="onboarding-collection-row">
              <span className="onboarding-collection-name">{c.name}</span>
              <span className="onboarding-collection-kind">{c.kind}</span>
              <span className="onboarding-collection-status">
                {resync && resync.collectionId === c.id
                  ? `${resync.kind === "sync" ? "Syncing" : "Scanning"}… ${resync.scanned}${resync.total > 0 ? ` / ${resync.total}` : ""}`
                  : "Added ✓"}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function PluginsStep({
  profile,
  entries,
  installedIds,
  onInstall,
  onEnable,
  onFetchGallery,
  onRecheckDeps,
  setBusy,
}: {
  profile: OnboardingProfile;
  entries: GalleryPluginEntry[];
  installedIds: Set<string>;
  onInstall: (entry: GalleryPluginEntry) => Promise<{ ok: boolean; error?: string }>;
  onEnable: (pluginId: string) => Promise<void>;
  onFetchGallery: () => Promise<GalleryPluginEntry[]>;
  onRecheckDeps: () => void;
  setBusy: (busy: boolean) => void;
}) {
  // Recomputed from the current profile on every visit — the step unmounts on
  // navigation, so switching profile and coming back re-seeds the selection.
  const [checked, setChecked] = useState<Set<string>>(() =>
    computeInitialSelection(entries, installedIds, profile),
  );
  const [installing, setInstalling] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [loadingGallery, setLoadingGallery] = useState(false);
  const touchedRef = useRef(false);

  // The gallery may still be loading when the wizard opens (it's prefetched
  // fire-and-forget). Re-seed the recommended selection once entries arrive,
  // unless the user already interacted with the checkboxes.
  useEffect(() => {
    if (!touchedRef.current) setChecked(computeInitialSelection(entries, installedIds, profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries]);

  async function retryGallery() {
    setLoadingGallery(true);
    try {
      await onFetchGallery();
    } catch (e) {
      console.error("Failed to fetch plugin gallery:", e);
    } finally {
      setLoadingGallery(false);
    }
  }

  function toggle(id: string) {
    touchedRef.current = true;
    setChecked((prev) => {
      const nextSet = new Set(prev);
      if (nextSet.has(id)) nextSet.delete(id);
      else nextSet.add(id);
      return nextSet;
    });
  }

  const toInstall = computeInstallEntries(entries, checked, installedIds).filter((e) => !done.has(e.id));

  async function handleInstall() {
    if (toInstall.length === 0) return;
    setRunning(true);
    setBusy(true);
    try {
      for (const entry of toInstall) {
        setInstalling((prev) => new Set(prev).add(entry.id));
        let ok = false;
        try {
          const res = await onInstall(entry);
          ok = res.ok;
          if (!res.ok) console.error(`Failed to install plugin "${entry.id}":`, res.error);
        } catch (e) {
          console.error(`Failed to install plugin "${entry.id}":`, e);
        }
        if (ok) {
          // Gallery installs land disabled by default — enable so the plugin
          // actually works right after setup.
          try {
            await onEnable(entry.id);
          } catch (e) {
            console.error(`Failed to enable plugin "${entry.id}":`, e);
          }
        }
        setInstalling((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(entry.id);
          return nextSet;
        });
        if (ok) setDone((prev) => new Set(prev).add(entry.id));
        else setFailed((prev) => new Set(prev).add(entry.id));
      }
      // New plugins may need external binaries (e.g. YouTube → yt-dlp), which
      // decides whether the dependencies step appears next.
      onRecheckDeps();
    } finally {
      setRunning(false);
      setBusy(false);
    }
  }

  if (entries.length === 0) {
    return (
      <div className="onboarding-empty">
        <span>
          {loadingGallery
            ? "Loading the plugin gallery…"
            : "The plugin gallery isn't available right now. You can install plugins later from Extensions."}
        </span>
        {!loadingGallery && (
          <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={retryGallery}>
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <>
      <p className="onboarding-step-desc">
        Plugins add streaming sources, lyrics, artwork, scrobbling and more.
        Recommended ones are pre-selected — adjust the list and install, or skip
        for now.
      </p>
      <div className="first-run-list">
        {entries.map((entry) => {
          const isInstalled = installedIds.has(entry.id) || done.has(entry.id);
          const isInstalling = installing.has(entry.id);
          const isFailed = failed.has(entry.id);
          return (
            <label key={entry.id} className={`first-run-row${isInstalled ? " is-installed" : ""}`}>
              <input
                type="checkbox"
                checked={isInstalled ? false : checked.has(entry.id)}
                disabled={isInstalled || running}
                onChange={() => toggle(entry.id)}
              />
              {entry.icon ? (
                <svg
                  className="first-run-icon"
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d={entry.icon} />
                </svg>
              ) : (
                <span className="first-run-icon first-run-icon--placeholder" />
              )}
              <span className="first-run-meta">
                <span className="first-run-name">
                  {entry.name}
                  {entry.recommended && <span className="first-run-badge">Recommended</span>}
                </span>
                <span className="first-run-desc">{entry.description}</span>
              </span>
              <span className={`first-run-status${isFailed ? " is-failed" : ""}`}>
                {isInstalling ? "Installing…" : isInstalled ? "Installed" : isFailed ? "Failed" : ""}
              </span>
            </label>
          );
        })}
      </div>
      <div className="ds-modal-actions">
        <button
          className="ds-btn ds-btn--primary"
          onClick={handleInstall}
          disabled={running || toInstall.length === 0}
        >
          {running
            ? "Installing…"
            : toInstall.length > 0
              ? `Install ${toInstall.length} plugin${toInstall.length === 1 ? "" : "s"}`
              : "Install"}
        </button>
      </div>
    </>
  );
}

function DependenciesStep({
  deps,
  installing,
  onInstallDep,
  onRecheckDeps,
  setBusy,
}: {
  deps: DependencyInfo[];
  installing: Record<string, InstallProgress>;
  onInstallDep: (name: string) => Promise<string | null>;
  onRecheckDeps: () => void;
  setBusy: (busy: boolean) => void;
}) {
  const [installingNames, setInstallingNames] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copiedName, setCopiedName] = useState<string | null>(null);
  const platform = getPlatform();

  // Show every plugin-consumed dep (installed ones stay visible with a check
  // mark, so the list doesn't jump around as installs complete).
  const rows = deps.filter((d) => d.pluginConsumers.length > 0);

  async function handleInstall(name: string) {
    setInstallingNames((prev) => new Set(prev).add(name));
    setErrors((prev) => ({ ...prev, [name]: "" }));
    setBusy(true);
    try {
      await onInstallDep(name);
      onRecheckDeps();
    } catch (e) {
      console.error(`Failed to install dependency "${name}":`, e);
      setErrors((prev) => ({ ...prev, [name]: String(e) }));
    } finally {
      setInstallingNames((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(name);
        return nextSet;
      });
      setBusy(false);
    }
  }

  async function handleCopy(name: string, command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedName(name);
      setTimeout(() => setCopiedName(null), 2000);
    } catch (e) {
      console.error("Failed to copy install command:", e);
    }
  }

  return (
    <>
      <p className="onboarding-step-desc">
        Some plugins rely on small companion tools. Install them now, or skip and
        do it later from Settings → Dependencies.
      </p>
      {rows.map((dep) => {
        const isInstalled = dep.status === "installed";
        const isInstalling = installingNames.has(dep.name);
        const progress = installing[dep.name];
        const progressPct =
          progress && progress.total ? Math.round((progress.downloaded / progress.total) * 100) : null;
        const neededBy = dep.pluginConsumers.map((c) => c.name).join(", ");
        return (
          <div key={dep.name} className="onboarding-dep-row">
            <div className="onboarding-dep-header">
              <span className="onboarding-dep-name">{dep.name}</span>
              <span className={`onboarding-dep-status${isInstalled ? " ok" : ""}`}>
                {isInstalled ? `Installed ✓${dep.version ? ` (${dep.version})` : ""}` : "Not installed"}
              </span>
            </div>
            <p className="onboarding-dep-desc">
              {dep.description}
              {neededBy ? ` — needed by ${neededBy}` : ""}
            </p>
            {!isInstalled && isInstalling && (
              <div className="onboarding-progress-track">
                <div
                  className="onboarding-progress-fill"
                  style={{
                    width: progressPct !== null ? `${progressPct}%` : "100%",
                    opacity: progressPct !== null ? 1 : 0.4,
                  }}
                />
              </div>
            )}
            {!isInstalled && !isInstalling && !dep.managedAvailable && (
              <div className="onboarding-dep-command">
                <code>{dep.install[platform]}</code>
                <button
                  className="ds-btn ds-btn--ghost ds-btn--sm"
                  onClick={() => handleCopy(dep.name, dep.install[platform])}
                >
                  {copiedName === dep.name ? "Copied" : `Copy (${getPlatformLabel(platform)})`}
                </button>
              </div>
            )}
            {errors[dep.name] && <div className="onboarding-error">Install failed: {errors[dep.name]}</div>}
            {!isInstalled && (
              <div className="onboarding-dep-actions">
                {dep.managedAvailable ? (
                  <button
                    className="ds-btn ds-btn--primary ds-btn--sm"
                    onClick={() => handleInstall(dep.name)}
                    disabled={isInstalling}
                  >
                    {isInstalling
                      ? `Installing…${progress ? ` ${formatBytes(progress.downloaded)}${progress.total ? ` / ${formatBytes(progress.total)}` : ""}` : ""}`
                      : "Install for me"}
                  </button>
                ) : (
                  <>
                    <button
                      className="ds-btn ds-btn--ghost ds-btn--sm"
                      onClick={() => openUrl(dep.install.url).catch(console.error)}
                    >
                      Download page
                    </button>
                    <button className="ds-btn ds-btn--secondary ds-btn--sm" onClick={onRecheckDeps}>
                      Check again
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function LastfmStep({
  active,
  panelData,
  onAction,
  onEnable,
}: {
  active: boolean;
  panelData: PluginViewData | undefined;
  onAction: (actionId: string, data?: unknown) => void;
  onEnable: () => Promise<void>;
}) {
  const [enabling, setEnabling] = useState(false);

  if (!active) {
    return (
      <>
        <p className="onboarding-step-desc">
          Scrobble what you play and import your listening history. The Last.fm
          plugin is installed but not enabled.
        </p>
        <button
          className="ds-btn ds-btn--primary"
          disabled={enabling}
          onClick={async () => {
            setEnabling(true);
            try {
              await onEnable();
            } catch (e) {
              console.error("Failed to enable the Last.fm plugin:", e);
            } finally {
              setEnabling(false);
            }
          }}
        >
          {enabling ? "Enabling…" : "Enable Last.fm"}
        </button>
      </>
    );
  }

  return (
    <>
      <p className="onboarding-step-desc">
        Connect your Last.fm account to scrobble plays, and optionally import
        your scrobble history — the import keeps running in the background.
        Skip this if you don't use Last.fm.
      </p>
      {panelData ? (
        <div className="onboarding-plugin-panel">
          <PluginViewRenderer pluginName="Last.fm" data={panelData} currentTrack={null} onAction={onAction} />
        </div>
      ) : (
        <div className="onboarding-empty">
          <span className="ds-spinner" />
        </div>
      )}
    </>
  );
}

function PlaybackStep({
  crossfadeSecs,
  onCrossfadeChange,
  autoContinueEnabled,
  onAutoContinueEnabledChange,
  showVideoHistoryToggle,
  trackVideoHistory,
  onTrackVideoHistoryChange,
}: {
  crossfadeSecs: number;
  onCrossfadeChange: (secs: number) => void;
  autoContinueEnabled: boolean;
  onAutoContinueEnabledChange: (enabled: boolean) => void;
  showVideoHistoryToggle: boolean;
  trackVideoHistory: boolean;
  onTrackVideoHistoryChange: (enabled: boolean) => void;
}) {
  return (
    <>
      <p className="onboarding-step-desc">
        How should tracks flow into each other? Both settings can be changed
        later in Settings → General.
      </p>
      <div className="settings-card">
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-label">Crossfade</span>
            <span className="settings-description">
              Smooth transition between tracks — Off keeps playback gapless
            </span>
          </div>
          <div className="settings-row-control settings-row-slider">
            <input
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={crossfadeSecs}
              onChange={(e) => onCrossfadeChange(parseFloat(e.target.value))}
              className="settings-slider"
            />
            <span className="settings-value">
              {crossfadeSecs === 0 ? "Off" : `${crossfadeSecs.toFixed(1)}s`}
            </span>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <span className="settings-label">Auto-continue</span>
            <span className="settings-description">
              Keep the music going with similar tracks when the queue ends
            </span>
          </div>
          <button
            className={`ds-toggle ${autoContinueEnabled ? "on" : ""}`}
            role="switch"
            aria-checked={autoContinueEnabled}
            onClick={() => onAutoContinueEnabledChange(!autoContinueEnabled)}
          >
            <span className="ds-toggle-thumb" />
          </button>
        </div>
        {showVideoHistoryToggle && (
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-label">Track video history</span>
              <span className="settings-description">
                Count video plays in your history and stats, like audio
              </span>
            </div>
            <button
              className={`ds-toggle ${trackVideoHistory ? "on" : ""}`}
              role="switch"
              aria-checked={trackVideoHistory}
              onClick={() => onTrackVideoHistoryChange(!trackVideoHistory)}
            >
              <span className="ds-toggle-thumb" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}

const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

const SHORTCUTS: Array<[string, string]> = [
  ["Space", "Play / pause"],
  [`${MOD} K`, "Search everything"],
  [`${MOD} 0`, "Home"],
  [`${MOD} 1`, "Library"],
  [`${MOD} 3`, "Now Playing"],
  [`${MOD} L`, "Like the current track"],
  [`${MOD} P`, "Toggle the queue panel"],
  [`${MOD} ⇧ M`, "Mini player"],
];

function FinishStep({ resync, resyncDone }: { resync: ScanActivity | null; resyncDone: ScanDone | null }) {
  return (
    <>
      <p className="onboarding-step-desc">
        That's it — a few shortcuts worth knowing:
      </p>
      <div className="onboarding-kbd-grid">
        {SHORTCUTS.map(([keys, desc]) => (
          <span key={keys} style={{ display: "contents" }}>
            <kbd>{keys}</kbd>
            <span className="onboarding-kbd-desc">{desc}</span>
          </span>
        ))}
      </div>
      {resync && (
        <div className="onboarding-scan-status">
          <span className="ds-spinner ds-spinner--sm" />
          {resync.kind === "sync" ? "Syncing" : "Scanning"} “{resync.collectionName}”…{" "}
          {resync.scanned}
          {resync.total > 0 ? ` / ${resync.total}` : ""} tracks
        </div>
      )}
      {!resync && resyncDone && (
        <div className="onboarding-scan-status">
          “{resyncDone.collectionName}” ready — {resyncDone.newTracks} tracks added
        </div>
      )}
      <p className="onboarding-hint">
        You can run this setup again anytime from Settings → General.
      </p>
    </>
  );
}
