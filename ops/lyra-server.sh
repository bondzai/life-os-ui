#!/bin/bash
# Lyra as a local service.
#
# One launchd job running one binary: the release `lyra-api` serving both the API and the built
# front end. That is the whole server — no node at runtime, no reverse proxy, and because the app
# is served from the API's own origin there is no CORS to configure.
#
# **It runs from an install prefix, not from the checkout.** This repo lives under ~/Desktop, and
# macOS refuses a LaunchAgent access to Desktop, Documents and Downloads unless the user grants
# Full Disk Access by hand. The symptom is a service that starts and immediately dies with
# "unable to open database file" on a file that is plainly there and readable from your shell.
# Installing the binary, the bundle and the database under ~/Library/Application Support sidesteps
# the whole thing — which is where application data belongs anyway.
#
#   ./ops/lyra-server.sh install   build, install the launchd job, start it
#   ./ops/lyra-server.sh start | stop | restart | status | logs
#   ./ops/lyra-server.sh uninstall
#
# The job is a LaunchAgent, so it starts when you log in and restarts if it dies. It is NOT a
# LaunchDaemon: the database lives in your home directory and the process has no business running
# as root or before you have logged in.
set -euo pipefail

LABEL="sh.lyra.server"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/lyra"
PREFIX="$HOME/Library/Application Support/Lyra"
PORT="${PORT:-3030}"

die() { echo "error: $*" >&2; exit 1; }

env_value() {
  # Read one KEY=value out of .env.local without sourcing it — sourcing would run whatever else
  # is in there, and this is called from a script the user may not have written.
  [ -f "$ROOT/.env.local" ] || return 0
  sed -n "s/^$1=//p" "$ROOT/.env.local" | tail -1
}

# The Node the project pins, resolved to a directory rather than through nvm.
#
# `nvm.sh` is a shell function that is not safe under `set -u`, and sourcing it here killed this
# script mid-way with no message at all — which reads exactly like a build that succeeded. nvm
# installs versions at a predictable path, so ask the filesystem instead.
node_bin() {
  local want dir
  want="$(tr -d '[:space:]v' < "$ROOT/.nvmrc" 2>/dev/null || true)"
  if [ -n "$want" ]; then
    dir="$(ls -d "$HOME"/.nvm/versions/node/v"$want".*/bin 2>/dev/null | sort -V | tail -1)"
  fi
  # Any Node at all beats none: a newer one usually builds fine, and the failure if it does not
  # is npm's, with npm's message.
  [ -n "${dir:-}" ] || dir="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "${dir:-}" ] || die "no Node found under ~/.nvm/versions/node — install the version in .nvmrc"
  printf '%s' "$dir"
}

build() {
  echo "==> building the release binary"
  PATH="/opt/homebrew/opt/rustup/bin:$PATH" cargo build --release --manifest-path "$ROOT/core/Cargo.toml" --bin lyra-api
  echo "==> building the front end (node $(basename "$(dirname "$(node_bin)")"))"
  # `VITE_API_URL=/api` is what makes same-origin serving actually work. The default is the
  # absolute `http://localhost:3001/api` the dev server needs; baked into this bundle it would
  # send every request from :3030 to a port with nothing on it, and every page would render its
  # error state against a perfectly healthy server.
  ( cd "$ROOT" && PATH="$(node_bin):$PATH" VITE_API_URL=/api npm run build ) \
    || die "the front-end build failed — run 'npm run build' to see why"
}

install_files() {
  mkdir -p "$PREFIX/bin" "$PREFIX/ui" "$PREFIX/data"
  cp "$ROOT/core/target/release/lyra-api" "$PREFIX/bin/lyra-api"
  # --delete so a bundle that drops a chunk does not leave the stale one behind to be requested
  # by a cached service worker.
  rsync -a --delete "$ROOT/dist/" "$PREFIX/ui/"
  echo "==> installed into $PREFIX"

  # The database moves once and then stays put. `.backup` rather than `cp`, because a plain copy
  # of a WAL-mode database mid-write gives you a torn file that opens fine and is missing rows.
  if [ ! -f "$PREFIX/data/lyra.db" ] && [ -f "$ROOT/core/data/lyra.db" ]; then
    sqlite3 "$ROOT/core/data/lyra.db" ".backup '$PREFIX/data/lyra.db'"
    echo "==> copied your database to $PREFIX/data/lyra.db"
    echo "    Point development at the same file so the two never drift:"
    echo "    LYRA_DB=$PREFIX/data/lyra.db"
  fi
}

write_plist() {
  local secret; secret="$(env_value JWT_SECRET)"
  [ -n "$secret" ] || die "JWT_SECRET is empty in .env.local — the API refuses to sign tokens without one.
       Generate one:  printf '\\nJWT_SECRET=%s\\n' \"\$(openssl rand -base64 48)\" >> .env.local"

  mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

  # Every variable the binary reads, resolved now and written in. launchd gives a job almost no
  # environment of its own — inheriting the shell's would make "works in my terminal" the only
  # way it ever works.
  {
    printf '<?xml version="1.0" encoding="UTF-8"?>\n'
    printf '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    printf '<plist version="1.0"><dict>\n'
    printf '  <key>Label</key><string>%s</string>\n' "$LABEL"
    printf '  <key>ProgramArguments</key><array><string>%s/bin/lyra-api</string></array>\n' "$PREFIX"
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$PREFIX"
    printf '  <key>RunAtLoad</key><true/>\n'
    printf '  <key>KeepAlive</key><true/>\n'
    printf '  <key>StandardOutPath</key><string>%s/server.log</string>\n' "$LOG_DIR"
    printf '  <key>StandardErrorPath</key><string>%s/server.log</string>\n' "$LOG_DIR"
    printf '  <key>EnvironmentVariables</key><dict>\n'
    printf '    <key>PORT</key><string>%s</string>\n' "$PORT"
    printf '    <key>LYRA_DB</key><string>%s/data/lyra.db</string>\n' "$PREFIX"
    printf '    <key>LYRA_UI_DIR</key><string>%s/ui</string>\n' "$PREFIX"
    # An allowlist, so it must grow with the code. Every variable the server reads and is not on
    # this line is silently absent from the installed service — set in .env.local, working under
    # `cargo run`, and dead in production, with nothing anywhere saying why.
    #
    # Deliberately absent: PORT, LYRA_DB and LYRA_UI_DIR (set above, from the install layout), and
    # LYRA_HTTP_CACHE / LYRA_HTTP_FIXTURES, which point the chain client at recorded test
    # responses — forwarding those would let a stray line in .env.local make production report
    # fixture balances as your money.
    for key in JWT_SECRET ALERT_WALLETS KUCOIN_API_KEY KUCOIN_API_SECRET KUCOIN_API_PASSPHRASE \
               TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_OWNER_USER_ID DISCORD_WEBHOOK_URL \
               ALERT_INTERVAL ALERT_FEE_USD ALERT_HF ALERT_REPORT_CCY DIGEST_HOUR HABITS_NUDGE_HOUR \
               SNAPSHOT_INTERVAL SNAPSHOT_GROUP LYRA_JOBS LYRA_KNOWLEDGE_PATH GCAL_API_KEY \
               GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GOOGLE_REDIRECT_URI FRONTEND_URL CORS_ORIGINS \
               RUST_LOG; do
      # Escaped for XML, because this is written into a plist. A value with a bare `&` — a
      # redirect URI with two query parameters, a webhook URL with a thread id — produced a file
      # launchd refused to load, and the service simply did not start.
      value="$(env_value "$key" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
      # An empty value is not the same as unset — `telegram_ready()` and friends check for
      # non-empty, and writing a blank string keeps that check honest.
      [ -n "$value" ] && printf '    <key>%s</key><string>%s</string>\n' "$key" "$value"
    done
    printf '  </dict>\n</dict></plist>\n'
  } > "$PLIST"
  echo "==> wrote $PLIST"
}

load()   { launchctl bootstrap "gui/$UID" "$PLIST" 2>/dev/null || launchctl load "$PLIST"; }
unload() { launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true; }

case "${1:-status}" in
  install)
    build; install_files; write_plist; unload; load
    printf '==> waiting for the server'
    for _ in $(seq 1 30); do
      if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
        echo; echo "==> Lyra is up:  http://localhost:$PORT"; exit 0
      fi
      printf '.'; sleep 1
    done
    echo; die "it did not answer on :$PORT — check $LOG_DIR/server.log"
    ;;
  start)   load;   echo "started" ;;
  stop)    unload; echo "stopped" ;;
  restart) unload; load; echo "restarted" ;;
  uninstall) unload; rm -f "$PLIST"; echo "removed $PLIST" ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      launchctl list | grep "$LABEL" | awk '{print "  pid:", $1, " last exit:", $2}'
    else
      echo "  not loaded"
    fi
    curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1 \
      && echo "  http://localhost:$PORT — healthy" \
      || echo "  http://localhost:$PORT — not answering"
    ;;
  logs) tail -f "$LOG_DIR/server.log" ;;
  *) die "usage: $0 {install|start|stop|restart|status|logs|uninstall}" ;;
esac
