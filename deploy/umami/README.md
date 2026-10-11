# Self-hosted Umami (website analytics)

Cookieless, anonymous analytics for **viboplr.com** — which pages are read,
where visitors come from (referrer, UTM campaign, country, device), and which
pages lead to a download. Runs on the same VPS as the site and Aptabase, behind
Nginx Proxy Manager at **https://stats.viboplr.com**.

Umami stores no IP address and sets no cookie. The tracker is loaded with
`data-do-not-track`, so a browser sending DNT isn't counted. The site says so in
`docs/help.html#website-analytics` — keep that text in step with what's tracked.

(App usage telemetry is a different thing — that's Aptabase, `deploy/aptabase/`.)

## How it's deployed

`.github/workflows/deploy-umami.yml` — **manual** (Actions → "Deploy Umami" →
Run workflow). It reuses the site deploy's VPS secrets, rsyncs this folder to
`~/umami` on the VPS and runs `setup.sh` there, which:

1. creates `~/umami/.env` with random `POSTGRES_PASSWORD` / `APP_SECRET` on the
   first run (never overwritten, never in git, excluded from the rsync);
2. `docker compose pull && up -d`;
3. runs `bootstrap.js` inside the container against Umami's own API: replaces
   the default `admin` / `umami` login with the `UMAMI_ADMIN_PASSWORD` secret,
   and creates the `viboplr.com` website under the fixed id the site already
   carries (`WEBSITE_ID` in `setup.sh` = `docs/js/analytics.js`).

No host port is published. The dashboard is reachable only through the proxy
host you add in step 4 below — after the default password is already gone.

Re-running the workflow is safe: it updates the image and changes nothing else.

## One-time setup

1. **Repo secret**: Settings → Secrets and variables → Actions →
   `UMAMI_ADMIN_PASSWORD` (12+ characters). This becomes the dashboard login
   for user `admin`; keep a copy in your password manager.
2. **DNS** (Cloudflare): `A` record `stats.viboplr.com` → the VPS IP, **DNS only**
   (grey cloud), like `analytics.viboplr.com`. Proxied would hide the visitor's
   IP behind Cloudflare's, and every visit would be geolocated to a Cloudflare
   data centre.
3. **Run the workflow** (Actions → Deploy Umami). The log ends with
   `Website created: viboplr.com (…)`.
4. **Nginx Proxy Manager** → Add Proxy Host:
   - Domain: `stats.viboplr.com`
   - Forward: `http` → `umami` port `3000`
   - SSL: request a Let's Encrypt certificate, Force SSL, HTTP/2.
5. Open https://stats.viboplr.com, sign in as `admin`. Visits from the live site
   appear within a minute (the tracker ignores localhost and previews).

## What's tracked

Page views come from the tracker itself. Events, from `docs/js/analytics.js`:

| Event | Data | When |
|---|---|---|
| `persona-card` | `persona` | a "Which listener are you?" card on the home page |
| `get-viboplr` | `from` (page) | the nav's **Get Vibo** button |
| `download-choice` | `platform`, `from` | a link to the macOS / Windows install page |
| `download-start` | `platform`, `file` | the install page starts the download |
| `download-manual` | `platform` | the install page's "Download it manually" link |
| `outbound` | `host`, `from` | any link off the site (GitHub, gallery repos, …) |

The funnel worth watching: **landing page → `download-choice` → `download-start`**,
filtered by referrer or persona page.

## Maintenance

- Update: re-run the workflow (or on the VPS: `cd ~/umami && docker compose pull && docker compose up -d`).
- Logs: `cd ~/umami && docker compose logs -f umami`
- Backup: the `umami-db` volume holds everything.
- Changing the admin password: do it in the dashboard (Profile → Change
  password), then update the `UMAMI_ADMIN_PASSWORD` secret to match. The
  bootstrap only ever replaces the *default* password; with a secret that no
  longer matches, a re-run still updates the containers but its bootstrap step
  fails at login (and changes nothing).
