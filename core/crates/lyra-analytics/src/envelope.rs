//! The honesty envelope — port of `pow_mcp/model.py` (`Confidence`, `Metric`) and the
//! metric-producing primitives in `pow_mcp/analytics.py`.
//!
//! **This module is the reason the analytics layer can be trusted by an AI.** The keyless
//! snapshot structurally lacks cost basis, gas, realized-fee history and price history. So a
//! *derived* number is never emitted bare: it carries the confidence it deserves and the inputs
//! it is missing, and when it cannot be computed at all the value is `None` **with a reason** —
//! never `0.0`, never an estimate, never a silently-dropped field. A zero and a "we don't know"
//! read identically downstream, and that is exactly the confusion that makes an agent
//! confidently wrong.
//!
//! Raw facts (a position's USD value) are plain typed fields; only derived quantities get wrapped.

use serde::{Deserialize, Serialize};

/// How much a derived number deserves to be believed.
///
/// Mirrors Python's `Confidence` str-enum exactly, wire values included — `n/a` is not a typo,
/// it is the serialized form the agent contract already uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Confidence {
    /// Direct from the snapshot, no assumptions.
    High,
    /// Derived, sound inputs.
    Medium,
    /// Derived with proxies / partial inputs.
    Low,
    /// Cannot be computed from a keyless snapshot.
    #[default]
    #[serde(rename = "n/a")]
    Na,
}

impl Confidence {
    /// The wire form. Kept as a method (not just serde) so non-JSON callers cannot invent a
    /// different spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
            Confidence::Na => "n/a",
        }
    }
}

/// A derived quantity plus its honesty envelope.
///
/// `value` is `None` when the metric is uncomputable, and `data_gaps` then says *why* —
/// construct that case through [`Metric::unavailable`] so a reason can never be forgotten.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Metric {
    pub value: Option<f64>,
    /// usd | thb | pct | days | ratio | index
    pub unit: Option<String>,
    #[serde(default)]
    pub confidence: Confidence,
    /// What is missing to raise the confidence — or, when `value` is `None`, what is missing to
    /// compute it at all.
    #[serde(default)]
    pub data_gaps: Vec<String>,
    pub note: Option<String>,
}

impl Metric {
    /// The null-with-reason constructor. There is deliberately no way to build an unavailable
    /// metric without saying what is missing: `gaps` is the whole point of the type.
    pub fn unavailable(unit: &str, gaps: &[&str], note: Option<&str>) -> Self {
        Self {
            value: None,
            unit: Some(unit.to_string()),
            confidence: Confidence::Na,
            data_gaps: gaps.iter().map(|g| (*g).to_string()).collect(),
            note: note.map(str::to_string),
        }
    }

    /// A computable metric. Still carries `data_gaps`, because "we have a number" and "the
    /// number is complete" are different claims.
    pub fn of(
        value: f64,
        unit: &str,
        confidence: Confidence,
        gaps: &[&str],
        note: Option<&str>,
    ) -> Self {
        Self {
            value: Some(value),
            unit: Some(unit.to_string()),
            confidence,
            data_gaps: gaps.iter().map(|g| (*g).to_string()).collect(),
            note: note.map(str::to_string),
        }
    }

    /// True when this metric is a null-with-reason. Used by callers that must branch on
    /// "unknown" rather than treating it as zero.
    pub fn is_unavailable(&self) -> bool {
        self.value.is_none()
    }
}

/// A machine-readable signal for agent reasoning — never a verdict.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Flag {
    /// e.g. `out_of_range`, `incentive_dependent`
    pub code: String,
    /// info | watch | warn
    pub severity: String,
    pub message: String,
}

/// One token leg: a pool token, a reward leg, or a basket component.
///
/// This is deliberately the *whole* input model for the maths in this crate — the adapter maps
/// the real portfolio onto it. `usd` is `Option` because the snapshot genuinely does not price
/// every leg, and that distinction drives the exposure-unwrap fallback.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TokenAmount {
    pub symbol: String,
    #[serde(default)]
    pub usd: Option<f64>,
}

impl TokenAmount {
    pub fn new(symbol: impl Into<String>, usd: Option<f64>) -> Self {
        Self {
            symbol: symbol.into(),
            usd,
        }
    }
}

/// Decimal rounding with Python's `round()` semantics.
///
/// Every rounded number in this crate goes through here. Python rounds the *exact* binary value
/// to the nearest decimal, ties to even, then returns the nearest double to that decimal —
/// which is precisely format-then-parse. The naive `(x * 10^n).round() / 10^n` rounds ties away
/// from zero and would silently disagree with the oracle on values like `12.25 -> 12.3` vs
/// Python's `12.2`. Percentages of round-numbered portfolios hit that case constantly, so the
/// difference is not academic.
pub fn round_dp(value: f64, digits: usize) -> f64 {
    if !value.is_finite() {
        return value;
    }
    format!("{value:.digits$}").parse().unwrap_or(value)
}

/// Split claimable rewards into swap-fee legs (the reward symbol is one of the pool's own
/// tokens) and emission legs (a separate farm-reward token).
///
/// The engine bundles both into one `rewards_usd`, which flatters a raw "fee APR" — a pool
/// paying entirely in its own inflationary farm token would look like it was earning real
/// trading fees. Returns `(swap_usd, emission_usd)`.
pub fn fee_split(pool_tokens: &[TokenAmount], rewards: &[TokenAmount]) -> (f64, f64) {
    let pool_syms: Vec<String> = pool_tokens
        .iter()
        .map(|t| t.symbol.to_uppercase())
        .collect();
    let (mut swap, mut emission) = (0.0, 0.0);
    for reward in rewards {
        let usd = reward.usd.unwrap_or(0.0);
        if pool_syms.contains(&reward.symbol.to_uppercase()) {
            swap += usd;
        } else {
            emission += usd;
        }
    }
    (round_dp(swap, 6), round_dp(emission, 6))
}

/// `emission_usd / (swap_usd + emission_usd)` — how incentive-dependent the yield is.
///
/// The cheapest real risk primitive available to a concentrated-liquidity desk: yield paid in a
/// farm token can evaporate when emissions end, and it must be sold to be realized. With no
/// claimable rewards at all there is nothing to attribute, so the answer is null-with-reason —
/// **not** `0.0`, which would read as "this yield is pure swap fees" and is a materially
/// different, and false, claim.
pub fn emission_dependency(pool_tokens: &[TokenAmount], rewards: &[TokenAmount]) -> Metric {
    let (swap, emission) = fee_split(pool_tokens, rewards);
    let total = swap + emission;
    if total <= 0.0 {
        return Metric::unavailable("ratio", &["no claimable rewards to attribute"], None);
    }
    Metric::of(
        round_dp(emission / total, 3),
        "ratio",
        Confidence::High,
        &["reward-token liquidity/dump-risk not available from a keyless snapshot"],
        Some("share of yield coming from farm emissions vs swap fees"),
    )
}

/// Health factor = collateral · liquidationThreshold / debt; liquidatable below 1.0.
///
/// Comes straight from an on-chain oracle, hence high confidence — but it is a point-in-time
/// value that moves with collateral and debt prices, which is recorded as a gap rather than
/// hidden. No debt means there is nothing to liquidate, which is an *absence* of risk, not a
/// risk of zero: null-with-reason again.
pub fn lending_health(hf: Option<f64>) -> Metric {
    match hf {
        None => Metric::unavailable("ratio", &["no active debt — nothing to liquidate"], None),
        Some(hf) => Metric::of(
            round_dp(hf, 3),
            "ratio",
            Confidence::High,
            &["point-in-time — moves with collateral & debt prices"],
            Some("liquidation at HF < 1.0"),
        ),
    }
}

/// How far collateral value can fall before liquidation (HF → 1): `1 − 1/HF`, as a fraction.
///
/// `None` when there is no debt or the position is already at/under the line — a negative
/// "buffer" is not a buffer, and reporting one would invert the reader's sense of safety.
pub fn liquidation_buffer(hf: Option<f64>) -> Option<f64> {
    match hf {
        Some(hf) if hf > 1.0 => Some(round_dp(1.0 - 1.0 / hf, 4)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(symbol: &str, usd: f64) -> TokenAmount {
        TokenAmount::new(symbol, Some(usd))
    }

    #[test]
    fn rounding_follows_python_ties_to_even() {
        // The cases where half-away-from-zero would disagree.
        assert_eq!(round_dp(12.25, 1), 12.2);
        assert_eq!(round_dp(0.125, 2), 0.12);
        assert_eq!(round_dp(2.5, 0), 2.0);
        assert_eq!(round_dp(-12.25, 1), -12.2);
        // ...and the cases where the exact binary value decides, not the literal.
        assert_eq!(round_dp(0.135, 2), 0.14);
        assert_eq!(round_dp(2.675, 2), 2.67);
    }

    #[test]
    fn rounding_passes_non_finite_through() {
        assert!(round_dp(f64::NAN, 2).is_nan());
        assert_eq!(round_dp(f64::INFINITY, 2), f64::INFINITY);
    }

    #[test]
    fn no_rewards_is_null_with_reason_not_zero() {
        let m = emission_dependency(&[tok("WETH", 100.0)], &[]);
        assert!(m.is_unavailable(), "no rewards must not produce a number");
        assert_eq!(m.value, None);
        assert_eq!(m.confidence, Confidence::Na);
        assert_eq!(m.data_gaps, vec!["no claimable rewards to attribute"]);
    }

    #[test]
    fn pure_emission_yield_is_a_full_ratio() {
        let m = emission_dependency(&[tok("WETH", 100.0)], &[tok("NEST", 4.0)]);
        assert_eq!(m.value, Some(1.0));
        assert_eq!(m.confidence, Confidence::High);
        assert!(!m.data_gaps.is_empty(), "even a real number keeps its gaps");
    }

    #[test]
    fn swap_and_emission_legs_are_separated_by_pool_membership() {
        let pool = [tok("WETH", 500.0), tok("USDC", 500.0)];
        let rewards = [tok("weth", 3.0), tok("NEST", 1.0)];
        assert_eq!(fee_split(&pool, &rewards), (3.0, 1.0));
        assert_eq!(emission_dependency(&pool, &rewards).value, Some(0.25));
    }

    #[test]
    fn no_debt_means_no_health_factor_and_no_buffer() {
        let m = lending_health(None);
        assert!(m.is_unavailable());
        assert_eq!(m.data_gaps, vec!["no active debt — nothing to liquidate"]);
        assert_eq!(liquidation_buffer(None), None);
        // Already under water: a "buffer" would be negative, so there isn't one.
        assert_eq!(liquidation_buffer(Some(0.97)), None);
        assert_eq!(liquidation_buffer(Some(1.0)), None);
    }

    #[test]
    fn health_factor_keeps_its_point_in_time_gap() {
        let m = lending_health(Some(1.234_5));
        assert_eq!(m.value, Some(1.234));
        assert_eq!(m.confidence, Confidence::High);
        assert_eq!(
            m.data_gaps,
            vec!["point-in-time — moves with collateral & debt prices"]
        );
    }

    #[test]
    fn confidence_wire_form_matches_python() {
        assert_eq!(Confidence::Na.as_str(), "n/a");
        assert_eq!(
            serde_json::to_string(&Confidence::Na).unwrap(),
            "\"n/a\"".to_string()
        );
        assert_eq!(
            serde_json::to_string(&Confidence::High).unwrap(),
            "\"high\"".to_string()
        );
    }
}
