//! The walk from a real portfolio onto the desk's narrow input model.
//!
//! Port of `wallet-portfolio/analysis.py` L61-158 — `holdings`, `lp_positions`,
//! `lending_positions`, `trading_bots` and the exposure legs. The desk's [`tools`] module
//! deliberately owns no chain types (see its "narrow input model" section), so this is the one
//! place that knows both shapes, and the only place a field can be dropped in translation.
//!
//! Everything here is pure: one [`PortfolioSnapshot`] in, one [`Snapshot`] out, no I/O and no
//! clock. That is what makes it testable against the oracle's own rules without a network.
//!
//! [`tools`]: crate::tools

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use lyra_analytics::envelope::TokenAmount;
use lyra_analytics::exposure::DefiPosition as ExposureLeg;
use lyra_chain::model::{PortfolioSnapshot, Position, TokenAmt, Wallet};

use crate::tools::{
    BotRow, Coverage, LendingPosition, LpPosition, PortfolioHolding, PositionToken, PriceBand,
    Snapshot,
};

/// A borrow line, which is a liability rather than an asset row.
///
/// The discriminator Python uses (`d.get("health")`) and the reason `holdings` skips these: the
/// collateral behind them is already counted as spot aTokens, so a lending row in the asset list
/// would double it. They come back through [`LendingPosition::net_usd`] instead.
fn is_lending(position: &Position) -> bool {
    position.health.is_some()
}

/// The pair label an LP renders under: its own name, else its token symbols joined.
fn pair_label(position: &Position) -> String {
    if !position.name.is_empty() {
        return position.name.clone();
    }
    position
        .tokens
        .iter()
        .map(|t| t.symbol.as_str())
        .collect::<Vec<_>>()
        .join("/")
}

/// The symbol a position is *classified* by — its first token leg.
///
/// Python classifies a DeFi row on `(d["tokens"] or [{}])[0].get("symbol")` together with the
/// category, so an ETH/USDC pool lands wherever an ETH holding would. The display name is not
/// used for this and is deliberately not carried: the desk classifies, it does not render.
fn classify_symbol(position: &Position) -> Option<String> {
    position.tokens.first().map(|t| t.symbol.clone())
}

fn opt_str(value: &Option<String>) -> Option<String> {
    value.clone().filter(|s| !s.is_empty())
}

/// Spot legs and non-lending DeFi rows, tier-classified downstream, filtered to `usd > 0`.
///
/// The filter is the oracle's (`analysis.holdings` returns `[h for h in out if h["usd"] > 0]`):
/// a zero-value row carries no weight in any tier total and only pads the counts the summary
/// reports.
fn holdings(wallets: &[Wallet]) -> Vec<PortfolioHolding> {
    let mut rows = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for token in &chain.spot {
                rows.push(PortfolioHolding {
                    symbol: opt_str(&token.symbol),
                    category: opt_str(&token.category),
                    usd: token.usd.unwrap_or(0.0),
                    change_24h: token.change24h.flatten(),
                });
            }
            for position in &chain.defi {
                if is_lending(position) {
                    continue;
                }
                rows.push(PortfolioHolding {
                    symbol: classify_symbol(position),
                    category: Some(position.category.clone()).filter(|s| !s.is_empty()),
                    usd: position.usd.unwrap_or(0.0),
                    change_24h: position.change24h.flatten(),
                });
            }
        }
    }
    rows.retain(|h| h.usd > 0.0);
    rows
}

fn position_tokens(tokens: &[TokenAmt]) -> Vec<PositionToken> {
    tokens
        .iter()
        .map(|t| PositionToken {
            symbol: t.symbol.clone(),
            amount: t.amount,
            usd: t.usd,
        })
        .collect()
}

/// Concentrated-liquidity positions, out-of-range first then by claimable descending.
///
/// The sort is `analysis.lp_positions`' `(in_range is not False, -fees_usd)`: only an explicit
/// `false` sorts to the front, so a position whose range could not be determined stays with the
/// healthy ones rather than being paraded as broken. Presence of `rewards` is the discriminator —
/// lending carries `health` and bots carry `bot` — which is the oracle's own rule and is kept
/// rather than guessed at from `category`, a free-text field.
fn lp_positions(wallets: &[Wallet]) -> Vec<LpPosition> {
    let mut rows = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for position in &chain.defi {
                let Some(rewards) = position.rewards.as_ref() else {
                    continue;
                };
                rows.push(LpPosition {
                    id: position.id.clone().flatten(),
                    pair_raw: pair_label(position),
                    protocol: position.protocol.clone(),
                    chain: chain.chain.clone(),
                    value_usd: position.usd.unwrap_or(0.0),
                    claimable_usd: position.rewards_usd.flatten().unwrap_or(0.0),
                    tokens: position_tokens(&position.tokens),
                    // Zero-amount reward legs are dropped, as the oracle does: a claimable list
                    // padded with tokens you cannot claim is noise in every tool that reads it.
                    rewards: position_tokens(rewards)
                        .into_iter()
                        .filter(|t| t.amount > 0.0)
                        .collect(),
                    in_range: position.in_range,
                    price_band: position.price_band.as_ref().map(|band| PriceBand {
                        lower: band.lower,
                        upper: band.upper,
                        cur: band.cur,
                        base: Some(band.base.clone()),
                        quote: Some(band.quote.clone()),
                        full: band.full,
                    }),
                    advertised_apr: position.apr,
                });
            }
        }
    }
    rows.sort_by(|a, b| {
        let out_first = (a.in_range != Some(false)).cmp(&(b.in_range != Some(false)));
        out_first.then_with(|| b.claimable_usd.total_cmp(&a.claimable_usd))
    });
    rows
}

/// Borrow positions, most at risk first.
///
/// Sorted by health factor ascending with `None` last — no debt means nothing to liquidate, so an
/// unlevered position is the least urgent thing on the list, not the most.
fn lending_positions(wallets: &[Wallet]) -> Vec<LendingPosition> {
    let mut rows = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for position in &chain.defi {
                let Some(health) = position.health.as_ref() else {
                    continue;
                };
                rows.push(LendingPosition {
                    protocol: position.protocol.clone(),
                    chain: chain.chain.clone(),
                    hf: health.hf,
                    collateral_usd: health.collateral_usd,
                    debt_usd: health.debt_usd,
                    // The position's own `usd` is its exact net-worth contribution: Aave carries
                    // −debt because the collateral is already in spot as aTokens, Compound and
                    // Morpho carry collateral−debt because the protocol holds it. Recomputing it
                    // here from collateral and debt would get one of the two families wrong.
                    net_usd: position.usd.unwrap_or(0.0),
                });
            }
        }
    }
    rows.sort_by(|a, b| {
        a.hf.unwrap_or(f64::INFINITY)
            .total_cmp(&b.hf.unwrap_or(f64::INFINITY))
    });
    rows
}

/// Trading bots, largest equity first, with the engine's own detail block passed through.
///
/// `detail` is forwarded as raw JSON because the desk does not model a bot's internals — a
/// rebalance basket and a futures group share no fields. The egress scrub in `server.rs` is what
/// makes that safe: this is the one field on the desk shaped to carry arbitrary upstream text.
fn trading_bots(wallets: &[Wallet]) -> Vec<BotRow> {
    let mut rows = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for position in &chain.defi {
                let Some(bot) = position.bot.as_ref() else {
                    continue;
                };
                rows.push(BotRow {
                    protocol: position.protocol.clone(),
                    name: Some(position.name.clone()).filter(|s| !s.is_empty()),
                    value_usd: position.usd.unwrap_or(0.0),
                    change_24h: position.change24h.flatten(),
                    pnl_usd: position.pnl_usd,
                    pnl_pct: position.pnl_pct,
                    detail: serde_json::to_value(bot).unwrap_or(serde_json::Value::Null),
                });
            }
        }
    }
    rows.sort_by(|a, b| b.value_usd.total_cmp(&a.value_usd));
    rows
}

fn spot_legs(wallets: &[Wallet]) -> Vec<TokenAmount> {
    let mut legs = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for token in &chain.spot {
                legs.push(TokenAmount::new(
                    token.symbol.clone().unwrap_or_default(),
                    token.usd,
                ));
            }
        }
    }
    legs
}

/// DeFi legs in the shape the exposure unwrap needs.
///
/// Lending rows are carried with `is_lending` set rather than dropped here, because the unwrap
/// owns that decision and skipping them twice would hide the rule in two places.
fn defi_legs(wallets: &[Wallet]) -> Vec<ExposureLeg> {
    let mut legs = Vec::new();
    for wallet in wallets {
        for chain in &wallet.chains {
            for position in &chain.defi {
                legs.push(ExposureLeg {
                    protocol: position.protocol.clone(),
                    usd: position.usd,
                    tokens: position
                        .tokens
                        .iter()
                        .map(|t| TokenAmount::new(t.symbol.clone(), t.usd))
                        .collect(),
                    bot_weights: position
                        .bot
                        .as_ref()
                        .and_then(|bot| bot.weights.as_ref())
                        .map(|weights| {
                            weights
                                .iter()
                                .map(|w| TokenAmount::new(w.symbol.clone(), Some(w.usd)))
                                .collect()
                        })
                        .unwrap_or_default(),
                    is_lending: is_lending(position),
                });
            }
        }
    }
    legs
}

/// What the fetch actually reached.
///
/// `partial` stays `None`: the aggregate's `FetchHealth` knows which chains failed, but it is not
/// carried on the snapshot type, and reporting `false` here would assert completeness this walk
/// cannot see. An unknown reported as unknown.
fn coverage(wallets: &[Wallet]) -> Coverage {
    let mut chains: Vec<String> = wallets
        .iter()
        .flat_map(|w| w.chains.iter().map(|c| c.chain.clone()))
        .collect();
    chains.sort();
    chains.dedup();
    Coverage {
        chains_seen: chains,
        wallets: wallets.len(),
        partial: None,
    }
}

/// A short fingerprint of the book: the same value means the same underlying read.
///
/// Over the requested addresses, the wallet count and the total, matching the oracle's
/// `json.dumps([key, len(wallets), total])`. It exists so an analysis can be anchored to the data
/// it was written against, not to prove integrity — nothing here is adversarial.
fn fingerprint(addrs: &[String], wallets: usize, total: f64) -> String {
    let mut hasher = DefaultHasher::new();
    let mut sorted: Vec<String> = addrs.iter().map(|a| a.to_lowercase()).collect();
    sorted.sort();
    sorted.hash(&mut hasher);
    wallets.hash(&mut hasher);
    total.to_bits().hash(&mut hasher);
    format!("{:012x}", hasher.finish())
}

/// One coherent view of the book, built from one fetch.
///
/// `as_of` is passed in rather than read from a clock so this stays pure, and so the stamp is the
/// moment the *fetch* happened rather than the moment some tool got round to asking.
pub fn snapshot_from(portfolio: &PortfolioSnapshot, addrs: Vec<String>, as_of: i64) -> Snapshot {
    let wallets = &portfolio.wallets;
    Snapshot {
        as_of,
        hash: fingerprint(&addrs, wallets.len(), portfolio.total),
        addrs,
        coverage: coverage(wallets),
        holdings: holdings(wallets),
        positions: lp_positions(wallets),
        lending: lending_positions(wallets),
        bots: trading_bots(wallets),
        spot: spot_legs(wallets),
        defi: defi_legs(wallets),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_chain::market::Rates;
    use lyra_chain::model::{
        BotInfo, BotWeight, ChainBucket, LendingHealth, PortfolioSentiment, SpotToken,
    };

    fn spot(symbol: &str, usd: f64, change: Option<f64>) -> SpotToken {
        SpotToken {
            symbol: Some(symbol.into()),
            amount: 1.0,
            price: Some(usd),
            usd: Some(usd),
            change24h: Some(change),
            coin: None,
            address: None,
            kind: Some("token".into()),
            category: None,
        }
    }

    fn token(symbol: &str, amount: f64, usd: Option<f64>) -> TokenAmt {
        TokenAmt {
            symbol: symbol.into(),
            amount,
            usd,
            side: None,
            shared: None,
            claim: None,
        }
    }

    fn lp(pair: &str, usd: f64, fees: f64, in_range: Option<bool>) -> Position {
        Position {
            protocol: "Uniswap v3".into(),
            category: "Liquidity Pool".into(),
            name: pair.into(),
            id: Some(Some("1".into())),
            via: None,
            tokens: vec![
                token("ETH", 1.0, Some(usd / 2.0)),
                token("USDC", 1.0, Some(usd / 2.0)),
            ],
            usd: Some(usd),
            in_range,
            rewards: Some(vec![
                token("AERO", 3.0, Some(fees)),
                token("OP", 0.0, Some(0.0)),
            ]),
            rewards_usd: Some(Some(fees)),
            ..Default::default()
        }
    }

    fn borrow(protocol: &str, hf: Option<f64>, net: f64) -> Position {
        Position {
            protocol: protocol.into(),
            category: "Borrowing".into(),
            name: "collateral".into(),
            tokens: vec![token("USDC", 1.0, Some(100.0))],
            usd: Some(net),
            health: Some(LendingHealth {
                hf,
                ltv: 0.4,
                liq_threshold: 0.8,
                collateral_usd: 1_000.0,
                debt_usd: 400.0,
            }),
            ..Default::default()
        }
    }

    fn bot(name: &str, usd: f64, weights: Option<Vec<BotWeight>>) -> Position {
        Position {
            protocol: "KuCoin".into(),
            category: "Rebalance".into(),
            name: name.into(),
            tokens: vec![],
            usd: Some(usd),
            bot: Some(BotInfo {
                kind: "spot".into(),
                status: "running".into(),
                count: None,
                weights,
                margin_usd: None,
                margin_pct: None,
                bots: None,
            }),
            ..Default::default()
        }
    }

    fn portfolio(spots: Vec<SpotToken>, defi: Vec<Position>) -> PortfolioSnapshot {
        PortfolioSnapshot {
            addresses: vec!["0xabc".into()],
            total: 1_000.0,
            wallets: vec![Wallet {
                address: "0xabc".into(),
                total: 1_000.0,
                chains: vec![ChainBucket {
                    chain: "base".into(),
                    usd: 1_000.0,
                    spot: spots,
                    defi,
                }],
            }],
            rates: Rates {
                usd: 1.0,
                thb: None,
                btc_usd: None,
            },
            sentiment: PortfolioSentiment::default(),
            fetched_at: 0.0,
        }
    }

    fn walk(spots: Vec<SpotToken>, defi: Vec<Position>) -> Snapshot {
        snapshot_from(&portfolio(spots, defi), vec!["0xabc".into()], 1_700_000_000)
    }

    #[test]
    fn holdings_carry_spot_and_defi_but_never_a_borrow_line() {
        let snap = walk(
            vec![spot("ETH", 400.0, Some(2.5))],
            vec![
                lp("ETH/USDC", 600.0, 5.0, Some(true)),
                borrow("Aave v3", Some(1.8), -400.0),
            ],
        );
        assert_eq!(snap.holdings.len(), 2);
        // The borrow is netted through `lending`, never listed as an asset — its collateral is
        // already in spot as aTokens, so a row here would double it.
        assert_eq!(snap.asset_total(), 1_000.0);
        assert_eq!(snap.lending_net(), -400.0);
        assert_eq!(snap.net_worth(), 600.0);
    }

    #[test]
    fn a_defi_row_is_classified_by_its_first_token_not_its_name() {
        let snap = walk(vec![], vec![lp("ETH/USDC", 600.0, 0.0, Some(true))]);
        assert_eq!(snap.holdings[0].symbol.as_deref(), Some("ETH"));
        assert_eq!(snap.holdings[0].category.as_deref(), Some("Liquidity Pool"));
    }

    #[test]
    fn worthless_rows_are_dropped_from_holdings() {
        let snap = walk(
            vec![spot("DUST", 0.0, None), spot("ETH", 10.0, None)],
            vec![lp("ETH/USDC", 0.0, 0.0, Some(true))],
        );
        assert_eq!(snap.holdings.len(), 1);
        assert_eq!(snap.holdings[0].symbol.as_deref(), Some("ETH"));
    }

    #[test]
    fn change_is_carried_as_a_percentage() {
        let snap = walk(vec![spot("ETH", 400.0, Some(2.5))], vec![]);
        assert_eq!(snap.holdings[0].change_24h, Some(2.5));
    }

    #[test]
    fn lp_positions_put_the_out_of_range_one_first_then_sort_by_claimable() {
        let snap = walk(
            vec![],
            vec![
                lp("A/B", 100.0, 1.0, Some(true)),
                lp("C/D", 100.0, 9.0, Some(true)),
                lp("E/F", 100.0, 0.5, Some(false)),
            ],
        );
        let pairs: Vec<&str> = snap.positions.iter().map(|p| p.pair_raw.as_str()).collect();
        assert_eq!(pairs, ["E/F", "C/D", "A/B"]);
    }

    #[test]
    fn a_position_of_unknown_range_is_not_treated_as_broken() {
        let snap = walk(
            vec![],
            vec![
                lp("A/B", 100.0, 1.0, None),
                lp("C/D", 100.0, 0.5, Some(false)),
            ],
        );
        // Only an explicit `false` sorts to the front: "we could not tell" is not "it is out".
        assert_eq!(snap.positions[0].pair_raw, "C/D");
    }

    #[test]
    fn zero_amount_reward_legs_are_dropped() {
        let snap = walk(vec![], vec![lp("A/B", 100.0, 2.0, Some(true))]);
        let symbols: Vec<&str> = snap.positions[0]
            .rewards
            .iter()
            .map(|r| r.symbol.as_str())
            .collect();
        assert_eq!(symbols, ["AERO"]);
        assert_eq!(snap.positions[0].claimable_usd, 2.0);
    }

    #[test]
    fn borrows_are_listed_most_at_risk_first_with_no_debt_last() {
        let snap = walk(
            vec![],
            vec![
                borrow("Morpho", None, 50.0),
                borrow("Aave v3", Some(1.05), -10.0),
                borrow("Compound", Some(2.4), 20.0),
            ],
        );
        let order: Vec<&str> = snap.lending.iter().map(|l| l.protocol.as_str()).collect();
        assert_eq!(order, ["Aave v3", "Compound", "Morpho"]);
    }

    #[test]
    fn a_borrows_net_worth_contribution_is_the_engines_own_figure() {
        // Aave carries −debt (collateral is in spot as aTokens); recomputing collateral − debt
        // here would report +600 instead of −400 and overstate net worth by the collateral.
        let snap = walk(vec![], vec![borrow("Aave v3", Some(1.8), -400.0)]);
        assert_eq!(snap.lending[0].net_usd, -400.0);
        assert_eq!(snap.lending[0].collateral_usd, 1_000.0);
    }

    #[test]
    fn bots_are_listed_largest_first_and_keep_their_detail() {
        let snap = walk(
            vec![],
            vec![bot("small", 10.0, None), bot("large", 900.0, None)],
        );
        assert_eq!(snap.bots.len(), 2);
        assert_eq!(snap.bots[0].name.as_deref(), Some("large"));
        assert_eq!(snap.bots[0].detail["kind"], "spot");
    }

    #[test]
    fn a_rebalance_basket_unwraps_through_its_weights() {
        let weights = vec![
            BotWeight {
                symbol: "BTC".into(),
                amount: 1.0,
                usd: 600.0,
                pct: 60.0,
            },
            BotWeight {
                symbol: "ETH".into(),
                amount: 1.0,
                usd: 400.0,
                pct: 40.0,
            },
        ];
        let snap = walk(vec![], vec![bot("basket", 1_000.0, Some(weights))]);
        let legs = &snap.defi[0].bot_weights;
        assert_eq!(legs.len(), 2);
        assert_eq!(legs[0].symbol, "BTC");
        assert_eq!(legs[0].usd, Some(600.0));
    }

    #[test]
    fn lending_legs_reach_the_exposure_unwrap_flagged_rather_than_dropped() {
        let snap = walk(vec![], vec![borrow("Aave v3", Some(1.8), -400.0)]);
        // The unwrap owns the skip; hiding it here too would put the rule in two places.
        assert_eq!(snap.defi.len(), 1);
        assert!(snap.defi[0].is_lending);
    }

    #[test]
    fn coverage_reports_the_chains_reached_and_never_guesses_at_completeness() {
        let snap = walk(vec![spot("ETH", 1.0, None)], vec![]);
        assert_eq!(snap.coverage.chains_seen, ["base"]);
        assert_eq!(snap.coverage.wallets, 1);
        assert_eq!(snap.coverage.partial, None);
    }

    #[test]
    fn the_fingerprint_tracks_the_book_not_the_moment() {
        let a = walk(vec![spot("ETH", 400.0, None)], vec![]);
        let b = walk(vec![spot("ETH", 400.0, None)], vec![]);
        assert_eq!(a.hash, b.hash);

        let mut moved = portfolio(vec![spot("ETH", 400.0, None)], vec![]);
        moved.total = 1_001.0;
        let c = snapshot_from(&moved, vec!["0xabc".into()], 1_700_000_000);
        assert_ne!(a.hash, c.hash);
    }

    #[test]
    fn address_order_does_not_change_the_fingerprint() {
        let book = portfolio(vec![], vec![]);
        let one = snapshot_from(&book, vec!["0xAAA".into(), "0xbbb".into()], 0);
        let two = snapshot_from(&book, vec!["0xBBB".into(), "0xaaa".into()], 0);
        assert_eq!(one.hash, two.hash);
    }
}
