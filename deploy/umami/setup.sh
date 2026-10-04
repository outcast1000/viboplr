#!/usr/bin/env bash
# Runs ON THE VPS, from deploy-umami.yml (after the folder is rsynced). Idempotent:
#   1. create .env with random secrets on the first run (never overwritten)
#   2. pull + start the containers
#   3. wait for Umami, then bootstrap.mjs: replace the default admin password
#      with the one in .admin-password, and make sure the viboplr.com website
#      exists under the id the site's js/analytics.js already carries
# .admin-password is written by the workflow from a GitHub secret and is
# deleted again at the end, whatever happens.
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -f .admin-password' EXIT

if [ ! -f .env ]; then
  umask 077
  {
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_SECRET=$(openssl rand -hex 32)"
  } > .env
  echo "Created .env with fresh secrets"
fi

docker compose pull --quiet
docker compose up -d

echo "Waiting for Umami…"
for _ in $(seq 1 60); do
  if docker compose exec -T umami node -e "fetch('http://localhost:3000/api/heartbeat').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    break
  fi
  sleep 3
done

UMAMI_ADMIN_PASSWORD="$(cat .admin-password)"
# Must match WEBSITE_ID in docs/js/analytics.js — the site is tagged with this
# id before the website exists, and bootstrap creates it under the same one.
WEBSITE_ID="550ff719-a783-4049-b3f9-2d30c76fea8b"
WEBSITE_DOMAIN="viboplr.com"
export UMAMI_ADMIN_PASSWORD WEBSITE_ID WEBSITE_DOMAIN
# Passed by name (-e VAR), so the password is in neither argv nor the log.
docker compose exec -T -e UMAMI_ADMIN_PASSWORD -e WEBSITE_ID -e WEBSITE_DOMAIN umami node - < bootstrap.js
