# API Server

One Rust binary, `lyra-api`, serving every route the front end calls. It replaced a planned
Hono + Drizzle server that was deleted on 2026-08-19 along with `api/`; `git log -- api/` still
has that code if you want to see what the shape used to be.

**`crates/lyra-api/src/main.rs` is the authoritative route list.** This document explains the
model; it does not try to stay in sync with every path, because a doc that drifts is worse than
no doc when the thing it describes handles money.

## Stack

| Piece | What | Why |
|---|---|---|
| axum 0.8 | HTTP | Same tokio runtime as the chain fan-out and the alert sweep, so one process does all three |
| sqlx (SQLite, WAL) | Storage | One file plus its `-wal`/`-shm` sidecars. No ORM: schema changes are forward-only SQL in `crates/lyra-db/src/migrations`, applied at startup and tracked by `PRAGMA user_version` |
| jsonwebtoken + bcrypt | Auth | HS256 session tokens; PINs stored as bcrypt |

## Why one binary

The alternative was an API process and a separate wealth service. One process means the
`Prices`, `Market` and vfat TTL caches are shared rather than duplicated — two of each would
mean two TTL windows over the same upstream and a cache hit rate that halves for no reason. It
also means the alert sweep reads the same code path the UI does, so an alert can never disagree
with the page it points at.

## Route groups

| Prefix | What | Auth |
|---|---|---|
| `/api/entities`, `/api/trackers`, `/api/schedules`, `/api/relations` | The core primitives — CRUD | JWT |
| `/api/knowledge` | Git-backed markdown notes. 404s unless `LYRA_KNOWLEDGE_PATH` points somewhere real | JWT |
| `/api/gcal/*` | Google Calendar OAuth + events | JWT, except the callback and the public read paths |
| `/api/wealth/*` | Portfolio, LP positions, borrows, bots, market data, the analysis journal, alert config | JWT |
| `/api/search` | Cross-entity search | JWT |
| `/api/health` | `SELECT 1` against the pool — a failure means the process is up and storage is not | none |
| `/api/auth/login` | PIN → token | none, rate-limited |

## Authentication

`POST /api/auth/login` with `{"pin": "…"}` returns `{token, user}`. Send it as
`Authorization: Bearer <token>`.

Two things worth knowing:

- **Legacy PINs were plaintext.** The old `life-os.db` stored them unhashed. The port accepts a
  plaintext PIN when the stored value is not a `$2[aby]$` hash and re-stores it as bcrypt on the
  first successful login, so the upgrade happens without anyone having to reset anything.
- **`JWT_SECRET` has no default.** Missing or empty and the process exits 1 rather than sign
  tokens with a fallback secret — the one failure mode where starting successfully is worse than
  not starting.

A protected route without a token answers `401`; a missing entity answers `404`, which is what
the client's `getById` turns into `undefined`.

## The wealth routes are a port, not a design

`/api/wealth/*` is a port of `wallet-portfolio/server.py`, contract-identical so the same JSON
reads the same on both sides. Two deliberate divergences:

1. **Paths are prefixed `/api/wealth/`** — the Python owned the whole `/api` namespace; here it
   is a guest in Lyra's, and `/api/history` would collide.
2. **Every route is JWT-protected**, where the Python served reads to anyone on the LAN.

And one addition: an absent `?address=` falls back to `ALERT_WALLETS` rather than answering 400.
This is a single-user box whose wallets are already configured server-side. An explicit address
still wins, and a *malformed* one is still a 400 — the fallback covers "you did not say", never
"you said something wrong".

Whether the port is faithful is not a matter of opinion: see [the parity harness](./parity.md),
which diffs this server against the Python one endpoint by endpoint.

## Two hazards to know before trusting a number

- **A partial read looks like a complete one.** The chain fan-out returns what it got when its
  deadline expires, and the `FetchHealth` that comes back with it is logged rather than
  serialised — because the Python has no such field and adding one would fail every parity run.
  Safe to display, **not** safe to record. A cold read that drops KuCoin logs
  `(kucoin skipped: timed out)` and quietly reports a smaller book.
- **Off-chain assets are only what you have told it.** The server is keyless: it reads public
  chain data for addresses it is given and cannot *discover* gold in a drawer. It can be told, and
  since 2026-08-21 that is what `/api/wealth/manual-assets` is for — the book is server state, and
  the net-worth snapshot counts it. A number is still only as complete as that list: nothing
  reconciles it against reality, so an asset you sold and did not delete is still in your net
  worth.

## Configuration

See [Deployment §7](./deployment.md) for the full table. The short version: `JWT_SECRET` is
required, `LYRA_DB` defaults to `data/lyra.db`, and everything wealth-related is optional — the
server starts and serves every route without it, reporting an empty book.
