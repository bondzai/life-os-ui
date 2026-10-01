//! `wealth.defi` — what your DeFi positions are worth right now, what is unclaimed, and how much
//! of that you should believe.
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
//! actually sends is a separate `notify.deliver` job in its own lane.
//!
//! # Say how much of this to believe
//!
//! Every figure here is a partial read of a dozen flaky upstreams, so the report carries its own
//! provenance: how many chain reads answered, which ones did not and why, and where the FX rate
//! came from. Without that a provider rate-limiting you shows up as a total that quietly shrank,
//! which reads as having lost money rather than as having lost a data source — and only the
//! second is something you can act on.

use anyhow::anyhow;
use lyra_chain::aggregate::FetchHealth;
use lyra_chain::market::Rates;
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
/// Telegram rejects a message over 4096 characters outright rather than truncating it, and a
/// position now costs two lines once its reward legs are shown.
const SHOWN: usize = 10;

/// How many reward tokens are named per position before the rest are counted.
const REWARD_TOKENS: usize = 3;

/// What to report the numbers in.
///
/// `Sats` is here because a Bitcoin-denominated view answers a question dollars cannot: whether
/// the position is actually outgrowing simply having held BTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Currency {
    #[default]
    Usd,
    Thb,
    Sats,
}

impl Currency {
    /// Anything unrecognised reads as USD. A typo in a payload must not stop the report going out.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "thb" | "baht" => Currency::Thb,
            "sats" | "sat" | "btc" => Currency::Sats,
            _ => Currency::Usd,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Currency::Usd => "usd",
            Currency::Thb => "thb",
            Currency::Sats => "sats",
        }
    }
}

/// Converts USD into whatever was asked for, and knows when it cannot.
///
/// **A missing rate falls back to USD rather than inventing one.** That is the convention
/// `market::Rates` already documents for the THB column — "the UI then hides the THB column rather
/// than showing a stale or invented rate" — and it matters more in a message than in a table,
/// because a number on your phone has no column header to disappear.
struct Converter {
    wanted: Currency,
    /// `None` when the rate for `wanted` was unavailable, so everything renders as USD.
    rate: Option<f64>,
}

impl Converter {
    fn new(wanted: Currency, rates: &Rates) -> Self {
        let rate = match wanted {
            Currency::Usd => Some(1.0),
            Currency::Thb => rates.thb,
            // One BTC is 100,000,000 sats, so a dollar buys that many divided by the BTC price.
            Currency::Sats => rates
                .btc_usd
                .filter(|p| *p > 0.0)
                .map(|p| 100_000_000.0 / p),
        };
        Self { wanted, rate }
    }

    /// Which currency the output is actually in — `Usd` whenever the rate was missing.
    fn effective(&self) -> Currency {
        match self.rate {
            Some(_) => self.wanted,
            None => Currency::Usd,
        }
    }

    fn show(&self, usd: f64) -> String {
        let Some(rate) = self.rate else {
            return usd_short(usd);
        };
        match self.wanted {
            Currency::Usd => usd_short(usd),
            Currency::Thb => {
                let thb = usd * rate;
                if thb.abs() >= 1000.0 {
                    format!("฿{:.1}k", thb / 1000.0)
                } else {
                    format!("฿{thb:.0}")
                }
            }
            Currency::Sats => {
                let sats = usd * rate;
                if sats.abs() >= 1_000_000.0 {
                    format!("{:.2}M sats", sats / 1_000_000.0)
                } else if sats.abs() >= 1000.0 {
                    format!("{:.0}k sats", sats / 1000.0)
                } else {
                    format!("{sats:.0} sats")
                }
            }
        }
    }
}

/// Whole dollars under a thousand, thousands above. Precision nobody acts on makes every line a
/// different width.
fn usd_short(usd: f64) -> String {
    if usd.abs() >= 1000.0 {
        format!("${:.1}k", usd / 1000.0)
    } else {
        format!("${usd:.0}")
    }
}

/// A token amount short enough to sit on a line with two others.
fn token_amount(amount: f64) -> String {
    if amount >= 1000.0 {
        format!("{:.1}k", amount / 1000.0)
    } else if amount >= 1.0 {
        format!("{amount:.2}")
    } else {
        // Dust rewards are the common case between claims, and `0.00` tells you nothing.
        format!("{amount:.4}")
    }
}

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
                // Permanent: no retry conjures an `ALERT_WALLETS` into the environment.
                return Err(HandlerError::Permanent(anyhow!(
                    "wealth.defi: ALERT_WALLETS is empty, so there is nothing to read"
                )));
            }
            let currency = Currency::parse(
                ctx.payload()
                    .get("currency")
                    .and_then(|c| c.as_str())
                    .unwrap_or("usd"),
            );

            let mut wallets = Vec::with_capacity(addresses.len());
            let mut health = FetchHealth::default();
            for address in &addresses {
                let (wallet, one) =
                    crate::wealth::build_watched_wallet_with_health(&self.state.pool, address)
                        .await;
                merge(&mut health, one);
                wallets.push(wallet);
            }
            let rates = crate::wealth::rates().await;
            let text = report(&wallets, &health, &rates, currency);

            // Recorded as a step, so a retry an hour later sends the numbers as they were when the
            // job ran rather than re-reading a portfolio that has since moved.
            let text = ctx
                .once("built", || async { Ok(json!(text)) })
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("recording the report: {e}")))?
                .as_str()
                .unwrap_or_default()
                .to_string();

            // `money`, not `day`. `Info` because a scheduled read is not an alert — the alert
            // rules are what decide something is wrong, and they have their own severities.
            let jobs = crate::notify::deliveries(
                &self.state,
                "money",
                Severity::Info,
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

/// Fold one wallet's health into the run's total.
fn merge(total: &mut FetchHealth, one: FetchHealth) {
    total.requested += one.requested;
    total.completed += one.completed;
    total.failures.extend(one.failures);
    total.abandoned.extend(one.abandoned);
    total.adapter_failures.extend(one.adapter_failures);
    total.deadline_hit |= one.deadline_hit;
    total.rates_degraded |= one.rates_degraded;
}

/// Render the report.
///
/// A pure function over wallets, health and rates, so it is testable without touching a chain —
/// which matters more here than anywhere else in this file, because the formatting is the part
/// anyone will complain about and the RPC is the part no test can reach.
pub fn report(
    wallets: &[Wallet],
    health: &FetchHealth,
    rates: &Rates,
    currency: Currency,
) -> String {
    let money = Converter::new(currency, rates);

    let mut positions: Vec<&lyra_chain::model::Position> = Vec::new();
    for wallet in wallets {
        for bucket in &wallet.chains {
            positions.extend(bucket.defi.iter());
        }
    }

    if positions.is_empty() {
        return format!(
            "DeFi: no open positions.{}",
            provenance(health, rates, &money)
        );
    }

    // Biggest first. Chain declaration order puts a $3 dust position above the one holding most
    // of the money.
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

    // One section per idea, separated by a blank line, and every line short enough to read on a
    // phone without wrapping. Structure comes from newlines rather than from separator characters
    // — `·` between four facts is four pieces of punctuation to skip past on a message that
    // arrives every ten minutes.
    let mut out = String::from("DEFI\n");
    out.push_str(&format!(
        "{} in {} position{}\n",
        money.show(total),
        positions.len(),
        if positions.len() == 1 { "" } else { "s" }
    ));
    // The claimable total goes in the headline block, because on a ten-minute schedule it is the
    // number you came for — the book barely moves between firings and this does.
    if rewards > 0.0 {
        out.push_str(&format!("{} unclaimed", money.show(rewards)));
        if total > 0.0 {
            out.push_str(&format!(" ({:.2}%)", rewards / total * 100.0));
        }
        out.push('\n');
    }
    if out_of_range > 0 {
        out.push_str(&format!("{out_of_range} out of range\n"));
    }

    out.push_str("\nPOSITIONS\n");
    for position in positions.iter().take(SHOWN) {
        // Two lines: what it is, then what it is doing. Three only when there are reward tokens
        // to name.
        out.push_str(&format!("\n{} {}\n", position.protocol, position.name));

        let mut facts = vec![money.show(position.usd.unwrap_or(0.0))];
        // Only when the position has a range at all. A lending position is never "in range", and
        // printing it against one is a sentence that is not true.
        match position.in_range {
            Some(true) => facts.push("in range".into()),
            Some(false) => facts.push("OUT OF RANGE".into()),
            None => {}
        }
        if let Some(lending) = &position.health
            && let Some(hf) = lending.hf
        {
            facts.push(format!("HF {hf:.2}"));
        }
        if let Some(reward) = position.rewards_usd.flatten().filter(|r| *r > 0.0) {
            facts.push(format!("+{} claimable", money.show(reward)));
        }
        out.push_str(&facts.join(", "));
        out.push('\n');

        if let Some(tokens) = reward_tokens(position) {
            out.push_str(&format!("{tokens}\n"));
        }
    }

    if positions.len() > SHOWN {
        out.push_str(&format!("\nand {} more\n", positions.len() - SHOWN));
    }
    out.push_str(&provenance(health, rates, &money));
    // A single trailing newline, never a run of them: blank lines at the end of a message are
    // noise that pushes the next one further down the chat.
    out.trim_end().to_string()
}

/// Which tokens a position's reward is in, if any.
///
/// The tokens matter as much as the value. "+$12" tells you to claim; "0.5234 AERO" tells you what
/// you will be holding afterwards, which is the part that decides whether to sell it. A reward leg
/// with **no** price still gets named — an unpriced token is exactly the one you would never
/// notice you were owed.
fn reward_tokens(position: &lyra_chain::model::Position) -> Option<String> {
    let tokens = position.rewards.as_ref().filter(|r| !r.is_empty())?;
    let named: Vec<String> = tokens
        .iter()
        .take(REWARD_TOKENS)
        .map(|t| format!("{} {}", token_amount(t.amount), t.symbol))
        .collect();
    if named.is_empty() {
        return None;
    }
    let mut line = named.join(", ");
    if tokens.len() > REWARD_TOKENS {
        line.push_str(&format!(" and {} more", tokens.len() - REWARD_TOKENS));
    }
    Some(line)
}

/// Where the numbers came from, and how much of them arrived.
///
/// Always present, even on a clean read: "12/12 chains" is the sentence that makes a later
/// "10/12" mean something. A footer that only appears when something is wrong is one nobody
/// learns to look for.
fn provenance(health: &FetchHealth, rates: &Rates, money: &Converter) -> String {
    let mut out = String::from("\nSOURCES\n");

    if health.requested > 0 {
        out.push_str(&format!(
            "{} of {} chains answered\n",
            health.completed, health.requested
        ));
    }

    // One per line, named with its reason. "2 failed" sends you to check twelve things;
    // "arbitrum: 429" sends you to check one.
    for failure in &health.failures {
        out.push_str(&format!(
            "{}: {}\n",
            failure.task.chain,
            first_line(&failure.error)
        ));
    }
    for task in &health.abandoned {
        out.push_str(&format!("{}: timed out\n", task.chain));
    }
    // Sub-chain: the chain answered but one protocol inside it did not, so the total is short by
    // an amount nothing else would reveal.
    for adapter in &health.adapter_failures {
        out.push_str(&format!(
            "{} on {}: skipped\n",
            adapter.adapter, adapter.chain
        ));
    }
    if health.deadline_hit {
        out.push_str("the read hit its deadline, so this total is short\n");
    }

    // The rate is evidence too: a figure in baht is only as good as the number it was multiplied
    // by, and that number comes from an upstream that goes down like any other.
    if money.wanted != Currency::Usd {
        if money.effective() == Currency::Usd {
            out.push_str(&format!(
                "no {} rate, so these are dollars\n",
                money.wanted.as_str().to_uppercase()
            ));
        } else {
            match money.wanted {
                Currency::Thb => {
                    if let Some(thb) = rates.thb {
                        out.push_str(&format!("1 USD = {thb:.2} THB\n"));
                    }
                }
                Currency::Sats => {
                    if let Some(btc) = rates.btc_usd {
                        out.push_str(&format!("BTC {}\n", usd_short(btc)));
                    }
                }
                Currency::Usd => {}
            }
        }
    }
    if health.rates_degraded {
        out.push_str("FX and BTC rates fell back to defaults\n");
    }

    out
}

/// One line of an upstream's error. A provider's HTML error page in a Telegram message is
/// unreadable, and the first line is always the part that names the problem.
fn first_line(error: &str) -> String {
    let line = error.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 40 {
        return line.to_string();
    }
    format!("{}…", line.chars().take(39).collect::<String>())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_chain::aggregate::{ChainFailure, ChainTask};
    use lyra_chain::model::{ChainBucket, LendingHealth, Position, TokenAmt};

    fn rates() -> Rates {
        Rates {
            usd: 1.0,
            thb: Some(36.5),
            btc_usd: Some(100_000.0),
        }
    }

    fn clean() -> FetchHealth {
        FetchHealth {
            requested: 12,
            completed: 12,
            ..FetchHealth::default()
        }
    }

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

    fn token(symbol: &str, amount: f64) -> TokenAmt {
        TokenAmt {
            symbol: symbol.into(),
            amount,
            usd: None,
            side: None,
            ..Default::default()
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

    /// The whole message, so a change to its shape is visible as a change to this test rather
    /// than as six assertions that each still pass.
    #[test]
    fn the_message_is_sections_separated_by_blank_lines() {
        let mut uni = lp("Uniswap", "ETH/USDC", 4200.0, Some(false), Some(12.4));
        uni.rewards = Some(vec![token("AERO", 0.5234), token("USDC", 2.1)]);
        let aero = lp("Aerodrome", "WETH/USDC", 3100.0, Some(true), Some(3.1));

        let text = report(
            &[wallet(vec![uni, aero])],
            &clean(),
            &rates(),
            Currency::Usd,
        );
        assert_eq!(
            text,
            "DEFI\n\
             $7.3k in 2 positions\n\
             $16 unclaimed (0.21%)\n\
             1 out of range\n\
             \n\
             POSITIONS\n\
             \n\
             Uniswap ETH/USDC\n\
             $4.2k, OUT OF RANGE, +$12 claimable\n\
             0.5234 AERO, 2.10 USDC\n\
             \n\
             Aerodrome WETH/USDC\n\
             $3.1k, in range, +$3 claimable\n\
             \n\
             SOURCES\n\
             12 of 12 chains answered",
            "\n--- actual ---\n{text}"
        );
    }

    /// **Discord collapses runs of spaces in a normal message.** Columns aligned with padding
    /// look right in Telegram and arrive as a jumble there, so the structure has to come from
    /// newlines alone.
    #[test]
    fn nothing_is_aligned_with_runs_of_spaces() {
        let mut position = lp("Aerodrome", "WETH/USDC", 3100.0, Some(true), Some(12.0));
        position.rewards = Some(vec![token("AERO", 0.5), token("USDC", 2.1)]);
        let health = FetchHealth {
            requested: 12,
            completed: 10,
            failures: vec![ChainFailure {
                task: ChainTask {
                    chain: "arbitrum",
                    address: "0xabc".into(),
                },
                error: "429 Too Many Requests".into(),
            }],
            ..FetchHealth::default()
        };
        let text = report(&[wallet(vec![position])], &health, &rates(), Currency::Thb);

        assert!(!text.contains("  "), "two spaces in a row:\n{text}");
        // And no blank line left dangling at either end — those push the next message down.
        assert_eq!(text.trim(), text);
        // Nor three newlines, which is a blank line nobody asked for.
        assert!(!text.contains("\n\n\n"), "{text}");
    }

    #[test]
    fn a_positions_rewards_name_the_tokens_not_just_the_value() {
        // "+$12" says claim it; "0.5234 AERO" says what you will be holding afterwards, which is
        // what decides whether to sell.
        let mut position = lp("Aerodrome", "WETH/USDC", 3100.0, Some(true), Some(12.0));
        position.rewards = Some(vec![token("AERO", 0.5234), token("USDC", 2.1)]);
        let text = report(&[wallet(vec![position])], &clean(), &rates(), Currency::Usd);

        assert!(text.contains("+$12 claimable"), "{text}");
        assert!(text.contains("0.5234 AERO, 2.10 USDC"), "{text}");
    }

    #[test]
    fn an_unpriced_reward_is_still_named() {
        // The token nobody priced is exactly the one you would never notice you were owed.
        let mut position = lp("Somewhere", "farm", 100.0, None, None);
        position.rewards = Some(vec![token("NEWCOIN", 1234.0)]);
        let text = report(&[wallet(vec![position])], &clean(), &rates(), Currency::Usd);
        assert!(text.contains("1.2k NEWCOIN"), "{text}");
    }

    #[test]
    fn baht_and_sats_convert_and_say_the_rate_they_used() {
        let positions = vec![lp("Uniswap", "ETH/USDC", 1000.0, None, None)];

        let thb = report(
            &[wallet(positions.clone())],
            &clean(),
            &rates(),
            Currency::Thb,
        );
        assert!(thb.contains("฿36.5k"), "{thb}");
        assert!(thb.contains("1 USD = 36.50 THB"), "{thb}");

        // $1000 at $100k/BTC is 0.01 BTC, which is 1,000,000 sats.
        let sats = report(&[wallet(positions)], &clean(), &rates(), Currency::Sats);
        assert!(sats.contains("1.00M sats"), "{sats}");
        assert!(sats.contains("BTC $100.0k"), "{sats}");
    }

    /// The rule `market::Rates` already documents for the THB column, applied to a message: never
    /// show a number multiplied by a rate that was not there.
    #[test]
    fn a_missing_rate_falls_back_to_dollars_and_says_so() {
        let no_rates = Rates {
            usd: 1.0,
            thb: None,
            btc_usd: None,
        };
        let text = report(
            &[wallet(vec![lp("Uniswap", "ETH/USDC", 1000.0, None, None)])],
            &clean(),
            &no_rates,
            Currency::Thb,
        );
        assert!(text.contains("$1.0k"), "dollars, not invented baht: {text}");
        assert!(!text.contains('฿'), "{text}");
        assert!(text.contains("no THB rate, so these are dollars"), "{text}");
    }

    /// Always present, even when nothing is wrong — a section that only appears on failure is one
    /// nobody learns to read.
    #[test]
    fn the_sources_section_is_there_on_a_clean_read_too() {
        let text = report(
            &[wallet(vec![lp("Uniswap", "ETH/USDC", 100.0, None, None)])],
            &clean(),
            &rates(),
            Currency::Usd,
        );
        assert!(text.contains("SOURCES\n12 of 12 chains answered"), "{text}");
        assert!(!text.contains("timed out"), "{text}");
    }

    /// Named, not counted, and one per line.
    #[test]
    fn a_failed_source_is_named_with_its_reason() {
        let health = FetchHealth {
            requested: 12,
            completed: 10,
            failures: vec![ChainFailure {
                task: ChainTask {
                    chain: "arbitrum",
                    address: "0xabc".into(),
                },
                error: "429 Too Many Requests\nfrom the provider".into(),
            }],
            abandoned: vec![ChainTask {
                chain: "base",
                address: "0xabc".into(),
            }],
            deadline_hit: true,
            ..FetchHealth::default()
        };
        let text = report(
            &[wallet(vec![lp("Uniswap", "ETH/USDC", 100.0, None, None)])],
            &health,
            &rates(),
            Currency::Usd,
        );
        assert!(text.contains("10 of 12 chains answered"), "{text}");
        assert!(text.contains("arbitrum: 429 Too Many Requests"), "{text}");
        // Only the first line of the error — a provider's HTML page is unreadable on a phone.
        assert!(!text.contains("from the provider"), "{text}");
        assert!(text.contains("base: timed out"), "{text}");
        assert!(text.contains("hit its deadline"), "{text}");
    }

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
        let text = report(&[wallet(vec![aave])], &clean(), &rates(), Currency::Usd);
        assert!(text.contains("HF 1.82"), "{text}");
        assert!(!text.contains("in range"), "{text}");
    }

    #[test]
    fn the_biggest_position_is_listed_first() {
        let text = report(
            &[wallet(vec![
                lp("Aerodrome", "dust", 3.0, Some(true), None),
                lp("Uniswap", "ETH/USDC", 4200.0, Some(true), None),
            ])],
            &clean(),
            &rates(),
            Currency::Usd,
        );
        assert!(
            text.find("Uniswap").unwrap() < text.find("Aerodrome").unwrap(),
            "{text}"
        );
    }

    #[test]
    fn a_long_portfolio_stays_inside_what_telegram_accepts() {
        let many: Vec<Position> = (0..40)
            .map(|n| {
                let mut p = lp(
                    "Uniswap",
                    &format!("pair {n}"),
                    100.0 - n as f64,
                    Some(true),
                    Some(1.0),
                );
                p.rewards = Some(vec![
                    token("AERO", 1.0),
                    token("USDC", 2.0),
                    token("OP", 3.0),
                    token("X", 4.0),
                ]);
                p
            })
            .collect();
        let text = report(&[wallet(many)], &clean(), &rates(), Currency::Usd);
        assert!(text.contains("in 40 positions"), "{text}");
        assert!(text.contains("and 30 more"), "{text}");
        // Telegram rejects the whole message past 4096 rather than truncating it.
        assert!(text.chars().count() < 4096, "{}", text.chars().count());
    }

    #[test]
    fn a_currency_nobody_recognises_is_dollars_rather_than_a_refusal() {
        assert_eq!(Currency::parse("thb"), Currency::Thb);
        assert_eq!(Currency::parse("BAHT"), Currency::Thb);
        assert_eq!(Currency::parse("sats"), Currency::Sats);
        assert_eq!(Currency::parse("btc"), Currency::Sats);
        // A typo in a payload must not stop the report going out.
        assert_eq!(Currency::parse("euros"), Currency::Usd);
        assert_eq!(Currency::parse(""), Currency::Usd);
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
            &clean(),
            &rates(),
            Currency::Usd,
        );
        assert!(!text.contains("unclaimed"), "{text}");
        assert!(!text.contains("claimable"), "{text}");
    }
}
