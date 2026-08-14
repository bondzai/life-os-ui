//! Solana chain reader — port of `portfolio.py:2018-2119`.
//!
//! Keyless JSON-RPC: native SOL from `getBalance`, SPL and Token-2022 balances from
//! `getTokenAccountsByOwner` (one call per token program), native stake accounts from
//! `getProgramAccounts`, and every price from DefiLlama.
//!
//! Three things here are easy to get wrong and expensive when wrong:
//!
//! * **Lamports.** Native SOL and stake accounts are integers of 1e-9 SOL. Tokens are *not* — the
//!   RPC already applies each mint's decimals and hands back `uiAmountString`, so that value is
//!   used verbatim rather than re-scaled.
//! * **One mint, several accounts.** A wallet can hold the same mint in multiple token accounts;
//!   the amounts are summed per mint, or the portfolio reports only whichever account came last.
//! * **Scam mints.** Airdropped SPL tokens come with a bogus DefiLlama price at low confidence.
//!   Anything below [`MIN_CONFIDENCE`] is dropped, exactly as the EVM spot path does.
//!
//! Public RPCs rate-limit and 403 datacenter IPs, so endpoints are tried in order and the first
//! usable answer wins — same shape as the Bitcoin provider chain.

use std::collections::HashMap;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::bitcoin::{ChainPortfolio, DUST_USD, Position, PositionToken, SpotToken, chain_result};
use crate::http_cache::HttpCache;
use crate::spam::MIN_CONFIDENCE;

/// Lamports in one SOL.
pub const LAMPORTS_PER_SOL: f64 = 1e9;

pub const SOL_RPCS: [&str; 2] = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
];

/// SPL Token, then Token-2022 — a wallet can hold balances under either program.
pub const SPL_PROGRAMS: [&str; 2] = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
];

pub const STAKE_PROGRAM: &str = "Stake11111111111111111111111111111111111111";

/// DefiLlama key for native SOL.
pub const SOL_PRICE_KEY: &str = "coingecko:solana";

/// Stake account layout: 200 bytes, with the withdraw authority at byte 44. Filtering on both is
/// what makes `getProgramAccounts` answer at all on a public RPC.
const STAKE_ACCOUNT_LEN: u64 = 200;
const STAKE_WITHDRAWER_OFFSET: u64 = 44;

/// A DefiLlama price entry. `confidence` gates whether the price may be believed at all.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LlamaPrice {
    pub price: Option<f64>,
    pub confidence: Option<f64>,
    pub symbol: Option<String>,
}

/// A mint's summed balance across every token account holding it. Kept as an ordered `Vec` rather
/// than a map so the emitted token order is stable run to run — a parity diff against the Python
/// compares lists.
pub type Held = Vec<(String, f64)>;

fn add_held(held: &mut Held, mint: &str, amount: f64) {
    if let Some(entry) = held.iter_mut().find(|(m, _)| m == mint) {
        entry.1 += amount;
    } else {
        held.push((mint.to_string(), amount));
    }
}

// ===========================================================================
// RPC
// ===========================================================================

/// One JSON-RPC call, falling back across the public endpoints. `None` when every endpoint failed
/// — the caller decides whether that means "chain unreadable" or "best-effort, treat as empty".
///
/// A non-200 status or a response without a `result` counts as a failure: public RPCs answer
/// throttling with a 200 and an `error` body, and treating that as an empty result would silently
/// zero the wallet.
pub async fn sol_rpc(
    client: &reqwest::Client,
    cache: &HttpCache,
    method: &str,
    params: Value,
) -> Option<Value> {
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
    for url in SOL_RPCS {
        match cache.post_json(client, url, &body).await {
            Ok(recorded) if recorded.status == 200 => {
                match serde_json::from_str::<Value>(&recorded.body) {
                    Ok(mut json) => {
                        if let Some(result) = json.get_mut("result") {
                            return Some(result.take());
                        }
                        tracing::warn!(url, method, body = recorded.body, "rpc returned no result");
                    }
                    Err(error) => tracing::warn!(url, method, %error, "rpc response is not JSON"),
                }
            }
            Ok(recorded) => {
                tracing::warn!(
                    url,
                    method,
                    status = recorded.status,
                    "rpc returned an error status"
                )
            }
            Err(error) => tracing::warn!(url, method, error = format!("{error:#}"), "rpc failed"),
        }
    }
    None
}

// ===========================================================================
// Parsing — pure
// ===========================================================================

/// Native balance in SOL from a `getBalance` result (`{"context": …, "value": lamports}`).
pub fn parse_native_balance(result: &Value) -> f64 {
    let lamports = result.get("value").and_then(Value::as_u64).unwrap_or(0);
    lamports as f64 / LAMPORTS_PER_SOL
}

/// Fold one `getTokenAccountsByOwner` result into `held`, summing per mint.
///
/// Malformed accounts are skipped rather than fatal: a single odd Token-2022 extension must not
/// cost the wallet every other balance. Zero-balance accounts (closed positions leave them behind)
/// are skipped too.
pub fn collect_token_accounts(result: &Value, held: &mut Held) {
    let Some(accounts) = result.get("value").and_then(Value::as_array) else {
        return;
    };
    for account in accounts {
        let Some(info) = account
            .get("account")
            .and_then(|a| a.get("data"))
            .and_then(|d| d.get("parsed"))
            .and_then(|p| p.get("info"))
        else {
            continue;
        };
        let Some(mint) = info.get("mint").and_then(Value::as_str) else {
            continue;
        };
        // `uiAmountString` is decimals-adjusted and exact; `uiAmount` is a lossy float and
        // `amount` is raw base units. The Python reads the string, and so do we.
        let amount = info
            .get("tokenAmount")
            .and_then(|t| t.get("uiAmountString"))
            .and_then(Value::as_str)
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0);
        if amount > 0.0 {
            add_held(held, mint, amount);
        }
    }
}

/// Total SOL across the wallet's native stake accounts, from a `getProgramAccounts` result.
///
/// Each account's **full lamports** are counted — delegated stake plus rent reserve plus unclaimed
/// rewards — because that is what the wallet would recover on withdrawal.
pub fn parse_staked(result: &Value) -> f64 {
    let Some(accounts) = result.as_array() else {
        // getProgramAccounts is heavy and often throttled; a failure is 0, not an error.
        return 0.0;
    };
    let lamports: u128 = accounts
        .iter()
        .filter_map(|a| a.get("account")?.get("lamports")?.as_u64())
        .map(u128::from)
        .sum();
    lamports as f64 / LAMPORTS_PER_SOL
}

/// DefiLlama's `coins` map from a `prices/current` body.
pub fn parse_llama_prices(body: &str) -> HashMap<String, LlamaPrice> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return HashMap::new();
    };
    let Some(coins) = value.get("coins").and_then(Value::as_object) else {
        return HashMap::new();
    };
    coins
        .iter()
        .map(|(key, entry)| {
            (
                key.clone(),
                LlamaPrice {
                    price: entry.get("price").and_then(Value::as_f64),
                    confidence: entry.get("confidence").and_then(Value::as_f64),
                    symbol: entry
                        .get("symbol")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                },
            )
        })
        .collect()
}

/// DefiLlama's `coins` map from a `percentage` body — key -> 24h % change.
pub fn parse_llama_changes(body: &str) -> HashMap<String, f64> {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return HashMap::new();
    };
    let Some(coins) = value.get("coins").and_then(Value::as_object) else {
        return HashMap::new();
    };
    coins
        .iter()
        .filter_map(|(key, change)| Some((key.clone(), change.as_f64()?)))
        .collect()
}

/// Batch price + 24h change for a set of coin keys — port of `_sol_prices`.
///
/// Either half failing yields an empty map rather than an error: an unpriced token drops out of
/// the total, which is the safe direction.
pub async fn sol_prices(
    client: &reqwest::Client,
    cache: &HttpCache,
    keys: &[String],
) -> (HashMap<String, LlamaPrice>, HashMap<String, f64>) {
    if keys.is_empty() {
        return (HashMap::new(), HashMap::new());
    }
    let joined = keys.join(",");

    let prices = match cache
        .get(
            client,
            &format!("https://coins.llama.fi/prices/current/{joined}"),
        )
        .await
    {
        Ok(recorded) => parse_llama_prices(&recorded.body),
        Err(error) => {
            tracing::warn!(error = format!("{error:#}"), "defillama prices failed");
            HashMap::new()
        }
    };
    let changes = match cache
        .get(
            client,
            &format!("https://coins.llama.fi/percentage/{joined}?period=24h"),
        )
        .await
    {
        Ok(recorded) => parse_llama_changes(&recorded.body),
        Err(error) => {
            tracing::warn!(error = format!("{error:#}"), "defillama changes failed");
            HashMap::new()
        }
    };
    (prices, changes)
}

/// The DefiLlama keys a wallet's holdings need: native SOL first, then one per mint.
pub fn price_keys(held: &Held) -> Vec<String> {
    let mut keys = vec![SOL_PRICE_KEY.to_string()];
    keys.extend(held.iter().map(|(mint, _)| format!("solana:{mint}")));
    keys
}

// ===========================================================================
// Assembly
// ===========================================================================

/// Build the Solana portfolio from already-fetched pieces — the pure half of
/// `_solana_chain_portfolio`.
///
/// Staked SOL is a *separate* position rather than added to the liquid balance: it cannot be spent
/// without a multi-day unbonding, and merging the two would misrepresent what is available.
pub fn solana_portfolio_from(
    chain: &str,
    sol_amount: f64,
    held: &Held,
    staked: f64,
    prices: &HashMap<String, LlamaPrice>,
    changes: &HashMap<String, f64>,
) -> Option<ChainPortfolio> {
    let sol_price = prices
        .get(SOL_PRICE_KEY)
        .and_then(|p| p.price)
        .unwrap_or(0.0);
    let sol_change = changes.get(SOL_PRICE_KEY).copied();

    let mut spot = Vec::new();
    if sol_amount * sol_price > DUST_USD {
        spot.push(SpotToken {
            symbol: "SOL".to_string(),
            amount: sol_amount,
            price: sol_price,
            usd: sol_amount * sol_price,
            change24h: sol_change,
            kind: "native",
            coin: Some(SOL_PRICE_KEY.to_string()),
            address: None,
        });
    }

    for (mint, amount) in held {
        let key = format!("solana:{mint}");
        let entry = prices.get(&key).cloned().unwrap_or_default();
        let Some(price) = entry.price else { continue };
        // The confidence gate is what keeps airdropped scam mints out of the total.
        if entry.confidence.unwrap_or(0.0) < MIN_CONFIDENCE {
            continue;
        }
        let usd = amount * price;
        if usd <= DUST_USD {
            continue;
        }
        spot.push(SpotToken {
            symbol: entry.symbol.as_deref().unwrap_or("?").to_uppercase(),
            amount: *amount,
            price,
            usd,
            change24h: changes.get(&key).copied(),
            kind: "token",
            coin: Some(key),
            address: Some(mint.clone()),
        });
    }

    let mut defi = Vec::new();
    if staked * sol_price > DUST_USD {
        defi.push(Position::new(
            "Native Stake",
            "Staking",
            "Staked SOL",
            staked * sol_price,
            vec![PositionToken {
                symbol: "SOL".to_string(),
                amount: staked,
            }],
            sol_change,
        ));
    }

    let usd = spot.iter().map(|t| t.usd).sum::<f64>() + defi.iter().map(|p| p.usd).sum::<f64>();
    chain_result(chain, usd, spot, defi)
}

/// Solana portfolio: native SOL + SPL/Token-2022 balances + native stake accounts.
///
/// `Err` means the RPC was unreachable and the chain must be reported as missing rather than
/// empty; `Ok(None)` means the wallet genuinely holds nothing worth showing.
pub async fn solana_chain_portfolio(
    client: &reqwest::Client,
    cache: &HttpCache,
    chain: &str,
    address: &str,
) -> Result<Option<ChainPortfolio>> {
    let balance = sol_rpc(client, cache, "getBalance", json!([address]))
        .await
        .context("every solana rpc endpoint failed for getBalance")?;
    let sol_amount = parse_native_balance(&balance);

    let mut held: Held = Vec::new();
    for program in SPL_PROGRAMS {
        if let Some(result) = sol_rpc(
            client,
            cache,
            "getTokenAccountsByOwner",
            json!([address, {"programId": program}, {"encoding": "jsonParsed"}]),
        )
        .await
        {
            collect_token_accounts(&result, &mut held);
        }
    }

    let (prices, changes) = sol_prices(client, cache, &price_keys(&held)).await;

    let staked_result = sol_rpc(
        client,
        cache,
        "getProgramAccounts",
        json!([STAKE_PROGRAM, {
            "encoding": "base64",
            "filters": [
                {"dataSize": STAKE_ACCOUNT_LEN},
                {"memcmp": {"offset": STAKE_WITHDRAWER_OFFSET, "bytes": address}}
            ]
        }]),
    )
    .await
    .unwrap_or(Value::Null);
    let staked = parse_staked(&staked_result);

    Ok(solana_portfolio_from(
        chain, sol_amount, &held, staked, &prices, &changes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_cache::Mode;
    use std::path::PathBuf;

    const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const JITO_MINT: &str = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";

    /// A real `getTokenAccountsByOwner` shape, trimmed to the fields the parser reads.
    const TOKEN_ACCOUNTS: &str = r#"{
      "context": {"apiVersion": "2.1.11", "slot": 312000000},
      "value": [
        {"pubkey": "AAA", "account": {"lamports": 2039280, "owner": "Tokenkeg",
          "data": {"program": "spl-token", "space": 165, "parsed": {"type": "account",
            "info": {"isNative": false, "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "9WzD", "state": "initialized",
              "tokenAmount": {"amount": "125500000", "decimals": 6,
                              "uiAmount": 125.5, "uiAmountString": "125.5"}}}}}},
        {"pubkey": "BBB", "account": {"lamports": 2039280, "owner": "Tokenkeg",
          "data": {"program": "spl-token", "space": 165, "parsed": {"type": "account",
            "info": {"mint": "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
              "tokenAmount": {"amount": "2000000000", "decimals": 9,
                              "uiAmount": 2.0, "uiAmountString": "2"}}}}}},
        {"pubkey": "CCC", "account": {"lamports": 2039280, "owner": "Tokenkeg",
          "data": {"program": "spl-token", "space": 165, "parsed": {"type": "account",
            "info": {"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "tokenAmount": {"amount": "500000", "decimals": 6,
                              "uiAmount": 0.5, "uiAmountString": "0.5"}}}}}}
      ]
    }"#;

    fn v(raw: &str) -> Value {
        serde_json::from_str(raw).expect("sample payload must be valid JSON")
    }

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        HttpCache::new(dir, Mode::Replay)
    }

    fn priced(key: &str, price: f64, confidence: f64, symbol: &str) -> (String, LlamaPrice) {
        (
            key.to_string(),
            LlamaPrice {
                price: Some(price),
                confidence: Some(confidence),
                symbol: Some(symbol.to_string()),
            },
        )
    }

    #[test]
    fn the_lamport_divisor_is_ten_to_the_nine() {
        assert_eq!(parse_native_balance(&v(r#"{"value": 1000000000}"#)), 1.0);
        assert_eq!(parse_native_balance(&v(r#"{"value": 1}"#)), 0.000_000_001);
        assert_eq!(
            parse_native_balance(&v(r#"{"context": {"slot": 1}, "value": 2500000000}"#)),
            2.5
        );
    }

    #[test]
    fn an_empty_account_reads_as_zero_sol() {
        // getBalance on an unfunded address returns value 0 — a real answer, not a failure.
        assert_eq!(parse_native_balance(&v(r#"{"value": 0}"#)), 0.0);
        assert_eq!(parse_native_balance(&v("{}")), 0.0);
    }

    #[test]
    fn token_accounts_are_summed_per_mint() {
        let mut held = Held::new();
        collect_token_accounts(&v(TOKEN_ACCOUNTS), &mut held);
        assert_eq!(
            held,
            vec![(USDC_MINT.to_string(), 126.0), (JITO_MINT.to_string(), 2.0)],
            "the two USDC accounts must merge into one 126.0 entry"
        );
    }

    #[test]
    fn both_token_programs_fold_into_one_map() {
        // SPL and Token-2022 are separate RPC calls; the same mint from both must still sum.
        let mut held = Held::new();
        collect_token_accounts(&v(TOKEN_ACCOUNTS), &mut held);
        collect_token_accounts(&v(TOKEN_ACCOUNTS), &mut held);
        assert_eq!(held[0].1, 252.0);
    }

    #[test]
    fn a_wallet_with_no_token_accounts_adds_nothing() {
        let mut held = Held::new();
        collect_token_accounts(&v(r#"{"context": {"slot": 1}, "value": []}"#), &mut held);
        collect_token_accounts(&v("{}"), &mut held);
        assert!(held.is_empty());
    }

    #[test]
    fn empty_and_malformed_token_accounts_are_skipped_not_fatal() {
        let body = r#"{"value": [
          {"pubkey": "AAA", "account": {"data": {"parsed": {"info": {"mint": "Mint1",
            "tokenAmount": {"uiAmountString": "0"}}}}}},
          {"pubkey": "BBB", "account": {"data": {"parsed": {"info": {"mint": "Mint2"}}}}},
          {"pubkey": "CCC", "account": {"data": "base64-not-parsed"}},
          {"pubkey": "DDD", "account": {"data": {"parsed": {"info": {"mint": "Mint3",
            "tokenAmount": {"uiAmountString": "7.25"}}}}}}
        ]}"#;
        let mut held = Held::new();
        collect_token_accounts(&v(body), &mut held);
        assert_eq!(held, vec![("Mint3".to_string(), 7.25)]);
    }

    #[test]
    fn the_exact_ui_amount_string_is_preferred_over_the_lossy_float() {
        // uiAmount is a JSON double and loses precision on large 9-decimal balances.
        let body = r#"{"value": [{"account": {"data": {"parsed": {"info": {"mint": "M",
          "tokenAmount": {"amount": "123456789123456789", "decimals": 9,
                          "uiAmount": 123456789.12345679,
                          "uiAmountString": "123456789.123456789"}}}}}}]}"#;
        let mut held = Held::new();
        collect_token_accounts(&v(body), &mut held);
        assert_eq!(held[0].1, "123456789.123456789".parse::<f64>().unwrap());
    }

    #[test]
    fn staked_lamports_sum_across_stake_accounts() {
        let body = r#"[
          {"pubkey": "S1", "account": {"lamports": 5000000000, "owner": "Stake11111111111111111111111111111111111111", "data": ["", "base64"], "space": 200}},
          {"pubkey": "S2", "account": {"lamports": 2500000000, "owner": "Stake11111111111111111111111111111111111111", "data": ["", "base64"], "space": 200}}
        ]"#;
        assert_eq!(parse_staked(&v(body)), 7.5);
    }

    #[test]
    fn no_stake_accounts_means_zero_staked() {
        assert_eq!(parse_staked(&v("[]")), 0.0);
    }

    #[test]
    fn a_throttled_stake_query_is_zero_rather_than_an_error() {
        // getProgramAccounts is best-effort; a non-list result must not sink the whole chain.
        assert_eq!(parse_staked(&Value::Null), 0.0);
        assert_eq!(
            parse_staked(&v(r#"{"error": "long-term storage query"}"#)),
            0.0
        );
    }

    #[test]
    fn llama_prices_and_changes_are_parsed() {
        let prices = parse_llama_prices(
            r#"{"coins": {"coingecko:solana": {"price": 150.5, "symbol": "SOL",
                 "confidence": 0.99, "timestamp": 1750000000}}}"#,
        );
        assert_eq!(prices["coingecko:solana"].price, Some(150.5));
        assert_eq!(prices["coingecko:solana"].confidence, Some(0.99));

        let changes = parse_llama_changes(r#"{"coins": {"coingecko:solana": -3.75}}"#);
        assert_eq!(changes["coingecko:solana"], -3.75);
    }

    #[test]
    fn a_broken_price_response_is_empty_not_fatal() {
        assert!(parse_llama_prices("<html>502 Bad Gateway</html>").is_empty());
        assert!(parse_llama_prices(r#"{"coins": {}}"#).is_empty());
        assert!(parse_llama_changes("nonsense").is_empty());
    }

    #[test]
    fn the_price_key_list_starts_with_native_sol() {
        let held = vec![(USDC_MINT.to_string(), 1.0)];
        assert_eq!(
            price_keys(&held),
            vec![
                "coingecko:solana".to_string(),
                format!("solana:{USDC_MINT}")
            ]
        );
    }

    // --- assembly -----------------------------------------------------------

    fn sample_prices() -> HashMap<String, LlamaPrice> {
        HashMap::from([
            priced(SOL_PRICE_KEY, 150.0, 0.99, "SOL"),
            priced(&format!("solana:{USDC_MINT}"), 1.0, 0.99, "usdc"),
            priced(&format!("solana:{JITO_MINT}"), 180.0, 0.99, "jitoSOL"),
        ])
    }

    #[test]
    fn native_tokens_and_stake_all_appear() {
        let held = vec![(USDC_MINT.to_string(), 126.0), (JITO_MINT.to_string(), 2.0)];
        let changes = HashMap::from([(SOL_PRICE_KEY.to_string(), -3.75)]);
        let portfolio =
            solana_portfolio_from("solana", 2.5, &held, 10.0, &sample_prices(), &changes).unwrap();

        // 2.5 SOL = 375, 126 USDC = 126, 2 jitoSOL = 360, 10 staked SOL = 1500.
        assert_eq!(portfolio.spot.len(), 3);
        assert_eq!(portfolio.spot[0].symbol, "SOL");
        assert_eq!(portfolio.spot[0].kind, "native");
        assert_eq!(portfolio.spot[0].change24h, Some(-3.75));
        assert_eq!(portfolio.spot[1].symbol, "USDC", "symbols are upper-cased");
        assert_eq!(portfolio.spot[1].address.as_deref(), Some(USDC_MINT));
        assert_eq!(portfolio.spot[2].symbol, "JITOSOL");
        assert!(
            (portfolio.usd - 2361.0).abs() < 1e-9,
            "got {}",
            portfolio.usd
        );

        let stake = &portfolio.defi[0];
        assert_eq!(stake.protocol, "Native Stake");
        assert_eq!(stake.category, "Staking");
        assert_eq!(stake.usd, 1500.0);
        assert_eq!(
            stake.tokens[0].amount, 10.0,
            "the position carries SOL, not USD"
        );
        assert_eq!(stake.change24h, Some(-3.75));
    }

    #[test]
    fn staked_sol_stays_out_of_the_liquid_balance() {
        // Liquid 2.5 SOL and 10 staked must not merge into a 12.5 SOL spot row.
        let portfolio = solana_portfolio_from(
            "solana",
            2.5,
            &Held::new(),
            10.0,
            &sample_prices(),
            &HashMap::new(),
        )
        .unwrap();
        assert_eq!(portfolio.spot.len(), 1);
        assert_eq!(portfolio.spot[0].amount, 2.5);
        assert_eq!(portfolio.defi.len(), 1);
    }

    #[test]
    fn a_low_confidence_mint_is_rejected() {
        // The scam-airdrop case: a real-looking price at a confidence nobody should trust.
        let held = vec![("ScamMint".to_string(), 1_000_000.0)];
        let prices = HashMap::from([
            priced(SOL_PRICE_KEY, 150.0, 0.99, "SOL"),
            priced("solana:ScamMint", 4.20, 0.4, "FREE"),
        ]);
        let portfolio =
            solana_portfolio_from("solana", 1.0, &held, 0.0, &prices, &HashMap::new()).unwrap();
        assert_eq!(portfolio.spot.len(), 1, "only SOL: {:?}", portfolio.spot);
        assert_eq!(portfolio.usd, 150.0);
    }

    #[test]
    fn the_confidence_boundary_matches_the_shared_gate() {
        let held = vec![("M".to_string(), 100.0)];
        let at_boundary = HashMap::from([priced("solana:M", 1.0, MIN_CONFIDENCE, "OK")]);
        assert_eq!(
            solana_portfolio_from("solana", 0.0, &held, 0.0, &at_boundary, &HashMap::new())
                .unwrap()
                .spot
                .len(),
            1
        );
        let below = HashMap::from([priced("solana:M", 1.0, MIN_CONFIDENCE - 0.01, "OK")]);
        assert!(
            solana_portfolio_from("solana", 0.0, &held, 0.0, &below, &HashMap::new()).is_none()
        );
    }

    #[test]
    fn an_unpriced_mint_is_dropped_rather_than_valued_at_zero() {
        let held = vec![("Unknown".to_string(), 5.0)];
        let prices = HashMap::from([priced(SOL_PRICE_KEY, 150.0, 0.99, "SOL")]);
        let portfolio =
            solana_portfolio_from("solana", 1.0, &held, 0.0, &prices, &HashMap::new()).unwrap();
        assert_eq!(portfolio.spot.len(), 1);
    }

    #[test]
    fn a_priced_mint_with_no_symbol_falls_back_to_a_question_mark() {
        let held = vec![("M".to_string(), 100.0)];
        let prices = HashMap::from([(
            "solana:M".to_string(),
            LlamaPrice {
                price: Some(1.0),
                confidence: Some(0.99),
                symbol: None,
            },
        )]);
        let portfolio =
            solana_portfolio_from("solana", 0.0, &held, 0.0, &prices, &HashMap::new()).unwrap();
        assert_eq!(portfolio.spot[0].symbol, "?");
    }

    #[test]
    fn an_empty_wallet_yields_nothing_rather_than_an_error() {
        // Zero SOL, no tokens, no stake: the chain is simply absent, and nothing panics.
        assert!(
            solana_portfolio_from(
                "solana",
                0.0,
                &Held::new(),
                0.0,
                &sample_prices(),
                &HashMap::new()
            )
            .is_none()
        );
    }

    #[test]
    fn dust_sol_produces_no_row() {
        // 0.00001 SOL at $150 is $0.0015.
        assert!(
            solana_portfolio_from(
                "solana",
                0.000_01,
                &Held::new(),
                0.0,
                &sample_prices(),
                &HashMap::new()
            )
            .is_none()
        );
    }

    #[test]
    fn a_missing_sol_price_does_not_crash_the_read() {
        let held = vec![(USDC_MINT.to_string(), 126.0)];
        let prices = HashMap::from([priced(&format!("solana:{USDC_MINT}"), 1.0, 0.99, "USDC")]);
        let portfolio =
            solana_portfolio_from("solana", 2.5, &held, 5.0, &prices, &HashMap::new()).unwrap();
        assert_eq!(
            portfolio.spot.len(),
            1,
            "SOL has no price, USDC still counts"
        );
        assert_eq!(portfolio.usd, 126.0);
        assert!(
            portfolio.defi.is_empty(),
            "stake cannot be valued without a SOL price"
        );
    }

    // --- replayed fixtures --------------------------------------------------

    #[tokio::test]
    async fn the_full_read_replays_from_fixtures() {
        let cache = fixtures();
        let client = reqwest::Client::new();
        let portfolio = solana_chain_portfolio(
            &client,
            &cache,
            "solana",
            "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        )
        .await
        .unwrap()
        .unwrap();

        // 2.5 SOL @150 + 126 USDC + 2 jitoSOL @180 + 10 staked SOL @150.
        assert_eq!(portfolio.spot.len(), 3);
        assert_eq!(portfolio.defi.len(), 1);
        assert!(
            (portfolio.usd - 2361.0).abs() < 1e-6,
            "got {}",
            portfolio.usd
        );
        assert_eq!(portfolio.spot[0].change24h, Some(-3.75));
    }

    #[tokio::test]
    async fn a_failing_first_rpc_endpoint_falls_through_to_the_second() {
        // The fixture for api.mainnet-beta answers HTTP 429; publicnode answers properly.
        let cache = fixtures();
        let client = reqwest::Client::new();
        let result = sol_rpc(
            &client,
            &cache,
            "getBalance",
            json!(["EmptyWa11etAddressForTesting1111111111111111"]),
        )
        .await
        .expect("the second endpoint must answer");
        assert_eq!(parse_native_balance(&result), 0.0);
    }

    #[tokio::test]
    async fn an_empty_wallet_reads_as_zero_over_the_wire() {
        // End to end: an address with nothing on it must produce no chain entry and no error.
        let cache = fixtures();
        let client = reqwest::Client::new();
        let portfolio = solana_chain_portfolio(
            &client,
            &cache,
            "solana",
            "EmptyWa11etAddressForTesting1111111111111111",
        )
        .await
        .unwrap();
        assert!(portfolio.is_none(), "got {portfolio:?}");
    }
}
