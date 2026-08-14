#!/usr/bin/env python3
"""Generate `model_corpus.json` from the Python oracle (`wallet-portfolio/portfolio.py`).

The corpus is the *shape* contract for `lyra_chain::model`: for every case it records the
exact dict the oracle produces, so the Rust side can assert its serialisation has the same
KEY SET (a missing key the UI reads is a blank panel) and the same values.

Everything here is built by calling the **real** factories — `_position`, `_lp_position`,
`_vfat_stamp_meta`, `_vfat_stamp_lifecycle`'s stamping body, `_chain_result`, `_wallet` —
never by hand-writing the expected dict, because a hand-written expectation is just the same
guess twice. The only hand-built dicts are the KuCoin ones, which is faithful: `kucoin.py`
genuinely bypasses `_position` and assembles its position dicts inline.

No network is touched. The adapters that need chain access are not called; instead their
*outputs* are fed to `_position` exactly as they would be at runtime.

Floats are chosen to be exactly representable in binary (halves, quarters, powers of two)
wherever the Rust test hand-builds the same struct, so `repr()` round-trips bit-for-bit and
no ULP tolerance is needed. The tick-maths cases are compared structurally only.

Run:
    cd wallet-portfolio && PYTHONPATH=. .venv/bin/python \
        ../lyra/core/crates/lyra-chain/tests/model_corpus_gen.py \
        > ../lyra/core/crates/lyra-chain/tests/model_corpus.json
"""

import copy
import json

import portfolio as p

CASES = []


def case(name, kind, note, obj):
    """Record one case. `kind` picks the Rust type the JSON must deserialise into."""
    CASES.append({"name": name, "kind": kind, "note": note, "json": obj})


# ---------------------------------------------------------------------------
# 1) `_position` — the central factory. One case per argument combination that
#    changes which keys land in the dict.
# ---------------------------------------------------------------------------

case("position_minimal", "position",
     "Only the four positional args: id/via/tokens/usd are still written, everything else absent.",
     p._position("Aave v3", "Borrowing", "Borrow vs. supplied collateral", -1024.5))

case("position_usd_none", "position",
     "usd=None must serialise as null, not vanish — types.ts declares `usd: number | null`.",
     p._position("Unknown", "Yield", "unpriced", None))

case("position_id_via", "position",
     "id and via supplied — the same keys as the minimal case, now non-null.",
     p._position("Uniswap v3", "Liquidity Pool", "WETH/USDC 0.05%", 2048.25,
                 id="#12345", via="vfat.io"))

case("position_tokens", "position",
     "tokens without usd on the legs (the ERC-4626 vault path, portfolio.py L662).",
     p._position("ERC-4626 vault", "Yield", "gtWBTCc", 512.0,
                 tokens=[{"symbol": "WBTC", "amount": 0.0078125}]))

case("position_tokens_usd", "position",
     "tokens with usd on each leg (the LP path).",
     p._position("Uniswap v3", "Liquidity Pool", "WETH/USDC 0.05%", 3.0,
                 tokens=[{"symbol": "WETH", "amount": 0.5, "usd": 2.0},
                         {"symbol": "USDC", "amount": 1.0, "usd": 1.0}]))

case("position_in_range_true", "position",
     "in_range=True -> key present.",
     p._position("Uniswap v3", "Liquidity Pool", "x", 1.0, in_range=True))

case("position_in_range_false", "position",
     "in_range=False is FALSY but not None — the key must still be present. A port that "
     "used a truthiness check would drop it and paint every position as in-range.",
     p._position("Uniswap v3", "Liquidity Pool", "x", 1.0, in_range=False))

case("position_rewards_pair", "position",
     "rewards + rewards_usd — written by one statement, so they always appear together.",
     p._position("Aerodrome", "Liquidity Pool", "x", 1.0,
                 rewards=[{"symbol": "AERO", "amount": 2.5, "usd": 1.25}],
                 rewards_usd=1.25))

case("position_rewards_usd_null", "position",
     "rewards passed WITHOUT rewards_usd: `pos['rewards'], pos['rewards_usd'] = rewards, None` "
     "so rewards_usd is present-and-NULL. A plain Option<f64> would drop the key here.",
     p._position("Aerodrome", "Liquidity Pool", "x", 1.0,
                 rewards=[{"symbol": "AERO", "amount": 2.5, "usd": 1.25}]))

case("position_rewards_usd_orphan", "position",
     "rewards_usd passed WITHOUT rewards: the assignment lives inside `if rewards is not None`, "
     "so NEITHER key is written. The value is silently discarded — this is the case that proves "
     "`rewards_usd` cannot be modelled independently of `rewards`.",
     p._position("Aerodrome", "Liquidity Pool", "x", 1.0, rewards_usd=99.0))

case("position_rewards_empty", "position",
     "rewards=[] is falsy but not None -> both keys written, rewards as an empty list.",
     p._position("Aerodrome", "Liquidity Pool", "x", 1.0, rewards=[], rewards_usd=0.0))

case("position_change24h", "position",
     "change24h present.",
     p._position("Uniswap v3", "Liquidity Pool", "x", 1.0, change24h=-2.5))

case("position_change24h_zero", "position",
     "change24h=0.0 is falsy but not None -> key present. A truthiness port loses flat days.",
     p._position("Uniswap v3", "Liquidity Pool", "x", 1.0, change24h=0.0))

case("position_health_hf", "position",
     "Lending health with a finite health factor (Compound path).",
     p._position("Compound v3", "Borrowing", "Borrow vs. supplied collateral", 256.0,
                 health={"hf": 1.5, "ltv": 0.5, "liq_threshold": 0.75,
                         "collateral_usd": 512.0, "debt_usd": 256.0}))

case("position_health_hf_null", "position",
     "Aave returns u256::MAX as healthFactor when debt == 0; the oracle maps it to None, "
     "so hf is present-and-null inside an otherwise fully-populated object.",
     p._position("Aave v3", "Borrowing", "Supplied collateral", 0.0,
                 health={"hf": None, "ltv": 0.0, "liq_threshold": 0.0,
                         "collateral_usd": 0.0, "debt_usd": 0.0}))

# `_spot_addr` — set by the factory, popped by the orchestrator before the chain result is
# built. Both halves are recorded: the pre-pop dict is what `_position` returns (Rust must
# NOT serialise it), the post-pop dict is what actually reaches the wire.
_with_spot = p._position("ERC-4626 vault", "Yield", "gtWBTCc", 512.0,
                         spot_addr="0xAbCdEf0000000000000000000000000000000001")
case("position_spot_addr_prepop", "position_internal",
     "_position DID write `_spot_addr`. It is internal: `_evm_chain_portfolio` pops it during "
     "spot dedup (portfolio.py L1903) before `_chain_result`, so it must never be serialised.",
     copy.deepcopy(_with_spot))
_popped = copy.deepcopy(_with_spot)
_popped.pop("_spot_addr")
case("position_spot_addr_postpop", "position",
     "The same position as it reaches the wire, after the orchestrator's pop.",
     _popped)

case("position_everything", "position",
     "Every `_position` keyword at once — the maximal factory output.",
     p._position("Aerodrome", "Liquidity Pool", "WETH/USDC 0.05%", 4096.0,
                 id="#99", via="vfat.io",
                 tokens=[{"symbol": "WETH", "amount": 1.0, "usd": 2048.0},
                         {"symbol": "USDC", "amount": 2048.0, "usd": 2048.0}],
                 in_range=True,
                 rewards=[{"symbol": "AERO", "amount": 10.0, "usd": 5.0}],
                 rewards_usd=5.0,
                 change24h=1.25,
                 health={"hf": 2.0, "ltv": 0.25, "liq_threshold": 0.8,
                         "collateral_usd": 1024.0, "debt_usd": 256.0},
                 spot_addr=None))

# ---------------------------------------------------------------------------
# 2) Lending legs — `side` on a token (portfolio.py L1684, the Morpho adapter).
# ---------------------------------------------------------------------------

case("position_lending_legs", "position",
     "Morpho borrow: token legs carry `side` (supply/borrow), which the compact health row reads.",
     p._position("Morpho", "Borrowing", "Borrow · WETH/USDC", -128.0,
                 tokens=[{"symbol": "WETH", "amount": 1.0, "usd": 2048.0, "side": "supply"},
                         {"symbol": "USDC", "amount": 128.0, "usd": 128.0, "side": "borrow"}],
                 health={"hf": 3.0, "ltv": 0.0625, "liq_threshold": 0.86,
                         "collateral_usd": 2048.0, "debt_usd": 128.0}))

# ---------------------------------------------------------------------------
# 3) `_lp_position` — the concentrated-liquidity wrapper. Adds tick_spacing and
#    price_band on top of the factory, and computes the reward legs from raw fees.
# ---------------------------------------------------------------------------

_lp = p._LP(q0=1.0, q1=2048.0, d0=18, d1=6, s0="WETH", s1="USDC",
            pr0=2048.0, pr1=1.0, ch0=1.5, ch1=-0.5)

case("lp_position_no_band", "position",
     "_lp_position with no band and a fee tier that maps to a tick spacing (500 -> 10).",
     p._lp_position("Uniswap v3", 12345, _lp, 500, True,
                    fee0_raw=10 ** 15, fee1_raw=10 ** 5, via=None))

case("lp_position_unknown_fee", "position",
     "A fee tier outside _FEE_TICK_SPACING -> spacing is None -> tick_spacing key ABSENT.",
     p._lp_position("Uniswap v4", 7, _lp, 4242, False,
                    fee0_raw=0, fee1_raw=0, via="Sickle"))

case("lp_position_with_band", "position",
     "_lp_position with the real _lp_range output — price_band's lower/upper/cur come from "
     "tick maths, so they are compared structurally, not against hand-written literals.",
     p._lp_position("Uniswap v3", 42, _lp, 3000, True,
                    fee0_raw=10 ** 14, fee1_raw=10 ** 4, via="vfat.io",
                    band=p._lp_range(-887220, 887220, 0, _lp), tick_spacing=60))

case("price_band_full_range", "position",
     "A full-range position: hi/lo span more than 1e9 so `full` is True. `fin()` nulls any "
     "non-finite bound, so lower/upper/cur are nullable but always present.",
     p._lp_position("Uniswap v3", 43, _lp, 100, True,
                    fee0_raw=0, fee1_raw=0, via=None,
                    band=p._lp_range(-887272, 887272, 100, _lp)))

# ---------------------------------------------------------------------------
# 4) `_vfat_stamp_meta` — apr + range_pct, stamped from an already-fetched farm entry.
# ---------------------------------------------------------------------------

_apr_pos = p._lp_position("Hyperswap", 1, _lp, 500, True, 0, 0, "vfat.io",
                          band=p._lp_range(-10000, 10000, 0, _lp))
p._vfat_stamp_meta(_apr_pos, {"farm": {"snapshot": {"apr": 42.5}},
                              "guaranteedAprPricePercentRange": {
                                  "minPricePercent": -5.0, "maxPricePercent": 5.0,
                                  "widthPercent": 10.0}})
case("vfat_meta_apr_range", "position",
     "apr from farm.snapshot.apr, range_pct from vfat's guaranteedAprPricePercentRange.",
     _apr_pos)

_lpapr_pos = p._lp_position("Hyperswap", 2, _lp, 500, True, 0, 0, "vfat.io",
                            band=p._lp_range(-10000, 10000, 0, _lp))
p._vfat_stamp_meta(_lpapr_pos, {"farm": {"snapshot": {"lpApr": 3.25}},
                                "guaranteedAprPricePercentRange": {
                                    "minPricePercent": None, "maxPricePercent": None,
                                    "widthPercent": 12.5}})
case("vfat_meta_range_pct_null_bounds", "position",
     "range_pct with NULL min/max but a real width: vfat only guarantees widthPercent, and "
     "the branch is gated on it alone. types.ts declares all three as required `number`.",
     _lpapr_pos)

_derived_pos = p._lp_position("Hyperswap", 3, _lp, 500, True, 0, 0, "vfat.io",
                              band=p._lp_range(-10000, 10000, 0, _lp))
p._vfat_stamp_meta(_derived_pos, {})
case("vfat_meta_range_derived", "position",
     "No vfat range and no apr: apr key stays ABSENT, range_pct is derived from the band.",
     _derived_pos)

_noapr_full = p._lp_position("Hyperswap", 4, _lp, 500, True, 0, 0, "vfat.io",
                             band=p._lp_range(-887272, 887272, 0, _lp))
p._vfat_stamp_meta(_noapr_full, {})
case("vfat_meta_full_range_no_stamp", "position",
     "A full-range band short-circuits the derived branch -> neither apr nor range_pct.",
     _noapr_full)

# ---------------------------------------------------------------------------
# 5) `_vfat_stamp_lifecycle` — the lifecycle/perf keys. The network fetch is not
#    callable offline, so the stamping body is reproduced against a synthetic
#    action list; the KEYS and their nullability are what this case pins.
# ---------------------------------------------------------------------------

def stamp_lifecycle(pos, acts, perf=None, perf_key=None):
    """The body of `_vfat_stamp_lifecycle.one()` (portfolio.py L1300-1324), verbatim."""
    if perf_key is not None:
        pos["perf_key"] = perf_key
    if acts:
        pos["deployed_at"] = acts[0].get("blockTimestamp")
        pos["updated_at"] = acts[-1].get("blockTimestamp")
        pos["last_action"] = acts[-1].get("actionType")
        harvests = [a for a in acts if "harvest" in (a.get("actionType") or "").lower()]
        if harvests:
            pos["last_harvest_at"] = harvests[-1].get("blockTimestamp")
        pos["cycle_start"] = p._iso_epoch(pos.get("last_harvest_at")
                                          or acts[0].get("blockTimestamp"))
    if perf:
        pos["in_range_secs"] = perf["in_range_secs"]
        pos.setdefault("cycle_start", perf["cycle_start"])


_life = p._lp_position("Aerodrome", 5, _lp, 500, True, 0, 0, "vfat.io")
stamp_lifecycle(_life,
                [{"blockTimestamp": "2026-01-02T03:04:05.000Z", "actionType": "deposited"},
                 {"blockTimestamp": "2026-03-04T05:06:07.000Z", "actionType": "harvested"},
                 {"blockTimestamp": "2026-05-06T07:08:09.000Z", "actionType": "rebalanced"}],
                perf={"in_range_secs": 86400.0, "cycle_start": 1}, perf_key="8453:5")
case("vfat_lifecycle_full", "position",
     "Full lifecycle: deployed/updated/last_action/last_harvest_at/cycle_start/in_range_secs "
     "plus perf_key. cycle_start anchors to the LAST HARVEST, not the deploy, and in_range_secs "
     "arrives from the cron accumulator. Note perf_key is emitted but undeclared in types.ts.",
     _life)

_life_noharvest = p._lp_position("Aerodrome", 6, _lp, 500, True, 0, 0, "vfat.io")
stamp_lifecycle(_life_noharvest,
                [{"blockTimestamp": "2026-01-02T03:04:05.000Z", "actionType": "deposited"}],
                perf_key="8453:6")
case("vfat_lifecycle_no_harvest", "position",
     "Never harvested: last_harvest_at key ABSENT, cycle_start falls back to the deploy. "
     "in_range_secs absent because the cron has no row yet.",
     _life_noharvest)

_life_nulls = p._lp_position("Aerodrome", 7, _lp, 500, True, 0, 0, "vfat.io")
stamp_lifecycle(_life_nulls, [{}, {}])
case("vfat_lifecycle_null_timestamps", "position",
     "An action list whose entries have no blockTimestamp/actionType: every lifecycle key is "
     "written with a NULL value (`.get()` returns None), and _iso_epoch(None) nulls cycle_start "
     "too. Present-and-null, not absent — hence the double Option.",
     _life_nulls)

_life_perf_only = p._lp_position("Aerodrome", 8, _lp, 500, True, 0, 0, "vfat.io")
stamp_lifecycle(_life_perf_only, [], perf={"in_range_secs": 3600.0, "cycle_start": 1750000000},
                perf_key="8453:8")
case("vfat_lifecycle_perf_only", "position",
     "vfat's action API failed but the cron has a row: in_range_secs + a setdefault'd "
     "cycle_start land WITHOUT any of the deployed/updated/last_action keys.",
     _life_perf_only)

# ---------------------------------------------------------------------------
# 6) KuCoin — the one producer that bypasses `_position`, so its dicts are the
#    shape divergence the model has to tolerate.
# ---------------------------------------------------------------------------

case("kucoin_spot_bot", "position",
     "kucoin.py L158 builds this inline: NO `id` key at all (every _position dict has one), "
     "and an extra `tier` key that types.ts does not declare on DefiPosition.",
     {"protocol": "KuCoin Spot Bot", "category": "Rebalance",
      "name": "Smart Rebalance · 3 assets", "via": None, "tier": "cashflow",
      "tokens": [{"symbol": "BTC", "amount": 0.5}, {"symbol": "ETH", "amount": 2.0}],
      "usd": 4096.0, "change24h": 1.25,
      "bot": {"kind": "Smart Rebalance", "status": "running",
              "weights": [{"symbol": "BTC", "amount": 0.5, "usd": 3072.0, "pct": 75.0},
                          {"symbol": "ETH", "amount": 2.0, "usd": 1024.0, "pct": 25.0}]}})

case("kucoin_futures_bot", "position",
     "kucoin.py L186: pnl_usd/pnl_pct on the position, and a BotInfo carrying count/margin/bots "
     "instead of weights. SubBot.id is `accountName or subName or accountId` — nullable.",
     {"protocol": "KuCoin Futures Bot", "category": "Futures",
      "name": "2 AI futures bots", "via": None, "tier": "highrisk",
      "tokens": [{"symbol": "USDT", "amount": 2048.0}], "usd": 2048.0,
      "pnl_usd": 128.0, "pnl_pct": 6.25,
      "bot": {"kind": "AI Futures", "status": "running", "count": 2,
              "margin_usd": 512.0, "margin_pct": 25,
              "bots": [{"id": "robot123", "usd": 1536.0, "pnl_usd": 96.0,
                        "pnl_pct": 6.67, "margin": 384.0},
                       {"id": None, "usd": 512.0, "pnl_usd": 32.0,
                        "pnl_pct": 6.67, "margin": 128.0}]}})

case("kucoin_earn_null_change", "position",
     "kucoin.py L121: an Earn position for an unpriced currency passes `chg=None` straight "
     "through, so change24h is present-and-NULL — a shape `_position` itself can never make.",
     {"protocol": "KuCoin Earn", "category": "Yield", "name": "USDT savings",
      "via": None, "tier": "cashflow",
      "tokens": [{"symbol": "USDT", "amount": 1024.0, "usd": 1024.0}],
      "usd": 1024.0, "change24h": None, "apr": 5.25})

# ---------------------------------------------------------------------------
# 7) Spot tokens — one case per producer, because they disagree on which keys exist.
# ---------------------------------------------------------------------------

case("spot_evm_native", "spot",
     "EVM native coin (portfolio.py L306): symbol/amount/price/usd/change24h/coin/kind.",
     {"symbol": "ETH", "amount": 1.5, "price": 2048.0, "usd": 3072.0,
      "change24h": 2.5, "coin": "coingecko:ethereum", "kind": "native"})

case("spot_evm_token", "spot",
     "EVM ERC-20 (L319): adds `address`; change24h is stamped in the batch pass at L353.",
     {"symbol": "USDC", "amount": 1024.0, "price": 1.0, "usd": 1024.0,
      "kind": "token", "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "coin": "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "change24h": -0.25})

case("spot_evm_token_null_symbol", "spot",
     "`tok.get('symbol')` is None for a Blockscout token with no symbol, and `cfg.get('llama')` "
     "is None for a chain with no DefiLlama prefix -> symbol AND coin present-and-null. "
     "types.ts declares `symbol: string` (non-null).",
     {"symbol": None, "amount": 1.0, "price": 2.0, "usd": 2.0,
      "kind": "token", "address": "0x0000000000000000000000000000000000000001",
      "coin": None, "change24h": None})

case("spot_hyperliquid", "spot",
     "Hyperliquid (L1995): NO change24h, NO coin, NO address keys at all.",
     {"symbol": "HYPE", "amount": 100.0, "price": 32.0, "usd": 3200.0, "kind": "token"})

case("spot_bitcoin", "spot",
     "Bitcoin (L1960): change24h present, but no coin/address.",
     {"symbol": "BTC", "amount": 0.25, "price": 65536.0, "usd": 16384.0,
      "change24h": 1.5, "kind": "native"})

case("spot_solana_spl", "spot",
     "Solana SPL (L2106): coin + address + change24h, kind=token.",
     {"symbol": "JUP", "amount": 512.0, "price": 0.5, "usd": 256.0,
      "change24h": -3.25, "coin": "solana:JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
      "kind": "token", "address": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"})

case("spot_kucoin", "spot",
     "KuCoin (kucoin.py L88): change24h present (nullable), no coin/address.",
     {"symbol": "USDT", "amount": 2048.0, "price": 1.0, "usd": 2048.0,
      "change24h": None, "kind": "token"})

# ---------------------------------------------------------------------------
# 8) `_chain_result` and `_wallet` — the containers.
# ---------------------------------------------------------------------------

_spot = [{"symbol": "ETH", "amount": 1.0, "price": 2048.0, "usd": 2048.0,
          "change24h": 2.5, "coin": "coingecko:ethereum", "kind": "native"}]
_defi = [p._position("Aave v3", "Borrowing", "Borrow vs. supplied collateral", -256.0,
                     health={"hf": 1.75, "ltv": 0.5, "liq_threshold": 0.8,
                             "collateral_usd": 2048.0, "debt_usd": 256.0})]

case("chain_result", "chain",
     "_chain_result: {chain, usd, spot, defi} and nothing else.",
     p._chain_result("base", 1792.0, _spot, _defi))

case("chain_result_empty", "chain",
     "A chain with value but no holdings — spot and defi are [] , never null.",
     p._chain_result("optimism", 0.5, [], []))

_c1 = p._chain_result("base", 1792.0, _spot, _defi)
_c2 = p._chain_result("optimism", 256.25, [], [])
case("wallet", "wallet",
     "_wallet: total is the SUM of the chains' usd, recomputed — not passed in.",
     p._wallet("0x7Fce9c293dBD6d050455B986cb6850114Aad71a8", [_c1, _c2]))

case("wallet_drops_none_chains", "wallet",
     "_wallet filters falsy chains (a chain below dust returns None from _chain_result) "
     "before summing, so the total never counts a dropped chain.",
     p._wallet("0x7Fce9c293dBD6d050455B986cb6850114Aad71a8",
               [_c1, None, p._chain_result("polygon", 0.001, [], []), _c2]))

case("wallet_kucoin", "wallet",
     "The synthetic KuCoin wallet (kucoin.py L203): address is the literal string 'KuCoin' "
     "and its single bucket's chain is 'kucoin'.",
     {"address": "KuCoin", "total": 1024.0,
      "chains": [{"chain": "kucoin", "usd": 1024.0,
                  "spot": [{"symbol": "USDT", "amount": 1024.0, "price": 1.0,
                            "usd": 1024.0, "change24h": None, "kind": "token"}],
                  "defi": []}]})

# ---------------------------------------------------------------------------
# 9) `build_portfolios` — the top-level envelope. Its body is all network, so the
#    envelope is assembled here exactly as L2411-2415 does, over real sub-objects.
# ---------------------------------------------------------------------------

def envelope(addresses, wallets, rates, fng, rainbow, fetched_at):
    """portfolio.py L2411-2415, verbatim apart from the injected values."""
    return {"addresses": addresses, "total": sum(x["total"] for x in wallets),
            "wallets": wallets, "rates": rates,
            "sentiment": {"fear_greed": fng, "btc_rainbow": rainbow},
            "fetched_at": fetched_at}


_w = p._wallet("0x7Fce9c293dBD6d050455B986cb6850114Aad71a8", [_c1, _c2])
_ku = {"address": "KuCoin", "total": 1024.0,
       "chains": [{"chain": "kucoin", "usd": 1024.0, "spot": [], "defi": []}]}

case("snapshot_full", "snapshot",
     "Everything populated. `addresses` lists only the REQUESTED wallets — the appended "
     "KuCoin wallet is in `wallets` but not in `addresses`, so the two lengths differ.",
     envelope(["0x7Fce9c293dBD6d050455B986cb6850114Aad71a8"], [_w, _ku],
              {"usd": 1.0, "thb": 32.5, "btc_usd": 65536.0},
              {"value": 42, "classification": "Fear"},
              p.btc_rainbow(65536.0), 1783924800.5))

case("snapshot_degraded", "snapshot",
     "The deadline/offline path: rates falls back to {usd:1.0, thb:None, btc_usd:None} — still "
     "an OBJECT, never null (types.ts types it `Rates | null`) — and both sentiment legs are "
     "null, since btc_rainbow(None) returns None. Keys all present.",
     envelope([], [], {"usd": 1.0, "thb": None, "btc_usd": None},
              None, p.btc_rainbow(None), 1783924800.0))

case("snapshot_multi_wallet", "snapshot",
     "Two wallets: total is the sum of the wallets' totals.",
     envelope(["0xaaa0000000000000000000000000000000000001",
               "0xbbb0000000000000000000000000000000000002"],
              [p._wallet("0xaaa0000000000000000000000000000000000001", [_c1]),
               p._wallet("0xbbb0000000000000000000000000000000000002", [_c2])],
              {"usd": 1.0, "thb": 32.5, "btc_usd": 65536.0},
              {"value": 88, "classification": "Extreme Greed"},
              p.btc_rainbow(120000.0), 1783924800.25))

print(json.dumps({"cases": CASES}, indent=2, sort_keys=False))
