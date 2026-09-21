# Deployment

How to run Lyra on the mini PC: a Rust API, an nginx serving the React front end, and Ollama for
local AI. Everything is local-only by default — nothing is published to the internet.

The stack is `docker-compose.yml`. The TypeScript API it replaced was deleted on 2026-08-19;
`git log -- api/` still has it.

---

## 1. What you need

- A mini PC running Linux (Debian/Ubuntu) or macOS
- Docker + Docker Compose
- **About 3 GB of free disk for the first build**, and ~400 MB once it is built. The breakdown is
  in §1.1 — the images themselves are small; it is the Rust builder that is briefly large.
- The repo checked out somewhere sensible, e.g. `~/lyra`
- Ollama models are extra on top of that, and they are gigabytes each


### 1.1 What actually takes the space

Worth knowing, because the numbers look alarming from the outside and mostly are not.

**Shipped — measured from the built images, not estimated:**

| Image | Total | Where it goes |
|---|---|---|
| `lyra-api` | **300 MB** | debian-slim base 108 MB · **apt layer 106 MB** · `lyra-api` 12.5 MB · `lyra-migrate` 3 MB |
| `lyra-ui` | **95.5 MB** | nginx:alpine packages 51 MB · the built SPA 2.2 MB · base and entrypoint scripts |

About 400 MB for the whole application. The surprise is the API's **apt layer: `git` and its
dependency chain cost 106 MB — as much as the entire base OS**, and `--no-install-recommends` is
already set, so that is git's hard dependencies. It is there for one feature: the knowledge
module shells out to `git` for note history. Replacing that with a Rust git library (`gix`,
`git2`) would take roughly a third off the image. Worth knowing; not worth doing until the image
size actually matters.

**Transient — build cache only, never shipped:**

| What | Size | Where it lives |
|---|---|---|
| `rust:1-bookworm` builder | ~1.4 GB | image layer, builder stage only |
| the workspace's `target/` | ~900 MB, mostly dependency artefacts | **BuildKit cache mount** — not a layer at all |
| the cargo registry | a few hundred MB | BuildKit cache mount |
| `node:24-alpine` builder | ~180 MB | image layer, builder stage only |

None of it reaches the final images. `target/` and the cargo registry are mounted as BuildKit
caches rather than written into layers, which is why the builder stage stays thin and why a
source-only change recompiles the seven workspace crates and nothing else.

`docker builder prune` reclaims all of it, at the cost of a full recompile next time — the cache
is local to the machine, which is the right trade for a box that builds its own images and the
wrong one if you ever move these builds to CI and a registry.

**The real disk consumer is Ollama**, and it is optional: the image is ~1 GB and each model is
gigabytes on top. Pull models deliberately, not by reflex.

**What is *not* a normal cost:** the first build attempt here uploaded ~15.9 GB as build context
and filled the disk. That was a missing rule in the root `.dockerignore` — it did not exclude
`core/`, so building the *UI* image sent the entire Rust `target/` directory to the daemon. Fixed;
the context is now 3 MB. If you ever see a build eat tens of gigabytes, suspect the context
before the image.

---

## 2. First run

### 2.1 Create the `.env`

Compose reads `.env` from the repo root. Create it with at minimum a JWT secret:

```bash
cd ~/lyra
printf 'JWT_SECRET=%s\n' "$(openssl rand -base64 48)" > .env
chmod 600 .env
```

The API **refuses to start** without `JWT_SECRET` — it exits with
`FATAL: JWT_SECRET environment variable is required` rather than falling back to a default. That
is deliberate: a predictable secret means anyone can mint a valid login token.

Keep the secret. Changing it later logs everyone out (all issued tokens become invalid), which is
also how you force a logout if a device is lost.

Everything else is optional. The full list is in section 7; a typical mini PC `.env` ends up as:

```dotenv
JWT_SECRET=<the generated value>
FRONTEND_URL=http://lyra.local:8080
CORS_ORIGINS=http://lyra.local:8080,http://192.168.1.50:8080
UI_PORT=8080
```

### 2.2 Bring the database over from the old stack

The Rust backend uses one SQLite file, `lyra.db`, which replaces the old Drizzle database
(`api/data/life-os.db`) and, if you use it, wallet-portfolio's `pow.db`. The `lyra-migrate`
binary creates the schema and imports both.

**Stop the old stack first, then copy the files — including their sidecars:**

```bash
docker compose down                 # stop the old API so nothing is mid-write

mkdir -p legacy
cp api/data/life-os.db* legacy/     # the * matters: -wal and -shm come too
cp /path/to/pow.db*     legacy/     # only if you use the wealth module
```

The `*` is not optional. In WAL mode, recent writes live in the `-wal` file and are not yet in
the `.db`. Copying the `.db` alone silently loses them, and opening a half-copied set can make
SQLite rewrite the original.

Now run the importer once. It is profile-gated, so it never starts as part of `up`:

```bash
docker compose run --rm migrate \
    /data/lyra.db --from-lyra /legacy/life-os.db --from-pow /legacy/pow.db
```

It prints a per-table row count. Re-running is safe — the schema migration is versioned and the
import is `INSERT OR IGNORE`, so nothing is duplicated. Starting fresh with no legacy data?
Skip the flags: `... run --rm migrate /data/lyra.db` creates an empty schema. (You can even skip
this step entirely — the API migrates on boot — but then you have no data.)

Once the import looks right, delete `./legacy/`; it is a copy of your database sitting in the
clear.

### 2.3 Build and start

```bash
docker compose up -d --build
```

The first build compiles ~400 Rust crates and takes 10–25 minutes on mini PC hardware. Later
builds reuse the dependency layer and take under a minute unless `Cargo.toml`/`Cargo.lock`
changed.

Check it came up:

```bash
docker compose ps          # api should be "healthy"
curl -s localhost:8080/api/health                     # {"status":"ok"}
```

Then open `http://<mini-pc>:8080` from any device on the LAN.

### 2.4 Pull an AI model

Ollama starts empty:

```bash
docker compose exec ollama ollama pull llama3.2:1b
```

The models live on the `ollama-models` volume and survive image updates.

One thing to know: **the browser talks to Ollama directly**, not through the API. So the Ollama
port has to be reachable from the device you browse on, and the front end's Content-Security-
Policy has to allow that origin. Out of the box `nginx.conf` allows `localhost:11434` only.
To use AI from your phone or laptop, add the mini PC's address to the `connect-src` list in
`nginx.conf`:

```
connect-src 'self' http://localhost:11434 http://192.168.1.50:11434 https://*.googleapis.com;
```

then `docker compose restart ui`. The file is bind-mounted, so no
rebuild is needed. If you skip this, the app shows AI as offline and falls back to its
algorithmic mode — everything else keeps working.

---

## 3. Ports

| Port | Service | Published |
|---|---|---|
| 8080 | UI (nginx) | yes — `UI_PORT` overrides |
| 11434 | Ollama | yes, and it has to be: the **browser** calls Ollama directly (`src/hooks/use-ai-health.ts`), the API never proxies it. Unreachable from the device running the browser means AI features show offline and fall back to algorithmic mode |
| 3001 | Rust API | no — nginx reaches it over the compose network. Uncomment the `ports:` block to hit it directly from a phone or a local `npm run dev` |

The compose project is named `lyra-rust`, which is where the volume names
(`lyra-rust_lyra-data`, `lyra-rust_ollama-models`) come from. Do not rename it on an existing
deployment: compose would create a second, empty database and the app would come up blank.


### 3.1 Seeding the volume — the two things that will bite you

The `lyra-data` volume starts empty, so a first `up` gives you a freshly migrated schema with
**no users**, and the login page will reject every PIN. Import the legacy databases (§2.2), or
copy a working database across:

```bash
# .backup, not cp — it checkpoints the WAL, so one file carries everything.
sqlite3 core/data/lyra.db ".backup /tmp/seed.db"

docker run --rm -v lyra-rust_lyra-data:/data -v /tmp:/src:ro alpine \
    sh -c "cp /src/seed.db /data/lyra.db && chown -R 10001:10001 /data"
```

**`chown -R` on `/data`, not just the file.** The container runs as uid 10001, and SQLite in WAL
mode has to *create* `lyra.db-wal` and `lyra.db-shm` in that directory. A root-owned directory
with a correctly-owned database inside it fails with `attempt to write a readonly database` —
which points at the file and is the wrong place to look. (uid 10001 is what matters; the group
inside the image is gid 999, and mismatching it is harmless.)

**Export `JWT_SECRET` for every compose command, not just `up`.** It is declared `:?` so compose
refuses to interpolate without it — including for `logs` and `ps`, which then report the
interpolation error instead of the container state and make a running stack look broken.

---

## 4. Backups

The database lives on the `lyra-data` Docker volume as three files: `lyra.db`, `lyra.db-wal`,
`lyra.db-shm`. **Never back up `lyra.db` on its own** — the WAL holds committed data that is not
in the main file yet.

### 4.1 Nightly snapshot (do this at minimum)

`sqlite3 .backup` takes a consistent copy while the API is running — no downtime, no stopping
containers:

```bash
mkdir -p ~/backups ~/bin
cat > ~/bin/lyra-backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date +%Y%m%d)
# The runtime image has no sqlite3, so a throwaway alpine container does the work. It mounts the
# same volume the API is using — .backup is safe to run against a live database.
docker run --rm -v lyra-rust_lyra-data:/data -v "$HOME/backups:/out" alpine \
    sh -c "apk add -q sqlite && sqlite3 /data/lyra.db \".backup /out/lyra-$STAMP.db\""
find "$HOME/backups" -name 'lyra-*.db' -mtime +30 -delete
EOF
chmod +x ~/bin/lyra-backup.sh
~/bin/lyra-backup.sh && ls -l ~/backups   # run it once by hand before trusting cron
```

```bash
crontab -e
# 3am nightly, keep 30 days
0 3 * * * ~/bin/lyra-backup.sh >> ~/backups/backup.log 2>&1
```

The runtime image has no `sqlite3` binary, hence the `alpine` fallback in the script — it is the
path that will actually be taken. A `.backup` output file is self-contained: no sidecars, safe to
copy anywhere.

### 4.2 Continuous backup with Litestream (optional, off by default)

A nightly snapshot can lose up to a day of work. Litestream streams the WAL to object storage
continuously, so the worst case is seconds. It needs no application changes — it reads the same
file the API writes.

To enable:

1. `cp litestream.example.yml litestream.yml`
2. Fill in your bucket, region and (for B2/R2/MinIO) endpoint. Leave the credential lines
   commented and pass them as environment variables instead:
   ```dotenv
   LITESTREAM_ACCESS_KEY_ID=...
   LITESTREAM_SECRET_ACCESS_KEY=...
   ```
   in `.env`. `litestream.yml` and `.env` are both gitignored — keep it that way.
3. Uncomment the `litestream` service in `docker-compose.yml`.
4. `docker compose up -d litestream`

Verify it is actually replicating — a backup you never checked is not a backup:

```bash
docker compose logs litestream | tail
docker compose exec litestream litestream snapshots /data/lyra.db
```

No cloud account? `litestream.example.yml` also shows a `file` replica, which does the same
thing onto a second disk or USB drive plugged into the mini PC.

---

## 5. Restore

### From a nightly snapshot

```bash
docker compose stop api

# Wipe the old database AND its sidecars, then drop the snapshot in.
docker run --rm -v lyra-rust_lyra-data:/data -v "$HOME/backups:/in" alpine \
    sh -c 'rm -f /data/lyra.db /data/lyra.db-wal /data/lyra.db-shm \
           && cp /in/lyra-20260814.db /data/lyra.db'

docker compose start api
curl -s localhost:8080/api/health
```

Leaving a stale `-wal` behind next to a restored `.db` is the classic way to corrupt the result.
Delete all three.

### From Litestream

```bash
docker compose stop api

# Restore refuses to overwrite, so clear the old file and its sidecars first.
docker run --rm -v lyra-rust_lyra-data:/data alpine \
    rm -f /data/lyra.db /data/lyra.db-wal /data/lyra.db-shm

docker compose run --rm litestream \
    restore -o /data/lyra.db "s3://YOUR_BUCKET/lyra"

docker compose start api
```

Add `-timestamp 2026-08-14T09:00:00Z` before `-o` to restore to a specific point in time.

**Practise this once, now, while nothing is wrong.** Restore into a scratch path and open it —
that is the only way to know your backups work.

---

## 6. When something is wrong

Start here:

```bash
docker compose ps       # who is up, who is healthy
docker compose logs -f api
```

| Symptom | Likely cause | Fix |
|---|---|---|
| `api` exits immediately, log says `FATAL: JWT_SECRET ... required` | No `.env`, or you ran compose from another directory | `cd ~/lyra` first; confirm `.env` contains `JWT_SECRET=` |
| `api` restarts forever, health never goes green | DB unreadable — health runs a real query, so this is storage, not the process | `docker compose logs api`; check the volume: `docker run --rm -v lyra-rust_lyra-data:/data alpine ls -l /data` |
| UI loads but everything is empty and nothing saves | Bundle built without `VITE_USE_API=true`, so the app is in browser-local mode | Rebuild with `--build`. Check in the app: Settings shows the data mode. A stale `lyra:data-mode` in localStorage overrides the build — clear site data |
| UI loads, calls to `/api/...` return 502 | nginx started before the API was healthy, or the API is down | `docker compose restart ui` after the API is healthy |
| Login returns 401 for a PIN that used to work | Different database, or a rotated `JWT_SECRET` | Confirm the import ran (section 2.2); users live in the `users` table |
| AI shows offline | Browser cannot reach Ollama, or the CSP blocks it | Open devtools → Console; a CSP violation means you need to add the origin to `nginx.conf` (section 2.4). Otherwise check `curl http://<mini-pc>:11434/api/tags` |
| Google Calendar says "not configured" | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` missing | Set all three (section 7); the redirect URI must match Google Cloud Console byte for byte |
| Google auth redirects to a dev URL | `FRONTEND_URL` still defaults to `localhost:5173` | Set `FRONTEND_URL` to the mini PC's UI origin |
| Knowledge notes save but have no history | Knowledge dir isn't mounted, or isn't a git repo | Uncomment `LYRA_KNOWLEDGE_PATH` and the bind mount; the directory must contain `.git`. Git failures are swallowed by design, so this fails quietly |
| Port already allocated on 8080 | The old stack is running | `docker compose down`, or set `UI_PORT=8081` |
| Rust build is slow every single time | You changed `Cargo.toml`/`Cargo.lock`, which invalidates the dependency layer | Expected. Unchanged deps → cached layer → fast build |

Turn up logging when the answer isn't obvious: `RUST_LOG=debug` in `.env`, then
`docker compose up -d api`.

---

## 7. Environment variables

Read from the source (`crates/lyra-api/src/main.rs`, `gcal.rs`, `knowledge.rs`), not from
memory.

| Variable | Required | Default | What it does |
|---|---|---|---|
| `JWT_SECRET` | **Yes** | — | Signs session tokens. Missing or empty → process exits 1. Generate: `openssl rand -base64 48` |
| `LYRA_DB` | No | `data/lyra.db` | SQLite path. Compose sets `/data/lyra.db` on the volume |
| `PORT` | No | `3001` | Listen port, bound on `0.0.0.0` |
| `CORS_ORIGINS` | No | `http://localhost:5173,http://localhost:8080` | Comma-separated allow-list. Irrelevant for the proxied UI (same-origin); matters for direct API access |
| `RUST_LOG` | No | `info` | Tracing filter, e.g. `debug` or `lyra_api=debug,info` |
| `LYRA_KNOWLEDGE_PATH` | No | `../lyra-knowledge` relative to cwd | Markdown knowledge repo. The default resolves to `/lyra-knowledge` in the container and won't exist unless mounted |
| `GOOGLE_CLIENT_ID` | No | — | Google OAuth. Without it the calendar endpoints return "Google OAuth not configured" |
| `GOOGLE_CLIENT_SECRET` | No | — | Google OAuth token exchange and refresh |
| `GOOGLE_REDIRECT_URI` | No | — | Must match Google Cloud Console exactly, e.g. `http://lyra.local:8080/api/gcal/auth/callback` |
| `FRONTEND_URL` | No | `http://localhost:5173` | Where the OAuth callback redirects the browser back to. Set it, or Google auth lands on the dev server |
| `GCAL_API_KEY` | No | built-in public embed key | Only for public calendar reads |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | No | `Lyra` / `lyra@localhost` | Identity for knowledge-note commits. Without an identity `git commit` fails, and the failure is ignored on purpose — notes save, history doesn't |
| `UI_PORT` | No | `8080` | Host port for the front end (compose-level) |
| `OLLAMA_PORT` | No | `11434` | Host port for Ollama (compose-level) |

### 7.1 Wealth

These come in through `env_file: .env.local`, **not** through `environment:` in the compose file.
That is deliberate: `environment:` wins over `env_file:`, so writing
`ALERT_WALLETS=${ALERT_WALLETS:-}` there would overwrite the real value with an empty string
whenever your shell had not exported it — and the symptom is a blank Holdings page on a healthy
container with nothing in the log.

Nothing here is required. Without them the API starts, serves every route, and reports an empty
book; the sweep runs and finds nothing to say.

| Variable | Default | What it does |
|---|---|---|
| `ALERT_WALLETS` | — | Wallets the sweep and the digest cover. Comma/space separated `0x…` and/or `bc1…`. The wealth pages take their addresses from the request, not from this |
| `KUCOIN_API_KEY` / `_SECRET` / `_PASSPHRASE` | — | Read-only exchange credentials. **Do not grant trade permission** — nothing in this stack places an order, so a key that can trade only adds blast radius |
| `TELEGRAM_BOT_TOKEN` | — | Unset, `/alerts/test` and `/alerts/digest` answer `400` and the sweep still runs, recording state without sending. That is the right first-boot state |
| `TELEGRAM_CHAT_ID` | — | Where alerts go |
| `DISCORD_WEBHOOK_URL` | — | The second channel. **The whole URL is the credential** — its last path segment is a token, so anyone holding it can post to that channel. The host is checked on construction, so a typo fails rather than posting your portfolio somewhere else. **Setting this turns on live delivery to a live channel**; the first sweep after a fresh `alert_state` is silent, the second is not. See [Alerts](./alerts.md) |
| `ALERT_INTERVAL` | `900` | Seconds between sweeps |
| `SNAPSHOT_INTERVAL` | — | Seconds between net-worth snapshots |
| `SNAPSHOT_GROUP` | — | Group the snapshot cron writes under |
| `DIGEST_HOUR` | — | Local hour for the daily brief. **Unset means no digest is ever sent** |
| `ALERT_FEE_USD` | — | Claimable threshold that triggers a harvest nudge |
| `ALERT_HF` | — | Health factor below which a borrow is called out |
| `ALERT_REPORT_CCY` | — | Currency the digest reports in |
| `REQUEST_DEADLINE` | — | Chain fan-out budget in seconds |
| `ADAPTER_CONCURRENCY` | — | Parallel adapter reads |

`.env.local` is the only copy on disk of the KuCoin key and the Telegram token. Back it up
alongside the database — a restored `lyra.db` with no `.env.local` is a system that comes up
showing an empty book.

**The first sweep is silent, the second is not.** A fresh `alert_state` baselines without sending;
once it has a baseline, a real change sends a real message to a real phone. When testing, either
stop the API inside `ALERT_INTERVAL` or leave `TELEGRAM_BOT_TOKEN` unset.

### 7.2 The MCP research desk

`lyra-mcp` is a **separate stdio process**, not a service — an MCP client launches it as a child
and talks JSON-RPC over its stdin/stdout. It is not in the compose file because there is nothing
for it to listen on.

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

- **`LYRA_DB` must be the same database the API uses**, or the analysis journal the desk writes is
  a different journal from the one the Journal page reads.
- **Wallets come from `POW_WALLETS`, falling back to `ALERT_WALLETS`.** The desk is a research
  tool and gets its own setting on purpose — pointing it at a subset of the book, or at an
  address the sweep does not watch, is a reasonable thing to want. But requiring the same list
  under a second name on a single-user box only produces two lists that drift, so an unset (or
  blank) `POW_WALLETS` means "whatever the sweep watches".

It refuses to start if any signing variable (`PRIVATE_KEY`, `MNEMONIC`, `SEED_PHRASE`, …) is in
its environment, and refuses any `MCP_TRANSPORT` but stdio. Both exit 1 with the reason on stderr.

**The tool surface, the read-only invariant and what each guarantee actually buys are in
[`docs/mcp.md`](./mcp.md).** This section is build-and-register only.

Build-time only, baked into the JS bundle — they do nothing as runtime variables:

| Build arg | Default | What it does |
|---|---|---|
| `VITE_USE_API` | `true` | `true` = talk to the API; anything else = browser-local storage |
| `VITE_API_URL` | `/api` | Same-origin path so nginx can proxy |

---

## 8. Remote access

The stack binds to the LAN only. To reach it from outside the house, do not port-forward — put
it on a tailnet:

```bash
# On the mini PC
tailscale up
tailscale serve --https=443 http://localhost:8080
```

Then `https://minipc.tail1234.ts.net` from any device on your tailnet. If you use this, add that
hostname to `CORS_ORIGINS` and `FRONTEND_URL`, and update `GOOGLE_REDIRECT_URI` in both `.env`
and Google Cloud Console.

An SSH tunnel works for one-off access: `ssh -L 8080:localhost:8080 user@minipc`.

---

## 9. Updates

```bash
cd ~/lyra
git pull
docker compose up -d --build
```

Schema migrations run automatically at API startup (forward-only, tracked by
`PRAGMA user_version`). Take a backup before updating anyway — section 4.

To free disk after several rebuilds: `docker image prune -f`.

## Running it locally as a service — 2026-08-22

`./ops/lyra-server.sh install`, or `make server-install`. Then **http://localhost:3030**.

One launchd job running one binary. The release `lyra-api` serves the API *and* the built front
end, so there is no node at runtime, no reverse proxy, and — because the app comes from the API's
own origin — no CORS to configure. `LYRA_UI_DIR` turns that on; unset (as in development, where
Vite serves the UI) the binary is an API and nothing else.

    make server-install   build, install, (re)start — also the way to deploy a change
    make server-status    loaded? answering?
    make server-logs      tail ~/Library/Logs/lyra/server.log
    make server-stop

`RunAtLoad` + `KeepAlive` mean it starts when you log in and comes back if it dies; verified by
`kill -9` on the pid and watching it answer again on a new one four seconds later.

### It installs into a prefix, and that is not optional

Everything the service runs from lives under `~/Library/Application Support/Lyra` — `bin/`, `ui/`,
`data/lyra.db` — not in the checkout.

**This repository is under `~/Desktop`, and macOS refuses a LaunchAgent access to Desktop,
Documents and Downloads** unless the user grants Full Disk Access by hand. The symptom is a
service that starts and instantly dies with `unable to open database file`, naming a file that is
plainly there and readable from your own shell. Installing outside the protected tree avoids the
whole question, which is where application data belongs anyway.

`install` copies `core/data/lyra.db` to the prefix on first run, with `sqlite3 .backup` rather
than `cp` — a plain copy of a WAL-mode database mid-write yields a torn file that opens fine and
is missing rows. `.env.local`'s `LYRA_DB` is then pointed at the installed copy so `make dev-api`
and the service share one database instead of drifting apart.

### Three things that had to be got right

**`VITE_API_URL=/api` at build time.** The default is the absolute `http://localhost:3001/api`
the dev server needs. Baked into the served bundle, every request from :3030 goes to a port with
nothing on it and every page renders its error state against a perfectly healthy server. The
install script sets it; a hand-run `npm run build` does not.

**`/api/*` is carved out of the SPA fallback.** A fallback catches every unmatched path,
`/api/typo` included, and answering that with 200 and a page of HTML turns a mistyped request
into "the JSON parser failed" three layers from the cause. A test asserts the catch-all is
registered before the fallback.

**The install script does not go through `nvm`.** `nvm.sh` is not safe under `set -u`: sourcing
it killed the script mid-way with no output at all, which reads exactly like a build that
succeeded. The script resolves the version in `.nvmrc` to a directory under
`~/.nvm/versions/node` and puts that on `PATH` itself.

### Docker is still there

`make docker-up` and the compose stack are unchanged, and remain the path for the mini PC. This
is the lighter answer for a Mac that is also your development machine — no VM, and Docker Desktop
was not running.
