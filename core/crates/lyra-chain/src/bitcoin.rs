//! Bitcoin chain reader — port of `portfolio.py:1911-1966` (`_btc_esplora` … `_btc_chain_portfolio`).
//!
//! Bitcoin has no accounts and no contracts, so a "balance" is whatever a block explorer says the
//! unspent outputs add up to. Explorers disagree about availability far more than about numbers:
//! mempool.space tar-pits datacenter IPs, blockstream.info rate-limits, blockchain.info goes down.
//! So the balance is read from a **chain of providers** and the first one that answers wins.
//!
//! Losing a provider must never look like losing coins: if one source errors, the next is tried,
//! and only when *every* source has failed is the answer `None` — which the caller renders as "this
//! chain is missing", never as "you have 0 BTC".
//!
//! Everything upstream is in **satoshis** (integers). The conversion to BTC happens exactly once,
//! at the edge of each parser, after integer arithmetic — getting that divisor wrong is a 10⁸ error
//! in the portfolio total, so the parsers keep the integers integral for as long as possible.

use std::future::Future;
use std::pin::Pin;

use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;

use crate::http_cache::HttpCache;

/// Satoshis in one BTC. Upstream reports integers of this unit; we divide exactly once.
pub const SATS_PER_BTC: f64 = 1e8;

/// A holding worth less than this is not worth a row — the Python's dust cut-off, applied both to
/// individual tokens and to a chain's total.
pub const DUST_USD: f64 = 0.01;

/// DefiLlama key for the BTC price (`CHAINS["bitcoin"]["native"]["price_key"]`).
pub const BTC_PRICE_KEY: &str = "coingecko:bitcoin";

pub const BLOCKSTREAM_API: &str = "https://blockstream.info/api";
pub const MEMPOOL_SPACE_API: &str = "https://mempool.space/api";
pub const BLOCKCHAIN_INFO: &str = "https://blockchain.info";

// ===========================================================================
// Shared portfolio shapes.
//
// NOTE: nothing below is Bitcoin-specific — `hyperliquid` and `solana` import these from here
// only because this port was scoped to three files. Hoist them into a `portfolio`/`types` module
// when wiring `lib.rs`; the EVM reader will want exactly the same shapes.
// ===========================================================================

/// One held token, mirroring the Python spot dict. Fields the Python omits when absent are
/// `Option` + skipped on serialize, so the JSON key set matches per chain kind.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpotToken {
    pub symbol: String,
    pub amount: f64,
    pub price: f64,
    pub usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change24h: Option<f64>,
    /// `"native"` or `"token"`.
    pub kind: &'static str,
    /// DefiLlama coin key, e.g. `solana:<mint>` (absent for BTC and Hyperliquid spot).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub coin: Option<String>,
    /// Mint / contract address, when the token has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
}

/// A token *inside* a DeFi position (`_position(tokens=[…])`) — amount only, no valuation.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PositionToken {
    pub symbol: String,
    pub amount: f64,
}

/// A non-spot holding — port of `_position` reduced to the fields the non-EVM readers set.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Position {
    pub protocol: String,
    pub category: String,
    pub name: String,
    pub id: Option<String>,
    pub via: Option<String>,
    pub tokens: Vec<PositionToken>,
    pub usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change24h: Option<f64>,
}

impl Position {
    /// The `_position(protocol, category, name, usd, tokens=…, change24h=…)` call shape.
    pub fn new(
        protocol: &str,
        category: &str,
        name: &str,
        usd: f64,
        tokens: Vec<PositionToken>,
        change24h: Option<f64>,
    ) -> Self {
        Self {
            protocol: protocol.to_string(),
            category: category.to_string(),
            name: name.to_string(),
            id: None,
            via: None,
            tokens,
            usd,
            change24h,
        }
    }
}

/// One wallet's holdings on one chain — the `_chain_result` shape.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChainPortfolio {
    pub chain: String,
    pub usd: f64,
    pub spot: Vec<SpotToken>,
    pub defi: Vec<Position>,
}

/// Port of `_chain_result`: a chain worth less than dust is dropped entirely rather than shown as
/// an empty row. `None` here means "nothing worth reporting", which is **not** the same as the
/// `None` a failed read returns — the caller distinguishes them.
pub fn chain_result(
    chain: &str,
    usd: f64,
    spot: Vec<SpotToken>,
    defi: Vec<Position>,
) -> Option<ChainPortfolio> {
    if usd < DUST_USD {
        return None;
    }
    Some(ChainPortfolio {
        chain: chain.to_string(),
        usd,
        spot,
        defi,
    })
}

// ===========================================================================
// Response parsing — pure, so the arithmetic is testable without a network.
// ===========================================================================

/// A satoshi count from a field that upstream may render as a JSON number *or* a string
/// (blockchain.info has shipped both); the Python's `int(...)` accepted either.
fn sats(parent: &Value, field: &str) -> Result<i128> {
    let raw = parent
        .get(field)
        .with_context(|| format!("missing field {field}"))?;
    match raw {
        Value::Number(n) => n
            .as_i128()
            .with_context(|| format!("{field} is not an integer: {n}")),
        Value::String(s) => s
            .parse::<i128>()
            .with_context(|| format!("{field} is not an integer: {s:?}")),
        other => bail!("{field} has unexpected type: {other}"),
    }
}

/// Optional satoshi count, defaulting to 0 — the Python's `m.get("funded_txo_sum", 0)`.
fn sats_or_zero(parent: Option<&Value>, field: &str) -> i128 {
    parent.and_then(|p| sats(p, field).ok()).unwrap_or_default()
}

/// Esplora-style balance (Blockstream / mempool.space): confirmed **plus** mempool, in BTC.
///
/// Mempool deltas are included on purpose — a payment you just made should leave your balance
/// immediately, not one block later. `chain_stats` is required; `mempool_stats` is optional and
/// its fields default to 0, exactly as the Python does.
pub fn parse_esplora_balance(body: &str) -> Result<f64> {
    let value: Value = serde_json::from_str(body).context("esplora: response is not JSON")?;
    let chain = value
        .get("chain_stats")
        .context("esplora: response has no chain_stats")?;
    let funded = sats(chain, "funded_txo_sum").context("esplora: chain_stats")?;
    let spent = sats(chain, "spent_txo_sum").context("esplora: chain_stats")?;

    let mempool = value.get("mempool_stats");
    let mempool_funded = sats_or_zero(mempool, "funded_txo_sum");
    let mempool_spent = sats_or_zero(mempool, "spent_txo_sum");

    Ok((funded - spent + mempool_funded - mempool_spent) as f64 / SATS_PER_BTC)
}

/// blockchain.info balance, in BTC. `final_balance` is already net of spends and includes
/// unconfirmed transactions.
pub fn parse_blockchain_info_balance(body: &str) -> Result<f64> {
    let value: Value =
        serde_json::from_str(body).context("blockchain.info: response is not JSON")?;
    Ok(sats(&value, "final_balance").context("blockchain.info")? as f64 / SATS_PER_BTC)
}

// ===========================================================================
// Providers
// ===========================================================================

/// One way to learn an address's balance. The trait exists so the fallback chain can be exercised
/// with a source that always fails — the case that silently loses BTC if the chain is broken.
pub trait BtcBalanceSource: Send + Sync {
    /// Human-readable, for the log line when this source is skipped.
    fn name(&self) -> String;

    /// Balance in BTC, or an error so the next source is tried.
    fn balance<'a>(
        &'a self,
        address: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<f64>> + Send + 'a>>;
}

/// Fail fast on an error status: an HTML rate-limit page parses as "not JSON" anyway, but saying
/// so plainly makes the fallback log readable.
fn body_of(recorded: crate::http_cache::Recorded, source: &str) -> Result<String> {
    if !(200..300).contains(&recorded.status) {
        bail!("{source} returned HTTP {}", recorded.status);
    }
    Ok(recorded.body)
}

/// Blockstream / mempool.space and anything else speaking the Esplora API.
pub struct Esplora<'a> {
    pub base: &'a str,
    pub client: &'a reqwest::Client,
    pub cache: &'a HttpCache,
}

impl BtcBalanceSource for Esplora<'_> {
    fn name(&self) -> String {
        self.base.to_string()
    }

    fn balance<'a>(
        &'a self,
        address: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<f64>> + Send + 'a>> {
        Box::pin(async move {
            let url = format!("{}/address/{address}", self.base);
            let recorded = self.cache.get(self.client, &url).await?;
            parse_esplora_balance(&body_of(recorded, self.base)?)
        })
    }
}

/// blockchain.info's `rawaddr`. `limit=0` asks for no transaction list — only the balance is
/// wanted, and a busy address's transaction history is megabytes.
pub struct BlockchainInfo<'a> {
    pub client: &'a reqwest::Client,
    pub cache: &'a HttpCache,
}

impl BtcBalanceSource for BlockchainInfo<'_> {
    fn name(&self) -> String {
        BLOCKCHAIN_INFO.to_string()
    }

    fn balance<'a>(
        &'a self,
        address: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<f64>> + Send + 'a>> {
        Box::pin(async move {
            let url = format!("{BLOCKCHAIN_INFO}/rawaddr/{address}?limit=0");
            let recorded = self.cache.get(self.client, &url).await?;
            parse_blockchain_info_balance(&body_of(recorded, BLOCKCHAIN_INFO)?)
        })
    }
}

/// Balance in BTC from the first source that answers; `None` only when **all** of them failed.
///
/// The Python races the providers in a thread pool and takes the first *completed* success. This
/// tries them in order instead: with record/replay fixtures a race is non-deterministic, and the
/// providers agree on the number — they differ only in whether they answer at all. The trade is
/// latency (a stalled first provider delays the rest) for reproducibility; see the module docs of
/// `http_cache`.
pub async fn balance_from_sources(sources: &[&dyn BtcBalanceSource], address: &str) -> Option<f64> {
    for source in sources {
        match source.balance(address).await {
            Ok(balance) => return Some(balance),
            Err(error) => {
                // Not an error for the caller: this is the fallback chain doing its job.
                tracing::warn!(
                    source = source.name(),
                    error = format!("{error:#}"),
                    "btc balance source failed, trying the next"
                );
            }
        }
    }
    None
}

/// The default provider chain, in the Python's order.
pub async fn btc_balance(
    client: &reqwest::Client,
    cache: &HttpCache,
    address: &str,
) -> Option<f64> {
    let blockstream = Esplora {
        base: BLOCKSTREAM_API,
        client,
        cache,
    };
    let blockchain_info = BlockchainInfo { client, cache };
    let mempool_space = Esplora {
        base: MEMPOOL_SPACE_API,
        client,
        cache,
    };
    balance_from_sources(&[&blockstream, &blockchain_info, &mempool_space], address).await
}

// ===========================================================================
// Pricing + assembly
// ===========================================================================

/// DefiLlama price for a raw coin key — port of `_llama_key_price`. `None` on any failure, so a
/// price outage degrades to "chain omitted" rather than to a wrong number.
///
/// NOTE: generic, not Bitcoin-specific; move to the shared prices module when it exists.
pub async fn llama_key_price(
    client: &reqwest::Client,
    cache: &HttpCache,
    key: &str,
) -> Option<f64> {
    let url = format!("https://coins.llama.fi/prices/current/{key}");
    let recorded = cache.get(client, &url).await.ok()?;
    let value: Value = serde_json::from_str(&recorded.body).ok()?;
    value.get("coins")?.get(key)?.get("price")?.as_f64()
}

/// 24h % change for a raw coin key — port of `_key_change` (without its TTL cache, which belongs
/// with the shared price layer).
pub async fn llama_key_change(
    client: &reqwest::Client,
    cache: &HttpCache,
    key: &str,
) -> Option<f64> {
    let url = format!("https://coins.llama.fi/percentage/{key}?period=24h");
    let recorded = cache.get(client, &url).await.ok()?;
    let value: Value = serde_json::from_str(&recorded.body).ok()?;
    value.get("coins")?.get(key)?.as_f64()
}

/// Assemble the Bitcoin portfolio from an already-fetched balance and price — the pure half of
/// `_btc_chain_portfolio`.
///
/// A zero balance is a real answer and yields `usd = 0`, which `chain_result` then drops as dust:
/// the chain is absent from the report because there is nothing on it, which is how the Python
/// behaves. That is deliberately different from a *failed* read, where `btc_balance` returns
/// `None` and the caller marks the portfolio partial.
pub fn btc_portfolio_from(
    chain: &str,
    balance: f64,
    price: f64,
    change24h: Option<f64>,
) -> Option<ChainPortfolio> {
    let usd = balance * price;
    let spot = if usd > DUST_USD {
        vec![SpotToken {
            symbol: "BTC".to_string(),
            amount: balance,
            price,
            usd,
            change24h,
            kind: "native",
            coin: None,
            address: None,
        }]
    } else {
        Vec::new()
    };
    chain_result(chain, usd, spot, Vec::new())
}

/// Bitcoin portfolio — balance from the provider chain, price from DefiLlama.
///
/// `Ok(None)` means "nothing to report" (dust); `Err` means the balance could not be read at all.
pub async fn btc_chain_portfolio(
    client: &reqwest::Client,
    cache: &HttpCache,
    chain: &str,
    address: &str,
) -> Result<Option<ChainPortfolio>> {
    let Some(balance) = btc_balance(client, cache, address).await else {
        bail!("every bitcoin balance provider failed for {address}");
    };
    let price = llama_key_price(client, cache, BTC_PRICE_KEY)
        .await
        .unwrap_or(0.0);
    let change = llama_key_change(client, cache, BTC_PRICE_KEY).await;
    Ok(btc_portfolio_from(chain, balance, price, change))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_cache::Mode;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// A real Blockstream body: an address with confirmed history and a pending spend.
    const ESPLORA_BODY: &str = r#"{
      "address": "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
      "chain_stats": {"funded_txo_count": 3, "funded_txo_sum": 250000000,
                      "spent_txo_count": 1, "spent_txo_sum": 100000000, "tx_count": 4},
      "mempool_stats": {"funded_txo_count": 1, "funded_txo_sum": 5000000,
                        "spent_txo_count": 1, "spent_txo_sum": 2000000, "tx_count": 2}
    }"#;

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        HttpCache::new(dir, Mode::Replay)
    }

    #[test]
    fn esplora_sums_confirmed_and_mempool_in_btc() {
        // (250_000_000 - 100_000_000 + 5_000_000 - 2_000_000) sats = 1.53 BTC
        let balance = parse_esplora_balance(ESPLORA_BODY).unwrap();
        assert!((balance - 1.53).abs() < 1e-12, "got {balance}");
    }

    #[test]
    fn the_satoshi_divisor_is_ten_to_the_eight() {
        // One satoshi funded, nothing spent. A wrong divisor shows up as 1e-6 or 1e-10 here.
        let body = r#"{"chain_stats": {"funded_txo_sum": 1, "spent_txo_sum": 0}}"#;
        assert_eq!(parse_esplora_balance(body).unwrap(), 0.000_000_01);

        let one_btc = r#"{"chain_stats": {"funded_txo_sum": 100000000, "spent_txo_sum": 0}}"#;
        assert_eq!(parse_esplora_balance(one_btc).unwrap(), 1.0);
    }

    #[test]
    fn esplora_tolerates_a_missing_mempool_block() {
        let body = r#"{"chain_stats": {"funded_txo_sum": 200000000, "spent_txo_sum": 50000000}}"#;
        assert_eq!(parse_esplora_balance(body).unwrap(), 1.5);
    }

    #[test]
    fn an_unused_esplora_address_is_zero_not_an_error() {
        // A fresh address still returns a well-formed body with zeroed stats.
        let body = r#"{"address": "bc1qnew", "chain_stats": {"funded_txo_count": 0,
          "funded_txo_sum": 0, "spent_txo_count": 0, "spent_txo_sum": 0, "tx_count": 0},
          "mempool_stats": {"funded_txo_sum": 0, "spent_txo_sum": 0}}"#;
        assert_eq!(parse_esplora_balance(body).unwrap(), 0.0);
    }

    #[test]
    fn a_fully_spent_esplora_address_is_zero() {
        let body = r#"{"chain_stats": {"funded_txo_sum": 12345678, "spent_txo_sum": 12345678}}"#;
        assert_eq!(parse_esplora_balance(body).unwrap(), 0.0);
    }

    #[test]
    fn esplora_rejects_a_body_it_cannot_understand() {
        // A rate-limit page or an error string must fail, so the next provider is tried.
        assert!(parse_esplora_balance("Too Many Requests").is_err());
        assert!(parse_esplora_balance(r#"{"error": "invalid address"}"#).is_err());
        assert!(parse_esplora_balance(r#"{"chain_stats": {"funded_txo_sum": 1}}"#).is_err());
    }

    #[test]
    fn blockchain_info_reads_final_balance_in_satoshis() {
        let body = r#"{"hash160": "aa", "address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
          "n_tx": 4, "total_received": 250000000, "total_sent": 97000000,
          "final_balance": 153000000, "txs": []}"#;
        assert_eq!(parse_blockchain_info_balance(body).unwrap(), 1.53);
    }

    #[test]
    fn blockchain_info_accepts_a_stringified_balance() {
        // The Python wrapped this in int(), which accepted both renderings.
        let body = r#"{"final_balance": "153000000"}"#;
        assert_eq!(parse_blockchain_info_balance(body).unwrap(), 1.53);
    }

    #[test]
    fn blockchain_info_zero_balance_is_zero() {
        assert_eq!(
            parse_blockchain_info_balance(r#"{"final_balance": 0, "n_tx": 0}"#).unwrap(),
            0.0
        );
    }

    #[test]
    fn blockchain_info_rejects_a_body_without_a_balance() {
        assert!(parse_blockchain_info_balance(r#"{"error": "not found"}"#).is_err());
        assert!(parse_blockchain_info_balance("<html>502</html>").is_err());
    }

    #[test]
    fn a_large_balance_keeps_full_satoshi_precision() {
        // 21M BTC in sats exceeds f64's exact-integer range only after the divide; the parser does
        // the arithmetic in i128 first so no satoshi is lost on the way.
        let body = r#"{"chain_stats": {"funded_txo_sum": 2100000000000000, "spent_txo_sum": 0}}"#;
        assert_eq!(parse_esplora_balance(body).unwrap(), 21_000_000.0);
    }

    // --- the fallback chain -------------------------------------------------

    /// Records whether it was asked, so a test can prove a later source was *not* consulted.
    struct FakeSource {
        label: &'static str,
        answer: Option<f64>,
        asked: Mutex<bool>,
    }

    impl FakeSource {
        fn ok(label: &'static str, balance: f64) -> Self {
            Self {
                label,
                answer: Some(balance),
                asked: Mutex::new(false),
            }
        }
        fn broken(label: &'static str) -> Self {
            Self {
                label,
                answer: None,
                asked: Mutex::new(false),
            }
        }
        fn was_asked(&self) -> bool {
            *self.asked.lock().unwrap()
        }
    }

    impl BtcBalanceSource for FakeSource {
        fn name(&self) -> String {
            self.label.to_string()
        }
        fn balance<'a>(
            &'a self,
            _address: &'a str,
        ) -> Pin<Box<dyn Future<Output = Result<f64>> + Send + 'a>> {
            Box::pin(async move {
                *self.asked.lock().unwrap() = true;
                self.answer.context("provider is down")
            })
        }
    }

    #[tokio::test]
    async fn a_failing_first_provider_falls_through_to_the_second() {
        // The important one: a dead provider must cost latency, never balance.
        let down = FakeSource::broken("blockstream");
        let up = FakeSource::ok("blockchain.info", 1.53);
        let balance = balance_from_sources(&[&down, &up], "bc1qtest").await;

        assert_eq!(balance, Some(1.53));
        assert!(down.was_asked() && up.was_asked());
    }

    #[tokio::test]
    async fn the_chain_survives_every_provider_but_the_last_failing() {
        let a = FakeSource::broken("blockstream");
        let b = FakeSource::broken("blockchain.info");
        let c = FakeSource::ok("mempool.space", 0.25);
        assert_eq!(
            balance_from_sources(&[&a, &b, &c], "bc1qtest").await,
            Some(0.25)
        );
    }

    #[tokio::test]
    async fn a_working_first_provider_stops_the_chain() {
        let first = FakeSource::ok("blockstream", 2.0);
        let second = FakeSource::ok("blockchain.info", 999.0);
        assert_eq!(
            balance_from_sources(&[&first, &second], "bc1qtest").await,
            Some(2.0)
        );
        assert!(
            !second.was_asked(),
            "the second source must not be consulted"
        );
    }

    #[tokio::test]
    async fn a_zero_balance_stops_the_chain_like_any_other_answer() {
        // 0 is an answer, not a failure — falling through here would ask a slower provider for a
        // number we already have.
        let first = FakeSource::ok("blockstream", 0.0);
        let second = FakeSource::ok("blockchain.info", 5.0);
        assert_eq!(
            balance_from_sources(&[&first, &second], "bc1qtest").await,
            Some(0.0)
        );
        assert!(!second.was_asked());
    }

    #[tokio::test]
    async fn all_providers_failing_yields_none_rather_than_zero() {
        // None means "unknown" and the chain is omitted; 0.0 would silently claim the wallet
        // is empty.
        let a = FakeSource::broken("a");
        let b = FakeSource::broken("b");
        assert_eq!(balance_from_sources(&[&a, &b], "bc1qtest").await, None);
    }

    // --- assembly -----------------------------------------------------------

    #[test]
    fn the_portfolio_prices_the_balance() {
        let portfolio = btc_portfolio_from("bitcoin", 1.53, 100_000.0, Some(2.5)).unwrap();
        assert_eq!(portfolio.chain, "bitcoin");
        assert_eq!(portfolio.usd, 153_000.0);
        assert_eq!(portfolio.spot.len(), 1);

        let btc = &portfolio.spot[0];
        assert_eq!(btc.symbol, "BTC");
        assert_eq!(btc.amount, 1.53);
        assert_eq!(btc.kind, "native");
        assert_eq!(btc.change24h, Some(2.5));
        assert!(portfolio.defi.is_empty());
    }

    #[test]
    fn a_zero_balance_is_dust_and_the_chain_is_dropped() {
        // Matches `_chain_result`: below a cent, the chain is not reported at all.
        assert!(btc_portfolio_from("bitcoin", 0.0, 100_000.0, None).is_none());
    }

    #[test]
    fn an_unpriced_balance_is_dropped_rather_than_valued_at_zero() {
        // price=0 is what `_llama_key_price(...) or 0` yields on an outage.
        assert!(btc_portfolio_from("bitcoin", 1.53, 0.0, None).is_none());
    }

    #[test]
    fn a_dust_balance_produces_no_spot_row() {
        // One satoshi at $100k is a tenth of a cent — real, but below the cut-off.
        assert!(btc_portfolio_from("bitcoin", 0.000_000_01, 100_000.0, None).is_none());
    }

    // --- replayed fixtures --------------------------------------------------

    #[tokio::test]
    async fn the_fallback_works_end_to_end_against_recorded_responses() {
        // Fixture 1: blockstream answering HTTP 429 with a rate-limit page.
        // Fixture 2: blockchain.info answering normally. The balance must come from #2.
        let cache = fixtures();
        let client = reqwest::Client::new();
        let blockstream = Esplora {
            base: BLOCKSTREAM_API,
            client: &client,
            cache: &cache,
        };
        let blockchain_info = BlockchainInfo {
            client: &client,
            cache: &cache,
        };

        let address = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
        assert!(
            blockstream.balance(address).await.is_err(),
            "the fixture makes the first source fail"
        );
        let balance = balance_from_sources(&[&blockstream, &blockchain_info], address).await;
        assert_eq!(balance, Some(1.53));
    }

    #[tokio::test]
    async fn a_healthy_esplora_fixture_replays() {
        let cache = fixtures();
        let client = reqwest::Client::new();
        let source = Esplora {
            base: MEMPOOL_SPACE_API,
            client: &client,
            cache: &cache,
        };
        assert_eq!(
            source
                .balance("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")
                .await
                .unwrap(),
            1.53
        );
    }

    #[tokio::test]
    async fn the_full_read_prices_a_replayed_balance() {
        let cache = fixtures();
        let client = reqwest::Client::new();
        let portfolio = btc_chain_portfolio(
            &client,
            &cache,
            "bitcoin",
            "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(portfolio.spot[0].symbol, "BTC");
        assert_eq!(portfolio.spot[0].amount, 1.53);
        assert_eq!(portfolio.spot[0].price, 95_000.0);
        assert_eq!(portfolio.usd, 1.53 * 95_000.0);
        assert_eq!(portfolio.spot[0].change24h, Some(-1.234));
    }
}
