#!/usr/bin/env bash
# The system packages the Linux CI jobs need to compile the Tauri crate
# (ci.yml rust-check-and-test, release.yml test). One list, both workflows.
#
# The Ubuntu mirror intermittently stalls: an `apt-get install` that normally
# takes under a minute sat for 20–35 minutes in two releases on 2026-10-23,
# and with no timeout a hang holds the job until GitHub's 6-hour cap. So each
# attempt is bounded, stalled connections time out, and a hung attempt is
# retried rather than waited out.
set -euo pipefail

PACKAGES=(libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libxdo-dev)
APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)
ATTEMPTS=3
ATTEMPT_TIMEOUT=300

export DEBIAN_FRONTEND=noninteractive

for attempt in $(seq 1 "$ATTEMPTS"); do
  if sudo -E timeout "$ATTEMPT_TIMEOUT" apt-get "${APT_OPTS[@]}" update \
    && sudo -E timeout "$ATTEMPT_TIMEOUT" apt-get "${APT_OPTS[@]}" install -y "${PACKAGES[@]}"; then
    exit 0
  fi
  echo "::warning::apt attempt $attempt/$ATTEMPTS failed or timed out"
  sleep 15
done

echo "::error::Could not install system packages after $ATTEMPTS attempts"
exit 1
