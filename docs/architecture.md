# Architecture

**Rewritten 2026-09-21.** The previous version drew an OpenClaw gateway that was never built, put
the API on port 3000, called `ApiRepository` future work two paragraphs after describing it as
shipped, and headed a section "Current limits (localStorage era)". This one describes what is in
the tree.

---

## The shape of it

Lyra is one React SPA, one Rust binary, one SQLite file, and a second Rust binary that reads the
same file over stdio. Everything runs on a mini PC behind a home router with nothing forwarded to
it — which is not a detail, it is the constraint that explains most of the decisions below.

```
                        MINI PC (home server)
  ┌──────────────────────────────────────────────────────────────┐
  │                                                              │
  │   React SPA ──HTTP──►  lyra-api  ──────►  ┌──────────┐       │
  │   (:5173 dev,          (:3001)            │  SQLite  │       │
  │    nginx in prod)      ├─ alert sweep     │   WAL    │       │
  │                        ├─ tgbot poll      │  + jobs  │       │
  │                        ├─ job workers     └────┬─────┘       │
  │                        └─ chain fan-out        │             │
  │                                                │             │
  │                             lyra-mcp ──stdio───┘             │
  │                             (child of an MCP client)         │
  └───────────┬──────────────────────────▲───────────────────────┘
              │ out: alerts, digest      │ in: commands (long poll)
              ▼                          │
        Telegram · Discord          Telegram
```

There is no gateway. There is no message broker. There is no second process holding state.

## The four ways into Lyra's data

This table is the thing this repo most needed and did not have. Each row is a different trust
model, and they are easy to confuse because three of them involve a model.

| Entry point | Direction | Auth | Can write? | Reaches |
|---|---|---|---|---|
| **React SPA** → `lyra-api` | request/response | JWT, PIN login | yes, everything | every route |
| **`lyra-mcp`** → SQLite | a client launches it as a child process | no JWT — it is a child process, and it pins the wallets and the owner by env | **one table**: `analyses`, via `save_analysis` | both halves: ten wealth tools and seven life tools |
| **Telegram** → `tgbot.rs` | long poll, inbound | the pinned `TELEGRAM_CHAT_ID`, and nothing else | **two of eighteen commands**: `/retry` and `/cancel` move a job | the wealth half, your agenda, and the queue |
| **`lyra-alerts`** → Telegram, Discord | outbound only | the bot token / the webhook URL | n/a | nothing; it only speaks |

Two things follow from reading it as a whole:

- **The life-OS half is readable from outside the browser and still not writable from it.** A phone
  can ask `/today` and an MCP client can call `get_agenda`, so a task is no longer invisible outside
  the tab; but nothing out there can create or close one. The capture grammar Telegram accepts
  (`!call the accountant @Accounts`) parses the line and echoes what it *would* become, deliberately
  writing nothing — see [the assistant roadmap](./assistant-roadmap.md).
- **`TELEGRAM_CHAT_ID` is already an authorization boundary, not only a spam filter.** `/cancel`
  drops a queued job and `/retry` enqueues one, so the check now stands between a stranger and the
  box's work, not merely between a stranger and a balance. See
  [`docs/telegram.md` §3](./telegram.md).

## Where inference happens

**In the browser. Only in the browser.** `src/core/ai/ai-client.ts:33` is the single place a model
is called, and it runs in the page.

So a Telegram command that needs natural language cannot be served at all, however the command
table grows, and an LLM job would sit unrun until a browser tab happened to be open. This is the
hardest constraint on "command it from Telegram" and it is a deliberate decision to leave in place
for now — see [D2](./assistant-roadmap.md).

## Components

### The SPA

React 19, TypeScript, Vite, Tailwind, shadcn/ui. Zustand for client state, TanStack Query for
server state.

Data comes from `ApiRepository` against `lyra-api`, or `LocalRepository` on browser storage in demo
mode. **Which one is live is a single session-wide decision** (`lyra:data-mode`), so the app can
never show demo entities next to real balances.

All data access goes through `IRepository<T>` — `getAll`, `getById`, `create`, `update`, `delete`,
`query` — which is what made swapping the backend a configuration change rather than a rewrite.
Filtering, `type=` scoping and pagination are now pushed to the server where the interface allows;
`useEntities` asks the API rather than pulling every row to fill a dropdown.

### `lyra-api` — one binary that owns the database

`axum` + `sqlx` over SQLite in WAL. No ORM; forward-only SQL migrations applied at startup from a
list in `lyra-db/src/migrations.rs`.

It serves CRUD for entities, trackers, schedules and relations; git-backed knowledge notes; Google
Calendar; the whole wealth surface; and the fleet and queue routes the Agents page reads
(`/api/agents`, `/api/jobs`, and `retry`/`cancel` on one job). It also runs **in-process**: the chain
fan-out, so upstream caches are shared with the request path and an alert can never disagree with the
page it points at; the alert sweep; the Telegram poll loop; and the four job workers.

See [`docs/api-server.md`](./api-server.md).

### `lyra-mcp` — a second reader, not a service

A separate stdio binary an MCP client launches as a child. Seventeen tools — ten wealth, seven life —
reading the same SQLite file. It cannot sign by construction: there is no signing path in the crate
and no `Sign` rung on the capability ladder, it refuses to boot with signing material in its
environment, and secrets are scrubbed on egress. `save_analysis` is the one tool that writes, and a
test asserts it is still the only writer on the wealth half. See [`docs/mcp.md`](./mcp.md).

### `lyra-alerts` — outbound

Pure rules (readings + previous state in, alerts + new state out), a digest builder, and a
`Channels` fan-out to Telegram and Discord where any channel succeeding counts as delivered. See
[`docs/alerts.md`](./alerts.md).

## Background work today

Two hand-rolled poll loops, and a queue underneath them:

| Loop | Cadence | Recovers from a crash by |
|---|---|---|
| `alert_loop.rs` | `ALERT_INTERVAL`, default 900s | re-reading `alert_state`; latches make a replay idempotent |
| `tgbot.rs` | 25s long poll | re-reading `tgbot:offset`, acked *after* the reply — so at most one command re-runs |
| job workers | claim loop, 250ms–5s idle backoff | re-claiming: a lease that expires is reaped and the job runs again |

**There is a job queue.** `jobs` and `job_effects` are tables in `lyra-db/src/migrations.rs`, the
store is `lyra-db/src/jobs.rs`, and the worker runtime is `lyra-api/src/jobs/`. A job carries a
payload, an attempt count against `max_attempts`, an exponential backoff, an optional idempotency
key and a lease held by a named worker — so work in flight when the process dies is picked up rather
than lost, and a handler that already sent a message records that in `job_effects` so the retry does
not send it twice. Four workers run, split by lane (two `interactive`, one `batch`, one `deliver`);
the split is isolation, not throughput — a ten-minute import must not sit in front of an answer
someone is waiting on. Four kinds are registered: `deliver.telegram`, `digest.daily`,
`snapshot.networth` and `schedule.tick`. `LYRA_JOBS=off` disables the workers. See
[`docs/jobs.md`](./jobs.md).

This is why a Telegram outage at digest hour no longer costs the day's brief. `maybe_digest` decides
the brief is *due* and enqueues `digest.daily` under the key `digest.daily:<day>`; the job's own
backoff carries past the digest hour, and the day key is stamped by the handler, so the flag and the
send cannot disagree.

`schedules` is **not** the queue and must not be made into one — see
[`docs/core-engine.md`](./core-engine.md). The bridge runs one way: `schedule.tick` reads
`schedules` and enqueues jobs, and `schedules` never learns the queue exists.

## Authentication

- **SPA**: PIN login, JWT, persisted via Zustand. Every life-OS handler scopes by `user.user_id`
  from the token.
- **`lyra-mcp`**: no JWT. It is a child process of a client the user launched, so instead it resolves
  one owner at boot — `LYRA_MCP_OWNER`, or the only user there is — and holds it in the store rather
  than in a tool argument. No life tool takes an `owner` field, so there is no string to guess; a
  test walks every life tool's schema and fails on an argument whose name contains "owner" or "user".
- **Telegram**: the pinned chat id, checked before anything runs.
- **`/api/search`**: unauthenticated on purpose — a proxy with no user data behind it.

## Two gates that constrain every change

- **Parity.** `core/parity.toml` diffs the wealth endpoints against a Python oracle at 0.5%
  tolerance, whole bodies, only `fetched_at` ignored. **A gated response cannot grow a field.**
  When one needs to, the move is a new ungated route — the same move `vfat-status` made — not a
  widened one. `alerts/test` and `alerts/digest` are excluded because a GET on either sends a real
  message. See [`docs/parity.md`](./parity.md).
- **Budget.** The frontend is 335 tests passing / 11 skipped, `tsc` clean, and **exactly 59 lint
  problems** — all pre-existing. Those numbers mean something only while they do not move.

## Deployment

Docker Compose on the mini PC; nginx serves the built SPA and proxies `/api`. See
[`docs/deployment.md`](./deployment.md).
