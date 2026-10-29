# YouTube Shorts: scenarios per persona

Status: draft for review (2026-10-24; revised plan + Reddit targets 2026-10-27). Step 1 of 2: decide *what* each short shows. Step 2
(automating the recording) comes after these are agreed.

## Ground rules for the whole series

- **Series frame: "Your music. Your AI."** (motto since 2026-10-28; was "the player for music
  you own"). Same positioning as the site
  (`.claude/rules/site.md` → Positioning). Collectors, self-hosters and audiophiles are the
  headline audiences, so their shorts are released first. AI control gets a short of its own but
  never opens the series.
- **Exception (owner decision, 2026-10-28): the self-hosters short uses the owner's real
  Navidrome**, added to `perf-demo` beside the demo folder. Its address is redacted for the
  whole run (`serverRedactions`: URL → `https://navidrome.local`, a hostname name →
  "Navidrome"), credentials never reach the control API, and the collection is **disabled or
  removed right after recording** — left on, every later capture from the profile shows the
  real library. Nothing else gets this exception.
- **Record from the demo library only** (`perf-demo` profile: `npm run demo:library` →
  `demo:setup` → capture). The first site captures came from a real profile and put a whole
  collection, its history and its likes on a public page. The same applies here, more so.
- **Plugin features say so on screen.** Anything a plugin does gets a small "plugin" chip in the
  caption, just like the site's `feature-tag`.
- **Captions don't age.** No version numbers, plugin counts, sizes or "new in". Same rule as the
  persona pages.
- **Format.** 9:16 at 1080×1920. 15–30 s each (60 s at most). The hook goes in the first 2 s.
  Captions are burned in, because most Shorts are watched muted. Every short ends on a 2 s card:
  wordmark plus "viboplr.com".
- **Legal.** No real copyrighted audio, lyrics or covers we don't have the right to show. The
  demo library's covers come from the app's own art providers, exactly as the site's stills do.
  Lyrics come only from the invented album *Glass Harbour*. Download shorts show content that is
  free to share.

## Decisions (2026-10-24)

- **Framing: follow the action.** Record the full landscape window. A virtual camera then moves a
  9:16 crop to each beat's focus (an element found by name, or a fixed rect), and drops back to a
  letterbox over a blurred copy for wide moments. Options A, B and C below are superseded.
- **Audio: silent export.** Music goes in afterwards, from YouTube's Shorts editor or the Audio
  Library; `--music` mixes in a file you have the rights to. There is no safe number of seconds of
  copyrighted audio. Any Content ID claim blocks a Short over 1 minute worldwide, and a shorter one
  gets the rights holder's policy.
- **Bed chosen (2026-10-29): HoliznaCC0 — "Eat"** (Funk collection, CC0, no credit needed,
  https://opengameart.org/content/funk-collection), mixed with `--music` at −16 LUFS. CC0 so no
  Content ID claim and no description credit, and the sound is in the file, so it reaches Reddit.
  Kept outside the repo at `~/ViboplrShorts/music/holiznacc0-eat.mp3`.
- **Library shorts use the real library (2026-10-29):** tinkerers, audiophiles, self-hosters and
  rediscoverers run on the profile's own collections (`needs: ["library"]`); the runner picks the artist
  (photo + every cover, no Greek names, studio album). ~38 s each plus the end card, each closing
  on an AI scene: staged chat bubbles, the app reacting through the real control-API verbs.
- **Text only**, no voice-over.
- **Generic click / type / key** went into the control API behind its own switch (Settings → AI
  control → **Click and type**), available to MCP too. It refuses the AI control settings, the
  Extensions view and consent dialogs.
- **PoC = Batch 1 #6 (tinkerers, `tinkerers-skins`)** since 2026-10-25: existing verbs only, so
  the first take proves the camera, captions and end card without on-camera input.
  `npm run short -- --demo ~/ViboplrDemo --only tinkerers-skins --keep-raw`. The collectors' short
  (`collectors-bulk-edit`, built on the mis-tagged compilation *Late Night Drive*) stays in
  `SHORTS` but is the dullest for viewers; its AI version is in the notes below.

## AI assistant series (notes, 2026-10-25, not built yet)

Owner steer: the collectors' bulk-edit short is the dullest one for viewers, and **AI control is
the thing that spares users that work**, so the series should lead with the in-app **AI Assistant
plugin** (`outcast1000/viboplr-llm`: chat, right-click *Ask AI about this…* / *Clean up titles…*
/ *Find missing tracks…*, Cmd+K *Search on AI Assistant*, the track page's **Meaning** tab). This
supersedes two things above: "AI control never opens the series" (ground rules), and #18 being
**manual**. The chat is inside the app, so it records from the demo profile. Every caption gets
the *plugin* chip. Parked while another PoC proves the pipeline.

Candidates, lead first:

1. **"100 badly tagged files. One sentence."** *Late Night Drive* again (the data and
   `ensureCompilationMessy` already exist), with the assistant doing the fix: the album list split
   into one album per performer → open AI Assistant → type *"Late Night Drive is one compilation,
   make it Various Artists"* → the tool calls fold into "Used N tools" → the Approve card →
   Approve → Albums: one album. The collectors' setup, with the assistant as the payoff.
2. **"Something for a rainy Sunday. Nothing I played this week."** Chat → the queue panel fills
   → playback starts. "It knows your history."
3. **"Which songs did I love and forget?"** The answer comes back as library tracks → play one.
4. **Right-click → *Ask AI about this album*.** The answer with the cover inline
   (`get_entity_image`).
5. **"What is this song about?"** The Meaning tab on a *Glass Harbour* track (invented lyrics, so
   nothing to clear).
6. **Cmd+K → *Search on AI Assistant*.** Type a mood, get tracks.

Open decisions:

- **Real model or a scripted endpoint for the take.** *Real model* (a fast one via OpenRouter,
  recommended): honest, but the wording and the turn length vary (from a few seconds to over 30),
  so the pipeline needs a **wait-until step** (beats are fixed-time today) and a **visible
  fast-forward** that cuts the wait (`composeArgs` only trims the tail). *Scripted*: a tiny local
  OpenAI-compatible fake returning a fixed tool-call sequence. The tools still run for real and
  the timing is deterministic, but the model's words are staged.
- **Provider and key on `perf-demo`.** The scenario must never visit the plugin's Settings (the
  key stays off camera). #1 also needs the *Write file tags* scope, as well as AI control and the
  plugin connected.
- **The Approve card isn't protected from Click and type** (`PluginChat.tsx`,
  `.plugin-chat-approval`). An outside assistant could approve the in-app assistant's changes,
  which is the consent bypass the protected regions exist to stop, so it should get
  `data-ui-input-protected`. After that fix the take can't click Approve itself. Suggested: the
  runner waits for the card and the person recording clicks Approve live (the camera holds on
  it), rather than opening with "Approve all" already set, which loses the best beat.

## Personas × AI features (2026-10-29)

Which AI capability each persona's short (and persona page) should lead with. "In-app" is the
AI Assistant plugin (llm); "external" is Claude or any MCP client over the control API. Tool
names are the MCP server's.

| Persona | AI angle | Behind it | Example ask |
|---|---|---|---|
| **Collectors** | Tag and folder cleanup by asking | `guide` renaming + tagging recipes, `edit_track_tags`, `write_file_tags`, `manage_files` (move into Artist/Album, cover.jpg, synced lyrics), `rename_history`; in-app *Clean up titles…* / *Find missing tracks…* | "Late Night Drive is one compilation, file it under Various Artists" |
| **Audiophiles** | It checks the files, then upgrades them | `ffmpeg-tools__analyze_audio` / `media_info` (fake FLACs, transcodes, loudness), `query_library` by format, `guide` upgrade, `replace_track_file` (side-by-side compare, swap on yes) | "Which of my 'lossless' albums are really MP3s?" |
| **Self-hosters** | Your server, by asking | `collections`, `catalog_search` / `catalog_play`, `download_track` (server → local folder, tagged) | "Pull this album from Navidrome into my Music folder" |
| **Rediscoverers** | It knows your history | `query_library` over history, `start_radio`, `home_shelves`, `edit_playlist`, `lastfm__recent_scrobbles` / `top_charts`; in-app chat filling the queue | "Something for a rainy Sunday, nothing I played this week" |
| **Info lovers** | Liner notes and meaning | `get_cue_context` + `cue_sheet` (cards, lyric-video clips), `get_lyrics`, `lyrics__search_lyrics`, `get_entity_info`, `search_info`, `web_search`; Meaning tab, *Ask AI about this album* | "Explain this song as it plays" |
| **Tinkerers** | It designs a skin; plugins add tools | `manage_extensions` `create_skin` (already the tinkerers short's closing scene), `plugin_tools` | "Make me a skin from this album cover" |
| **Coders** | Music without leaving the terminal | Claude Code over MCP, `playback_control`, `play_tracks`, `get_status`, `window_control` (mini player), the REST API | "Something to focus to, then go to the mini player" |
| **Downloaders** | Find it, get it, play it | `ytdlp__search` / `ytdlp__play_url`, `download_plugin_track`, `guide` extensions (finds the plugin, the user approves the install) | "Find the music video for this song and download it" |
| **Spotify users** | Any Spotify playlist, played from sources you choose, even as clips; packed as a mixtape | `spotify-browse__list_playlists` / `get_playlist_tracks` → `play_tracks` with metadata-only entries (the stream resolvers find each song at play time, no Premium) or yt-dlp for video; `download_plugin_track` per track (explicit `pluginId`, one at a time) → `manage_files` `create_mixtape` (new 2026-10-29) | "Play my Discover Weekly as videos" / "Turn this playlist into a mixtape I can send" |

Notes:

- **Strongest fits:** collectors, info lovers, rediscoverers — the AI removes real work or
  answers what the app can't show by itself. They're also the drafted AI candidates above.
- **Audiophiles:** pitch it as "it checks your files", not as a chatbot (r/audiophile).
- **Self-hosters:** the thinnest AI story; AI as a closing beat, not the hook.
- **Spotify** stays cut from the shorts (see Cuts). If it comes back: say "your Spotify playlists,
  played from sources you choose", never "like a paid subscription"; and the download-to-mixtape
  half goes on camera only with freely licensed music (same strike rule as downloaders), with
  copy about *your* playlist rather than sharing commercial albums. The chain itself is buildable:
  downloads are per track by design (no host batch download — conventions.md), and
  `create_mixtape` is source-faithful, so streamed tracks must be downloaded first.
- **Site gap:** only coders, info-lovers and tinkerers cross-link the AI page in "Also for you".
  Audiophiles, collectors, downloaders, rediscoverers, self-hosters and spotify could each get an
  AI card using the example ask above.
- The audiophile and self-hoster asks haven't been run end to end yet; check them live before they
  go on the site or into a short.

## Revised plan (2026-10-27): merges, cuts and where to post

The 21 scenarios below plus the six AI candidates above overlap, need a person or an outside
service, or don't work as a silent short. Proposed: about ten shorts. The batches below are kept
for reference; this section wins where they disagree.

### Merges

1. **Collectors #1 + #8 + AI candidate 1 → one short.** #8 is #1's last beat (the Various Artists
   album with each performer kept), and the AI candidate uses the same *Late Night Drive* data.
   Two acts: "by hand: select, edit once" → "or just ask" → one album. Answers the "dullest"
   steer without AI opening the series.
2. **Tinkerers #6 + #16 → #6, skins only.** #16 is all hero looks, the half that already fails at
   phone size. #6's second half becomes skins over Now Playing fullscreen; #16 is dropped.
3. **Info lovers #5 + #19 + AI candidate 5 → "Every song has a story", all on Glass Harbour.**
   Synced lyrics → cue cards fading in → the Meaning tab. Removes #5's empty-About caveat and
   needs nothing cleared (the lyrics are invented). #15 (Genius, third-party text) is dropped.
4. **Rediscoverers #4 + #13 + AI candidate 3 → one short** (`rediscoverers-forgotten`, built
   2026-10-29): Home's shelves and the History view by hand, then the assistant answering
   "What did I love, then forget?" — the songs come from a real history query at run time
   (Home's forgotten-favorites pool with a five-play floor, none in 30 days; `needs: "history"`) and
   are played next, not as a new queue. #14 (auto-continue) is dropped: it shows nothing on its
   own, and the AI act is the stronger close.
5. **Coders #17 + AI #18 → one split screen: "a player your tools can drive".** curl first, then
   an assistant doing the same. #18 needs a person to record, so the curl half can ship alone.
6. **Audiophiles #3 + #12 → "Pure, or shaped".** Bit-perfect on, then off and an EQ preset.
   #11 (gapless) is dropped: its point is audible and the export is silent.

### Cuts

- **Spotify (#21):** another company's brand plus a signed-in account on a public channel, needs
  a person, and works against "music you own". Skip.
- **Downloaders (#20):** at most one, with a clearly CC-licensed target, and not early in the
  series (strike risk).
- **Self-hosters #10:** it's the website, not the app. #2 stays, blocked on the demo server.
- **Collectors #9:** later, automatable with a second synthetic FLAC + `replace_track_file`.

### Buildable today

Tinkerers (fix), info lovers, rediscoverers (built 2026-10-29, `rediscoverers-forgotten`), audiophiles — audiophiles built 2026-10-28
(`audiophiles-pure-or-shaped`). Self-hosters built the same day on the owner's real Navidrome
(`self-hosters-server`, see the exception above) instead of a demo server;
collectors and the AI shorts need the real-vs-scripted model decision. So the "primary audiences
first" rule can't hold for the first release unless those two are unblocked first. The best-fit
subreddits below belong to exactly those blocked shorts, which is a reason to unblock them early.

### Where to post (Reddit)

Each short goes out as a link plus a short description. No Linux subreddits: the release builds
macOS and Windows only.

| Persona | Short (after merges) | Subreddits |
|---|---|---|
| **Collectors** | "100 badly tagged files": edit once by hand → or just ask | r/musichoarder, r/DataHoarder, r/foobar2000, r/MusicBrainz, r/macapps, r/software |
| **Self-hosters** | "Your server, built in" (blocked on a demo Navidrome) | r/navidrome, r/selfhosted, r/subsonic, r/homelab, r/DataHoarder |
| **Audiophiles** | "Pure, or shaped": bit-perfect, then EQ | r/audiophile, r/headphones, r/HeadphoneAdvice, r/musichoarder, r/macapps |
| Rediscoverers | Home → Forgotten favorites → History → "What did I love, then forget?" | r/musichoarder, r/lastfm, r/truespotify, r/software, r/macapps, r/windowsapps |
| Info lovers | Glass Harbour: synced lyrics → cue cards → Meaning tab | r/lastfm, r/MusicBrainz, r/software, r/macapps, r/LovingOpenSourceAI |
| Tinkerers | Skins over the artist page and Now Playing fullscreen | r/tauri, r/reactjs (Showoff Saturday), r/javascript, r/web_design, r/opensource, r/foss |
| Coders | Mini player over the editor + curl driving the app | r/rust, r/tauri, r/programming, r/commandline, r/macapps, r/SideProject |
| AI | In-app assistant fixes tags / builds a queue; Claude over MCP | r/ClaudeAI, r/claude, r/ClaudeCode, r/mcp, r/vibecoding, r/LovingOpenSourceAI, r/LocalLLaMA (local model only) |
| Downloaders | yt-dlp search → download (CC video) → in library; torrent and Soulseek plugins | r/youtubedl, r/qBittorrent, r/Soulseek, r/DataHoarder, r/torrents |
| Spotify users | (cut) | r/truespotify; r/spotify bans promotion, skip |
| **Whole project** | one overview video or the repo link | r/BestGithubRepos, r/coolgithubprojects, r/opensource, r/foss, r/SideProject, r/IMadeThis, r/alternativeto, r/macapps, r/windowsapps, r/software, r/vibecoding |

Rules to check per subreddit before posting (from memory; they change):

- **r/selfhosted** limits project promos to a weekly slot (has been "New Project Friday") and
  wants the repo link, not only a video.
- **r/audiophile, r/headphones** are hostile to self-promotion: lead with what bit-perfect does,
  or use their weekly threads.
- **r/rust** wants Rust to be the point: post the libmpv engine / backend angle, not skins.
- **r/youtubedl, r/qBittorrent, r/Soulseek** are mostly support communities: pitch the plugin
  as a front-end for their tool, and show no copyrighted target.
- **r/LocalLLaMA** only if the assistant runs on a local model (Ollama, LM Studio).
- **r/reactjs** showcases on Showoff Saturday only; **r/macapps** has strict post formatting.
- **Pacing:** one account, spread over days, commenting in each sub. The same link posted many
  times in a short span gets shadow-removed by Reddit's spam filter, and many subs apply a
  10%-self-promotion rule to the account's history.

## Decisions needed before recording (original options, kept for reference)

1. **Framing.** The capture pipeline grabs the app window, and the window *can* be portrait:
   `window.set` takes `width`/`height` and the minimum is 300×400. Options:
   - **A. Portrait window** (about 486×864 logical, which is 972×1728 on Retina, scaled to
     1080×1920). It fills the frame natively, but nobody has checked how the sidebar, Home
     shelves and detail heroes look that narrow. That needs a test capture first.
   - **B. Crop a landscape window** (1440×900) to a 9:16 region per beat: the Now Playing
     centre, a modal, the queue panel. It's sharp, but wide surfaces (Home, a detail hero) lose
     their context.
   - **C. Letterbox**: the full landscape window over a blurred copy of itself, with captions in
     the bands above and below. Works for everything, but the UI reads small on a phone.
   - *Suggestion:* A by default, C for the surfaces that are wide by nature (skins over a detail
     hero, Home scroll), B for modals. Each scenario below names its framing.
2. **Audio.** The demo library is synthesised tones (ffmpeg `aevalsrc`), and the capture
   records silently. A short with sound on would give that away. Options: (a) mute the capture
   and add a licensed or royalty-free music bed in post; (b) add one or two CC-licensed real
   recordings to the demo library for the shorts where sound is the point (gapless,
   bit-perfect), and use (a) for the rest; (c) record the real output and live with the synth.
3. **Voice-over or text only.** Text only is assumed below; it automates fully.
4. **Which batch first.** Batch 1 is proposed below.

## Legend

`scene:` an existing `SCENES` entry in `scripts/lib/captureScenes.mjs` already gets the app into
this state, so step 2 only reframes it and adds captions. **new verb:** the control API has no
route for this yet. **manual:** needs an outside service or a real person, like the entries in
`MANUAL_CAPTURES`.

---

## Batch 1 (proposed): one short per persona, all automatable

### 1. Collectors: "Fix a hundred tracks at once" (~20 s, A)
- **Hook (0–2 s):** a messy album row, then a caption: *"100 badly tagged files. One edit."*
- **Beats:** 2 s select an album's tracks → 5 s Bulk Edit opens (`scene: bulk-edit`) →
  9 s set the album artist → 14 s the album list redraws as one album →
  18 s end card.
- **Captions:** "Select them all" · "Edit once" · "Written to the files, not just the app".
- **Needs:** typing into the modal fields — done with Click and type (`collectors-bulk-edit`).
- **Automatable:** yes.

### 2. Self-hosters: "Your server, built in" (~20 s, A)
- **Hook:** the library list with a "Navidrome" badge next to "Local". *"Local files and your
  server. One library."*
- **Beats:** Collections view (`shot-servers` state) → library, filtered to show both sources
  mixed → play a server track (Now Playing) → Download from your server
  (`scene: server-download`) → end card.
- **Captions:** "Subsonic & Navidrome, no plugin" · "Search both at once" · "Take a copy with
  you".
- **Needs:** a Subsonic/Navidrome server with free-to-share content in the demo setup. The demo
  library is local only today. *Open:* a throwaway Navidrome in Docker, loaded with the
  synthetic demo albums?
- **Automatable:** yes, once a demo server exists.

### 3. Audiophiles: "Hear the file, not the mixer" (~15 s, A)
- **Hook:** Now Playing with a format badge: *"Bit-perfect in one click."*
- **Beats:** `scene: bit-perfect` (toggle on, confirm, the app checks its own output) →
  Settings → Playback (`scene: settings-playback`) → end card.
- **Captions:** "Exclusive output" · "It checks its work" · "Built on libmpv".
- **Audio:** sound adds nothing here. Use a bed (decision 2a).
- **Automatable:** yes.

### 4. Rediscoverers: "You own thousands of songs. You play fifty." (~25 s, C)
- **Hook:** the caption alone over a fast Home scroll.
- **Beats:** `scene: home` (scroll Home → Forgotten favorites shelf) → open one → Start radio
  from it → the queue fills (queue panel open) → end card.
- **Captions:** "A home screen that knows your library" · "Forgotten favorites" · "A station
  from any song".
- **Needs:** start radio from the UI — Click and type on the hero's **Radio** button.
- **Automatable:** yes.

### 5. Info lovers: "Every song has a story" (~25 s, A)
- **Hook:** synced lyrics lighting up line by line (`scene: lyrics`, Glass Harbour).
- **Beats:** lyrics (8 s) → the About panel on Now Playing (`nowPlayingAbout`) → the track's
  detail page with its information tabs → end card.
- **Captions:** "Synced lyrics" · "Who you're hearing" (plugin) · "The whole album, one tap".
- **Caveat:** the About and bio content for the invented album is empty. Either use a
  well-known demo album for that beat (bio from the art/Last.fm providers, *plugin* chip) or
  skip it.
- **Automatable:** yes.

### 6. Tinkerers: "Make it look like yours" (~15 s, C)
- **Hook:** a skin change mid-frame.
- **Beats:** `scene: skins` (four skins over an artist hero with `aurora-drift`) → cut through
  three hero looks (`heroLook`) → end card.
- **Captions:** "Any color" · "Any mood" · "Or write your own: a plugin is two files".
- **Automatable:** yes, entirely with existing verbs.

### 7. Coders: "Music while you work. Nothing else." (~15 s, A then full-screen desktop)
- **Hook:** a code editor full-screen, with the mini player floating in a corner.
- **Beats:** `scene: mini-player` → the mini player's sizes (`scene: mini-player-sizes` as an
  animated sequence rather than a grid) → Cmd+K, type a title, Enter (`shot-search`) → end card.
- **Captions:** "Stays out of the way" · "Every size you need" · "One shortcut, any song".
- **Caveat:** the editor behind it must be staged: a neutral demo file, nothing personal (the
  site's first run caught real branch names). Record over a fixed wallpaper and editor
  screenshot.
- **Automatable:** mostly. The Cmd+K typing is the `search` verb; the backdrop is a staged image.

---

## Batch 2: second short per persona

### 8. Collectors: "Compilations, done right" (~20 s, A)
Navigate to a "Various Artists" album (`navigate album`) → track list showing each performer →
the artist page still lists their compilation track. *Needs a compilation in the demo library
(check `demoAlbums.mjs`).* Automatable.

### 9. Collectors: "Better copy? Swap it in place" (~25 s, B)
Upgrade compare dialog (quality and length side by side) → Replace. **manual** (listed in
`MANUAL_CAPTURES`: needs a real better copy). Could be automated against a second synthetic
FLAC of the same track, via `replace_track_file`.

### 10. Self-hosters: "Visit other servers" (~15 s, C)
Community site → a public server → add it. **manual** (website, not the app).

### 11. Audiophiles: "Gapless where it should be" (~15 s, A)
`scene: gapless`. Its value is audible, so it only works with decision 2b (a real gapless
pair). Otherwise drop it.

### 12. Audiophiles: "Shape it, when you want to" (~12 s, A)
`scene: eq-panel` → drag a band. Dragging a band has no verb: record it as a still plus a zoom,
or add an EQ preset verb.

### 13. Rediscoverers: "Fresh mixes, every day" (~15 s, A)
`scene: mixes` → open a daily mix → it plays. Automatable.

### 14. Rediscoverers: "The music never stops" (~20 s, A)
Seek to the last track's end → auto-continue picks the next one (`seekFromEnd`).
Automatable.

### 15. Info lovers: "What is this song really about?" (~20 s, A)
Genius explanations (plugin). Needs a real song, so its explanation text is third-party content.
**manual**, and check the licence before using it.

### 16. Tinkerers: "Pages with a little theatre" (~15 s, C)
Detail hero effects one after another (`heroLook` through every look). Automatable. *Perf note:*
the hero stack is the heaviest surface. Watch for dropped frames in the grab.

### 17. Coders: "A player with an API" (~20 s, split screen)
A terminal running `curl localhost:…/v1/status` next to the app reacting (play, skip). Needs the
token and port redacted. Automatable with a scripted terminal (or `vhs`).

### 18. AI: "Your assistant, running your music" (~30 s, split screen)
Claude asking for "something like this but slower" → the queue changes. **manual** (the chat
side has to be the real Claude app; listed in `MANUAL_CAPTURES`).

### 19. AI: "Liner notes, on cue" (~15 s, A)
`scene: cue-sheet` as video: cue cards fading in over Glass Harbour's lyrics. Automatable.

### 20. Downloaders: "Find it, get it, play it" (~25 s, A)
yt-dlp search (`scene: ytdlp-search`, plugin) → download a CC-licensed video → it appears in
the library. Needs a free-to-share target and the network. Semi-manual.

### 21. Spotify users: "Bring your playlists to a free player" (~20 s, A)
The Spotify browse view (plugin) → a playlist → play. **manual** (signed-in session; scroll
past the personal greeting, and redact the account name).

## What step 2 (automation) will need, from the scenarios above

- A **`shorts` scene set** beside `SCENES`/`SCREENSHOT_SCENES`, with the same declarative
  steps plus per-beat `caption` and `framing` (portrait / crop rect / letterbox).
- **Portrait window support** in the runner (it already sets geometry). Verify the narrow layout
  first.
- **Caption and end-card compositing**: ffmpeg `drawtext` (Outfit font, brand gradient) or
  pre-rendered PNG overlays, plus the letterbox filter (blurred copy behind).
- **Audio muxing**: a bed track per short, faded in and out.
- **New verbs** flagged above: bulk-edit field values, start radio from the UI (or a direct
  `start_radio` call), and possibly an EQ preset.
- **Demo data gaps**: a demo Subsonic server, a compilation album, maybe a real CC gapless pair.
