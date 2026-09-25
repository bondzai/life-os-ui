# Deployment

Lyra runs as **one binary**. The release `lyra-api` serves the API and the built front end from the
same origin — no nginx, no node at runtime, and therefore no CORS to configure.

There are two supported hosts, and they are the same shape:

| | Host | Supervisor | Installer | Prefix |
|---|---|---|---|---|
| **The box** | mini PC, Ubuntu 24.04 under WSL2 | systemd | `ops/lyra-server-linux.sh` | `/opt/lyra` |
| **A laptop** | macOS | launchd | `ops/lyra-server.sh` | `~/Library/Application Support/Lyra` |

> **The four-container compose stack is gone.** It ran `api` + `ui`/nginx + `ollama` + a `migrate`
> one-shot; three of those existed to do what `LYRA_UI_DIR` now does inside the binary. The files
> (`docker-compose.yml`, `Dockerfile.ui`, `core/Dockerfile`) are still in the tree and still build,
> but nothing here uses them and `core/Dockerfile` has never contained the front end — a container
> built from it serves the API only. `git log` has the old instructions.

---

## 1. The pipeline

Deploys are **pull-based**, and that is a security decision, not a convenience one.

```
   laptop / phone / anywhere          GitHub Actions (free: public repo)
   ┌──────────────────────┐          ┌────────────────────────────────────┐
   │  git push master     │ ───────► │ ci.yml       fmt, clippy, tests,   │
   └──────────────────────┘          │              typecheck, vitest     │
                                     │ release.yml  gate → x86_64 tarball │
                                     │              → GitHub Release      │
                                     └─────────────────┬──────────────────┘
                                                       │ outbound HTTPS only
                                     ┌─────────────────▼──────────────────┐
                                     │ mini PC                            │
                                     │  lyra-update.timer   every 5 min   │
                                     │  ops/lyra-update.sh  new tag?      │
                                     │    → verify SHA256                 │
                                     │    → lyra-server-linux.sh deploy   │
                                     │    → restart, health-check,        │
                                     │      roll back if it does not come │
                                     │      up                            │
                                     └────────────────────────────────────┘
```

**Why not a self-hosted runner.** This repository is public. A self-hosted runner on a public
repository runs code from anyone's pull request, on the machine it is installed on — here a box
inside a home network with the database on it. GitHub documents this as a reason not to do it.
Pulling costs five minutes of latency and deletes the entire class of problem: nothing reaches in,
no port is open, and the box trusts only a release tarball whose checksum it can verify.

**Why the box does not build.** `[profile.release]` is `lto = "fat"` with `codegen-units = 1` over
~400 crates. That is minutes on a CI runner with a warm cache and a long time on a mini PC whose
job is answering requests. The cost is paid once, in Actions, for free.

**`ubuntu-24.04` is pinned in both workflows, not `ubuntu-latest`.** The binary is dynamically
linked against the builder's glibc. The day `ubuntu-latest` moves, every deploy onto Ubuntu 24.04
dies with `GLIBC_2.4x not found` — on a binary that built and tested perfectly. **If the distro on
the box changes, change that line in the same commit.**

---

## 2. Preparing the box (once)

### Windows

It is a server now, so stop it sleeping:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg -h off
```

In the BIOS, turn on "restore on AC power loss" if it is there. Then:

```powershell
wsl --install -d Ubuntu-24.04
```

**Ubuntu 24.04 specifically** — it has to match `ubuntu-24.04` in the workflows.

`%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=8GB
processors=4
# Without this, a port inside WSL is reachable from Windows and from nowhere else — not the LAN,
# not Tailscale. Needs Windows 11 22H2 or newer.
networkingMode=mirrored
```

WSL does not boot until something asks it to, so a service that "starts at boot" does not. Create a
Task Scheduler task — **At startup**, *Run whether user is logged on or not*:

```
wsl.exe -d Ubuntu-24.04 --exec /bin/true
```

Then `wsl --shutdown` and start it again to pick up `.wslconfig`.

### Inside WSL

```bash
sudo tee /etc/wsl.conf >/dev/null <<'EOF'
[boot]
systemd=true
EOF
```

`wsl --shutdown` from PowerShell again, then reopen. `systemctl is-system-running` should answer
something other than `offline`.

```bash
sudo apt update && sudo apt install -y sqlite3 curl rsync ca-certificates git
# DIGEST_HOUR and HABITS_NUDGE_HOUR are LOCAL hours. Get this wrong and the daily brief
# arrives at the wrong time, with nothing anywhere saying why.
sudo timedatectl set-timezone Asia/Bangkok
```

---

## 3. Installing the service

Clone the repo and give it the secrets. `.env.local` is gitignored and is the only copy on this box
of the KuCoin key and the Telegram token — **carry it over out of band** (USB, or `scp` over
Tailscale). Never through git: this repository is public.

```bash
git clone https://github.com/bondzai/life-os-ui.git ~/lyra
cd ~/lyra
# from the laptop, or retyped
install -m 600 /path/to/.env.local .env.local
sudo ./ops/lyra-server-linux.sh setup
```

`setup` creates the `lyra` system user and `/opt/lyra`, writes `/etc/lyra/lyra.env` from
`.env.local`, installs the unit plus the update and backup timers, and enables everything. With no
binary yet it says so; the update timer fetches the latest release within five minutes, or:

```bash
sudo /opt/lyra/bin/lyra-update.sh
```

### The layout

```
/opt/lyra/bin/lyra-api        the running binary
         /ui/                 the built front end (LYRA_UI_DIR points here)
         /data/lyra.db        the database — the only thing here that is not replaceable
         /releases/<tag>/     what was unpacked; rollback is a swap back to the previous one
         /backups/            nightly VACUUM INTO, 14 days
         /.version            the installed tag, compared by the updater
/etc/lyra/lyra.env            every setting, mode 640 root:lyra
```

### Settings

`/etc/lyra/lyra.env` is generated — **do not edit it**, `setup` overwrites it. Edit `.env.local` in
the checkout and re-run `setup`.

What it contains is the allowlist in **`ops/service-env.list`**, which both installers read. A
variable the server reads and that file does not name is silently absent in production: set in
`.env.local`, working under `cargo run`, dead on the box. That has happened once, to
`DISCORD_WEBHOOK_URL` and the Google OAuth keys. `the_install_script_forwards_every_setting_the_server_reads`
in `crates/lyra-api/src/main.rs` reads the list and fails naming the variable and its source file,
so it cannot happen quietly again.

`PORT`, `LYRA_DB` and `LYRA_UI_DIR` come from the install layout. `LYRA_HTTP_CACHE` and
`LYRA_HTTP_FIXTURES` are deliberately never forwarded — they point the chain client at recorded test
responses, and forwarding them would let a stray line in `.env.local` make production report
fixture balances as your money.

---

## 4. Moving the database

A hard cutover. **Not a migration, and there is no overlap window.**

The Telegram bot long-polls `getUpdates` (`tgbot.rs`, deliberately — a webhook would need a public
HTTPS endpoint). Two processes on one token fight over updates and drop them. Two instances also
send two daily digests and run two alert sweeps.

```bash
# 1. On the laptop — STOP IT FIRST.
launchctl bootout gui/$(id -u)/sh.lyra.server

# 2. One consistent file. VACUUM INTO rather than cp or .backup: this database runs in WAL mode,
#    so lyra.db alone is missing whatever is still in lyra.db-wal, and VACUUM INTO writes a single
#    compacted file with no sidecars — nothing left to forget to copy.
sqlite3 "$HOME/Library/Application Support/Lyra/data/lyra.db" \
  "VACUUM INTO '/tmp/lyra-move.db'"

# 3. Check it before you trust it.
sqlite3 /tmp/lyra-move.db "pragma integrity_check; select count(*) from entities;"

# 4. Carry it over, then on the box:
sudo systemctl stop lyra
sudo install -o lyra -g lyra -m 600 /path/to/lyra-move.db /opt/lyra/data/lyra.db
sudo rm -f /opt/lyra/data/lyra.db-wal /opt/lyra/data/lyra.db-shm
sudo systemctl start lyra
curl -sf localhost:3030/api/health && echo ok
```

Deleting the sidecars in step 4 matters: a stale `-wal` left beside a fresh `.db` is the classic way
to corrupt the result.

Keep the laptop's database for a couple of weeks. It is the rollback.

Migrations run forward-only at startup against `PRAGMA user_version`, so the new binary upgrades the
schema on first boot. An **older** binary refuses to open a newer database — which is why
`deploy` health-checks and rolls back rather than leaving a half-started service.

---

## 5. Backups and restore

`lyra-backup.timer` runs nightly at 03:30: `VACUUM INTO /opt/lyra/backups/lyra-YYYYMMDD.db`, keeping
14 days. One consistent, compacted file per night, no sidecars, safe to run against a live database.

At roughly half a megabyte, offsite is cheap: `rclone` to Cloudflare R2 (10 GB free) or any free
drive. **Back up `.env.local` alongside it** — a restored `lyra.db` with no `.env.local` is a system
that comes up showing an empty book.

Litestream is not used here. It streams the WAL continuously, which is the right tool for a database
orders of magnitude larger than this one.

```bash
sudo systemctl stop lyra
# All three, or a stale -wal beside a fresh .db corrupts the result.
sudo rm -f /opt/lyra/data/lyra.db /opt/lyra/data/lyra.db-wal /opt/lyra/data/lyra.db-shm
sudo install -o lyra -g lyra -m 600 /opt/lyra/backups/lyra-20260925.db /opt/lyra/data/lyra.db
sudo systemctl start lyra
curl -sf localhost:3030/api/health && echo ok
```

---

## 6. When something is wrong

```bash
./ops/lyra-server-linux.sh status     # active? which tag? when do the timers next fire?
./ops/lyra-server-linux.sh logs       # journalctl -u lyra -f
journalctl -u lyra-update -n 50       # why a deploy did or did not happen
systemctl list-timers 'lyra-*'
```

| Symptom | Cause |
|---|---|
| `FATAL: JWT_SECRET environment variable is required` | Not in `.env.local`, so not in `lyra.env`. `openssl rand -base64 48`, then re-run `setup` |
| Unit is active, port answers nothing | `journalctl -u lyra` for a migration failure. An **older** binary cannot open a **newer** database |
| `attempt to write a readonly database` | The `data/` **directory** must be writable by `lyra`, not just the file — WAL mode creates two sidecars beside it |
| Pages render their error state against a healthy server | The bundle was built without `VITE_API_URL=/api`. `release.yml` sets it; a hand-built `dist/` may not |
| A blank Holdings page, nothing in the log | A wealth variable is missing from `ops/service-env.list` or from `.env.local` — §7.1 |
| The daily brief arrives at the wrong hour | `timedatectl`. `DIGEST_HOUR` is a **local** hour |
| The service does not come back after a reboot | The Windows Task Scheduler task that boots WSL is missing or did not run — §2 |
| `GLIBC_2.4x not found` | The runner image and the WSL distro have diverged — §1 |
| Deploys stopped arriving | `systemctl list-timers 'lyra-*'`, then `journalctl -u lyra-update` |
| Telegram replies twice, or drops messages | Two instances share one bot token — §4 |
| Ports: only **3030** | The whole application. Ollama, if added, is 11434 and must be reachable *from the browser* — the API never proxies it, so a phone that cannot reach it shows AI offline and falls back to algorithmic mode |

---

## 7. Settings reference

Read from the source (`crates/lyra-api/src/main.rs`, `gcal.rs`, `knowledge.rs`), not from memory.
Which of these the *installed service* actually receives is the allowlist in
**`ops/service-env.list`** — see §3.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `JWT_SECRET` | **Yes** | — | Signs session tokens. Missing or empty → process exits 1. Generate: `openssl rand -base64 48`. Rotating it logs everyone out |
| `LYRA_DB` | No | `data/lyra.db` | SQLite path. The installers set it from the install layout |
| `LYRA_UI_DIR` | No | unset | Directory of the built front end. **Unset serves the API only**; set, one binary is the whole application. No `index.html` inside it logs a warning and serves the API only |
| `PORT` | No | `3001` | Listen port, bound on `0.0.0.0`. Both installers set `3030` |
| `CORS_ORIGINS` | No | `http://localhost:5173,http://localhost:8080` | Comma-separated allow-list. Irrelevant when the binary serves the UI (same-origin); matters for direct API access — a phone on the LAN, a local `npm run dev` |
| `RUST_LOG` | No | `info` | Tracing filter, e.g. `lyra_api=debug,info` |
| `LYRA_JOBS` | No | on | The job queue. Off, the Agents page stays empty and nothing is queued |
| `LYRA_KNOWLEDGE_PATH` | No | `../lyra-knowledge` relative to cwd | Markdown knowledge repo |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth. Without it the calendar endpoints return "Google OAuth not configured" and nothing else is affected |
| `GOOGLE_CLIENT_SECRET` | No | — | Token exchange and refresh |
| `GOOGLE_REDIRECT_URI` | No | — | Must match the Google Cloud Console **byte for byte** |
| `FRONTEND_URL` | No | `http://localhost:5173` | Where the OAuth callback redirects the browser back to. Set it, or Google auth lands on the dev server |
| `GCAL_API_KEY` | No | built-in public embed key | Only for public calendar reads |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | No | `Lyra` / `lyra@localhost` | Identity for knowledge-note commits. Without one `git commit` fails, and the failure is ignored on purpose — notes save, history does not |

Deliberately never forwarded to the service: `LYRA_HTTP_CACHE` and `LYRA_HTTP_FIXTURES`, which point
the chain client at recorded test responses. Forwarding them would let a stray line in `.env.local`
make production report fixture balances as your money.

Build-time only, inlined into the JS bundle — they do nothing as runtime variables:

| Build arg | Default | What it does |
|---|---|---|
| `VITE_USE_API` | `true` | `true` = talk to the API; anything else = browser-local storage |
| `VITE_API_URL` | dev-server URL | Must be `/api` for same-origin serving. `release.yml` sets it |

### 7.1 Wealth

Nothing here is required. Without them the API starts, serves every route, and reports an empty
book; the sweep runs and finds nothing to say. **A blank page is the symptom of a missing variable,
rather than a crash** — which is why §6 lists it.

| Variable | Default | What it does |
|---|---|---|
| `ALERT_WALLETS` | — | Wallets the sweep and the digest cover. Comma/space separated `0x…` and/or `bc1…`. The wealth pages take their addresses from the request, not from this |
| `KUCOIN_API_KEY` / `_SECRET` / `_PASSPHRASE` | — | Read-only exchange credentials. **Do not grant trade permission** — nothing in this stack places an order, so a key that can trade only adds blast radius |
| `TELEGRAM_BOT_TOKEN` | — | Unset, `/alerts/test` and `/alerts/digest` answer `400` and the sweep still runs, recording state without sending. That is the right first-boot state |
| `TELEGRAM_CHAT_ID` | — | Where alerts go |
| `TELEGRAM_OWNER_USER_ID` | — | Which row in `users` the life commands read, for `/today`, `/next`, `/inbox`, `/week` and the habits nudge. Unset with exactly one user is fine — it is inferred. Unset with several, or naming a user that does not exist, leaves the money commands working and the life commands declining |
| `DISCORD_WEBHOOK_URL` | — | The second channel. **The whole URL is the credential** — its last path segment is a token, so anyone holding it can post to that channel. The host is checked on construction, so a typo fails rather than posting your portfolio somewhere else. **Setting this turns on live delivery to a live channel.** See [Alerts](./alerts.md) |
| `ALERT_INTERVAL` | `900` | Seconds between sweeps |
| `SNAPSHOT_INTERVAL` | — | Seconds between net-worth snapshots |
| `SNAPSHOT_GROUP` | — | Group the snapshot cron writes under |
| `DIGEST_HOUR` | — | **Local** hour for the daily brief. **Unset means no digest is ever sent** |
| `HABITS_NUDGE_HOUR` | — | **Local** hour to message you about recurrences that are due. **Unset means never**, which is the default: the daily brief already arrives, and a second unsolicited message is a choice rather than a setting to find and turn off. Reads `schedules`; writes nothing, and never touches `nextDue` — see [Core engine](./core-engine.md) |
| `ALERT_FEE_USD` | — | Claimable threshold that triggers a harvest nudge |
| `ALERT_HF` | — | Health factor below which a borrow is called out |
| `ALERT_REPORT_CCY` | — | Currency the digest reports in |
| `REQUEST_DEADLINE` | — | Chain fan-out budget in seconds |
| `ADAPTER_CONCURRENCY` | — | Parallel adapter reads |

`.env.local` is the only copy on disk of the KuCoin key and the Telegram token. Back it up alongside
the database.

**The first sweep is silent, the second is not.** A fresh `alert_state` baselines without sending;
once it has a baseline, a real change sends a real message to a real phone. When testing, either
stop the API inside `ALERT_INTERVAL` or leave `TELEGRAM_BOT_TOKEN` unset.

### 7.2 The MCP research desk

`lyra-mcp` is a **separate stdio process**, not a service — an MCP client launches it as a child and
talks JSON-RPC over its stdin/stdout. It is not part of the deployment above because there is
nothing for it to listen on, and it is not fetched by the release pipeline: it runs wherever the
client runs, which is usually the laptop.

```bash
cd core && cargo build --release --bin lyra-mcp
```

Register it with the client (Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "proof-of-wealth": {
      "command": "/path/to/lyra/core/target/release/lyra-mcp",
      "env": { "LYRA_DB": "/path/to/lyra.db", "POW_WALLETS": "0x…,bc1…" }
    }
  }
}
```

Two things to get right:

- **`LYRA_DB` must be the same database the API uses**, or the analysis journal the desk writes is a
  different journal from the one the Journal page reads. Pointing it at the mini PC's database means
  pointing it at a file over a network mount — SQLite over a network filesystem is a way to corrupt
  a database, so prefer running the desk on the box itself, or against a `VACUUM INTO` copy.
- **Wallets come from `POW_WALLETS`, falling back to `ALERT_WALLETS`.** The desk is a research tool
  and gets its own setting on purpose — pointing it at a subset of the book is a reasonable thing to
  want. But requiring the same list under a second name on a single-user box only produces two lists
  that drift, so an unset or blank `POW_WALLETS` means "whatever the sweep watches".

It refuses to start if any signing variable (`PRIVATE_KEY`, `MNEMONIC`, `SEED_PHRASE`, …) is in its
environment, and refuses any `MCP_TRANSPORT` but stdio. Both exit 1 with the reason on stderr.

**The tool surface, the read-only invariant and what each guarantee actually buys are in
[`docs/mcp.md`](./mcp.md).** This section is build-and-register only.

---

## 8. Remote access

**Tailscale**, free tier — 100 devices, 3 users. On the box (the Windows side is simplest, with
mirrored networking from §2):

```bash
tailscale up
tailscale serve --https=443 http://localhost:3030
```

**Use HTTPS, not plain HTTP over the tailnet.** Lyra is a PWA and service workers require a secure
context; over `http://minipc:3030` the worker silently never registers and you lose offline and
install. `tailscale serve` gives a real certificate for free.

Then add the `*.ts.net` origin to `FRONTEND_URL`, `CORS_ORIGINS` and `GOOGLE_REDIRECT_URI` — in
`.env.local` **and** in the Google Console, byte for byte — and re-run `setup`.

**Do not port-forward.** If you want a shell fallback instead:
`ssh -L 3030:localhost:3030 you@minipc`.

---

## 9. Updates

Push to `master`. That is the whole procedure — `release.yml` gates and builds, and the box installs
the new tag within five minutes.

```bash
sudo /opt/lyra/bin/lyra-update.sh          # don't wait for the timer
sudo ./ops/lyra-server-linux.sh rollback   # back to the previous release
```

`deploy` health-checks after restarting and **rolls itself back** if the new binary does not answer,
so a bad build costs a minute of downtime rather than an evening. Exactly one previous release is
kept: two is a rollback target, ten is a disk that fills up on a box nobody is watching.

Migrations run forward-only at startup against `PRAGMA user_version`. They are append-only by
policy, so a rollback of the *binary* across a migration boundary will fail to open the database —
that is the one case where you restore a backup from §5 instead.

Changing settings is not a deploy: edit `.env.local` in the checkout on the box and re-run
`sudo ./ops/lyra-server-linux.sh setup`.

---

## 10. What is deliberately not automated

- **`.env.local` never travels through CI.** No secret is needed to build: the bundle is
  configuration-free apart from `VITE_API_URL`, and every runtime setting is read on the box. There
  are no GitHub Actions secrets in this pipeline at all.
- **The parity gate is not in CI.** `parity.toml` points at a Python oracle on `127.0.0.1:8000` that
  exists only on the author's laptop. Run `make parity` there. See [parity](./parity.md).
- **`npm run lint` does not gate.** 58 pre-existing errors; it runs in `ci.yml` reporting only. A
  check that is red the day you add it teaches everyone to ignore checks. Clean them, then drop the
  `|| true` in `ci.yml`.
