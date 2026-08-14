#!/usr/bin/env python3
"""Generate `lp_corpus.json` from the Python oracle (`wallet-portfolio/portfolio.py`).

The concentrated-liquidity maths is the highest-risk code in the port — it turns an opaque
`liquidity` integer into the token amounts every LP valuation is built from — and it is also
completely pure, so it can be differentially tested exhaustively offline with no chain access.

Design notes, because a few things here are deliberate rather than arbitrary:

* `sqrtP` is dumped as **hex**, not as a JSON number. On chain it is a `uint160`, whose maximum
  (the sqrt ratio at tick 887272, ~1.46e48) does not fit in `u128` — writing it as a float in the
  corpus would round it *before* Rust ever saw it and would quietly hide the very truncation bug
  this file exists to catch. Rust parses it back with `lp_math::u256_hex_to_f64`.
* Liquidity is dumped as a decimal string for the same reason (it is a `uint128`).
* The `sqrtP` grid deliberately includes the exact branch seams — `int(sqrtA)`, `int(sqrtA)+1`,
  `int(sqrtB)-1`, `int(sqrtB)` — because Python compares an exact int against a float *exactly*
  while Rust compares after rounding to f64, so those are the only inputs where the two can pick
  different branches. The Rust side asserts the results still agree, which is the real claim:
  the piecewise function is continuous at both seams.
* `_lp_range` can raise (OverflowError is caught internally, but a caller-supplied
  `tickL > tickU` would reach a ZeroDivisionError), so every case is wrapped and the outcome
  recorded, forcing the Rust side to make a deliberate decision rather than accidentally match.
* `allow_nan=False` on the dump: serde_json rejects `Infinity`/`NaN`, and a leak of either would
  mean the port's finite-ness handling is wrong, so we want it to fail loudly here.

Run from the wallet-portfolio directory:

    .venv/bin/python <path-to-this-file> > .../tests/lp_corpus.json
"""

import json
import math
import sys

import portfolio as p

MAX_TICK = 887_272


def sqrt_ratio_cases():
    """`_sqrt_ratio_at_tick` across the entire valid tick domain."""
    ticks = set()
    # The bounds and their immediate neighbours, where a naive port is most likely to break.
    for edge in (0, MAX_TICK, -MAX_TICK):
        for d in (-2, -1, 0, 1, 2):
            ticks.add(edge + d)
    # A dense sweep of the whole range, hitting both parities of `tick / 2`.
    ticks.update(range(-MAX_TICK, MAX_TICK + 1, 4001))
    # Real-world pool ticks (WETH/USDC-shaped, stablecoin-shaped).
    ticks.update([-202_000, -199_000, -196_000, -60, -1, 1, 60, 200, 887_271])
    return [{"tick": t, "sqrt": p._sqrt_ratio_at_tick(t)} for t in sorted(ticks)]


# (tickLower, tickUpper) pairs: full range, real WETH/USDC bands, stablecoin-tight bands,
# degenerate one-tick bands, and bands pinned against each bound.
RANGES = [
    (-MAX_TICK, MAX_TICK),
    (-202_000, -196_000),
    (196_000, 202_000),
    (-1_000, 1_000),
    (-60, 60),
    (0, 1),
    (100_000, 200_000),
    (-MAX_TICK, 0),
    (0, MAX_TICK),
    (887_271, MAX_TICK),
]

# Liquidity values spanning the uint128 domain, including both sides of the f64 exact-integer
# boundary (2**53) where the `int -> float` coercion starts rounding.
LIQUIDITIES = [
    0,
    1,
    1_000,
    10**6,
    10**12,
    2**53,
    2**53 + 1,
    2**64,
    2**96,
    2**127,
    2**128 - 1,
]


def sqrt_price_probes(sqrt_a, sqrt_b):
    """Integer sqrtP values placed below / on / inside / on / above the range seams."""
    a, b = int(sqrt_a), int(sqrt_b)
    probes = [
        max(1, a // 2),          # clearly below
        a,                       # exactly on the lower seam
        a + 1,                   # one integer step above it (rounds back to `a` in f64)
        max(a + 1, int(math.sqrt(sqrt_a) * math.sqrt(sqrt_b))),  # geometric middle
        max(a + 1, b - 1),       # one integer step below the upper seam
        b,                       # exactly on the upper seam
        b * 2,                   # clearly above
    ]
    return [x for x in probes if x > 0]


def amount_cases():
    """`_amounts_from_liquidity` over ranges x liquidity x sqrtP position."""
    cases = []
    for tl, tu in RANGES:
        sqrt_a = p._sqrt_ratio_at_tick(tl)
        sqrt_b = p._sqrt_ratio_at_tick(tu)
        for sqrt_p in sqrt_price_probes(sqrt_a, sqrt_b):
            for liq in LIQUIDITIES:
                amt0, amt1 = p._amounts_from_liquidity(liq, sqrt_p, sqrt_a, sqrt_b)
                cases.append({
                    "tick_lower": tl,
                    "tick_upper": tu,
                    "liquidity": str(liq),
                    "sqrt_p_hex": hex(sqrt_p),
                    "amt0": amt0,
                    "amt1": amt1,
                })
    return cases


# Decimal pairs seen in the wild: 18/18 (WETH/WBTC-ish), 18/6 (WETH/USDC), 8/18 (WBTC/WETH),
# and the 0-decimal edge, plus both orientations of each so the inversion branch is exercised.
DECIMALS = [(18, 18), (18, 6), (6, 18), (8, 18), (18, 8), (6, 6), (0, 18), (18, 0)]


def lp_range_cases():
    """`_lp_range` over bands x current tick x decimals."""
    bands = RANGES + [
        (-9_000_000, 0),      # lower edge underflows f64 to 0.0
        (0, 9_000_000),       # upper edge overflows -> OverflowError -> inf
        (-MAX_TICK, -800_000),
        (800_000, MAX_TICK),
    ]
    cases = []
    for tl, tu in bands:
        curs = [tl, tu, (tl + tu) // 2, tl - 5_000, tu + 5_000, 0]
        for cur in curs:
            for d0, d1 in DECIMALS:
                lp = p._LP(q0=0, q1=0, d0=d0, d1=d1, s0="AAA", s1="BBB",
                           pr0=0, pr1=0, ch0=None, ch1=None)
                case = {"tick_lower": tl, "tick_upper": tu, "cur_tick": cur,
                        "d0": d0, "d1": d1, "s0": "AAA", "s1": "BBB"}
                try:
                    band = p._lp_range(tl, tu, cur, lp)
                except Exception as e:                    # noqa: BLE001 - recording, not handling
                    case["error"] = type(e).__name__
                else:
                    case["error"] = None
                    case.update(band)
                cases.append(case)
    return cases


def blend_cases():
    """`_blend_change` over values x changes, including the falsy-zero and cancelling totals."""
    values = [0.0, 1e-9, 1.0, 100.0, 1e6, -50.0]
    changes = [None, 0.0, 5.5, -3.25]
    cases = []
    for v0 in values:
        for c0 in changes:
            for v1 in values:
                for c1 in changes:
                    out = p._blend_change(v0, c0, v1, c1)
                    cases.append({"v0": v0, "c0": c0, "v1": v1, "c1": c1, "out": out})
    return cases


def s24_cases():
    """`_s24` across the whole 24-bit domain."""
    xs = set()
    for edge in (0, 1 << 23, 1 << 24):
        for d in (-2, -1, 0, 1, 2):
            x = edge + d
            if 0 <= x < (1 << 24):
                xs.add(x)
    xs.update(range(0, 1 << 24, 55_924))
    # The Uniswap tick bounds as a v4 PositionInfo word would carry them.
    xs.update([MAX_TICK, (-MAX_TICK) & 0xFFFFFF, 0xFFFFFF, 0xFFFFFE])
    return [{"x": x, "out": p._s24(x)} for x in sorted(xs)]


def fee_spacing_cases():
    fees = [0, 1, 100, 101, 400, 500, 501, 3_000, 3_001, 10_000, 10_001, 100_000, (1 << 24) - 1]
    return [{"fee": f, "spacing": p._FEE_TICK_SPACING.get(f)} for f in fees]


def u256_cases():
    """Reference `int -> float` conversions, pinning `u256_hex_to_f64` against Python's own."""
    vals = [0, 1, 255, 2**53 - 1, 2**53, 2**53 + 1, 2**64, 2**96, 2**127,
            2**128 - 1, 2**128, 2**160 - 1, 2**200, 2**255, 2**256 - 1]
    # Every sqrt ratio the amount cases actually feed in, so the parser is tested on real inputs.
    for tl, tu in RANGES:
        vals.append(int(p._sqrt_ratio_at_tick(tl)))
        vals.append(int(p._sqrt_ratio_at_tick(tu)))
    return [{"hex": hex(v), "f": float(v)} for v in sorted(set(vals))]


def main():
    corpus = {
        "sqrt_ratio": sqrt_ratio_cases(),
        "amounts": amount_cases(),
        "lp_range": lp_range_cases(),
        "blend": blend_cases(),
        "s24": s24_cases(),
        "fee_spacing": fee_spacing_cases(),
        "u256": u256_cases(),
    }
    total = sum(len(v) for v in corpus.values())
    print(f"corpus: {total} cases " +
          " ".join(f"{k}={len(v)}" for k, v in corpus.items()), file=sys.stderr)
    # allow_nan=False: serde_json cannot read Infinity/NaN, and a leak of either would mean the
    # port's finite-ness handling is wrong. Fail here rather than silently emit unparseable JSON.
    json.dump(corpus, sys.stdout, allow_nan=False, indent=1)


if __name__ == "__main__":
    main()
