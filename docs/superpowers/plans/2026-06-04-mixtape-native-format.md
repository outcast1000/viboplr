# Mixtape Native Format Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-export "max preferred format" picker to full-mode mixtape export (native format, no transcode, provider decides) and remove the now-redundant global Download format setting, the `api.downloads.getDownloadFormat()` plugin API, the dead `useDownloads.downloadTrack`, and the `useDownloads` hook itself.

**Architecture:** The picker is a fixed host-defined format ladder shown only when a full mixtape contains remote tracks; the chosen value is passed as the existing `options.format` hint to `export_mixtape_full` (no backend change). Removal work strips the global setting end-to-end (Settings UI, store key, restore path, prop drilling) and dissolves `useDownloads` by inlining its single `download-resolve-request` listener into App.tsx.

**Tech Stack:** React + TypeScript (Vite), Tauri 2, Vitest. Frontend-only — no Rust changes.

---

## File Structure

**New files:**
- `src/utils/mixtapeFormatLadder.ts` — exported ladder constant `MIXTAPE_FORMAT_LADDER` + default.
- `src/__tests__/mixtapeFormatLadder.test.ts` — unit test for the ladder.

**Modified files:**
- `src/components/MixtapeExportModal.tsx` — add `maxFormat` state, picker UI (gated on remote tracks), send `maxFormat` to backend; drop `downloadFormat` prop.
- `src/components/SettingsPanel.tsx` — remove "Download format" row + `downloadFormat`/`onDownloadFormatChange` props.
- `src/components/DownloadModal.tsx` — drop `downloadFormat` prop (pass-through).
- `src/components/download/SingleTrackDownload.tsx` — drop `downloadFormat` prop, literal `"flac"` seed.
- `src/components/download/MultiTrackDownload.tsx` — drop `downloadFormat` prop, literal `"flac"` seed.
- `src/types/plugin.ts` — remove `getDownloadFormat` from `PluginDownloadsAPI`.
- `src/hooks/usePlugins.ts` — remove `getDownloadFormat` (API impl + `PluginPlaybackCallbacks` field).
- `src/App.tsx` — inline resolve-request listener, delete `useDownloads` usage, drop `downloadFormatRef`, remove all `downloadFormat` props + restore lines.
- `src/store.ts` — remove `downloadFormat` default key.
- `src/startup/readPersistedSettings.ts` — remove `downloadFormat` read + type field.
- `.claude/rules/conventions.md`, `.claude/rules/plugins.md` — update doc references.

**Deleted files:**
- `src/hooks/useDownloads.ts`.

---

## Ordering rationale

The feature (Tasks 1–2) is built first and independently — it does not depend on any removal. The removals (Tasks 3–9) follow. Because TypeScript will report errors mid-removal until all references are gone, **the regression gate (`npx tsc --noEmit`) is run at Task 10**, after every reference is cleared. Each removal task still commits independently for a clean history.

---

### Task 1: Format ladder constant + test

**Files:**
- Create: `src/utils/mixtapeFormatLadder.ts`
- Test: `src/__tests__/mixtapeFormatLadder.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/mixtapeFormatLadder.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { MIXTAPE_FORMAT_LADDER, MIXTAPE_FORMAT_DEFAULT } from "../utils/mixtapeFormatLadder";

describe("MIXTAPE_FORMAT_LADDER", () => {
  it("lists formats highest-quality-first", () => {
    expect(MIXTAPE_FORMAT_LADDER.map(o => o.value)).toEqual([
      "flac-hires", "flac", "aac", "mp3",
    ]);
  });

  it("gives every option a non-empty label", () => {
    for (const opt of MIXTAPE_FORMAT_LADDER) {
      expect(opt.label.length).toBeGreaterThan(0);
    }
  });

  it("defaults to flac", () => {
    expect(MIXTAPE_FORMAT_DEFAULT).toBe("flac");
    expect(MIXTAPE_FORMAT_LADDER.some(o => o.value === MIXTAPE_FORMAT_DEFAULT)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run mixtapeFormatLadder`
Expected: FAIL — cannot resolve `../utils/mixtapeFormatLadder`.

- [ ] **Step 3: Create the ladder constant**

Create `src/utils/mixtapeFormatLadder.ts`:

```typescript
// Fixed, host-defined "max preferred format" ladder for full-mode mixtape export.
//
// These are HINT strings passed to the download resolve chain as `options.format`
// — NOT a transcoding instruction. Each download provider interprets the hint and
// falls back to its best native option when it can't honor it ("provider decides").
// The packed file's real extension is sniffed from the resolved URL by the backend.
// Rendered highest-quality-first.
export interface MixtapeFormatOption {
  value: string;
  label: string;
}

export const MIXTAPE_FORMAT_LADDER: MixtapeFormatOption[] = [
  { value: "flac-hires", label: "FLAC hi-res" },
  { value: "flac", label: "FLAC (lossless)" },
  { value: "aac", label: "AAC / M4A" },
  { value: "mp3", label: "MP3" },
];

// Matches the backend `.unwrap_or("flac")` default so untouched exports are unchanged.
export const MIXTAPE_FORMAT_DEFAULT = "flac";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run mixtapeFormatLadder`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/utils/mixtapeFormatLadder.ts src/__tests__/mixtapeFormatLadder.test.ts
git commit -m "feat(mixtape): add fixed max-preferred-format ladder constant"
```

---

### Task 2: Mixtape modal picker (gated on remote tracks)

**Files:**
- Modify: `src/components/MixtapeExportModal.tsx`

This task makes the modal use its own `maxFormat` state instead of the `downloadFormat` prop, and renders a picker only when a full mixtape contains remote tracks. The `downloadFormat` prop is removed here; the App.tsx call site that still passes it is fixed in Task 8 (TS errors until then are expected and resolved at Task 10's gate — but this file compiles in isolation since the prop simply no longer exists).

- [ ] **Step 1: Remove the `downloadFormat` prop from the interface**

In `src/components/MixtapeExportModal.tsx`, the props interface currently reads:

```typescript
interface MixtapeExportModalProps {
  tracks: ExportTrack[];
  defaultTitle?: string;
  defaultCoverPath?: string | null;
  defaultMetadata?: Record<string, string> | null;
  defaultMixtapeType?: MixtapeType;
  downloadFormat?: string;
  onClose: () => void;
}
```

Change it to (remove the `downloadFormat?: string;` line):

```typescript
interface MixtapeExportModalProps {
  tracks: ExportTrack[];
  defaultTitle?: string;
  defaultCoverPath?: string | null;
  defaultMetadata?: Record<string, string> | null;
  defaultMixtapeType?: MixtapeType;
  onClose: () => void;
}
```

- [ ] **Step 2: Add the import and drop `downloadFormat` from the destructure**

Near the top of the file, after the existing `import { formatDuration, formatFileSize } from "../utils";` line, add:

```typescript
import { MIXTAPE_FORMAT_LADDER, MIXTAPE_FORMAT_DEFAULT } from "../utils/mixtapeFormatLadder";
```

The component signature currently is:

```typescript
export function MixtapeExportModal({ tracks, defaultTitle, defaultCoverPath, defaultMetadata, defaultMixtapeType, downloadFormat, onClose }: MixtapeExportModalProps) {
```

Change it to (remove `downloadFormat`):

```typescript
export function MixtapeExportModal({ tracks, defaultTitle, defaultCoverPath, defaultMetadata, defaultMixtapeType, onClose }: MixtapeExportModalProps) {
```

- [ ] **Step 3: Add `maxFormat` state**

Immediately after the existing `const [title, setTitle] = useState(defaultTitle || "");` line, add:

```typescript
  const [maxFormat, setMaxFormat] = useState<string>(MIXTAPE_FORMAT_DEFAULT);
```

- [ ] **Step 4: Send `maxFormat` to the backend**

In `handleExport`, the `export_mixtape_full` invoke currently ends with:

```typescript
            tracks: trackInputs,
            format: downloadFormat || "flac",
          },
        });
```

Change the `format` line to:

```typescript
            tracks: trackInputs,
            format: maxFormat,
          },
        });
```

- [ ] **Step 5: Add `maxFormat` to the `handleExport` dependency array**

The `handleExport` `useCallback` dependency array currently is:

```typescript
  }, [title, metadataEntries, mixtapeType, coverPath, includeThumb, trackList, exportMode]);
```

Change it to:

```typescript
  }, [title, metadataEntries, mixtapeType, coverPath, includeThumb, trackList, exportMode, maxFormat]);
```

- [ ] **Step 6: Render the picker, gated on full mode + remote tracks**

In the JSX, the "Export mode" block currently ends with:

```tsx
                    {exportMode === "playlist" && (
                      <p className="mixtape-export-hint">Track list and cover only — no audio files</p>
                    )}
                  </div>
```

Insert a new format-picker row directly after the closing `</div>` of `mixtape-export-mode` (so it sits as the next sibling row, still inside `mixtape-export-fields`):

```tsx
                    {exportMode === "playlist" && (
                      <p className="mixtape-export-hint">Track list and cover only — no audio files</p>
                    )}
                  </div>
                  {exportMode === "full" && trackList.some(t => trackStatus(t) !== "local") && (
                    <div className="mixtape-export-row">
                      <label>
                        Max preferred format
                        <select value={maxFormat} onChange={(e) => setMaxFormat(e.target.value)}>
                          {MIXTAPE_FORMAT_LADDER.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
```

Note: `mixtape-export-row` and the bare `<label>` + nested `<select>` mirror the existing "Type" row (`MixtapeExportModal.tsx`, the Type `<select>`), so styling is consistent and no new CSS is needed.

- [ ] **Step 7: Type-check just this file's logic via the test suite**

Run: `npm test -- --run mixtapeFormatLadder`
Expected: PASS (unchanged — confirms the imported constants resolve).

Note: a full `npx tsc --noEmit` will still report the App.tsx call site passing the now-removed `downloadFormat` prop. That is fixed in Task 8 and verified at Task 10. Do not run the full type-check here.

- [ ] **Step 8: Commit**

```bash
git add src/components/MixtapeExportModal.tsx
git commit -m "feat(mixtape): per-export max preferred format picker for remote tracks"
```

---

### Task 3: Remove the Download format row from SettingsPanel

**Files:**
- Modify: `src/components/SettingsPanel.tsx`

- [ ] **Step 1: Remove the two props from the props interface**

In `src/components/SettingsPanel.tsx`, the props interface contains:

```typescript
  downloadFormat: string;
  onDownloadFormatChange: (format: string) => void;
```

Delete both lines.

- [ ] **Step 2: Remove them from the destructured parameters**

The component destructure contains:

```typescript
  downloadFormat,
  onDownloadFormatChange,
```

Delete both lines.

- [ ] **Step 3: Remove the Download format settings row**

The JSX contains this block (inside the Downloads settings card, immediately after the downloads-folder row's closing `</div>`):

```tsx
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Download format</span>
                        <span className="settings-description">Preferred format for saving tracks</span>
                      </div>
                      <select
                        value={downloadFormat}
                        onChange={(e) => onDownloadFormatChange(e.target.value)}
                        className="ds-select"
                      >
                        <option value="flac">FLAC (Lossless)</option>
                        <option value="aac">M4A (AAC)</option>
                      </select>
                    </div>
```

Delete the entire block.

- [ ] **Step 4: Verify no remaining references in this file**

Run: `grep -n "downloadFormat\|onDownloadFormatChange" src/components/SettingsPanel.tsx`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsPanel.tsx
git commit -m "refactor(settings): remove Download format setting row"
```

---

### Task 4: Drop `downloadFormat` prop from the download modals

**Files:**
- Modify: `src/components/DownloadModal.tsx`
- Modify: `src/components/download/SingleTrackDownload.tsx`
- Modify: `src/components/download/MultiTrackDownload.tsx`

The setting only ever seeded the modal's initial quality; `lastDownloadQuality` immediately overrides it. Replace the seed with a literal `"flac"`.

- [ ] **Step 1: SingleTrackDownload — remove prop from destructure**

In `src/components/download/SingleTrackDownload.tsx`, the destructured params include `downloadFormat,`. Remove that line. The typed params block includes `downloadFormat: string;`. Remove that line too.

- [ ] **Step 2: SingleTrackDownload — replace the seed expression**

The quality state initializer currently is:

```typescript
  const [quality, setQualityState] = useState<string>(() => {
    if (hasProviderQualities) return qualities[0].value;
    return downloadFormat === "flac" ? "flac" : "aac";
  });
```

Change it to:

```typescript
  const [quality, setQualityState] = useState<string>(() => {
    if (hasProviderQualities) return qualities[0].value;
    return "flac";
  });
```

- [ ] **Step 3: MultiTrackDownload — remove prop from destructure**

In `src/components/download/MultiTrackDownload.tsx`, remove `downloadFormat,` from the destructured params and `downloadFormat: string;` from the typed params block.

- [ ] **Step 4: MultiTrackDownload — replace the seed expression**

The quality state initializer currently is:

```typescript
  const [quality, setQualityState] = useState<string>(
    hasProviderQualities ? qualities[0].value : (downloadFormat === "flac" ? "flac" : "aac")
  );
```

Change it to:

```typescript
  const [quality, setQualityState] = useState<string>(
    hasProviderQualities ? qualities[0].value : "flac"
  );
```

- [ ] **Step 5: DownloadModal — remove the pass-through prop**

In `src/components/DownloadModal.tsx`:
- Remove `downloadFormat: string;` from the `DownloadModalProps` interface.
- Remove `downloadFormat,` from the destructured params.
- Remove the `downloadFormat={downloadFormat}` line from BOTH the `<SingleTrackDownload ... />` and `<MultiTrackDownload ... />` JSX usages.

- [ ] **Step 6: Verify no remaining references across the three files**

Run: `grep -rn "downloadFormat" src/components/DownloadModal.tsx src/components/download/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/DownloadModal.tsx src/components/download/SingleTrackDownload.tsx src/components/download/MultiTrackDownload.tsx
git commit -m "refactor(downloads): drop downloadFormat seed prop, default to flac"
```

---

### Task 5: Remove `getDownloadFormat` from the plugin API type

**Files:**
- Modify: `src/types/plugin.ts`

- [ ] **Step 1: Remove the method from `PluginDownloadsAPI`**

The interface currently is:

```typescript
export interface PluginDownloadsAPI {
  getDownloadFormat(): Promise<string>;
  enqueue(request: DownloadRequest): Promise<number>;
  onResolveByUri(providerId: string, handler: DownloadResolveByUriHandler): () => void;
  onResolveByMetadata(providerId: string, handler: DownloadResolveByMetadataHandler): () => void;
  onInteractiveSearch(providerId: string, handler: InteractiveSearchHandler): () => void;
  onInteractiveResolve(providerId: string, handler: InteractiveResolveHandler): () => void;
  onGetQualities(providerId: string, handler: GetQualitiesHandler): () => void;
}
```

Remove the `getDownloadFormat(): Promise<string>;` line.

- [ ] **Step 2: Commit**

```bash
git add src/types/plugin.ts
git commit -m "refactor(plugins): remove getDownloadFormat from PluginDownloadsAPI"
```

---

### Task 6: Remove `getDownloadFormat` from usePlugins

**Files:**
- Modify: `src/hooks/usePlugins.ts`

- [ ] **Step 1: Remove the API implementation**

The `downloads` API object currently begins:

```typescript
        downloads: {
          async getDownloadFormat() {
            return playbackCallbacksRef.current?.getDownloadFormat() ?? "flac";
          },
          async enqueue(request) {
```

Remove the `async getDownloadFormat() { ... },` method so it begins:

```typescript
        downloads: {
          async enqueue(request) {
```

- [ ] **Step 2: Remove the field from `PluginPlaybackCallbacks`**

The interface currently is:

```typescript
export interface PluginPlaybackCallbacks {
  playTrack: (track: PluginTrack) => void;
  playTracks: (tracks: PluginTrack[], startIndex?: number, context?: { name?: string; playlistName?: string; coverUrl?: string | null; source?: string | null; description?: string | null; metadata?: Record<string, string> | null }) => void;
  insertTrack: (track: PluginTrack, position: number) => void;
  insertTracks: (tracks: PluginTrack[], position: number) => void;
  getDownloadFormat: () => string;
}
```

Remove the `getDownloadFormat: () => string;` line.

- [ ] **Step 3: Verify no remaining references in this file**

Run: `grep -n "getDownloadFormat" src/hooks/usePlugins.ts`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/usePlugins.ts
git commit -m "refactor(plugins): drop getDownloadFormat host implementation"
```

---

### Task 7: Inline the resolve-request listener into App.tsx and delete useDownloads

**Files:**
- Modify: `src/App.tsx`
- Delete: `src/hooks/useDownloads.ts`

This moves the `download-resolve-request` listener + `resolveTrackDownload` helper into App.tsx and removes the `useDownloads` call. (`listen`, `invoke`, `useEffect`, `DownloadProvider`, `DownloadResolveResult` are already imported in App.tsx.)

- [ ] **Step 1: Add the `resolveTrackDownload` helper at module scope in App.tsx**

In `src/App.tsx`, add this function at module scope (outside the component — e.g. directly above the `function App()` / `export default` region, near other top-level helpers). It is copied verbatim from the deleted hook:

```typescript
async function resolveTrackDownload(
  providers: DownloadProvider[],
  uri: string | null,
  title: string,
  artistName: string | null,
  albumName: string | null,
  durationSecs: number | null,
  format: string,
  provider?: string | null,
): Promise<DownloadResolveResult | null> {
  const targetProviders = provider
    ? providers.filter(p => p.id === provider)
    : providers;

  if (uri) {
    for (const p of targetProviders) {
      try {
        const result = await Promise.race([
          p.resolveByUri(uri, format),
          new Promise<null>((r) => setTimeout(() => r(null), 10000)),
        ]);
        if (result) return result;
      } catch {
        continue;
      }
    }
  }

  for (const p of targetProviders) {
    try {
      const result = await Promise.race([
        p.resolveByMetadata(title, artistName, albumName, durationSecs, format),
        new Promise<null>((r) => setTimeout(() => r(null), 10000)),
      ]);
      if (result) return result;
    } catch {
      continue;
    }
  }

  return null;
}
```

- [ ] **Step 2: Add the listener effect inside the component**

The component currently has, around line 441-442:

```typescript
  const downloadProvidersRef = useRef<DownloadProvider[]>([]);
  downloadProvidersRef.current = downloadProviders;
```

Immediately after those two lines, add the inlined listener effect:

```typescript
  // Respond to backend download-resolve-request events by walking the plugin
  // download-provider chain. (Inlined from the former useDownloads hook.)
  useEffect(() => {
    const unlisten = listen<{
      id: number;
      title: string;
      artist_name: string | null;
      album_title: string | null;
      duration_secs: number | null;
      uri: string | null;
      format: string;
      provider: string | null;
    }>("download-resolve-request", async (event) => {
      const { id, title, artist_name, album_title, duration_secs, uri, format, provider } = event.payload;
      const result = await resolveTrackDownload(
        downloadProvidersRef.current,
        uri, title, artist_name, album_title, duration_secs, format, provider,
      );
      await invoke("download_resolve_response", { id, result: result ?? null });
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);
```

- [ ] **Step 3: Remove the `useDownloads` call**

The component contains, around line 643-644:

```typescript
  // Downloads
  const downloads = useDownloads(downloadFormatRef, downloadProvidersRef);
```

Delete both lines.

- [ ] **Step 4: Remove the `useDownloads` import**

Remove this import line from App.tsx:

```typescript
import { useDownloads } from "./hooks/useDownloads";
```

- [ ] **Step 5: Delete the hook file**

Run: `git rm src/hooks/useDownloads.ts`

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "refactor(downloads): inline resolve-request listener, delete useDownloads"
```

Note: App.tsx still references `downloads.*` and `downloadFormatRef` elsewhere — those are removed in Task 8. The full type-check runs at Task 10.

---

### Task 8: Remove remaining `downloads.*` / `downloadFormatRef` references in App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Remove the `downloadFormatRef` declaration**

The component contains, around line 289:

```typescript
  const downloadFormatRef = useRef("flac");
```

Delete the line.

- [ ] **Step 2: Remove the `getDownloadFormat` callback from `pluginPlaybackCallbacks`**

The `pluginPlaybackCallbacks` memo ends with:

```typescript
    getDownloadFormat: () => downloadFormatRef.current,
  }), [queueHook, pluginTrackToQueueTrack]);
```

Remove the `getDownloadFormat: () => downloadFormatRef.current,` line so it ends:

```typescript
  }), [queueHook, pluginTrackToQueueTrack]);
```

- [ ] **Step 3: Fix the non-interactive enqueue to pass `format: null`**

The non-interactive enqueue block currently is:

```typescript
      invoke("enqueue_download", {
        title: track?.title ?? title,
        artistName: track?.artist_name ?? artistName,
        albumTitle: track?.album_title ?? null,
        uri: track?.path ?? null,
        durationSecs: track?.duration_secs ?? null,
        destCollectionId: null,
        format: downloadFormatRef.current,
        provider: providerId,
      }).catch((e: unknown) => {
```

Change the `format` line to `format: null,`:

```typescript
      invoke("enqueue_download", {
        title: track?.title ?? title,
        artistName: track?.artist_name ?? artistName,
        albumTitle: track?.album_title ?? null,
        uri: track?.path ?? null,
        durationSecs: track?.duration_secs ?? null,
        destCollectionId: null,
        format: null,
        provider: providerId,
      }).catch((e: unknown) => {
```

- [ ] **Step 4: Remove the SettingsPanel format props**

The `<SettingsPanel ... />` usage contains:

```tsx
              downloadFormat={downloads.downloadFormat}
              onDownloadFormatChange={(format) => downloads.setFormat(format, store)}
```

Delete both lines.

- [ ] **Step 5: Remove the DownloadModal format prop**

The `<DownloadModal ... />` usage contains:

```tsx
          downloadFormat={downloads.downloadFormat}
```

Delete the line.

- [ ] **Step 6: Remove the MixtapeExportModal format prop**

The `<MixtapeExportModal ... />` usage contains:

```tsx
          downloadFormat={downloads.downloadFormat}
```

Delete the line.

- [ ] **Step 7: Verify no remaining references in App.tsx**

Run: `grep -n "downloads\.\|downloadFormatRef\|onDownloadFormatChange" src/App.tsx`
Expected: no output. (The restore-path references in `readPersistedSettings` are handled in Task 9.)

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx
git commit -m "refactor(app): remove downloadFormat ref, props, and getDownloadFormat callback"
```

---

### Task 9: Remove `downloadFormat` from the store and restore path

**Files:**
- Modify: `src/store.ts`
- Modify: `src/startup/readPersistedSettings.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Remove the store default**

In `src/store.ts`, remove the line:

```typescript
  downloadFormat: "flac",
```

- [ ] **Step 2: Remove the type field from `PersistedSettings`**

In `src/startup/readPersistedSettings.ts`, remove the line:

```typescript
  downloadFormat: string | null | undefined;
```

- [ ] **Step 3: Remove `downloadFormat` from the destructure, the Promise.all, and the return**

In `readPersistedSettings`, the destructure line currently is:

```typescript
    downloadFormat, filterYoutubeOnly, mediaTypeFilter, trackLikedFirst,
```

Change it to:

```typescript
    filterYoutubeOnly, mediaTypeFilter, trackLikedFirst,
```

In the `Promise.all([...])`, remove the line:

```typescript
    store.get<string | null>("downloadFormat"),
```

In the return object, the line currently is:

```typescript
    downloadFormat, filterYoutubeOnly, mediaTypeFilter, trackLikedFirst,
```

Change it to:

```typescript
    filterYoutubeOnly, mediaTypeFilter, trackLikedFirst,
```

- [ ] **Step 4: Remove the restore destructure + apply in App.tsx**

In `src/App.tsx`, the restore destructure contains:

```typescript
          downloadFormat: savedDownloadFormat, filterYoutubeOnly: savedFilterYoutubeOnly,
```

Change it to:

```typescript
          filterYoutubeOnly: savedFilterYoutubeOnly,
```

And remove the apply line:

```typescript
        if (savedDownloadFormat && ["flac", "aac"].includes(savedDownloadFormat)) { downloads.setFormat(savedDownloadFormat, store); }
```

- [ ] **Step 5: Verify no remaining references**

Run: `grep -rn "downloadFormat" src/`
Expected: only matches in `src/utils/mixtapeFormatLadder.ts` comments/names referencing the LADDER (no `downloadFormat` identifier) — confirm there are NO matches for the bare `downloadFormat` store key or prop. Specifically expect zero hits in `src/store.ts`, `src/startup/readPersistedSettings.ts`, and `src/App.tsx`.

- [ ] **Step 6: Commit**

```bash
git add src/store.ts src/startup/readPersistedSettings.ts src/App.tsx
git commit -m "refactor(store): remove downloadFormat key and restore path"
```

---

### Task 10: Full regression gate

**Files:** none (verification only)

- [ ] **Step 1: TypeScript type-check**

Run: `npx tsc --noEmit`
Expected: no errors. (This is the first full type-check since Task 2 — it validates that every dropped prop/field/import is consistent across all files.)

- [ ] **Step 2: Frontend test suite**

Run: `npm test`
Expected: all suites pass, including the new `mixtapeFormatLadder` test. The previously-existing `builtinDownloadQualities` test and all others stay green.

- [ ] **Step 3: Rust compile check (confirms no backend coupling broke)**

Run: `cd src-tauri && cargo check`
Expected: compiles cleanly. (No Rust files were changed; this is a safety net.)

- [ ] **Step 4: If any step fails, fix and re-run before proceeding.**

No commit (verification only). If fixes were needed, commit them with a descriptive message.

---

### Task 11: Update project rule docs

**Files:**
- Modify: `.claude/rules/conventions.md`
- Modify: `.claude/rules/plugins.md`

- [ ] **Step 1: Fix the Download Track canonical reference**

In `.claude/rules/conventions.md`, the Download Track entry currently reads:

```markdown
- **Canonical:** `useDownloads.ts` -> `downloadTrack()`
```

`useDownloads.ts` no longer exists and `downloadTrack` was removed. The remaining canonical download paths are in `useContextMenuActions.ts`. Change the line to:

```markdown
- **Canonical:** `useContextMenuActions.ts` -> `handleDownloadTrack()` / `handleDownloadMulti()`; the unified `DownloadModal` flow is wired in `App.tsx`
```

- [ ] **Step 2: Remove the `getDownloadFormat` API doc line**

In `.claude/rules/plugins.md`, under the `api.downloads` section, remove the line:

```markdown
- `getDownloadFormat()` — returns the user's configured download format (`"flac" | "m4a" | "mp3" | "aac"`)
```

- [ ] **Step 3: Verify**

Run: `grep -rn "getDownloadFormat\|useDownloads" .claude/rules/`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add .claude/rules/conventions.md .claude/rules/plugins.md
git commit -m "docs: update rules for mixtape format picker + downloads cleanup"
```

---

## Self-Review Notes

- **Spec coverage:** Ladder (Task 1) ✓; modal picker + gating + send hint (Task 2) ✓; remove Settings row (Task 3) ✓; DownloadModal seed → literal (Task 4) ✓; remove `getDownloadFormat` API + impl (Tasks 5–6) ✓; inline listener + delete `useDownloads` + remove `downloadTrack` (Task 7 deletes the whole file, which contained `downloadTrack`) ✓; collapse `downloadFormatRef` → `format: null` (Task 8) ✓; store + restore removal (Task 9) ✓; tests/gate (Tasks 1, 10) ✓; doc updates (Task 11) ✓.
- **`downloadTrack` removal:** handled implicitly by deleting `useDownloads.ts` in Task 7 (the function had zero callers, confirmed during design).
- **Type consistency:** `MIXTAPE_FORMAT_LADDER`/`MIXTAPE_FORMAT_DEFAULT`/`MixtapeFormatOption` names match between Task 1 (definition) and Task 2 (import). `resolveTrackDownload` signature in Task 7 is copied verbatim from the source.
- **Intentional mid-plan TS errors:** Tasks 2–9 leave App.tsx temporarily inconsistent; this is called out at each task and resolved by the Task 10 gate. Commits remain individually meaningful even if not all independently type-clean — acceptable for a tightly-coupled removal, and the gate guarantees the final state compiles.
