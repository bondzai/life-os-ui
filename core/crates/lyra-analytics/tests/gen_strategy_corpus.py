#!/usr/bin/env python3
"""Generate `strategy_corpus.json` from the REAL Python oracle.

Runs `pow_mcp.analytics.lending_flags`, `.market_timing` and `.strategy` (over plans and
concentrations built by the real `analysis.rebalance_plan` / `analytics.concentration`) across
varied synthetic books, and dumps inputs + expected outputs for the Rust parity test.

Regenerate:

    cd /Users/jamesbond/Desktop/code/home-ai-assistant/wallet-portfolio
    ./.venv/bin/python \\
      /Users/jamesbond/Desktop/code/home-ai-assistant/lyra/core/crates/lyra-analytics/tests/gen_strategy_corpus.py

Coverage is deliberately weighted toward the cases that lose their honesty in a careless port:
MISSING DATA (no sentiment feed, no health factor, no exposure) alongside healthy, thin,
critical and already-liquidatable borrow positions, every posture, and the exact threshold
boundaries (HF 1.0 / 1.2 / 1.5, F&G 25 / 75, concentration 25 / 35, the $25 and 0.5%/1% floors).
"""

import json
import os
import random
import sys

sys.path.insert(0, os.environ.get(
    "WALLET_PORTFOLIO", "/Users/jamesbond/Desktop/code/home-ai-assistant/wallet-portfolio"))

import analysis as A                       # noqa: E402
from pow_mcp import analytics as AN        # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "strategy_corpus.json")


def _encode(obj):
    """Pydantic models (Metric, Flag) -> plain JSON. Confidence is a str-Enum, so json handles it."""
    if hasattr(obj, "model_dump"):
        return obj.model_dump(mode="json")
    raise TypeError(f"cannot encode {type(obj)!r}")


def jsonable(value):
    """Round-trip through the encoder so the corpus holds only plain JSON."""
    return json.loads(json.dumps(value, default=_encode))


# ---------- inputs ----------

def hold(symbol, usd, category=None):
    return {"symbol": symbol, "category": category, "usd": usd}


def lend(protocol, hf, debt_usd):
    return {"protocol": protocol, "hf": hf, "debt_usd": debt_usd}


def plan_for(holdings, targets=None):
    rows = [{"usd": h["usd"], "tier": A.classify(h["symbol"], h["category"])} for h in holdings]
    return A.rebalance_plan(rows, targets)


def concentration_for(exposure):
    """Normalize so every key is always present — the Rust side deserializes a fixed shape."""
    conc = AN.concentration(exposure)
    return {"hhi": conc.get("hhi"), "top_asset": conc.get("top_asset"),
            "top_asset_pct": conc.get("top_asset_pct"),
            "stablecoin_pct": conc.get("stablecoin_pct"), "note": conc.get("note")}


def sentiment_of(index, classification=None):
    if index is None:
        return {}
    return {"fear_greed": {"value": index, "classification": classification}}


# ---------- the three entry points ----------

def lending_flag_cases():
    """Every threshold boundary, plus the missing-data case that produces NO flags — the one the
    port must not turn into a silent all-clear."""
    values = [None, 0.0, 0.5, 0.87, 0.876, 0.999, 0.9999, 1.0, 1.0001, 1.05, 1.15, 1.199,
              1.1999, 1.2, 1.2001, 1.35, 1.499, 1.4999, 1.5, 1.5001, 1.6, 2.0, 2.5, 10.0,
              123.456, 1.005, 1.015, 1.125]
    return [{"hf": hf,
             "flags": jsonable(AN.lending_flags({"hf": hf})),
             "health_factor": jsonable(AN.lending_health({"hf": hf})),
             "liquidation_buffer": AN.liquidation_buffer({"hf": hf})}
            for hf in values]


def market_timing_cases():
    cases = []

    def add(name, sentiment):
        timing = AN.market_timing(sentiment)
        cases.append({"name": name, "sentiment": jsonable(sentiment),
                      "timing": jsonable(timing)})

    # --- no feed at all: must be neutral WITH a reason, never a mid-scale 50 ---
    add("sentiment_none", None)
    add("sentiment_empty", {})
    add("no_fear_greed_key", {"mvrv": 2.1})
    add("fear_greed_empty", {"fear_greed": {}})
    add("fear_greed_null_value", {"fear_greed": {"value": None}})
    add("fear_greed_explicit_null", {"fear_greed": None})
    # --- the boundaries of the contrarian tilt ---
    for index in [0, 1, 10, 24, 25, 26, 50, 73, 74, 75, 76, 90, 99, 100]:
        add(f"index_{index}", sentiment_of(index))
    # --- classification passthrough, and a fractional reading ---
    add("with_classification", sentiment_of(12, "Extreme Fear"))
    add("greed_with_classification", sentiment_of(82, "Extreme Greed"))
    add("fractional_index", sentiment_of(20.5))
    add("fractional_high", sentiment_of(74.5))
    return cases


def strategy_case(name, holdings, exposure, claim_usd, lending, index, net_worth=None,
                  targets=None, concentration=None):
    plan = plan_for(holdings, targets)
    conc = concentration if concentration is not None else concentration_for(exposure)
    timing = AN.market_timing(sentiment_of(index))
    nw = plan["total_usd"] if net_worth is None else net_worth
    signals, actions = AN.strategy(plan, conc, claim_usd, lending, timing, nw)
    return {
        "name": name,
        "plan": jsonable(plan),
        "concentration": jsonable(conc),
        "claim_usd": claim_usd,
        "lending": lending,
        "sentiment": jsonable(sentiment_of(index)),
        "timing": jsonable(timing),
        "net_worth": nw,
        "expected": {"signals": jsonable(signals), "actions": jsonable(actions)},
    }


def handcrafted_strategies():
    out = []
    even = [hold("USDC", 2500.0), hold("BTC", 2500.0), hold("JLP", 2500.0), hold("PEPE", 2500.0)]
    even_exp = {"USDC": 2500.0, "BTC": 2500.0, "SOL": 2500.0, "PEPE": 2500.0}
    store_heavy = [hold("BTC", 9000.0), hold("USDC", 1000.0)]
    store_exp = {"BTC": 9000.0, "USDC": 1000.0}
    stables_only = [hold("USDC", 10_000.0)]
    stables_exp = {"USDC": 10_000.0}

    # --- the empty book: nothing to say, and it must say it honestly ---
    out.append(strategy_case("empty_book", [], {}, 0.0, [], None, net_worth=0.0))
    out.append(strategy_case("empty_book_with_feed", [], {}, 0.0, [], 50, net_worth=0.0))

    # --- no sentiment feed on a real book: the tilt is absent, not neutral-by-default ---
    out.append(strategy_case("no_feed_real_book", store_heavy, store_exp, 300.0,
                             [lend("Aave V3", 1.9, 2000.0)], None))

    # --- borrow risk across every band ---
    for label, hf in [("healthy", 2.5), ("safe_edge", 1.5), ("just_under", 1.4999),
                      ("low", 1.45), ("critical", 1.15), ("at_one", 1.0),
                      ("liquidatable", 0.92)]:
        out.append(strategy_case(f"borrow_{label}", even, even_exp, 0.0,
                                 [lend("Aave V3", hf, 3000.0)], 50))
    # --- missing health factors: alone, and mixed with a real one ---
    out.append(strategy_case("borrow_hf_missing", even, even_exp, 0.0,
                             [lend("Morpho", None, 5000.0)], 50))
    out.append(strategy_case("borrow_hf_missing_and_thin", even, even_exp, 0.0,
                             [lend("Morpho", None, 5000.0), lend("Aave V3", 1.3, 2000.0)], 50))
    out.append(strategy_case("borrow_all_hf_missing", even, even_exp, 0.0,
                             [lend("Morpho", None, 0.0), lend("Compound III", None, 0.0)], 50))
    # --- worst-of selection, including an exact tie (first wins) ---
    out.append(strategy_case("borrow_worst_of_three", even, even_exp, 0.0,
                             [lend("Aave V3", 1.45, 1000.0), lend("Morpho", 1.1, 2000.0),
                              lend("Compound III", 2.0, 500.0)], 50))
    out.append(strategy_case("borrow_tie_first_wins", even, even_exp, 0.0,
                             [lend("Aave V3", 1.2, 1000.0), lend("Morpho", 1.2, 9000.0)], 50))
    out.append(strategy_case("borrow_zero_debt_thin_hf", even, even_exp, 0.0,
                             [lend("Aave V3", 1.1, 0.0)], 50))

    # --- harvest floors: $25 absolute and 0.5% of net worth ---
    for claim in [0.0, 24.99, 25.0, 25.01, 49.0, 50.0, 51.0, 500.0]:
        out.append(strategy_case(f"harvest_{claim}", even, even_exp, claim, [], 50))
    out.append(strategy_case("harvest_below_pct_floor", even, even_exp, 400.0, [], 50,
                             net_worth=100_000.0))
    out.append(strategy_case("harvest_at_pct_floor", even, even_exp, 500.0, [], 50,
                             net_worth=100_000.0))

    # --- posture × book: where the harvest goes, and what gets proposed ---
    for index in [10, 25, 30, 50, 74, 75, 90]:
        out.append(strategy_case(f"posture_{index}_store_heavy", store_heavy, store_exp,
                                 400.0, [], index))
        out.append(strategy_case(f"posture_{index}_stables_only", stables_only, stables_exp,
                                 400.0, [], index))
        out.append(strategy_case(f"posture_{index}_even", even, even_exp, 400.0, [], index))
    # fear + underweight store -> DCA into blue chips
    out.append(strategy_case("fear_store_underweight", stables_only, stables_exp, 1000.0, [], 5))
    # greed + underweight high risk -> signal but no action
    out.append(strategy_case("greed_highrisk_underweight", store_heavy, store_exp, 0.0, [], 95))

    # --- concentration thresholds, driven by synthetic concentration blocks ---
    for pct in [0.0, 24.9, 25.0, 25.1, 34.9, 35.0, 35.1, 50.0, 99.9, 100.0]:
        out.append(strategy_case(
            f"concentration_{pct}", even, even_exp, 0.0, [], 50,
            concentration={"hhi": round(pct / 100 * pct / 100, 3), "top_asset": "BTC",
                           "top_asset_pct": pct, "stablecoin_pct": 10.0, "note": "x"}))
    out.append(strategy_case(
        "concentration_unmeasurable", even, even_exp, 0.0, [], 50,
        concentration={"hhi": None, "top_asset": None, "top_asset_pct": None,
                       "stablecoin_pct": None, "note": "no exposure to measure"}))

    # --- material threshold: 1% of net worth suppresses trivial drift legs ---
    out.append(strategy_case("material_suppresses_small_legs", even, even_exp, 0.0, [], 50,
                             net_worth=10_000_000.0))
    out.append(strategy_case("tiny_book_uses_absolute_floor",
                             [hold("USDC", 30.0), hold("BTC", 70.0)], {"USDC": 30.0, "BTC": 70.0},
                             0.0, [], 50))

    # --- custom targets, including fractional ones (which render differently in the strings) ---
    out.append(strategy_case("custom_targets", even, even_exp, 300.0, [], 50,
                             targets={"reserve": 25, "store": 25, "cashflow": 25,
                                      "highrisk": 25}))
    out.append(strategy_case("fractional_targets", even, even_exp, 300.0, [], 50,
                             targets={"reserve": 12.5, "store": 37.5, "cashflow": 30,
                                      "highrisk": 20}))

    # --- everything at once ---
    out.append(strategy_case(
        "kitchen_sink",
        [hold("USDC", 1200.0), hold("BTC", 40_000.0), hold("ETH", 12_000.0),
         hold("WETH", 8000.0, "Liquidity Pool"), hold("PEPE", 3000.0), hold("sUSDe", 2000.0)],
        {"BTC": 40_000.0, "ETH": 20_000.0, "USDC": 3200.0, "PEPE": 3000.0},
        1234.56,
        [lend("Aave V3", 1.12, 15_000.0), lend("Morpho", None, 0.0),
         lend("Compound III", 3.4, 1000.0)],
        8, net_worth=66_200.0))
    return out


def randomized_strategies(n, seed=20260815):
    rnd = random.Random(seed)
    symbols = ["USDC", "USDT", "BTC", "WBTC", "ETH", "wstETH", "JLP", "sUSDe", "PEPE", "ARB"]
    protocols = ["Aave V3", "Morpho", "Compound III"]
    out = []
    for i in range(n):
        holdings, exposure = [], {}
        for _ in range(rnd.randint(1, 6)):
            sym = rnd.choice(symbols)
            usd = rnd.choice([rnd.uniform(1, 500), rnd.uniform(500, 50_000),
                              float(rnd.randint(0, 20_000)),
                              round(rnd.uniform(0, 5000) * 8) / 8])
            holdings.append(hold(sym, usd))
            exposure[A.norm_sym(sym)] = exposure.get(A.norm_sym(sym), 0) + usd
        lending = []
        for _ in range(rnd.randint(0, 3)):
            hf = rnd.choice([None, rnd.uniform(0.5, 3.0), 1.0, 1.2, 1.5,
                             round(rnd.uniform(0.8, 2.0), 2)])
            lending.append(lend(rnd.choice(protocols), hf,
                                rnd.choice([0.0, rnd.uniform(1, 50_000)])))
        index = rnd.choice([None, 0, 5, 20, 25, 40, 50, 60, 74, 75, 88, 100,
                            rnd.randint(0, 100)])
        claim = rnd.choice([0.0, rnd.uniform(0, 30), rnd.uniform(25, 5000),
                            float(rnd.randint(0, 2000))])
        targets = None
        if rnd.random() < 0.25:
            targets = {k: rnd.randint(0, 60) for k in A.TIER_ORDER}
        net_worth = None if rnd.random() < 0.7 else rnd.uniform(0, 500_000)
        out.append(strategy_case(f"random_{i:03d}", holdings, exposure, claim, lending, index,
                                 net_worth=net_worth, targets=targets))
    return out


def main():
    strategies = handcrafted_strategies() + randomized_strategies(120)
    corpus = {
        "generated_by": "crates/lyra-analytics/tests/gen_strategy_corpus.py",
        "thresholds": {
            "harvest_floor_usd": AN._HARVEST_FLOOR_USD,
            "harvest_floor_pct": AN._HARVEST_FLOOR_PCT,
            "material_pct": AN._MATERIAL_PCT,
            "conc_watch": AN._CONC_WATCH,
            "conc_warn": AN._CONC_WARN,
            "hf_safe": AN._HF_SAFE,
            "hf_target": AN._HF_TARGET,
        },
        "lending_flags": lending_flag_cases(),
        "market_timing": market_timing_cases(),
        "strategies": strategies,
    }
    with open(OUT, "w") as fh:
        json.dump(corpus, fh, indent=1, sort_keys=False)
        fh.write("\n")
    print(f"wrote {OUT}")
    print(f"  lending_flags cases  {len(corpus['lending_flags'])}")
    print(f"  market_timing cases  {len(corpus['market_timing'])}")
    print(f"  strategy cases       {len(strategies)}")
    print(f"  signals + actions    "
          f"{sum(len(c['expected']['signals']) + len(c['expected']['actions']) for c in strategies)}")


if __name__ == "__main__":
    main()
