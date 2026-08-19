// E2E coverage for the App.tsx context-menu extraction: the ~280-line
// buildAndShowNativeMenu useCallback body was moved into a pure function
// contextMenu/buildContextMenuSpecs.tsx. App.tsx keeps a thin wrapper that owns
// setContextMenu + showNativeMenu (which uses the native Tauri menu API and so
// can't render in a browser). We exercise the pure builder directly in the live
// Vite webview and assert the returned MenuItemSpec[] structure per target kind.
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const tauriMockPath = path.resolve(__dirname, '..', 'tauri-mock.js');

// Calls buildContextMenuSpecs(target, deps) in the page and returns the visible
// item/check/submenu texts (separators flattened out). Stub deps are built
// entirely in-page (functions can't cross the evaluate boundary); only
// serializable DATA overrides are passed in (e.g. library tags).
async function buildSpecTexts(page, target, dataOverrides = {}) {
  return page.evaluate(async ({ target, dataOverrides }) => {
    const mod = await import('/src/contextMenu/buildContextMenuSpecs.tsx');
    const noop = () => {};
    const deps = {
      contextMenuActions: {
        setContextMenu: noop,
        handleContextPlay: noop, handleContextEnqueue: noop,
        handleQueueRemove: noop, handleQueueKeepOnly: noop,
        handleQueueMoveToTop: noop, handleQueueMoveToBottom: noop,
        handleShowInFolder: noop, handleDeleteRequest: noop,
        handleDownloadTrack: noop, handleDownloadMulti: noop,
        handleBulkEdit: noop, handleWatchOnYoutube: noop,
        watchOnYoutube: noop, startRadio: noop,
      },
      videoLayout: { setFitMode: noop, setDockSide: noop },
      queueHook: { queue: dataOverrides.queue ?? [] },
      library: {
        tracks: dataOverrides.tracks ?? [],
        tags: dataOverrides.tags ?? [],
        handleLocateTrack: noop, handleTrackClick: noop, setView: noop,
        setSelectedArtist: noop, setSelectedAlbum: noop, setSelectedTag: noop,
      },
      plugins: { menuItems: dataOverrides.menuItems ?? [], dispatchContextMenuAction: noop },
      searchProviders: dataOverrides.searchProviders ?? [],
      // Null = no provider owns this target's source, so the native "Download…"
      // item is omitted. Override via dataOverrides to exercise the item.
      resolveNativeDownload: () => dataOverrides.nativeDownload ?? null,
      openNativeDownload: noop,
      artistImageCache: { requestFetch: noop },
      albumImageCache: { requestFetch: noop },
      tagImageCache: { requestFetch: noop },
      beginRetrieveImage: noop,
      setSearchInitialQuery: noop, setSearchQueryKey: noop, setDeleteTagConfirm: noop,
      trashLabel: 'Trash',
      // Ref-shaped deps: the builder reads `.current` to decide whether the
      // owning modal exists, so these must be objects, not bare nulls.
      handleExportAsMixtapeRef: { current: null },
      openPublishMusicSourceRef: { current: null },
      openEditTrackInfoRef: { current: null },
    };
    const specs = mod.buildContextMenuSpecs(target, deps);
    if (!specs) return null;
    const texts = [];
    const walk = (arr) => arr.forEach((s) => {
      if (s.kind === 'separator') return;
      if (s.text) texts.push(s.text);
      if (s.kind === 'submenu' && s.items) walk(s.items);
    });
    walk(specs);
    return texts;
  }, { target, dataOverrides });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ path: tauriMockPath });
  await page.goto('/');
  await page.waitForSelector('.sidebar');
});

test('video target yields fit-mode and dock-side check items', async ({ page }) => {
  const texts = await buildSpecTexts(page, { kind: 'video', dockSide: 'bottom', fitMode: 'contain' });
  expect(texts).toContain('Contain');
  expect(texts).toContain('Fill');
  expect(texts).toContain('Bottom');
  expect(texts).toContain('Right');
});

test('local track target has Play / Open Folder / Move to Trash', async ({ page }) => {
  const texts = await buildSpecTexts(page, {
    kind: 'track', trackId: 5, isLocal: true, title: 'Song', artistName: 'Artist',
  });
  expect(texts).toContain('Play');
  expect(texts).toContain('Enqueue');
  expect(texts).toContain('Open Containing Folder');
  expect(texts).toContain('Move to Trash');
  expect(texts).toContain('View Details');
});

test('multi-tag target offers delete-N-tags', async ({ page }) => {
  const texts = await buildSpecTexts(page, { kind: 'multi-tag', tagIds: [1, 2, 3] }, {
    tags: [{ id: 1, name: 'rock' }, { id: 2, name: 'pop' }, { id: 3, name: 'jazz' }],
  });
  expect(texts).toContain('Play 3 tags');
  expect(texts).toContain('Enqueue 3 tags');
  expect(texts).toContain('Delete 3 tags');
});

test('artist target offers Play All / Retrieve Image', async ({ page }) => {
  const texts = await buildSpecTexts(page, { kind: 'artist', artistId: 7, name: 'Some Artist' });
  expect(texts).toContain('Play');
  expect(texts).toContain('Retrieve Image');
});

// There are deliberately NO host-generated per-provider download entries
// ("Download from {X}…" / "Upgrade from {X}…") — providers contribute their own
// context-menu items instead (plugin-first). These tests pin the removal: the
// host offers only the source-owned "Download…" and the batch item.

test('local library track gets no host download or upgrade entries', async ({ page }) => {
  const texts = await buildSpecTexts(page, {
    kind: 'track', trackId: 5, isLocal: true, title: 'Song', artistName: 'Artist',
  });
  expect(texts.some(t => t.startsWith('Download'))).toBe(false);
  expect(texts.some(t => t.startsWith('Upgrade'))).toBe(false);
});

test('non-local track offers only the source-owned Download…', async ({ page }) => {
  // With a native provider (the track's own source), the single entry shows.
  const texts = await buildSpecTexts(page, {
    kind: 'track', trackId: 5, isLocal: false, title: 'Song', artistName: 'Artist',
  }, { nativeDownload: { providerId: '__builtin:subsonic', providerName: 'Subsonic' } });
  expect(texts).toContain('Download…');
  expect(texts.some(t => t.startsWith('Download from'))).toBe(false);
  expect(texts.some(t => t.startsWith('Upgrade'))).toBe(false);

  // Without one, no download entry at all — per-provider fallbacks are gone.
  const bare = await buildSpecTexts(page, {
    kind: 'track', trackId: 5, isLocal: false, title: 'Song', artistName: 'Artist',
  });
  expect(bare.some(t => t.startsWith('Download'))).toBe(false);
});

test('single local queue selection gets no Upgrade entries', async ({ page }) => {
  const queueTrack = {
    key: 'lib:5', path: 'file:///music/a.mp3', title: 'Song',
    artist_name: 'Artist', album_title: null, duration_secs: 100, format: null, liked: 0,
  };
  const target = {
    kind: 'queue-multi', indices: [0], trackIds: [5],
    firstTrack: { title: 'Song', artistName: 'Artist', isLocal: true },
  };
  const texts = await buildSpecTexts(page, target, { queue: [queueTrack] });
  expect(texts.some(t => t.startsWith('Upgrade'))).toBe(false);
  expect(texts.some(t => t.startsWith('Download'))).toBe(false);
});

test('track with no id omits Play/Enqueue/Trash but keeps metadata-only actions', async ({ page }) => {
  const texts = await buildSpecTexts(page, { kind: 'track', title: 'X', artistName: null });
  // No trackId -> no Play/Enqueue/View Details; no isLocal -> no folder/trash.
  expect(texts).not.toContain('Play');
  expect(texts).not.toContain('Enqueue');
  expect(texts).not.toContain('Open Containing Folder');
  expect(texts).not.toContain('Move to Trash');
  expect(texts).not.toContain('View Details');
  // "Start radio from this track" only needs a title -> still present.
  expect(texts).toContain('Start radio from this track');
});
