# Deployment

How to run Lyra on the mini PC: a Rust API, an nginx serving the React front end, and Ollama for
local AI. Everything is local-only by default — nothing is published to the internet.

The stack is `docker-compose.yml`. The TypeScript API it replaced was deleted on 2026-08-19;
`git log -- api/` still has it.

---

## 1. What you need

- A mini PC running Linux (Debian/Ubuntu) or macOS
- Docker + Docker Compose
- **Disk headroom.** The API image compiles the Rust workspace inside the container; between the
  build cache, the images and the database volume, give it **20 GB free** and keep an eye on it.
  A build that runs out of space does not fail with "no space left on device" — it fails with an
  I/O error deep in a layer write, and on Docker Desktop it can take the VM down with it, needing
  a restart from the GUI. Check `df -h /` before a first build.
- The repo checked out somewhere sensible, e.g. `~/lyra`
- Ollama models are extra on top of that, and they are gigabytes each

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
- **Wallets come from `POW_WALLETS`**, not `ALERT_WALLETS`. The desk is a research tool with its
  own scope; the sweep's wallet list is a separate setting on purpose.

It refuses to start if any signing variable (`PRIVATE_KEY`, `MNEMONIC`, `SEED_PHRASE`, …) is in
its environment, and refuses any `MCP_TRANSPORT` but stdio. Both exit 1 with the reason on stderr.

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
