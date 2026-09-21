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
  │                        ├─ tgbot poll      └────┬─────┘       │
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
| **`lyra-mcp`** → SQLite | a client launches it as a child process | none — it is a child process, and it pins wallets by env | **one table**: `analyses`, via `save_analysis` | the wealth half only |
| **Telegram** → `tgbot.rs` | long poll, inbound | the pinned `TELEGRAM_CHAT_ID`, and nothing else | **no** — all eleven commands are reads | the wealth half only |
| **`lyra-alerts`** → Telegram, Discord | outbound only | the bot token / the webhook URL | n/a | nothing; it only speaks |

Two things follow from reading it as a whole:

- **The life-OS half of the app is reachable only from the browser.** Nothing on a phone and no
  model outside the tab can see a task. That is the gap [the assistant roadmap](./assistant-roadmap.md)
  closes.
- **`TELEGRAM_CHAT_ID` is currently a spam filter and is about to become an authorization
  boundary.** See [`docs/telegram.md` §3](./telegram.md).

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
Calendar; and the whole wealth surface. It also runs **in-process**: the chain fan-out, so upstream
caches are shared with the request path and an alert can never disagree with the page it points at;
the alert sweep; and the Telegram poll loop.

See [`docs/api-server.md`](./api-server.md).

### `lyra-mcp` — a second reader, not a service

A separate stdio binary an MCP client launches as a child. It reads the same SQLite file and is
read-only by construction: no signing path exists in the crate, it refuses to boot with signing
material in its environment, secrets are scrubbed on egress, and a test asserts exactly one tool
writes. See [`docs/mcp.md`](./mcp.md).

### `lyra-alerts` — outbound

Pure rules (readings + previous state in, alerts + new state out), a digest builder, and a
`Channels` fan-out to Telegram and Discord where any channel succeeding counts as delivered. See
[`docs/alerts.md`](./alerts.md).

## Background work today

Two hand-rolled poll loops, and nothing else:

| Loop | Cadence | Recovers from a crash by |
|---|---|---|
| `alert_loop.rs` | `ALERT_INTERVAL`, default 900s | re-reading `alert_state`; latches make a replay idempotent |
| `tgbot.rs` | 25s long poll | re-reading `tgbot:offset`, acked *after* the reply — so at most one command re-runs |

**There is no job queue.** No durable work item, no retry, no backoff, no crash recovery for work
that was in flight. A Telegram outage at digest hour costs the day's brief silently, because
`maybe_digest` swallows the error and the day key is only written on success.

`schedules` is **not** the queue and must not be made into one — see
[`docs/core-engine.md`](./core-engine.md). The queue's design is in
[the roadmap](./assistant-roadmap.md), Stage A3 and D.

## Authentication

- **SPA**: PIN login, JWT, persisted via Zustand. Every life-OS handler scopes by `user.user_id`
  from the token.
- **`lyra-mcp`**: none. It is a child process of a client the user launched, and it has no JWT —
  which is why it has no way to scope entity reads today, and why the roadmap gives it a pinned
  owner before it gets a single life-OS tool.
- **Telegram**: the pinned chat id, checked before anything runs.
- **`/api/search`**: unauthenticated on purpose — a proxy with no user data behind it.

## Two gates that constrain every change

- **Parity.** `core/parity.toml` diffs the wealth endpoints against a Python oracle at 0.5%
  tolerance, whole bodies, only `fetched_at` ignored. **A gated response cannot grow a field.**
  When one needs to, the move is a new ungated route — the same move `vfat-status` made — not a
  widened one. `alerts/test` and `alerts/digest` are excluded because a GET on either sends a real
  message. See [`docs/parity.md`](./parity.md).
- **Budget.** The frontend is 298 tests passing / 11 skipped, `tsc` clean, and **exactly 59 lint
  problems** — all pre-existing. Those numbers mean something only while they do not move.

## Deployment

Docker Compose on the mini PC; nginx serves the built SPA and proxies `/api`. See
[`docs/deployment.md`](./deployment.md).
