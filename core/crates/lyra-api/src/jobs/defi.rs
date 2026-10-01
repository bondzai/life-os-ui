//! `wealth.defi` — what your DeFi positions are worth right now, and what is unclaimed.
//!
//! The first cron action that **fetches** something. `notify.message` sends text you wrote; this
//! goes and reads the chains, then sends what it found. That is the whole difference, and it is
//! why the action is an allowlist rather than "any job kind": a cron pointed at something that
//! reads nothing produces a message saying nothing, forever.
//!
//! # Where the work happens
//!
//! `Lane::Batch`, not `Deliver`. Building a wallet is several seconds of RPC across every chain,
//! and a delivery worker blocked on that is a Telegram reply nobody gets. The follow-up that
//! actually sends is a separate `notify.deliver` job in its own lane, exactly as `notify.message`
//! does it.
//!
//! # On running this every ten minutes
//!
//! It costs one full portfolio read per firing. That is the same read the alert sweep already does
//! every thirty seconds, so this adds nothing a busy box was not already doing — but it is worth
//! knowing that the cost is RPC calls rather than CPU, and that a provider rate-limiting you shows
//! up here as a thinner report rather than an error. [`report`] says how many chains it could not
//! read, so a quiet degradation is visible instead of silent.

use anyhow::anyhow;
use lyra_chain::model::Wallet;
use lyra_db::channels::Severity;
use lyra_db::jobs::{Lane, NewJob};
use serde_json::json;

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;
use crate::jobs::deliver::Markup;

pub const KIND: &str = "wealth.defi";

/// How many positions are listed before the message summarises the rest.
///
/// Telegram's limit is 4096 characters and a position is roughly one line; past this the message
/// stops being something you read on a phone and becomes something you scroll.
const SHOWN: usize = 12;

pub fn job() -> NewJob {
    NewJob::new(KIND, Lane::Batch)
}

pub struct DefiReport {
    state: AppState,
}

impl DefiReport {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for DefiReport {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let addresses = crate::wealth::watched_wallets();
            if addresses.is_empty() {
                // Permanent: no retry conjures an `ALERT_WALLETS` into the environment, and
                // retrying five times only writes the same line five times.
                return Err(HandlerError::Permanent(anyhow!(
                    "wealth.defi: ALERT_WALLETS is empty, so there is nothing to read"
                )));
            }

            let mut wallets = Vec::with_capacity(addresses.len());
            let mut unreadable = 0;
            for address in &addresses {
                let (wallet, missing) =
                    crate::wealth::build_watched_wallet(&self.state.pool, address).await;
                unreadable += missing;
                wallets.push(wallet);
            }

            let text = report(&wallets, unreadable);

            // Recorded as a step, so a retry an hour later sends the numbers as they were when the
            // job ran rather than re-reading a portfolio that has since moved. The same reason the
            // daily brief records its built text.
            let text = ctx
                .once("built", || async { Ok(json!(text)) })
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("recording the report: {e}")))?
                .as_str()
                .unwrap_or_default()
                .to_string();

            // `money`, not `day`: this is about real positions, and the routing grid already
            // knows where money goes. `Info` because a scheduled read is not an alert — the alert
            // rules are what decide something is wrong, and they have their own severities.
            let jobs = crate::notify::deliveries(
                &self.state,
                "money",
                Severity::Info,
                // Keyed by this job, so a retry lands as the same deliveries rather than a second
                // copy of the report.
                Some(&format!("defi:{}", ctx.job.id)),
                &text,
                Markup::Plain,
            )
            .await;

            if jobs.is_empty() {
                return Err(HandlerError::Retry(anyhow!(
                    "nowhere to send the DeFi report"
                )));
            }
            for job in jobs {
                ctx.enqueue(job);
            }
            Ok(())
        })
    }
}

/// Render the report.
///
/// A pure function over wallets so it is testable without touching a chain — which matters more
/// here than anywhere else in this file, because the formatting is the part anyone will actually
/// complain about and the RPC is the part no test can reach.
pub fn report(wallets: &[Wallet], unreadable: usize) -> String {
    let mut positions: Vec<&lyra_chain::model::Position> = Vec::new();
    for wallet in wallets {
        for bucket in &wallet.chains {
            positions.extend(bucket.defi.iter());
        }
    }

    if positions.is_empty() {
        let mut out = "DeFi: no open positions.".to_string();
        if unreadable > 0 {
            out.push_str(&format!(" {unreadable} chain(s) could not be read."));
        }
        return out;
    }

    // Biggest first. A report ordered by chain declaration puts a $3 dust position above the one
    // holding most of the money.
    positions.sort_by(|a, b| {
        b.usd
            .unwrap_or(0.0)
            .partial_cmp(&a.usd.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total: f64 = positions.iter().filter_map(|p| p.usd).sum();
    let rewards: f64 = positions
        .iter()
        .filter_map(|p| p.rewards_usd.flatten())
        .sum();
    let out_of_range = positions
        .iter()
        .filter(|p| p.in_range == Some(false))
        .count();

    let mut out = format!(
        "DeFi {} across {} position{}",
        money(total),
        positions.len(),
        if positions.len() == 1 { "" } else { "s" }
    );
    if rewards > 0.0 {
        out.push_str(&format!(" · {} unclaimed", money(rewards)));
    }
    if out_of_range > 0 {
        out.push_str(&format!(" · {out_of_range} out of range"));
    }
    out.push('\n');

    for position in positions.iter().take(SHOWN) {
        out.push_str(&format!(
            "\n{} · {}  {}",
            position.protocol,
            position.name,
            money(position.usd.unwrap_or(0.0))
        ));
        // Only when the position has a range at all. A lending position is never "in range", and
        // printing "in range" against one is a sentence that is not true.
        match position.in_range {
            Some(true) => out.push_str("  in range"),
            Some(false) => out.push_str("  OUT OF RANGE"),
            None => {}
        }
        if let Some(health) = &position.health
            && let Some(hf) = health.hf
        {
            out.push_str(&format!("  HF {hf:.2}"));
        }
        if let Some(reward) = position.rewards_usd.flatten().filter(|r| *r > 0.0) {
            out.push_str(&format!("  +{}", money(reward)));
        }
    }

    if positions.len() > SHOWN {
        out.push_str(&format!("\n…and {} more", positions.len() - SHOWN));
    }
    if unreadable > 0 {
        // Said out loud: a provider rate-limiting you otherwise shows up as a total that quietly
        // shrank, which reads as having lost money.
        out.push_str(&format!(
            "\n\n{unreadable} chain(s) could not be read — this total is incomplete."
        ));
    }
    out
}

/// Whole dollars under a thousand, thousands above. A DeFi position reported to the cent is
/// precision nobody acts on, and it makes every line a different width.
fn money(usd: f64) -> String {
    if usd.abs() >= 1000.0 {
        format!("${:.1}k", usd / 1000.0)
    } else {
        format!("${usd:.0}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_chain::model::{ChainBucket, LendingHealth, Position};

    fn lp(
        protocol: &str,
        name: &str,
        usd: f64,
        in_range: Option<bool>,
        rewards: Option<f64>,
    ) -> Position {
        Position {
            protocol: protocol.into(),
            category: "lp".into(),
            name: name.into(),
            usd: Some(usd),
            in_range,
            rewards_usd: Some(rewards),
            ..Position::new(protocol, "lp", name, Some(usd))
        }
    }

    fn wallet(positions: Vec<Position>) -> Wallet {
        Wallet::new(
            "0xabc",
            vec![ChainBucket {
                chain: "base".into(),
                usd: 0.0,
                spot: vec![],
                defi: positions,
            }],
        )
    }

    #[test]
    fn the_biggest_position_is_listed_first() {
        // Chain declaration order would put a dust position above the one holding the money.
        let text = report(
            &[wallet(vec![
                lp("Aerodrome", "dust", 3.0, Some(true), None),
                lp("Uniswap", "ETH/USDC", 4200.0, Some(true), None),
            ])],
            0,
        );
        let uni = text.find("Uniswap").unwrap();
        let dust = text.find("Aerodrome").unwrap();
        assert!(uni < dust, "{text}");
    }

    #[test]
    fn the_headline_carries_the_total_rewards_and_what_is_out_of_range() {
        let text = report(
            &[wallet(vec![
                lp("Uniswap", "ETH/USDC", 4200.0, Some(false), Some(12.4)),
                lp("Aerodrome", "WETH/USDC", 3100.0, Some(true), Some(3.1)),
            ])],
            0,
        );
        assert!(text.starts_with("DeFi $7.3k across 2 positions"), "{text}");
        assert!(text.contains("$16 unclaimed"), "{text}");
        assert!(text.contains("1 out of range"), "{text}");
        assert!(text.contains("OUT OF RANGE"), "{text}");
    }

    /// A lending position has no range, and saying "in range" about one is a false sentence.
    #[test]
    fn a_position_without_a_range_is_not_described_as_having_one() {
        let mut aave = lp("Aave", "supply", 5045.0, None, None);
        aave.health = Some(LendingHealth {
            hf: Some(1.82),
            ltv: 0.4,
            liq_threshold: 0.8,
            collateral_usd: 5045.0,
            debt_usd: 2000.0,
        });
        let text = report(&[wallet(vec![aave])], 0);
        assert!(text.contains("HF 1.82"), "{text}");
        assert!(!text.contains("in range"), "{text}");
        assert!(!text.contains("OUT OF RANGE"), "{text}");
    }

    /// A chain that could not be read must be said out loud. Otherwise a rate limit looks like
    /// having lost money.
    #[test]
    fn an_unreadable_chain_is_reported_rather_than_shrinking_the_total() {
        let text = report(
            &[wallet(vec![lp("Uniswap", "ETH/USDC", 100.0, None, None)])],
            2,
        );
        assert!(text.contains("2 chain(s) could not be read"), "{text}");
        assert!(text.contains("incomplete"), "{text}");

        // And with nothing at all, the same warning still has to survive.
        let empty = report(&[], 3);
        assert!(empty.contains("no open positions"), "{empty}");
        assert!(empty.contains("3 chain(s)"), "{empty}");
    }

    #[test]
    fn a_long_portfolio_is_summarised_rather_than_scrolled() {
        let many: Vec<Position> = (0..20)
            .map(|n| {
                lp(
                    "Uniswap",
                    &format!("pair {n}"),
                    100.0 - n as f64,
                    Some(true),
                    None,
                )
            })
            .collect();
        let text = report(&[wallet(many)], 0);
        assert!(text.contains("across 20 positions"), "{text}");
        assert!(text.contains("…and 8 more"), "{text}");
        // Telegram rejects the whole message past 4096 characters rather than truncating it.
        assert!(text.chars().count() < 4096, "{}", text.chars().count());
    }

    #[test]
    fn rewards_are_only_mentioned_when_there_are_some() {
        let text = report(
            &[wallet(vec![lp(
                "Uniswap",
                "ETH/USDC",
                100.0,
                Some(true),
                None,
            )])],
            0,
        );
        assert!(!text.contains("unclaimed"), "{text}");
        assert!(!text.contains('+'), "no dangling plus sign: {text}");
    }
}
