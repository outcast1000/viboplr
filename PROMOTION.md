# Viboplr — Promotion Playbook

A working document for promoting Viboplr across communities, show-and-tell sites,
and software directories. Contains the channel list, **ready-to-paste post texts**,
and **specs for every image/video** you'll need.

- **App:** Viboplr — a local-first, skinnable desktop music player (Tauri 2 · Rust + React)
- **Site:** https://viboplr.com
- **Repo:** https://github.com/outcast1000/viboplr
- **License:** GPL-3.0-or-later (free & open source)
- **Current version:** 1.0.8
- **Platforms:** Windows, macOS (Linux where Tauri/libmpv is available)

> Fill in the `[BRACKETED]` bits (exact download URL, release date, video link) before posting.

---

## 0. Cautions & framing to keep in mind

- Lead with the **local-library + Subsonic/Navidrome** story and the **skins/UX**. The
  **YouTube download** feature can trigger "piracy tool" reactions in
  stricter communities — let it be *discovered* on the site, don't headline it.
  - **One deliberate exception:** the yt-dlp/ffmpeg communities (§2 below) are the *one* place
    where leading with the plugin capability is on-topic and welcome. Keep it **plugin-scoped**
    there ("Viboplr has an optional yt-dlp-powered plugin"), and be aware of the trade-off:
    the more you brand Viboplr as a "yt-dlp frontend," the more the piracy-tool perception
    follows it into *other* rooms. Don't let "downloader" become the app's main identity.
- **"Spotify killer" is a great hook but must be framed honestly.** Viboplr is a *local-first
  player*, not a streaming catalog — it won't kill Spotify by matching its catalog; it kills
  your *dependence* on it. Position it as: **own your music, self-host, and get a player that
  looks and feels better than Spotify.** If you say "Spotify killer" bluntly to skeptical
  audiences (esp. r/audiophile), expect "but it doesn't stream 100M songs" pushback — so pair
  the phrase with the "for people who own/self-host their music" qualifier.
- **The "vibecoded" angle is an asset in the right rooms and a liability in the wrong ones.**
  In r/vibecoding, r/ClaudeAI, r/ClaudeCode and AI/indie subs, "built almost entirely with
  Claude Code" is the headline. In r/audiophile, r/rust, or a picky FOSS sub, *don't* lead
  with it — those crowds may read "AI-generated" as "low quality." Lead with the product;
  mention the build process only if it's the sub's whole point.
- **Audiophile & competitor-community subs are strict about self-promo.** r/audiophile,
  r/foobar2000, etc. often require mod approval or a participation history. Read the rules,
  post as a genuine "I made this," and be ready for a critical audience.

---

## 1. Reusable Press Kit (write once, paste everywhere)

Almost every channel and directory asks for the same fields. Keep this block handy.

### One-liner (≤ 80 chars)
> A local-first, skinnable desktop music player with a plugin system.

### Alternate hooks (pick per audience)
- **Spotify-alternative angle:** `The Spotify experience for music you actually own.`
- **Self-host angle:** `A player that makes owning your music feel better than streaming.`
- **Vibecoded angle:** `A full desktop music player, vibecoded end-to-end with Claude Code.`
- **FOSS angle:** `Free, open-source, no account, no cloud — just your music.`

### Short description (≈ 50 words)
> Viboplr is a free, open-source desktop music player for your own library and your
> Subsonic/Navidrome server. Gapless playback and crossfade via a native mpv engine,
> synced lyrics, a video theater mode, fully skinnable UI, and a plugin system for
> lyrics, artwork, scrobbling and more. Windows & macOS.

### Long description (≈ 130 words)
> Viboplr is a modern, local-first music player built with Tauri (Rust + React). It plays
> your local files across a huge range of formats and syncs with Subsonic and Navidrome
> servers, so your collection lives with you — not in someone's cloud.
>
> Under the hood it runs a native libmpv engine for true gapless playback, crossfade,
> ReplayGain, a 10-band EQ, exclusive audio output, and native video (theater + mini
> player). A Home page with a radio-station carousel and smart shelves helps you rediscover
> your library, and synced lyrics follow along as tracks play.
>
> Everything extends through plugins — lyrics, artwork, Last.fm scrobbling, Genius, and
> streaming-service browsing — and the whole interface is skinnable down to 19 color tokens.
> Free and open source (GPL-3.0).

### Feature bullets (pick per channel)
- 🎵 **Local-first** — your files, your library, no account required
- 🖥️ **Subsonic / Navidrome sync** — first-class client for self-hosted servers
- 🔊 **Native mpv engine** — true gapless, crossfade, ReplayGain, 10-band EQ, exclusive output
- 🎬 **Video support** — native theater mode + mini player (macOS & Windows)
- 📝 **Synced lyrics** — karaoke-style highlighting that tracks playback
- 🏠 **Home page** — radio-station carousel + smart shelves (recently played, most played, jump back in)
- 🎨 **Fully skinnable** — 19 color tokens, a skin gallery, custom CSS
- 🧩 **Plugin system** — lyrics, artwork, scrobbling, Genius, streaming browse, and more
- 🔎 **Instant search** — SQLite FTS5 across your whole library
- 📻 **Radio & auto-continue** — endless playback seeded from any track
- 🪟 **Mini player** — compact, always-on-top, with a cycling now-playing info line
- ⌨️ **Keyboard-driven** — full shortcut set, profiles, playlists & mixtapes

### Metadata fields (for directory forms)
- **Category:** Audio / Music Player
- **License:** GPL-3.0 (Free, Open Source)
- **OS:** Windows 10/11, macOS
- **Price:** Free
- **Tags:** music player, subsonic, navidrome, local music, mpv, gapless, lyrics, skins, open source, tauri
- **Developer:** outcast1000
- **Homepage:** https://viboplr.com
- **Download:** [DIRECT DOWNLOAD URL — link to viboplr.com or the GitHub release, never a third-party mirror]

---

## 2. Reddit

Each subreddit wants a *different framing* of the same app. **Read each sub's self-promo
rules first** — most require you to be a participant, not a drive-by poster. Post as an
"I built this" story, include a gif/screenshots, and stay in the comments for the first
few hours.

### r/selfhosted — angle: Subsonic/Navidrome client
**Title:** `I built a local-first desktop player that syncs with Navidrome/Subsonic — Viboplr (free & open source)`

**Body:**
```
I've been building Viboplr, a desktop music player for people who keep their own library
instead of renting it from a streaming service. It's local-first, but its main hook for
this crowd: it's a proper Subsonic/Navidrome client — point it at your server, it syncs
artists/albums/tracks and genres, and everything shows up in one unified library alongside
your local files.

Other bits self-hosters might like:
- Native mpv engine: real gapless, crossfade, ReplayGain, 10-band EQ, exclusive audio out
- Synced lyrics, a Home page with smart shelves, radio/auto-continue
- Fully skinnable UI + a plugin system (lyrics, artwork, Last.fm scrobbling, etc.)
- Profiles (Chrome-style isolation), playlists + mixtapes, FTS search

Free and GPL-3.0. Windows & macOS.

Site: https://viboplr.com
Source: https://github.com/outcast1000/viboplr

Happy to answer anything — it's a Tauri (Rust + React) app.
```
**Media:** GIF-01 (Subsonic sync → library populates), SHOT-01 (library), SHOT-05 (Home).

### r/navidrome + Subsonic community — angle: "a client you'll actually like looking at"
**Title:** `Viboplr — a skinnable desktop client for Navidrome/Subsonic (gapless, synced lyrics, plugins)`

**Body:**
```
Sharing a desktop client I've been working on for Navidrome/Subsonic users. Beyond the
usual sync, it focuses on the listening experience: a native mpv engine for true gapless
+ crossfade, synced karaoke-style lyrics, a video theater mode, and a fully skinnable UI
(there's a skin gallery). Plugins add Last.fm scrobbling, artwork, Genius, and more.

Free & open source (GPL-3.0), Windows & macOS.
Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr

Would love feedback from folks running Navidrome — especially on sync edge cases.
```
**Media:** GIF-02 (skin switching), SHOT-06 (synced lyrics / now playing), SHOT-01 (library).

### r/rust + r/tauri — angle: the engineering
**Title (r/rust):** `Show r/rust: a music player with a hand-rolled libmpv engine and a JS plugin system — built in Tauri`

**Body:**
```
Viboplr is a desktop music player I built with Tauri 2 (Rust backend, React/TS frontend).
A few things that were fun to build and might interest this sub:

- A native playback engine wrapping libmpv via a hand-rolled dlopen/LoadLibraryW FFI loader
  (~17 symbols), with dual libmpv handles ping-ponging for sample-accurate gapless and a
  Rust volume-ramp thread for crossfade. Native video embeds differently per-OS (NSOpenGL
  layer under the WKWebView on macOS; a child HWND with wid embedding on Windows).
- A two-layer plugin system: a Rust image/stream/download worker bridged to sandboxed JS
  plugins (executed via `new Function`), with SQLite-backed caching keyed by metadata.
- Everything is local-first: SQLite with FTS5 search, name-based entity keys so metadata
  (likes, lyrics, artwork) survives across libraries.

Free & open source (GPL-3.0).
Source: https://github.com/outcast1000/viboplr  •  Site: https://viboplr.com

Happy to go deep on any of the above.
```
**Media:** SHOT-07 (video theater), GIF-01 or a short architecture-focused clip. For r/tauri, emphasize the native-video-under-webview trick.

### r/opensource / r/coolgithubprojects — angle: FOSS
**Title:** `Viboplr — a free, open-source local music player with skins and a plugin system (Tauri, GPL-3.0)`

**Body:**
```
Viboplr is a local-first desktop music player, free and open source under GPL-3.0. It
plays your own library, syncs with Subsonic/Navidrome, does gapless/crossfade via a native
mpv engine, shows synced lyrics, and is fully skinnable with a plugin system on top.

Windows & macOS. No account, no cloud, no telemetry you can't turn off.
Source: https://github.com/outcast1000/viboplr  •  Site: https://viboplr.com
```
**Media:** SHOT-01, SHOT-05, GIF-02.

### r/DataHoarder — angle: big local libraries
**Title:** `A music player built for large local libraries — instant FTS search, Subsonic sync, format support galore`

**Body:**
```
If you've got a big local music collection, Viboplr might be worth a look. It's built
around a local SQLite library with FTS5 full-text search (fast even on large collections),
handles a wide range of audio formats (FLAC, ALAC, OPUS, DSD, WavPack, Musepack, APE, and
more via bundled ffmpeg/libmpv), and syncs with Subsonic/Navidrome if you self-host.

Free & open source (GPL-3.0), Windows & macOS.
https://viboplr.com  •  https://github.com/outcast1000/viboplr
```
**Media:** SHOT-01 (library with big track count visible), SHOT-08 (search results).

### r/vibecoding — angle: built end-to-end with AI
**Title:** `I vibecoded a full desktop music player (Tauri + Rust + React) — Viboplr, now shipping v1.0`

**Body:**
```
Viboplr started as a "can I actually vibecode a real, shippable desktop app?" experiment and
turned into a full music player. It's a Tauri app — Rust backend, React/TS frontend — and
the vast majority of it was built with Claude Code: the native libmpv playback engine (FFI
loader, dual-handle gapless, crossfade), a SQLite library with FTS5 search, a JS plugin
system, a skin engine, synced lyrics, Subsonic/Navidrome sync — the works.

What surprised me about vibecoding at this scale:
- Guardrails matter more than prompts. I keep a set of "rules" files (conventions, per-area
  architecture docs) that the agent reads every session — that's what kept a 100k-line
  codebase from drifting.
- The hard parts were still hard (native video embedding under a transparent webview, per-OS
  audio engines) — AI made them *tractable*, not trivial.
- Tests + a release pipeline were non-negotiable to trust the output.

It's free and open source (GPL-3.0), Windows & macOS. Happy to talk process, prompts, and
where it broke down.

Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr
```
**Media:** VIDEO-01 or GIF-00, plus SHOT-10 (plugins) to show scope. Consider a screenshot of
your `.claude/rules/` structure — this crowd loves the "how" behind a big vibecoded project.

### r/ClaudeAI + r/ClaudeCode — angle: what Claude Code can build
**Title:** `Shipped a real desktop music player almost entirely with Claude Code — here's what worked`

**Body:**
```
Wanted to share a non-toy result from Claude Code: Viboplr, a desktop music player built with
Tauri (Rust + React/TS), now at v1.0 and publicly released. It's a genuinely large app — a
native libmpv playback engine (gapless/crossfade/EQ/ReplayGain), Subsonic/Navidrome sync,
a plugin system, synced lyrics, skins, a mini player, profiles — and Claude Code did the bulk
of the implementation across backend and frontend.

What made it work at this size:
- A `CLAUDE.md` + a folder of per-area "rules" files (backend, frontend, queue, plugins, UI,
  testing conventions) the agent reads every session. This was the single biggest lever for
  keeping architecture consistent over months.
- Skills/slash-commands for repetitive flows (releases, code-health audits, CSS reviews).
- Treating the agent like a teammate: small, well-scoped tasks; tests to verify; let it fix
  convention violations as it touches files.

Free & open source (GPL-3.0). Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr

Happy to answer questions about the workflow, the rules-file setup, or where I had to step in.
```
**Media:** SHOT-01, SHOT-05, VIDEO-01. A screenshot of the `CLAUDE.md` / rules layout resonates
strongly here.

### More open-source / indie-maker subs (quick cross-posts)
- **r/SideProject**, **r/somethingimade**, **r/IndieDev**, **r/programming** (only if you frame
  it around the engineering, not the launch), **r/degoogle** / **r/privacy** (angle: no account,
  no cloud, own your data), **r/linux** (only once a Linux build is solid).
- Reuse the r/opensource body, trimmed. For r/degoogle/r/privacy, lead with "no account, no
  telemetry you can't disable, your library stays local."

### Music-player & audiophile subs — angle: a better-looking player for your own library
> ⚠️ **Read each sub's self-promo rules first** — several require mod approval or a posting
> history. These are critical audiences; post as "I made this," not an ad. Do **not** lead
> with the "vibecoded" angle here.

**Targets:** `r/musicplayers`, `r/foobar2000` (the "modern, skinnable alternative" angle),
`r/MusicBee`, `r/audiophile` (careful — see below), `r/headphones`, `r/audiophilemusic`,
`r/plexamp` / `r/jellyfin` (self-hosted players crowd).

**Title:** `Viboplr — a modern, skinnable local music player with a native mpv engine (gapless, ReplayGain, exclusive output)`

**Body:**
```
For folks who keep a real local library: I built Viboplr, a desktop player focused on sound
and looks. It runs a native libmpv engine, so you get true sample-accurate gapless, crossfade,
ReplayGain, a 10-band EQ, and bit-perfect exclusive audio output (WASAPI exclusive / CoreAudio
hog mode). Wide format support via libmpv/ffmpeg — FLAC, ALAC, DSD, WavPack, Musepack, APE,
OPUS, and more.

Beyond playback: syncs with Subsonic/Navidrome, synced lyrics, a fully skinnable UI, and a
plugin system for lyrics/artwork/scrobbling. Free & open source (GPL-3.0), Windows & macOS.

Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr

Genuinely after critical feedback on the audio path — exclusive-mode and ReplayGain behavior
especially.
```
**Media:** SHOT-12 (Settings → Playback: engine/exclusive/EQ/ReplayGain — the audiophile
credibility shot), SHOT-02 (skins), SHOT-06 (lyrics), GIF-02.

> **r/audiophile specifically:** hardware-focused and self-promo-averse. Only post if the
> rules allow it (or ask a mod), keep it software-forum-appropriate, lead with the
> *exclusive-output / bit-perfect / ReplayGain* substance, and skip the marketing gloss.

### yt-dlp & ffmpeg communities — angle: a GUI built on the tools they love
These crowds *appreciate* well-made frontends for their tools, and both are used by Viboplr
plugins (the **YouTube** plugin shells out to `yt-dlp`/`ffmpeg`; the **ffmpeg-tools** plugin
adds bulk convert + a media-info probe). Two different risk profiles:

- **ffmpeg community — clean and safe.** Bulk conversion + media probing via a GUI is
  uncontroversial and genuinely useful to them.
- **yt-dlp community — valuable but handle with care.** On-topic here, but keep it
  **plugin-scoped** and don't let it define the app elsewhere (see §0).

**Targets:**
- **r/ffmpeg** — the ffmpeg-tools plugin (GUI bulk-convert + probe/loudness) is the lead.
- **r/youtubedl** (the yt-dlp/youtube-dl sub — GUIs/frontends are welcome there) and
  **r/DataHoarder** (already covered; overlaps heavily).
- **Get listed, don't just post:** yt-dlp maintains a "**projects using yt-dlp**" wiki page —
  submitting Viboplr's YouTube plugin there is a durable, low-risk backlink that reaches this
  audience without a promo post. Do the same for any "built-with-ffmpeg" / GUI-frontend lists.

**Post text — r/ffmpeg (lead with ffmpeg-tools):**
```
I built a music player (Viboplr) with a plugin system, and one of the plugins turns ffmpeg
into a GUI: right-click any track(s) for a "Convert to…" submenu (bulk transcode), plus a
Media Info tab that probes container/streams/tags and loudness — all parsed from plain
ffmpeg's output (no ffprobe needed). The player itself decodes everything through a bundled
libmpv/ffmpeg, so format support is wide (FLAC, ALAC, DSD, WavPack, APE, OPUS, …).

Free & open source (GPL-3.0), Windows & macOS. The ffmpeg bits are an optional plugin.
Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr

Feedback on the convert/probe UX welcome.
```
**Media:** a shot of the "Convert to…" submenu + the Media Info tab (see SHOT-14), SHOT-01.

**Post text — r/youtubedl (plugin-scoped):**
```
Sharing a yt-dlp frontend that's part of something bigger: Viboplr, an open-source desktop
music player, has an optional YouTube plugin powered by yt-dlp — search a track and play it
as audio or video in-app, or download it (yt-dlp + ffmpeg under the hood). It's one plugin in
a full local-library player (Subsonic/Navidrome sync, gapless mpv engine, synced lyrics,
skins), not a standalone downloader.

The host manages the yt-dlp binary for you (install/auto-update, checksum-verified) so you're
not chasing releases. Free & open source (GPL-3.0), Windows & macOS.
Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr
```
**Media:** a short clip of searching a track → it plays in the theater (see GIF-03). Keep the
*download* aspect secondary to the *play-in-a-real-player* aspect.

### Other subs (lower effort, quick cross-posts)
`r/software`, `r/windowsapps`, `r/macapps`, `r/lastfm` (if leaning on the scrobbling plugin).
Reuse the r/opensource body, trimmed. For r/lastfm, lead with the Last.fm plugin (scrobbling,
history import, similar artists, community tags).

---

## 3. Show-and-tell platforms

### Hacker News — "Show HN"
**Title:** `Show HN: Viboplr – a local-first music player with a native mpv engine and plugins`

**First comment (post immediately after submitting):**
```
Author here. Viboplr is a desktop music player I built with Tauri (Rust + React) for
people who keep their own library instead of streaming everything.

The parts I'm proudest of, technically:
- A native playback engine wrapping libmpv through a hand-rolled FFI loader, with two
  libmpv handles ping-ponging for sample-accurate gapless and a Rust ramp thread for
  crossfade. Native video embeds under the webview differently on macOS vs Windows.
- A plugin system where sandboxed JS plugins contribute lyrics, artwork, scrobbling,
  streaming-service browsing, home-page shelves, and context-menu actions — bridged to a
  Rust worker for the network/file/cache side.
- Local-first data model: SQLite + FTS5, with metadata-based entity keys so likes/lyrics/
  artwork survive across libraries and non-library tracks.

It also syncs with Subsonic/Navidrome, has synced lyrics, a skin system (19 color tokens
+ a gallery), a mini player, and profiles.

Free & open source (GPL-3.0). Windows & macOS.
Site: https://viboplr.com  •  Source: https://github.com/outcast1000/viboplr

Feedback very welcome — especially on the playback engine and plugin API.
```
**Timing:** submit ~8–10am ET on a weekday. **Media:** HN shows no images inline — make
sure the *site* hero (GIF-00) sells it in 3 seconds, since that's the first click.

### Lobsters (needs invite)
Tag `audio`, `rust`, `release`. Same framing as Show HN but lead harder with the
architecture. **Media:** none inline; link to repo README with GIF-00.

### Product Hunt
- **Tagline:** `A local-first, skinnable music player with a plugin system`
- **Description:** use the long press-kit description.
- **First comment:** the "maker's story" — why you built it (owning your library vs.
  streaming), what's unique (native mpv engine + skins + plugins).
- **Media:** PH needs a **gallery** — see the "Product Hunt gallery" spec below (thumbnail
  + 4–6 images + the demo video). Launch on a Tue–Thu, rally early upvotes from your
  networks in the first hours.

### Awesome lists (long-tail discovery via PRs)
Submit a one-line entry + link via PR to:
- `awesome-tauri` (apps section)
- `awesome-selfhosted` (media streaming / audio — emphasize Subsonic client)
- `awesome-music` / `awesome-musicplayers`
**Media:** none; just a clean README with GIF-00 at the top.

---

## 4. Where your users already are (communities/Discords)

- **Navidrome Discord** + **Subsonic forums** — post in showcase/clients channels. Framing:
  "a desktop client that syncs to your server." **Media:** GIF-01 (sync), SHOT-06 (lyrics).
- **Tauri Discord** `#showcase` — the tech-stack crowd. **Media:** SHOT-07 (native video),
  GIF-02 (skins).
- **r/lastfm** + Last.fm forums — if leaning on scrobbling. **Media:** SHOT-09 (scrobble
  history / Last.fm section).
- **Mastodon** (#foss #selfhosted #music) and **Bluesky** — short post + GIF-02. Keep it to
  one gif and the two links.

**Mastodon/Bluesky post:**
```
Viboplr — a free, open-source desktop music player for your own library + Subsonic/
Navidrome. Native mpv engine (gapless, crossfade), synced lyrics, video theater, fully
skinnable, plugin system. Windows & macOS. GPL-3.0.

https://viboplr.com
#foss #selfhosted #music #opensource
```

---

## 5. Software download directories

Backlinks (SEO) + a steady trickle of non-technical users. Point **every** listing at
`viboplr.com` or your GitHub release — never a third-party mirror.

### Worth doing
| Site | Notes | Priority |
|---|---|---|
| **Softpedia** | Big directory; they test and award a "100% Clean" badge you can display | ⭐ High |
| **MajorGeeks** | Curated, respected Windows power-user audience | ⭐ High |
| **FossHub** | For FOSS; also a great place to *host* release binaries (fast mirrors + stats) | ⭐ High |
| **AlternativeTo** | List as an alternative to Spotify/foobar2000/MusicBee/iTunes — high discovery | ⭐ High |
| **winget / Homebrew Cask / Scoop** | Package-manager manifests; how power users install; self-updating | ⭐ High |
| **SnapFiles** | Low-effort classic directory | Medium |
| **Softonic / Uptodown** | Big traffic; ensure they link *your* download and don't repackage | Medium (verify) |
| **Slant.co** | Community "best music players" ranked lists | Medium |
| **SourceForge** | Dated but well-indexed; hosting + stats if OSS | Low |
| **PortableApps / Portable Freeware** | Only if you ship a portable build | Low |

### Skip / be cautious
- Anything that bundles *their* installer/adware, charges for basic listings, or looks
  abandoned. **CNET Download.com** has a checkered adware-bundling history — avoid unless
  they link the raw binary.

### Standard directory submission text
Use the **short description** + **feature bullets** + **metadata fields** from §1. Most
forms also want:
- **What's new / changelog:** link to https://viboplr.com/history.html
- **Screenshots:** SHOT-01, SHOT-05, SHOT-06, SHOT-02 (skins), SHOT-07 (video)
- **Icon:** ICON set (see specs below)

### AlternativeTo (do this one properly)
- Add Viboplr as an **alternative to**: Spotify (desktop), foobar2000, MusicBee, iTunes/
  Apple Music, Clementine, Strawberry, Sonixd/Feishin (Subsonic clients).
- Fill **License: Open Source / Free**, **Platforms: Windows, Mac**.
- Tags: `subsonic-client`, `music-player`, `gapless`, `skinnable`, `lyrics`, `mpv`.
- **Media:** upload SHOT-01, SHOT-02, SHOT-05, SHOT-06.

### Anti-virus / signing note
Newly-signed Tauri binaries sometimes get false-positive AV flags, which directories
surface prominently. Make sure installers are **code-signed** so scanners come back clean,
and keep a note of the Softpedia/VirusTotal "clean" result to link if a user asks.

---

## 6. Media assets needed

Produce these **once** and reuse across every channel. Capture on a clean profile with a
well-populated library and a good-looking skin (use the default dark skin for most, then a
couple of alternates for the skin shots). Target a 16:10 or 16:9 window, 1920×1200 or
1920×1080, Retina/2× where possible.

### Video

**VIDEO-01 — Main demo (60–90s).** The hero asset for Product Hunt, YouTube, the site,
and Discords.
- Shot list:
  1. (0–8s) Cold open on the **Home page** — radio carousel auto-rotating, shelves scrolling.
  2. (8–20s) Click a track → **now playing** with **synced lyrics** highlighting in time.
  3. (20–32s) Open **Settings → skins**, switch between 2–3 skins live (the whole UI recolors).
  4. (32–44s) **Subsonic/Navidrome**: show a synced server collection in the library.
  5. (44–56s) **Video theater mode** — a music video filling the column, then the **mini
     player** (compact, always-on-top) with the cycling info line.
  6. (56–75s) Quick montage: gapless/crossfade toggle, EQ popover, search (FTS), a plugin
     tab (lyrics/artwork). End on the wordmark + `viboplr.com`.
- Style: no voiceover needed (music bed only) for social; optional voiceover version for
  YouTube. Keep captions/text overlays naming each feature.
- Output: 1080p MP4 (H.264) + a muted, looping version for social autoplay.

**GIF-00 — Site/README hero (3–6s, silent loop).** The single "sells it in 3 seconds" clip.
- Content: skin switch OR Home page coming alive OR synced lyrics — pick the most visually
  striking. Recommend the **skin switch** (instant "wow", no reading required).
- Output: optimized GIF or WebM/APNG, < 5 MB, ~800px wide.

**GIF-01 — Subsonic sync (4–8s).** Library goes from empty → populated as a server syncs.
Used in r/selfhosted, r/navidrome, Navidrome Discord.

**GIF-02 — Skin switching (3–5s).** Cycle through 3–4 skins; whole UI recolors. Used in
skins-oriented posts, Mastodon/Bluesky, Tauri Discord.

**GIF-03 — YouTube plugin play (4–6s).** Search a track via the YouTube plugin → it plays as
video in the theater. Used in r/youtubedl. Keep the emphasis on *playing in a real player*,
not on the download button.

### Screenshots (PNG, clean, no personal data)

| ID | Content | Used in |
|---|---|---|
| **SHOT-01** | Library (tracks view) with a healthy track count visible | Reddit, directories, AlternativeTo |
| **SHOT-02** | Same view under a **different skin** (show range) | Skins posts, AlternativeTo |
| **SHOT-03** | An album detail page (hero art + tracklist + info tabs) | Directories, site |
| **SHOT-04** | An artist detail page (avatar, albums, similar) | Site, optional |
| **SHOT-05** | **Home page** (radio carousel + shelves) | Reddit, PH, directories |
| **SHOT-06** | **Now Playing** with synced lyrics highlighted | Navidrome/Subsonic posts, PH |
| **SHOT-07** | **Video theater mode** (music video full-column) | r/rust, r/tauri, PH |
| **SHOT-08** | Global search (Cmd+K) with grouped results | r/DataHoarder |
| **SHOT-09** | Track detail showing Last.fm / scrobble section + community tags | r/lastfm |
| **SHOT-10** | Extensions/plugins view (show the plugin ecosystem) | r/opensource, PH |
| **SHOT-11** | Mini player (compact, on top of a desktop) | PH, social |
| **SHOT-12** | Settings → Playback (engine, crossfade, EQ, exclusive/bit-perfect audio) | Tech + audiophile posts |
| **SHOT-13** | Editor view of `CLAUDE.md` + `.claude/rules/` file tree (the "how it was vibecoded" shot) | r/vibecoding, r/ClaudeAI, r/ClaudeCode |
| **SHOT-14** | ffmpeg-tools plugin: the "Convert to…" context submenu + the Media Info probe tab | r/ffmpeg |

### Icon / branding

- **ICON set:** app icon at 512×512, 256×256, 128×128, 48×48 (PNG, transparent). Directories
  ask for a range; PH wants a square logo/thumbnail (240×240 min).
- **Wordmark:** the pink→magenta gradient "Viboplr" logo on transparent + on dark, for
  banners and video outro.

### Product Hunt gallery (specific)
- **Thumbnail:** 240×240 square (app icon or a crisp UI crop).
- **Gallery images (1270×760 recommended):** SHOT-05 (Home), SHOT-06 (lyrics), SHOT-02
  (skins), SHOT-07 (video), SHOT-10 (plugins) — 4–6 total.
- **Gallery video:** VIDEO-01.

---

## 7. Suggested launch order

1. **Prep:** finalize press kit (§1), capture VIDEO-01 + GIF-00/01/02 + SHOT-01…12, confirm
   installers are code-signed and the download URL is live.
2. **Foundation (quiet):** submit to FossHub, Softpedia, MajorGeeks; add winget/Homebrew/
   Scoop manifests; create the AlternativeTo listing; PR the awesome-lists. These bake in
   SEO before the big pushes.
3. **Community warm-up:** post to r/selfhosted, r/navidrome + Subsonic community, and the
   Navidrome/Tauri Discords. Engage in comments.
4. **Big pushes (separate days):** Show HN one day; Product Hunt another (Tue–Thu). Don't
   stack them — you want to be present in the comments for each.
5. **Cross-post + social:** r/rust, r/tauri, r/opensource, r/DataHoarder, r/SideProject,
   r/degoogle, Mastodon, Bluesky, remaining directories (SnapFiles, Slant, etc.).
6. **AI/vibecoding pushes (separate days):** r/vibecoding, then r/ClaudeAI + r/ClaudeCode.
   These have a *different* audience than the product subs — lead with the build story +
   SHOT-13, and don't cross-post them the same day as Show HN.
7. **Audiophile/music-player subs (careful, spaced out):** r/musicplayers, r/foobar2000,
   r/MusicBee, then r/audiophile *only if rules allow*. Lead with SHOT-12 (exclusive/
   bit-perfect audio), never the vibecoded angle.
8. **Tool communities (plugin-scoped):** get listed on yt-dlp's "projects using yt-dlp" wiki
   first (durable, low-risk), then post to r/ffmpeg (lead with ffmpeg-tools + SHOT-14) and
   r/youtubedl (plugin-scoped, GIF-03). Keep "downloader" secondary to "music player."
9. **Follow-up:** respond to every thread for the first 24–48h; note recurring questions/
   feature requests; fold the best screenshots/quotes back into the site.

---

## 8. Quick copy-paste snippets

**Tweet/Bluesky/Mastodon (short):**
```
Viboplr: free, open-source desktop music player for your own library + Subsonic/Navidrome.
Gapless mpv engine, synced lyrics, video theater, fully skinnable, plugins. Win & macOS.
https://viboplr.com
```

**Forum signature / one-liner:**
```
Viboplr — a local-first, skinnable music player with a plugin system (FOSS, GPL-3.0) · https://viboplr.com
```

**Directory "about" (50 words):** use the short description in §1.
```
