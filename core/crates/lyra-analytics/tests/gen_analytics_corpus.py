#!/usr/bin/env python3
"""Generate `analytics_corpus.json` from the REAL Python oracle.

Runs `analysis.py` (tier classification, rebalance/drift plan, exposure unwrap) and
`pow_mcp/analytics.py` (HHI concentration, the Metric honesty envelope) over a deterministic
set of synthetic portfolios, and dumps inputs + expected outputs for the Rust parity test.

Regenerate:

    cd /Users/jamesbond/Desktop/code/home-ai-assistant/wallet-portfolio
    ./.venv/bin/python \\
      /Users/jamesbond/Desktop/code/home-ai-assistant/lyra/core/crates/lyra-analytics/tests/gen_analytics_corpus.py

Portfolios deliberately cover: empty, single-asset, perfectly-even, extreme concentration,
all-stable, all-speculative, LP pairs with and without priced legs (the data-gap fallback),
perp-bot collateral, rebalance baskets, lending-only books (which must unwrap to NO exposure),
wrapper duplicates that fold onto one asset, dust and whale magnitudes, custom targets, and
values engineered to land exactly on a rounding tie (where Python's banker's rounding disagrees
with naive half-away-from-zero).
"""

import json
import os
import random
import sys

sys.path.insert(0, os.environ.get(
    "WALLET_PORTFOLIO", "/Users/jamesbond/Desktop/code/home-ai-assistant/wallet-portfolio"))

import analysis as A                       # noqa: E402
from pow_mcp import analytics as AN        # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "analytics_corpus.json")

SYMBOLS = ["USDC", "USDT", "DAI", "USDe", "USDC.e", "BTC", "WBTC", "cbBTC", "ETH", "WETH",
           "wstETH", "weETH", "SOL", "wSOL", "jitoSOL", "MATIC", "wPOL", "BNB", "wBNB", "AVAX",
           "HYPE", "wHYPE", "PAXG", "XAUt", "GOLD", "sUSDe", "sDAI", "JLP", "GHO", "aUSDC",
           "PEPE", "ARB", "OP", "LINK", "UNI", "", "btc.b", "eth.b", "FDUSD", "LUSD"]
CATEGORIES = [None, "", "Perps", "Futures", "Rebalance", "Spot Grid", "Liquidity Pool", "Yield",
              "Wallet", "Staking"]
PROTOCOLS = ["Uniswap V3", "Aerodrome", "KuCoin Futures Bot", "KuCoin Rebalance Bot",
             "Hyperswap", "Aave V3", "Morpho"]


# ---------- input builders (the flat shapes the Rust crate takes) ----------

def wallets_from(spot, defi):
    """Wrap the flat spot/defi lists back into the nested structure analysis.py walks, so the
    oracle sees exactly the same book the Rust does."""
    return [{"chains": [{"chain": "base", "spot": spot, "defi": defi}]}]


def py_defi(d):
    """Flat Rust-shaped defi row -> the raw engine dict analysis.exposure_map expects."""
    out = {"protocol": d["protocol"], "usd": d["usd"]}
    if d["tokens"]:
        out["tokens"] = [{"symbol": t["symbol"], "usd": t["usd"]} for t in d["tokens"]]
    if d["bot_weights"]:
        out["bot"] = {"weights": [{"symbol": t["symbol"], "usd": t["usd"]} for t in d["bot_weights"]]}
    if d["is_lending"]:
        out["health"] = {"hf": 1.4, "debt_usd": 100.0, "collateral_usd": 200.0}
    return out


def tok(symbol, usd):
    return {"symbol": symbol, "usd": usd}


def defi(protocol, usd, tokens=(), bot_weights=(), is_lending=False):
    return {"protocol": protocol, "usd": usd, "tokens": list(tokens),
            "bot_weights": list(bot_weights), "is_lending": is_lending}


def hold(symbol, usd, category=None):
    return {"symbol": symbol, "category": category, "usd": usd}


def case(name, holdings=(), targets=None, spot=(), defi_rows=()):
    """Run the oracle over one synthetic portfolio and record inputs + expected outputs."""
    holdings, spot, defi_rows = list(holdings), list(spot), list(defi_rows)

    # --- tiers / drift: classify each holding with the oracle, then plan against it ---
    rows = [{"usd": h["usd"], "tier": A.classify(h["symbol"], h["category"])} for h in holdings]
    plan = A.rebalance_plan(rows, targets)

    # --- exposure / concentration: through the real nested-walk unwrap ---
    wallets = wallets_from(spot, [py_defi(d) for d in defi_rows])
    exposure = A.exposure_map(wallets)
    conc = AN.concentration(exposure)

    return {
        "name": name,
        "holdings": holdings,
        "targets": targets,
        "spot": spot,
        "defi": defi_rows,
        "expected": {
            "tiers": [r["tier"] for r in rows],
            "plan": plan,
            "exposure": [{"asset": k, "usd": v} for k, v in exposure.items()],
            "concentration": conc,
        },
    }


# ---------- the deliberate (non-random) portfolios ----------

def handcrafted():
    out = []
    out.append(case("empty"))
    out.append(case("single_asset",
                    holdings=[hold("BTC", 10_000.0)],
                    spot=[tok("BTC", 10_000.0)]))
    out.append(case("single_asset_dust",
                    holdings=[hold("PEPE", 0.0001)],
                    spot=[tok("PEPE", 0.0001)]))
    out.append(case("perfectly_even_four",
                    holdings=[hold("USDC", 250.0), hold("BTC", 250.0),
                              hold("ETH", 250.0), hold("PEPE", 250.0)],
                    spot=[tok("USDC", 250.0), tok("BTC", 250.0),
                          tok("ETH", 250.0), tok("PEPE", 250.0)]))
    out.append(case("perfectly_even_three",
                    holdings=[hold("USDC", 100.0), hold("BTC", 100.0), hold("SOL", 100.0)],
                    spot=[tok("USDC", 100.0), tok("BTC", 100.0), tok("SOL", 100.0)]))
    out.append(case("extreme_concentration",
                    holdings=[hold("BTC", 9_500.0), hold("USDC", 500.0)],
                    spot=[tok("BTC", 9_500.0), tok("USDC", 500.0)]))
    out.append(case("all_stables",
                    holdings=[hold("USDC", 500.0), hold("USDT", 300.0), hold("DAI", 200.0)],
                    spot=[tok("USDC", 500.0), tok("USDT", 300.0), tok("DAI", 200.0)]))
    out.append(case("all_speculative",
                    holdings=[hold("PEPE", 400.0), hold("ARB", 300.0), hold("OP", 300.0)],
                    spot=[tok("PEPE", 400.0), tok("ARB", 300.0), tok("OP", 300.0)]))
    out.append(case("wrapper_duplicates_fold_to_one_bet",
                    holdings=[hold("WBTC", 300.0), hold("cbBTC", 200.0), hold("BTC", 100.0),
                              hold("wstETH", 250.0), hold("WETH", 150.0)],
                    spot=[tok("WBTC", 300.0), tok("cbBTC", 200.0), tok("BTC", 100.0),
                          tok("wstETH", 250.0), tok("WETH", 150.0)]))
    out.append(case("lending_only_has_no_exposure",
                    holdings=[],
                    defi_rows=[defi("Aave V3", -500.0, is_lending=True),
                               defi("Morpho", 1_200.0, is_lending=True)]))
    out.append(case("priced_lp_pair_splits",
                    holdings=[hold("WETH", 1_000.0, "Liquidity Pool")],
                    defi_rows=[defi("Uniswap V3", 1_000.0,
                                    tokens=[tok("WETH", 600.0), tok("USDC", 400.0)])]))
    out.append(case("unpriced_leg_falls_back_to_first_token",
                    holdings=[hold("WETH", 300.0, "Liquidity Pool")],
                    defi_rows=[defi("Hyperswap", 300.0,
                                    tokens=[tok("WETH", 200.0), tok("MYSTERY", None)])]))
    out.append(case("no_tokens_falls_back_to_protocol_name",
                    defi_rows=[defi("Aerodrome", 450.0)]))
    out.append(case("empty_symbol_falls_back_to_protocol_name",
                    defi_rows=[defi("Aerodrome", 450.0, tokens=[tok("", None)])]))
    out.append(case("perp_bot_is_usdt_collateral",
                    holdings=[hold("USDT", 750.0, "Futures")],
                    defi_rows=[defi("KuCoin Futures Bot", 750.0)]))
    out.append(case("rebalance_basket_uses_weights",
                    holdings=[hold("BTC", 300.0, "Rebalance")],
                    defi_rows=[defi("KuCoin Rebalance Bot", 300.0,
                                    bot_weights=[tok("BTC", 200.0), tok("wSOL", 100.0)])]))
    out.append(case("mixed_book",
                    holdings=[hold("USDC", 1_200.0), hold("BTC", 4_000.0), hold("ETH", 2_500.0),
                              hold("WETH", 1_500.0, "Liquidity Pool"),
                              hold("USDT", 800.0, "Futures"), hold("PEPE", 300.0),
                              hold("sUSDe", 700.0)],
                    spot=[tok("USDC", 1_200.0), tok("BTC", 4_000.0), tok("ETH", 2_500.0),
                          tok("PEPE", 300.0), tok("sUSDe", 700.0)],
                    defi_rows=[defi("Uniswap V3", 1_500.0,
                                    tokens=[tok("WETH", 900.0), tok("USDC", 600.0)]),
                               defi("KuCoin Futures Bot", 800.0),
                               defi("Aave V3", -300.0, is_lending=True)]))
    out.append(case("zero_value_rows",
                    holdings=[hold("USDC", 0.0), hold("BTC", 0.0)],
                    spot=[tok("USDC", 0.0), tok("BTC", None)]))
    out.append(case("negative_usd_leg_is_ignored",
                    spot=[tok("USDC", -100.0), tok("BTC", 100.0)]))
    out.append(case("whale",
                    holdings=[hold("BTC", 12_345_678.91), hold("USDC", 987_654.32)],
                    spot=[tok("BTC", 12_345_678.91), tok("USDC", 987_654.32)]))

    # --- rounding ties: percentages that land exactly on x.x5 / x.xx5 ---
    #   122.5/1000 -> 12.25% -> banker's 12.2 (naive rounding would say 12.3)
    out.append(case("rounding_tie_now_pct",
                    holdings=[hold("USDC", 122.5), hold("BTC", 877.5)],
                    spot=[tok("USDC", 122.5), tok("BTC", 877.5)]))
    out.append(case("rounding_tie_eighth",
                    holdings=[hold("USDC", 125.0), hold("BTC", 875.0)],
                    spot=[tok("USDC", 125.0), tok("BTC", 875.0)]))
    out.append(case("rounding_tie_thirty_seven_five",
                    holdings=[hold("USDC", 375.0), hold("BTC", 625.0)],
                    spot=[tok("USDC", 375.0), tok("BTC", 625.0)]))
    out.append(case("rounding_tie_action_usd",
                    holdings=[hold("USDC", 100.125), hold("BTC", 899.875)],
                    spot=[tok("USDC", 100.125), tok("BTC", 899.875)]))
    out.append(case("repeating_thirds",
                    holdings=[hold("USDC", 1.0), hold("BTC", 1.0), hold("ETH", 1.0)],
                    spot=[tok("USDC", 1.0), tok("BTC", 1.0), tok("ETH", 1.0)]))

    # --- custom targets, including a book that sits exactly on the tolerance edge ---
    out.append(case("custom_targets",
                    holdings=[hold("USDC", 200.0), hold("BTC", 300.0),
                              hold("WETH", 300.0, "Liquidity Pool"), hold("PEPE", 200.0)],
                    targets={"reserve": 25, "store": 25, "cashflow": 25, "highrisk": 25},
                    spot=[tok("USDC", 200.0), tok("BTC", 300.0), tok("PEPE", 200.0)],
                    defi_rows=[defi("Uniswap V3", 300.0,
                                    tokens=[tok("WETH", 180.0), tok("USDC", 120.0)])]))
    out.append(case("exactly_on_tolerance_edge",
                    holdings=[hold("USDC", 125.0), hold("BTC", 400.0),
                              hold("JLP", 300.0), hold("PEPE", 175.0)],
                    targets={"reserve": 10, "store": 40, "cashflow": 30, "highrisk": 20}))
    out.append(case("targets_that_do_not_sum_to_100",
                    holdings=[hold("USDC", 500.0), hold("BTC", 500.0)],
                    targets={"reserve": 50, "store": 50, "cashflow": 50, "highrisk": 50}))
    out.append(case("empty_with_custom_targets",
                    targets={"reserve": 5, "store": 60, "cashflow": 25, "highrisk": 10}))
    return out


# ---------- randomized portfolios ----------

def randomized(n, seed=20260614):
    rnd = random.Random(seed)
    out = []
    for i in range(n):
        size = rnd.choice([1, 2, 3, 5, 8, 13])
        holdings, spot, defi_rows = [], [], []
        for _ in range(size):
            sym = rnd.choice(SYMBOLS)
            cat = rnd.choice(CATEGORIES)
            usd = rnd.choice([
                rnd.uniform(0.0001, 1.0),
                rnd.uniform(1.0, 1_000.0),
                rnd.uniform(1_000.0, 500_000.0),
                round(rnd.uniform(0, 1000) * 8) / 8,      # eighths: exact rounding ties
                float(rnd.randint(0, 5_000)),
            ])
            holdings.append(hold(sym, usd, cat))
            kind = rnd.random()
            if kind < 0.45:
                spot.append(tok(sym, usd))
            elif kind < 0.6:
                defi_rows.append(defi(rnd.choice(PROTOCOLS), usd,
                                      tokens=[tok(sym, usd * 0.6),
                                              tok(rnd.choice(SYMBOLS), usd * 0.4)]))
            elif kind < 0.72:
                # a leg the engine could not price -> the whole position lands on token 0
                defi_rows.append(defi(rnd.choice(PROTOCOLS), usd,
                                      tokens=[tok(sym, None), tok(rnd.choice(SYMBOLS), None)]))
            elif kind < 0.82:
                defi_rows.append(defi("KuCoin Futures Bot", usd))
            elif kind < 0.92:
                defi_rows.append(defi("KuCoin Rebalance Bot", usd,
                                      bot_weights=[tok(rnd.choice(SYMBOLS), usd * 0.5),
                                                   tok(rnd.choice(SYMBOLS), usd * 0.5)]))
            else:
                defi_rows.append(defi(rnd.choice(["Aave V3", "Morpho"]), usd, is_lending=True))
        targets = None
        if rnd.random() < 0.3:
            targets = {k: rnd.randint(0, 60) for k in A.TIER_ORDER}
        out.append(case(f"random_{i:03d}", holdings, targets, spot, defi_rows))
    return out


# ---------- classify / norm_sym / envelope / rounding ----------

def classify_cases():
    return [{"symbol": s, "category": c, "tier": A.classify(s, c)}
            for s in SYMBOLS + [None, "usdc", "WbTc", "unknown-token"]
            for c in CATEGORIES]


def norm_sym_cases():
    extra = ["usdc.e", "WSTETH", "wsteth", "xaut", "kau", "btc.b", "MATIC", "matic", "pepe",
             "", "Unknown", "gold", "jitosol"]
    return [{"symbol": s, "normalized": A.norm_sym(s)} for s in SYMBOLS + extra]


def metric(m):
    return m.model_dump(mode="json")


def envelope_cases():
    """The honesty envelope, with the null-with-reason paths first — the property most likely to
    be quietly lost in a port is a metric that comes back 0.0 instead of "cannot be computed"."""
    pool = [{"symbol": "WETH"}, {"symbol": "USDC"}]
    cases = []

    def emission(name, tokens, rewards):
        cases.append({"kind": "emission_dependency", "name": name,
                      "tokens": [{"symbol": t["symbol"], "usd": t.get("usd")} for t in tokens],
                      "rewards": [{"symbol": r["symbol"], "usd": r.get("usd")} for r in rewards],
                      "metric": metric(AN.emission_dependency(
                          {"tokens": tokens, "rewards": rewards}))})

    # --- uncomputable: must be null WITH a reason, never 0.0 ---
    emission("no_rewards_at_all", pool, [])
    emission("no_rewards_key", pool, [])
    emission("all_rewards_worthless", pool, [{"symbol": "NEST", "usd": 0.0}])
    emission("unpriced_rewards", pool, [{"symbol": "NEST", "usd": None}])
    emission("no_pool_tokens_no_rewards", [], [])
    # --- computable ---
    emission("pure_emissions", pool, [{"symbol": "NEST", "usd": 4.0}])
    emission("pure_swap_fees", pool, [{"symbol": "WETH", "usd": 2.0},
                                      {"symbol": "USDC", "usd": 1.0}])
    emission("mixed_quarter", pool, [{"symbol": "WETH", "usd": 3.0},
                                     {"symbol": "NEST", "usd": 1.0}])
    emission("case_insensitive_pool_match", pool, [{"symbol": "weth", "usd": 3.0},
                                                   {"symbol": "nest", "usd": 1.0}])
    emission("repeating_third", pool, [{"symbol": "WETH", "usd": 2.0},
                                       {"symbol": "NEST", "usd": 1.0}])
    emission("tiny_dust", pool, [{"symbol": "WETH", "usd": 1e-7},
                                 {"symbol": "NEST", "usd": 1e-7}])
    emission("many_legs", pool, [{"symbol": "WETH", "usd": 1.234567891},
                                 {"symbol": "USDC", "usd": 0.000000456},
                                 {"symbol": "NEST", "usd": 9.876543219},
                                 {"symbol": "AERO", "usd": 0.5}])

    for name, hf in [("no_debt", None), ("liquidatable", 0.97), ("critical", 1.15),
                     ("low", 1.42), ("healthy", 2.5), ("exactly_one", 1.0),
                     ("rounding_tie", 1.2345), ("huge", 1234.5678)]:
        cases.append({"kind": "lending_health", "name": name, "hf": hf,
                      "metric": metric(AN.lending_health({"hf": hf})),
                      "liquidation_buffer": AN.liquidation_buffer({"hf": hf})})
    return cases


def rounding_cases():
    """Python rounds the exact binary value to nearest-decimal, ties to EVEN. A naive
    `(x*10^n).round()/10^n` disagrees on every tie, and portfolio percentages hit ties often."""
    values = [12.25, 12.35, 0.125, 0.135, 2.675, 2.5, 3.5, -12.25, -0.125, 0.5, 1.5,
              100.005, 0.0005, 1e-7, 1234.5678, 0.1 + 0.2, 1 / 3, 2 / 3, 1e12 + 0.5,
              99.995, 0.9999999, 12.5, 37.5, 62.5, 87.5]
    return [{"value": v, "digits": d, "rounded": round(v, d)}
            for v in values for d in (0, 1, 2, 3, 4, 6)]


def main():
    portfolios = handcrafted() + randomized(60)
    corpus = {
        "generated_by": "crates/lyra-analytics/tests/gen_analytics_corpus.py",
        "tier_order": A.TIER_ORDER,
        "tier_target_default": A.TIER_TARGET_DEFAULT,
        "reb_tol": A.REB_TOL,
        "tier_meta": A.TIERS,
        "stables": sorted(A.STABLES),
        "hard": sorted(A.HARD),
        "yield_tokens": sorted(A.YIELD_TOKENS),
        "no_exposure_note": AN.concentration({})["note"],
        "rounding": rounding_cases(),
        "norm_sym": norm_sym_cases(),
        "classify": classify_cases(),
        "envelope": envelope_cases(),
        "portfolios": portfolios,
    }
    with open(OUT, "w") as fh:
        json.dump(corpus, fh, indent=1, sort_keys=False)
        fh.write("\n")
    print(f"wrote {OUT}")
    print(f"  portfolios      {len(portfolios)}")
    print(f"  classify cases  {len(corpus['classify'])}")
    print(f"  norm_sym cases  {len(corpus['norm_sym'])}")
    print(f"  envelope cases  {len(corpus['envelope'])}")
    print(f"  rounding cases  {len(corpus['rounding'])}")


if __name__ == "__main__":
    main()
