# Handoff: Now Playing cue sheets

Branch: `feat/now-playing-cue-sheets` (from `main` at `84d82fbc`). Status: **first working version, not yet tried in the real app.**

## What it is

An AI assistant (over the control API / MCP) reads a song's lyrics, meaning, bio, review, quality and tags, writes a **cue sheet** — timed cards — and the Now Playing view plays those cards over the album art while the song plays.

The idea came from: "should an AI assistant that controls the app be allowed to change what the user sees in Now Playing — detect things from lyrics/titles and show images or text?" The answer chosen: the AI does **not** drive the screen live (latency, cost, and it would break "plugins render, the host acts"). It **pre-writes** a cue sheet per song, which is cached and played back on the host clock.

## Flow

1. `get_cue_context` (MCP) → `GET /v1/cues/context?title&artistName` (defaults to the playing track). Returns:
   - `track` — title, artist, album, album artist, duration, `quality` (e.g. "FLAC · 96.0 kHz · 24-bit"), `isPlaying`
   - `lyrics` — synced → `lines: [{ at, text }]` (the clock to place cues on), else plain `text`
   - `prose` — every info value of display kind `rich_text` / `html` / `annotated_text` / `annotations` for song, artist and album (song story / meaning, lyric annotations, bio, review), as plain text, capped at 6000 chars each
   - `tags`, `existingSheet`, and `guide` (the format + pacing rules, `CUE_SHEET_GUIDE`)
2. The assistant writes cues and calls `cue_sheet` with `action=set` → `PUT /v1/cues { title, artistName, sheet: { cues }, source }`.
3. The backend normalizes and stores the sheet and emits `cue-sheet-changed`. An open Now Playing view reloads it immediately, with no replay.

Cue shape: `{ at, until?, kind: "text" | "quote" | "image", text?, caption?, label?, imageUrl? }`. One card is shown at a time. It stays until `until`, else 10s (`DEFAULT_CUE_SECS`), and always gives way to the next cue.

## Files

| Area | File | Notes |
|---|---|---|
| Storage | `src-tauri/src/db/cue_sheets.rs` | Table `cue_sheets` (init_tables + migration #14 in `db/mod.rs`). Keyed by the likes store's `track:{artist}:{title}` entity key. `normalize_cue_sheet` is the trust boundary (see below). Rust tests at the bottom. |
| Commands | `src-tauri/src/commands/library.rs` | `cue_sheet_get` / `cue_sheet_set` / `cue_sheet_delete`; registered in `lib.rs`. Writes emit `cue-sheet-changed`. |
| HTTP | `src-tauri/src/control_api.rs` | `GET/PUT/DELETE /v1/cues`, `GET /v1/cues/context` (slow bridge). All bridged to the webview. |
| SQL notes | `src-tauri/src/db/control_query.rs` | Schema note for `cue_sheets`. |
| Dispatcher | `src/hooks/useControlApi.ts` | `cues.get` / `cues.set` / `cues.delete` / `cues.context`; `cueSong()` defaults to the playing track. |
| Context | `src/utils/cueContext.ts` | `gatherCueContext`, plus pure `proseText` / `lyricsForContext`. |
| Timing | `src/utils/cueSheet.ts` | Types, `activeCueIndex`, `cueEnd`, `sameCueSong`, `CUE_SHEET_GUIDE`. |
| Quality | `src/hooks/useNowPlayingInfo.ts` | Quality lookup extracted into the exported `resolveTrackQuality(track, { playing })`, shared with the Quality info item (behaviour unchanged). |
| UI | `src/hooks/useCueSheet.ts`, `src/components/CueOverlay.tsx` + `.css`, `NowPlayingView.tsx/.css`, `App.tsx` | The overlay sits in the art column (over a visualizer too). The corner button shows **only** when the song has a sheet. The hide flag is persisted as `nowPlayingCuesHidden` (`startup/readPersistedSettings.ts`). |
| MCP | `mcp/tools.mjs`, `mcp/README.md` | Tools `get_cue_context` (read-only) and `cue_sheet` (`readOnlyWhen` action=get), plus a "Cue sheet recipe" line in `INSTRUCTIONS`. |
| Docs | `.claude/rules/backend.md` ("Cue sheets"), `ui.md` (Now Playing View → Cue cards), `frontend.md` | |
| Tests | `src/__tests__/cueSheet.test.ts`, `tests/e2e/specs/now-playing-cues.test.js`, `tests/e2e/tauri-mock.js` (`window.__E2E_CUES__` fixture) | |

## Decisions (and why)

- **Host overlay, not a visualizer plugin.** A visualizer replaces the art or the vinyl deck; cue cards describe the song, so they sit on top of whatever is in the art column.
- **No write scope.** It is DB-only and touches no file, the same footing as `/v1/likes`. The user can hide the cards from the view.
- **Metadata-keyed.** Like likes, so a sheet follows the song onto any copy (library, stream, id-less queue entry).
- **Backend validation is strict, and its errors name the cue index.** The author is an LLM: unknown fields are dropped, kinds are a closed set, times are finite seconds ≤ 24h with `until > at`, text ≤ 400 / caption ≤ 200 / label ≤ 40 chars, ≤ 200 cues, and **image URLs must be http(s)** (no file paths or data URIs reach `<img>`).
- **Cards paint on artwork**, so they use `--scrim-rgb` / `--on-image-rgb` / `--hero-text-*`, never `--overlay-*`.
- **The button is hidden, not disabled, without a sheet** (unlike Lyrics): almost no track has one.

## Verified

- `cargo test --lib cue` passes (4 tests); `cargo test --lib control` passes (43).
- `npx tsc --noEmit` is clean; eslint shows no errors in the touched files.
- `src/__tests__/cueSheet.test.ts` passes (7); assistantTools / mcpServer / controlApi tests pass.
- E2E `now-playing-cues` (3) and `now-playing-about` (3) pass. A screenshot showed the card rendering over the art.
- The full `npm test` run had **3 failures, in `pluginSigningScript.test.ts` and `sitePersonas.test.ts`**. These are untouched areas (the plugin-signing fixtures and the docs site) and look unrelated, but this wasn't confirmed against a clean `main`.

## Not done / next steps

1. **End-to-end with a real assistant.** Run `npm run tauri dev`, enable Settings → AI control, connect Claude via MCP, play a song with synced lyrics and ask it to make a cue sheet. Judge the pacing and the guide text (`CUE_SHEET_GUIDE`) on real output, and tune it.
2. **Image cues are untested with real URLs.** Text and quote cues are the reliable part. Consider whether image cues should stay, or need an allow-list of hosts.
3. **No UI to delete or inspect a sheet** except the hide toggle and the API. Possibly add "Remove cue sheet" somewhere (a native menu item on the button?).
4. **Precompute ahead of playback.** The recipe tells the assistant it *may* do upcoming queue tracks, but nothing in-app triggers generation. An in-app path would be a plugin using `api.assistant.host` + an LLM key.
5. **`nowPlayingInfo` push API.** Text cues could also flash in the mini player's info line, but that API has no mid-track push yet (see plugins.md `api.nowPlayingInfo`).
6. Confirm whether the 3 unrelated test failures also fail on `main`.

## How to try it quickly without an AI

With the control API on (Settings → AI control) and a song playing:

```bash
TOKEN=...; PORT=...   # from control-api.json in the profile dir
curl -s -X PUT "http://127.0.0.1:$PORT/v1/cues" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sheet":{"cues":[{"at":5,"kind":"text","label":"Trivia","text":"Hello from a cue sheet"}]},"source":"curl"}'
```

Open Now Playing; the card appears at 0:05.
