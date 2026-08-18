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
