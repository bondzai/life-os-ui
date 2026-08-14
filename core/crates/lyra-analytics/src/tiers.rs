//! The Capital Ladder: tier classification and drift-vs-target — port of `analysis.py`
//! (`TIERS`, `classify`, `tier_totals`, `rebalance_plan`) as consumed by `pow_mcp`.
//!
//! Assets are ranked base (safe/liquid) → apex (speculative), and the whole point of the ladder
//! is that *drift* is measured against the user's own targets rather than against a market view.
//! Nothing here predicts anything: it reports where the book sits versus where the user said it
//! should sit.
//!
//! **The classification rules are ported verbatim, including their ordering.** Category beats
//! symbol (an LP of two stablecoins is productive capital, not reserve), yield-bearing wrappers
//! beat the stable list (`sUSDe` is a yield position, not cash), and anything unrecognized falls
//! to `highrisk` — the conservative direction to be wrong in. Re-ordering these checks silently
//! re-tiers the portfolio and invalidates every drift number the user has ever seen.

use serde::{Deserialize, Serialize};

use crate::envelope::round_dp;

/// One rung of the Capital Ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// Liquidity & dry powder — cash, stablecoins.
    Reserve,
    /// Preserve — BTC, ETH, gold, blue-chip.
    Store,
    /// Productive — spot bot, LPs, vaults, staking.
    Cashflow,
    /// Speculation — futures bot, perps, alts.
    Highrisk,
}

/// Base → apex. This order is load-bearing: it is the order rows appear in the ladder and in
/// the drift plan, and the API contract downstream depends on it.
pub const TIER_ORDER: [Tier; 4] = [Tier::Reserve, Tier::Store, Tier::Cashflow, Tier::Highrisk];

/// Drift inside this many percentage points of target counts as on-target. Rebalancing costs
/// gas and taxes, so a band beats a knife-edge.
pub const REB_TOL: f64 = 2.5;

impl Tier {
    /// The wire key, matching Python's dict keys.
    pub fn key(self) -> &'static str {
        match self {
            Tier::Reserve => "reserve",
            Tier::Store => "store",
            Tier::Cashflow => "cashflow",
            Tier::Highrisk => "highrisk",
        }
    }

    /// Roman rank, base → apex.
    pub fn rank(self) -> &'static str {
        match self {
            Tier::Reserve => "I",
            Tier::Store => "II",
            Tier::Cashflow => "III",
            Tier::Highrisk => "IV",
        }
    }

    /// Human label used in the UI and in agent-facing summaries.
    pub fn label(self) -> &'static str {
        match self {
            Tier::Reserve => "Reserve",
            Tier::Store => "Store of Value",
            Tier::Cashflow => "Investment & Income",
            Tier::Highrisk => "High Risk",
        }
    }

    /// What the rung is *for* — the sentence that makes the tiering legible to a human.
    pub fn desc(self) -> &'static str {
        match self {
            Tier::Reserve => "liquidity & dry powder — cash, stablecoins",
            Tier::Store => "preserve — BTC, ETH, gold, blue-chip",
            Tier::Cashflow => "productive — spot bot, LPs, vaults, staking",
            Tier::Highrisk => "speculation — futures bot, perps, alts",
        }
    }
}

/// Dollar-pegged symbols → the Reserve rung.
pub const STABLES: [&str; 16] = [
    "USDC", "USDT", "DAI", "USDE", "USDC.E", "TUSD", "FRAX", "PYUSD", "GUSD", "LUSD", "SUSD",
    "USDP", "USDD", "BUSD", "FDUSD", "USDS",
];

/// Hard money — BTC/ETH and their liquid wrappers, plus tokenized gold → Store of Value.
pub const HARD: [&str; 16] = [
    "BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "ETH", "WETH", "STETH", "WSTETH", "RETH", "WEETH",
    "XAUT", "PAXG", "KAU", "XAU", "GOLD",
];

/// Wrappers that *are* a yield position rather than the asset they are pegged to. Checked before
/// the stable list on purpose: `sUSDe` is cashflow, not cash.
pub const YIELD_TOKENS: [&str; 11] = [
    "JLP", "GLP", "SDAI", "SUSDE", "SUSDS", "GDAI", "AUSDC", "CUSDC", "GHO", "MSOL", "JITOSOL",
];

/// Map a holding to a Capital Ladder tier. Same rules, and the same order of rules, as the web
/// app and `analysis.classify`.
pub fn classify(symbol: Option<&str>, category: Option<&str>) -> Tier {
    let sym = symbol.unwrap_or("").to_uppercase();
    match category.unwrap_or("") {
        // Category wins over symbol: what the capital is *doing* outranks what it is denominated in.
        "Perps" | "Futures" => return Tier::Highrisk,
        "Rebalance" | "Spot Grid" | "Liquidity Pool" | "Yield" => return Tier::Cashflow,
        _ => {}
    }
    let s = sym.as_str();
    if YIELD_TOKENS.contains(&s) {
        Tier::Cashflow
    } else if STABLES.contains(&s) {
        Tier::Reserve
    } else if HARD.contains(&s) {
        Tier::Store
    } else {
        // Unknown means unproven. Falling to speculation is the safe direction to be wrong in.
        Tier::Highrisk
    }
}

/// One asset row as the ladder maths sees it. Minimal on purpose — the adapter maps the real
/// portfolio onto this, and the maths stays trivially testable.
///
/// Rows are expected to be pre-filtered to `usd > 0` (the Python `holdings()` does this before
/// the plan ever sees them); dust and zero-value rows only add noise to the percentages.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Holding {
    #[serde(default)]
    pub symbol: Option<String>,
    /// The engine's own position category (`Liquidity Pool`, `Perps`, …) when it has one.
    #[serde(default)]
    pub category: Option<String>,
    pub usd: f64,
    /// Pre-assigned tier. When present it wins over [`classify`], so an adapter that already
    /// knows the tier (e.g. a bot leg) does not have to round-trip through a fake symbol.
    #[serde(default)]
    pub tier: Option<Tier>,
}

impl Holding {
    /// The rung this holding sits on.
    pub fn tier(&self) -> Tier {
        self.tier
            .unwrap_or_else(|| classify(self.symbol.as_deref(), self.category.as_deref()))
    }
}

/// USD per rung, in [`TIER_ORDER`].
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct TierTotals {
    pub reserve: f64,
    pub store: f64,
    pub cashflow: f64,
    pub highrisk: f64,
}

impl TierTotals {
    pub fn get(&self, tier: Tier) -> f64 {
        match tier {
            Tier::Reserve => self.reserve,
            Tier::Store => self.store,
            Tier::Cashflow => self.cashflow,
            Tier::Highrisk => self.highrisk,
        }
    }

    pub fn add(&mut self, tier: Tier, usd: f64) {
        match tier {
            Tier::Reserve => self.reserve += usd,
            Tier::Store => self.store += usd,
            Tier::Cashflow => self.cashflow += usd,
            Tier::Highrisk => self.highrisk += usd,
        }
    }

    /// Sum across every rung.
    pub fn total(&self) -> f64 {
        self.reserve + self.store + self.cashflow + self.highrisk
    }
}

/// Target allocation in percent. The user's own policy — never a recommendation from this crate.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TierTargets {
    pub reserve: f64,
    pub store: f64,
    pub cashflow: f64,
    pub highrisk: f64,
}

impl Default for TierTargets {
    fn default() -> Self {
        Self {
            reserve: 10.0,
            store: 40.0,
            cashflow: 30.0,
            highrisk: 20.0,
        }
    }
}

impl TierTargets {
    pub fn get(&self, tier: Tier) -> f64 {
        match tier {
            Tier::Reserve => self.reserve,
            Tier::Store => self.store,
            Tier::Cashflow => self.cashflow,
            Tier::Highrisk => self.highrisk,
        }
    }
}

/// What to do about a rung's drift.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftAction {
    OnTarget,
    Add,
    Trim,
}

impl DriftAction {
    pub fn as_str(self) -> &'static str {
        match self {
            DriftAction::OnTarget => "on_target",
            DriftAction::Add => "add",
            DriftAction::Trim => "trim",
        }
    }
}

/// One rung's position versus its target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DriftRow {
    pub tier: Tier,
    pub label: String,
    pub rank: String,
    pub value_usd: f64,
    pub now_pct: f64,
    pub target_pct: f64,
    /// `now − target`, signed: positive is overweight.
    pub drift_pct: f64,
    pub action: DriftAction,
    /// Absolute dollars to move to land exactly on target.
    pub action_usd: f64,
}

/// The full ladder-vs-target picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RebalancePlan {
    pub total_usd: f64,
    pub tolerance_pct: f64,
    pub tiers: Vec<DriftRow>,
}

/// Sum holdings onto their rungs.
pub fn tier_totals(holdings: &[Holding]) -> TierTotals {
    let mut totals = TierTotals::default();
    for h in holdings {
        totals.add(h.tier(), h.usd);
    }
    totals
}

/// Per-tier drift versus target plus the exact dollars to add (underweight) or trim (overweight).
pub fn rebalance_plan(holdings: &[Holding], targets: Option<&TierTargets>) -> RebalancePlan {
    let total: f64 = holdings.iter().map(|h| h.usd).sum();
    plan_from_totals(&tier_totals(holdings), total, targets)
}

/// The same plan from pre-aggregated rung totals, for an adapter that has already tiered its
/// rows. `total` is passed separately rather than derived so it matches Python, which sums the
/// holding rows themselves.
pub fn plan_from_totals(
    totals: &TierTotals,
    total: f64,
    targets: Option<&TierTargets>,
) -> RebalancePlan {
    let targets = targets.copied().unwrap_or_default();
    let tiers = TIER_ORDER
        .iter()
        .map(|&tier| {
            let cur = if total != 0.0 {
                totals.get(tier) / total * 100.0
            } else {
                0.0
            };
            let tgt = targets.get(tier);
            // Signed dollars to reach target: positive = buy, negative = sell.
            let delta = (tgt - cur) / 100.0 * total;
            // An empty book is on-target by definition — there is nothing to rebalance, and
            // reporting a 100%-underweight reserve on a $0 portfolio is noise, not information.
            let on_target = total == 0.0 || (cur - tgt).abs() <= REB_TOL;
            DriftRow {
                tier,
                label: tier.label().to_string(),
                rank: tier.rank().to_string(),
                value_usd: round_dp(totals.get(tier), 2),
                now_pct: round_dp(cur, 1),
                target_pct: tgt,
                drift_pct: round_dp(cur - tgt, 1),
                action: if on_target {
                    DriftAction::OnTarget
                } else if delta > 0.0 {
                    DriftAction::Add
                } else {
                    DriftAction::Trim
                },
                action_usd: round_dp(delta.abs(), 2),
            }
        })
        .collect();
    RebalancePlan {
        total_usd: round_dp(total, 2),
        tolerance_pct: REB_TOL,
        tiers,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn holding(symbol: &str, usd: f64) -> Holding {
        Holding {
            symbol: Some(symbol.to_string()),
            usd,
            ..Default::default()
        }
    }

    #[test]
    fn category_outranks_symbol() {
        // A USDC/USDT LP is productive capital, not idle reserve.
        assert_eq!(
            classify(Some("USDC"), Some("Liquidity Pool")),
            Tier::Cashflow
        );
        assert_eq!(classify(Some("BTC"), Some("Perps")), Tier::Highrisk);
        assert_eq!(classify(Some("USDT"), Some("Futures")), Tier::Highrisk);
        assert_eq!(classify(Some("ETH"), Some("Spot Grid")), Tier::Cashflow);
    }

    #[test]
    fn yield_wrappers_beat_the_stable_list() {
        assert_eq!(classify(Some("sUSDe"), None), Tier::Cashflow);
        assert_eq!(classify(Some("USDE"), None), Tier::Reserve);
    }

    #[test]
    fn symbols_are_case_insensitive_and_unknowns_are_speculation() {
        assert_eq!(classify(Some("wbtc"), None), Tier::Store);
        assert_eq!(classify(Some("PEPE"), None), Tier::Highrisk);
        assert_eq!(classify(None, None), Tier::Highrisk);
    }

    #[test]
    fn an_empty_book_is_on_target_everywhere() {
        let plan = rebalance_plan(&[], None);
        assert_eq!(plan.total_usd, 0.0);
        assert!(plan.tiers.iter().all(|t| t.action == DriftAction::OnTarget));
        assert!(plan.tiers.iter().all(|t| t.action_usd == 0.0));
        assert!(plan.tiers.iter().all(|t| t.now_pct == 0.0));
    }

    #[test]
    fn drift_is_signed_and_action_dollars_close_the_gap() {
        // 100% reserve against a 10% target: massively overweight reserve, everything else empty.
        let plan = rebalance_plan(&[holding("USDC", 1000.0)], None);
        let reserve = &plan.tiers[0];
        assert_eq!(reserve.now_pct, 100.0);
        assert_eq!(reserve.drift_pct, 90.0);
        assert_eq!(reserve.action, DriftAction::Trim);
        assert_eq!(reserve.action_usd, 900.0);
        let store = &plan.tiers[1];
        assert_eq!(store.action, DriftAction::Add);
        assert_eq!(store.action_usd, 400.0);
    }

    #[test]
    fn drift_within_tolerance_is_on_target() {
        // Reserve at 12% vs a 10% target — inside the 2.5pt band.
        let plan = rebalance_plan(
            &[holding("USDC", 120.0), holding("BTC", 880.0)],
            Some(&TierTargets {
                reserve: 10.0,
                store: 88.0,
                cashflow: 1.0,
                highrisk: 1.0,
            }),
        );
        assert_eq!(plan.tiers[0].action, DriftAction::OnTarget);
        assert_eq!(plan.tiers[0].drift_pct, 2.0);
        // ...but the dollar gap is still reported, so the caller can decide for itself.
        assert_eq!(plan.tiers[0].action_usd, 20.0);
    }

    #[test]
    fn an_explicit_tier_overrides_classification() {
        let h = Holding {
            symbol: Some("PEPE".to_string()),
            tier: Some(Tier::Reserve),
            usd: 5.0,
            ..Default::default()
        };
        assert_eq!(h.tier(), Tier::Reserve);
        assert_eq!(tier_totals(&[h]).reserve, 5.0);
    }
}
