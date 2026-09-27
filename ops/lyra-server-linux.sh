#!/bin/bash
# Lyra as a systemd service. The Linux twin of ops/lyra-server.sh.
#
# One unit running one binary: the release `lyra-api` serving both the API and the built front end.
# No nginx, no node at runtime, and because the app is served from the API's own origin there is no
# CORS to configure. The four-container compose stack this replaces is gone from the docs for the
# same reason — three of its services existed to do what one binary now does.
#
#   sudo ./ops/lyra-server-linux.sh setup          create the user, the layout, the unit, the timer
#   sudo ./ops/lyra-server-linux.sh deploy <tgz>   install a release tarball and restart
#   sudo ./ops/lyra-server-linux.sh rollback       put the previous release back
#        ./ops/lyra-server-linux.sh status | logs
#   sudo ./ops/lyra-server-linux.sh start | stop | restart | uninstall
#
# **It does not build.** A release build of this workspace is `lto = "fat"` with one codegen unit
# over ~400 crates; on a mini PC that is tens of minutes of a machine whose job is to answer
# requests. GitHub Actions builds the x86_64 tarball for free and `ops/lyra-update.sh` fetches it.
# `setup` installs that timer.
#
# ── WSL2 ──
# systemd is not on by default. Before this script does anything useful:
#
#   /etc/wsl.conf          [boot]\nsystemd=true              then `wsl --shutdown` from Windows
#   %UserProfile%\.wslconfig   [wsl2]\nnetworkingMode=mirrored   so the port is reachable from
#                              the LAN and from Tailscale rather than only from Windows
#   sudo timedatectl set-timezone <yours>    DIGEST_HOUR and HABITS_NUDGE_HOUR are LOCAL hours
#
# And WSL does not boot until something asks it to, so a service that "starts at boot" does not.
# A Windows Task Scheduler task at system startup running
#   wsl.exe -d <distro> --exec /bin/true
# is what actually brings the distro (and therefore this unit) up.
set -euo pipefail

LABEL="lyra"
UNIT="/etc/systemd/system/$LABEL.service"
UPDATE_UNIT="/etc/systemd/system/$LABEL-update.service"
UPDATE_TIMER="/etc/systemd/system/$LABEL-update.timer"
BACKUP_UNIT="/etc/systemd/system/$LABEL-backup.service"
BACKUP_TIMER="/etc/systemd/system/$LABEL-backup.timer"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="/opt/lyra"
ENV_FILE="/etc/lyra/lyra.env"
SVC_USER="lyra"
PORT="${PORT:-3030}"
# Where ops/lyra-update.sh looks for releases. Overridable so a fork can point elsewhere.
REPO="${LYRA_REPO:-bondzai/life-os-ui}"

die() { echo "error: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run this with sudo"; }

# The settings this service is allowed to have, from the one list both installers read.
service_env_keys() {
  [ -f "$ROOT/ops/service-env.list" ] || die "missing ops/service-env.list — it is the allowlist"
  sed -e 's/#.*//' -e '/^[[:space:]]*$/d' -e 's/[[:space:]]//g' "$ROOT/ops/service-env.list"
}

env_value() {
  # Read one KEY=value out of .env.local without sourcing it — sourcing would run whatever else
  # is in there, and this is called as root.
  [ -f "$ROOT/.env.local" ] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env.local" | tail -1
}

# ── layout ────────────────────────────────────────────────────────────────────
# /opt/lyra/bin/lyra-api      the running binary
#          /ui/               the built front end
#          /data/lyra.db      the database, and the only thing here that is not replaceable
#          /releases/<tag>/   what was unpacked, kept so rollback is a symlink swap
#          /backups/          nightly VACUUM INTO, 14 days
#          /current -> releases/<tag>
make_layout() {
  id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SVC_USER"
  mkdir -p "$PREFIX"/{bin,ui,data,releases,backups} /etc/lyra
  # The service must be able to create lyra.db-wal and lyra.db-shm beside the database, so the
  # *directory* has to be writable — a writable file in a read-only directory fails at the first
  # write with "attempt to write a readonly database".
  chown -R "$SVC_USER:$SVC_USER" "$PREFIX"
  chmod 755 "$PREFIX"
  chmod 700 "$PREFIX/data"
}

write_env() {
  local secret; secret="$(env_value JWT_SECRET)"
  [ -n "$secret" ] || die "JWT_SECRET is empty in .env.local — the API refuses to sign tokens without one.
       Generate one:  printf '\\nJWT_SECRET=%s\\n' \"\$(openssl rand -base64 48)\" >> .env.local"

  # systemd's EnvironmentFile is KEY=value, unquoted, one per line, and it does NOT expand
  # anything — so unlike the plist there is no XML to escape. A value containing `&` or `<` is
  # fine here; a value containing a newline is not, and neither .env.local nor this supports one.
  {
    printf '# Written by ops/lyra-server-linux.sh from .env.local. Do not edit by hand:\n'
    printf '# `setup` overwrites it. Edit .env.local in the checkout and re-run setup.\n'
    printf 'PORT=%s\n' "$PORT"
    printf 'LYRA_DB=%s/data/lyra.db\n' "$PREFIX"
    printf 'LYRA_UI_DIR=%s/ui\n' "$PREFIX"
    for key in $(service_env_keys); do
      value="$(env_value "$key")"
      # An empty value is not the same as unset — `telegram_ready()` and friends check for
      # non-empty, and writing a blank string keeps that check honest.
      [ -n "$value" ] && printf '%s=%s\n' "$key" "$value"
    done
  } > "$ENV_FILE"
  # Root writes it, the service reads it, nobody else sees it. It is the only copy on this box of
  # the KuCoin key and the Telegram token.
  chown root:"$SVC_USER" "$ENV_FILE"
  chmod 640 "$ENV_FILE"
  echo "==> wrote $ENV_FILE ($(grep -c '^[A-Z]' "$ENV_FILE") settings)"
}

write_units() {
  cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=Lyra
Documentation=https://github.com/$REPO/blob/master/docs/deployment.md
# network-online rather than network: the first thing it does is reach Telegram and the chains,
# and "an interface exists" is not "DNS resolves".
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$PREFIX
ExecStart=$PREFIX/bin/lyra-api
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=2
# A crash loop must not become a busy loop: five starts in a minute and it stops, so the log is
# about the failure rather than 40,000 copies of it.
StartLimitIntervalSec=60
StartLimitBurst=5

# It serves HTTP, reads its database, and talks out. It has no business doing anything else.
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictSUIDSGID=yes
LockPersonality=yes
ReadWritePaths=$PREFIX/data $PREFIX/backups

[Install]
WantedBy=multi-user.target
UNIT_EOF

  cat > "$UPDATE_UNIT" <<UPDATE_EOF
[Unit]
Description=Fetch and install the latest Lyra release
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
# Root because it writes /opt/lyra and restarts the unit. It reaches exactly one host
# (api.github.com) and runs nothing it downloaded — the tarball is unpacked, not executed.
ExecStart=$PREFIX/bin/lyra-update.sh
UPDATE_EOF

  cat > "$UPDATE_TIMER" <<TIMER_EOF
[Unit]
Description=Check for a new Lyra release every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
# Without this a box that was asleep at the scheduled minute simply skips it.
Persistent=true

[Install]
WantedBy=timers.target
TIMER_EOF

  cat > "$BACKUP_UNIT" <<BACKUP_EOF
[Unit]
Description=Snapshot the Lyra database

[Service]
Type=oneshot
User=$SVC_USER
Group=$SVC_USER
# VACUUM INTO, not cp: this database runs in WAL mode, so lyra.db on its own is missing whatever
# is still in lyra.db-wal. VACUUM INTO writes one consistent, compacted file with no sidecars —
# there is nothing left to forget to copy, which is the way this goes wrong.
ExecStart=/bin/sh -c 'sqlite3 $PREFIX/data/lyra.db "VACUUM INTO \\'$PREFIX/backups/lyra-\$(date +%%Y%%m%%d).db\\'" && find $PREFIX/backups -name "lyra-*.db" -mtime +14 -delete'
BACKUP_EOF

  cat > "$BACKUP_TIMER" <<BTIMER_EOF
[Unit]
Description=Snapshot the Lyra database nightly

[Timer]
OnCalendar=03:30
Persistent=true

[Install]
WantedBy=timers.target
BTIMER_EOF

  install -m 755 "$ROOT/ops/lyra-update.sh" "$PREFIX/bin/lyra-update.sh"
  install -m 755 "$ROOT/ops/lyra-server-linux.sh" "$PREFIX/bin/lyra-server-linux.sh"
  # The updater calls this script's `deploy`, which reads ops/service-env.list.
  mkdir -p "$PREFIX/ops"
  install -m 644 "$ROOT/ops/service-env.list" "$PREFIX/ops/service-env.list"

  systemctl daemon-reload
  echo "==> wrote $UNIT and the update/backup timers"
}

# ── deploy ────────────────────────────────────────────────────────────────────
deploy() {
  local tgz="${1:-}" tag stage
  [ -n "$tgz" ] && [ -f "$tgz" ] || die "usage: $0 deploy <lyra-x86_64-linux.tar.gz>"

  # The tag is whatever the tarball says it is, so a rollback target has a name.
  tag="$(tar -xzOf "$tgz" VERSION 2>/dev/null || true)"
  [ -n "$tag" ] || tag="unknown-$(date +%s)"
  stage="$PREFIX/releases/$tag"

  rm -rf "$stage"; mkdir -p "$stage"
  tar -xzf "$tgz" -C "$stage"
  [ -x "$stage/bin/lyra-api" ] || die "the tarball has no bin/lyra-api"
  [ -f "$stage/ui/index.html" ] || die "the tarball has no ui/index.html — LYRA_UI_DIR would serve nothing"

  # Keep exactly one previous release. Two is a rollback target; ten is a disk that fills up on a
  # box nobody is watching.
  local previous; previous="$(readlink -f "$PREFIX/current" 2>/dev/null || true)"
  [ -n "$previous" ] && [ "$previous" != "$stage" ] && echo "$previous" > "$PREFIX/.previous"

  chown -R "$SVC_USER:$SVC_USER" "$stage"
  ln -sfn "$stage" "$PREFIX/current"
  install -m 755 -o "$SVC_USER" -g "$SVC_USER" "$stage/bin/lyra-api" "$PREFIX/bin/lyra-api"
  rsync -a --delete "$stage/ui/" "$PREFIX/ui/"
  chown -R "$SVC_USER:$SVC_USER" "$PREFIX/ui"
  echo "$tag" > "$PREFIX/.version"

  systemctl restart "$LABEL"
  wait_healthy || {
    echo "==> it did not come up; rolling back" >&2
    rollback
    die "deploy of $tag failed and was rolled back — journalctl -u $LABEL"
  }
  echo "==> $tag is live on :$PORT"

  # Prune everything that is neither current nor the rollback target.
  local keep_prev; keep_prev="$(cat "$PREFIX/.previous" 2>/dev/null || true)"
  for d in "$PREFIX"/releases/*; do
    [ -d "$d" ] || continue
    [ "$d" = "$stage" ] && continue
    [ "$d" = "$keep_prev" ] && continue
    rm -rf "$d"
  done
}

rollback() {
  local previous; previous="$(cat "$PREFIX/.previous" 2>/dev/null || true)"
  [ -n "$previous" ] && [ -x "$previous/bin/lyra-api" ] || die "no previous release to go back to"
  install -m 755 -o "$SVC_USER" -g "$SVC_USER" "$previous/bin/lyra-api" "$PREFIX/bin/lyra-api"
  rsync -a --delete "$previous/ui/" "$PREFIX/ui/"
  chown -R "$SVC_USER:$SVC_USER" "$PREFIX/ui"
  ln -sfn "$previous" "$PREFIX/current"
  basename "$previous" > "$PREFIX/.version"
  systemctl restart "$LABEL"
  echo "==> rolled back to $(basename "$previous")"
}

wait_healthy() {
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

case "${1:-status}" in
  setup)
    need_root
    make_layout; write_env; write_units
    systemctl enable "$LABEL" >/dev/null
    systemctl enable --now "$LABEL-update.timer" "$LABEL-backup.timer" >/dev/null
    echo "==> enabled $LABEL and its timers"
    if [ -x "$PREFIX/bin/lyra-api" ]; then
      systemctl restart "$LABEL"
      wait_healthy && echo "==> Lyra is up:  http://127.0.0.1:$PORT" || die "not answering — journalctl -u $LABEL"
    else
      echo "==> no binary installed yet. The update timer will fetch the latest release within"
      echo "    5 minutes, or do it now:  sudo $PREFIX/bin/lyra-update.sh"
    fi
    ;;
  deploy)   need_root; shift; deploy "$@" ;;
  rollback) need_root; rollback ;;
  start)    need_root; systemctl start "$LABEL";   echo "started" ;;
  stop)     need_root; systemctl stop "$LABEL";    echo "stopped" ;;
  restart)  need_root; systemctl restart "$LABEL"; echo "restarted" ;;
  uninstall)
    need_root
    systemctl disable --now "$LABEL" "$LABEL-update.timer" "$LABEL-backup.timer" 2>/dev/null || true
    rm -f "$UNIT" "$UPDATE_UNIT" "$UPDATE_TIMER" "$BACKUP_UNIT" "$BACKUP_TIMER"
    systemctl daemon-reload
    echo "removed the units. $PREFIX and $ENV_FILE are left alone — your database is in there."
    ;;
  status)
    systemctl is-active --quiet "$LABEL" && echo "  active, version $(cat "$PREFIX/.version" 2>/dev/null || echo unknown)" || echo "  not running"
    curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 \
      && echo "  http://127.0.0.1:$PORT — healthy" \
      || echo "  http://127.0.0.1:$PORT — not answering"
    systemctl list-timers "$LABEL-*" --no-pager 2>/dev/null | sed -n '2,4p'
    ;;
  logs) journalctl -u "$LABEL" -f ;;
  *) die "usage: $0 {setup|deploy <tgz>|rollback|start|stop|restart|status|logs|uninstall}" ;;
esac
