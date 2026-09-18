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
| `/api/wealth/*` | Portfolio, LP positions, borrows, bots, market data, yield discovery, upstream freshness, the analysis journal, alert config | JWT |
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

## Routes that are not a port — 2026-09-17

Two routes under `/api/wealth/` have no Python counterpart, and that is the point: they answer
questions `server.py` was never asked. Both read vfat's v4 API, which `adapters/vfat.rs` already
talks to — the [vfat MCP server](https://vfat.io/mcp) wraps that same API rather than exposing
anything new, so nothing here speaks MCP at runtime. It was used to *find* these endpoints, which
is what its `search_vfat_api` / `get_vfat_api_operation` tools are for.

| Route | What | Why it is not on an existing route |
|---|---|---|
| `GET /api/wealth/vfat-status` | How far behind vfat's own aggregation is, per chain, worst first | `/api/wealth/services` is parity-gated, and it answers "reachable or not" — which is not the failure mode |
| `GET /api/wealth/opportunities` | Pools matching a filter set, whether or not a wallet holds them | `/api/wealth/yield-radar` is parity-gated, and it is *defined* by what the wallet holds |

**`vfat-status` names a failure the code could only survive.** Farm-balances answers HTTP 200 with
data that is quietly hours old, which is why `LAST_GOOD_MAX_AGE_SECS` exists — a last-good shield
that could never say *how* stale. `/v4/aggregation-delay` can. The response carries `checked:
false` when the endpoint itself could not be read, because "we could not check" and "every chain is
current" both render as an empty list and mean opposite things. It takes the radar's staleness
posture rather than farm-balances': no last-good shield, failures not cached. A freshness report
that vouches for data it never saw is worse than none.

**`opportunities` is the complement to the radar, not a replacement.** The radar reads the wallet's
farm balances and only suggests pools beating the APR already earned, capped at 6 and floored at
50% APR. That is right for "should I move?" and useless for "what exists?" — a wallet holding
nothing correctly gets nothing from it. This route never consults a wallet. Filters are validated
against what vfat documents, so a typo is a 400 naming the accepted values rather than an empty
board that looks like an answer.

Each row also reports what pays its APR — `swapFees`, `staking`, `offChainRewards` — from the
`aprBasis` that rides on options the feed already returns, so the breakdown costs no extra request.
Two pools quoting 80% are not the same pool when one is emissions and the other is fees. vfat quotes
every APR `assumesFullTimeInRange`, and live rows declare a 7-day fee window with as little as 1.04
days actually behind it; both caveats are surfaced rather than smoothed over.

Three constraints worth carrying forward:

1. **Chain sets go in one request.** `chains=<comma-separated ids>` takes the whole set where
   `chainId=` took one each — a seven-chain board went from seven round trips at 8.07s to one at
   ~1.6s. Ids only: `chains=base,ethereum` came back carrying chain 999, so the name form does not
   filter reliably, and the handler resolves names before the query is built.
2. **A TVL that is not in dollars is refused.** WETH/YFX on Base reports `totalLiquidity` around
   1.3e17 where every other pool reports USD. `TVL_CEILING` drops it; believing it would quote a
   pool at a hundred thousand trillion dollars.
3. **Gated responses cannot grow fields.** The four APR-provenance fields hang off the same
   `YieldOpportunity` the radar serves, so they are `skip_serializing_if`-absent and a test asserts
   they serialise away on that path. See [parity §Adding an endpoint](./parity.md#adding-an-endpoint).

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

## The Telegram command bot — 2026-08-22

`lyra-alerts` **pushes** alerts and the daily brief out; `tgbot.rs` **pulls** commands in. Both
halves existed in the Python (`notify.py` and `tgbot.py`); only the pushing half was ported, which
is why messaging the bot did nothing.

Long polling (`getUpdates`), not a webhook: a webhook needs a public HTTPS endpoint, and the point
of this box is that it sits behind a home router with nothing forwarded to it.

`/nw` `/tiers` `/positions` `/rewards` `/risk` `/sats` `/bots` `/market` `/digest` `/status`
`/help`, published to Telegram with `setMyCommands` at startup so the "/" menu offers them —
without that the bot looks inert even while it is listening.

**Only the pinned `TELEGRAM_CHAT_ID` is answered.** A bot token is a URL anyone holding it can
message; the chat id is what makes the bot yours. Anything from another chat is counted and
dropped — never answered, because a reply confirms the bot exists, and never echoed, because that
would put a stranger's text in front of the owner. Position names are attacker-controlled on-chain
data, so every label is stripped of control characters and capped before it goes into a message.

The update offset is acknowledged **after** the reply is sent and stored in `alert_state`, so a
restart mid-command re-runs at most that one command instead of replaying the backlog. A poll
handles at most five commands, because after an outage Telegram returns everything queued at once
and a week offline should not fire a week of portfolio reads back to back.

### A malformed URL fails exactly like an outage

The first version of `poll` built its URL with a `\`-continuation and shipped nine literal spaces
in the path — `getUpdates%20%20%20…?timeout=`. Every poll failed for a day while messages queued
unread, and the log said `error sending request`, which is what a network problem says too. The
URL is built by `updates_url`, on one line, with a test asserting it contains no space and that
the query starts immediately after the method name.

Related, and worse: `reqwest::Error` renders the URL it failed on, and that URL carries the bot
token — so every transient blip wrote the secret into `~/Library/Logs/lyra/server.log` in plain
text. Both call sites now log `e.without_url()`. **If a log from before 2026-08-23 was ever copied
off this machine, rotate the token with @BotFather.**

**Do not call `getUpdates` by hand while the bot is running.** Telegram allows one consumer, and a
manual call consumes the update the bot was waiting for — the message then never reaches it.
