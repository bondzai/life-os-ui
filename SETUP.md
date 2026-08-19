# Lyra — Setup Guide

## Prerequisites

- **Node 24** — `nvm use` in this directory picks it up from `.nvmrc`. The shell default of 18
  is too old for Vite 7.
- **Rust** — Homebrew's rustup keg only links `rustup`; the cargo/rustc shims live in
  `/opt/homebrew/opt/rustup/bin`, which the `Makefile` prepends for you.
- Git, and Docker if you want the container stack.

## Quick Start (Local Development)

```bash
git clone git@github.com:bondzai/life-os-ui.git
cd life-os-ui
nvm use && npm install

# Terminal 1 — the Rust API on :3001
export JWT_SECRET="$(openssl rand -base64 48)"
make dev-api

# Terminal 2 — the front end on :5174
make dev-ui
```

Then sign in and pick **API** mode; the PIN is whatever is in your database (`1234` on a fresh
seed). The choice is stored as `lyra:data-mode` and is what every repository — entities,
trackers, and the wealth surfaces alike — reads to decide whether it is talking to the server or
to browser-local demo data. `VITE_USE_API=true` in a root `.env` sets the default for a session
that has not chosen.

**Wealth needs a little more.** The wealth pages read live chain data, which the server fetches
for the addresses in `ALERT_WALLETS`, and the KuCoin account needs read-only API credentials.
All of it lives in `.env.local` (gitignored, mode 600); `.env.example` documents every name. With
none of it set the API still starts and every page renders an empty book — a blank Holdings page
is the symptom of a missing variable, not a crash.

**The MCP research desk** is a separate stdio binary, `make mcp`. See
[Deployment §7.2](./docs/deployment.md).

---

## Deployment

Lyra is meant to run on a mini PC in your house, not in someone else's cloud: it holds a live
picture of your net worth, and the whole point of a keyless design is that nothing about it has
to leave the LAN.

```bash
docker compose up -d --build      # UI on :8080, Ollama on :11434
```

The full procedure — first run, bringing the legacy database across, backups, restore,
troubleshooting, and every environment variable — is in [Deployment](./docs/deployment.md).

The earlier Render + Turso instructions are gone with the Hono API they deployed. For access
from outside the house, put the box on a tailnet rather than forwarding a port; see
[Deployment §8](./docs/deployment.md).

---

## Data Backup Migrations (localStorage)

Export/import handles schema changes automatically. Backups are versioned — when you import an older backup, it runs migrations to transform the data to the current schema.

**Location:** `src/lib/data-backup.ts`

### How It Works

1. Every export stamps `CURRENT_VERSION` (e.g. `2`)
2. On import, if the backup version is older, migrations run sequentially (v1→v2→v3→...)
3. Legacy backups without a version are treated as v1

### When You Change Schema

1. Bump `CURRENT_VERSION`
2. Add a migration function to `MIGRATIONS`

```typescript
// src/lib/data-backup.ts

const CURRENT_VERSION = 3  // ← bump

const MIGRATIONS: Record<number, MigrationFn> = {
  1: migrateV1toV2,
  2: (data) => {  // ← add migration from v2 → v3
    const entities = (data['lyra:entities'] ?? []) as Record<string, unknown>[]
    for (const e of entities) {
      if (!e.color) e.color = 'default'  // new required field
    }
    return data
  },
}
```

### Rules

- Each migration transforms data from version N to N+1
- Migrations must be backwards-compatible (never remove a migration)
- Importing a backup from a newer version is rejected with a clear error

---

## Database Migrations

Forward-only SQL in `core/crates/lyra-db/src/migrations`, applied automatically when the API
starts and tracked by `PRAGMA user_version`. There is nothing to generate and nothing to run by
hand: no ORM sits between the code and the schema.

To add a column, write the next numbered migration and bump the version. To bring a legacy
database across, `make db-migrate` — the importer is `INSERT OR IGNORE`, so re-running it after
the old system has moved on is safe and picks up only what is new.

---

## Project Structure

```
lyra/
├── src/                    # Frontend (React + Vite)
│   ├── core/               # Entity engine, hooks, types
│   ├── pages/              # Route pages
│   ├── components/         # Shared UI components
│   ├── stores/             # Zustand stores
│   ├── layout/             # Sidebar, shell
│   └── lib/                # Utilities
├── core/                   # Backend — one Rust workspace
│   ├── crates/lyra-api/    # axum HTTP server (the binary you run)
│   ├── crates/lyra-db/     # SQLite + forward-only migrations
│   ├── crates/lyra-chain/  # Multi-chain portfolio reader
│   ├── crates/lyra-analytics/  # Tier/exposure/strategy maths
│   ├── crates/lyra-alerts/ # Background sweep, digest, Telegram
│   ├── crates/lyra-mcp/    # MCP research desk (separate stdio binary)
│   ├── crates/lyra-parity/ # Diffs this port against the Python oracle
│   └── data/               # Local SQLite file (gitignored)
├── docker-compose.yml      # The deployment stack
├── Dockerfile.ui           # Front-end image (VITE_* are BUILD args)
└── nginx.conf         # Front-end proxy + CSP
```

## API Endpoints

All protected routes require `Authorization: Bearer <jwt>` header.

| Method | Endpoint              | Auth | Description           |
|--------|-----------------------|------|-----------------------|
| GET    | `/api/health`         | No   | Health check          |
| POST   | `/api/auth/login`     | No   | Login with PIN        |
| GET    | `/api/entities`       | Yes  | List user entities    |
| POST   | `/api/entities`       | Yes  | Create entity         |
| PUT    | `/api/entities/:id`   | Yes  | Update entity         |
| DELETE | `/api/entities/:id`   | Yes  | Delete entity         |
| GET    | `/api/trackers`       | Yes  | List trackers         |
| POST   | `/api/trackers`       | Yes  | Create tracker entry  |
| DELETE | `/api/trackers/:id`   | Yes  | Delete tracker        |
| GET    | `/api/schedules`      | Yes  | List schedules        |
| POST   | `/api/schedules`      | Yes  | Create schedule       |
| PUT    | `/api/schedules/:id`  | Yes  | Update schedule       |
| DELETE | `/api/schedules/:id`  | Yes  | Delete schedule       |
| GET    | `/api/relations`      | Yes  | List relations        |
| POST   | `/api/relations`      | Yes  | Create relation       |
| DELETE | `/api/relations/:id`  | Yes  | Delete relation       |
| GET    | `/api/gcal/events`    | Yes  | List calendar events  |
| POST   | `/api/gcal/events`    | Yes  | Create calendar event |
| PUT    | `/api/gcal/events/:id`| Yes  | Update calendar event |
| DELETE | `/api/gcal/events/:id`| Yes  | Delete calendar event |

## Environment Variables Reference

### Frontend (root `.env`)

| Variable         | Default | Description                     |
|------------------|---------|---------------------------------|
| `VITE_USE_API`   | —       | Set `true` to use backend API   |
| `VITE_API_URL`   | —       | API base URL (e.g. `/api`)      |

### Backend

`JWT_SECRET` is the only required one — missing or empty and the process exits 1 rather than sign
tokens with a fallback secret.

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | *required* | Signs session tokens |
| `LYRA_DB` | `data/lyra.db` | SQLite path. WAL mode, so it always has `-wal`/`-shm` sidecars — back up all three or none |
| `PORT` | `3001` | Listen port |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:8080` | Comma-separated allow-list |
| `RUST_LOG` | `info` | Tracing filter |
| `LYRA_KNOWLEDGE_PATH` | `../lyra-knowledge` | Markdown notes repo; `/api/knowledge` 404s without it |
| `GOOGLE_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` | — | Calendar OAuth |
| `FRONTEND_URL` | `http://localhost:5173` | Where the OAuth callback returns to |

Wealth and alert variables — `ALERT_WALLETS`, the KuCoin credentials, the Telegram token, the
sweep thresholds — are in [Deployment §7.1](./docs/deployment.md). All optional; without them the
book is empty.
