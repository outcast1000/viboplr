---
date: 2026-07-10
topic: self-hosted-music-server
---

# Self-Hosted Music Distribution Server — Requirements

## Summary

A new standalone, self-hostable music distribution server, developed in its own repo as its own product. One small binary that a label, collective, or scene runs on a cheap VPS: invited artists upload music via the web or publish straight from Viboplr; listeners stream from generated public artist pages in any browser or one-click-subscribe in Viboplr; artists get a play-analytics dashboard. Each artist's public catalog is a generated static site around a thin dynamic core, exportable to plain static hosting at any time.

---

## Problem Frame

Viboplr's existing publish flow (`src-tauri/src/music_publish.rs` + `PublishSourceModal`) produces a static bundle the artist must host themselves. That model is fully decentralized but has two hard ceilings: static files cannot count plays (an artist never learns whether anyone listened), and the hosting step (GitHub Pages, copy-paste `gh` commands) is real friction for musicians.

The adjacent products bracket the space without filling it. Faircamp generates beautiful static artist sites but analytics are impossible by design. Funkwhale is a full federated platform with a Django + PostgreSQL + Redis footprint that realistically needs a sysadmin. The vacant middle — a living server as easy to run as Navidrome, focused on artists distributing their own music — is where this product sits.

Demand is hypothetical: no concrete artist has asked for this yet. That honesty sizes v1 — small enough to ship and validate, not a platform build-out.

---

## Key Decisions

- **Standalone product, not a Viboplr accessory.** The server is installable and useful for any musician; Viboplr is the flagship integration, not the only consumer. It gets its own brand — **Bandstatic** (repo `outcast1000/bandstatic`; name verified collision-free) — as a separate repo, following the established separate-repo convention (`viboplr-relay`, `viboplr-youtube`, gallery repos).
- **Static core, dynamic shell.** Each artist's public catalog — pages, player, manifest, audio — is a generated static site, regenerated on catalog change. The running server is only the thin living layer: auth, upload, play-count beacon, analytics dashboard. This maximizes reuse of the proven bundle model, keeps the public attack surface near-inert, and makes export-and-leave structurally cheap.
- **Invite-only multi-artist.** The admin creates or invites artist accounts (label/collective/scene model). Admins host only people they know, keeping the moderation and takedown surface small. Open registration is a possible later config flag, not a v1 behavior.
- **Manifest compatibility is a hard constraint.** The server serves the exact `manifest.json` shape existing Viboplr clients already parse, so every current install can subscribe with zero app changes. The parser accepts more fields than the current bundle generator emits (`year`, `cover`, top-level `artist`/`image`), so richer manifests are free wins.
- **Discovery is deferred.** v1 listeners arrive via shared links and the Add-to-Viboplr deep link. A central discovery directory is a separate future deliverable; the server must not preclude registering into one, but builds nothing for it now.
- **Two-repo delivery.** The server is one repo; publish-from-Viboplr is a small change in the main app repo (a new target in the existing publish flow).

---

## Actors

- A1. **Admin** — installs and operates a server instance, invites artists, removes content or accounts when needed.
- A2. **Artist** — uploads and manages their catalog, views analytics. May also be the admin on a single-artist instance.
- A3. **Listener (browser)** — streams from an artist's public page; no account, no app.
- A4. **Listener (Viboplr)** — subscribes to an artist via the manifest; tracks appear in their library and auto-update.
- A5. **Viboplr desktop app** — acts as a publish client for artists and a subscribe/streaming client for listeners.

---

## Requirements

**Publishing**

- R1. An artist can upload audio files through the web dashboard; the server reads embedded metadata and adds the tracks to their catalog.
- R2. Viboplr's publish flow gains a "publish to my server" target that pushes a track selection or collection to the artist's account on a server instance.
- R3. On any catalog change, the server regenerates that artist's public static site — pages, player, manifest, cover art — with no manual step.

**Listening**

- R4. Each artist has a public page with an in-browser player; anyone can stream without an account.
- R5. The server serves a per-artist `manifest.json` conforming to the schema in `src-tauri/src/manifest_sync.rs`, and the public page carries an "Add to Viboplr" deep link (`viboplr://add-collection?kind=manifest&url=…`). Existing clients subscribe with zero app changes.

**Accounts and administration**

- R6. Artist accounts are created by admin invite only; there is no open signup.
- R7. The admin can remove any artist account and any content on the instance.
- R8. The dashboard (upload, analytics, settings) requires authentication; all public listening surfaces require none.

**Analytics**

- R9. The server counts plays per track — from the web player via a lightweight beacon, and from app/subscriber streaming via its own audio-serving logs. Counts are anonymous; no listener identities.
- R10. An artist's dashboard shows per-track play counts over time.

**Ownership and deployment**

- R11. An artist can export their entire public site as a folder that works on plain static hosting — the export loses analytics collection but nothing a listener sees.
- R12. The server ships as a single small binary (optionally also a Docker image) and reaches a working instance on a bare VPS in minutes, not hours.

---

## Key Flows

- F1. **Instance setup.** Admin installs the binary, completes minimal config (domain, admin credentials), invites an artist by email/link. Artist sets a password and lands on an empty dashboard.
- F2. **Publish from Viboplr.** Artist selects tracks in Viboplr → "Publish to my server" → app pushes files + metadata to their account → server ingests, regenerates their site → public page and manifest reflect the new tracks. Covers R2, R3.
- F3. **Subscribe and listen.** Listener opens the artist's public page, clicks "Add to Viboplr" → app confirms and subscribes → tracks appear and stream; plays are counted server-side. Browser listeners stream from the same page; the player beacons plays. Covers R4, R5, R9.
- F4. **Check analytics.** Artist logs into the dashboard and sees per-track plays over time. Covers R10.
- F5. **Export and leave.** Artist triggers export, receives their complete static site, hosts it anywhere; listeners' existing manifest subscriptions keep working if the artist keeps the same URLs. Covers R11.

---

## Acceptance Examples

- AE1. **Covers R5.** Given an unmodified, currently-released Viboplr install, when the user adds the server's manifest URL as a music source, then the artist's tracks appear in the library and stream — no app update involved.
- AE2. **Covers R1, R3.** Given an artist uploads a new track via the dashboard, when the upload completes, then the public page and manifest include it without any further action by the artist or admin.
- AE3. **Covers R11.** Given an artist exports their site and hosts the folder on plain static hosting at the same base URL, then public pages and existing Viboplr subscriptions continue to work; only play counting stops.
- AE4. **Covers R6.** Given a visitor who has no invite, when they look for a way to register on the instance, then none exists on any public surface.

---

## Scope Boundaries

**Deferred for later**

- Central discovery directory and server auto-registration into it — separate deliverable; design must not preclude it.
- Open registration as an admin-opt-in config flag.
- Subsonic API layer for third-party listening apps.
- Payments, download sales, unlock codes.
- Listener-level analytics (unique listeners, geography, referrers).

**Outside this product's identity**

- Federation/ActivityPub — Funkwhale's territory; discovery will come from a directory instead.
- Podcasts, RSS radio, internet-radio hosting.
- Private library streaming for personal collections — Navidrome's job, not this server's.
- Any Viboplr-operated hosting of third-party audio — instances are always run by their own admins.

---

## Dependencies and Assumptions

- Demand is unvalidated: no concrete artist is committed. v1 is sized to ship and test the premise, and expansion beyond this scope should wait for real users.
- Publish-from-Viboplr (R2) depends on a change in the main app repo, extending the existing publish surface (`src/components/PublishSourceModal.tsx` → `export_music_source`).
- Subscriber freshness needs no new client work: manifest collections are created with auto-update on a daily interval (`src-tauri/src/commands/collections.rs`), so R3's regenerated manifest propagates automatically.
- The manifest parser (`src-tauri/src/manifest_sync.rs`) requires only `title` and `url` per track and tolerates unknown fields — verified against source, so server-side manifest evolution has slack.

---

## Outstanding Questions

**Deferred to planning**

- Server tech stack (Rust + axum is the natural fit given in-repo precedent in `src-tauri/src/transcode_server.rs`, but planning decides).
- Auth mechanism for publish-from-Viboplr (API token vs. session).
- Play-beacon mechanics and how app-streaming plays are distinguished from crawlers/prefetch.
- Whether public pages offer file downloads in v1 or streaming only.
- Upload quotas / storage limits per artist.

---

## Sources

- `src-tauri/src/manifest_sync.rs` — manifest schema the server must emit (verified: `title`/`url` mandatory, all else optional, serde aliases `duration`/`track`).
- `src-tauri/src/music_publish.rs` — the static bundle generator whose model the "static core" reuses.
- `src/components/PublishSourceModal.tsx`, `src/App.tsx` (deep-link handling + `AddMusicSourceModal`) — existing publish/subscribe UX the two-repo delivery extends.
- `src-tauri/src/commands/collections.rs`, `src-tauri/src/lib.rs` — manifest collections default to daily auto-update via the generic resync loop.
- Faircamp (static-site generator for musicians; no analytics by design; desktop app planned 2026) — https://simonrepp.com/faircamp/
- Funkwhale (federated self-hosted audio platform; heavy deploy; Subsonic API) — https://funkwhale.audio/ · 2.0 federation direction: https://blog.funkwhale.audio/funkwhale-2-more-federation.html
