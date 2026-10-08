#!/usr/bin/env bash
# Runs ON THE VPS, from deploy-umami.yml (after the folder is rsynced). Idempotent:
#   1. create .env with random secrets on the first run (never overwritten)
#   2. pull + start the containers
#   3. wait for Umami, then bootstrap.js: replace the default admin password
#      with the one in .admin-password, and make sure each site's website
#      (viboplr.com, community.viboplr.com) exists under the id its tracker
#      already carries
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
export UMAMI_ADMIN_PASSWORD
# One Umami website per site, each "id domain". The ids must match the trackers
# — the sites are tagged with them before the websites exist, and bootstrap
# creates each under the same id:
#   viboplr.com            → docs/js/analytics.js
#   community.viboplr.com  → src/analytics.js in outcast1000/viboplr-community
WEBSITES="550ff719-a783-4049-b3f9-2d30c76fea8b viboplr.com
042509a9-88c1-4011-a88f-0f8a0eac0ecb community.viboplr.com"
echo "$WEBSITES" | while read -r WEBSITE_ID WEBSITE_DOMAIN; do
  export WEBSITE_ID WEBSITE_DOMAIN
  # Passed by name (-e VAR), so the password is in neither argv nor the log.
  docker compose exec -T -e UMAMI_ADMIN_PASSWORD -e WEBSITE_ID -e WEBSITE_DOMAIN umami node - < bootstrap.js
done
