#!/usr/bin/env python3
"""Generate `market_corpus.json` from the Python oracle (`wallet-portfolio/portfolio.py`).

The market-context maths is pure — a price (or a metric reading) in, a band/zone out — so it can
be compared exhaustively offline with no network and no flakiness. That is the whole reason these
functions were split out of the networked fetchers in the Rust port.

Two wrinkles this script works around:

* `btc_rainbow` reads `date.today()`, so its answer drifts daily. Rather than freeze the clock we
  shift `BTC_GENESIS` to `today - N`, which makes `days` exactly `N` — that both pins the corpus
  and sweeps the fair-value curve across the whole history of the model.
* `_zoned` uses `next(...)` with no default, so a value at or above the top zone's bound raises
  `StopIteration` instead of returning. We catch it and record the fact, so the Rust side has to
  make a deliberate decision about it rather than accidentally matching.

**Every float is emitted as a decimal string, not a JSON number.** `serde_json` parses floats with
a fast path that is off by up to one ULP unless the `float_roundtrip` feature is on, and a corpus
built entirely of band edges and their neighbours is exactly the input that exposes it — a value
one ULP below an edge would load as the edge itself and read as a porting bug. `repr(float)` is
shortest-round-trip in Python and Rust's `str::parse::<f64>` is correctly rounded, so a string
round-trips the exact bits with no dependency change.

Run from the wallet-portfolio directory:

    PYTHONPATH=. .venv/bin/python <path-to-this-file> > .../tests/market_corpus.json
"""

import json
import math
import sys
from datetime import date, timedelta

import portfolio as p

# Day counts to evaluate the rainbow at. `1` is the degenerate edge (log(1) == 0), the middle
# values bracket the real deployment window, and 20000 runs the model far past today.
DAY_COUNTS = [1, 2, 100, 1000, 4000, 5000, 6000, 6500, 7000, 10000, 20000]

# Prices to sweep. Geometric coverage gets the orders of magnitude; the linear points catch
# anything that only misbehaves at round numbers.
BASE_PRICES = (
    [1_000 * (1.5**i) for i in range(20)]
    + [1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000,
       1_000_000, 2_000_000]
    + [0.0, 1e-9, 0.5, 1.0, 12.34, 1e12]
    + [-1.0, -100_000.0]
)


def f(x):
    """A float as a bit-exact decimal string (see the module docstring for why not a JSON number)."""
    return None if x is None else repr(float(x))


def band_json(band):
    """`btc_rainbow`'s dict with its floats stringified."""
    if band is None:
        return None
    return {**band, "ratio": f(band["ratio"])}


def zone_json(zone):
    """`_zoned`'s dict with its floats stringified."""
    return None if zone is None else {**zone, "value": f(zone["value"])}


def neighbours(x):
    """`x` and its immediate float neighbours — a band edge is only interesting one ULP wide."""
    if x == 0 or not math.isfinite(x):
        return [x]
    return [math.nextafter(x, -math.inf), x, math.nextafter(x, math.inf)]


def rainbow_cases():
    """`btc_rainbow` over prices × day counts, with every band edge hit exactly."""
    real_genesis = p.BTC_GENESIS
    today = date.today()
    out = []
    try:
        for days in DAY_COUNTS:
            p.BTC_GENESIS = today - timedelta(days=days)
            fair = 10 ** (2.66167155005961 * math.log(days) - 17.9183761889864)

            prices = list(BASE_PRICES)
            # The load-bearing cases: the exact price at which each band starts, and one ULP
            # either side of it. `ratio >= thr` inclusive vs exclusive shows up only here.
            for thr, _label, _color in p._RAINBOW:
                prices += neighbours(thr * fair)
            prices += neighbours(fair)

            for price in prices:
                if not math.isfinite(price):
                    continue
                out.append({
                    "days": days,
                    "price": f(price),
                    "band": band_json(p.btc_rainbow(price)),
                })
    finally:
        p.BTC_GENESIS = real_genesis
    return out


ZONE_SETS = [
    ("mvrv_zscore", p._MVRV_ZONES, 2),
    ("sopr", p._SOPR_ZONES, 3),
    ("puell", p._PUELL_ZONES, 2),
]


def zone_cases():
    """`_zoned` over each metric's bounds, one ULP either side, plus the far tails."""
    out = []
    for metric, zones, dp in ZONE_SETS:
        values = [None, 0.0, -1.0, -1e6, 0.123456789, 1e8]
        for hi, _label, _color in zones:
            values += neighbours(hi)
            values += [hi / 2, hi * 0.999, hi * 1.001]
        # Rounding edges: half-way values are where a naive `(x*100).round()/100` diverges from
        # Python's round-half-to-even.
        values += [0.125, 0.375, 2.675, 1.0005, 0.0625, 1.005, 2.5, 3.5]
        # Deliberately past the top bound, where the Python raises. (Infinity is covered by a
        # hand-written Rust test instead — JSON has no way to spell it.)
        values += [1e9, 1e9 + 1, 1e12]

        for value in values:
            if value is not None and math.isnan(value):
                continue
            case = {"metric": metric, "dp": dp, "value": f(value), "raises": False, "zone": None}
            try:
                case["zone"] = zone_json(p._zoned(value, zones, dp))
            except StopIteration:
                case["raises"] = True
            out.append(case)
    return out


def main():
    corpus = {
        "generated_by": "market_corpus_gen.py",
        "genesis": p.BTC_GENESIS.isoformat(),
        "rainbow_bands": [
            {"min_ratio": f(thr), "label": label, "color": color}
            for thr, label, color in p._RAINBOW
        ],
        "zone_sets": {
            metric: [{"upper": f(hi), "label": label, "color": color} for hi, label, color in zones]
            for metric, zones, _dp in ZONE_SETS
        },
        "rainbow": rainbow_cases(),
        "zoned": zone_cases(),
    }
    json.dump(corpus, sys.stdout)
    print(file=sys.stderr)
    print(f"rainbow cases: {len(corpus['rainbow'])}", file=sys.stderr)
    print(f"zoned cases:   {len(corpus['zoned'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
