#!/usr/bin/env bash
# The system packages the Linux CI jobs need to compile the Tauri crate
# (ci.yml rust-check-and-test, release.yml test). One list, both workflows.
#
# The Ubuntu mirror misbehaves two ways, and both have bitten:
# - it stalls: an `apt-get install` that normally takes under a minute sat for
#   20–35 minutes in two releases on 2026-10-23, and with no timeout a hang
#   holds the job until GitHub's 6-hour cap;
# - it crawls: on 2026-10-26 it served ~35 KB/s, so the 76 MB download needed
#   half an hour. Each bounded attempt got ~10 MB further (apt keeps finished
#   .debs in its cache), and a fixed three tries gave up at 56 MB to go.
# So each attempt is bounded and a stalled one is retried, as before, but the
# give-up count is of attempts in a row that downloaded nothing: a crawl that
# keeps advancing is waited out. Progress is what landed in either apt
# directory — the package lists or the .debs — so a crawl during `update`
# counts too. `update` runs until it succeeds once and is not repeated, so a
# retry spends its whole budget on the install. The step's own timeout-minutes
# is the overall cap.
set -euo pipefail

PACKAGES=(libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev)
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
ATTEMPT_TIMEOUT=300
MAX_STALLED=3

# `sudo -E` is ignored on these runners ("preserving the entire environment is
# not supported"), so the variable is passed through env instead — without it
# a debconf prompt would wait for input that never comes.
apt() { sudo env DEBIAN_FRONTEND=noninteractive timeout "$ATTEMPT_TIMEOUT" apt-get "${APT_OPTS[@]}" "$@"; }
fetched() { sudo du -sbc /var/lib/apt/lists /var/cache/apt/archives | tail -1 | cut -f1; }

attempt=1
stalled=0
updated=false
while true; do
  before=$(fetched)
  if [ "$updated" = true ] || apt update; then
    updated=true
    if apt install -y "${PACKAGES[@]}"; then
      exit 0
    fi
  fi
  after=$(fetched)
  phase=install
  [ "$updated" = true ] || phase=update
  if [ "$after" -gt "$before" ]; then
    stalled=0
    echo "::warning::apt $phase attempt $attempt failed or timed out after $(( (after - before) / 1048576 )) MB more — retrying"
  else
    stalled=$((stalled + 1))
    echo "::warning::apt $phase attempt $attempt failed or timed out with no download progress ($stalled/$MAX_STALLED)"
    if [ "$stalled" -ge "$MAX_STALLED" ]; then
      echo "::error::Could not install system packages: $MAX_STALLED attempts in a row made no progress"
      exit 1
    fi
  fi
  attempt=$((attempt + 1))
  sleep 15
done
