//! Spot holdings from Blockscout — port of `portfolio.py:255-366` (`_rpc_native_balance`,
//! `_get_spot_uncached`, `get_spot`).
//!
//! This is the layer that turns "what does this wallet hold" into "what is it worth", so every
//! decision here moves the net-worth number:
//!
//! * **Filtering order is load-bearing.** Spam is rejected *before* anything is priced; a price is
//!   accepted from Blockscout as-is, or from DefiLlama only above [`MIN_CONFIDENCE`](crate::spam);
//!   and the dust cut runs *last*, on the valued list. Running dust before pricing would keep
//!   worthless-but-numerous tokens, and running the confidence gate after dust would let a scam
//!   token's fake price carry it over the threshold first.
//! * **Decimals come separately from the balance.** Blockscout returns `value` as an integer
//!   string and `decimals` as its own (string!) field. Reading a 6-decimal USDC balance as 18
//!   decimals understates it by 10^12; the reverse inflates net worth by the same factor.
//! * **Blockscout has bad days.** 500s and HTML error bodies degrade to an empty object, so the
//!   native coin still comes from the RPC and one flaky indexer cannot zero a wallet.
//!
//! The pure half ([`parse_tokens`], [`apply_llama_prices`], [`keep_above_dust`],
//! [`apply_changes`], [`spot_from_responses`]) takes already-fetched JSON, so the whole
//! transformation is unit-testable without a network. The networked half ([`Spot`]) only fetches
//! and hands over, and every request goes through [`HttpCache`].

use std::collections::HashMap;

use anyhow::{Context, Result};
use serde_json::{Value, json};

use crate::bitcoin::SpotToken;
use crate::chains::Chain;
use crate::http_cache::HttpCache;
use crate::prices::{Prices, SharedTtlCache};
// The DefiLlama batch endpoints are chain-agnostic, and these parsers are already parity-checked
// for the Solana reader — the EVM path uses the same bytes, so it uses the same parsers.
use crate::solana::{LlamaPrice, parse_llama_changes, parse_llama_prices};
use crate::spam::{TokenInfo, is_spam, price_is_trustworthy};

/// `get_spot` memoises per (chain, address) for this long. Blockscout's token scan is the single
/// biggest cost of a fetch, so a refresh inside the window skips it entirely.
pub const SPOT_TTL_SECS: f64 = 45.0;

/// Default dust cut-off in USD (`dust_usd=0.01`). Comparison is **strictly greater**.
pub const DEFAULT_DUST_USD: f64 = 0.01;

/// Native balances are always 18-decimal wei on the chains with a Blockscout instance.
const WEI_PER_ETHER: f64 = 1e18;

// ===========================================================================
// The pure half
// ===========================================================================

/// A holding before the dust cut, while `price`/`usd` may still be unknown.
///
/// Python threads one mutable dict through pricing, filtering and the change pass; this is that
/// dict, with the unresolved fields honestly typed as `Option`.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub symbol: String,
    pub amount: f64,
    pub price: Option<f64>,
    pub usd: Option<f64>,
    /// `"native"` or `"token"`.
    pub kind: &'static str,
    /// Contract address — absent for the native coin.
    pub address: Option<String>,
    /// DefiLlama key, e.g. `base:0x833…`.
    pub coin: Option<String>,
    pub change24h: Option<f64>,
}

impl Candidate {
    /// Drop to the shared output shape. Only called for holdings that cleared the dust cut, so a
    /// price is present by construction; `0.0` is a defensive default that no kept row reaches.
    pub fn into_spot_token(self) -> SpotToken {
        SpotToken {
            symbol: self.symbol,
            amount: self.amount,
            price: self.price.unwrap_or(0.0),
            usd: self.usd.unwrap_or(0.0),
            change24h: self.change24h,
            kind: self.kind,
            coin: self.coin,
            address: self.address,
        }
    }
}

/// The chain's coin symbol: its configured one, else the Python fallback `chain.upper()[:4]`.
pub fn native_symbol(chain: &Chain) -> String {
    match chain.native {
        Some(native) if !native.symbol.is_empty() => native.symbol.to_string(),
        _ => chain.name.to_uppercase().chars().take(4).collect(),
    }
}

/// The native holding, valued. Not spam-filtered and not confidence-gated: the chain's own coin is
/// never a scam token, and its price comes from Blockscout or DefiLlama directly.
pub fn native_candidate(
    chain: &Chain,
    amount: f64,
    price: f64,
    change24h: Option<f64>,
) -> Candidate {
    Candidate {
        symbol: native_symbol(chain),
        amount,
        price: Some(price),
        usd: Some(amount * price),
        kind: "native",
        address: None,
        coin: chain.native.map(|n| n.price_key.to_string()),
        change24h,
    }
}

/// Blockscout's `/addresses/{a}/tokens?type=ERC-20` body -> candidates, spam already dropped.
///
/// Ordering is Blockscout's own, unchanged: the Python appends in iteration order and a parity
/// diff compares lists.
pub fn parse_tokens(chain: &Chain, tokens_body: &Value) -> Vec<Candidate> {
    let Some(items) = tokens_body.get("items").and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let token = item.get("token")?;
            let symbol = string_field(token, "symbol");
            let name = string_field(token, "name");
            let reputation = string_field(token, "reputation");
            // Layer one, before any pricing: a spam token never reaches a valuation at all.
            if is_spam(&TokenInfo {
                symbol: symbol.as_deref(),
                name: name.as_deref(),
                reputation: reputation.as_deref(),
            }) {
                return None;
            }
            // `address_hash` is what the Python reads; `address` is the same value under the name
            // some Blockscout builds use, taken as a fallback so a rename cannot blank a holding.
            let address =
                string_field(token, "address_hash").or_else(|| string_field(token, "address"))?;
            let amount = raw_value(item.get("value")?)? / 10f64.powi(decimals_of(token) as i32);
            let rate = blockscout_rate(token);
            Some(Candidate {
                symbol: symbol.unwrap_or_default(),
                amount,
                price: rate,
                usd: rate.map(|r| amount * r),
                kind: "token",
                coin: chain.llama.map(|llama| format!("{llama}:{address}")),
                address: Some(address),
                change24h: None,
            })
        })
        .collect()
}

/// DefiLlama keys for the candidates Blockscout could not price, in order.
pub fn missing_price_keys(candidates: &[Candidate]) -> Vec<String> {
    candidates
        .iter()
        .filter(|c| c.price.is_none())
        .filter_map(|c| c.coin.clone())
        .collect()
}

/// Fill in the missing prices — **only** where DefiLlama is confident.
///
/// This is the scam gate: an airdropped token gets a plausible-looking price at a low confidence,
/// and accepting it would add fictional dollars to the total. A rejected price leaves the holding
/// unvalued, which the dust cut then removes.
pub fn apply_llama_prices(candidates: &mut [Candidate], prices: &HashMap<String, LlamaPrice>) {
    for candidate in candidates.iter_mut().filter(|c| c.price.is_none()) {
        let Some(entry) = candidate.coin.as_deref().and_then(|key| prices.get(key)) else {
            continue;
        };
        // Python's `if c.get("price") and confidence >= MIN_CONFIDENCE` — a zero price is falsy
        // there, so it is no price at all here either.
        let Some(price) = entry.price.filter(|p| *p != 0.0) else {
            continue;
        };
        if !price_is_trustworthy(entry.confidence) {
            continue;
        }
        candidate.price = Some(price);
        candidate.usd = Some(candidate.amount * price);
    }
}

/// The dust cut, applied last: keep only holdings worth **strictly more** than `dust_usd`.
///
/// An unpriced holding counts as `$0` (Python's `t["usd"] or 0`), which is how tokens whose price
/// was missing or untrustworthy leave the portfolio.
pub fn keep_above_dust(candidates: Vec<Candidate>, dust_usd: f64) -> Vec<Candidate> {
    candidates
        .into_iter()
        .filter(|c| c.usd.unwrap_or(0.0) > dust_usd)
        .collect()
}

/// Attach 24h changes to the kept ERC-20s from a batch `percentage` response.
///
/// A key with no entry is set to `None` rather than left alone — the Python assigns
/// `chg.get(k)` unconditionally, so a stale value can never survive here.
pub fn apply_changes(kept: &mut [Candidate], changes: &HashMap<String, f64>) {
    for candidate in kept.iter_mut().filter(|c| c.address.is_some()) {
        candidate.change24h = candidate
            .coin
            .as_deref()
            .and_then(|key| changes.get(key).copied());
    }
}

/// DefiLlama keys for the kept ERC-20s — the batch the change call asks for, and what the change
/// cache is seeded with afterwards.
pub fn change_keys(kept: &[Candidate]) -> Vec<String> {
    kept.iter()
        .filter(|c| c.address.is_some())
        .filter_map(|c| c.coin.clone())
        .collect()
}

/// Everything `_get_spot_uncached` needs once the fetching is done. Split out so the whole
/// transformation can be exercised against realistic JSON with no network at all.
#[derive(Debug, Default, Clone)]
pub struct SpotInputs {
    /// `/api/v2/addresses/{address}` body; `{}` when Blockscout failed.
    pub address_body: Value,
    /// `/api/v2/addresses/{address}/tokens?type=ERC-20` body; `{}` when Blockscout failed.
    pub tokens_body: Value,
    /// Native balance from the RPC, used only when Blockscout reports no `coin_balance`.
    pub native_rpc_balance: Option<f64>,
    /// DefiLlama price for the native coin, used when Blockscout has no exchange rate.
    pub native_llama_price: Option<f64>,
    pub native_change: Option<f64>,
    pub llama_prices: HashMap<String, LlamaPrice>,
    pub llama_changes: HashMap<String, f64>,
}

/// Native coin first, then ERC-20s, priced and dust-filtered — everything up to the 24h-change
/// pass, which needs a second network call over exactly this list.
pub fn valued_candidates(chain: &Chain, inputs: &SpotInputs, dust_usd: f64) -> Vec<Candidate> {
    let mut out = Vec::new();

    let (amount, price) = native_reading(inputs);
    if amount * price > dust_usd {
        out.push(native_candidate(chain, amount, price, inputs.native_change));
    }

    let mut tokens = parse_tokens(chain, &inputs.tokens_body);
    apply_llama_prices(&mut tokens, &inputs.llama_prices);
    out.extend(tokens);

    keep_above_dust(out, dust_usd)
}

/// The whole of `_get_spot_uncached` after the I/O: native first, then ERC-20s, in that order.
pub fn spot_from_responses(chain: &Chain, inputs: &SpotInputs, dust_usd: f64) -> Vec<SpotToken> {
    let mut kept = valued_candidates(chain, inputs, dust_usd);
    apply_changes(&mut kept, &inputs.llama_changes);
    kept.into_iter().map(Candidate::into_spot_token).collect()
}

/// Native amount and price from whichever source answered.
///
/// Blockscout's `coin_balance` wins when present; an exchange rate of 0 or absent falls through to
/// DefiLlama, and a missing balance falls through to the RPC reading.
fn native_reading(inputs: &SpotInputs) -> (f64, f64) {
    let coin_balance = inputs
        .address_body
        .get("coin_balance")
        .filter(|v| !v.is_null());
    match coin_balance {
        Some(balance) => {
            let amount = raw_value(balance).unwrap_or(0.0) / WEI_PER_ETHER;
            let rate = as_number(inputs.address_body.get("exchange_rate"))
                .filter(|r| *r != 0.0)
                .or(inputs.native_llama_price)
                .unwrap_or(0.0);
            (amount, rate)
        }
        None => (
            inputs.native_rpc_balance.unwrap_or(0.0),
            inputs.native_llama_price.unwrap_or(0.0),
        ),
    }
}

/// `int(tok.get("decimals") or 18)`.
///
/// Blockscout sends decimals as a **string**, so `"0"` is truthy and means zero decimals, while a
/// JSON `0` is falsy and means "unset" -> 18. Both cases occur in the wild.
fn decimals_of(token: &Value) -> u32 {
    let raw = match token.get("decimals") {
        Some(Value::String(s)) if !s.is_empty() => s.parse::<u32>().unwrap_or(18),
        Some(Value::Number(n)) => match n.as_u64() {
            Some(0) | None => 18,
            Some(d) => d as u32,
        },
        _ => 18,
    };
    // 10^309 is +inf as an f64; clamping keeps a nonsense `decimals` at "amount is ~0" rather
    // than NaN. No real token comes close.
    raw.min(300)
}

/// A balance as Blockscout sends it: an integer string (arbitrarily large), or occasionally a
/// JSON number.
///
/// Parsed straight to `f64`. Python divides two exact integers and rounds once; this rounds the
/// numerator too, for a worst case of one extra ULP — around `$1e-9` on a `$10M` holding, far
/// below any threshold that decides anything.
fn raw_value(value: &Value) -> Option<f64> {
    match value {
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Blockscout's `exchange_rate`, honouring Python's truthiness: an absent, null or empty rate is
/// "no price" (so DefiLlama is asked), while the string `"0"` is a *stated* price of zero — the
/// token stays unpriced-but-answered and is never sent to DefiLlama.
fn blockscout_rate(token: &Value) -> Option<f64> {
    match token.get("exchange_rate") {
        Some(Value::String(s)) if !s.is_empty() => Some(s.trim().parse::<f64>().unwrap_or(0.0)),
        Some(Value::Number(n)) => n.as_f64().filter(|v| *v != 0.0),
        _ => None,
    }
}

fn as_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::String(s) => s.trim().parse().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_string)
}

// ===========================================================================
// The networked half
// ===========================================================================

/// Blockscout + DefiLlama access for spot balances, with Python's 45s per-wallet cache.
#[derive(Debug)]
pub struct Spot {
    prices: std::sync::Arc<Prices>,
    cached: SharedTtlCache<Vec<SpotToken>>,
}

impl Spot {
    pub fn new(prices: std::sync::Arc<Prices>) -> Self {
        Self {
            prices,
            cached: SharedTtlCache::new(),
        }
    }

    pub fn prices(&self) -> &Prices {
        &self.prices
    }

    fn client(&self) -> &reqwest::Client {
        self.prices.client()
    }

    fn http(&self) -> &HttpCache {
        self.prices.http_cache()
    }

    /// Port of `get_spot`: cached ~45s per (chain, address). **Errors are not cached** — a failed
    /// read must be retried, not remembered for 45 seconds.
    ///
    /// The key omits `dust_usd`, exactly as Python's does: a second call with a different cut-off
    /// inside the window is served the first call's list.
    pub async fn get_spot(
        &self,
        chain: &Chain,
        address: &str,
        dust_usd: f64,
    ) -> Result<Vec<SpotToken>> {
        let key = format!("spot:{}:{}", chain.name, address.to_lowercase());
        if let Some(hit) = self.cached.get(&key, SPOT_TTL_SECS, self.prices.now()) {
            return Ok(hit);
        }
        let fresh = self.get_spot_uncached(chain, address, dust_usd).await?;
        self.cached.put(&key, fresh.clone(), self.prices.now());
        Ok(fresh)
    }

    /// Port of `_get_spot_uncached`.
    pub async fn get_spot_uncached(
        &self,
        chain: &Chain,
        address: &str,
        dust_usd: f64,
    ) -> Result<Vec<SpotToken>> {
        let native_key = chain.native.map(|n| n.price_key).unwrap_or("");

        // A chain with no Blockscout instance reports its native coin only.
        let Some(base) = chain.blockscout else {
            let amount = self.rpc_native_balance(chain, address).await?;
            let price = self.prices.llama_key_price(native_key).await.unwrap_or(0.0);
            if amount * price <= dust_usd {
                return Ok(Vec::new());
            }
            let change = self.prices.key_change(native_key).await;
            return Ok(vec![
                native_candidate(chain, amount, price, change).into_spot_token(),
            ]);
        };

        // Both calls hit the same indexer and are independent, so they go out together rather than
        // paying two round trips in series (Python uses a two-worker thread pool here).
        let summary_url = format!("{base}/api/v2/addresses/{address}");
        let tokens_url = format!("{base}/api/v2/addresses/{address}/tokens?type=ERC-20");
        let (address_body, tokens_body) = tokio::join!(
            self.blockscout_get(&summary_url),
            self.blockscout_get(&tokens_url),
        );

        // Native: Blockscout's balance and rate when it answered, else the RPC and DefiLlama.
        let has_coin_balance = address_body
            .get("coin_balance")
            .is_some_and(|v| !v.is_null());
        let needs_llama_price = !has_coin_balance
            || as_number(address_body.get("exchange_rate")).is_none_or(|r| r == 0.0);
        let mut inputs = SpotInputs {
            address_body,
            tokens_body,
            native_rpc_balance: None,
            native_llama_price: if needs_llama_price {
                self.prices.llama_key_price(native_key).await
            } else {
                None
            },
            native_change: None,
            llama_prices: HashMap::new(),
            llama_changes: HashMap::new(),
        };
        if !has_coin_balance {
            inputs.native_rpc_balance = Some(self.rpc_native_balance(chain, address).await?);
        }
        let (native_amount, native_price) = native_reading(&inputs);
        if native_amount * native_price > dust_usd {
            inputs.native_change = self.prices.key_change(native_key).await;
        }

        // The indexer listed nothing. That is normal for a chain with no Blockscout at all, and
        // it is *also* what a dead instance looks like — hyperscan started 404ing every address
        // endpoint, and HyperEVM spot silently became "the native coin only". Where the chain
        // names fallback tokens, read those over RPC before giving up on them.
        let mut fallback = Vec::new();
        if inputs.tokens_body.get("items").and_then(Value::as_array).is_none_or(|i| i.is_empty())
            && !chain.spot_fallback.is_empty()
        {
            fallback = self.rpc_fallback_spot(chain, address, dust_usd).await;
        }

        // Prices for whatever Blockscout could not price.
        let missing = missing_price_keys(&parse_tokens(chain, &inputs.tokens_body));
        if !missing.is_empty() {
            inputs.llama_prices = self.llama_prices(&missing).await;
        }

        // 24h changes for what actually survives, then seed the change cache from the same batch.
        let mut kept = valued_candidates(chain, &inputs, dust_usd);
        // Appended after valuation because these arrive already priced, and deduped by symbol so
        // a recovering indexer never yields the same token twice.
        for token in fallback {
            if !kept.iter().any(|c| c.symbol.eq_ignore_ascii_case(&token.symbol)) {
                kept.push(token);
            }
        }
        let keys = change_keys(&kept);
        if !keys.is_empty() {
            let changes = self.llama_changes(&keys).await;
            apply_changes(&mut kept, &changes);
            for key in keys {
                let value = changes.get(&key).copied();
                self.prices.seed_change(&key, value);
            }
        }
        Ok(kept.into_iter().map(Candidate::into_spot_token).collect())
    }

    /// A Blockscout GET reduced to a JSON object. A non-200, a non-JSON body (their error pages are
    /// HTML) or a JSON array all degrade to `{}` — a flaky indexer must not take the chain down.
    async fn blockscout_get(&self, url: &str) -> Value {
        let recorded = match self.http().get(self.client(), url).await {
            Ok(recorded) => recorded,
            Err(error) => {
                tracing::warn!(
                    url,
                    error = format!("{error:#}"),
                    "blockscout request failed"
                );
                return json!({});
            }
        };
        if !(200..300).contains(&recorded.status) {
            tracing::warn!(
                url,
                status = recorded.status,
                "blockscout returned an error"
            );
            return json!({});
        }
        match serde_json::from_str::<Value>(&recorded.body) {
            Ok(value) if value.is_object() => value,
            _ => json!({}),
        }
    }

    /// The tokens a chain names, read straight from its RPC.
    ///
    /// One `eth_call` per token — `balanceOf(address)`. This can only ever confirm holdings of
    /// tokens someone thought to list, which is why it is a fallback and not the primary path: an
    /// indexer enumerates what you hold, an RPC answers about what you ask for.
    ///
    /// Failures are per-token and silent-but-logged. A dead RPC should leave the chain reporting
    /// its native coin, exactly as it did before this existed, rather than failing the whole read.
    async fn rpc_fallback_spot(
        &self,
        chain: &Chain,
        address: &str,
        dust_usd: f64,
    ) -> Vec<Candidate> {
        let Some(rpc) = chain.rpc else {
            return Vec::new();
        };
        let keys: Vec<String> = chain
            .spot_fallback
            .iter()
            .map(|t| t.price_key.to_string())
            .collect();
        let prices = self.llama_prices(&keys).await;

        let mut out = Vec::new();
        for token in chain.spot_fallback {
            let Some(amount) = self.erc20_balance(rpc, token, address).await else {
                continue;
            };
            if amount <= 0.0 {
                continue;
            }
            let price = prices.get(token.price_key).and_then(|p| p.price);
            let usd = price.map(|p| amount * p);
            // The same dust cut every other holding gets — a fallback should not be the one path
            // that floods the ledger with sub-dollar remnants.
            if usd.is_none_or(|v| v <= dust_usd) {
                continue;
            }
            out.push(Candidate {
                symbol: token.symbol.to_string(),
                amount,
                price,
                usd,
                kind: "token",
                address: Some(token.address.to_string()),
                coin: Some(token.price_key.to_string()),
                change24h: None,
            });
        }
        if !out.is_empty() {
            tracing::info!(
                chain = chain.name,
                count = out.len(),
                "read spot balances over RPC; the indexer listed nothing"
            );
        }
        out
    }

    /// `balanceOf(address)` for one ERC-20. `None` on any failure, which the caller skips.
    async fn erc20_balance(
        &self,
        rpc: &str,
        token: &crate::chains::FallbackToken,
        address: &str,
    ) -> Option<f64> {
        // `balanceOf(address)` — selector, then the address left-padded to 32 bytes.
        let data = format!("0x70a08231000000000000000000000000{}", address.trim_start_matches("0x"));
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{ "to": token.address, "data": data }, "latest"],
        });
        let recorded = match self.http().post_json(self.client(), rpc, &body).await {
            Ok(recorded) => recorded,
            Err(error) => {
                tracing::warn!(symbol = token.symbol, error = format!("{error:#}"), "balanceOf failed");
                return None;
            }
        };
        let json: Value = serde_json::from_str(&recorded.body).ok()?;
        let raw = json.get("result").and_then(Value::as_str)?;
        let raw = raw.trim_start_matches("0x");
        // An empty `0x` is a call to a contract that is not there — not a zero balance.
        if raw.is_empty() {
            return None;
        }
        let units = u128::from_str_radix(raw, 16).ok()?;
        Some(units as f64 / 10f64.powi(token.decimals as i32))
    }

    /// Port of `_rpc_native_balance`. Unlike the Blockscout calls this one **propagates** its
    /// error: it is the last source of the native balance, and reporting `0` for an unreadable
    /// wallet would silently delete its coins from the total.
    pub async fn rpc_native_balance(&self, chain: &Chain, address: &str) -> Result<f64> {
        let rpc = chain
            .rpc
            .with_context(|| format!("chain {} has no rpc endpoint", chain.name))?;
        let body = json!({
            "jsonrpc": "2.0", "id": 1, "method": "eth_getBalance",
            "params": [address, "latest"],
        });
        let recorded = self.http().post_json(self.client(), rpc, &body).await?;
        let json: Value = serde_json::from_str(&recorded.body)
            .with_context(|| format!("eth_getBalance on {} returned non-JSON", chain.name))?;
        let result = json
            .get("result")
            .and_then(Value::as_str)
            .with_context(|| format!("eth_getBalance on {} returned no result", chain.name))?;
        let wei = u128::from_str_radix(result.trim_start_matches("0x"), 16)
            .with_context(|| format!("eth_getBalance returned {result}"))?;
        Ok(wei as f64 / WEI_PER_ETHER)
    }

    async fn llama_prices(&self, keys: &[String]) -> HashMap<String, LlamaPrice> {
        let url = format!("https://coins.llama.fi/prices/current/{}", keys.join(","));
        match self.http().get(self.client(), &url).await {
            Ok(recorded) => parse_llama_prices(&recorded.body),
            Err(error) => {
                tracing::warn!(error = format!("{error:#}"), "defillama prices failed");
                HashMap::new()
            }
        }
    }

    async fn llama_changes(&self, keys: &[String]) -> HashMap<String, f64> {
        let url = format!(
            "https://coins.llama.fi/percentage/{}?period=24h",
            keys.join(",")
        );
        match self.http().get(self.client(), &url).await {
            Ok(recorded) => parse_llama_changes(&recorded.body),
            Err(error) => {
                tracing::warn!(error = format!("{error:#}"), "defillama changes failed");
                HashMap::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains;
    use crate::http_cache::Mode;
    use crate::prices::{ManualClock, PRICE_TTL_SECS};
    use std::path::PathBuf;
    use std::sync::Arc;

    /// A Blockscout token page shaped exactly like the live one (string `decimals`, string
    /// `value`, string `exchange_rate`, `reputation`), carrying one of each case that matters:
    ///
    /// * WETH — 18 decimals, priced by Blockscout.
    /// * USDC — **6** decimals, priced by Blockscout. The decimals trap.
    /// * FREEBIE — spam by name, and priced high enough to matter if it ever survived.
    /// * SCAMCOIN — flagged `reputation: "spam"` by Blockscout itself.
    /// * GHOST — unpriced by Blockscout; DefiLlama answers with a *low-confidence* price.
    /// * REALTOKEN — unpriced by Blockscout; DefiLlama answers confidently.
    /// * CRUMB — real and confidently priced, but worth less than a cent.
    const TOKENS_BODY: &str = r#"{
      "items": [
        {"value": "2500000000000000000",
         "token": {"address_hash": "0x4200000000000000000000000000000000000006",
                   "symbol": "WETH", "name": "Wrapped Ether", "decimals": "18",
                   "exchange_rate": "2000.0", "reputation": "ok", "type": "ERC-20"}},
        {"value": "1234560000",
         "token": {"address_hash": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                   "symbol": "USDC", "name": "USD Coin", "decimals": "6",
                   "exchange_rate": "1.0", "reputation": "ok", "type": "ERC-20"}},
        {"value": "1000000000000000000000",
         "token": {"address_hash": "0x00000000000000000000000000000000deadbeef",
                   "symbol": "FREEBIE", "name": "Claim 5000 USDC at claim-me.xyz",
                   "decimals": "18", "exchange_rate": "12.5", "reputation": "ok",
                   "type": "ERC-20"}},
        {"value": "5000000000000000000000",
         "token": {"address_hash": "0x00000000000000000000000000000000badc0de0",
                   "symbol": "SCAMCOIN", "name": "Totally Normal Token", "decimals": "18",
                   "exchange_rate": "9.99", "reputation": "spam", "type": "ERC-20"}},
        {"value": "8000000000000000000000",
         "token": {"address_hash": "0x00000000000000000000000000000000600570ff",
                   "symbol": "GHOST", "name": "Ghost Token", "decimals": "18",
                   "exchange_rate": null, "reputation": "ok", "type": "ERC-20"}},
        {"value": "3000000000000000000",
         "token": {"address_hash": "0x0000000000000000000000000000000000005eal",
                   "symbol": "REALTOKEN", "name": "Real Token", "decimals": "18",
                   "exchange_rate": null, "reputation": "ok", "type": "ERC-20"}},
        {"value": "1000000000000000",
         "token": {"address_hash": "0x00000000000000000000000000000000c2u3b100",
                   "symbol": "CRUMB", "name": "Crumb", "decimals": "18",
                   "exchange_rate": "1.0", "reputation": "ok", "type": "ERC-20"}}
      ],
      "next_page_params": null
    }"#;

    const ADDRESS_BODY: &str = r#"{
      "hash": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      "coin_balance": "6635339380601433797",
      "exchange_rate": "2000.0",
      "is_contract": false
    }"#;

    fn v(raw: &str) -> Value {
        serde_json::from_str(raw).expect("sample payload must be valid JSON")
    }

    fn base() -> &'static Chain {
        chains::by_name("base").expect("base is configured")
    }

    fn price(price: f64, confidence: f64) -> LlamaPrice {
        LlamaPrice {
            price: Some(price),
            confidence: Some(confidence),
            symbol: None,
        }
    }

    /// DefiLlama's answer for the two tokens Blockscout could not price: GHOST is the scam shape
    /// (a real-looking price at 0.5 confidence), REALTOKEN is genuine.
    fn llama_prices() -> HashMap<String, LlamaPrice> {
        HashMap::from([
            (
                "base:0x00000000000000000000000000000000600570ff".to_string(),
                price(3.75, 0.5),
            ),
            (
                "base:0x0000000000000000000000000000000000005eal".to_string(),
                price(10.0, 0.99),
            ),
        ])
    }

    fn inputs() -> SpotInputs {
        SpotInputs {
            address_body: v(ADDRESS_BODY),
            tokens_body: v(TOKENS_BODY),
            llama_prices: llama_prices(),
            ..SpotInputs::default()
        }
    }

    fn by_symbol<'a>(spot: &'a [SpotToken], symbol: &str) -> Option<&'a SpotToken> {
        spot.iter().find(|t| t.symbol == symbol)
    }

    // ------------------------------------------------------------- the whole transformation

    #[test]
    fn a_realistic_page_yields_exactly_the_holdings_that_count() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        let symbols: Vec<&str> = spot.iter().map(|t| t.symbol.as_str()).collect();
        assert_eq!(
            symbols,
            vec!["ETH", "WETH", "USDC", "REALTOKEN"],
            "native first, then Blockscout's order; spam, low-confidence and dust all gone"
        );
    }

    #[test]
    fn a_six_decimal_token_is_valued_at_its_face_amount() {
        // The 10^12 error: 1234560000 raw units of a 6-decimal token is 1234.56 USDC, not
        // 0.00000123 — and at $1 that is the difference between $1,234 and nothing.
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        let usdc = by_symbol(&spot, "USDC").expect("USDC is kept");
        assert!(
            (usdc.amount - 1234.56).abs() < 1e-9,
            "got {} tokens",
            usdc.amount
        );
        assert!((usdc.usd - 1234.56).abs() < 1e-9, "got ${}", usdc.usd);
    }

    #[test]
    fn an_eighteen_decimal_token_is_valued_at_its_face_amount() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        let weth = by_symbol(&spot, "WETH").expect("WETH is kept");
        assert!((weth.amount - 2.5).abs() < 1e-12, "got {}", weth.amount);
        assert!((weth.usd - 5000.0).abs() < 1e-9, "got ${}", weth.usd);
    }

    #[test]
    fn spam_is_dropped_however_it_is_flagged() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        assert!(
            by_symbol(&spot, "FREEBIE").is_none(),
            "a claim-link name is spam even though Blockscout priced it at $12.50"
        );
        assert!(
            by_symbol(&spot, "SCAMCOIN").is_none(),
            "Blockscout's own `reputation: spam` is honoured"
        );
        let total: f64 = spot.iter().map(|t| t.usd).sum();
        assert!(
            total < 60_000.0,
            "the two spam tokens would have added ~$62k, got ${total}"
        );
    }

    #[test]
    fn a_low_confidence_price_never_becomes_dollars() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        assert!(
            by_symbol(&spot, "GHOST").is_none(),
            "8000 tokens at a 0.5-confidence $3.75 is $30k of fiction"
        );
        assert!(
            by_symbol(&spot, "REALTOKEN").is_some(),
            "the same shape at 0.99 confidence is kept"
        );
    }

    #[test]
    fn a_confident_llama_price_is_applied_to_the_amount_not_the_raw_value() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        let real = by_symbol(&spot, "REALTOKEN").expect("kept");
        assert!((real.amount - 3.0).abs() < 1e-12);
        assert!((real.usd - 30.0).abs() < 1e-9, "3 tokens at $10");
        assert_eq!(real.price, 10.0);
    }

    #[test]
    fn dust_is_filtered_strictly_above_the_threshold() {
        // CRUMB is 0.001 tokens at $1 = $0.001, under the cent.
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        assert!(by_symbol(&spot, "CRUMB").is_none());

        // Raising the cut-off removes more; the comparison is `> dust`, so a holding worth exactly
        // the threshold is dropped.
        let coarse = spot_from_responses(base(), &inputs(), 2_000.0);
        assert_eq!(
            coarse.iter().map(|t| t.symbol.as_str()).collect::<Vec<_>>(),
            vec!["ETH", "WETH"],
            "$13,270 ETH and $5,000 WETH clear $2,000; $1,234 USDC does not"
        );
    }

    #[test]
    fn a_holding_worth_exactly_the_dust_threshold_is_dropped() {
        let body = json!({"items": [{"value": "10000000000000000", "token": {
            "address_hash": "0xexact", "symbol": "EXACT", "name": "Exact",
            "decimals": "18", "exchange_rate": "1.0"}}]});
        let spot = spot_from_responses(
            base(),
            &SpotInputs {
                tokens_body: body,
                ..SpotInputs::default()
            },
            DEFAULT_DUST_USD,
        );
        assert!(
            spot.is_empty(),
            "0.01 tokens at $1 is exactly $0.01, not more"
        );
    }

    // ------------------------------------------------------------- filtering *order*

    #[test]
    fn spam_is_rejected_before_it_is_ever_priced() {
        // A spam token is not even offered to DefiLlama: it never reaches `missing`.
        let tokens = parse_tokens(base(), &v(TOKENS_BODY));
        assert!(
            !tokens
                .iter()
                .any(|c| c.symbol == "FREEBIE" || c.symbol == "SCAMCOIN"),
            "spam is gone before pricing, so no key is ever requested for it"
        );
        assert_eq!(
            missing_price_keys(&tokens),
            vec![
                "base:0x00000000000000000000000000000000600570ff".to_string(),
                "base:0x0000000000000000000000000000000000005eal".to_string(),
            ],
            "only the two Blockscout could not price"
        );
    }

    #[test]
    fn the_confidence_gate_runs_before_the_dust_cut() {
        // GHOST would clear any sane dust threshold on its fake price. Ordering the two the other
        // way round would keep it.
        let mut tokens = parse_tokens(base(), &v(TOKENS_BODY));
        apply_llama_prices(&mut tokens, &llama_prices());
        let ghost = tokens
            .iter()
            .find(|c| c.symbol == "GHOST")
            .expect("still a candidate");
        assert_eq!(ghost.price, None, "rejected outright, not devalued");
        assert_eq!(ghost.usd, None);
        assert!(
            keep_above_dust(tokens, DEFAULT_DUST_USD)
                .iter()
                .all(|c| c.symbol != "GHOST")
        );
    }

    #[test]
    fn an_unpriced_token_counts_as_zero_dollars_not_as_missing_data() {
        let mut tokens = parse_tokens(base(), &v(TOKENS_BODY));
        apply_llama_prices(&mut tokens, &HashMap::new()); // DefiLlama down entirely
        let kept: Vec<String> = keep_above_dust(tokens, DEFAULT_DUST_USD)
            .into_iter()
            .map(|c| c.symbol)
            .collect();
        assert_eq!(
            kept,
            vec!["WETH".to_string(), "USDC".to_string()],
            "a dead price feed removes tokens from the total rather than guessing"
        );
    }

    // ------------------------------------------------------------- parsing details

    #[test]
    fn decimals_default_to_eighteen_only_when_unset() {
        assert_eq!(decimals_of(&json!({"decimals": "6"})), 6);
        assert_eq!(
            decimals_of(&json!({"decimals": "0"})),
            0,
            "the string is truthy"
        );
        assert_eq!(
            decimals_of(&json!({"decimals": 0})),
            18,
            "a JSON 0 is falsy"
        );
        assert_eq!(decimals_of(&json!({"decimals": null})), 18);
        assert_eq!(decimals_of(&json!({})), 18);
        assert_eq!(decimals_of(&json!({"decimals": "junk"})), 18);
    }

    #[test]
    fn a_zero_decimal_token_keeps_its_whole_units() {
        let body = json!({"items": [{"value": "42", "token": {
            "address_hash": "0xnft", "symbol": "WHOLE", "name": "Whole Units",
            "decimals": "0", "exchange_rate": "3.0"}}]});
        let tokens = parse_tokens(base(), &body);
        assert_eq!(tokens[0].amount, 42.0);
        assert_eq!(tokens[0].usd, Some(126.0));
    }

    #[test]
    fn a_stated_zero_exchange_rate_is_not_a_missing_price() {
        // Blockscout answering "0" is an answer: Python's `float(rate) if rate else None` keeps
        // it, so the token is never sent to DefiLlama and simply falls out at the dust cut.
        let body = json!({"items": [{"value": "1000000000000000000", "token": {
            "address_hash": "0xzero", "symbol": "ZERO", "name": "Zero Rate",
            "decimals": "18", "exchange_rate": "0"}}]});
        let tokens = parse_tokens(base(), &body);
        assert_eq!(tokens[0].price, Some(0.0));
        assert!(
            missing_price_keys(&tokens).is_empty(),
            "not asked of DefiLlama"
        );
        assert!(keep_above_dust(tokens, DEFAULT_DUST_USD).is_empty());
    }

    #[test]
    fn a_token_carries_its_defillama_key() {
        let tokens = parse_tokens(base(), &v(TOKENS_BODY));
        assert_eq!(
            tokens[0].coin.as_deref(),
            Some("base:0x4200000000000000000000000000000000000006"),
            "chain-prefixed, address casing preserved"
        );
        assert_eq!(tokens[0].kind, "token");
    }

    #[test]
    fn a_broken_token_page_is_empty_rather_than_fatal() {
        assert!(parse_tokens(base(), &json!({})).is_empty());
        assert!(parse_tokens(base(), &json!({"items": null})).is_empty());
        assert!(parse_tokens(base(), &json!({"items": [{"no_token": 1}]})).is_empty());
        assert!(parse_tokens(base(), &json!({"items": [{"token": {}}]})).is_empty());
    }

    #[test]
    fn a_huge_balance_survives_the_parse() {
        // 10^28 raw units — past u64, and the sort of supply a meme token really reports.
        let body = json!({"items": [{"value": "10000000000000000000000000000", "token": {
            "address_hash": "0xbig", "symbol": "BIG", "name": "Big Supply",
            "decimals": "18", "exchange_rate": "0.0000386"}}]});
        let tokens = parse_tokens(base(), &body);
        assert!((tokens[0].amount - 1e10).abs() / 1e10 < 1e-12);
        assert!((tokens[0].usd.unwrap() - 386_000.0).abs() < 1.0);
    }

    // ------------------------------------------------------------- native coin

    #[test]
    fn the_native_coin_uses_blockscouts_balance_and_rate() {
        let spot = spot_from_responses(base(), &inputs(), DEFAULT_DUST_USD);
        let eth = by_symbol(&spot, "ETH").expect("native is present");
        assert_eq!(eth.kind, "native");
        assert!(
            (eth.amount - 6.635339380601434).abs() < 1e-12,
            "{}",
            eth.amount
        );
        assert!((eth.usd - eth.amount * 2000.0).abs() < 1e-9);
        assert_eq!(eth.address, None, "the native coin has no contract");
        assert_eq!(eth.coin.as_deref(), Some("coingecko:ethereum"));
    }

    #[test]
    fn a_missing_exchange_rate_falls_through_to_defillama() {
        let inputs = SpotInputs {
            address_body: json!({"coin_balance": "1000000000000000000", "exchange_rate": "0"}),
            native_llama_price: Some(3_000.0),
            ..SpotInputs::default()
        };
        let spot = spot_from_responses(base(), &inputs, DEFAULT_DUST_USD);
        assert_eq!(spot[0].price, 3_000.0, "a zero rate is no rate");
        assert_eq!(spot[0].usd, 3_000.0);
    }

    #[test]
    fn a_dead_blockscout_falls_back_to_the_rpc_balance() {
        let inputs = SpotInputs {
            address_body: json!({}), // what `_bsget` degrades a 500 to
            tokens_body: json!({}),
            native_rpc_balance: Some(2.0),
            native_llama_price: Some(1_500.0),
            ..SpotInputs::default()
        };
        let spot = spot_from_responses(base(), &inputs, DEFAULT_DUST_USD);
        assert_eq!(spot.len(), 1, "native only — no token list to read");
        assert_eq!(spot[0].usd, 3_000.0);
    }

    #[test]
    fn an_unpriceable_native_coin_is_dropped_rather_than_shown_at_zero() {
        let inputs = SpotInputs {
            address_body: json!({"coin_balance": "1000000000000000000"}),
            ..SpotInputs::default()
        };
        assert!(spot_from_responses(base(), &inputs, DEFAULT_DUST_USD).is_empty());
    }

    #[test]
    fn the_native_symbol_falls_back_to_the_chain_name() {
        assert_eq!(native_symbol(base()), "ETH");
        let nameless = Chain {
            native: None,
            ..*base()
        };
        assert_eq!(
            native_symbol(&nameless),
            "BASE",
            "Python's `chain.upper()[:4]`"
        );
    }

    // ------------------------------------------------------------- 24h change

    #[test]
    fn changes_attach_by_defillama_key_and_only_to_tokens() {
        let mut kept = parse_tokens(base(), &v(TOKENS_BODY));
        kept.insert(0, native_candidate(base(), 1.0, 2_000.0, Some(1.5)));
        let changes = HashMap::from([(
            "base:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913".to_string(),
            -0.02,
        )]);
        apply_changes(&mut kept, &changes);

        assert_eq!(
            kept[0].change24h,
            Some(1.5),
            "the native change is untouched"
        );
        let usdc = kept.iter().find(|c| c.symbol == "USDC").unwrap();
        assert_eq!(usdc.change24h, Some(-0.02));
        let weth = kept.iter().find(|c| c.symbol == "WETH").unwrap();
        assert_eq!(
            weth.change24h, None,
            "no entry means no change, not a stale one"
        );
    }

    #[test]
    fn change_keys_cover_every_kept_token() {
        let mut kept = parse_tokens(base(), &v(TOKENS_BODY));
        kept.insert(0, native_candidate(base(), 1.0, 2_000.0, None));
        let keys = change_keys(&kept);
        assert_eq!(
            keys.len(),
            5,
            "the five non-spam tokens, not the native coin"
        );
        assert!(keys.iter().all(|k| k.starts_with("base:")));
    }

    // ------------------------------------------------------------- caching

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        // `LYRA_HTTP_CACHE=record` re-records these; every other run replays.
        let mode = if Mode::from_env() == Mode::Record {
            Mode::Record
        } else {
            Mode::Replay
        };
        HttpCache::new(dir, mode)
    }

    fn spot_at(now: f64) -> (Spot, Arc<ManualClock>) {
        let clock = Arc::new(ManualClock::new(now));
        let prices = Arc::new(Prices::with_clock(
            reqwest::Client::new(),
            fixtures(),
            clock.clone(),
        ));
        (Spot::new(prices), clock)
    }

    /// Vitalik's Ethereum wallet, recorded with `LYRA_HTTP_CACHE=record`.
    const RECORDED_WALLET: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

    #[tokio::test]
    async fn a_recorded_ethereum_wallet_replays_offline() {
        let (spot, _clock) = spot_at(1_000.0);
        let chain = chains::by_name("ethereum").unwrap();
        let holdings = spot
            .get_spot(chain, RECORDED_WALLET, DEFAULT_DUST_USD)
            .await
            .expect("the recorded responses are enough to value the wallet");

        assert!(!holdings.is_empty(), "a funded wallet reports holdings");
        assert_eq!(holdings[0].kind, "native", "the native coin leads");
        assert_eq!(holdings[0].symbol, "ETH");
        for holding in &holdings {
            assert!(
                holding.usd > DEFAULT_DUST_USD,
                "{} is below dust at ${}",
                holding.symbol,
                holding.usd
            );
            assert!(
                !is_spam(&TokenInfo {
                    symbol: Some(&holding.symbol),
                    name: None,
                    reputation: None,
                }),
                "{} should have been filtered as spam",
                holding.symbol
            );
            assert!(
                holding.price > 0.0,
                "{} kept without a price",
                holding.symbol
            );
        }
    }

    #[tokio::test]
    async fn a_second_read_inside_the_window_is_served_from_cache() {
        // The cache hit is *proved* by the third call: fixtures are keyed on the exact URL, and
        // nothing was recorded for the lower-cased address. A real fetch for it would miss every
        // fixture, fall through to the RPC and fail — so an `Ok` identical to the first read can
        // only have come from the `spot:{chain}:{address.lower()}` entry.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let prices = Arc::new(Prices::with_clock(
            reqwest::Client::new(),
            fixtures(),
            clock.clone(),
        ));
        let spot = Spot::new(prices);
        let chain = chains::by_name("ethereum").unwrap();

        let first = spot
            .get_spot(chain, RECORDED_WALLET, DEFAULT_DUST_USD)
            .await
            .unwrap();

        clock.advance(SPOT_TTL_SECS - 1.0);
        let second = spot
            .get_spot(chain, RECORDED_WALLET, DEFAULT_DUST_USD)
            .await
            .unwrap();
        assert_eq!(
            first, second,
            "44s in, the cached list is returned verbatim"
        );

        // The key is case-insensitive on the address, as Python's `address.lower()` makes it.
        let lowercased = spot
            .get_spot(chain, &RECORDED_WALLET.to_lowercase(), DEFAULT_DUST_USD)
            .await
            .unwrap();
        assert_eq!(first, lowercased);
    }

    #[tokio::test]
    async fn the_spot_read_seeds_the_change_cache() {
        let (spot, _clock) = spot_at(1_000.0);
        let chain = chains::by_name("ethereum").unwrap();
        let holdings = spot
            .get_spot(chain, RECORDED_WALLET, DEFAULT_DUST_USD)
            .await
            .unwrap();

        let token = holdings
            .iter()
            .find(|h| h.address.is_some())
            .expect("the recorded wallet holds at least one ERC-20");
        let key = token.coin.as_deref().expect("a kept token has a llama key");
        assert!(
            spot.prices().cached_change(key).is_some(),
            "the batch change call must fill the cache a later single lookup would use"
        );
    }

    #[tokio::test]
    async fn an_unreadable_native_balance_is_an_error_not_an_empty_wallet() {
        // Replay with no fixtures at all: the RPC read fails, and that failure propagates rather
        // than being reported as an empty (i.e. worthless) wallet.
        let clock = Arc::new(ManualClock::new(0.0));
        let empty = HttpCache::new(std::env::temp_dir().join("lyra-no-fixtures"), Mode::Replay);
        let prices = Arc::new(Prices::with_clock(reqwest::Client::new(), empty, clock));
        let spot = Spot::new(prices);
        let chain = Chain {
            blockscout: None,
            ..*chains::by_name("ethereum").unwrap()
        };
        assert!(
            spot.get_spot(&chain, RECORDED_WALLET, DEFAULT_DUST_USD)
                .await
                .is_err(),
            "an unreadable native balance is an error, never a zero"
        );
    }

    #[test]
    fn the_ttl_constants_match_python() {
        assert_eq!(SPOT_TTL_SECS, 45.0);
        assert_eq!(PRICE_TTL_SECS, 75.0);
        assert_eq!(DEFAULT_DUST_USD, crate::bitcoin::DUST_USD);
    }
}
