//! Borrow-risk flags, the contrarian timing tilt, and the ranked candidate actions — port of the
//! strategy half of `pow_mcp/analytics.py` (`lending_flags`, `market_timing`, `strategy`).
//!
//! Everything here is **decision support, never a verdict**. Signals are observations about the
//! user's own book measured against the user's own targets; actions are proposals with a size, a
//! confidence, the assumptions they rest on, and how reversible they are. Nothing in this module
//! predicts a price, and the single external input — one sentiment index — is applied as a
//! labelled *tilt* on sizing, never as a market call.
//!
//! The honesty envelope governs this module as it governs the rest of the crate: a timing signal
//! with no sentiment feed is [`Metric::unavailable`] with the reason attached, not a neutral
//! zero. See [`lending_flags`] for the one place where a faithful port of the Python leaves a
//! real gap, and [`unassessable_debt_flag`] for the addition that closes it.

use serde::{Deserialize, Serialize};

use crate::envelope::{Confidence, Flag, Metric, round_dp};
use crate::exposure::Concentration;
use crate::tiers::{DriftAction, RebalancePlan, Tier};

// ---------------------------------------------------------------------------------------------
// Thresholds — every one of these is a judgement call, so they are named and gathered here
// ---------------------------------------------------------------------------------------------

/// Ignore claimable dust below this — harvesting costs gas and attention.
pub const HARVEST_FLOOR_USD: f64 = 25.0;
/// ...or below this share of net worth, whichever is larger.
pub const HARVEST_FLOOR_PCT: f64 = 0.005;
/// A rebalance leg worth surfacing at all: 1% of net worth.
pub const MATERIAL_PCT: f64 = 0.01;
/// Top-asset share of true exposure that earns a mention (%).
pub const CONC_WATCH: f64 = 25.0;
/// ...and the share that earns a proposed trim (%).
pub const CONC_WARN: f64 = 35.0;
/// Health-factor floor considered safe. Matches the app UI and the alert threshold.
pub const HF_SAFE: f64 = 1.5;
/// Deleverage target — slightly above the floor, so a repay does not leave you back at the line.
pub const HF_TARGET: f64 = 1.6;
/// Drift beyond this many points is a warning rather than a watch.
pub const DRIFT_WARN_PCT: f64 = 8.0;
/// Health factor below this is critical rather than merely thin.
pub const HF_CRITICAL: f64 = 1.2;

// ---------------------------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------------------------

/// How loudly a signal asks to be read. Ordering is the ranking used when signals are sorted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Warn,
    Watch,
    Info,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Warn => "warn",
            Severity::Watch => "watch",
            Severity::Info => "info",
        }
    }
}

/// The contrarian posture. A tilt on sizing, not a forecast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Posture {
    /// Sentiment is fearful — bias toward accumulating store-of-value.
    Accumulate,
    /// No tilt; follow the target allocation.
    Neutral,
    /// Sentiment is greedy — bias toward banking profit into reserves.
    TakeProfit,
}

impl Posture {
    pub fn as_str(self) -> &'static str {
        match self {
            Posture::Accumulate => "accumulate",
            Posture::Neutral => "neutral",
            Posture::TakeProfit => "take_profit",
        }
    }
}

/// How hard a move is to undo — part of what makes a proposal honest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reversibility {
    Easy,
    Moderate,
    Hard,
}

impl Reversibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Reversibility::Easy => "easy",
            Reversibility::Moderate => "moderate",
            Reversibility::Hard => "hard",
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Number formatting that matches Python's, because these numbers end up inside strings
// ---------------------------------------------------------------------------------------------

/// `f"{x:,.0f}"` — whole dollars with thousands separators.
fn usd0(value: f64) -> String {
    // `{:.0}` rounds ties to even, exactly as Python's format spec does.
    let rendered = format!("{value:.0}");
    let (sign, digits) = match rendered.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", rendered.as_str()),
    };
    let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{sign}{grouped}")
}

/// `f"{x:.2f}"`.
fn dp2(value: f64) -> String {
    format!("{value:.2}")
}

/// `f"{x:.0f}"` — no grouping.
fn dp0(value: f64) -> String {
    format!("{value:.0}")
}

/// Python's `str()` of a float: a whole number keeps its `.0` (`25.0`, not `25`).
///
/// Used for values that are genuinely floats on the Python side (`now_pct`, `hhi`), so the
/// rendered summaries match character for character.
fn pyfloat(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        format!("{value:.1}")
    } else {
        format!("{value}")
    }
}

/// Python's `str()` of a tier target, which is an **int** in the config (`10`, not `10.0`).
///
/// Targets come from `TIER_TARGET_DEFAULT` or an integer env override, so a whole number renders
/// without a decimal point. A fractional target renders as a float, matching Python either way.
fn pytarget(value: f64) -> String {
    if value.fract() == 0.0 && value.is_finite() {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

// ---------------------------------------------------------------------------------------------
// Lending / borrow risk
// ---------------------------------------------------------------------------------------------

/// One borrow position, reduced to what the risk maths reads.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LendingRow {
    pub protocol: String,
    /// Health factor. `None` means the engine reported no active debt.
    #[serde(default)]
    pub hf: Option<f64>,
    #[serde(default)]
    pub debt_usd: f64,
}

/// Machine-readable borrow-risk signals. Thresholds match the app UI and the alert floor.
///
/// **An empty list is not a clean bill of health.** With no health factor there is nothing to
/// threshold, so nothing is flagged — which is correct when `hf` is `None` because there is no
/// debt (the ordinary case), and dangerously quiet if a position has debt whose health could not
/// be computed. The Python cannot tell those apart, and neither can this function; that is why
/// [`crate::envelope::lending_health`] returns null-with-reason for the same input and why
/// [`unassessable_debt_flag`] exists. Callers should surface all three together: the flags, the
/// health-factor metric, and the unassessable-debt flag.
pub fn lending_flags(hf: Option<f64>) -> Vec<Flag> {
    let Some(hf) = hf else {
        return Vec::new();
    };
    let flag = |code: &str, severity: Severity, message: String| Flag {
        code: code.to_string(),
        severity: severity.as_str().to_string(),
        message,
    };
    if hf < 1.0 {
        vec![flag(
            "liquidatable",
            Severity::Warn,
            format!("health factor {} < 1.0 — position is liquidatable", dp2(hf)),
        )]
    } else if hf < HF_CRITICAL {
        vec![flag(
            "health_factor_critical",
            Severity::Warn,
            format!(
                "health factor {} — near liquidation; add collateral or repay",
                dp2(hf)
            ),
        )]
    } else if hf < HF_SAFE {
        vec![flag(
            "health_factor_low",
            Severity::Watch,
            format!("health factor {} — thinning liquidation buffer", dp2(hf)),
        )]
    } else {
        Vec::new()
    }
}

/// The flag the Python surface cannot express: **debt exists, but its health is unknown.**
///
/// An addition, not a port. `lending_flags(None)` returns nothing, which reads downstream as
/// "no borrow risk here" — true when there is no debt, and the single most damaging thing this
/// system could say when there is debt the snapshot failed to price. Rather than silently
/// changing the ported function's output, this reports the gap explicitly so a caller can render
/// it alongside the flags.
///
/// Returns `None` whenever the Python behaviour is already correct: no debt, or a known health
/// factor.
pub fn unassessable_debt_flag(hf: Option<f64>, debt_usd: f64) -> Option<Flag> {
    (hf.is_none() && debt_usd > 0.0).then(|| Flag {
        code: "health_factor_unavailable".to_string(),
        severity: Severity::Warn.as_str().to_string(),
        message: format!(
            "${} of debt with no health factor — liquidation risk cannot be assessed from this \
             snapshot; check the protocol UI",
            usd0(debt_usd)
        ),
    })
}

// ---------------------------------------------------------------------------------------------
// Market timing
// ---------------------------------------------------------------------------------------------

/// The Fear & Greed reading, as the sentiment feed reports it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FearGreed {
    /// 0-100. `None` when the feed is unavailable — which is a fact, not a neutral 50.
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub classification: Option<String>,
}

/// The posture, its basis, and what it is missing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarketTiming {
    pub posture: Posture,
    /// The index as an integer, or `None` when there is no feed.
    pub index: Option<i64>,
    pub classification: Option<String>,
    pub confidence: Confidence,
    /// The one-line justification, always naming the index it came from.
    pub basis: String,
    pub gaps: Vec<String>,
}

impl MarketTiming {
    /// The timing tilt as a metric.
    ///
    /// With no feed the value is `None` with the gap attached — never a mid-scale 50 standing in
    /// for "we don't know", which would silently read as a real neutral reading.
    pub fn metric(&self, note: Option<&str>) -> Metric {
        let gaps: Vec<&str> = self.gaps.iter().map(String::as_str).collect();
        match self.index {
            Some(index) => Metric::of(index as f64, "index", self.confidence, &gaps, note),
            None => Metric::unavailable("index", &gaps, note),
        }
    }
}

/// Contrarian long-horizon posture from the Fear & Greed index.
///
/// Fear biases toward accumulating store-of-value, greed toward taking profit into reserves. A
/// **heuristic tilt for sizing** — never a market call; the magnitude of any move stays the
/// user's decision. With no reading at all the posture is neutral *and says so*: the gap is
/// recorded rather than papered over with a default.
pub fn market_timing(fear_greed: Option<&FearGreed>) -> MarketTiming {
    let reading = fear_greed.and_then(|fg| fg.value.map(|value| (value, fg)));
    let Some((index, fg)) = reading else {
        return MarketTiming {
            posture: Posture::Neutral,
            index: None,
            classification: None,
            confidence: Confidence::Na,
            basis: "Fear & Greed unavailable — no timing tilt, follow target allocation"
                .to_string(),
            gaps: vec!["no sentiment feed; timing bias not applied".to_string()],
        };
    };

    let rendered = pytarget(index);
    let (posture, basis) = if index <= 25.0 {
        (
            Posture::Accumulate,
            format!("Fear & Greed {rendered} (fear) — contrarian bias to accumulate blue-chips"),
        )
    } else if index >= 75.0 {
        (
            Posture::TakeProfit,
            format!(
                "Fear & Greed {rendered} (greed) — contrarian bias to bank profit into reserves"
            ),
        )
    } else {
        (
            Posture::Neutral,
            format!("Fear & Greed {rendered} (neutral) — follow target allocation, no timing tilt"),
        )
    };
    MarketTiming {
        posture,
        index: Some(index.trunc() as i64),
        classification: fg.classification.clone(),
        confidence: Confidence::Low,
        basis,
        gaps: vec![
            "contrarian heuristic on one sentiment index — not a market prediction".to_string(),
        ],
    }
}

// ---------------------------------------------------------------------------------------------
// Signals and candidate actions
// ---------------------------------------------------------------------------------------------

/// One machine-readable observation about the book — never a verdict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategySignal {
    /// market_timing | borrow_buffer | harvest | tier_drift | concentration
    pub kind: String,
    pub severity: Severity,
    pub summary: String,
    /// The quantified value with its confidence and data gaps.
    pub metric: Metric,
}

/// A proposed move, grounded in the user's own targets plus the sentiment tilt.
///
/// Sizes are estimates: gas, slippage, tax and cost basis are not modelled, and that is stated in
/// `assumptions` rather than left for the reader to discover.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CandidateAction {
    /// 1 = do first. Risk before growth.
    pub priority: usize,
    /// deleverage | harvest_and_redeploy | add_<tier> | trim_<tier> | reduce_concentration
    pub action: String,
    pub title: String,
    pub rationale: String,
    /// `None` when the right size is genuinely the user's call.
    pub size_usd: Option<f64>,
    pub confidence: Confidence,
    pub assumptions: Vec<String>,
    pub reversibility: Reversibility,
}

/// What [`strategy`] produces.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StrategyOutcome {
    /// Sorted most-urgent first.
    pub signals: Vec<StrategySignal>,
    /// Sorted risk-first and renumbered 1..n.
    pub actions: Vec<CandidateAction>,
}

fn signal(kind: &str, severity: Severity, summary: String, metric: Metric) -> StrategySignal {
    StrategySignal {
        kind: kind.to_string(),
        severity,
        summary,
        metric,
    }
}

/// Build the signals and ranked candidate actions from the book.
///
/// Ranked risk-first, and that order is the substance of the whole function: **protect the book**
/// (a liquidation ends compounding permanently), then **compound** (idle fees are a drag), then
/// **rebalance to target**, then **diversify**. Growth ideas never outrank a borrow position
/// under its safe floor.
///
/// Pure: plan, concentration, claimable, borrow rows, timing and net worth in — signals and
/// proposals out.
pub fn strategy(
    plan: &RebalancePlan,
    concentration: &Concentration,
    claim_usd: f64,
    lending: &[LendingRow],
    timing: &MarketTiming,
    net_worth: f64,
) -> StrategyOutcome {
    let posture = timing.posture;
    // Below this, a rebalance leg is noise: the larger of $25 and 1% of net worth.
    let material = HARVEST_FLOOR_USD.max(net_worth * MATERIAL_PCT);
    let mut signals: Vec<StrategySignal> = Vec::new();
    let mut actions: Vec<CandidateAction> = Vec::new();

    // --- market timing, always surfaced so its absence is visible too ---
    signals.push(signal(
        "market_timing",
        Severity::Info,
        timing.basis.clone(),
        timing.metric(Some(&format!("posture: {}", posture.as_str()))),
    ));

    // --- 1. protect: deleverage anything under the safe health-factor floor ---
    // First strictly-smallest wins, matching Python's `min` on ties.
    let worst =
        lending
            .iter()
            .filter(|row| row.hf.is_some())
            .fold(None::<&LendingRow>, |best, row| match best {
                Some(b) if b.hf <= row.hf => Some(b),
                _ => Some(row),
            });
    if let Some(worst) = worst
        && let Some(hf) = worst.hf
        && hf < HF_SAFE
    {
        // Repay enough to lift HF to the target: debt · (1 − hf/target).
        let repay = round_dp((worst.debt_usd * (1.0 - hf / HF_TARGET)).max(0.0), 2);
        signals.push(signal(
            "borrow_buffer",
            if hf < HF_CRITICAL {
                Severity::Warn
            } else {
                Severity::Watch
            },
            format!(
                "{} health factor {} < {} safe floor",
                worst.protocol,
                dp2(hf),
                pyfloat(HF_SAFE)
            ),
            Metric::of(
                round_dp(hf, 3),
                "ratio",
                Confidence::High,
                &[],
                Some("liquidation at HF < 1"),
            ),
        ));
        actions.push(CandidateAction {
            priority: 1,
            action: "deleverage".to_string(),
            title: format!(
                "Repay ~${} on {} to lift HF {}→{}",
                usd0(repay),
                worst.protocol,
                dp2(hf),
                pyfloat(HF_TARGET)
            ),
            rationale: "Protect the book first — a liquidation is the fastest way to break \
                        long-term compounding."
                .to_string(),
            size_usd: Some(repay),
            confidence: Confidence::Medium,
            assumptions: vec![
                format!(
                    "target HF {} (safe floor {})",
                    pyfloat(HF_TARGET),
                    pyfloat(HF_SAFE)
                ),
                "collateral & debt prices hold while you repay".to_string(),
            ],
            reversibility: Reversibility::Moderate,
        });
    }

    // --- 2. compound: harvest claimable fees and redeploy ---
    if claim_usd >= HARVEST_FLOOR_USD.max(net_worth * HARVEST_FLOOR_PCT) {
        signals.push(signal(
            "harvest",
            Severity::Watch,
            format!(
                "${} claimable LP rewards idle — a compounding drag until redeployed",
                usd0(claim_usd)
            ),
            Metric::of(
                round_dp(claim_usd, 2),
                "usd",
                Confidence::High,
                &[],
                Some("claimable now"),
            ),
        ));
        // Biggest underweight first; ties keep ladder order (stable sort, as in Python).
        let mut adds: Vec<_> = plan
            .tiers
            .iter()
            .filter(|t| t.action == DriftAction::Add)
            .collect();
        adds.sort_by(|a, b| b.action_usd.total_cmp(&a.action_usd));
        let store_underweight = plan
            .tiers
            .iter()
            .any(|t| t.tier == Tier::Store && t.action == DriftAction::Add);

        let (destination, why) = if posture == Posture::Accumulate && store_underweight {
            (
                "Store of Value (BTC/ETH)".to_string(),
                "market in fear + store underweight → DCA the harvest into blue-chips".to_string(),
            )
        } else if let Some(top) = adds.first() {
            (
                top.label.clone(),
                format!(
                    "routes to your most-underweight tier (${} gap)",
                    usd0(top.action_usd)
                ),
            )
        } else {
            (
                if posture == Posture::TakeProfit {
                    "reserves".to_string()
                } else {
                    "target-weighted tiers".to_string()
                },
                "no tier is underweight — bank it or compound in place".to_string(),
            )
        };
        actions.push(CandidateAction {
            priority: 2,
            action: "harvest_and_redeploy".to_string(),
            title: format!(
                "Harvest ${} in fees and deploy into {destination}",
                usd0(claim_usd)
            ),
            rationale: format!("{why}."),
            size_usd: Some(round_dp(claim_usd, 2)),
            confidence: Confidence::Medium,
            assumptions: vec![
                "destination fits your long-term targets".to_string(),
                "gas/slippage not modeled (keyless snapshot)".to_string(),
            ],
            reversibility: Reversibility::Easy,
        });
    }

    // --- 3. rebalance: close material gaps, tilted by posture ---
    for row in &plan.tiers {
        if row.action == DriftAction::OnTarget || row.action_usd < material {
            continue;
        }
        let severity = if row.drift_pct.abs() >= DRIFT_WARN_PCT {
            Severity::Warn
        } else {
            Severity::Watch
        };
        let verb = if row.action == DriftAction::Add {
            "underweight"
        } else {
            "overweight"
        };
        // The signal is emitted even when no action follows (see the skip below): the drift is
        // still a fact about the book, and suppressing it would hide why nothing was proposed.
        signals.push(signal(
            "tier_drift",
            severity,
            format!(
                "{} {}% vs {}% target — {verb} ${}",
                row.label,
                pyfloat(row.now_pct),
                pytarget(row.target_pct),
                usd0(row.action_usd)
            ),
            Metric::of(
                row.drift_pct,
                "pct",
                Confidence::High,
                &[],
                Some(&format!(
                    "{} ${} to reach target",
                    row.action.as_str(),
                    usd0(row.action_usd)
                )),
            ),
        ));

        let (priority, why, title) = if row.action == DriftAction::Add {
            if row.tier == Tier::Highrisk && posture == Posture::TakeProfit {
                continue; // don't add risk into greed
            }
            let (priority, why) = if row.tier == Tier::Store && posture == Posture::Accumulate {
                (
                    3,
                    "accumulate blue-chips while sentiment is fearful (long-term contrarian)",
                )
            } else {
                (4, "close the gap to your target allocation")
            };
            (
                priority,
                why.to_string(),
                format!(
                    "Add ~${} to {} ({}%→{}%)",
                    usd0(row.action_usd),
                    row.label,
                    pyfloat(row.now_pct),
                    pytarget(row.target_pct)
                ),
            )
        } else {
            let taking_profit = posture == Posture::TakeProfit;
            let destination = if taking_profit {
                "reserves"
            } else {
                "underweight tiers"
            };
            let priority = if row.tier == Tier::Highrisk && taking_profit {
                3
            } else {
                5
            };
            let why = if taking_profit {
                "take profit into dry powder while sentiment is greedy"
            } else {
                "rotate overweight capital toward target"
            };
            (
                priority,
                why.to_string(),
                format!(
                    "Trim ~${} from {} ({}%→{}%) into {destination}",
                    usd0(row.action_usd),
                    row.label,
                    pyfloat(row.now_pct),
                    pytarget(row.target_pct)
                ),
            )
        };
        actions.push(CandidateAction {
            priority,
            action: format!("{}_{}", row.action.as_str(), row.tier.key()),
            title,
            rationale: format!("{why}."),
            size_usd: Some(row.action_usd),
            confidence: Confidence::Medium,
            assumptions: vec!["based on your tier targets + current prices".to_string()],
            reversibility: if matches!(row.tier, Tier::Reserve | Tier::Store) {
                Reversibility::Easy
            } else {
                Reversibility::Moderate
            },
        });
    }

    // --- 4. diversify: trim an over-concentrated single asset ---
    if let Some(top_pct) = concentration.top_asset_pct
        && top_pct >= CONC_WATCH
    {
        let top_asset = concentration.top_asset.clone().unwrap_or_default();
        signals.push(signal(
            "concentration",
            if top_pct >= CONC_WARN {
                Severity::Warn
            } else {
                Severity::Watch
            },
            format!(
                "{top_asset} is {}% of true exposure — single-asset risk",
                dp0(top_pct)
            ),
            Metric::of(
                top_pct,
                "pct",
                Confidence::High,
                &[],
                Some(&format!(
                    "HHI {}",
                    concentration
                        .hhi
                        .map_or_else(|| "None".to_string(), pyfloat)
                )),
            ),
        ));
        if top_pct >= CONC_WARN {
            actions.push(CandidateAction {
                priority: 4,
                action: "reduce_concentration".to_string(),
                title: format!(
                    "Trim {top_asset} from {}% toward a single-asset cap",
                    dp0(top_pct)
                ),
                rationale: "Concentration is the biggest un-forced long-term risk — diversify \
                            the tail."
                    .to_string(),
                // Deliberately unsized: the right cap is the user's risk tolerance, not ours.
                size_usd: None,
                confidence: Confidence::Medium,
                assumptions: vec![
                    "a single-asset cap you're comfortable with (e.g. 20-25%)".to_string(),
                ],
                reversibility: Reversibility::Easy,
            });
        }
    }

    // Rank risk-first, then renumber to a clean 1..n. Both sorts are stable, so equal-priority
    // items keep the order they were generated in — which is itself risk-first.
    actions.sort_by_key(|a| a.priority);
    for (i, action) in actions.iter_mut().enumerate() {
        action.priority = i + 1;
    }
    signals.sort_by_key(|s| s.severity);

    StrategyOutcome { signals, actions }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiers::{Holding, TierTargets, rebalance_plan};

    fn timing_at(index: Option<f64>) -> MarketTiming {
        market_timing(Some(&FearGreed {
            value: index,
            classification: None,
        }))
    }

    #[test]
    fn no_health_factor_produces_no_flags_but_the_gap_is_reportable() {
        // Faithful to the Python: nothing to threshold, so nothing is flagged...
        assert!(lending_flags(None).is_empty());
        // ...and with no debt that is the whole truth.
        assert_eq!(unassessable_debt_flag(None, 0.0), None);
        // But debt with an uncomputable health factor must not read as silence.
        let flag = unassessable_debt_flag(None, 12_345.0).expect("debt with unknown HF must flag");
        assert_eq!(flag.code, "health_factor_unavailable");
        assert_eq!(flag.severity, "warn");
        assert!(flag.message.contains("$12,345 of debt"));
        assert!(flag.message.contains("cannot be assessed"));
        // A known health factor is not a gap, whatever its value.
        assert_eq!(unassessable_debt_flag(Some(0.5), 100.0), None);
    }

    #[test]
    fn lending_flag_thresholds_are_exact_at_the_boundaries() {
        assert_eq!(lending_flags(Some(0.99))[0].code, "liquidatable");
        assert_eq!(lending_flags(Some(1.0))[0].code, "health_factor_critical");
        assert_eq!(lending_flags(Some(1.19))[0].code, "health_factor_critical");
        assert_eq!(lending_flags(Some(1.2))[0].code, "health_factor_low");
        assert_eq!(lending_flags(Some(1.49))[0].code, "health_factor_low");
        assert!(
            lending_flags(Some(1.5)).is_empty(),
            "the safe floor is safe"
        );
        assert!(lending_flags(Some(3.0)).is_empty());
        assert_eq!(
            lending_flags(Some(0.876))[0].message,
            "health factor 0.88 < 1.0 — position is liquidatable"
        );
    }

    #[test]
    fn a_missing_sentiment_feed_is_neutral_with_a_reason_not_a_neutral_reading() {
        for absent in [None, Some(&FearGreed::default())] {
            let timing = market_timing(absent);
            assert_eq!(timing.posture, Posture::Neutral);
            assert_eq!(timing.index, None);
            assert_eq!(timing.confidence, Confidence::Na);
            assert_eq!(
                timing.gaps,
                vec!["no sentiment feed; timing bias not applied"]
            );
            // The metric must be null-with-reason — never 50, the mid-scale "neutral" value.
            let metric = timing.metric(None);
            assert!(metric.is_unavailable());
            assert_ne!(metric.value, Some(50.0));
            assert_eq!(metric.data_gaps, timing.gaps);
        }
    }

    #[test]
    fn the_contrarian_tilt_flips_at_25_and_75() {
        assert_eq!(timing_at(Some(0.0)).posture, Posture::Accumulate);
        assert_eq!(timing_at(Some(25.0)).posture, Posture::Accumulate);
        assert_eq!(timing_at(Some(26.0)).posture, Posture::Neutral);
        assert_eq!(timing_at(Some(74.0)).posture, Posture::Neutral);
        assert_eq!(timing_at(Some(75.0)).posture, Posture::TakeProfit);
        assert_eq!(timing_at(Some(100.0)).posture, Posture::TakeProfit);
        let fearful = timing_at(Some(12.0));
        assert_eq!(
            fearful.basis,
            "Fear & Greed 12 (fear) — contrarian bias to accumulate blue-chips"
        );
        // Even a real reading is low confidence and carries its heuristic caveat.
        assert_eq!(fearful.confidence, Confidence::Low);
        assert_eq!(
            fearful.gaps,
            vec!["contrarian heuristic on one sentiment index — not a market prediction"]
        );
    }

    fn book(reserve: f64, store: f64, cashflow: f64, highrisk: f64) -> Vec<Holding> {
        [
            ("USDC", reserve),
            ("BTC", store),
            ("JLP", cashflow),
            ("PEPE", highrisk),
        ]
        .into_iter()
        .filter(|(_, usd)| *usd > 0.0)
        .map(|(symbol, usd)| Holding {
            symbol: Some(symbol.to_string()),
            usd,
            ..Default::default()
        })
        .collect()
    }

    fn empty_concentration() -> Concentration {
        Concentration {
            note: "no exposure to measure".to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn protecting_the_book_outranks_every_growth_idea() {
        let holdings = book(0.0, 10_000.0, 0.0, 0.0);
        let plan = rebalance_plan(&holdings, Some(&TierTargets::default()));
        let outcome = strategy(
            &plan,
            &Concentration {
                hhi: Some(1.0),
                top_asset: Some("BTC".into()),
                top_asset_pct: Some(100.0),
                stablecoin_pct: Some(0.0),
                note: String::new(),
            },
            5_000.0, // a large harvest
            &[LendingRow {
                protocol: "Aave V3".into(),
                hf: Some(1.05),
                debt_usd: 4_000.0,
            }],
            &timing_at(Some(50.0)),
            10_000.0,
        );
        assert_eq!(outcome.actions[0].action, "deleverage");
        assert_eq!(outcome.actions[0].priority, 1);
        assert_eq!(outcome.actions[1].action, "harvest_and_redeploy");
        // Priorities are renumbered to a clean sequence.
        let priorities: Vec<usize> = outcome.actions.iter().map(|a| a.priority).collect();
        assert_eq!(priorities, (1..=outcome.actions.len()).collect::<Vec<_>>());
        // Repay to lift 1.05 -> 1.6: 4000 * (1 - 1.05/1.6).
        assert_eq!(outcome.actions[0].size_usd, Some(1375.0));
        assert!(outcome.actions[0].title.contains("HF 1.05→1.6"));
        // Warnings sort ahead of watches, which sort ahead of info.
        assert_eq!(outcome.signals[0].severity, Severity::Warn);
        assert_eq!(
            outcome.signals.last().unwrap().kind,
            "market_timing",
            "info-level timing sorts last"
        );
    }

    #[test]
    fn greed_never_proposes_adding_to_high_risk_but_still_reports_the_drift() {
        // High risk is empty (underweight vs its 20% target) while sentiment is greedy.
        let holdings = book(0.0, 10_000.0, 0.0, 0.0);
        let plan = rebalance_plan(&holdings, Some(&TierTargets::default()));
        let outcome = strategy(
            &plan,
            &empty_concentration(),
            0.0,
            &[],
            &timing_at(Some(90.0)),
            10_000.0,
        );
        assert!(
            outcome
                .signals
                .iter()
                .any(|s| s.kind == "tier_drift" && s.summary.starts_with("High Risk")),
            "the drift is still a fact and must be surfaced"
        );
        assert!(
            !outcome.actions.iter().any(|a| a.action == "add_highrisk"),
            "adding speculation into greed is exactly what the tilt exists to prevent"
        );
        // Trimming the overweight store tier routes to reserves under a take-profit posture.
        let trim = outcome
            .actions
            .iter()
            .find(|a| a.action == "trim_store")
            .expect("an 87.5% store tier against a 40% target is a trim");
        assert!(trim.title.ends_with("into reserves"));
    }

    #[test]
    fn fear_promotes_accumulating_store_of_value_with_the_harvest() {
        let holdings = book(10_000.0, 0.0, 0.0, 0.0);
        let plan = rebalance_plan(&holdings, Some(&TierTargets::default()));
        let outcome = strategy(
            &plan,
            &empty_concentration(),
            500.0,
            &[],
            &timing_at(Some(10.0)),
            10_000.0,
        );
        let harvest = outcome
            .actions
            .iter()
            .find(|a| a.action == "harvest_and_redeploy")
            .unwrap();
        assert!(harvest.title.contains("Store of Value (BTC/ETH)"));
        assert!(harvest.rationale.starts_with("market in fear"));
        assert!(
            harvest
                .assumptions
                .iter()
                .any(|a| a.contains("gas/slippage not modeled")),
            "an unmodelled cost must be stated, not implied"
        );
    }

    #[test]
    fn dust_is_not_a_signal() {
        let holdings = book(2_500.0, 2_500.0, 2_500.0, 2_500.0);
        let plan = rebalance_plan(&holdings, Some(&TierTargets::default()));
        // $20 of claimable on a $10k book is below both harvest floors.
        let outcome = strategy(
            &plan,
            &empty_concentration(),
            20.0,
            &[],
            &timing_at(Some(50.0)),
            10_000.0,
        );
        assert!(!outcome.actions.iter().any(|a| a.action.contains("harvest")));
        assert!(!outcome.signals.iter().any(|s| s.kind == "harvest"));
    }

    #[test]
    fn an_empty_book_still_answers_and_proposes_nothing() {
        let plan = rebalance_plan(&[], None);
        let outcome = strategy(
            &plan,
            &empty_concentration(),
            0.0,
            &[],
            &market_timing(None),
            0.0,
        );
        assert!(outcome.actions.is_empty());
        // The one signal is the timing tilt, and it is honest about having no feed.
        assert_eq!(outcome.signals.len(), 1);
        assert_eq!(outcome.signals[0].kind, "market_timing");
        assert!(outcome.signals[0].metric.is_unavailable());
    }

    #[test]
    fn concentration_is_watched_at_25_and_actioned_at_35() {
        let plan = rebalance_plan(&book(2_500.0, 2_500.0, 2_500.0, 2_500.0), None);
        let conc = |pct: f64| Concentration {
            hhi: Some(0.5),
            top_asset: Some("BTC".into()),
            top_asset_pct: Some(pct),
            stablecoin_pct: Some(0.0),
            note: String::new(),
        };
        let run = |pct: f64| {
            strategy(
                &plan,
                &conc(pct),
                0.0,
                &[],
                &timing_at(Some(50.0)),
                10_000.0,
            )
        };
        assert!(!run(24.0).signals.iter().any(|s| s.kind == "concentration"));
        let watched = run(30.0);
        let signal = watched
            .signals
            .iter()
            .find(|s| s.kind == "concentration")
            .unwrap();
        assert_eq!(signal.severity, Severity::Watch);
        assert_eq!(
            signal.summary,
            "BTC is 30% of true exposure — single-asset risk"
        );
        assert_eq!(signal.metric.note.as_deref(), Some("HHI 0.5"));
        assert!(
            !watched
                .actions
                .iter()
                .any(|a| a.action == "reduce_concentration")
        );
        let warned = run(40.0);
        let action = warned
            .actions
            .iter()
            .find(|a| a.action == "reduce_concentration")
            .unwrap();
        assert_eq!(action.size_usd, None, "the right cap is the user's call");
    }

    #[test]
    fn dollar_formatting_matches_python() {
        assert_eq!(usd0(1234.0), "1,234");
        assert_eq!(usd0(999.0), "999");
        assert_eq!(usd0(1_234_567.89), "1,234,568");
        assert_eq!(usd0(-1234.4), "-1,234");
        assert_eq!(usd0(0.0), "0");
        assert_eq!(pyfloat(25.0), "25.0");
        assert_eq!(pyfloat(12.25), "12.25");
        assert_eq!(pytarget(10.0), "10");
        assert_eq!(pytarget(10.5), "10.5");
    }
}
