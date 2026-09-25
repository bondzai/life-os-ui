#!/bin/bash
# Fetch the latest Lyra release and install it, if it is not the one already running.
#
# Run every five minutes by lyra-update.timer. Pushing to master builds a tarball in GitHub
# Actions; this is what picks it up.
#
# ── Why the box pulls instead of GitHub pushing ──
# The obvious design is a self-hosted Actions runner on this machine. Do not do that: this
# repository is **public**, and a self-hosted runner on a public repository will execute code from
# anyone's pull request — on a box inside your home network, with your database on it. GitHub says
# so itself. Pulling inverts it: nothing reaches in, no port is open, and the only thing this box
# trusts is a release tarball on a tag it can name. It also means deploys work from anywhere you
# can push from — the laptop, a phone, a Codespace — with no runner to register.
#
# What it does NOT do: run anything out of the tarball. The archive is unpacked and the binary is
# started by systemd as an unprivileged user; no install hook, no script from the payload.
set -euo pipefail

REPO="${LYRA_REPO:-bondzai/life-os-ui}"
PREFIX="/opt/lyra"
ASSET="lyra-x86_64-linux.tar.gz"
API="https://api.github.com/repos/$REPO/releases/latest"

log() { echo "[lyra-update] $*"; }
die() { echo "[lyra-update] error: $*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is not installed"

# `|| true` on the fetch: this runs every five minutes forever, and a box with no network for a
# minute is the normal case, not an incident. A failed check is silent and the next one tries again.
meta="$(curl -fsSL --max-time 30 -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null || true)"
[ -n "$meta" ] || { log "could not reach GitHub; will try again"; exit 0; }

# grep/sed rather than jq, so this has no dependency beyond curl and coreutils on a fresh box.
latest="$(printf '%s' "$meta" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$latest" ] || { log "no release found in the API response"; exit 0; }

current="$(cat "$PREFIX/.version" 2>/dev/null || true)"
if [ "$latest" = "$current" ]; then
  exit 0
fi
log "current=${current:-none} latest=$latest — updating"

url="$(printf '%s' "$meta" \
  | tr ',' '\n' \
  | sed -n "s|.*\"browser_download_url\"[[:space:]]*:[[:space:]]*\"\([^\"]*$ASSET\)\".*|\1|p" \
  | head -1)"
[ -n "$url" ] || die "release $latest has no $ASSET asset"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --max-time 300 -o "$tmp/$ASSET" "$url" || die "downloading $ASSET failed"

# The checksum is published beside the tarball by the release workflow. If it is there it is
# checked; if the release predates it, say so rather than pretending to have verified something.
sums_url="${url%/$ASSET}/SHA256SUMS"
if curl -fsSL --max-time 30 -o "$tmp/SHA256SUMS" "$sums_url" 2>/dev/null; then
  ( cd "$tmp" && sha256sum --check --ignore-missing SHA256SUMS ) \
    || die "checksum mismatch on $ASSET — refusing to install"
  log "checksum ok"
else
  log "warning: release $latest publishes no SHA256SUMS; installing unverified"
fi

exec "$PREFIX/bin/lyra-server-linux.sh" deploy "$tmp/$ASSET"
