//! Uniswap-style concentrated-liquidity maths — port of `portfolio.py:545-615` and `:801`.
//!
//! Shared by Uniswap v3, Uniswap v4, and the v3 forks (Aerodrome Slipstream). This is the
//! highest-risk arithmetic in the portfolio: it turns an opaque `liquidity` integer into the
//! token amounts every LP valuation is built from, and a wrong answer here looks exactly like a
//! right one.
//!
//! # Why this module is deliberately `f64`
//!
//! The Python oracle computes sqrt ratios as *floats* (`_sqrt_ratio_at_tick` returns
//! `1.0001**(tick/2) * 2**96`, a `float`, with the comment "float is precise enough for display
//! value"). Because `sqrtA`/`sqrtB` are floats, every mixed int/float operation downstream in
//! `_amounts_from_liquidity` is promoted to `float` by CPython before it is evaluated. So the
//! effective arithmetic is IEEE-754 binary64 end to end, and `f64` here is a faithful port, not
//! a shortcut.
//!
//! Choosing an integer type instead would be the actual trap: an on-chain `sqrtPriceX96` is a
//! **uint160**, whose maximum (≈1.46e48, the sqrt ratio at tick 887272) is far beyond `u128::MAX`
//! (≈3.40e38). Anyone reaching for `u128::from_str_radix` on a slot0 value gets a silent wrong
//! answer for high-priced pools. [`u256_hex_to_f64`] exists precisely so callers never have to,
//! and it widens through an explicit `u128` pair rather than truncating.
//!
//! Liquidity *is* a uint128 and is taken as one; the `u128 -> f64` rounding at the multiply is
//! exactly the `int -> float` coercion CPython performs at the same point.
//!
//! # What is NOT ported here
//!
//! This is display/valuation maths, not swap maths. It must never be used to compute a
//! settlement amount — Uniswap's on-chain `LiquidityAmounts` library is exact integer maths and
//! rounds deliberately; this rounds to nearest at every step.

/// `2**96`, the Uniswap Q64.96 fixed-point scale. Exactly representable in `f64` (a pure power
/// of two), so this constant introduces no error of its own.
pub const Q96: f64 = 79_228_162_514_264_337_593_543_950_336.0;

/// `2**128`, used to recombine an explicitly widened `u128` pair. Also exact in `f64`.
const TWO_POW_128: f64 = 340_282_366_920_938_463_463_374_607_431_768_211_456.0;

/// The tick at which Uniswap's sqrt-ratio maths is defined; `[-MAX_TICK, MAX_TICK]` is the whole
/// valid domain. Kept for callers and tests — the Python never bounds-checks, and neither do we,
/// because a pool that somehow reports a wilder tick should still value rather than panic.
pub const MAX_TICK: i32 = 887_272;

/// Value-weighted 24h change of a two-token position — `portfolio.py:_blend_change`.
///
/// `None` when neither leg has price-change data. Mirrors the Python's `c0 or 0` (a missing
/// *and* a genuinely zero change both contribute nothing) and its `if tv else None` guard, where
/// a total value of zero — including `-0.0` — yields `None` rather than a division by zero.
pub fn blend_change(v0: f64, c0: Option<f64>, v1: f64, c1: Option<f64>) -> Option<f64> {
    if c0.is_none() && c1.is_none() {
        return None;
    }
    let tv = v0 + v1;
    if tv == 0.0 {
        // `== 0.0` is true for `-0.0` too, matching Python's falsy-zero check.
        return None;
    }
    Some((v0 * c0.unwrap_or(0.0) + v1 * c1.unwrap_or(0.0)) / tv)
}

/// `sqrt(1.0001^tick) * 2^96` — `portfolio.py:_sqrt_ratio_at_tick`.
///
/// Note this is *not* Uniswap's exact `TickMath.getSqrtRatioAtX96` (a 256-bit integer routine).
/// The Python deliberately uses the float form, and the two agree to ~1e-15 relative, which is
/// invisible next to the price feeds this feeds into. Ported as-is so parity holds.
///
/// `tick / 2` is exact: every `i32` tick converts to `f64` without loss, and halving only
/// decrements the exponent.
pub fn sqrt_ratio_at_tick(tick: i32) -> f64 {
    1.0001f64.powf(f64::from(tick) / 2.0) * Q96
}

/// Convert liquidity to token0/token1 amounts — `portfolio.py:_amounts_from_liquidity`.
///
/// Returns raw (undecimalised) amounts, exactly as the Python does; the caller divides by
/// `10**decimals`.
///
/// # Branch boundaries
///
/// Python holds `sqrtP` as an exact arbitrary-precision int and compares it against the float
/// `sqrtA`/`sqrtB` *exactly*; we compare after rounding `sqrtP` to `f64`. The two can therefore
/// pick different branches for a `sqrtP` within one ULP of a boundary. This is provably harmless
/// because the piecewise function is **continuous** at both seams:
///
/// - at `sqrtP == sqrtA`: the in-range arm gives `amt0 = L*(sqrtB-sqrtA)/(sqrtA*sqrtB)*Q96`
///   (identical to the below-range arm) and `amt1 = L*(sqrtP-sqrtA)/Q96 = 0` (identical too);
/// - at `sqrtP == sqrtB`: the in-range arm gives `amt0 = L*(sqrtB-sqrtB)/... = 0` and
///   `amt1 = L*(sqrtB-sqrtA)/Q96`, which is exactly the above-range arm.
///
/// So a differing branch choice changes the result by at most a rounding step, never by a token.
/// `lp_parity.rs` pins this with cases placed exactly on both seams.
pub fn amounts_from_liquidity(
    liquidity: u128,
    sqrt_p: f64,
    sqrt_a: f64,
    sqrt_b: f64,
) -> (f64, f64) {
    let (sqrt_a, sqrt_b) = if sqrt_a > sqrt_b {
        (sqrt_b, sqrt_a)
    } else {
        (sqrt_a, sqrt_b)
    };
    // The same `int -> float` coercion CPython applies at the first multiply. Above 2^53 this
    // rounds, and Python rounds identically at the identical point.
    let l = liquidity as f64;

    if sqrt_p <= sqrt_a {
        // Price below the range: the position is entirely token0.
        (l * (sqrt_b - sqrt_a) / (sqrt_a * sqrt_b) * Q96, 0.0)
    } else if sqrt_p < sqrt_b {
        // In range: both tokens.
        (
            l * (sqrt_b - sqrt_p) / (sqrt_p * sqrt_b) * Q96,
            l * (sqrt_p - sqrt_a) / Q96,
        )
    } else {
        // Price above the range: entirely token1.
        (0.0, l * (sqrt_b - sqrt_a) / Q96)
    }
}

/// The human-readable price band of a concentrated-LP position — `portfolio.py:_lp_range`.
///
/// Borrows the symbols rather than owning them, matching the style of `spam::TokenInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct PriceBand<'a> {
    /// Lower edge of the band, `None` when it is not finite.
    pub lower: Option<f64>,
    /// Upper edge of the band, `None` when it is not finite.
    pub upper: Option<f64>,
    /// Where the market sits now, `None` when it is not finite.
    pub cur: Option<f64>,
    /// The token the price is quoted *in terms of*.
    pub base: &'a str,
    /// The token the price is quoted *in*.
    pub quote: &'a str,
    /// Whether the position is effectively full-range / unbounded, so the UI hides the band.
    pub full: bool,
}

/// Price band of a concentrated-LP position, oriented quote-per-base for readability.
///
/// `dec0`/`dec1` are the token decimals and `sym0`/`sym1` their symbols — the fields the Python
/// reads off its `_LP` namedtuple.
///
/// # Infinity handling
///
/// Python computes `1.0001 ** t`, which raises `OverflowError` past `t ≈ 7.1e6` and is caught and
/// replaced with `math.inf`; IEEE-754 saturates to `+inf` at the same point, so the two agree
/// without a fallible path. Underflow (very negative ticks) silently yields `0.0` in both. The
/// one place this could diverge is `0.0 * inf = NaN`, reachable only if `dec0 - dec1 >= 309`;
/// since decimals are a `uint8`, that needs a 309-decimal token, but the guard below costs one
/// comparison and makes the port total rather than merely-unreachable-in-practice.
pub fn lp_range<'a>(
    tick_lower: i32,
    tick_upper: i32,
    cur_tick: i32,
    dec0: i32,
    dec1: i32,
    sym0: &'a str,
    sym1: &'a str,
) -> PriceBand<'a> {
    // Decimal adjustment: token1 per token0.
    let f = 10f64.powi(dec0 - dec1);
    let price = |t: i32| -> f64 {
        if f.is_infinite() {
            // Python raises OverflowError converting the huge int `10**e` and substitutes inf.
            return f64::INFINITY;
        }
        1.0001f64.powf(f64::from(t)) * f
    };

    let (mut lo, mut hi, mut cur) = (price(tick_lower), price(tick_upper), price(cur_tick));
    let (mut base, mut quote) = (sym0, sym1);

    // Invert sub-1 prices so the number reads naturally ("3,200 USDC per ETH", not "0.0003").
    if cur > 0.0 && cur < 1.0 && lo != 0.0 && hi != f64::INFINITY {
        (lo, hi, cur) = (1.0 / hi, 1.0 / lo, 1.0 / cur);
        (base, quote) = (sym1, sym0);
    }

    // `lo == 0.0` is checked first so the `hi / lo` below is never a 0/0: Python relies on the
    // same short-circuit to avoid a ZeroDivisionError.
    let full = lo == 0.0 || hi == f64::INFINITY || hi / lo > 1e9;

    let fin = |x: f64| if x.is_finite() { Some(x) } else { None };
    PriceBand {
        lower: fin(lo),
        upper: fin(hi),
        cur: fin(cur),
        base,
        quote,
        full,
    }
}

/// Uniswap v3 fee tier (in hundredths of a bip) to tick spacing — `portfolio.py:_FEE_TICK_SPACING`.
///
/// A `match` rather than a map: the table is closed, four entries, and the Python's `.get`
/// returning `None` for an unknown tier maps straight onto `Option`. The frontend renders the
/// result as the "CL{spacing}" label vfat.io and friends use for a pool.
pub fn fee_tick_spacing(fee: u32) -> Option<i32> {
    match fee {
        100 => Some(1),
        500 => Some(10),
        3000 => Some(60),
        10000 => Some(200),
        _ => None,
    }
}

/// Interpret a 24-bit uint as `int24` (two's complement) — `portfolio.py:_s24`.
///
/// Used to unpack the tick pair out of a Uniswap v4 `PositionInfo` word. Computed in `i64` so the
/// subtraction cannot wrap, then narrowed with a checked conversion: for any value in the
/// documented 24-bit domain the result lands in `[-2^23, 2^23)`, comfortably inside `i32`, so the
/// `expect` is unreachable for well-formed input and loud rather than silent for anything else.
/// Python would happily return a big int here; silently truncating instead would corrupt a tick.
pub fn s24(x: u32) -> i32 {
    let x = i64::from(x);
    let v = if x >= 1 << 23 { x - (1 << 24) } else { x };
    i32::try_from(v).expect("s24 input must be a 24-bit uint")
}

/// Parse an arbitrary-width unsigned hex integer (up to 256 bits) to the nearest `f64`.
///
/// Exists because an on-chain `sqrtPriceX96` is a **uint160** and does not fit in `u128`; this is
/// the lossless-until-the-last-step path from an RPC hex string into the `f64` maths above.
/// Accumulation is done in an explicit `(hi, lo)` `u128` pair — full 256-bit precision, with
/// `checked_mul` rejecting anything wider instead of wrapping — and only the final recombination
/// rounds, giving well under 1e-15 relative error.
///
/// Accepts an optional `0x` prefix. Returns `None` for empty input, a non-hex digit, or a value
/// that does not fit in 256 bits.
pub fn u256_hex_to_f64(hex: &str) -> Option<f64> {
    let s = hex.trim();
    let s = s
        .strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s);
    if s.is_empty() {
        return None;
    }
    let (mut hi, mut lo) = (0u128, 0u128);
    for ch in s.chars() {
        let d = u128::from(ch.to_digit(16)?);
        // (hi, lo) <<= 4, feeding the four bits shifted off the top of `lo` into `hi`.
        let carry = lo >> 124;
        hi = hi.checked_mul(16)?.checked_add(carry)?;
        lo = (lo << 4) | d;
    }
    Some(hi as f64 * TWO_POW_128 + lo as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Relative comparison; the maths is float end to end, so exact equality is the wrong assert
    /// except where a value is structurally zero.
    fn close(a: f64, b: f64, tol: f64) -> bool {
        if a == b {
            return true;
        }
        let scale = a.abs().max(b.abs());
        (a - b).abs() / scale <= tol
    }

    // ---- blend_change -----------------------------------------------------

    #[test]
    fn blend_change_is_none_when_neither_leg_has_data() {
        assert_eq!(blend_change(100.0, None, 50.0, None), None);
    }

    #[test]
    fn blend_change_weights_by_value_not_by_leg_count() {
        // 900 USD moving +10% and 100 USD moving 0% is +9%, not +5%.
        let got = blend_change(900.0, Some(10.0), 100.0, Some(0.0)).unwrap();
        assert!(close(got, 9.0, 1e-12), "{got}");
    }

    #[test]
    fn blend_change_treats_a_missing_leg_as_zero_change() {
        // Mirrors Python's `c0 or 0`: the leg still contributes its *value* to the denominator.
        let got = blend_change(100.0, None, 100.0, Some(8.0)).unwrap();
        assert!(close(got, 4.0, 1e-12), "{got}");
    }

    #[test]
    fn blend_change_is_none_for_a_worthless_position() {
        // Total value zero would be a division by zero, and a change on nothing means nothing.
        assert_eq!(blend_change(0.0, Some(10.0), 0.0, Some(20.0)), None);
        assert_eq!(blend_change(-0.0, Some(10.0), 0.0, None), None);
    }

    #[test]
    fn blend_change_survives_a_one_sided_position() {
        let got = blend_change(0.0, Some(99.0), 250.0, Some(-4.0)).unwrap();
        assert!(close(got, -4.0, 1e-12), "{got}");
    }

    // ---- sqrt_ratio_at_tick -----------------------------------------------

    #[test]
    fn sqrt_ratio_at_tick_zero_is_exactly_q96() {
        // 1.0001^0 == 1, so the ratio is the raw Q64.96 unit.
        assert_eq!(sqrt_ratio_at_tick(0), Q96);
    }

    #[test]
    fn sqrt_ratio_at_tick_is_monotonic_and_symmetric() {
        assert!(sqrt_ratio_at_tick(1) > sqrt_ratio_at_tick(0));
        assert!(sqrt_ratio_at_tick(-1) < sqrt_ratio_at_tick(0));
        // sqrt(1.0001^t) * sqrt(1.0001^-t) == 2^192.
        let product = sqrt_ratio_at_tick(5000) * sqrt_ratio_at_tick(-5000);
        assert!(close(product, Q96 * Q96, 1e-12), "{product}");
    }

    #[test]
    fn sqrt_ratio_at_the_uniswap_bounds_stays_finite_and_exceeds_u128() {
        let hi = sqrt_ratio_at_tick(MAX_TICK);
        let lo = sqrt_ratio_at_tick(-MAX_TICK);
        assert!(hi.is_finite() && lo.is_finite());
        // The whole reason this module is not u128-based: the top of the range is ~1.46e48.
        assert!(hi > u128::MAX as f64, "{hi} should exceed u128::MAX");
        assert!(close(hi, 1.4614467034780703e48, 1e-12), "{hi}");
        assert!(close(lo, 4295128738.152353, 1e-12), "{lo}");
    }

    // ---- amounts_from_liquidity -------------------------------------------

    fn range(tick_lower: i32, tick_upper: i32) -> (f64, f64) {
        (
            sqrt_ratio_at_tick(tick_lower),
            sqrt_ratio_at_tick(tick_upper),
        )
    }

    #[test]
    fn below_the_range_the_position_is_all_token0() {
        let (a, b) = range(1000, 2000);
        let (amt0, amt1) = amounts_from_liquidity(1_000_000_000_000, sqrt_ratio_at_tick(500), a, b);
        assert!(amt0 > 0.0, "{amt0}");
        assert_eq!(amt1, 0.0, "no token1 is owed below the range");
    }

    #[test]
    fn above_the_range_the_position_is_all_token1() {
        let (a, b) = range(1000, 2000);
        let (amt0, amt1) =
            amounts_from_liquidity(1_000_000_000_000, sqrt_ratio_at_tick(3000), a, b);
        assert_eq!(amt0, 0.0, "no token0 is owed above the range");
        assert!(amt1 > 0.0, "{amt1}");
    }

    #[test]
    fn in_range_the_position_holds_both_tokens() {
        let (a, b) = range(1000, 2000);
        let (amt0, amt1) =
            amounts_from_liquidity(1_000_000_000_000, sqrt_ratio_at_tick(1500), a, b);
        assert!(amt0 > 0.0 && amt1 > 0.0, "{amt0} {amt1}");
    }

    #[test]
    fn a_reversed_range_is_sorted_rather_than_rejected() {
        let (a, b) = range(1000, 2000);
        let forward = amounts_from_liquidity(5_000_000, sqrt_ratio_at_tick(1500), a, b);
        let reversed = amounts_from_liquidity(5_000_000, sqrt_ratio_at_tick(1500), b, a);
        assert_eq!(forward, reversed);
    }

    #[test]
    fn the_piecewise_function_is_continuous_at_both_seams() {
        // This is what makes the f64 branch boundary safe: picking the "wrong" side of a seam
        // (which a sub-ULP rounding difference against Python can do) changes nothing material.
        let (a, b) = range(-30000, 45000);
        let l = 987_654_321_098_765u128;

        let (b0_lo, b1_lo) = amounts_from_liquidity(l, a, a, b); // below/in seam, from `in`
        let (u0_lo, u1_lo) = amounts_from_liquidity(l, a * (1.0 - f64::EPSILON), a, b); // from `below`
        assert!(close(b0_lo, u0_lo, 1e-12), "{b0_lo} vs {u0_lo}");
        assert!(close(b1_lo, u1_lo, 1e-12) || (b1_lo == 0.0 && u1_lo == 0.0));

        let (b0_hi, b1_hi) = amounts_from_liquidity(l, b, a, b); // at/above seam, from `above`
        let (u0_hi, u1_hi) = amounts_from_liquidity(l, b * (1.0 - f64::EPSILON), a, b); // from `in`
        assert!(close(b1_hi, u1_hi, 1e-12), "{b1_hi} vs {u1_hi}");
        assert!(u0_hi.abs() < b1_hi * 1e-12, "token0 should vanish: {u0_hi}");
        assert_eq!(b0_hi, 0.0);
    }

    #[test]
    fn zero_liquidity_owes_nothing_anywhere() {
        let (a, b) = range(-1000, 1000);
        for tick in [-5000, -1000, 0, 1000, 5000] {
            let (amt0, amt1) = amounts_from_liquidity(0, sqrt_ratio_at_tick(tick), a, b);
            assert_eq!((amt0, amt1), (0.0, 0.0), "tick {tick}");
        }
    }

    #[test]
    fn a_full_range_position_at_the_uniswap_bounds_stays_finite() {
        let (a, b) = range(-MAX_TICK, MAX_TICK);
        let (amt0, amt1) = amounts_from_liquidity(u128::from(u64::MAX), Q96, a, b);
        assert!(amt0.is_finite() && amt1.is_finite(), "{amt0} {amt1}");
        assert!(amt0 > 0.0 && amt1 > 0.0);
    }

    #[test]
    fn a_uint128_max_liquidity_does_not_overflow() {
        // The worst realistic case: max liquidity across the widest range.
        let (a, b) = range(-MAX_TICK, MAX_TICK);
        let (amt0, amt1) = amounts_from_liquidity(u128::MAX, Q96, a, b);
        assert!(amt0.is_finite() && amt1.is_finite(), "{amt0} {amt1}");
    }

    #[test]
    fn a_zero_width_range_owes_nothing() {
        let a = sqrt_ratio_at_tick(1000);
        let (amt0, amt1) = amounts_from_liquidity(1_000_000, a, a, a);
        assert_eq!((amt0, amt1), (0.0, 0.0));
    }

    // ---- lp_range ---------------------------------------------------------

    #[test]
    fn lp_range_reports_a_plain_band_when_the_price_reads_naturally() {
        // WETH/USDC-shaped: 18 vs 6 decimals puts the price well above 1, so no inversion.
        let band = lp_range(-202000, -196000, -199000, 18, 6, "WETH", "USDC");
        assert_eq!((band.base, band.quote), ("WETH", "USDC"));
        assert!(band.lower.unwrap() < band.cur.unwrap());
        assert!(band.cur.unwrap() < band.upper.unwrap());
        assert!(!band.full, "a 600-tick band is not full-range");
    }

    #[test]
    fn lp_range_inverts_a_sub_one_price_and_swaps_the_pair() {
        // Same pool the other way round: the raw price is ~0.0003, so it is flipped for reading.
        let band = lp_range(196000, 202000, 199000, 6, 18, "USDC", "WETH");
        assert_eq!(
            (band.base, band.quote),
            ("WETH", "USDC"),
            "a sub-1 price must be inverted so the symbols follow"
        );
        assert!(band.cur.unwrap() > 1.0, "{:?}", band.cur);
        assert!(band.lower.unwrap() < band.upper.unwrap());
    }

    #[test]
    fn lp_range_marks_a_full_range_position() {
        let band = lp_range(-MAX_TICK, MAX_TICK, 0, 18, 18, "A", "B");
        assert!(band.full, "the widest possible band is full-range");
    }

    #[test]
    fn lp_range_at_tick_zero_is_the_decimal_adjustment_itself() {
        let band = lp_range(-10, 10, 0, 18, 18, "A", "B");
        assert_eq!(band.cur, Some(1.0), "1.0001^0 * 10^0 == 1");
        assert!(!band.full);
    }

    #[test]
    fn lp_range_drops_non_finite_edges_rather_than_emitting_them() {
        // Past tick ~7.1e6 the price overflows f64; Python raises OverflowError and substitutes
        // inf, and either way the edge is not a number a UI can render.
        let band = lp_range(0, 9_000_000, 0, 18, 18, "A", "B");
        assert_eq!(band.upper, None, "an overflowed edge must not leak inf");
        assert!(band.full, "an unbounded upper edge means full-range");
    }

    #[test]
    fn lp_range_treats_an_underflowed_lower_edge_as_full_range() {
        // Very negative ticks underflow to 0.0, which Python's `not lo` catches first — the
        // ordering matters, because `hi / lo` would otherwise be a division by zero.
        let band = lp_range(-9_000_000, 0, 0, 18, 18, "A", "B");
        assert_eq!(band.lower, Some(0.0));
        assert!(band.full);
    }

    #[test]
    fn lp_range_applies_the_decimal_adjustment() {
        // 10^(6-18) shifts the price by twelve orders of magnitude.
        let same = lp_range(-100, 100, 0, 18, 18, "A", "B");
        let shifted = lp_range(-100, 100, 0, 6, 18, "A", "B");
        // The shifted price is sub-1, so it comes back inverted: 1/1e-12 == 1e12.
        assert_eq!((shifted.base, shifted.quote), ("B", "A"));
        assert!(close(shifted.cur.unwrap(), 1e12, 1e-9), "{:?}", shifted.cur);
        assert_eq!(same.cur, Some(1.0));
    }

    // ---- fee_tick_spacing -------------------------------------------------

    #[test]
    fn every_uniswap_v3_fee_tier_maps_to_its_spacing() {
        assert_eq!(fee_tick_spacing(100), Some(1));
        assert_eq!(fee_tick_spacing(500), Some(10));
        assert_eq!(fee_tick_spacing(3000), Some(60));
        assert_eq!(fee_tick_spacing(10000), Some(200));
    }

    #[test]
    fn an_unknown_fee_tier_has_no_spacing() {
        // v4 pools and v3 forks set their own spacing, so a miss is normal, not an error.
        for fee in [0u32, 1, 250, 400, 3001, 100_000] {
            assert_eq!(fee_tick_spacing(fee), None, "fee {fee}");
        }
    }

    // ---- s24 --------------------------------------------------------------

    #[test]
    fn s24_leaves_the_positive_half_alone() {
        assert_eq!(s24(0), 0);
        assert_eq!(s24(1), 1);
        assert_eq!(s24(887_272), 887_272);
        assert_eq!(s24((1 << 23) - 1), 8_388_607, "the largest positive int24");
    }

    #[test]
    fn s24_wraps_the_top_half_into_negatives() {
        assert_eq!(s24(1 << 23), -8_388_608, "the most negative int24");
        assert_eq!(s24(0xFF_FFFF), -1, "all ones is -1");
        assert_eq!(s24(0xFF_FFFE), -2);
    }

    #[test]
    fn s24_recovers_the_uniswap_tick_bounds() {
        // The two values a v4 PositionInfo word actually carries at the extremes.
        let encoded_min = (i64::from(-MAX_TICK) & 0xFF_FFFF) as u32;
        let encoded_max = MAX_TICK as u32;
        assert_eq!(s24(encoded_min), -MAX_TICK);
        assert_eq!(s24(encoded_max), MAX_TICK);
    }

    #[test]
    fn s24_round_trips_every_boundary() {
        for tick in [-8_388_608i32, -887_272, -1, 0, 1, 887_272, 8_388_607] {
            let encoded = (i64::from(tick) & 0xFF_FFFF) as u32;
            assert_eq!(s24(encoded), tick, "tick {tick}");
        }
    }

    // ---- u256_hex_to_f64 --------------------------------------------------

    #[test]
    fn u256_hex_parses_small_values_exactly() {
        assert_eq!(u256_hex_to_f64("0x0"), Some(0.0));
        assert_eq!(u256_hex_to_f64("0x1"), Some(1.0));
        assert_eq!(u256_hex_to_f64("ff"), Some(255.0));
        assert_eq!(u256_hex_to_f64("0X10"), Some(16.0));
    }

    #[test]
    fn u256_hex_handles_a_uint160_that_cannot_fit_in_u128() {
        // Uniswap's exact `TickMath.MAX_SQRT_RATIO` — the value that breaks any u128-based port.
        let max_sqrt = "0xfffd8963efd1fc6a506488495d951d5263988d26";
        let got = u256_hex_to_f64(max_sqrt).unwrap();
        assert!(got > u128::MAX as f64, "{got} must exceed u128::MAX");
        assert!(close(got, 1.4614467034852102e48, 1e-15), "{got}");
    }

    #[test]
    fn the_float_sqrt_ratio_trails_uniswaps_exact_tick_math_at_the_bounds() {
        // Documents a real, pre-existing limit of the Python oracle we are matching: its float
        // `1.0001**(tick/2)` form is NOT Uniswap's exact 256-bit `TickMath`. At the bounds they
        // differ by ~5e-12 (top) and ~2e-10 (bottom) relative — invisible against a price feed,
        // but the reason this module must never be used to compute a settlement amount.
        let exact_max = u256_hex_to_f64("0xfffd8963efd1fc6a506488495d951d5263988d26").unwrap();
        let ours_max = sqrt_ratio_at_tick(MAX_TICK);
        let drift_max = (exact_max - ours_max).abs() / exact_max;
        assert!(drift_max < 1e-11, "top-of-range drift grew: {drift_max:e}");

        let exact_min = 4_295_128_739.0; // TickMath.MIN_SQRT_RATIO
        let ours_min = sqrt_ratio_at_tick(-MAX_TICK);
        let drift_min = (exact_min - ours_min).abs() / exact_min;
        assert!(
            drift_min < 1e-9,
            "bottom-of-range drift grew: {drift_min:e}"
        );
    }

    #[test]
    fn u256_hex_spans_the_full_256_bit_width() {
        let all_ones = "f".repeat(64);
        let got = u256_hex_to_f64(&all_ones).unwrap();
        assert!(close(got, TWO_POW_128 * TWO_POW_128, 1e-15), "{got}");
        assert_eq!(
            u256_hex_to_f64(&"f".repeat(65)),
            None,
            "wider than 256 bits must be rejected, not wrapped"
        );
    }

    #[test]
    fn u256_hex_rejects_junk_instead_of_guessing() {
        assert_eq!(u256_hex_to_f64(""), None);
        assert_eq!(u256_hex_to_f64("0x"), None);
        assert_eq!(u256_hex_to_f64("0xzz"), None);
        assert_eq!(u256_hex_to_f64("12g4"), None);
    }
}
