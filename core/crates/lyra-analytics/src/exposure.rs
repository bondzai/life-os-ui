//! True underlying-asset exposure and HHI concentration — port of `analysis.py`
//! (`SYM_ALIAS`, `norm_sym`, `exposure_map`) and `pow_mcp/analytics.py` (`concentration`).
//!
//! A tier breakdown answers "what kind of capital do I hold"; this answers the sharper question
//! "what am I actually long of". Baskets, LP pairs and bot collateral are unwrapped down to the
//! coins underneath, and wrappers are folded onto the asset they track — holding WBTC on one
//! chain and cbBTC on another is one Bitcoin bet, not two, and only the unwrapped view can say
//! so. Concentration measured on the wrapped view would flatter the book precisely when it is
//! most concentrated.

use serde::{Deserialize, Serialize};

use crate::envelope::{TokenAmount, round_dp};

/// Wrapper/liquid-staking symbols folded onto the asset they actually track.
///
/// Deliberately one-way and lossy: `wstETH` is ETH exposure for concentration purposes even
/// though it is not redeemable 1:1 on demand. That approximation is why the *risk* it hides
/// (depeg, validator slashing) belongs in a data gap, not in the number.
pub const SYM_ALIAS: [(&str, &str); 25] = [
    ("WBTC", "BTC"),
    ("CBBTC", "BTC"),
    ("TBTC", "BTC"),
    ("LBTC", "BTC"),
    ("BTC.B", "BTC"),
    ("WETH", "ETH"),
    ("STETH", "ETH"),
    ("WSTETH", "ETH"),
    ("RETH", "ETH"),
    ("WEETH", "ETH"),
    ("ETH.B", "ETH"),
    ("WSOL", "SOL"),
    ("MSOL", "SOL"),
    ("JITOSOL", "SOL"),
    ("WPOL", "POL"),
    ("WMATIC", "POL"),
    ("MATIC", "POL"),
    ("WBNB", "BNB"),
    ("WAVAX", "AVAX"),
    ("WHYPE", "HYPE"),
    ("USDC.E", "USDC"),
    ("XAUT", "GOLD"),
    ("PAXG", "GOLD"),
    ("KAU", "GOLD"),
    ("XAU", "GOLD"),
];

/// The protocol whose position value *is* USDT collateral rather than the coins it trades.
const FUTURES_BOT_PROTOCOL: &str = "KuCoin Futures Bot";

/// Uppercase a symbol and fold wrappers onto their underlying asset.
pub fn norm_sym(symbol: &str) -> String {
    let upper = symbol.to_uppercase();
    SYM_ALIAS
        .iter()
        .find(|(from, _)| *from == upper)
        .map_or(upper, |(_, to)| (*to).to_string())
}

/// A DeFi position reduced to the fields the exposure unwrap actually looks at.
///
/// The adapter fills this in from the real portfolio; every branch below mirrors a real shape
/// the engine emits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct DefiPosition {
    pub protocol: String,
    /// The position's own USD value.
    #[serde(default)]
    pub usd: Option<f64>,
    /// Pool tokens / basket legs. Each leg's `usd` is `None` when the engine could not price it.
    #[serde(default)]
    pub tokens: Vec<TokenAmount>,
    /// A rebalance bot's target weights, when this position is a basket.
    #[serde(default)]
    pub bot_weights: Vec<TokenAmount>,
    /// True when this row is a lending/borrow line (`health` present in the engine).
    #[serde(default)]
    pub is_lending: bool,
}

/// One unwrapped asset and the dollars behind it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExposureRow {
    pub asset: String,
    pub usd: f64,
}

/// True asset exposure: unwrap every basket / LP / bot into the underlying coins.
///
/// Returned sorted by USD descending, ties keeping first-seen order, so the output is
/// deterministic for a given input — an agent diffing two snapshots should see real movement,
/// not map-iteration noise.
///
/// Lending lines are skipped: a borrow row is a liability, not an asset exposure, and adding it
/// would double-count collateral that already appears in spot.
pub fn exposure_map(spot: &[TokenAmount], defi: &[DefiPosition]) -> Vec<ExposureRow> {
    let mut exposure: Vec<ExposureRow> = Vec::new();
    let mut add = |symbol: &str, usd: f64| {
        let asset = norm_sym(symbol);
        // Only positive, named exposure counts. A zero-dollar or unnamed leg tells us nothing.
        if asset.is_empty() || usd <= 0.0 {
            return;
        }
        match exposure.iter_mut().find(|r| r.asset == asset) {
            Some(row) => row.usd += usd,
            None => exposure.push(ExposureRow { asset, usd }),
        }
    };

    for token in spot {
        add(&token.symbol, token.usd.unwrap_or(0.0));
    }
    for position in defi {
        if position.is_lending {
            continue;
        }
        if !position.bot_weights.is_empty() {
            // A rebalance basket knows its own composition — use it.
            for weight in &position.bot_weights {
                add(&weight.symbol, weight.usd.unwrap_or(0.0));
            }
        } else if position.protocol == FUTURES_BOT_PROTOCOL {
            // A perp bot's economic exposure is its USDT collateral, not the pairs it trades.
            add("USDT", position.usd.unwrap_or(0.0));
        } else if !position.tokens.is_empty() && position.tokens.iter().all(|t| t.usd.is_some()) {
            // A fully priced LP pair splits across both legs.
            for token in &position.tokens {
                add(&token.symbol, token.usd.unwrap_or(0.0));
            }
        } else {
            // Partially priced: attribute the whole position to its first token rather than
            // inventing per-leg values. Falls back to the protocol name when even that is
            // missing, so the dollars stay visible under an honest label instead of vanishing.
            let label = position
                .tokens
                .first()
                .map(|t| t.symbol.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(position.protocol.as_str());
            add(label, position.usd.unwrap_or(0.0));
        }
    }

    exposure.sort_by(|a, b| b.usd.total_cmp(&a.usd));
    exposure
}

/// HHI concentration over true underlying exposure, plus the top asset's share and the stable
/// share.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Concentration {
    /// Herfindahl–Hirschman index, 0..1 — higher is more concentrated. `None` when there is no
    /// exposure to measure.
    pub hhi: Option<f64>,
    pub top_asset: Option<String>,
    pub top_asset_pct: Option<f64>,
    pub stablecoin_pct: Option<f64>,
    pub note: String,
}

/// The note carried when there is nothing to measure. An empty book has no concentration —
/// reporting `hhi: 0.0` would claim perfect diversification, which is the opposite of the truth.
pub const NO_EXPOSURE_NOTE: &str = "no exposure to measure";

const HHI_NOTE: &str = "HHI over underlying assets; 1.0 = single-asset, ~0.1 = ~10 equal assets";

/// Sum of squared shares over the unwrapped exposure map.
///
/// HHI is the right primitive here because it is superlinear: it punishes one 60% position far
/// harder than six 10% positions, which is exactly how single-asset risk actually behaves. A
/// single position scores 1.0 (maximal); *n* equal positions score 1/*n*.
///
/// With no exposure, every field is `None` with the reason in `note` — never a zero that would
/// read as "well diversified".
pub fn concentration(exposure: &[ExposureRow]) -> Concentration {
    let total: f64 = exposure.iter().map(|r| r.usd).sum();
    if total <= 0.0 {
        return Concentration {
            hhi: None,
            top_asset: None,
            top_asset_pct: None,
            stablecoin_pct: None,
            note: NO_EXPOSURE_NOTE.to_string(),
        };
    }
    let shares: Vec<(&str, f64)> = exposure
        .iter()
        .map(|r| (r.asset.as_str(), r.usd / total))
        .collect();
    let hhi = round_dp(shares.iter().map(|(_, s)| s * s).sum::<f64>(), 3);
    // First maximal share wins, matching Python's `max()` on ties.
    let (top_asset, top_share) =
        shares
            .iter()
            .fold(("", f64::NEG_INFINITY), |best, &(asset, share)| {
                if share > best.1 { (asset, share) } else { best }
            });
    let stable: f64 = shares
        .iter()
        .filter(|(asset, _)| is_stable(asset))
        .map(|(_, share)| share)
        .sum();
    Concentration {
        hhi: Some(hhi),
        top_asset: Some(top_asset.to_string()),
        top_asset_pct: Some(round_dp(top_share * 100.0, 1)),
        stablecoin_pct: Some(round_dp(stable * 100.0, 1)),
        note: HHI_NOTE.to_string(),
    }
}

/// Whether an exposure key is a dollar peg, before or after alias normalization (`USDC.E`
/// survives either way).
fn is_stable(asset: &str) -> bool {
    let upper = asset.to_uppercase();
    crate::tiers::STABLES.contains(&norm_sym(asset).as_str())
        || crate::tiers::STABLES.contains(&upper.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(asset: &str, usd: f64) -> ExposureRow {
        ExposureRow {
            asset: asset.to_string(),
            usd,
        }
    }

    fn tok(symbol: &str, usd: f64) -> TokenAmount {
        TokenAmount::new(symbol, Some(usd))
    }

    #[test]
    fn wrappers_fold_onto_the_asset_they_track() {
        assert_eq!(norm_sym("wstETH"), "ETH");
        assert_eq!(norm_sym("cbBTC"), "BTC");
        assert_eq!(norm_sym("USDC.e"), "USDC");
        assert_eq!(norm_sym("PAXG"), "GOLD");
        assert_eq!(norm_sym("pepe"), "PEPE");
        assert_eq!(norm_sym(""), "");
    }

    #[test]
    fn one_bitcoin_bet_across_three_wrappers_is_one_exposure() {
        let spot = [tok("WBTC", 100.0), tok("cbBTC", 50.0), tok("BTC", 25.0)];
        let exposure = exposure_map(&spot, &[]);
        assert_eq!(exposure, vec![row("BTC", 175.0)]);
    }

    #[test]
    fn lending_lines_are_not_exposure() {
        let defi = [DefiPosition {
            protocol: "Aave V3".to_string(),
            usd: Some(-500.0),
            is_lending: true,
            ..Default::default()
        }];
        assert!(exposure_map(&[], &defi).is_empty());
    }

    #[test]
    fn a_priced_lp_pair_splits_across_both_legs() {
        let defi = [DefiPosition {
            protocol: "Uniswap V3".to_string(),
            usd: Some(1000.0),
            tokens: vec![tok("WETH", 600.0), tok("USDC", 400.0)],
            ..Default::default()
        }];
        assert_eq!(
            exposure_map(&[], &defi),
            vec![row("ETH", 600.0), row("USDC", 400.0)]
        );
    }

    #[test]
    fn an_unpriced_leg_falls_back_to_the_whole_position() {
        let defi = [DefiPosition {
            protocol: "Some Vault".to_string(),
            usd: Some(300.0),
            tokens: vec![tok("WETH", 200.0), TokenAmount::new("MYSTERY", None)],
            ..Default::default()
        }];
        // Not 200/100 — the split is unknown, so the whole position lands on the first token.
        assert_eq!(exposure_map(&[], &defi), vec![row("ETH", 300.0)]);
    }

    #[test]
    fn a_perp_bot_is_its_usdt_collateral() {
        let defi = [DefiPosition {
            protocol: FUTURES_BOT_PROTOCOL.to_string(),
            usd: Some(750.0),
            ..Default::default()
        }];
        assert_eq!(exposure_map(&[], &defi), vec![row("USDT", 750.0)]);
    }

    #[test]
    fn a_basket_uses_its_own_weights() {
        let defi = [DefiPosition {
            protocol: "KuCoin Rebalance Bot".to_string(),
            usd: Some(300.0),
            bot_weights: vec![tok("BTC", 200.0), tok("wSOL", 100.0)],
            ..Default::default()
        }];
        assert_eq!(
            exposure_map(&[], &defi),
            vec![row("BTC", 200.0), row("SOL", 100.0)]
        );
    }

    #[test]
    fn an_empty_book_has_no_concentration_not_zero_concentration() {
        let c = concentration(&[]);
        assert_eq!(c.hhi, None, "an empty book must not read as diversified");
        assert_eq!(c.top_asset, None);
        assert_eq!(c.top_asset_pct, None);
        assert_eq!(c.stablecoin_pct, None);
        assert_eq!(c.note, NO_EXPOSURE_NOTE);
    }

    #[test]
    fn a_single_asset_is_maximal_concentration() {
        let c = concentration(&[row("BTC", 1234.56)]);
        assert_eq!(c.hhi, Some(1.0));
        assert_eq!(c.top_asset.as_deref(), Some("BTC"));
        assert_eq!(c.top_asset_pct, Some(100.0));
        assert_eq!(c.stablecoin_pct, Some(0.0));
    }

    #[test]
    fn n_equal_assets_score_one_over_n() {
        let even: Vec<ExposureRow> = ["BTC", "ETH", "SOL", "USDC"]
            .iter()
            .map(|a| row(a, 250.0))
            .collect();
        assert_eq!(concentration(&even).hhi, Some(0.25));
        assert_eq!(concentration(&even).top_asset_pct, Some(25.0));
        assert_eq!(concentration(&even).stablecoin_pct, Some(25.0));
    }

    #[test]
    fn stables_count_before_and_after_normalization() {
        let c = concentration(&[row("USDC.E", 500.0), row("BTC", 500.0)]);
        assert_eq!(c.stablecoin_pct, Some(50.0));
    }
}
