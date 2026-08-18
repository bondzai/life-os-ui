//! Portfolio snapshot → digest figures — the port of `notify.py:_collect` (L359).
//!
//! # Why this lives here and not in `lyra-alerts`
//!
//! `lyra-alerts` deliberately takes plain input structs (`rules::PositionInput`,
//! `digest::DigestInput`) rather than depending on `lyra-chain`. That keeps the alert logic
//! testable without a chain model, and it is the same seam `rules.rs` already uses. This module is
//! the adapter between the two, and `lyra-api` is the one crate that owns both sides.
//!
//! # What it computes, and the one piece of arithmetic worth reading twice
//!
//! `contrib` is a **signed 24h contribution in USD with the pre-move value backed out**:
//!
//! ```text
//! contrib += usd * (chg/100) / (1 + chg/100)
//! ```
//!
//! The division is the part that matters. `usd` is the holding's value *now*, i.e. after the move,
//! so `usd * chg` would overstate a gain and understate a loss. Dividing by `1 + chg` recovers the
//! pre-move value first, which is what makes these numbers sum to the portfolio's actual 24h
//! change — and what makes them agree with the web app's mover math rather than being a second,
//! subtly different answer to the same question.
//!
//! # Scope
//!
//! `_collect` also produces `exposure`, `kpis` and `lp_in`/`lp_out`. Those feed `sec_exposure`
//! and `sec_kpis`, which the Python's own comments mark as **not in the daily REPORT** — they
//! belong to the on-demand `/overview` command. `DigestInput` carries only what the brief renders,
//! so they are not computed here.

use lyra_alerts::digest::{DigestInput, Mover, PoolLine, Tiers};
use lyra_chain::model::{PortfolioSnapshot, Position, SpotToken};

/// Symbols that count toward the BTC stack — `_BTC_SYMS` (notify.py L311).
///
/// Wrapped and bridged forms included: the stack is about how much bitcoin you have, not which
/// contract is holding it.
pub const BTC_SYMBOLS: [&str; 7] = ["BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "BTC.B", "UBTC"];

/// Hard money held directly — `_HARD` (notify.py L321).
///
/// Mirrors `web/src/lib/compute.ts`'s set. Keep the two in step, or the brief's allocation bar
/// disagrees with the Overview's tier card about the same holdings.
pub const HARD: [&str; 16] = [
    "BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "UBTC", "ETH", "WETH", "STETH", "WSTETH", "RETH",
    "WEETH", "XAUT", "PAXG", "KAU", "XAU",
];

/// Categories that mean a CEX bot or a derivative — `_TRADING_CATS`.
pub const TRADING_CATS: [&str; 4] = ["Perps", "Futures", "Rebalance", "Spot Grid"];

/// Categories that mean productive DeFi — `_BUSINESS_CATS`.
pub const BUSINESS_CATS: [&str; 2] = ["Liquidity Pool", "Yield"];

/// Which rung of the three-tier Capital Ladder a holding sits on — `_tier` (notify.py L327).
///
/// Coarser than the four-rung ladder in `lyra-analytics`, and deliberately so: this one has to
/// match the web app's tier card, which the brief's allocation bar is a text rendering of.
///
/// The default is `business`, not `store`: cash, stables and alts are all working capital. Only
/// hard money held **directly** is a store, which is why an LP whose legs are WBTC classifies as
/// business — the position is productive even when its contents are not.
#[must_use]
pub fn tier(symbol: Option<&str>, category: Option<&str>) -> &'static str {
    if let Some(category) = category {
        if TRADING_CATS.contains(&category) {
            return "trading";
        }
        if BUSINESS_CATS.contains(&category) {
            return "business";
        }
    }
    let upper = symbol.unwrap_or_default().to_uppercase();
    if HARD.contains(&upper.as_str()) {
        "store"
    } else {
        "business"
    }
}

/// Whether a symbol counts toward the BTC stack — `_is_btc`.
#[must_use]
pub fn is_btc(symbol: Option<&str>) -> bool {
    let upper = symbol.unwrap_or_default().to_uppercase();
    BTC_SYMBOLS.contains(&upper.as_str())
}

/// The pre-move value backed out of a 24h percentage change — see the module docs.
///
/// `1 + chg/100 == 0` would mean the holding lost exactly 100% of its value, which makes the
/// pre-move value unrecoverable rather than infinite; contributing nothing is the honest answer.
#[must_use]
pub fn contribution(usd: f64, change_pct: f64) -> f64 {
    let factor = 1.0 + change_pct / 100.0;
    if factor == 0.0 {
        return 0.0;
    }
    usd * (change_pct / 100.0) / factor
}

/// Accumulates `label -> contribution`, preserving first-seen order.
///
/// Order matters because the renderer's sort is stable: two movers with equal contribution keep
/// the order they were collected in, so the brief does not reshuffle between sends.
#[derive(Debug, Default)]
struct Movers(Vec<Mover>);

impl Movers {
    /// Port of `_collect`'s inner `add`. A holding worth nothing has nothing to contribute, so it
    /// is skipped before it can claim a label in the list.
    fn add(&mut self, label: Option<&str>, usd: f64, change_pct: Option<f64>) {
        if usd <= 0.0 {
            return;
        }
        let label = match label {
            Some(label) if !label.is_empty() => label.to_string(),
            _ => "?".to_string(),
        };
        let slot = match self.0.iter_mut().find(|m| m.label == label) {
            Some(slot) => slot,
            None => {
                self.0.push(Mover {
                    label,
                    contrib_usd: 0.0,
                });
                self.0.last_mut().expect("just pushed")
            }
        };
        if let Some(change) = change_pct {
            slot.contrib_usd += contribution(usd, change);
        }
    }
}

/// Running totals, so the spot and DeFi arms read as the Python's single loop does.
#[derive(Debug, Default)]
struct Totals {
    total: f64,
    claimable: f64,
    contrib: f64,
    btc_usd: f64,
    debt: f64,
    collateral: f64,
    hf_min: Option<f64>,
    tiers: Tiers,
}

impl Totals {
    fn add_tier(&mut self, rung: &str, usd: f64) {
        match rung {
            "store" => self.tiers.store += usd,
            "trading" => self.tiers.trading += usd,
            _ => self.tiers.business += usd,
        }
    }
}

/// Aggregate a portfolio snapshot into the figures the daily brief renders.
///
/// `btc_price` comes from the snapshot's own rates. It is what turns BTC *reserves in USD* into
/// **sats** — a coin amount, and therefore price-invariant, so the "stacked since last" delta in
/// the brief reflects actual accumulation rather than a price wiggle.
#[must_use]
pub fn collect(snapshot: &PortfolioSnapshot) -> DigestInput {
    let mut totals = Totals::default();
    let mut movers = Movers::default();
    let mut pools: Vec<PoolLine> = Vec::new();

    for wallet in &snapshot.wallets {
        for chain in &wallet.chains {
            for token in &chain.spot {
                collect_spot(token, &mut totals, &mut movers);
            }
            for position in &chain.defi {
                collect_position(position, &mut totals, &mut movers, &mut pools);
            }
        }
    }

    let btc_price = snapshot.rates.btc_usd;
    let btc_sats = btc_price
        .filter(|price| *price > 0.0)
        .map(|price| totals.btc_usd * 1e8 / price);

    DigestInput {
        total: totals.total,
        contrib: totals.contrib,
        claimable: totals.claimable,
        btc_usd: totals.btc_usd,
        btc_price,
        btc_sats,
        debt: totals.debt,
        collateral: totals.collateral,
        hf_min: totals.hf_min,
        tiers: totals.tiers,
        movers: movers.0,
        pools,
    }
}

/// One spot balance's contribution to the figures.
fn collect_spot(token: &SpotToken, totals: &mut Totals, movers: &mut Movers) {
    let usd = token.usd.unwrap_or(0.0);
    let symbol = token.symbol.as_deref();

    totals.total += usd;
    // A spot token has no category, so this is the symbol test alone.
    totals.add_tier(tier(symbol, None), usd);
    if is_btc(symbol) {
        totals.btc_usd += usd;
    }

    // `Nullable` is `Option<Option<_>>`: the outer is key presence, the inner is JSON null. The
    // Python's `if ch is not None` means "present and not null", which is exactly `flatten`.
    let change = token.change24h.flatten();
    movers.add(symbol, usd, change);
    if let Some(change) = change {
        // Outside the `usd > 0` guard `add` applies, matching the Python: the per-label mover
        // list skips worthless holdings, the portfolio-wide total does not.
        totals.contrib += contribution(usd, change);
    }
}

/// One DeFi position's contribution to the figures, and its ledger line.
fn collect_position(
    position: &Position,
    totals: &mut Totals,
    movers: &mut Movers,
    pools: &mut Vec<PoolLine>,
) {
    let usd = position.usd.unwrap_or(0.0);
    totals.total += usd;

    // The Python reads `(toks or [{}])[0].get("symbol")` — the first leg names the position for
    // tier purposes, and a position with no legs falls through to the category test alone.
    let first_symbol = position.tokens.first().map(|leg| leg.symbol.as_str());
    totals.add_tier(tier(first_symbol, Some(&position.category)), usd);

    let fees = position.rewards_usd.flatten().unwrap_or(0.0);
    totals.claimable += fees;

    // BTC legs held inside an LP or a vault count toward the stack: the bitcoin is yours whether
    // it is sitting in the wallet or working in a pool.
    for leg in &position.tokens {
        if is_btc(Some(&leg.symbol)) {
            totals.btc_usd += leg.usd.unwrap_or(0.0);
        }
    }

    if let Some(health) = &position.health {
        totals.debt += health.debt_usd;
        totals.collateral += health.collateral_usd;
        if let Some(hf) = health.hf {
            totals.hf_min = Some(match totals.hf_min {
                Some(current) => current.min(hf),
                None => hf,
            });
        }
    }

    // `name or protocol`, which is how the ledger and the mover list both label a position.
    let label = if position.name.is_empty() {
        position.protocol.as_str()
    } else {
        position.name.as_str()
    };

    pools.push(PoolLine {
        name: if label.is_empty() {
            "position".to_string()
        } else {
            label.to_string()
        },
        protocol: position.protocol.clone(),
        usd,
        fees,
        // `None` keeps a position out of the LP ledger entirely — an exchange bot rides in through
        // the same `defi[]` array but has no range, so it would render as noise. It is still in
        // net worth.
        in_range: position.in_range,
    });

    let change = position.change24h.flatten();
    movers.add(Some(label), usd, change);
    if let Some(change) = change {
        totals.contrib += contribution(usd, change);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_chain::market::Rates;
    use lyra_chain::model::{
        ChainBucket, LendingHealth, PortfolioSentiment, Position, SpotToken, TokenAmt, Wallet,
    };

    fn spot(symbol: &str, usd: f64, change: Option<f64>) -> SpotToken {
        SpotToken {
            symbol: Some(symbol.to_string()),
            amount: 1.0,
            price: Some(usd),
            usd: Some(usd),
            change24h: change.map(Some),
            ..SpotToken::default()
        }
    }

    fn position(name: &str, category: &str, usd: f64) -> Position {
        let mut found = Position::new("Aerodrome", category, name, Some(usd));
        found.protocol = "Aerodrome".to_string();
        found
    }

    fn snapshot(
        spot: Vec<SpotToken>,
        defi: Vec<Position>,
        btc_usd: Option<f64>,
    ) -> PortfolioSnapshot {
        PortfolioSnapshot::new(
            vec!["0xabc".into()],
            vec![Wallet::new(
                "0xabc",
                vec![ChainBucket {
                    chain: "base".into(),
                    usd: 0.0,
                    spot,
                    defi,
                }],
            )],
            Rates {
                usd: 1.0,
                thb: None,
                btc_usd,
            },
            PortfolioSentiment::default(),
            1783924800.0,
        )
    }

    // ---- the contribution formula -----------------------------------------

    #[test]
    fn a_contribution_backs_out_the_pre_move_value() {
        // A holding worth $110 after a +10% day started at $100, so it contributed $10 — not the
        // $11 that `usd * chg` would claim.
        assert!((contribution(110.0, 10.0) - 10.0).abs() < 1e-9);
    }

    #[test]
    fn a_loss_contributes_the_right_negative() {
        // $90 after −10% started at $100: a $10 loss.
        assert!((contribution(90.0, -10.0) + 10.0).abs() < 1e-9);
    }

    #[test]
    fn contributions_sum_to_the_portfolios_actual_change() {
        // The property the division exists for. Two holdings, different moves; the parts must add
        // up to the whole, or the brief's movers disagree with its net-worth line.
        let before = 100.0 + 200.0;
        let after = 110.0 + 180.0;
        let sum = contribution(110.0, 10.0) + contribution(180.0, -10.0);
        assert!((sum - (after - before)).abs() < 1e-9);
    }

    #[test]
    fn a_total_loss_contributes_nothing_rather_than_infinity() {
        assert_eq!(contribution(0.0, -100.0), 0.0);
    }

    // ---- tiers -------------------------------------------------------------

    #[test]
    fn hard_money_held_directly_is_the_store_rung() {
        assert_eq!(tier(Some("BTC"), None), "store");
        assert_eq!(tier(Some("wsteth"), None), "store", "case-insensitive");
    }

    #[test]
    fn cash_and_alts_are_working_capital_not_a_store() {
        // The default that is easy to get backwards: stables are business, not store.
        assert_eq!(tier(Some("USDC"), None), "business");
        assert_eq!(tier(None, None), "business");
    }

    #[test]
    fn the_category_wins_over_the_symbol() {
        // A WBTC/USDC pool is productive capital, not a store — the position is working even
        // though its contents are hard money.
        assert_eq!(tier(Some("WBTC"), Some("Liquidity Pool")), "business");
        assert_eq!(tier(Some("BTC"), Some("Perps")), "trading");
    }

    // ---- collection --------------------------------------------------------

    #[test]
    fn spot_balances_total_and_split_by_tier() {
        let input = collect(&snapshot(
            vec![spot("BTC", 1_000.0, None), spot("USDC", 500.0, None)],
            Vec::new(),
            Some(50_000.0),
        ));

        assert_eq!(input.total, 1_500.0);
        assert_eq!(input.tiers.store, 1_000.0);
        assert_eq!(input.tiers.business, 500.0);
        assert_eq!(input.btc_usd, 1_000.0);
    }

    #[test]
    fn btc_reserves_are_reported_in_sats_so_the_delta_is_accumulation_not_price() {
        // 1 BTC at $50k. The sats figure must not move when the price does.
        let a = collect(&snapshot(
            vec![spot("BTC", 50_000.0, None)],
            Vec::new(),
            Some(50_000.0),
        ));
        let b = collect(&snapshot(
            vec![spot("BTC", 60_000.0, None)],
            Vec::new(),
            Some(60_000.0),
        ));

        assert!((a.btc_sats.unwrap() - 1e8).abs() < 1.0);
        assert!(
            (a.btc_sats.unwrap() - b.btc_sats.unwrap()).abs() < 1.0,
            "the same coin at a different price is the same stack"
        );
    }

    #[test]
    fn no_btc_price_means_no_sats_rather_than_a_wrong_number() {
        let input = collect(&snapshot(
            vec![spot("BTC", 50_000.0, None)],
            Vec::new(),
            None,
        ));
        assert_eq!(input.btc_sats, None);
        assert_eq!(input.btc_usd, 50_000.0, "the USD reserve is still known");
    }

    #[test]
    fn wrapped_btc_inside_an_lp_still_counts_toward_the_stack() {
        // The bitcoin is yours whether it sits in the wallet or works in a pool.
        let mut pool = position("WBTC/USDC", "Liquidity Pool", 2_000.0);
        pool.tokens = vec![
            TokenAmt {
                symbol: "WBTC".into(),
                amount: 0.02,
                usd: Some(1_200.0),
                ..TokenAmt::default()
            },
            TokenAmt {
                symbol: "USDC".into(),
                amount: 800.0,
                usd: Some(800.0),
                ..TokenAmt::default()
            },
        ];

        let input = collect(&snapshot(Vec::new(), vec![pool], Some(60_000.0)));
        assert_eq!(input.btc_usd, 1_200.0);
        assert_eq!(input.tiers.business, 2_000.0);
    }

    #[test]
    fn claimable_fees_accumulate_across_positions() {
        let mut a = position("A/B", "Liquidity Pool", 100.0);
        a.rewards_usd = Some(Some(12.5));
        let mut b = position("C/D", "Liquidity Pool", 100.0);
        b.rewards_usd = Some(Some(0.5));

        let input = collect(&snapshot(Vec::new(), vec![a, b], None));
        assert_eq!(input.claimable, 13.0);
    }

    #[test]
    fn the_tightest_health_factor_wins() {
        // `hf_min` is the liquidation buffer the brief flags on. Taking anything but the minimum
        // would report the safest borrow while a riskier one is closer to the edge.
        let mut safe = position("Safe", "Borrowing", -100.0);
        safe.health = Some(LendingHealth {
            hf: Some(2.5),
            ltv: 0.4,
            liq_threshold: 0.8,
            collateral_usd: 1_000.0,
            debt_usd: 100.0,
        });
        let mut risky = position("Risky", "Borrowing", -400.0);
        risky.health = Some(LendingHealth {
            hf: Some(1.15),
            ltv: 0.7,
            liq_threshold: 0.8,
            collateral_usd: 600.0,
            debt_usd: 400.0,
        });

        let input = collect(&snapshot(Vec::new(), vec![safe, risky], None));
        assert_eq!(input.hf_min, Some(1.15));
        assert_eq!(input.debt, 500.0);
        assert_eq!(input.collateral, 1_600.0);
    }

    #[test]
    fn a_null_health_factor_does_not_become_the_minimum() {
        // Aave reports no health factor when there is no debt; treating that as 0 would flag a
        // permanent red alert on a wallet in no danger at all.
        let mut supply = position("Supplied", "Lending", 1_000.0);
        supply.health = Some(LendingHealth {
            hf: None,
            ltv: 0.0,
            liq_threshold: 0.8,
            collateral_usd: 1_000.0,
            debt_usd: 0.0,
        });

        let input = collect(&snapshot(Vec::new(), vec![supply], None));
        assert_eq!(input.hf_min, None);
    }

    #[test]
    fn a_position_with_no_range_stays_out_of_the_lp_ledger() {
        // An exchange bot arrives through the same `defi[]` array. It belongs in net worth and
        // not in the "in range" count, which `in_range: None` is what expresses.
        let bot = position("Spot grid", "Spot Grid", 500.0);
        let mut lp = position("A/B", "Liquidity Pool", 100.0);
        lp.in_range = Some(true);

        let input = collect(&snapshot(Vec::new(), vec![bot, lp], None));
        assert_eq!(input.total, 600.0);
        assert_eq!(input.pools.len(), 2);
        assert_eq!(input.pools[0].in_range, None);
        assert_eq!(input.pools[1].in_range, Some(true));
        assert_eq!(input.tiers.trading, 500.0);
    }

    #[test]
    fn movers_accumulate_per_label_and_keep_first_seen_order() {
        let input = collect(&snapshot(
            vec![
                spot("ETH", 1_100.0, Some(10.0)),
                spot("USDC", 500.0, Some(0.0)),
                spot("ETH", 2_200.0, Some(10.0)),
            ],
            Vec::new(),
            None,
        ));

        assert_eq!(input.movers.len(), 2, "ETH is one label, not two");
        assert_eq!(input.movers[0].label, "ETH");
        assert_eq!(input.movers[1].label, "USDC");
        assert!((input.movers[0].contrib_usd - 300.0).abs() < 1e-9);
    }

    #[test]
    fn a_holding_with_no_change_data_contributes_nothing() {
        // Absent is not zero: a token DefiLlama has no percentage for must not read as "flat".
        let input = collect(&snapshot(
            vec![spot("ETH", 1_000.0, None)],
            Vec::new(),
            None,
        ));
        assert_eq!(input.contrib, 0.0);
        assert_eq!(
            input.movers.len(),
            1,
            "it still holds value, so it is listed"
        );
        assert_eq!(input.movers[0].contrib_usd, 0.0);
    }

    #[test]
    fn a_worthless_holding_claims_no_mover_slot() {
        let input = collect(&snapshot(
            vec![spot("RUG", 0.0, Some(-99.0))],
            Vec::new(),
            None,
        ));
        assert!(input.movers.is_empty());
    }

    #[test]
    fn the_portfolio_contribution_matches_the_sum_of_its_movers() {
        // The invariant that keeps the brief internally consistent: the headline 24h change and
        // the movers underneath it are the same arithmetic.
        let input = collect(&snapshot(
            vec![
                spot("ETH", 1_100.0, Some(10.0)),
                spot("SOL", 900.0, Some(-10.0)),
            ],
            Vec::new(),
            None,
        ));
        let from_movers: f64 = input.movers.iter().map(|m| m.contrib_usd).sum();
        assert!((input.contrib - from_movers).abs() < 1e-9);
    }

    #[test]
    fn an_empty_portfolio_collects_to_zeros_not_a_panic() {
        let input = collect(&snapshot(Vec::new(), Vec::new(), None));
        assert_eq!(input.total, 0.0);
        assert!(input.movers.is_empty());
        assert!(input.pools.is_empty());
        assert_eq!(input.hf_min, None);
    }
}
