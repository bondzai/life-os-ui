# Parity harness

The gate for the Rust port. `wallet-portfolio/` (Python) is the oracle; `core/` (Rust) is the port.
An endpoint counts as ported when `make parity` is green for it — not when it compiles, and not when
it looks right in the UI.

This exists because the port moves money code — Uniswap v3/v4 tick math, uncollected-fee accounting,
spam filtering, price-confidence gates — where a wrong answer looks exactly like a right one.

## Running it

```bash
make oracle     # terminal 1 — Python on :8000
make dev-api    # terminal 2 — Rust on :3001  (once lyra-api exists)
make parity     # terminal 3
```

`make parity` exits 0 when green, 1 when not, so it drops into CI as-is. With no endpoints
configured it prints `no endpoints configured` and exits 0 — the gate was built before there was
anything to gate.

Useful flags: `--only portfolio` (one endpoint), `--tolerance 0.001` (tighten), `--allow-extra`
(permit fields the Rust side adds), `--max-report 50`.

## What counts as "the same answer"

Configured in `core/parity.toml`, implemented in `core/crates/lyra-parity/src/diff.rs`.

| Rule | Why |
|---|---|
| **Keys are exact.** A field Python returns and Rust does not is a hard failure. | This is the failure this harness exists for: a dropped LP position or a missing metric, which otherwise just looks like a slightly smaller net worth. |
| **Floats get 0.5% relative tolerance.** | Money crosses `float` → `Decimal`/`U256` in the port. Small drift is expected and not interesting. |
| **Integers get no tolerance at all.** | Integers here are *identities* — `tokenId`, `tick`, `decimals`, `chainId`, epoch stamps. "Within 0.5%" of a `tokenId` is a different position. |
| **Arrays pair by identity** (`id`, `tokenId`, `address`, `symbol`, `name`), falling back to index order. | Both sides fan out concurrently, so array order carries no meaning. Index-wise comparison would produce noise, and a noisy gate gets ignored. |
| **Fields only in Rust also fail**, unless `--allow-extra`. | Catches a response envelope that quietly drifted from the contract. |

Duplicate identity values within an array disable identity pairing for that array — pairing would be
arbitrary, which is worse than comparing by index.

## A float that is a timestamp is not really being compared

The 0.5% relative tolerance is calibrated for money. Applied to a Unix epoch it is meaningless:
0.5% of `1_787_044_207` is about **8.9 million seconds — 103 days** of slack. Two `last_check`
stamps 612 seconds apart sailed through the gate as a match.

Integers are exempt from tolerance and compare exactly, so an epoch **integer** (`cycle_start`,
`ts`, a history point's `d`) is genuinely checked. It is only epoch-seconds *floats* — Python's
`time.time()` — that slip through. There are two on this surface, `fetched_at` and `last_check`,
and both are now on ignore lists. That is the honest outcome: an ignored field is visibly
unchecked, where a passing comparison on a 103-day tolerance looked like verification and was not.

If a timestamp float ever needs real checking, it wants an absolute bound rather than a relative
one — the config has `abs_epsilon`, but `diff.rs` uses it only as a near-zero guard.

## A difference of near-equal numbers amplifies the tolerance

`range_pct.min` came in at -7.0953 (Python) vs -7.1325 (Rust) — 0.521%, just past tolerance, and it
looked like a tick-math bug. It is not.

`range_pct` is derived: `min = (lower - cur) / cur * 100`, over `price_band`'s own fields. Working
backwards from the two answers, the implied `lower / cur` ratios agree to **0.0400%** — well inside
tolerance. Because `lower` sits about 7% below `cur`, the subtraction `lower - cur` cancels away
93% of the magnitude and amplifies the relative error by **13.1×**. 0.04% in, 0.52% out.

Nothing is lost by the flag: `price_band.lower`, `.upper` and `.cur` are all compared by the same
gate and all pass. `range_pct` is a pure function of them, so its inputs *are* verified — which is
why this is left compared rather than ignored. A wrong tick calculation would still move
`price_band`, and that is the thing to look at.

**Triage rule:** if `range_pct` is the only field flagged on a position and its `price_band` is
green, it is amplification, not a defect. If `price_band` is flagged too, it is real.

The general shape is worth remembering: any field defined as the difference of two nearly-equal
quantities carries an amplification factor of roughly `|a| / |a - b|`, and a flat relative tolerance
does not fit it.

## The ignore list is a hole in the gate

Every entry in `ignore` is a field nobody is checking. Add one only after confirming in source that
it is genuinely non-deterministic. Currently there is exactly one:

- `fetched_at` — `time.time()` in `build_portfolios` (`portfolio.py:2413`) and `market_sentiment`
  (`portfolio.py:2354`).

Syntax: a bare name (`fetched_at`) ignores that field at any depth; anything with a `.` or `[`
(`$.positions[].fees_usd`) matches the full path with array subscripts normalised away.

## Two hazards to know about

**Partial oracle responses.** `build_portfolios` fans out across every (wallet × chain) pair under a
75-second `REQUEST_DEADLINE` (`portfolio.py:2387`) and returns **partial results** when it expires,
printing `(request deadline hit; returning partial results)` to stderr. A partial oracle response
shows up here as *extra in rust* on whatever Python failed to fetch — the report inverts. If a run
produces a burst of unexplained mismatches, check the oracle's stderr before touching the Rust code.

**Live chain data.** Both sides read the chain at slightly different moments, so a real balance
change mid-run reads as drift. For anything subtler than a few percent, re-run before investigating.
Phase 0's remaining piece — an upstream record/replay cache in `lyra-chain`, so both sides can be
pinned to the same recorded upstream responses — removes this class of noise entirely and is
required before the adapter ports in Phase 3.

## Differential tests for pure functions

Endpoint parity needs both servers running. Pure functions don't — they can be compared
exhaustively, offline, with no flakiness. `lyra-chain/tests/spam_parity.rs` does this for the spam
filter: a corpus generated by `portfolio._is_spam` itself, 3,255 combinations of symbol × name ×
reputation, asserted case-for-case against the Rust port.

Regenerate the corpus after any change to the Python filter:

```bash
cd wallet-portfolio
.venv/bin/python - > ../lyra/core/crates/lyra-chain/tests/spam_corpus.json <<'PY'
import json, itertools, sys
sys.path.insert(0, '.')
import portfolio

symbols = ["ETH","USDC","WBTC","cbBTC","AERO","","TKN","ABCDEFGHIJKLMNOPQRST",
           "ABCDEFGHIJKLMNOPQRSTU","RATIO","ORG","$FREE","xn--","BTC.B","stETH"]
names = ["Ether","USD Coin","Wrapped Bitcoin","Visit https://claim.xyz","www.airdrop.io",
         "t.me/chan","Claim your reward","AIRDROP 2026","Voucher","Giveaway!","Rewards",
         "🎁 open","💰 money","go → here","Ratio Finance","Organic Growth","",
         "Aerodrome Finance","reward","rewarding","organ","ratio.io","my.app","node.live",
         "a.cc","x.vip","$ 100","visit us","Visitor Pass","proclaim","disclaimer"]
reps = [None, "", "ok", "SPAM", "scam", "Spam", "unknown"]

rows = [{"symbol": s, "name": n, "reputation": r,
         "spam": bool(portfolio._is_spam({"symbol": s, "name": n, "reputation": r}))}
        for s, n, r in itertools.product(symbols, names, reps)]
json.dump({"min_confidence": portfolio.MIN_CONFIDENCE, "cases": rows}, sys.stdout)
PY
```

The corpus deliberately includes word-boundary near-misses (`ratio` vs `.io`, `organic` vs `.org`,
`proclaim`/`disclaimer` vs `claim`, `Visitor` vs `visit `) — those are where a hand-rewritten regex
diverges first. Keep both verdicts well represented; an all-spam corpus passes while testing nothing.

Use the same shape for the LP maths in Phase 3: generate expected values from the Python for a set
of known positions, and assert against them offline.

## Adding an endpoint

`core/parity.toml` carries a commented block for every endpoint, grouped by phase, with paths taken
from `server.py:139-379`. Uncomment as each lands. Wallet addresses and the Rust JWT come from the
environment via `${VAR}` so nothing secret is committed:

```bash
export LYRA_PARITY_WALLETS="0xabc...,bc1q..."
export LYRA_PARITY_JWT="$(...)"
```

The full set the current `parity.toml` reads:

```bash
export LYRA_PARITY_WALLETS="$ALERT_WALLETS"        # from wallet-portfolio/.env.local
export LYRA_PARITY_WALLET="${LYRA_PARITY_WALLETS%%,*}"
export LYRA_PARITY_FUND='K-GOLD-A(D)'              # web/src/lib/store.ts:448
export LYRA_PARITY_GROUP=server
export LYRA_PARITY_JWT="$(curl -s -X POST localhost:3001/api/auth/login \
    -H 'Content-Type: application/json' -d '{"pin":"…"}' | jq -r .token)"
```

Every referenced variable must be set even when `--only` names one endpoint: expansion happens when
the config loads, before the filter runs. An unset one is a hard error, never an empty string.

## First live run — 2026-08-18

The gate ran against real wallets for the first time. Twelve endpoints; **nine green**, and the
three failures were each a real gap rather than a tolerance argument. Both servers were restarted
mid-session to prove the findings survived a cold cache.

Fixed as a direct result:

1. **The harness expanded `${VAR}` in the bases and headers but not in endpoint paths.** The
   portfolio, wallet and yield-radar endpoints were requesting a literal `${LYRA_PARITY_WALLETS}`,
   and both servers answered the same `400 invalid address`. Here that surfaced as a failure, but
   the shape is the false green `parity.toml` warns about: identical nonsense in, identical answer
   out, nothing compared. Fixed in `config.rs`, with two regression tests.
2. **The service board's probes were unbounded** (`lyra-api/src/wealth.rs`). `services.py` gives
   every probe an 8s ceiling; the port declared `PROBE_TIMEOUT` but applied it only to Telegram —
   every other probe went through `reqwest::Client::new()`, which has no timeout at all. A hung
   `vfat farm-balances` read `down` at 8083ms in Python and `slow` at 19723ms here. Probes now use
   a client built with `PROBE_TIMEOUT`.
3. **Thai fund NAV always returned `null`.** `wealthmagik_client()` — which exists precisely to
   carry the `clientId` header WealthMagik requires — was never called; `Market::get_json` used the
   plain client, so both calls got `401 "CLIENT ID INVALID"` and the `Option` chain collapsed to
   `None`. `Market` now holds a dedicated WealthMagik client. The headers stay off the default
   client on purpose: they claim to be wealthmagik.com, which has no business going to DefiLlama.

Still open, both pre-existing and both now measured rather than assumed:

- ~~**`_vfat_stamp_lifecycle` is not ported**~~ — **ported the same day.** See below.
- ~~**The notify scheduler is not ported.**~~ — **ported the same day.** See below.

Two things that look like failures and are not:

- **`snapshots` showed `python=3 rust=0`** — the cron had written three rows since the Aug 14
  migration. Re-running `lyra-migrate` imported exactly those three (and 5 `pos_perf` rows) and the
  endpoint went green, which also confirms the importer is genuinely incremental against live data.
  Take the source with `sqlite3 pow.db ".backup copy.db"` rather than `cp` while the oracle is up.
- **KuCoin bot PnL drifts ~1%** — the figure is an unrealized PnL of about -$1.08 on a live futures
  bot, so a one-cent move is 0.9%. Small absolute values amplify relative drift; re-runs disagree in
  both directions, which is what noise looks like.

One marginal case, since resolved: `range_pct.min` at 0.521% turned out to be tolerance
amplification through a difference of near-equal numbers, not a tick-math defect. See "A difference
of near-equal numbers amplifies the tolerance" above.

## `_vfat_stamp_lifecycle`, ported — 2026-08-18

The gap the first run measured is closed. `/wallet` went from **37 mismatches over 270 compared
values to 6 over 305**, and `/portfolio` from 38/278 to 6/337 — the extra compared values are the
newly-present fields agreeing. Five of the six lifecycle fields now match exactly on every position:
`deployed_at`, `updated_at`, `last_action`, `last_harvest_at`, `cycle_start`, `perf_key`.

Where it lives:

- `VfatApi::nft_actions` — `_vfat_nft_actions`, with its own 600s cache keyed
  `vfatact:<chainId>:<sickle>:<tokenId>`. Every miss is `[]`, never an error, because a position
  whose history we cannot read must still render with its balance.
- `vfat::stamp_lifecycle` — the pure stamping half, including the harvest-cycle anchor. The
  `Nullable` fields matter here: Python writes the key with a `null` when an action has no
  timestamp, and dropping the key instead would be a visible contract change.
- `vfat::stamp_lifecycle_all` — the concurrent pass, capped at 6 like Python's `ThreadPoolExecutor`,
  called at the tail of **both** `enrich` and `adapt_vfat_api` as in the Python.
- `vfat::apply_perf` + `lyra_db::wealth::perf_records` — the `pos_perf` join, split across the crate
  boundary because `lyra-chain` holds no database handle. That makes it one query per portfolio
  where Python issues one per chain. `cycle_start` is `setdefault`, not assignment: an anchor from
  the action history wins, and the cron's value only fills in for a position whose history was
  unavailable. Backwards, it would silently re-anchor every position.

Verified by 12 new unit tests, 4 new `pos_perf` tests, and a new differential test
(`tests/lifecycle_parity.rs`) run against `tests/lifecycle_corpus.json`, generated by the Python's
own `_iso_epoch` and `position_perf.key`. That corpus is worth keeping: `perf_key` is a *contract
between two processes* — the alert loop writes rows under that string and every build reads them
back by it. A divergence would not error, it would just never match, and `in_range_secs` would be
quietly absent forever.

**One deliberate divergence, in `_iso_epoch`.** A timestamp with no timezone is read as UTC; Python
reads it as *local* time, because `datetime.timestamp()` on a naive datetime applies the host's
zone — so the oracle's own answer depends on which machine it runs on (7h apart on the development
box, which sits at UTC+7). vfat stamps every `blockTimestamp` with `Z`, so nothing real reaches that
branch. The corpus skips exactly that case and asserts the other 29.

### What is left on these two endpoints

All six residual mismatches are `in_range_secs`, and all six have one cause: **`pos_perf` has no
writer on the Rust side.** The counter is accumulated by the notify cron, which is the piece still
missing — so the Rust column can only ever be as fresh as the last `lyra-migrate` run, and a
position the cron started sampling afterwards (`8453:2925479`) has no row at all. Note that
`lyra-migrate` cannot refresh these: the import is `INSERT OR IGNORE`, so an existing key keeps its
stale value. It is an importer, not a syncer — correct for a one-time migration, and a trap if you
reach for it expecting a sync.

Porting the scheduler closes this and the `alerts` endpoint together.

## The notify scheduler, ported — 2026-08-18

`lyra-alerts` held every decision — `rules::evaluate`, `digest`, `AlertStore` — and nothing drove
them on a clock. `lyra-api/src/alert_loop.rs` is that driver and nothing more; no rule lives in it.
It runs in-process as a `tokio` task beside the HTTP server, the way `server.py` starts
`notify.start()`, which is what lets `/api/wealth/alerts` answer `running: true` truthfully.

One tick: **sweep** (build each watched wallet, evaluate, send what fired, save the latches, sample
each LP's in-range state into `pos_perf`) → **digest** (if the hour has come round and today's has
not gone out) → **snapshot** (if `SNAPSHOT_INTERVAL` has elapsed).

`/alerts` went from 4 mismatches to 1, and the last one is ignored rather than fixed: `running` and
`watching` now match the oracle exactly (`true`, `6`), while `last_error` is per-process history —
the oracle's is a stale `tgbot getUpdates` reset from a long-poll bot the Rust port does not run.

Verified live against the real wallet: the loop announced itself, swept, reported
`running: true / watching: 6 / last_error: null`, and wrote all six `pos_perf` rows. No Telegram
message was sent — `alert_state` starts empty so the first sweep baselines every position silently,
and `DIGEST_HOUR` is unset.

### Three things worth knowing

**`record_perf_samples` is the only writer of `pos_perf`.** A second one would double-count. Its
edge cases are where the bugs would be, so they are tested directly: an outage is capped at
`MAX_SAMPLE_GAP_SECS` rather than credited in full, a backwards clock credits nothing, and an
out-of-range position still advances `last_sample_ts` — without that last one the next in-range
tick would credit the whole idle stretch as earning time.

**A never-harvested position must sample an empty anchor, not a null.** A `NULL` `harvest_anchor`
reading back as anything other than `""` would make every sweep look like a fresh harvest, so the
counter would sit at zero forever — silently, since nothing errors.

**Snapshots are gated on `FetchHealth::is_complete`.** The Python has no such check because it
cannot tell a partial read from a small one. `aggregate`'s own docs ask callers persisting to
history to gate on this, and a snapshot is exactly that: a partial total stored in the net-worth
series is indistinguishable from a real drawdown forever after, and skews every figure derived from
it. A gap in the series is recoverable; a false point is not.

### One divergence found by running it

The first live sweep sampled five of six positions. The sixth had had its `sickle-nft-actions` call
fail on that tick, so `stamp_lifecycle` left `cycle_start` unset — and the sampling gate
(`if d.get("cycle_start") is not None and d.get("perf_key")`) dropped it, freezing its accumulator.

Python does not have this hole: its `pos_perf` join runs *inside* `_vfat_stamp_lifecycle`, so
`check_once` sees the stored `cycle_start`. This port had moved the join out to the HTTP handlers
to keep SQL out of `lyra-chain`, which left the sweep blind to it. `build_watched_wallet` now runs
the join too. Re-verified live: all six rows sampled, and the stalled position caught up its gap.

## `_attach_campaign_rewards` / `_merkl_rewards`, ported — 2026-08-18

The last functional gap from the Python is closed. Both halves are in `vfat.rs`:

- **Merkl** (`VfatApi::merkl_rewards`, cached 120s per Sickle) — attribution hangs on the `reason`
  field's `<PROTOCOL>_<pool>_<tokenId>` tail, which is what makes per-position rewards possible at
  all; vfat's own `offChainRewards` blob is wallet-level. `amount - claimed` is what is still
  claimable, and the same token across breakdown rows is merged into one line.
- **Nest** (`nest_entry` + `distribute_nest`) — Nest signs **one** claim per Sickle for all that
  wallet's Nest positions, so vfat reports the identical total on every one of them. The split is
  by live accrual rate (campaign emission × rewarded/pool-liquidity share × the position's own
  liquidity), which gives each position a distinct share that still sums back to the real claimable
  total. Equal split when no live rate is available.

Two guards carry the correctness, and both are tested: a claim is only counted for a position whose
own `farm.offChainRewards` lists that campaign (the wallet-level figure appears on positions that
never earned it), and a `nestClaim: false` entry is skipped because the Merkl API reports the same
reward — counting both would double it.

The two tail passes run over **different pair sets** in `enrich`, which is easy to get wrong:
lifecycle covers every matched position, campaign rewards only the farms that pass appended. An
RPC-read position already carries its rewards from the adapter that read it.

None of this moves a position's `usd`. What it fixes is an understated *claimable* figure.

## Cutover state — 2026-08-18

**Secrets migrated.** `wallet-portfolio/.env.local` was the only copy on disk of `ALERT_WALLETS`,
the KuCoin key/secret/passphrase and the Telegram token — it is gitignored there, so deleting that
directory would have destroyed the running system's configuration. It now lives at
`lyra/.env.local` (mode 600, covered by `.gitignore:13`), and the names are documented in
`.env.example`. Verified by running the API entirely from the new file: the KuCoin endpoint
returned a live balance, so the migrated key works.

With that done, `wallet-portfolio/` is no longer load-bearing. Its tree is clean and it has a
remote (`git@github.com:bondzai/wallet-portfolio.git`), so the directory is re-clonable — but a
re-clone will **not** restore `.env.local`, which is exactly why the migration had to come first.

**Route sweep, all green.** Every route registered in `main.rs`, against the migrated database:
21 endpoints plus the auth gate. Includes the contract details the client depends on — 404 on a
missing entity (which is what `getById` uses to return `undefined`), 401 on every protected route
without a token, and the documented 400 from `/alerts/test` and `/alerts/digest` when Telegram is
unconfigured. CORS preflight from the dev origin echoes it with credentials.

One apparent failure was not one: `/api/knowledge` 404s because it resolves `../lyra-knowledge`,
which does not exist here — and the Hono route resolves to the identical path, so it would 404
too. Contract-identical. Point `LYRA_KNOWLEDGE_PATH` at `dev-knowledge/` and it returns content.

**Front end.** `tsc -b` clean, production bundle builds, 184 unit tests pass, and all 21 page
modules transform through Vite without error against the running Rust API.

**Still needs a human.** The plan gates deleting `api/` on a real click-through in a browser, and
no browser automation was available in this session. The automated checks above cover the
data-layer contract, not rendering. See the handoff checklist in the session notes.

## Front end on live data — 2026-08-19

The wealth surfaces were rendering `mockWealthSource` the whole time — `use-wealth.ts` carried a
hardcoded `USE_MOCK_DATA = true`. Every automated check up to this point (page transforms, `tsc`,
the route sweep) passed against that, so "the UI works" meant the mock worked. The switch is gone:
`WEALTH_SOURCE` now follows the app-wide data mode (`lyra:data-mode`, else `VITE_USE_API`), the
same one the entity repositories use. A demo session and a live session can no longer disagree
about which of them is showing real money.

Two surfaces read the API directly rather than through that seam, because there is nothing
sensible to mock: Journal (analyses the AI layer actually wrote) and Alerts (server state — sweep
interval, Telegram wiring). Both now skip the request in a demo session and say why, instead of
rendering an error from a backend that was never meant to be there.

The render tests still run on the mock, which is the point of the seam: `localStorage` has no
`lyra:data-mode` under jsdom and `VITE_USE_API` is unset, so `USE_API` is false in tests.

## Phase 7 surfaces, complete — 2026-08-19

The last of the Python `web/src/surfaces/` list is ported. BTC, Bots, Journal, Alerts (Settings),
Borrowing and Cashflow (Harvest) landed as pages and panels; **Snowball** closes the set.

Snowball is the one surface with no server side at all: it is a hand-tagged basket cutting across
wallets, LPs, bots and off-chain assets, and both the tags and its daily climb series live in
`localStorage`. Ported deliberately rather than transliterated:

- Tag ids are built by `lpKey`/`botKey` — the same functions that build the row keys — so a tag
  cannot drift away from the position it points at. This is why those two are exported.
- A wallet tagged whole **swallows its own positions**, since `wallet.total` already contains
  them. Tested; the naive version inflates the basket by whatever share is deployed.
- Sub-bots are not tagged individually (the original allowed it). Lyra's Bots page presents a
  futures strategy as one row, so it is tagged as one row.
- `btcUsd` uses the BTC page's wrapper-aware `isBtcSymbol`, where the original counted only
  literal `BTC`. Same question, better answer: redeeming cbBTC gives you bitcoin.
- The panel does **not** hide itself when nothing is tagged, which the original did. The ❄ toggles
  live on DeFi and Bots, so a book holding only a wallet and off-chain assets could never have
  found the feature. It collapses to one line plus a source picker instead.

## `lyra-mcp` wired to real data — 2026-08-19

Phase 6 was recorded as "DONE (unverified)". It was not done. The crate had the JSON-RPC server,
all ten tool bodies, the egress secret scrub and the read-only boot refusal with its tests — and
no way to run any of it:

- **no binary.** `lyra-mcp` was `lib.rs` only, so there was no executable for an MCP client to
  launch. "Never exercised" was not an oversight; it was not possible.
- **no production data.** The only implementors of `PortfolioSource` / `MarketSource` /
  `AnalysisStore` anywhere in the tree were the test fakes in `server.rs`.

Both are closed.

### `book.rs` — the walk

Port of `wallet-portfolio/analysis.py` L61-158: `holdings`, `lp_positions`, `lending_positions`,
`trading_bots`, and the spot/DeFi legs the exposure unwrap needs. `lyra-analytics` deliberately
owns no chain types ("the adapter maps the real portfolio onto it"), so this is the one file that
knows both shapes and the only place a field can be lost in translation.

Pure by construction — one `PortfolioSnapshot` in, one `Snapshot` out, no I/O and no clock — which
is what lets the oracle's rules be tested offline. The four that matter, each with a test:

- **A borrow line is never an asset row.** Its collateral is already counted as spot aTokens, so
  a holding row would double it; it comes back through `net_usd` instead. That `net_usd` is the
  engine's own figure, not a recomputation: Aave carries −debt, Compound and Morpho carry
  collateral−debt, and deriving it here would get one of the two families wrong by the collateral.
- **A DeFi row is classified by its first token, not its display name** — an ETH/USDC pool lands
  where an ETH holding lands.
- **Only an explicit `in_range: false` sorts to the front.** A position whose range could not be
  determined stays with the healthy ones rather than being paraded as broken.
- **Zero-value rows and zero-amount reward legs are dropped**, as the oracle does.

### `sources.rs` — the data room

Port of `pow_mcp/sources.py`, reading the same env names and defaults (`POW_WALLETS`,
`POW_MCP_TTL=120`, `POW_MCP_CACHE_MAX=32`, `POW_MCP_MAX_WALLETS=10`, `POW_MCP_RADAR_LIMIT=8`) so
one `.env` drives either implementation.

The bounded TTL+LRU snapshot cache is the load-bearing part. One analysis calls several tools, and
without it each would trigger its own multi-chain fan-out — the model would then reason across a
*drifting* book where two tools disagree because prices moved between them. Verified in the live
run below: seven tool calls, one `as_of`, one snapshot hash.

The journal writes to the same `analyses` table the HTTP API uses, with `source = "mcp"`. Sharing
it is the point: a review the desk writes has to appear in the Journal page, and one written in
the UI has to be readable by the model. Validation runs before the insert so a malformed scope
comes back as `InvalidInput` — something the model can fix — rather than `Unavailable`, which
reads as "try again later".

### `main.rs` — the entry point

Three refusals, each checked before a frame can be served, and each exercised:

1. **Signing material in the environment** → exit 1, naming the variable. Verified with
   `PRIVATE_KEY=…`.
2. **`MCP_TRANSPORT` other than stdio** → exit 1. The Python's v1 HTTP transport bound
   `allowed_hosts=['*']` with no auth, which served a full net worth to anyone with the URL; it
   stays fail-closed until remote auth exists. Verified with `MCP_TRANSPORT=http`.
3. **Logs go to stderr.** stdout *is* the protocol — one stray log line there is a corrupt frame
   and a dead session.

### The live run

Against the real wallets (`POW_WALLETS=$ALERT_WALLETS`), one stdio session, every tool:

| tool | result |
|---|---|
| `initialize` / `tools/list` | 10 tools, matching the Python's surface |
| `get_portfolio` | net worth $448.63, 14 holdings, 6 LP positions, 6 chains incl. KuCoin |
| `get_exposures` | HHI 0.219, top asset BTC 30.6%, stables 26.1% |
| `get_trading_bots` | the live futures bot with its sub-bot breakdown |
| `get_market_context` | rates + fear/greed + rainbow + MVRV |
| `get_fund_nav` | `K-GOLD-A(D)` at 16.5106 THB, dated |
| `list_opportunities` | empty board — no pool beat what the book already earns |
| `save_analysis` → `list_analyses` | written and read back, with a server-side anchor |

Every call in that session shared one `as_of` and one snapshot hash, which is the cache doing its
job rather than seven separate fan-outs.

### One unit bug found and fixed

`PortfolioHolding::change_24h` was documented as a fraction (`0.05 = +5%`) while the value it
feeds is emitted as `change_24h_pct` and the oracle supplies a percentage. A live book would have
reported a 3% day as `0.03%`. The field is now percent throughout, matching the engine and the key
name; the one unit test that encoded the old reading was corrected with it.

**Registering the desk** with an MCP client — `LYRA_DB` must point at the same database the API
uses, or the journal is a different journal:

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

## The cutover, checked against a running stack — 2026-08-19

The UI had never been pointed at the API. Everything green up to this point — 21 routes swept,
21 page modules transformed, `tsc -b` clean, 199 unit tests — was true of a front end reading
`mockWealthSource` and a back end nobody had asked for a page's worth of data. Putting the two
together found three breaks, none of which any of those checks could see:

1. **`getPortfolio()` sends no `?address=`, and the route answered 400.** The Python required an
   address on every call because its front end kept the wallet list in the browser; Lyra's does
   not. The route now falls back to `ALERT_WALLETS` — this is a single-user box whose wallets are
   already configured server-side, and a page asking "what am I worth" should not have to be told
   whose money to count. An explicit address still wins, so the parity gate is unaffected, and a
   *malformed* address is still a 400: the fallback covers "you did not say", never "you said
   something wrong".
2. **`getManualAssets()` called `wealth/manual-assets`, which does not exist** and never did.
   Off-chain assets are the one thing a keyless backend cannot know — `lyra-db`'s own header says
   so. They live in the browser, as they did in the original app, and the repository now reads
   them from there. This is why net worth can be lower here than on the device you typed them
   into.
3. **`getHistory()` typed the response as an array; the route returns `{group, points}`.** It
   degraded quietly to "not enough history" rather than throwing, which is the worst kind of
   wrong — a chart that renders, and lies by omission.

### `live-api.test.tsx`

A render test that mounts every wealth surface against the **running** API — real fetches, real
JSON, real component tree — skipped unless `LYRA_LIVE_API=1`:

```bash
LYRA_LIVE_API=1 npx vitest run src/pages/wealth/live-api.test.tsx
```

Eight tests, ~21s. It exists because the three bugs above were each invisible to a green suite:
`surfaces.test.tsx` proves the pages render *the mock*, and a route sweep proves the server
answers *its own* URLs. Only something that puts both halves together can catch a client asking
for a route that was never built.

One client is shared across the file, as the app does. A client per test refetched the portfolio
for every page — a real multi-chain fan-out each time, 128s of wall clock and a fetch storm
against live upstreams for no added coverage.

### What this does not cover

Pixels. No browser automation was available, so layout, styling, responsive behaviour and
anything that only shows up on a real paint remain unverified by eye. Everything underneath — the
data contract, the render tree, the error and empty states — now is.

### Observed while running

- **A cold portfolio read can drop KuCoin.** The first call after a restart logged
  `(kucoin skipped: timed out)` and returned one wallet at $368.87; warm calls return two at
  $448.71. That is the documented side-channel budget doing its job, and it is exactly the
  "a partial read looks like a complete one" hazard this file warns about — safe to display,
  not safe to record.
- **`/api/knowledge` 404s** unless `LYRA_KNOWLEDGE_PATH` points somewhere real. Contract-identical
  to the Hono route, which resolved the same missing path.

## The net-worth chart was reading a dead table — 2026-08-19

Found while checking what would be lost by deleting the oracle. Three separate things, each
individually invisible:

**1. The Python's database was never fully imported.** `pow.db` does not live in
`wallet-portfolio/` — `db.py` resolves it to `$POW_DB`, else `$HISTORY_DIR/pow.db`, else a path
under the system temp directory, which is where it actually was. Re-running `lyra-migrate`
against it imported **61 rows nothing had**: 57 daily net-worth points spanning 2026-06-12 to
2026-08-18, plus 4 snapshots. `nw_history` in `lyra.db` was **empty**.

Worth noting for anyone repeating this: the live database sat in a temp directory that macOS is
free to clean.

**2. Nothing writes `nw_history` any more.** The only writer was ever the old browser app POSTing
to `/history`; Lyra's front end has no such call. So the daily series the chart draws stopped
growing the day the port landed. `record_snapshot` now files a daily point in the same
transaction as the fine-grained snapshot — one per UTC day, last write wins, exactly what the
browser did. Two tests pin it.

**3. `/history` and `/snapshots` disagreed about the default group.** `/snapshots` defaulted to
the sweep's `SNAPSHOT_GROUP`; `/history` defaulted to the group literally named `""`, which
nothing has ever written. The client asks for neither by name, so the chart read the empty group
and would have stayed blank however much history the database held. Both now default to the same
place, and an explicit `?group=` still wins.

### Why the legacy series is *not* spliced onto the live one

Tempting, and wrong. The imported series runs $919–$2358; the on-chain book today is ~$449.
Splicing them would draw one line with a ~$1100 cliff at the join.

The two do not measure the same thing. The old app's net worth included the off-chain assets the
user typed into that browser, which a keyless server cannot see. Whether the rest of the gap is
missing off-chain value or a book that genuinely shrank is **not knowable from this data** — and
a chart that answers a question it cannot answer is worse than one that starts today.

So the legacy points stay under their own group (`me`), readable at
`/api/wealth/history?group=me`, and the live series starts from the sweep's first daily point.
The chart says "not enough history yet" until it has two, which is true.

Closing this properly means Lyra tracking off-chain assets server-side, at which point the two
bases match and the join is honest. Until then they are two series, presented as two.

## The oracle is gone — 2026-08-19

`wallet-portfolio/` was deleted once every phase was complete. What that means for this document:
**every rule below is still the specification, and `make parity` cannot run until the oracle is
back.** Nothing here is stale; it just needs its other half.

### Getting the oracle back

```bash
make oracle-clone   # clone + venv + deps, next to this repo
cp .env.local ../wallet-portfolio/.env.local
make oracle         # :8000
```

Three things to know before trusting a run afterwards:

- **Its venv needs brew `python@3.13`.** The system Python will not do.
- **`.env.local` does not come back with the clone** — it is gitignored, and this repo's copy is
  now the only one. That is why the secrets were migrated *before* the directory was deleted.
- **Starting it also starts the Telegram command bot and its crons.** It is not a read-only
  process.

### What was kept

- `core/data/legacy-pow.db` — the oracle's own database, checkpointed with `.backup`. 57
  `nw_history` points, 4 snapshots, 6 `pos_perf` rows. Its live copy sat in a system temp
  directory that macOS is free to clean, which is a poor place for the only copy of anything.
- `core/data/legacy-life-os.db` — the Hono API's database, 89 entities.
- Everything else is in the git remote: `git@github.com:bondzai/wallet-portfolio.git`, clean tree,
  nothing unpushed, verified before deleting.

### The differential tests do not need it

`lyra-chain/tests/spam_parity.rs` runs against a committed corpus (3,255 cases generated *by* the
Python filter), so it keeps working. Regenerating that corpus needs the oracle back — see
"Differential tests for pure functions" above.

## The click-through, finally done — 2026-08-19

No browser automation was available through any of the porting sessions, so "does it actually
work when a person opens it" stayed unanswered to the end. It is answerable without an
integration: `playwright-core` drives the **system Chrome**, downloading no browser. The harness
is `scripts/visual-sweep.mjs`.

It loads all 21 routes against the running API and records what a person would otherwise have to
notice: console errors, uncaught exceptions, failed requests, HTTP ≥ 400, the React error
boundary, and whether the page painted at all. A screenshot per route lands in `shots/`.

**First run: 2 real defects, both invisible to everything else.**

### `/deep-work` was a blank screen with no way out

`SessionPlanner` is the only thing on that page when no focus tasks are set, and it had two
`return null` branches: AI offline, and no plan came back. Not running Ollama was enough to get a
completely empty dark page with no control on it — no button, no text, no way back. Both branches
now render a short "choose tasks yourself" hand-off. It renders 70 characters instead of 0, which
is the whole difference between a dead end and a working page.

### `SmartPriority` set state on `TodayPage` while rendering

```jsx
if (!isOnline || candidates.length === 0) {
  onManual()      // ← the parent's setState, during this component's render
  return null
}
```

React's "Cannot update a component while rendering a different component". Moved into an effect,
with the prop held in a ref — it is a fresh arrow on every parent render, so depending on it
would re-run the effect forever.

Chasing it turned up a third thing in `today.tsx`: the same file pruned stale priority ids from
inside a `useMemo`, calling two setters mid-render. Worse, it had no guard for "the entities have
not loaded yet" — a render before the fetch returned resolved *every* priority to nothing,
concluded they were all stale, and wrote an empty list to storage. A slow fetch could silently
wipe the user's list. Now an effect, guarded on `allEntities.length`.

### After the fixes: 21/21 clean

Confirmed by eye as well as by counter — Overview shows $448.31 with the tier split and the
Snowball panel; DeFi shows six live positions with range bars, per-position ❄ toggles and the
de-duplicated claim summary.

### What it deliberately ignores

`:11434` (Ollama is not running here, and the browser calling it directly is the documented
offline path) and `/api/knowledge` (404s without `LYRA_KNOWLEDGE_PATH`). Everything else is a
failure.

### A note on disk

Running `docker compose build` first filled a 228 GB volume and took the Docker daemon down with
it. The cause was a missing rule: the root `.dockerignore` did not exclude `core/`, so building
the **UI** image uploaded `core/target` — about 15 GB of Rust artefacts — as build context. Fixed
there. Worth knowing that the failure mode is an I/O error deep in a layer write, which does not
look like "your ignore file is wrong".

## Phase 9 — where it actually stands — 2026-08-19

Honest status, because "the compose file exists" has been mistaken for "the stack runs" once
already in this project.

**Done and checked:**

- `docker compose config` resolves, including the wealth variables through `env_file` — verified
  by inspecting the resolved config, not by reading the YAML.
- The `.dockerignore` fix is measured, not assumed: the UI build context drops from **893 MB to
  3 MB**. Before `core/target/debug` was cleared it would have been ~15.9 GB, which is what
  filled the disk.
- Every path the stack depends on is named in the deployment doc, and the disk requirement now
  leads it.

**Not done:** neither image has ever been built successfully, so nothing has run in a container.

The first attempt died on the full disk — the buildkit metadata database took the I/O error
(`write /var/lib/docker/buildkit/.../metadata_v2.db: input/output error`), which killed the API
build as well as the UI one. Docker Desktop then threw error dialogs and its VM has not booted
since; the backend process runs, `docker info` returns client info only, and
`~/.docker/run/docker.sock` never appears. That needs a human at the GUI, and deleting Docker's
data directory is not a repair anyone should do on someone else's machine — it holds images and
volumes from other projects.

**When Docker is back**, in order:

```bash
df -h /                                    # ~3 GB is enough, per §1.1
docker compose build api ui                # the context is 3 MB now, not 15.9 GB
docker compose up -d api ui                # ollama is a separate, large pull — add it after
docker compose ps                          # api should reach "healthy"
```

The database volume starts empty, so the API will migrate a fresh schema and there will be **no
user to log in as**. Either run the `migrate` service against the legacy databases (§2.2) or copy
the working `core/data/lyra.db` onto the `lyra-data` volume first — a fresh schema with no rows
looks identical to a broken import until you try to sign in.

## Phase 9, actually run — 2026-08-20

The stack has now been built and served, which the previous entry could not say.

Docker's VM was recovered first: the backend had crashed *while recovering from an engine crash*
(it could not write its own log — the disk was full), and the wedged `com.docker.backend` process
then blocked every restart. `docker desktop restart` and quitting the app both just waited on it.
`pkill -9 -f com.docker.backend` followed by `open -a Docker` brought it back. Deleting
`~/Library/Containers/com.docker.docker/Data` would also have "worked" and would have taken every
other project's images and volumes with it.

**What the first real build found** — two things no amount of reading could have:

1. **`Dockerfile.ui` still copied `nginx.rust.conf`.** The rename to `nginx.conf` had been
   followed through compose, the Makefile and the docs, and missed the one place that actually
   consumes it. The build failed on a missing file; nothing else in the repo referenced it.
2. **Seeding the volume by hand leaves `/data` root-owned**, and SQLite in WAL mode must *create*
   its `-wal`/`-shm` sidecars in that directory. The error is `attempt to write a readonly
   database`, which names the file — the file was fine. `chown -R 10001:10001 /data`.

A third, smaller: `JWT_SECRET` is declared `:?`, so **every** compose subcommand needs it
exported, `logs` and `ps` included. Without it they print the interpolation error instead of
container state, which makes a healthy stack look dead.

**The builder now uses BuildKit cache mounts** for `target/` and the cargo registry, replacing the
manifest-stub dependency layer. Same incremental behaviour, but the ~900 MB of dependency
artefacts never becomes an image layer. The trade is that the cache is machine-local and
`docker builder prune` clears it — right for a box that builds its own images, wrong if these ever
move to CI and a registry.

**Verified end to end:**

- `lyra-api` and `lyra-ui` build clean.
- nginx serves the SPA on :8080 and proxies `/api`; health, login and a live portfolio read
  ($455.17 across 2 wallets) all answer through it.
- The **production** bundle passes the same browser sweep as the dev server: **21/21 routes clean**
  against `http://localhost:8080`.

**Measured image sizes**, replacing the estimates that were in here twice: `lyra-api` **300 MB**,
`lyra-ui` **95.5 MB**. The one worth knowing: git and its dependencies are **106 MB** of the API
image — as much as the base OS — for the knowledge module's note history. A Rust git library would
take about a third off the image.

## The env move, finished — 2026-08-20

`wallet-portfolio/.env.local` was migrated into `lyra/.env.local` on 2026-08-18, before the
directory was deleted — that ordering was deliberate, because a re-clone does not bring the file
back. An audit of what the binaries actually read confirms nothing was lost: `ALERT_WALLETS`, all
three `KUCOIN_*` and both `TELEGRAM_*` are present.

Two things the move did leave behind, both found by checking every variable the code reads rather
than by reading the file:

**`POW_WALLETS` was never set** — so every portfolio tool on the MCP desk answered "no wallets
supplied", which reads like a broken server rather than a missing setting. The desk keeps its own
variable (a research tool deserves its own scope) but now falls back to `ALERT_WALLETS`, because
requiring the same list under a second name on a single-user box only produces two lists that
drift apart. A blank value counts as unset, since that is how a half-filled `.env` presents
itself. Verified against the real environment: `get_portfolio` with no `POW_WALLETS` returns
$449.06 across 2 wallets.

**`JWT_SECRET` is present but empty**, which is why the API exits 1 on `make dev-api` from the
repo's own environment. This one cannot be fixed in code and should not be: the secret has to be
the operator's. Generate it once and keep it stable — changing it invalidates every existing
session:

```bash
printf '\nJWT_SECRET=%s\n' "$(openssl rand -base64 48)" >> .env.local
```
