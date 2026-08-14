//! Hyperliquid L1 (HyperCore) reader — port of `portfolio.py:1968-2015`.
//!
//! HyperCore is an order-book exchange, not an EVM chain, so there is no RPC and no contract to
//! call: everything comes from the keyless `info` API, keyed by the same `0x…` address the wallet
//! uses on HyperEVM.
//!
//! A wallet here holds value in **two separate places**, and both must be reported:
//!
//! * **spot balances** — real tokens, priced from the `?/USDC` pair mids;
//! * **the perp account** — cross-margin collateral, which shows up as an account *value* rather
//!   than as a token balance. It is frequently the larger of the two, and dropping it would
//!   understate the portfolio without any error to notice.
//!
//! Prices deserve a word: `allMids` keys spot pairs as `@<universe index>`, not by symbol, and the
//! universe entry says which two token indices the pair trades. Only pairs quoted in USDC
//! (`quote == 0`) give a dollar price, so those are the only ones read.

use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};

use crate::bitcoin::{ChainPortfolio, DUST_USD, Position, PositionToken, SpotToken, chain_result};
use crate::http_cache::HttpCache;

pub const HL_INFO: &str = "https://api.hyperliquid.xyz/info";

/// The quote token index that means "priced in dollars".
const USDC_INDEX: u64 = 0;

/// One `info` API call. Every request is a POST whose body names the query type, so the body is
/// part of the cache identity — `post_json` already accounts for that.
pub async fn hl(client: &reqwest::Client, cache: &HttpCache, body: &Value) -> Result<Value> {
    let recorded = cache.post_json(client, HL_INFO, body).await?;
    if !(200..300).contains(&recorded.status) {
        bail!("hyperliquid info returned HTTP {}", recorded.status);
    }
    serde_json::from_str(&recorded.body).context("hyperliquid info: response is not JSON")
}

/// Hyperliquid renders every quantity as a decimal **string** (`"12.5"`), so parsing is explicit
/// rather than incidental. A number is accepted too, in case that ever changes.
fn number(value: &Value, what: &str) -> Result<f64> {
    match value {
        Value::String(s) => s
            .parse::<f64>()
            .with_context(|| format!("{what} is not a number: {s:?}")),
        Value::Number(n) => n
            .as_f64()
            .with_context(|| format!("{what} is not a number: {n}")),
        other => bail!("{what} has unexpected type: {other}"),
    }
}

/// Non-zero spot balances, in the order the API returns them — `(coin, total)`.
///
/// `total` includes held (in-order) amounts; that is intentional, an open order is still the
/// wallet's money.
pub fn parse_spot_balances(state: &Value) -> Result<Vec<(String, f64)>> {
    let Some(balances) = state.get("balances").and_then(Value::as_array) else {
        // A wallet that has never touched spot has no `balances` key at all — an empty portfolio,
        // not a failure.
        return Ok(Vec::new());
    };

    let mut out = Vec::new();
    for balance in balances {
        let coin = balance
            .get("coin")
            .and_then(Value::as_str)
            .context("spot balance has no coin")?;
        let total = number(
            balance.get("total").context("spot balance has no total")?,
            "spot balance total",
        )?;
        if total > 0.0 {
            out.push((coin.to_string(), total));
        }
    }
    Ok(out)
}

/// Map spot coin symbol -> USD price: USDC is the unit, everything else comes from its `?/USDC`
/// pair mid.
///
/// Pairs quoted in something other than USDC are skipped rather than converted — a two-hop price
/// is a guess, and an unpriced token is simply left out of the total.
pub fn parse_spot_prices(meta: &Value, mids: &Value) -> Result<HashMap<String, f64>> {
    let mut names: HashMap<u64, String> = HashMap::new();
    for token in meta
        .get("tokens")
        .and_then(Value::as_array)
        .context("spotMeta has no tokens")?
    {
        if let (Some(index), Some(name)) = (
            token.get("index").and_then(Value::as_u64),
            token.get("name").and_then(Value::as_str),
        ) {
            names.insert(index, name.to_string());
        }
    }

    let mut prices = HashMap::from([("USDC".to_string(), 1.0)]);
    for pair in meta
        .get("universe")
        .and_then(Value::as_array)
        .context("spotMeta has no universe")?
    {
        let (Some(tokens), Some(index)) = (
            pair.get("tokens").and_then(Value::as_array),
            pair.get("index").and_then(Value::as_u64),
        ) else {
            continue;
        };
        let (Some(base), Some(quote)) = (
            tokens.first().and_then(Value::as_u64),
            tokens.get(1).and_then(Value::as_u64),
        ) else {
            continue;
        };
        if quote != USDC_INDEX {
            continue;
        }
        let Some(mid) = mids.get(format!("@{index}")) else {
            continue; // a listed pair with no current mid — no trades, no price
        };
        if let (Some(name), Ok(price)) = (names.get(&base), number(mid, "spot mid")) {
            prices.insert(name.clone(), price);
        }
    }
    Ok(prices)
}

/// Cross-margin account value in USD — the perp side's entire worth in one number.
///
/// Missing or null means zero: a wallet that has never opened a perp account still returns a
/// well-formed response, and that is not an error.
pub fn parse_account_value(state: &Value) -> Result<f64> {
    match state
        .get("marginSummary")
        .and_then(|m| m.get("accountValue"))
    {
        None | Some(Value::Null) => Ok(0.0),
        Some(raw) => number(raw, "marginSummary.accountValue"),
    }
}

/// Assemble the HyperCore portfolio — the pure half of `_hypercore_portfolio`.
///
/// A spot token with no price is dropped rather than valued at zero: Hyperliquid lists tokens with
/// no USDC pair, and inventing a price for them would move the portfolio total.
pub fn hypercore_portfolio_from(
    chain: &str,
    balances: &[(String, f64)],
    prices: &HashMap<String, f64>,
    account_value: f64,
) -> Option<ChainPortfolio> {
    let mut spot = Vec::new();
    for (coin, amount) in balances {
        let Some(&price) = prices.get(coin) else {
            continue;
        };
        let usd = amount * price;
        if usd > DUST_USD {
            spot.push(SpotToken {
                symbol: coin.clone(),
                amount: *amount,
                price,
                usd,
                change24h: None,
                kind: "token",
                coin: None,
                address: None,
            });
        }
    }

    let defi = if account_value > DUST_USD {
        vec![Position::new(
            "Hyperliquid Perps",
            "Perps",
            "Cross-margin account",
            account_value,
            vec![PositionToken {
                symbol: "USDC".to_string(),
                amount: account_value,
            }],
            None,
        )]
    } else {
        Vec::new()
    };

    let usd = spot.iter().map(|t| t.usd).sum::<f64>() + account_value;
    chain_result(chain, usd, spot, defi)
}

/// Hyperliquid L1 portfolio: spot balances plus the perp account value.
pub async fn hypercore_portfolio(
    client: &reqwest::Client,
    cache: &HttpCache,
    chain: &str,
    address: &str,
) -> Result<Option<ChainPortfolio>> {
    let spot_state = hl(
        client,
        cache,
        &json!({"type": "spotClearinghouseState", "user": address}),
    )
    .await?;
    let balances = parse_spot_balances(&spot_state)?;

    // Two extra calls only when there is something to price.
    let prices = if balances.is_empty() {
        HashMap::new()
    } else {
        let meta = hl(client, cache, &json!({"type": "spotMeta"})).await?;
        let mids = hl(client, cache, &json!({"type": "allMids"})).await?;
        parse_spot_prices(&meta, &mids)?
    };

    let perp = hl(
        client,
        cache,
        &json!({"type": "clearinghouseState", "user": address}),
    )
    .await?;
    let account_value = parse_account_value(&perp)?;

    Ok(hypercore_portfolio_from(
        chain,
        &balances,
        &prices,
        account_value,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_cache::Mode;
    use std::path::PathBuf;

    const SPOT_STATE: &str = r#"{
      "balances": [
        {"coin": "USDC", "token": 0, "hold": "0.0", "total": "250.5", "entryNtl": "0.0"},
        {"coin": "HYPE", "token": 1105, "hold": "1.0", "total": "12.5", "entryNtl": "300.0"},
        {"coin": "PURR", "token": 1, "hold": "0.0", "total": "0.0", "entryNtl": "0.0"}
      ]
    }"#;

    const SPOT_META: &str = r#"{
      "tokens": [
        {"name": "USDC", "szDecimals": 8, "weiDecimals": 8, "index": 0, "isCanonical": true},
        {"name": "PURR", "szDecimals": 0, "weiDecimals": 5, "index": 1, "isCanonical": true},
        {"name": "HYPE", "szDecimals": 2, "weiDecimals": 8, "index": 1105, "isCanonical": true}
      ],
      "universe": [
        {"tokens": [1, 0], "name": "PURR/USDC", "index": 0, "isCanonical": true},
        {"tokens": [1105, 0], "name": "@107", "index": 107, "isCanonical": false}
      ]
    }"#;

    const ALL_MIDS: &str = r#"{"BTC": "95000.0", "ETH": "3200.5", "@0": "0.19", "@107": "24.0"}"#;

    const PERP_STATE: &str = r#"{
      "marginSummary": {"accountValue": "1500.25", "totalNtlPos": "4000.0",
                        "totalRawUsd": "5500.25", "totalMarginUsed": "400.0"},
      "crossMarginSummary": {"accountValue": "1500.25"},
      "withdrawable": "1100.25", "assetPositions": [], "time": 1750000000000
    }"#;

    /// Sample payloads are written as the JSON the API actually returns; the callers hand the
    /// parsers an already-decoded `Value`.
    fn v(raw: &str) -> Value {
        serde_json::from_str(raw).expect("sample payload must be valid JSON")
    }

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        HttpCache::new(dir, Mode::Replay)
    }

    fn prices() -> HashMap<String, f64> {
        parse_spot_prices(&v(SPOT_META), &v(ALL_MIDS)).unwrap()
    }

    #[test]
    fn spot_balances_are_parsed_from_strings_and_zeroes_dropped() {
        let balances = parse_spot_balances(&v(SPOT_STATE)).unwrap();
        assert_eq!(
            balances,
            vec![("USDC".to_string(), 250.5), ("HYPE".to_string(), 12.5)],
            "PURR holds nothing and must not appear"
        );
    }

    #[test]
    fn a_wallet_with_no_spot_history_yields_an_empty_list_not_an_error() {
        assert!(
            parse_spot_balances(&v(r#"{"balances": []}"#))
                .unwrap()
                .is_empty()
        );
        assert!(parse_spot_balances(&v("{}")).unwrap().is_empty());
    }

    #[test]
    fn a_malformed_balance_fails_loudly() {
        // Better to lose the chain than to report a wallet as smaller than it is.
        assert!(
            parse_spot_balances(&v(r#"{"balances": [{"coin": "HYPE", "total": "abc"}]}"#)).is_err()
        );
        assert!(parse_spot_balances(&v(r#"{"balances": [{"coin": "HYPE"}]}"#)).is_err());
    }

    #[test]
    fn spot_prices_come_from_the_usdc_pair_mids() {
        let prices = prices();
        assert_eq!(prices.get("USDC"), Some(&1.0), "USDC is the unit");
        assert_eq!(prices.get("PURR"), Some(&0.19), "pair @0 -> token index 1");
        assert_eq!(prices.get("HYPE"), Some(&24.0), "pair @107 -> token 1105");
    }

    #[test]
    fn the_pair_index_not_the_token_index_keys_the_mid() {
        // HYPE is token 1105 but trades as pair @107. Keying by the token index would price HYPE
        // at PURR's mid, or at nothing.
        assert_eq!(prices().get("HYPE"), Some(&24.0));
        assert!(
            !prices().values().any(|p| *p == 95000.0),
            "perp mids are not spot pairs"
        );
    }

    #[test]
    fn pairs_not_quoted_in_usdc_are_skipped() {
        // A PURR/HYPE pair gives no dollar price, so HYPE stays unpriced.
        let meta = r#"{"tokens": [{"name": "USDC", "index": 0}, {"name": "PURR", "index": 1},
                       {"name": "HYPE", "index": 1105}],
                       "universe": [{"tokens": [1105, 1], "index": 5}]}"#;
        let prices = parse_spot_prices(&v(meta), &v(r#"{"@5": "126.3"}"#)).unwrap();
        assert_eq!(prices.len(), 1, "only USDC: {prices:?}");
    }

    #[test]
    fn a_pair_with_no_mid_is_skipped_rather_than_priced_at_zero() {
        let prices = parse_spot_prices(&v(SPOT_META), &v(r#"{"@0": "0.19"}"#)).unwrap();
        assert_eq!(prices.get("PURR"), Some(&0.19));
        assert_eq!(prices.get("HYPE"), None, "no mid means no price, not 0");
    }

    #[test]
    fn the_account_value_is_read_from_the_margin_summary() {
        assert_eq!(parse_account_value(&v(PERP_STATE)).unwrap(), 1500.25);
    }

    #[test]
    fn a_wallet_with_no_perp_account_values_at_zero() {
        assert_eq!(
            parse_account_value(&v(r#"{"marginSummary": {}}"#)).unwrap(),
            0.0
        );
        assert_eq!(parse_account_value(&v("{}")).unwrap(), 0.0);
        assert_eq!(
            parse_account_value(&v(r#"{"marginSummary": {"accountValue": null}}"#)).unwrap(),
            0.0
        );
        assert_eq!(
            parse_account_value(&v(r#"{"marginSummary": {"accountValue": "0.0"}}"#)).unwrap(),
            0.0
        );
    }

    #[test]
    fn both_spot_and_perp_value_land_in_the_total() {
        // The point of the chain: 250.50 + 12.5*24 = 550.50 spot, plus a 1500.25 perp account.
        let balances = parse_spot_balances(&v(SPOT_STATE)).unwrap();
        let portfolio =
            hypercore_portfolio_from("hyperliquid", &balances, &prices(), 1500.25).unwrap();

        assert_eq!(portfolio.spot.len(), 2);
        assert_eq!(portfolio.defi.len(), 1);
        assert!(
            (portfolio.usd - 2050.75).abs() < 1e-9,
            "got {}",
            portfolio.usd
        );

        let perp = &portfolio.defi[0];
        assert_eq!(perp.protocol, "Hyperliquid Perps");
        assert_eq!(perp.category, "Perps");
        assert_eq!(perp.name, "Cross-margin account");
        assert_eq!(perp.usd, 1500.25);
        assert_eq!(perp.tokens[0].symbol, "USDC");
        assert_eq!(perp.tokens[0].amount, 1500.25);
    }

    #[test]
    fn a_perp_only_wallet_still_reports_its_account() {
        // No spot at all: the entire portfolio is the perp account, and it must survive.
        let portfolio =
            hypercore_portfolio_from("hyperliquid", &[], &HashMap::new(), 4200.0).unwrap();
        assert!(portfolio.spot.is_empty());
        assert_eq!(portfolio.usd, 4200.0);
        assert_eq!(portfolio.defi[0].usd, 4200.0);
    }

    #[test]
    fn a_spot_only_wallet_reports_no_perp_position() {
        let balances = parse_spot_balances(&v(SPOT_STATE)).unwrap();
        let portfolio = hypercore_portfolio_from("hyperliquid", &balances, &prices(), 0.0).unwrap();
        assert!(portfolio.defi.is_empty());
        assert!((portfolio.usd - 550.5).abs() < 1e-9);
    }

    #[test]
    fn an_unpriced_token_is_left_out_of_the_total() {
        let balances = vec![("WEIRD".to_string(), 1_000_000.0)];
        assert!(hypercore_portfolio_from("hyperliquid", &balances, &HashMap::new(), 0.0).is_none());
    }

    #[test]
    fn dust_spot_and_dust_perp_yield_nothing() {
        let balances = vec![("USDC".to_string(), 0.001)];
        assert!(hypercore_portfolio_from("hyperliquid", &balances, &prices(), 0.0).is_none());
    }

    #[test]
    fn an_empty_wallet_is_absent_rather_than_zeroed() {
        assert!(hypercore_portfolio_from("hyperliquid", &[], &HashMap::new(), 0.0).is_none());
    }

    #[tokio::test]
    async fn the_full_read_replays_from_fixtures() {
        let cache = fixtures();
        let client = reqwest::Client::new();
        let portfolio = hypercore_portfolio(
            &client,
            &cache,
            "hyperliquid",
            "0x1234567890abcdef1234567890abcdef12345678",
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(portfolio.spot.len(), 2);
        assert_eq!(
            portfolio.defi.len(),
            1,
            "the perp account must survive the round trip"
        );
        assert!(
            (portfolio.usd - 2050.75).abs() < 1e-9,
            "got {}",
            portfolio.usd
        );
    }

    #[tokio::test]
    async fn each_info_query_gets_its_own_fixture() {
        // Every call is a POST to the same URL; if the cache keyed on URL alone these two would
        // collide and the perp state would answer the spot query.
        let cache = fixtures();
        let client = reqwest::Client::new();
        let address = "0x1234567890abcdef1234567890abcdef12345678";

        let spot = hl(
            &client,
            &cache,
            &json!({"type": "spotClearinghouseState", "user": address}),
        )
        .await
        .unwrap();
        let perp = hl(
            &client,
            &cache,
            &json!({"type": "clearinghouseState", "user": address}),
        )
        .await
        .unwrap();

        assert!(spot.get("balances").is_some());
        assert!(perp.get("marginSummary").is_some());
    }
}
