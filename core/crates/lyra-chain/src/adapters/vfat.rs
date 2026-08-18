//! vfat.io — Sickle owner resolution + the farm-balances API adapter.
//!
//! Port of `portfolio.py`: `VFAT_FACTORY`/`vfat_sickle`/`resolve_owners` (L510-536),
//! `_vfat_farm_balances` (L957-992), `_vfat_pending_rewards`/`_vfat_api_position`/
//! `_vfat_stamp_meta` (L1150-1273) and `adapt_vfat_api` (L1441-1460).
//!
//! Two things here are silent when they go wrong, which is why they carry the weight of this
//! module:
//!
//! * **Sickle proxies.** vfat parks a user's LP NFTs inside a per-user CREATE2 proxy, so the NFT
//!   is owned by the *proxy*, not the wallet. An adapter that enumerates only the wallet address
//!   finds nothing and reports nothing — no error, no empty-state, the position simply is not
//!   there. [`resolve_owners`] is the shared answer: every NFT-enumerating adapter scans the list
//!   it returns, which is the wallet *and* its Sickle.
//! * **The last-good cache.** vfat's farm-balances endpoint is intermittently unresponsive while
//!   the rest of their API stays up, and for `vfat_api` chains (HyperEVM) it is the *only* source
//!   of LP positions. A failed refetch therefore serves the previous response for up to
//!   [`LAST_GOOD_MAX_AGE_SECS`] rather than returning nothing: "your positions are an hour stale"
//!   is recoverable, "your positions vanished" is not.
//!
//! Deliberately **not** ported here: `_merkl_rewards` / `_attach_campaign_rewards` (off-chain
//! campaign rewards) and `_vfat_stamp_lifecycle` (per-position `sickle-nft-actions` calls). Both
//! are separate network concerns layered on top of these positions; [`sickle_addresses`] exposes
//! the input the Merkl step needs so it can be added without reshaping this module.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::JoinSet;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::abi::{Address, Value as AbiValue};
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt};
use crate::http_cache::HttpCache;
use crate::lp_math::{blend_change, lp_range};
use crate::model::{Position, PriceBand, RangePct, TokenAmt};
use crate::prices::{Clock, SharedTtlCache, SystemClock};

/// The global SickleFactory. Chains that deploy their own override it (`Chain::sickle_factory`).
pub const VFAT_FACTORY: &str = "0x9D70B9E5ac2862C405D64A0193b4A4757Aab7F95";

/// `sickles(address) -> address` — the only function this module calls on the factory.
pub const SICKLES_SIGNATURE: &str = "sickles(address)";

/// The label a position reached through a Sickle carries in `via`.
pub const VIA_VFAT: &str = "vfat.io";

pub const VFAT_API: &str = "https://api.vfat.io/v4";

/// farm-balances is memoised this long per owner (`_ttl(f"vfat:{okey}", 120, fetch)`).
pub const FARM_BALANCES_TTL_SECS: f64 = 120.0;

/// How stale a last-good response may be and still be served during an outage.
pub const LAST_GOOD_MAX_AGE_SECS: f64 = 3600.0;

/// A mapped position must be worth **at least** this to be kept.
///
/// Note the comparison is `>=`, not the `>` used by the spot dust filter — a position worth
/// exactly one cent is kept here and dropped there. Both are copied from their own line of the
/// Python (`adapt_vfat_api` L1452 vs `_get_spot_uncached` L343).
pub const MIN_POSITION_USD: f64 = 0.01;

// ===========================================================================
// Sickle resolution
// ===========================================================================

/// One address to scan, and the label explaining how the wallet reaches it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    /// Checksummed address.
    pub address: String,
    /// `None` for the wallet itself, `Some("vfat.io")` for a proxy holding on its behalf.
    pub via: Option<&'static str>,
}

/// The owner's Sickle proxy on this chain, or `None` if it has none — port of `vfat_sickle`.
///
/// Every failure means `None`, matching the Python's blanket `except`: an undeployed factory, a
/// reverting call, a node hiccup and a genuine "no sickle" are indistinguishable to the caller and
/// all mean "nothing to scan here".
///
/// **One structural difference.** Python first checks `len(w3.eth.get_code(factory)) == 0` to skip
/// chains where the factory is not deployed; [`EvmRpc`] exposes no `eth_getCode`, so the call is
/// made unconditionally. A node answers a call to a codeless address with `0x`, which fails to
/// decode and yields `None` — the same answer by a different route, at the cost of one RPC round
/// trip on chains without a factory.
pub async fn vfat_sickle(rpc: &impl EvmRpc, owner: &str, factory: &str) -> Option<String> {
    let factory = Address::from_hex(factory).ok()?.to_checksum();
    let owner = AbiValue::address(owner).ok()?;
    let result = rpc
        .call_one(&factory, SICKLES_SIGNATURE, &[owner], "address")
        .await
        .ok()?;
    let sickle = result.as_address().ok()?;
    // `sickles()` returns the zero address for a user who never created one.
    (!sickle.is_zero()).then(|| sickle.to_checksum())
}

/// The addresses an NFT-enumerating adapter must scan — port of `resolve_owners`.
///
/// Returns the wallet first, then its Sickle. Passing `sickle` explicitly skips the lookup, the
/// way Python's `sickle=None` sentinel does, so a caller that already resolved it (or that knows
/// there is none) pays no RPC.
pub async fn resolve_owners(
    rpc: &impl EvmRpc,
    owner: &str,
    factory: &str,
    sickle: Option<&str>,
) -> Vec<Owner> {
    let resolved = match sickle {
        Some(sickle) => Some(sickle.to_string()),
        None => vfat_sickle(rpc, owner, factory).await,
    };
    let mut owners = vec![Owner {
        address: checksum_or_original(owner),
        via: None,
    }];
    // A caller-supplied empty string is Python's falsy `sickle`, which appends nothing.
    if let Some(sickle) = resolved.filter(|s| !s.is_empty()) {
        owners.push(Owner {
            address: checksum_or_original(&sickle),
            via: Some(VIA_VFAT),
        });
    }
    owners
}

/// Checksum an address, leaving anything unparseable untouched.
///
/// Python would raise on a malformed address and lose the whole chain; passing it through means a
/// caller with an odd-but-usable identifier still gets scanned.
fn checksum_or_original(address: &str) -> String {
    Address::from_hex(address)
        .map(|a| a.to_checksum())
        .unwrap_or_else(|_| address.to_string())
}

/// The factory to use for a chain: its own deployment, else the global one.
pub fn factory_for(chain: &Chain) -> &str {
    chain.sickle_factory.unwrap_or(VFAT_FACTORY)
}

// ===========================================================================
// farm-balances — the API client, its TTL cache and its last-good cache
// ===========================================================================

/// A last-good response and when it was stored.
#[derive(Debug, Clone)]
struct LastGood {
    stored_at: f64,
    entries: Arc<Vec<Value>>,
}

/// The vfat farm-balances feed with Python's two-layer caching.
///
/// The layers do different jobs and must not be collapsed into one:
///
/// * the **120s TTL cache** stops a wallet's several chain scans from each hitting the API;
/// * the **last-good cache** ([`LAST_GOOD_MAX_AGE_SECS`]) is an outage shield, and is deliberately
///   *not* refreshed by serving from it. A stale answer never enters the TTL cache either, so
///   every call during an outage retries the API — the moment vfat recovers, the next call is
///   fresh, rather than being pinned to stale data for another two minutes.
#[derive(Debug)]
pub struct VfatApi {
    client: reqwest::Client,
    cache: HttpCache,
    clock: Arc<dyn Clock>,
    fresh: SharedTtlCache<Arc<Vec<Value>>>,
    last_good: Mutex<HashMap<String, LastGood>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// The radar's own 600s cache, keyed by chain. Separate from `fresh` by design — see
    /// [`VfatApi::yield_opportunities`].
    opportunities: SharedTtlCache<Arc<Vec<Value>>>,
    /// Merkl reward responses, keyed `merkl:<chainId>:<sickle>` and held for [`MERKL_TTL_SECS`].
    /// Much shorter-lived than the action cache: these are accruing balances, not history.
    merkl: SharedTtlCache<Arc<Vec<Value>>>,
    /// Per-position action histories, keyed `vfatact:<chainId>:<sickle>:<tokenId>` and held for
    /// [`NFT_ACTIONS_TTL_SECS`]. Its own cache rather than a slot in `fresh`: the two are keyed
    /// differently (position vs wallet) and expire on different clocks.
    actions: SharedTtlCache<Arc<Vec<Value>>>,
}

impl VfatApi {
    pub fn new(client: reqwest::Client, cache: HttpCache) -> Self {
        Self::with_clock(client, cache, Arc::new(SystemClock))
    }

    pub fn with_clock(client: reqwest::Client, cache: HttpCache, clock: Arc<dyn Clock>) -> Self {
        Self {
            client,
            cache,
            clock,
            fresh: SharedTtlCache::new(),
            last_good: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            opportunities: SharedTtlCache::new(),
            merkl: SharedTtlCache::new(),
            actions: SharedTtlCache::new(),
        }
    }

    fn now(&self) -> f64 {
        self.clock.now_secs()
    }

    /// Every vfat LP/farm position for an EOA, across all chains — port of `_vfat_farm_balances`.
    ///
    /// `Err` only when the API failed *and* there is no last-good response within the window; the
    /// caller is then genuinely blind, which is different from "the wallet holds nothing".
    pub async fn farm_balances(&self, owner: &str) -> Result<Arc<Vec<Value>>> {
        let key = owner.to_lowercase();

        // Singleflight: every EVM chain of a wallet is scanned in parallel and each consults this
        // feed, so the concurrent cold-cache callers are coalesced into one fetch. The TTL check
        // lives *inside* the lock, exactly as Python's `with lk: _ttl(...)` does — that is what
        // makes the waiters read the fresh result instead of each starting their own request.
        let lock = self.lock_for(&key);
        let _guard = lock.lock().await;

        if let Some(hit) = self.fresh.get(&key, FARM_BALANCES_TTL_SECS, self.now()) {
            return Ok(hit);
        }

        match self.fetch(owner).await {
            Ok(entries) => {
                self.remember(&key, entries.clone());
                self.fresh.put(&key, entries.clone(), self.now());
                Ok(entries)
            }
            Err(error) => self.serve_last_good(&key, owner, &error),
        }
    }

    /// One live call. A non-2xx is an error (`raise_for_status`), as is an unparseable body.
    async fn fetch(&self, owner: &str) -> Result<Arc<Vec<Value>>> {
        let url = format!("{VFAT_API}/farm-balances?addresses={owner}");
        let recorded = self.cache.get(&self.client, &url).await?;
        if !(200..300).contains(&recorded.status) {
            return Err(anyhow!("farm-balances returned HTTP {}", recorded.status));
        }
        let body: Value =
            serde_json::from_str(&recorded.body).context("farm-balances returned non-JSON")?;
        Ok(Arc::new(entries_of(body)))
    }

    /// The outage path: serve the previous response while it is inside the window, else propagate.
    fn serve_last_good(
        &self,
        key: &str,
        owner: &str,
        error: &anyhow::Error,
    ) -> Result<Arc<Vec<Value>>> {
        let good = self.last_good.lock().ok().and_then(|c| c.get(key).cloned());
        let Some(good) = good else {
            return Err(anyhow!("{error:#}")).context("vfat farm-balances failed, no cached copy");
        };
        let age = self.now() - good.stored_at;
        if age >= LAST_GOOD_MAX_AGE_SECS {
            return Err(anyhow!("{error:#}")).with_context(|| {
                format!("vfat farm-balances failed and the cached copy is {age:.0}s old")
            });
        }
        tracing::warn!(
            owner = owner.chars().take(8).collect::<String>(),
            age_secs = age as i64,
            error = format!("{error:#}"),
            "vfat farm-balances down; serving cached positions"
        );
        Ok(good.entries)
    }

    fn remember(&self, key: &str, entries: Arc<Vec<Value>>) {
        if let Ok(mut cache) = self.last_good.lock() {
            cache.insert(
                key.to_string(),
                LastGood {
                    stored_at: self.now(),
                    entries,
                },
            );
        }
    }

    fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = match self.locks.lock() {
            Ok(locks) => locks,
            // A poisoned map costs coalescing, not correctness: each caller fetches its own.
            Err(_) => return Arc::new(tokio::sync::Mutex::new(())),
        };
        locks.entry(key.to_string()).or_default().clone()
    }

    /// Age in seconds of the stored last-good response, for diagnostics and tests.
    pub fn last_good_age(&self, owner: &str) -> Option<f64> {
        let stored = self
            .last_good
            .lock()
            .ok()?
            .get(&owner.to_lowercase())
            .map(|g| g.stored_at)?;
        Some(self.now() - stored)
    }
}

/// vfat answers with a bare array; anything else (an error object, `null`) is no positions.
///
/// Python's `_ttl(...) or []` collapses those cases the same way, and `adapt_vfat_api` then skips
/// every non-dict entry — so a malformed element is dropped rather than fatal.
fn entries_of(body: Value) -> Vec<Value> {
    match body {
        Value::Array(items) => items,
        _ => Vec::new(),
    }
}

// ===========================================================================
// Mapping one farm-balances entry to a position
// ===========================================================================

/// On-chain gauge emissions accrued by a position — port of `_vfat_pending_rewards`.
///
/// A Hybra LP staked in its gauge earns HYBR here, a PancakeSwap LP earns CAKE. Entries without a
/// symbol, with an unparseable amount, or with a non-positive amount are skipped.
pub fn pending_rewards(entry: &Value) -> Vec<TokenAmt> {
    let Some(rewards) = entry.get("pendingRewards").and_then(Value::as_array) else {
        return Vec::new();
    };
    rewards
        .iter()
        .filter_map(|reward| {
            let token = reward.get("token")?;
            let symbol = non_empty_str(token.get("symbol"))?;
            let amount = raw_amount(reward.get("amount"), decimals_of(token))?;
            if amount <= 0.0 {
                return None;
            }
            Some(TokenAmt {
                symbol,
                amount,
                usd: Some(amount * number(token.get("price")).unwrap_or(0.0)),
                ..Default::default()
            })
        })
        .collect()
}

/// Map one farm-balances entry to a position — port of `_vfat_api_position` + `_vfat_stamp_meta`.
///
/// `None` when the entry is not a two-token LP (both underlying symbols are required), which is how
/// single-token farms and malformed entries drop out.
pub fn vfat_api_position(entry: &Value) -> Option<Position> {
    let empty = Value::Object(Default::default());
    let nft = entry.get("nft").filter(|v| v.is_object()).unwrap_or(&empty);
    let underlying = entry
        .get("underlying")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    // Python pads with two empty dicts, so a 0- or 1-token entry reads as missing symbols.
    let t0 = underlying.first().unwrap_or(&empty);
    let t1 = underlying.get(1).unwrap_or(&empty);
    let sym0 = non_empty_str(t0.get("symbol"))?;
    let sym1 = non_empty_str(t1.get("symbol"))?;

    // `balance` is already in human units here (unlike `fees0`/`fees1`, which are raw).
    let a0 = number(t0.get("balance")).unwrap_or(0.0);
    let a1 = number(t1.get("balance")).unwrap_or(0.0);
    let pr0 = number(t0.get("price")).unwrap_or(0.0);
    let pr1 = number(t1.get("price")).unwrap_or(0.0);
    let (dec0, dec1) = (decimals_of(t0), decimals_of(t1));
    let fee = number(entry.get("fee")).unwrap_or(0.0);
    let spacing = entry.get("tickSpacing").and_then(Value::as_i64);

    let tick_lower = entry_tick(nft.get("tickLow"));
    let tick_upper = entry_tick(nft.get("tickUp"));
    let cur_tick = entry_tick(entry.get("tick"));
    // Inclusive at **both** ends — unlike the RPC v3 path's `tickL <= cur < tickU`.
    let in_range = match (tick_lower, tick_upper, cur_tick) {
        (Some(lower), Some(upper), Some(cur)) => Some(lower <= cur && cur <= upper),
        _ => None,
    };

    // Converted to the owned model type immediately: `lp_range` borrows the symbols, and they are
    // moved into the token list below.
    let price_band = match (tick_lower, tick_upper, cur_tick) {
        (Some(lower), Some(upper), Some(cur)) => {
            let band = lp_range(
                lower as i32,
                upper as i32,
                cur as i32,
                dec0 as i32,
                dec1 as i32,
                &sym0,
                &sym1,
            );
            Some(PriceBand {
                lower: band.lower,
                upper: band.upper,
                cur: band.cur,
                base: band.base.to_string(),
                quote: band.quote.to_string(),
                full: band.full,
            })
        }
        _ => None,
    };

    // Claimable yield is swap fees *plus* farm emissions. A Nest LP earns its reward token with
    // ~0 swap fees, so dropping either half makes a productive position read as "no fees yet".
    // Both legs are always emitted, zero or not: the front end treats the presence of `rewards`
    // as the marker of an LP position and hides positions without it.
    let fee0 = raw_amount(nft.get("fees0"), dec0).unwrap_or(0.0);
    let fee1 = raw_amount(nft.get("fees1"), dec1).unwrap_or(0.0);
    let mut rewards = vec![
        TokenAmt {
            symbol: sym0.clone(),
            amount: fee0,
            usd: Some(fee0 * pr0),
            ..Default::default()
        },
        TokenAmt {
            symbol: sym1.clone(),
            amount: fee1,
            usd: Some(fee1 * pr1),
            ..Default::default()
        },
    ];
    let pending = pending_rewards(entry);
    let swap_fees_usd = fee0 * pr0 + fee1 * pr1;
    let rewards_usd = swap_fees_usd + pending.iter().filter_map(|r| r.usd).sum::<f64>();
    rewards.extend(pending);

    let (v0, v1) = (a0 * pr0, a1 * pr1);
    let mut position = Position::new(
        protocol_label(entry),
        "Liquidity Pool",
        format!("{sym0}/{sym1} {:.2}%", fee / 1e4),
        Some(v0 + v1),
    );
    position.id = Some(
        nft.get("id")
            .filter(|v| !v.is_null())
            .map(|id| format!("#{}", scalar_string(id))),
    );
    position.via = Some(VIA_VFAT.to_string());
    position.tokens = vec![
        TokenAmt {
            symbol: sym0,
            amount: a0,
            usd: Some(v0),
            ..Default::default()
        },
        TokenAmt {
            symbol: sym1,
            amount: a1,
            usd: Some(v1),
            ..Default::default()
        },
    ];
    position.in_range = in_range;
    position.rewards = Some(rewards);
    position.rewards_usd = Some(Some(rewards_usd));
    // `_position` writes `change24h` only when it is not None, so a pair with no change data
    // anywhere omits the key rather than writing null.
    position.change24h = blend_change(
        v0,
        number(t0.get("percentChange24h")),
        v1,
        number(t1.get("percentChange24h")),
    )
    .map(Some);
    position.pool_type = Some(pool_type(entry).to_string());
    position.swap_fees_usd = Some(swap_fees_usd);
    position.tick_spacing = spacing;
    position.price_band = price_band;

    stamp_meta(&mut position, entry);
    Some(position)
}

/// Stamp vfat's own APR and range-% band — port of `_vfat_stamp_meta`. No network calls.
pub fn stamp_meta(position: &mut Position, entry: &Value) {
    let snapshot = entry.get("farm").and_then(|f| f.get("snapshot"));
    position.apr = snapshot
        .and_then(|s| number(s.get("apr")))
        .or_else(|| snapshot.and_then(|s| number(s.get("lpApr"))));

    // Prefer vfat's own figure; else derive it from the band so the UI always has one.
    let range = entry.get("guaranteedAprPricePercentRange");
    if let Some(width) = range.and_then(|r| number(r.get("widthPercent"))) {
        position.range_pct = Some(RangePct {
            min: range.and_then(|r| number(r.get("minPricePercent"))),
            max: range.and_then(|r| number(r.get("maxPricePercent"))),
            width,
        });
        return;
    }
    let Some(band) = position.price_band.as_ref().filter(|b| !b.full) else {
        return;
    };
    // Python's `if lo and hi and c` — a zero edge is falsy there and skips the branch.
    let (Some(lo), Some(hi), Some(cur)) = (band.lower, band.upper, band.cur) else {
        return;
    };
    if lo == 0.0 || hi == 0.0 || cur == 0.0 {
        return;
    }
    position.range_pct = Some(RangePct {
        min: Some((lo - cur) / cur * 100.0),
        max: Some((hi - cur) / cur * 100.0),
        width: (hi - lo) / cur * 100.0,
    });
}

/// `"pool"` (a pure swap-fee LP) or `"farm"` (it earns a reward token).
///
/// vfat's own `depositOptionKind` decides when it says one; otherwise the rule is "earns a reward
/// token => farm", which is what the UI groups on.
fn pool_type(entry: &Value) -> &'static str {
    let farm = entry.get("farm");
    let kind = farm
        .and_then(|f| f.get("depositOptionKind"))
        .map(scalar_string)
        .unwrap_or_default()
        .to_lowercase();
    if ["farm", "gauge", "stake"].iter().any(|k| kind.contains(k)) {
        return "farm";
    }
    let earns = |field: &str| {
        farm.and_then(|f| f.get(field))
            .is_some_and(|v| !is_falsy(v))
    };
    if earns("offChainRewards")
        || earns("rewardTokenAddresses")
        || entry.get("pendingRewards").is_some_and(|v| !is_falsy(v))
    {
        "farm"
    } else {
        "pool"
    }
}

/// The source DEX (Hyperswap, ProjectX, …), else the position type title-cased.
///
/// Note the Python applies `.title()` to the *fallback expression*, so a missing `type` yields
/// `"Uniswap V3"` with a capital V — not the `"Uniswap v3"` written in the source.
fn protocol_label(entry: &Value) -> String {
    if let Some(name) = entry
        .get("farm")
        .and_then(|f| f.get("protocol"))
        .and_then(|p| p.get("name"))
        .and_then(|n| non_empty_str(Some(n)))
    {
        return name;
    }
    let kind = non_empty_str(entry.get("type")).unwrap_or_else(|| "Uniswap v3".to_string());
    python_title(&kind.replace('_', " "))
}

/// Python's `str.title()`: a cased character is upper-cased when the character before it is not a
/// letter, and lower-cased otherwise. `"EQUALIZER_LP"` -> `"Equalizer Lp"`, `"uni v3"` -> `"Uni V3"`.
fn python_title(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut prev_is_alpha = false;
    for ch in text.chars() {
        if prev_is_alpha {
            out.extend(ch.to_lowercase());
        } else {
            out.extend(ch.to_uppercase());
        }
        prev_is_alpha = ch.is_alphabetic();
    }
    out
}

// ---- small JSON helpers, all matching Python's coercions -------------------

/// A number, whether JSON sent it as a number or as a string (vfat does both).
fn number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// `int(v) / 10 ** dec`, with Python's `except (TypeError, ValueError): 0.0`.
///
/// The value is a raw integer *string*; a decimal point makes `int()` raise, so `"1.5"` is 0.0
/// rather than 1.5 — copied deliberately, since a raw amount should never carry a fraction.
fn raw_amount(value: Option<&Value>, decimals: u32) -> Option<f64> {
    let raw = match value? {
        // `int()` accepts only a digit string — no decimal point, no exponent.
        Value::String(s) => {
            let s = s.trim();
            let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            s.parse::<f64>().ok()?
        }
        Value::Number(n) => n.as_f64().filter(|v| v.fract() == 0.0)?,
        _ => return None,
    };
    Some(raw / 10f64.powi(decimals.min(300) as i32))
}

/// `t.get("decimals", 18)`, treating an explicit `null` as 18 as well.
///
/// Python would carry the `None` into `10 ** None` and raise; the caller's `try` turns that into a
/// zero amount for fees, but `_lp_range` would take the whole adapter down. Defaulting is the
/// same answer everywhere the value is usable and strictly better where it is not.
fn decimals_of(token: &Value) -> u32 {
    match token.get("decimals") {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(18) as u32,
        Some(Value::String(s)) => s.trim().parse().unwrap_or(18),
        _ => 18,
    }
}

fn entry_tick(value: Option<&Value>) -> Option<i64> {
    match value? {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A scalar as Python's `str()` would render it — ids arrive as both `123` and `"123"`.
fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Python truthiness for the values that reach it here: `null`, `false`, `0`, `""`, `[]`, `{}`.
fn is_falsy(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::Bool(b) => !b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
    }
}

// ===========================================================================
// The adapter
// ===========================================================================

/// LP positions from the vfat API — port of `adapt_vfat_api`.
///
/// Only for chains flagged `vfat_api` (HyperEVM, BNB): those are the chains whose explorer indexes
/// neither the Sickle-held NFTs nor their transactions, so vfat's indexer is the only source. On
/// every other chain this returns nothing, because the RPC adapters already read those positions
/// and counting them twice would inflate the portfolio.
pub async fn adapt_vfat_api(
    api: Arc<VfatApi>,
    chain: &Chain,
    owner: &str,
) -> Result<Vec<Position>> {
    if !chain.vfat_api {
        return Ok(Vec::new());
    }
    let entries = api.farm_balances(owner).await?;
    let mut positions = positions_for_chain(&entries, chain.chain_id);

    // A chain with no configured id pairs nothing, which is the same no-op Python reaches by
    // comparing every entry's `chainId` against `None`.
    if let Some(chain_id) = chain.chain_id {
        let pairs = lifecycle_pairs(&entries, chain_id, &positions);

        // `_attach_campaign_rewards(pairs, merkl)` then `_vfat_stamp_lifecycle(pairs)`
        // (portfolio.py L1458-1459), in that order.
        let sickles = sickle_addresses(&entries, Some(chain_id));
        if !sickles.is_empty() {
            let merkl = api.merkl_rewards(&sickles, chain_id).await;
            attach_campaign_rewards(&mut positions, &entries, &pairs, &merkl);
        }
        stamp_lifecycle_all(api, &entries, chain_id, &mut positions).await;
    }
    Ok(positions)
}

/// The pure half of [`adapt_vfat_api`]: filter the feed to one chain and map what is worth keeping.
///
/// A chain with no configured id matches nothing — Python compares `p["chainId"] != None`, which
/// is never true for a real entry.
pub fn positions_for_chain(entries: &[Value], chain_id: Option<u64>) -> Vec<Position> {
    entries
        .iter()
        .filter(|entry| entry.is_object())
        .filter(|entry| entry_chain_id(entry) == chain_id)
        .filter_map(vfat_api_position)
        .filter(|position| position.usd.unwrap_or(0.0) >= MIN_POSITION_USD)
        .collect()
}

/// The Sickles holding this chain's positions — the input `_merkl_rewards` needs, and proof that a
/// position belongs to a proxy rather than the wallet.
pub fn sickle_addresses(entries: &[Value], chain_id: Option<u64>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries
        .iter()
        .filter(|entry| entry_chain_id(entry) == chain_id)
    {
        if let Some(sickle) = non_empty_str(entry.get("sickleAddress"))
            && !out.contains(&sickle)
        {
            out.push(sickle);
        }
    }
    out
}

fn entry_chain_id(entry: &Value) -> Option<u64> {
    entry.get("chainId").and_then(Value::as_u64)
}

// ===========================================================================
// Yield radar — port of `_vfat_yield_opportunities` (L1382) and `vfat_yield_radar` (L1396)
// ===========================================================================

/// Default number of pools the radar returns. **A default, not a cap** — `mcp_server.py:262`
/// passes its own `limit=cap`, so a caller may ask for more; only `server.py` takes the default.
pub const RADAR_LIMIT_DEFAULT: usize = 6;

/// Below this TVL vfat's advertised APRs are noise from dust pools.
pub const RADAR_TVL_FLOOR: f64 = 10_000.0;

/// Yield opportunities are cached this long per chain, independently of farm-balances.
pub const YIELD_OPPORTUNITIES_TTL_SECS: f64 = 600.0;

/// Server-side filter: the radar only asks for pools already paying at least this APR.
pub const RADAR_MIN_APR: u32 = 50;

/// Tokens recognisable enough that a pair containing one is not pure degen. Anything outside this
/// set has to be a token the user already holds.
///
/// Exactly `_RADAR_MAJORS` (portfolio.py L1375) — 19 entries, no additions. Widening it would
/// let pairs the Python rejects onto the radar.
pub const RADAR_MAJORS: [&str; 19] = [
    "USDC", "USD₮0", "USDT0", "USDT", "USDH", "USDXL", "DAI", "WHYPE", "HYPE", "KHYPE", "WSTHYPE",
    "LHYPE", "STHYPE", "WBTC", "UBTC", "BTC", "ETH", "WETH", "WSTETH",
];

/// vfat chain id -> the portfolio's chain name (`_ID_CHAIN`, the inverse of `_EVM_CHAIN_IDS`).
///
/// Defined here rather than read from [`crate::chains`]: the Python keeps its own literal map, and
/// most chains carry no `chain_id` in the chain table (it is populated only where something keys
/// off it), so deriving it from there would silently lose names.
const ID_CHAIN: [(u64, &str); 7] = [
    (1, "ethereum"),
    (10, "optimism"),
    (137, "polygon"),
    (56, "bnb"),
    (8453, "base"),
    (42161, "arbitrum"),
    (999, "hyperevm"),
];

/// One pool the radar suggests. Field names match the Python dict, which the API serves verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct YieldOpportunity {
    pub chain_id: Option<u64>,
    pub chain: String,
    /// `"WHYPE/USDC"` — the dedup key together with `chain_id` and `protocol`.
    pub pair: String,
    pub tokens: Vec<String>,
    pub protocol: Option<String>,
    pub url: Option<String>,
    pub apr: f64,
    pub tvl: f64,
    pub fee: Option<f64>,
}

/// What the user already has, which is what the radar compares against.
///
/// `held` is an ordered `Vec` rather than a map because the Python iterates a dict in insertion
/// order and equal-APR results keep that order through a stable sort — a `HashMap` here would
/// reorder tied suggestions run to run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RadarProfile {
    /// Per chain, the symbols the user holds in vfat LPs (upper-cased), first-seen order.
    pub held: Vec<(Option<u64>, Vec<String>)>,
    /// The best APR the user is *already* earning, across every chain. Only pools beating it
    /// are worth showing.
    pub best_apr: f64,
    /// `(chain_id, pool address)` the user is already in — never suggested back to them.
    pub in_pools: Vec<(Option<u64>, String)>,
}

/// Build the comparison baseline from a farm-balances feed — the first half of `vfat_yield_radar`.
pub fn radar_profile(entries: &[Value]) -> RadarProfile {
    let mut profile = RadarProfile::default();
    for entry in entries.iter().filter(|e| e.is_object()) {
        let chain_id = entry_chain_id(entry);
        for token in entry
            .get("underlying")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
        {
            let Some(symbol) = non_empty_str(token.get("symbol")) else {
                continue;
            };
            let symbol = symbol.to_uppercase();
            let slot = match profile.held.iter_mut().find(|(cid, _)| *cid == chain_id) {
                Some(slot) => slot,
                None => {
                    profile.held.push((chain_id, Vec::new()));
                    profile.held.last_mut().expect("just pushed")
                }
            };
            if !slot.1.contains(&symbol) {
                slot.1.push(symbol);
            }
        }
        let apr = entry
            .get("farm")
            .and_then(|f| f.get("snapshot"))
            .and_then(|s| number(s.get("apr")))
            .unwrap_or(0.0);
        profile.best_apr = profile.best_apr.max(apr);
        if let Some(pool) = entry
            .get("nft")
            .and_then(|n| n.get("poolAddress"))
            .and_then(|p| non_empty_str(Some(p)))
        {
            let key = (chain_id, pool.to_lowercase());
            if !profile.in_pools.contains(&key) {
                profile.in_pools.push(key);
            }
        }
    }
    profile
}

/// Filter one chain's yield-opportunities response down to pools worth suggesting.
///
/// Four gates, all from the Python and all load-bearing: the pair must be a two-token pool
/// containing something the user holds; every leg must be a major or another held token (no pure
/// degen pairs); the user must not already be in it; and it must clear the TVL floor *and* beat
/// their current best APR — an "opportunity" worse than what they have is noise.
pub fn radar_candidates(
    profile: &RadarProfile,
    chain_id: Option<u64>,
    held: &[String],
    items: &[Value],
) -> Vec<YieldOpportunity> {
    let empty = Value::Object(Default::default());
    items
        .iter()
        .filter_map(|item| {
            let pool = item.get("pool").filter(|p| p.is_object()).unwrap_or(&empty);
            let symbols: Vec<String> = pool
                .get("underlying")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .map(|t| {
                    t.get("symbol")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_uppercase()
                })
                .collect();
            if symbols.len() != 2 || !symbols.iter().any(|s| held.contains(s)) {
                return None;
            }
            if !symbols
                .iter()
                .all(|s| RADAR_MAJORS.contains(&s.as_str()) || held.contains(s))
            {
                return None;
            }
            let address = pool
                .get("address")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if profile.in_pools.contains(&(chain_id, address)) {
                return None;
            }

            // `max(..., key=apr, default={})` — Python keeps the *first* maximal option on a tie.
            let best = item
                .get("options")
                .and_then(Value::as_array)
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .fold(None::<&Value>, |best, option| match best {
                    Some(current)
                        if number(current.get("apr")).unwrap_or(0.0)
                            >= number(option.get("apr")).unwrap_or(0.0) =>
                    {
                        Some(current)
                    }
                    _ => Some(option),
                })
                .unwrap_or(&empty);
            let apr = number(best.get("apr")).unwrap_or(0.0);
            let tvl = number(best.get("totalLiquidity")).unwrap_or(0.0);
            if tvl < RADAR_TVL_FLOOR || apr <= profile.best_apr {
                return None;
            }
            let protocol = best.get("protocol").filter(|p| p.is_object());
            Some(YieldOpportunity {
                chain_id,
                chain: chain_name(chain_id),
                pair: symbols.join("/"),
                tokens: symbols,
                protocol: protocol.and_then(|p| non_empty_str(p.get("name"))),
                url: protocol.and_then(|p| non_empty_str(p.get("url"))),
                apr,
                tvl,
                fee: number(pool.get("currentFee")),
            })
        })
        .collect()
}

/// Highest APR first, one row per (chain, pair, protocol), truncated to `limit`.
///
/// The sort is stable and the dedup keeps the first survivor, so tied APRs stay in feed order —
/// the same rows in the same order the Python produces.
pub fn rank_radar(mut found: Vec<YieldOpportunity>, limit: usize) -> Vec<YieldOpportunity> {
    found.sort_by(|a, b| b.apr.total_cmp(&a.apr));
    let mut seen: Vec<(Option<u64>, String, Option<String>)> = Vec::new();
    let mut out = Vec::new();
    for opportunity in found {
        let key = (
            opportunity.chain_id,
            opportunity.pair.clone(),
            opportunity.protocol.clone(),
        );
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        out.push(opportunity);
        if out.len() == limit {
            break;
        }
    }
    out
}

/// The portfolio's chain name -> vfat chain id (`_EVM_CHAIN_IDS`, portfolio.py L1330).
///
/// The inverse of [`ID_CHAIN`], and the reason the enrich pass can run on chains whose entry in
/// [`crate::chains`] carries no `chain_id`: that field is populated only where something already
/// keys off it, so reading it alone would silently skip most chains.
#[must_use]
pub fn evm_chain_id(chain: &str) -> Option<u64> {
    ID_CHAIN
        .iter()
        .find(|(_, name)| *name == chain)
        .map(|(id, _)| *id)
}

/// Reconcile an RPC chain's positions with the vfat feed — the port of `_vfat_enrich` (L1334).
///
/// Two jobs, matched by `(chainId, tokenId)`:
///
/// 1. **Enrich.** A vfat-proxy LP that the RPC pass already read (`via == "vfat.io"`) gets vfat's
///    own APR and range-% stamped onto it, the same data the HyperEVM positions carry.
/// 2. **Add.** A farm the RPC pass *cannot* see is appended from the feed. This is the part that
///    moves money: a gauge-staked NFT (Aerodrome Slipstream on Base) has been transferred to the
///    gauge, and a Sickle position on a chain whose factory we do not resolve is held by a proxy
///    we never enumerate. Neither is reachable by `balanceOf`, so without this pass they are
///    missing from the total outright rather than merely unadorned.
///
/// Dedup is by NFT id, so an unstaked Sickle LP that *is* read over RPC is not counted twice.
///
/// No-op on `vfat_api` chains: there the feed is the only source and [`adapt_vfat_api`] has
/// already added everything, so a second pass would duplicate every position.
///
/// The farm-balances call is shared with [`adapt_vfat_api`] and [`super::sickle_rpc`] through the
/// same TTL cache, so on a wallet those already scanned this costs no network.
///
/// # Decorations
///
/// Both of the Python's tail passes run here: [`attach_campaign_rewards`] for the farms this pass
/// *appended* (an RPC-read position already has its rewards, so re-adding Merkl would double it),
/// then [`stamp_lifecycle_all`] for every matched position. The two pair sets differ deliberately.
pub async fn enrich(
    api: Arc<VfatApi>,
    chain: &Chain,
    owner: &str,
    positions: &mut Vec<Position>,
) -> Result<()> {
    if chain.vfat_api {
        return Ok(()); // the feed is the only source here; adapt_vfat_api already added it all
    }
    let Some(chain_id) = chain.chain_id.or_else(|| evm_chain_id(chain.name)) else {
        return Ok(()); // no vfat chain id, so nothing in the feed can match
    };

    let entries = api.farm_balances(owner).await?;
    let first_added = positions.len();
    let added = reconcile(&entries, chain_id, positions);
    if added > 0 {
        tracing::info!(
            chain = chain.name,
            count = added,
            "added vfat farms the RPC pass cannot see (gauge-staked or unresolved Sickle)"
        );
    }

    // `if added_pairs and sickles: _attach_campaign_rewards(added_pairs, ...)` — only the farms
    // this pass *appended*. The RPC-read positions already carry their rewards from the adapter
    // that read them, and adding Merkl on top would double-count.
    if added > 0 {
        let sickles = sickle_addresses(&entries, Some(chain_id));
        if !sickles.is_empty() {
            let merkl = api.merkl_rewards(&sickles, chain_id).await;
            let added_pairs: Vec<(usize, usize)> = lifecycle_pairs(&entries, chain_id, positions)
                .into_iter()
                .filter(|(position_index, _)| *position_index >= first_added)
                .collect();
            attach_campaign_rewards(positions, &entries, &added_pairs, &merkl);
        }
    }

    // Lifecycle covers **all** pairs, matched and added alike — `_vfat_enrich` stamps `pairs`,
    // not `added_pairs`. The two lists differ, which is why they are built separately.
    stamp_lifecycle_all(api, &entries, chain_id, positions).await;
    Ok(())
}

/// The pure half of [`enrich`]: stamp what matched, append what did not, and say how many were
/// appended.
///
/// Only positions marked `via == "vfat.io"` are enrich targets. That matters: an id collision
/// across protocols is possible — NFT ids are per-manager, not global — so matching on id alone
/// would stamp a Uniswap position with an unrelated farm's APR.
pub fn reconcile(entries: &[Value], chain_id: u64, positions: &mut Vec<Position>) -> usize {
    let mut added = Vec::new();

    for entry in entries.iter().filter(|e| e.is_object()) {
        if entry_chain_id(entry) != Some(chain_id) {
            continue;
        }
        let feed_id = entry.pointer("/nft/id").map(id_text);

        // An RPC-read vfat position with this id, if there is one.
        let matched = feed_id.as_ref().and_then(|id| {
            positions.iter_mut().find(|position| {
                position.via.as_deref() == Some(VIA_VFAT)
                    && position_id(position).as_ref() == Some(id)
            })
        });

        match matched {
            Some(position) => stamp_meta(position, entry),
            None => {
                // API-only: gauge-staked, or a Sickle we do not enumerate.
                if let Some(position) =
                    vfat_api_position(entry).filter(|p| p.usd.unwrap_or(0.0) >= MIN_POSITION_USD)
                {
                    added.push(position);
                }
            }
        }
    }

    let count = added.len();
    positions.extend(added);
    count
}

/// A feed `nft.id`, which arrives as either a JSON string or a number.
fn id_text(id: &Value) -> String {
    match id {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// A position's id with the display `#` stripped, so it compares against a raw feed id.
fn position_id(position: &Position) -> Option<String> {
    position
        .id
        .as_ref()
        .and_then(|inner| inner.as_deref())
        .map(|id| id.trim_start_matches('#').to_string())
}

/// Per-wallet radar cap — `vfat_yield_radar(owner, limit=6)`.
pub const RADAR_LIMIT: usize = 6;

/// Higher-APR pools for the tokens `owner` already holds in vfat LPs — the port of
/// `vfat_yield_radar` (portfolio.py L1396).
///
/// The whole thing is relative to what the wallet already has: [`radar_profile`] builds the
/// baseline from the wallet's own farm balances, and [`radar_candidates`] only keeps pools that
/// beat it. A wallet with no vfat LPs therefore has an empty profile and gets no suggestions,
/// which is correct rather than a miss — there is nothing to compare against.
///
/// Opportunities are fetched per chain the wallet holds on, not per chain that exists, because
/// the profile's `held` map is keyed that way. Both the farm-balances feed and the
/// yield-opportunities feed are cached inside [`VfatApi`], so calling this alongside a portfolio
/// read costs no extra requests.
pub async fn vfat_yield_radar(
    api: &VfatApi,
    owner: &str,
    limit: usize,
) -> Result<Vec<YieldOpportunity>> {
    let entries = api.farm_balances(owner).await?;
    let profile = radar_profile(&entries);

    let mut found = Vec::new();
    for (chain_id, held) in &profile.held {
        let items = api.yield_opportunities(*chain_id).await;
        found.extend(radar_candidates(&profile, *chain_id, held, &items));
    }
    Ok(rank_radar(found, limit))
}

/// `_ID_CHAIN.get(cid, str(cid))` — the chain's name, else its id as a string.
fn chain_name(chain_id: Option<u64>) -> String {
    match chain_id {
        Some(id) => ID_CHAIN
            .iter()
            .find(|(known, _)| *known == id)
            .map(|(_, name)| (*name).to_string())
            .unwrap_or_else(|| id.to_string()),
        // Python formats a missing id as the string "None"; a real entry always has one.
        None => "None".to_string(),
    }
}

impl VfatApi {
    /// Top-APR pools on a chain — port of `_vfat_yield_opportunities`. `[]` on any miss.
    ///
    /// **Its staleness behaviour differs from farm-balances on purpose.** This has its own 600s
    /// cache and *no* last-good shield: when the endpoint is down the radar simply goes empty.
    /// That is the right asymmetry — farm-balances reports money the user owns, so stale beats
    /// absent; the radar reports pools they might move into, and a stale suggestion is worse than
    /// no suggestion.
    pub async fn yield_opportunities(&self, chain_id: Option<u64>) -> Arc<Vec<Value>> {
        let cache_key = match chain_id {
            Some(id) => format!("vfatyo:{id}"),
            None => "vfatyo:None".to_string(),
        };
        if let Some(hit) =
            self.opportunities
                .get(&cache_key, YIELD_OPPORTUNITIES_TTL_SECS, self.now())
        {
            return hit;
        }
        // `requests` drops a `None` param, so a chain without an id asks for every chain — kept
        // rather than corrected, since the Python's output would carry those rows too.
        let chain_param = match chain_id {
            Some(id) => format!("chainId={id}&"),
            None => String::new(),
        };
        let url = format!(
            "{VFAT_API}/yield-opportunities?{chain_param}pageSize=60&sortKey=apr&sortDirection=desc&minAPR={RADAR_MIN_APR}"
        );
        let items = match self.fetch_items(&url).await {
            Ok(items) => items,
            Err(error) => {
                // Python's bare `except: return []`. A failure is *not* cached, so the next call
                // retries rather than serving an empty radar for ten minutes.
                tracing::warn!(
                    url,
                    error = format!("{error:#}"),
                    "vfat yield-opportunities failed; radar is empty for this chain"
                );
                return Arc::new(Vec::new());
            }
        };
        self.opportunities
            .put(&cache_key, items.clone(), self.now());
        items
    }

    async fn fetch_items(&self, url: &str) -> Result<Arc<Vec<Value>>> {
        let recorded = self.cache.get(&self.client, url).await?;
        if !(200..300).contains(&recorded.status) {
            return Err(anyhow!(
                "yield-opportunities returned HTTP {}",
                recorded.status
            ));
        }
        let body: Value = serde_json::from_str(&recorded.body)
            .context("yield-opportunities returned non-JSON")?;
        Ok(Arc::new(
            body.get("items")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ))
    }

    /// Higher-APR pools for the tokens this wallet already LPs — port of `vfat_yield_radar`.
    ///
    /// `Err` only when farm-balances itself is unreadable (no last-good copy inside the window):
    /// without the user's own positions there is nothing to compare against, and an empty radar
    /// would read as "nothing better out there" rather than "we could not check".
    pub async fn yield_radar(&self, owner: &str, limit: usize) -> Result<Vec<YieldOpportunity>> {
        let entries = self.farm_balances(owner).await?;
        let profile = radar_profile(&entries);
        let mut found = Vec::new();
        for (chain_id, held) in &profile.held {
            let items = self.yield_opportunities(*chain_id).await;
            found.extend(radar_candidates(&profile, *chain_id, held, &items));
        }
        Ok(rank_radar(found, limit))
    }
}

// ===========================================================================================
// Campaign rewards — `_merkl_rewards` / `_nest_entry` / `_distribute_nest` (portfolio.py L1018)
// ===========================================================================================

/// Merkl's rewards API.
pub const MERKL_API: &str = "https://api.merkl.xyz/v4";

/// `_ttl(f"merkl:{chain_id}:{sickle}", 120, ...)`.
pub const MERKL_TTL_SECS: f64 = 120.0;

/// Per-position Merkl rewards, keyed by the NFT `tokenId` as a string.
pub type MerklRewards = HashMap<String, Vec<TokenAmt>>;

impl VfatApi {
    /// Real per-position Merkl rewards for a chain — port of `_merkl_rewards`.
    ///
    /// Merkl encodes the earning position in each reward's `reason` field as
    /// `<PROTOCOL>_<pool>_<tokenId>`, which is what makes per-position attribution possible at all;
    /// vfat's own `offChainRewards` blob is wallet-level. Rewards accrue to the Sickle rather than
    /// the EOA, so this is queried per Sickle.
    ///
    /// A Sickle whose call fails is skipped (`except: continue`), not fatal: campaign rewards
    /// decorate a position's *claimable* figure and never its `usd`, so a Merkl outage must not
    /// cost the portfolio its balances.
    pub async fn merkl_rewards(&self, sickles: &[String], chain_id: u64) -> MerklRewards {
        let mut out: MerklRewards = HashMap::new();

        // `for s in sorted(sickles)` — order decides which breakdown row lands first in a token's
        // merged entry, so it is kept deterministic.
        let mut ordered: Vec<&String> = sickles.iter().collect();
        ordered.sort();

        for sickle in ordered {
            let key = format!("merkl:{chain_id}:{}", sickle.to_lowercase());
            let chains = match self.merkl.get(&key, MERKL_TTL_SECS, self.now()) {
                Some(hit) => hit,
                None => {
                    let url = format!("{MERKL_API}/users/{sickle}/rewards?chainId={chain_id}");
                    match self.fetch_merkl(&url).await {
                        Ok(chains) => {
                            self.merkl.put(&key, chains.clone(), self.now());
                            chains
                        }
                        Err(error) => {
                            tracing::debug!(
                                chain_id,
                                error = format!("{error:#}"),
                                "merkl rewards unavailable for a sickle"
                            );
                            continue;
                        }
                    }
                }
            };
            for chain in chains.iter() {
                merge_merkl_chain(chain, &mut out);
            }
        }
        out
    }

    async fn fetch_merkl(&self, url: &str) -> Result<Arc<Vec<Value>>> {
        let recorded = self.cache.get(&self.client, url).await?;
        if !(200..300).contains(&recorded.status) {
            return Err(anyhow!("merkl rewards returned HTTP {}", recorded.status));
        }
        let body: Value =
            serde_json::from_str(&recorded.body).context("merkl rewards returned non-JSON")?;
        Ok(Arc::new(entries_of(body)))
    }
}

/// Fold one chain block of the Merkl response into the per-token map.
///
/// Split out from the fetch so the parsing is testable without a server — it is where every
/// judgement call lives.
fn merge_merkl_chain(chain: &Value, out: &mut MerklRewards) {
    let Some(rewards) = chain.get("rewards").and_then(Value::as_array) else {
        return;
    };
    for reward in rewards {
        let token = reward.get("token").unwrap_or(&Value::Null);
        let Some(symbol) = non_empty_str(token.get("symbol")) else {
            continue; // `if not (tid.isdigit() and sym)`
        };
        let price = number(token.get("price")).unwrap_or(0.0);
        let decimals = decimals_of(token);

        let Some(breakdowns) = reward.get("breakdowns").and_then(Value::as_array) else {
            continue;
        };
        for breakdown in breakdowns {
            let reason = breakdown
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            // `reason.rsplit("_", 1)[-1] if "_" in reason else ""` — the tail after the LAST
            // underscore, and nothing at all when there is no underscore.
            let Some((_, token_id)) = reason.rsplit_once('_') else {
                continue;
            };
            // `tid.isdigit()`: every character a digit, and non-empty. A reason whose tail is not
            // a token id belongs to no position we can name, so it is dropped rather than guessed.
            if token_id.is_empty() || !token_id.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }

            // `amount - claimed` = still claimable. Both are integer strings in the response;
            // a value that will not parse skips the row, as the Python's `except` does.
            let (Some(amount), Some(claimed)) = (
                raw_amount(breakdown.get("amount"), decimals),
                raw_amount(breakdown.get("claimed").or(Some(&Value::Null)), decimals).or(Some(0.0)),
            ) else {
                continue;
            };
            let claimable = amount - claimed;
            if claimable <= 0.0 {
                continue;
            }

            let entries = out.entry(token_id.to_string()).or_default();
            // Merge the same token across breakdown rows rather than listing it twice — one
            // position earning NEST from two campaigns shows one NEST line.
            match entries.iter_mut().find(|e| e.symbol == symbol) {
                Some(existing) => {
                    existing.amount += claimable;
                    existing.usd = Some(existing.usd.unwrap_or(0.0) + claimable * price);
                }
                None => entries.push(TokenAmt {
                    symbol: symbol.clone(),
                    amount: claimable,
                    usd: Some(claimable * price),
                    ..Default::default()
                }),
            }
        }
    }
}

/// The wallet-level Nest claim one position is eligible for — port of `_nest_entry`.
///
/// Nest self-distributes rather than going through Merkl: its signer issues **one** claim per
/// Sickle covering all that wallet's Nest positions, so vfat reports the identical wallet total on
/// every one of them. There is no per-position figure upstream, which is why
/// [`distribute_nest`] has to derive one.
#[derive(Debug, Clone, PartialEq)]
pub struct NestEntry {
    pub symbol: String,
    /// The wallet-level claimable amount — identical on every position of the same Sickle.
    pub amount: f64,
    pub price: f64,
    /// Campaign id, for the intra-campaign liquidity split.
    pub campaign: String,
    /// Campaign emission rate scaled by its rewarded/pool-liquidity share.
    pub camp_rate: f64,
    /// This position's own liquidity.
    pub liq: f64,
}

pub fn nest_entry(entry: &Value) -> Option<NestEntry> {
    let farm = entry.get("farm").unwrap_or(&Value::Null);
    let farm_rewards = farm.get("offChainRewards").and_then(Value::as_array);
    let first = farm_rewards.and_then(|r| r.first()).unwrap_or(&Value::Null);

    // The set of (protocol, reward-token) pairs this position's own farm actually lists. A
    // position earns only a campaign its farm declares — without this check a wallet-level claim
    // would be attributed to positions that never earned it.
    let earns: Vec<(String, String)> = farm_rewards
        .map(|rewards| {
            rewards
                .iter()
                .filter(|r| r.is_object())
                .map(|r| {
                    (
                        scalar_string(r.get("protocol").unwrap_or(&Value::Null)),
                        r.pointer("/rewardToken/address")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_lowercase(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    for reward in entry
        .get("offChainRewards")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        // `if not e.get("nestClaim"): continue` — a Merkl-backed claim is handled by
        // `merkl_rewards`, and counting it here too would double it.
        if !reward.is_object() || is_falsy(reward.get("nestClaim").unwrap_or(&Value::Null)) {
            continue;
        }
        let token = reward.get("token").unwrap_or(&Value::Null);
        let address = token
            .get("address")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_lowercase();
        let protocol = scalar_string(reward.get("protocol").unwrap_or(&Value::Null));
        if !earns.contains(&(protocol.clone(), address)) {
            continue;
        }

        let Some(symbol) = non_empty_str(token.get("symbol")) else {
            continue;
        };
        // `int(e["amount"]) / 10 ** decimals`, with the Python's `except -> 0.0` then `amt <= 0`.
        let amount = raw_amount(reward.get("amount"), decimals_of(token)).unwrap_or(0.0);
        if amount <= 0.0 {
            continue;
        }

        let snapshot = farm.get("snapshot").unwrap_or(&Value::Null);
        // `rewardsPerSecond` is an 18-decimal integer regardless of the reward token's own
        // decimals — it is an emission rate, not a token balance.
        let rps = raw_amount(first.get("rewardsPerSecond"), 18).unwrap_or(0.0);
        let pool_liq = number(snapshot.get("poolLiquidity")).unwrap_or(0.0);
        let camp_rate = if pool_liq != 0.0 {
            rps * (number(snapshot.get("rewardedLiquidity")).unwrap_or(0.0) / pool_liq)
        } else {
            rps
        };

        return Some(NestEntry {
            symbol,
            amount,
            price: number(token.get("price")).unwrap_or(0.0),
            campaign: non_empty_str(first.get("campaignId")).unwrap_or(protocol),
            camp_rate,
            liq: number(entry.pointer("/nft/liquidity")).unwrap_or(0.0),
        });
    }
    None
}

/// Split the single wallet-level Nest claim into a real per-position share — `_distribute_nest`.
///
/// The claim is one number for the whole Sickle, but each position's *live accrual rate* is
/// observable: campaign emission × the campaign's rewarded/pool-liquidity share, apportioned
/// within a campaign by the position's own liquidity. Splitting by that rate gives every position
/// a distinct, mechanics-grounded share that still sums back to the true claimable total — so
/// wallet totals stay exact and no two positions read identically.
///
/// Falls back to an equal split when no live rate is available (all dust).
pub fn distribute_nest(positions: &mut [Position], entries: &[Option<NestEntry>]) {
    let live: Vec<(usize, &NestEntry)> = entries
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.as_ref().map(|e| (index, e)))
        .collect();
    let Some((_, first)) = live.first() else {
        return;
    };

    // Read once: the claim is identical on every Nest position of the same Sickle.
    let total_amount = first.amount;
    let price = first.price;
    let symbol = first.symbol.clone();

    // campaign -> Σ liquidity, for the intra-campaign split.
    let mut campaign_liquidity: HashMap<&str, f64> = HashMap::new();
    for (_, entry) in &live {
        *campaign_liquidity
            .entry(entry.campaign.as_str())
            .or_default() += entry.liq;
    }

    let weights: Vec<f64> = live
        .iter()
        .map(|(_, entry)| {
            let campaign_total = campaign_liquidity
                .get(entry.campaign.as_str())
                .copied()
                .unwrap_or(0.0);
            let liq_share = if campaign_total > 0.0 {
                entry.liq / campaign_total
            } else {
                // Every position in this campaign is dust: share it equally among them.
                let peers = live
                    .iter()
                    .filter(|(_, other)| other.campaign == entry.campaign)
                    .count();
                1.0 / peers as f64
            };
            entry.camp_rate * liq_share
        })
        .collect();

    let total_weight: f64 = weights.iter().sum();
    let count = live.len() as f64;

    for ((index, _), weight) in live.iter().zip(&weights) {
        let share = if total_weight > 0.0 {
            weight / total_weight
        } else {
            1.0 / count // no live rate anywhere — equal split
        };
        let amount = total_amount * share;
        let usd = amount * price;
        add_reward(
            &mut positions[*index],
            TokenAmt {
                symbol: symbol.clone(),
                amount,
                usd: Some(usd),
                ..Default::default()
            },
        );
    }
}

/// `pos.setdefault("rewards", []).append(r)` plus the matching `rewards_usd` bump.
///
/// The two keys are written together on purpose: `rewards_usd` is the claimable figure the UI
/// shows, and a reward appended without it would be invisible in every total.
fn add_reward(position: &mut Position, reward: TokenAmt) {
    let usd = reward.usd.unwrap_or(0.0);
    position.rewards.get_or_insert_with(Vec::new).push(reward);
    position.rewards_usd = Some(Some(position.rewards_usd.flatten().unwrap_or(0.0) + usd));
}

/// Attach real campaign rewards to each paired position — port of `_attach_campaign_rewards`.
///
/// Merkl rewards are exact per position (keyed by NFT id); the Nest claim is split by live
/// emission rate. Neither changes a position's `usd` — they are *claimable* yield — so this
/// affects what the UI reports as ready to harvest, not net worth.
pub fn attach_campaign_rewards(
    positions: &mut [Position],
    entries: &[Value],
    pairs: &[(usize, usize)],
    merkl: &MerklRewards,
) {
    for (position_index, entry_index) in pairs {
        let token_id = entries[*entry_index]
            .pointer("/nft/id")
            .map(id_text)
            .unwrap_or_default();
        if let Some(rewards) = merkl.get(&token_id) {
            for reward in rewards {
                add_reward(&mut positions[*position_index], reward.clone());
            }
        }
    }

    // Nest is distributed across the same pair set, after Merkl, exactly as the Python orders it.
    let mut ordered_positions: Vec<Option<NestEntry>> = vec![None; positions.len()];
    for (position_index, entry_index) in pairs {
        ordered_positions[*position_index] = nest_entry(&entries[*entry_index]);
    }
    distribute_nest(positions, &ordered_positions);
}

// ===========================================================================================
// Lifecycle — `_vfat_stamp_lifecycle` (portfolio.py L1288)
// ===========================================================================================

/// How long one position's action history is cached — `_vfat_nft_actions`' `_ttl(key, 600, …)`.
///
/// Five times the farm-balances TTL, and deliberately so: balances move with every price tick,
/// while an action list only grows when the user transacts.
pub const NFT_ACTIONS_TTL_SECS: f64 = 600.0;

/// A position's cron-accumulated in-range time, read from `pos_perf`.
///
/// `lyra-chain` speaks HTTP and never SQL, so the rows are fetched by the caller that owns the
/// pool and handed to [`apply_perf`]. That also makes the read one query for a whole portfolio
/// rather than Python's one per chain.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PerfRecord {
    pub in_range_secs: f64,
    /// `NULL`-able in the schema, and the column the `setdefault` in `_vfat_stamp_lifecycle`
    /// falls back to when the action history did not yield a cycle anchor.
    pub cycle_start: Option<i64>,
}

/// The key both the cron (writer) and the build (reader) derive independently — they must agree
/// or the accumulator is invisible. Port of `position_perf.key`.
///
/// `lstrip('#')` strips *every* leading `#`, not one, so `trim_start_matches` is the right
/// counterpart rather than `strip_prefix`.
pub fn perf_key(chain_id: u64, token_id: &str) -> String {
    format!("{chain_id}:{}", token_id.trim_start_matches('#'))
}

/// ISO-8601 (`2026-07-15T14:16:11.000Z`) to epoch seconds — port of `_iso_epoch`.
///
/// Python accepts a bare number as itself and truncates toward zero via `int()`; both are kept.
/// Anything else parses as RFC 3339, and an unparseable string yields `None` rather than an error,
/// because the Python swallows the exception and the field is optional.
pub fn iso_epoch(value: &Value) -> Option<i64> {
    match value {
        Value::Null => None,
        Value::Number(n) => n.as_f64().map(|f| f.trunc() as i64),
        Value::String(s) => chrono_free_parse(s),
        _ => None,
    }
}

/// `datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()`, without pulling `chrono` into
/// this crate.
///
/// Only the shape vfat actually emits is accepted — `YYYY-MM-DDTHH:MM:SS`, an optional fractional
/// part, and an optional `Z` or `±HH:MM`. Field ranges are checked (including the real length of
/// the month) because `fromisoformat` rejects `2026-13-45T99:99:99` and this must too; without the
/// check the arithmetic below would happily return a number for it.
///
/// # One deliberate divergence
///
/// A timestamp with **no** zone is read as UTC here. Python reads it as *local* time, because
/// `datetime.timestamp()` on a naive datetime applies the host's timezone — so the oracle's own
/// answer for `2026-07-15T14:16:11` depends on which machine it runs on (it differs by 7h on the
/// development box, which sits at UTC+7). Reproducing that would mean shipping a timezone database
/// to reproduce a bug. vfat stamps every `blockTimestamp` with `Z`, so no real input reaches this
/// branch.
fn chrono_free_parse(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    // Byte 10 is the date/time separator and is deliberately *not* pinned to `T`:
    // `fromisoformat` accepts any single character there, and the corpus has a space-separated
    // stamp that Python parses.
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&month) || !(1..=days_in_month(year, month)).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    // Fractional seconds are parsed and dropped: `int(...)` in `_iso_epoch` truncates them away,
    // and `.999` must not round the second up.
    let tail = &text[19..];
    let tail = match tail.strip_prefix('.') {
        Some(frac) => {
            let digits = frac.len() - frac.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            if digits == 0 {
                return None;
            }
            &frac[digits..]
        }
        None => tail,
    };
    let offset_secs = match tail {
        "" | "Z" | "z" => 0,
        other => {
            let sign = match other.as_bytes()[0] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let hh = other.get(1..3)?.parse::<i64>().ok()?;
            // `+07` and `+07:00` both parse; anything else after the hours is rejected.
            let mm = match other.len() {
                3 => 0,
                6 if other.as_bytes()[3] == b':' => other.get(4..6)?.parse::<i64>().ok()?,
                _ => return None,
            };
            if hh > 23 || mm > 59 {
                return None;
            }
            sign * (hh * 3600 + mm * 60)
        }
    };

    Some(
        days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second
            - offset_secs,
    )
}

/// Length of a month, so `2026-02-30` is rejected the way `fromisoformat` rejects it.
fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since the Unix epoch for a proleptic-Gregorian date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

impl VfatApi {
    /// One position's on-chain lifecycle, oldest-first — port of `_vfat_nft_actions`.
    ///
    /// Every miss is an empty list, never an error: Python wraps the whole thing in `except:
    /// return []`, and a position whose history we cannot read must still render with its balance.
    /// The four-way guard is Python's `if not (chain_id and sickle and token_id and manager)`,
    /// where `0` and `""` are both falsy — hence the `is_empty` checks rather than `Option` alone.
    pub async fn nft_actions(
        &self,
        chain_id: u64,
        sickle: &str,
        token_id: &str,
        manager: &str,
    ) -> Arc<Vec<Value>> {
        if chain_id == 0 || sickle.is_empty() || token_id.is_empty() || manager.is_empty() {
            return Arc::new(Vec::new());
        }
        let key = format!("vfatact:{chain_id}:{}:{token_id}", sickle.to_lowercase());
        if let Some(hit) = self.actions.get(&key, NFT_ACTIONS_TTL_SECS, self.now()) {
            return hit;
        }

        let url = format!(
            "{VFAT_API}/sickle-nft-actions?chainId={chain_id}&sickleAddress={sickle}\
             &tokenId={token_id}&nftManagerAddress={manager}"
        );
        let actions = match self.fetch_actions(&url).await {
            Ok(actions) => actions,
            Err(error) => {
                // Not cached, so the next build retries — the same as Python, whose `_ttl` only
                // stores what `fetch` returned without raising.
                tracing::debug!(
                    chain_id,
                    token_id,
                    error = format!("{error:#}"),
                    "vfat sickle-nft-actions failed; position has no lifecycle this build"
                );
                return Arc::new(Vec::new());
            }
        };
        self.actions.put(&key, actions.clone(), self.now());
        actions
    }

    async fn fetch_actions(&self, url: &str) -> Result<Arc<Vec<Value>>> {
        let recorded = self.cache.get(&self.client, url).await?;
        if !(200..300).contains(&recorded.status) {
            return Err(anyhow!(
                "sickle-nft-actions returned HTTP {}",
                recorded.status
            ));
        }
        let body: Value =
            serde_json::from_str(&recorded.body).context("sickle-nft-actions returned non-JSON")?;
        let mut actions = entries_of(body);
        // `sorted(acts, key=lambda a: a.get("blockTimestamp") or "")` — a *string* sort, and a
        // missing timestamp sorts first as "". Kept literally: these are fixed-width ISO-8601
        // stamps, where lexical and chronological order coincide, and Python's `sorted` is stable
        // so equal keys keep feed order.
        actions.sort_by(|a, b| action_stamp(a).cmp(action_stamp(b)));
        Ok(Arc::new(actions))
    }
}

/// `a.get("blockTimestamp") or ""` — a non-string (or absent, or `null`) stamp sorts as empty,
/// exactly as the Python `or ""` collapses every falsy value.
fn action_stamp(action: &Value) -> &str {
    match action.get("blockTimestamp") {
        Some(Value::String(s)) => s.as_str(),
        _ => "",
    }
}

/// Stamp one position's lifecycle from its action history — the body of `_vfat_stamp_lifecycle`'s
/// `one()`, minus the perf join (see [`apply_perf`]).
///
/// A no-op on an empty history, matching `if acts:` — the position keeps whatever it had, rather
/// than gaining a set of null fields it did not have before.
pub fn stamp_lifecycle(position: &mut Position, actions: &[Value]) {
    let (Some(first), Some(last)) = (actions.first(), actions.last()) else {
        return;
    };

    // `.get()` on a dict: the key is always written, with `null` when the field is absent — which
    // is why these are `Nullable` and not `Option`. Dropping the key instead would be a visible
    // contract change for the UI.
    position.deployed_at = Some(non_empty_str(first.get("blockTimestamp")));
    position.updated_at = Some(non_empty_str(last.get("blockTimestamp")));
    position.last_action = Some(non_empty_str(last.get("actionType")));

    // The cycle anchor: the latest `harvest*` action, else the deploy. `last_harvest_at` is set
    // only when a harvest exists — Python leaves the key absent otherwise, and the UI reads its
    // absence as "never harvested this position".
    let last_harvest = actions.iter().rfind(|action| {
        action
            .get("actionType")
            .and_then(Value::as_str)
            .is_some_and(|t| t.to_lowercase().contains("harvest"))
    });
    if let Some(harvest) = last_harvest {
        position.last_harvest_at = Some(non_empty_str(harvest.get("blockTimestamp")));
    }

    // `_iso_epoch(pos.get("last_harvest_at") or acts[0].get("blockTimestamp"))` — note the `or`
    // reads back the value just written, so an empty-string harvest stamp falls through to the
    // deploy stamp rather than anchoring the cycle at the epoch.
    let anchor = position
        .last_harvest_at
        .clone()
        .flatten()
        .filter(|s| !s.is_empty())
        .map(Value::String)
        .or_else(|| first.get("blockTimestamp").cloned())
        .unwrap_or(Value::Null);
    position.cycle_start = Some(iso_epoch(&anchor));
}

/// Stamp the perf key every vfat-feed position must carry — the loop at `portfolio.py:1300-1303`.
///
/// Written before the history fetch and independently of it, so a position whose action history
/// failed still joins to its accumulator.
pub fn stamp_perf_key(position: &mut Position, entry: &Value) {
    let (Some(chain_id), Some(id)) = (entry_chain_id(entry), entry.pointer("/nft/id")) else {
        return;
    };
    if id.is_null() {
        return; // Python's `tid is not None`
    }
    position.perf_key = Some(perf_key(chain_id, &id_text(id)));
}

/// Join the cron's in-range accumulators onto positions already carrying a `perf_key`.
///
/// The `cycle_start` half is `setdefault`, not assignment: a cycle anchor derived from the action
/// history wins, and this only fills in for a position whose history was unavailable. Getting that
/// backwards would silently re-anchor every position to the cron's first sighting of it.
pub fn apply_perf(positions: &mut [Position], perf: &HashMap<String, PerfRecord>) {
    for position in positions {
        let Some(record) = position.perf_key.as_ref().and_then(|k| perf.get(k)) else {
            continue;
        };
        position.in_range_secs = Some(record.in_range_secs);
        if position.cycle_start.is_none() {
            position.cycle_start = Some(record.cycle_start);
        }
    }
}

/// Pair each position with the feed entry it came from, by chain and NFT id.
///
/// Returns indices rather than references so the caller can keep mutating `positions`; the feed
/// is the authority on which entry a position belongs to, and ids are unique per chain — the same
/// assumption Python's `targets` dict makes.
pub fn lifecycle_pairs(
    entries: &[Value],
    chain_id: u64,
    positions: &[Position],
) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for (entry_index, entry) in entries.iter().enumerate() {
        if !entry.is_object() || entry_chain_id(entry) != Some(chain_id) {
            continue;
        }
        let Some(feed_id) = entry.pointer("/nft/id").map(id_text) else {
            continue;
        };
        if let Some(position_index) = positions
            .iter()
            .position(|p| position_id(p).as_deref() == Some(feed_id.as_str()))
        {
            pairs.push((position_index, entry_index));
        }
    }
    pairs
}

/// Python's `ThreadPoolExecutor(max_workers=min(6, len(pairs)))` — a wallet with forty positions
/// must not open forty sockets against an API that rate-limits.
pub const LIFECYCLE_CONCURRENCY: usize = 6;

/// Fetch and stamp every paired position's lifecycle concurrently — `_vfat_stamp_lifecycle`.
///
/// Best-effort by construction: [`VfatApi::nft_actions`] never fails, so an unreachable history
/// costs that one position its lifecycle fields and nothing else. The perf key is written for
/// every pair *before* the fetch, so a position whose history is unavailable still joins to its
/// accumulator in [`apply_perf`].
pub async fn stamp_lifecycle_all(
    api: Arc<VfatApi>,
    entries: &[Value],
    chain_id: u64,
    positions: &mut [Position],
) {
    let pairs = lifecycle_pairs(entries, chain_id, positions);
    if pairs.is_empty() {
        return;
    }

    let permits = Arc::new(tokio::sync::Semaphore::new(LIFECYCLE_CONCURRENCY));
    let mut set: JoinSet<(usize, Arc<Vec<Value>>)> = JoinSet::new();

    for (position_index, entry_index) in pairs {
        let entry = &entries[entry_index];
        stamp_perf_key(&mut positions[position_index], entry);

        // Owned before the spawn: the task outlives this borrow of `entries`.
        let sickle = non_empty_str(entry.get("sickleAddress")).unwrap_or_default();
        let token_id = entry.pointer("/nft/id").map(id_text).unwrap_or_default();
        let manager = non_empty_str(entry.pointer("/nft/managerAddress")).unwrap_or_default();
        let api = Arc::clone(&api);
        let permits = Arc::clone(&permits);
        set.spawn(async move {
            // Cannot fail: the semaphore outlives every task holding a clone.
            let _permit = permits.acquire_owned().await;
            (
                position_index,
                api.nft_actions(chain_id, &sickle, &token_id, &manager)
                    .await,
            )
        });
    }

    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((position_index, actions)) => {
                stamp_lifecycle(&mut positions[position_index], &actions)
            }
            // A panicked task would otherwise abort the whole chain read. The position keeps its
            // balance and loses only its lifecycle, which is this pass's contract anyway.
            Err(error) => {
                tracing::warn!(chain_id, error = %error, "vfat lifecycle task failed")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains;
    use crate::evm::MockRpc;
    use crate::http_cache::Mode;
    use crate::prices::ManualClock;
    use serde_json::json;
    use std::path::PathBuf;

    const WALLET: &str = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    const SICKLE: &str = "0x1111111111111111111111111111111111111111";

    fn hyperevm() -> &'static Chain {
        chains::by_name("hyperevm").expect("hyperevm is configured")
    }

    // ---------------------------------------------------------------- Sickle resolution

    fn factory_returning(sickle: &str) -> MockRpc {
        MockRpc::new()
            .returns(
                &Address::from_hex(VFAT_FACTORY).unwrap().to_checksum(),
                SICKLES_SIGNATURE,
                &[AbiValue::address(WALLET).unwrap()],
                &[AbiValue::address(sickle).unwrap()],
            )
            .expect("stub encodes")
    }

    #[tokio::test]
    async fn a_wallet_with_a_sickle_resolves_both_owners() {
        let rpc = factory_returning(SICKLE);
        let owners = resolve_owners(&rpc, WALLET, VFAT_FACTORY, None).await;

        assert_eq!(owners.len(), 2, "the wallet AND the proxy holding for it");
        assert_eq!(owners[0].address, WALLET, "the wallet comes first");
        assert_eq!(owners[0].via, None);
        assert_eq!(
            owners[1].address,
            Address::from_hex(SICKLE).unwrap().to_checksum()
        );
        assert_eq!(
            owners[1].via,
            Some(VIA_VFAT),
            "a proxy-held position must be labelled with how it is reached"
        );
    }

    #[tokio::test]
    async fn a_wallet_without_a_sickle_resolves_to_itself_only() {
        let rpc = factory_returning("0x0000000000000000000000000000000000000000");
        let owners = resolve_owners(&rpc, WALLET, VFAT_FACTORY, None).await;
        assert_eq!(owners.len(), 1);
        assert_eq!(owners[0].via, None);
    }

    #[tokio::test]
    async fn an_undeployed_factory_yields_no_sickle_instead_of_an_error() {
        // A node answers a call to a codeless address with `0x`; Python skips the call entirely
        // after `get_code` comes back empty. Both mean "no Sickle on this chain".
        let rpc = MockRpc::new()
            .returns_nothing(
                &Address::from_hex(VFAT_FACTORY).unwrap().to_checksum(),
                SICKLES_SIGNATURE,
            )
            .unwrap();
        assert_eq!(vfat_sickle(&rpc, WALLET, VFAT_FACTORY).await, None);
        assert_eq!(
            resolve_owners(&rpc, WALLET, VFAT_FACTORY, None).await.len(),
            1
        );
    }

    #[tokio::test]
    async fn a_reverting_factory_yields_no_sickle() {
        let rpc = MockRpc::new()
            .reverts(
                &Address::from_hex(VFAT_FACTORY).unwrap().to_checksum(),
                SICKLES_SIGNATURE,
                "no sickle",
            )
            .unwrap();
        assert_eq!(vfat_sickle(&rpc, WALLET, VFAT_FACTORY).await, None);
    }

    #[tokio::test]
    async fn a_supplied_sickle_skips_the_lookup_entirely() {
        // An empty mock: any RPC call would be an error, so reaching zero calls proves the
        // caller-supplied value short-circuits (Python's `sickle is not None` sentinel).
        let rpc = MockRpc::new();
        let owners = resolve_owners(&rpc, WALLET, VFAT_FACTORY, Some(SICKLE)).await;
        assert_eq!(owners.len(), 2);
        assert_eq!(
            rpc.call_count(),
            0,
            "no RPC when the Sickle is already known"
        );
    }

    #[tokio::test]
    async fn a_chain_local_factory_is_used_when_configured() {
        let chain = hyperevm();
        let factory = factory_for(chain);
        assert_eq!(
            factory, "0x233d9067677dcf1a161954d45b4c965b9d567168",
            "HyperEVM deploys its own SickleFactory; the global one is not there"
        );
        let rpc = MockRpc::new()
            .returns(
                &Address::from_hex(factory).unwrap().to_checksum(),
                SICKLES_SIGNATURE,
                &[AbiValue::address(WALLET).unwrap()],
                &[AbiValue::address(SICKLE).unwrap()],
            )
            .unwrap();
        assert!(vfat_sickle(&rpc, WALLET, factory).await.is_some());
        assert_eq!(factory_for(chains::by_name("base").unwrap()), VFAT_FACTORY);
    }

    #[tokio::test]
    async fn the_factory_is_asked_about_the_wallet_not_the_proxy() {
        let rpc = factory_returning(SICKLE);
        resolve_owners(&rpc, WALLET, VFAT_FACTORY, None).await;
        let call = rpc.calls().into_iter().next().expect("one call was made");
        assert_eq!(call.to, VFAT_FACTORY.to_lowercase());
        assert!(
            call.data
                .to_lowercase()
                .contains(&WALLET[2..].to_lowercase()),
            "the wallet address must be the argument: {}",
            call.data
        );
    }

    // ---------------------------------------------------------------- position mapping

    /// A HyperEVM concentrated-liquidity entry.
    ///
    /// **HAND-WRITTEN**, not recorded. Field names and types are copied from a real recorded
    /// farm-balances response (see `a_real_recorded_response_parses`) and from the keys
    /// `_vfat_api_position` reads; the wallet used for the real recording holds no HyperEVM CL
    /// position, so this shape could not be captured live.
    fn cl_entry() -> Value {
        json!({
          "chainId": 999,
          "type": "HYPERSWAP_V3",
          "wallet": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
          "sickleAddress": "0x1111111111111111111111111111111111111111",
          "fee": 3000,
          "tickSpacing": 60,
          "tick": 100,
          "nft": {"id": 8412, "tickLow": -60, "tickUp": 300,
                  "fees0": "1500000000000000", "fees1": "2500000",
                  "poolAddress": "0xpool"},
          "farm": {"depositOptionKind": "GAUGE_STAKE",
                   "protocol": {"name": "Hyperswap"},
                   "snapshot": {"apr": 42.5}},
          "pendingRewards": [
            {"amount": "3000000000000000000",
             "token": {"symbol": "HYBR", "decimals": 18, "price": 0.25}}
          ],
          "underlying": [
            {"symbol": "WHYPE", "decimals": 18, "balance": "2.5", "price": 40.0,
             "percentChange24h": 5.0},
            {"symbol": "USDC", "decimals": 6, "balance": "100.0", "price": 1.0,
             "percentChange24h": -1.0}
          ]
        })
    }

    #[test]
    fn a_cl_entry_maps_to_a_priced_position() {
        let position = vfat_api_position(&cl_entry()).expect("a two-token LP maps");
        assert_eq!(position.protocol, "Hyperswap");
        assert_eq!(position.category, "Liquidity Pool");
        assert_eq!(
            position.name, "WHYPE/USDC 0.30%",
            "fee 3000 renders as 0.30%"
        );
        assert_eq!(position.id, Some(Some("#8412".to_string())));
        assert_eq!(position.via.as_deref(), Some(VIA_VFAT));
        assert_eq!(position.usd, Some(200.0), "2.5 * $40 + 100 * $1");
        assert_eq!(position.tokens.len(), 2);
        assert_eq!(position.tokens[0].usd, Some(100.0));
        assert_eq!(position.tokens[1].amount, 100.0);
    }

    #[test]
    fn token_decimals_scale_the_fee_legs_independently() {
        // The 10^12 trap again: fees1 is a 6-decimal token. Reading it as 18 would report
        // 0.0000000000025 USDC instead of 2.5.
        let position = vfat_api_position(&cl_entry()).unwrap();
        let rewards = position.rewards.as_ref().unwrap();
        assert!(
            (rewards[0].amount - 0.0015).abs() < 1e-12,
            "18-decimal leg: {}",
            rewards[0].amount
        );
        assert!(
            (rewards[1].amount - 2.5).abs() < 1e-12,
            "6-decimal leg: {}",
            rewards[1].amount
        );
    }

    #[test]
    fn claimable_yield_sums_swap_fees_and_gauge_emissions() {
        let position = vfat_api_position(&cl_entry()).unwrap();
        // swap fees: 0.0015 WHYPE * $40 + 2.5 USDC * $1 = $2.56
        assert!((position.swap_fees_usd.unwrap() - 2.56).abs() < 1e-9);
        // plus 3 HYBR * $0.25 = $0.75
        let rewards_usd = position
            .rewards_usd
            .flatten()
            .expect("both keys are written");
        assert!(
            (rewards_usd - 3.31).abs() < 1e-9,
            "swap fees alone would read as 'no farm yield': {rewards_usd}"
        );
        let rewards = position.rewards.unwrap();
        assert_eq!(rewards.len(), 3, "both fee legs plus the gauge token");
        assert_eq!(rewards[2].symbol, "HYBR");
    }

    #[test]
    fn both_fee_legs_are_emitted_even_when_zero() {
        // The front end treats "has rewards" as the marker of an LP position; omitting empty legs
        // would hide the position entirely.
        let mut entry = cl_entry();
        entry["nft"]["fees0"] = json!("0");
        entry["nft"]["fees1"] = json!("0");
        entry["pendingRewards"] = json!([]);
        let position = vfat_api_position(&entry).unwrap();
        let rewards = position.rewards.unwrap();
        assert_eq!(rewards.len(), 2);
        assert_eq!(rewards[0].amount, 0.0);
        assert_eq!(position.rewards_usd.flatten(), Some(0.0));
    }

    #[test]
    fn the_range_check_is_inclusive_at_both_ends() {
        let mut entry = cl_entry();
        assert_eq!(vfat_api_position(&entry).unwrap().in_range, Some(true));

        entry["tick"] = json!(-60); // exactly the lower tick
        assert_eq!(
            vfat_api_position(&entry).unwrap().in_range,
            Some(true),
            "vfat's own check is `tl <= cur <= tu`, unlike the RPC path's half-open range"
        );
        entry["tick"] = json!(300); // exactly the upper tick
        assert_eq!(vfat_api_position(&entry).unwrap().in_range, Some(true));
        entry["tick"] = json!(301);
        assert_eq!(vfat_api_position(&entry).unwrap().in_range, Some(false));
    }

    #[test]
    fn a_missing_tick_leaves_range_and_band_absent() {
        let mut entry = cl_entry();
        entry["tick"] = Value::Null;
        let position = vfat_api_position(&entry).unwrap();
        assert_eq!(position.in_range, None, "unknown, not false");
        assert_eq!(position.price_band, None);
    }

    #[test]
    fn a_single_token_entry_is_not_a_position() {
        let mut entry = cl_entry();
        entry["underlying"] = json!([{"symbol": "WHYPE", "decimals": 18, "balance": "1"}]);
        assert!(vfat_api_position(&entry).is_none());

        entry["underlying"] = json!([]);
        assert!(vfat_api_position(&entry).is_none());
    }

    #[test]
    fn the_24h_change_is_value_weighted() {
        // $100 at +5% and $100 at -1% blends to +2%, not the +4% a naive mean would give.
        let position = vfat_api_position(&cl_entry()).unwrap();
        let change = position.change24h.flatten().expect("both tokens have data");
        assert!((change - 2.0).abs() < 1e-9, "got {change}");
    }

    #[test]
    fn vfats_apr_and_range_band_are_stamped() {
        let position = vfat_api_position(&cl_entry()).unwrap();
        assert_eq!(position.apr, Some(42.5));
        assert_eq!(position.tick_spacing, Some(60));
        let range = position.range_pct.expect("derived from the band");
        assert!(range.width > 0.0);
        assert!(range.min.unwrap() < 0.0, "the lower edge is below spot");
        assert!(range.max.unwrap() > 0.0);
    }

    #[test]
    fn vfats_own_range_percentages_win_over_the_derived_ones() {
        let mut entry = cl_entry();
        entry["guaranteedAprPricePercentRange"] =
            json!({"minPricePercent": -3.5, "maxPricePercent": 4.0, "widthPercent": 7.5});
        let range = vfat_api_position(&entry).unwrap().range_pct.unwrap();
        assert_eq!(range.width, 7.5);
        assert_eq!(range.min, Some(-3.5));
    }

    #[test]
    fn the_apr_falls_back_to_lp_apr() {
        let mut entry = cl_entry();
        entry["farm"]["snapshot"] = json!({"lpApr": 12.0});
        assert_eq!(vfat_api_position(&entry).unwrap().apr, Some(12.0));
    }

    #[test]
    fn a_staked_position_is_a_farm_and_a_bare_lp_is_a_pool() {
        assert_eq!(
            vfat_api_position(&cl_entry()).unwrap().pool_type.as_deref(),
            Some("farm"),
            "depositOptionKind GAUGE_STAKE"
        );

        let mut entry = cl_entry();
        entry["farm"] = json!({"protocol": {"name": "Hyperswap"}});
        entry["pendingRewards"] = json!([]);
        assert_eq!(
            vfat_api_position(&entry).unwrap().pool_type.as_deref(),
            Some("pool"),
            "no reward token of any kind"
        );

        entry["farm"] = json!({"offChainRewards": [{"campaign": "x"}]});
        assert_eq!(
            vfat_api_position(&entry).unwrap().pool_type.as_deref(),
            Some("farm"),
            "an off-chain campaign still makes it a farm"
        );
    }

    #[test]
    fn the_protocol_falls_back_to_a_title_cased_type() {
        let mut entry = cl_entry();
        entry["farm"] = json!({"snapshot": {"apr": 1.0}});
        assert_eq!(vfat_api_position(&entry).unwrap().protocol, "Hyperswap V3");

        entry["type"] = Value::Null;
        assert_eq!(
            vfat_api_position(&entry).unwrap().protocol,
            "Uniswap V3",
            "Python applies .title() to the fallback too — capital V, not the literal in the source"
        );
    }

    #[test]
    fn python_title_matches_the_oracle() {
        assert_eq!(python_title("EQUALIZER LP"), "Equalizer Lp");
        assert_eq!(python_title("hyperswap v3"), "Hyperswap V3");
        assert_eq!(python_title("uni v3"), "Uni V3");
        assert_eq!(python_title(""), "");
    }

    #[test]
    fn a_raw_amount_with_a_fraction_is_zero_not_a_guess() {
        // Python's `int("1.5")` raises ValueError and the except returns 0.0.
        assert_eq!(raw_amount(Some(&json!("1.5")), 18), None);
        assert_eq!(raw_amount(Some(&json!("100")), 2), Some(1.0));
        assert_eq!(raw_amount(Some(&Value::Null), 18), None);
    }

    // ---------------------------------------------------------------- the adapter

    #[test]
    fn only_the_requested_chains_positions_are_returned() {
        let arbitrum_entry = json!({"chainId": 42161, "type": "EQUALIZER_LP",
            "underlying": [{"symbol": "A", "balance": "1", "price": 100.0},
                           {"symbol": "B", "balance": "1", "price": 100.0}]});
        let entries = vec![cl_entry(), arbitrum_entry];

        let hyper = positions_for_chain(&entries, Some(999));
        assert_eq!(hyper.len(), 1);
        assert_eq!(hyper[0].protocol, "Hyperswap");

        assert_eq!(positions_for_chain(&entries, Some(42161)).len(), 1);
        assert!(
            positions_for_chain(&entries, None).is_empty(),
            "a chain with no configured id matches nothing"
        );
    }

    #[test]
    fn a_position_below_a_cent_is_dropped_but_exactly_a_cent_is_kept() {
        let mut entry = cl_entry();
        entry["underlying"][0]["balance"] = json!("0");
        entry["underlying"][1]["balance"] = json!("0.01");
        assert_eq!(
            positions_for_chain(std::slice::from_ref(&entry), Some(999)).len(),
            1,
            "the vfat threshold is `>= 0.01`, unlike the spot dust cut's `> 0.01`"
        );

        entry["underlying"][1]["balance"] = json!("0.009");
        assert!(positions_for_chain(&[entry], Some(999)).is_empty());
    }

    #[test]
    fn malformed_entries_are_skipped_rather_than_fatal() {
        let entries = vec![json!("not an object"), json!(null), json!({}), cl_entry()];
        assert_eq!(positions_for_chain(&entries, Some(999)).len(), 1);
    }

    #[test]
    fn the_sickle_holding_a_position_is_recoverable_from_the_feed() {
        // This is the proxy case from the API side: the position is held by the Sickle, and it is
        // reported under the *wallet's* query. An adapter keyed on the wallet address alone would
        // never see it.
        let entries = vec![cl_entry()];
        assert_eq!(
            sickle_addresses(&entries, Some(999)),
            vec![SICKLE.to_string()]
        );
        assert_eq!(
            entries[0]["wallet"].as_str().unwrap(),
            WALLET.to_lowercase(),
            "the feed is keyed by the EOA even though the NFT belongs to the proxy"
        );
        let position = positions_for_chain(&entries, Some(999)).remove(0);
        assert_eq!(
            position.via.as_deref(),
            Some(VIA_VFAT),
            "every position from this feed is proxy-held and must say so"
        );
    }

    // ---------------------------------------------------------------- caching / outage

    fn fixtures() -> HttpCache {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mode = if Mode::from_env() == Mode::Record {
            Mode::Record
        } else {
            Mode::Replay
        };
        HttpCache::new(dir, mode)
    }

    /// An API pointed at an empty directory in replay mode: every fetch fails, which is exactly
    /// what a vfat outage looks like from here.
    fn broken_api(clock: Arc<ManualClock>) -> VfatApi {
        let dir = std::env::temp_dir().join("lyra-vfat-no-fixtures");
        VfatApi::with_clock(
            reqwest::Client::new(),
            HttpCache::new(dir, Mode::Replay),
            clock,
        )
    }

    #[tokio::test]
    async fn a_real_recorded_response_parses() {
        // REAL fixture, recorded with LYRA_HTTP_CACHE=record against api.vfat.io. The wallet holds
        // one Arbitrum position and nothing on HyperEVM, which makes it a genuine check of the
        // chain filter: the same feed must yield a position for 42161 and none for 999.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock);
        let entries = api.farm_balances(WALLET).await.expect("recorded response");

        assert!(!entries.is_empty(), "the recorded wallet holds a position");
        assert!(
            entries.iter().all(|e| e.get("chainId").is_some()),
            "every entry carries the chain it belongs to"
        );
        assert!(
            positions_for_chain(&entries, Some(999)).is_empty(),
            "nothing on HyperEVM for this wallet"
        );
    }

    #[tokio::test]
    async fn a_second_call_inside_the_window_does_not_refetch() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        let first = api.farm_balances(WALLET).await.unwrap();

        // Uppercased: the cache key is `owner.lower()`, so this must hit the same entry.
        clock.advance(FARM_BALANCES_TTL_SECS - 1.0);
        let second = api.farm_balances(&WALLET.to_uppercase()).await.unwrap();
        assert!(Arc::ptr_eq(&first, &second), "served from the TTL cache");
    }

    #[tokio::test]
    async fn past_the_window_the_feed_is_refetched() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        let first = api.farm_balances(WALLET).await.unwrap();

        clock.advance(FARM_BALANCES_TTL_SECS + 1.0);
        let second = api.farm_balances(WALLET).await.unwrap();
        assert!(
            !Arc::ptr_eq(&first, &second),
            "past 120s the cache must not answer — this is a fresh parse of the response"
        );
        assert_eq!(*first, *second, "same fixture, so the same positions");
    }

    #[tokio::test]
    async fn a_dead_api_serves_the_last_good_response_for_an_hour() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock.clone());

        // Seed a last-good response the only way the type allows: a successful fetch. With no
        // fixtures every fetch fails, so prime it from the recorded API and hand the entries over.
        let primed = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        let good = primed.farm_balances(WALLET).await.unwrap();
        api.remember(&WALLET.to_lowercase(), good.clone());

        // 59 minutes in: the API is down and the cache carries the day.
        clock.advance(3_540.0);
        let served = api
            .farm_balances(WALLET)
            .await
            .expect("a stale answer beats no answer");
        assert_eq!(*served, *good, "the previous response, unchanged");
        assert!(api.last_good_age(WALLET).unwrap() >= 3_540.0);
    }

    #[tokio::test]
    async fn a_dead_api_past_the_window_propagates_the_failure() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock.clone());
        let primed = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        api.remember(
            &WALLET.to_lowercase(),
            primed.farm_balances(WALLET).await.unwrap(),
        );

        clock.advance(LAST_GOOD_MAX_AGE_SECS + 1.0);
        let error = api
            .farm_balances(WALLET)
            .await
            .expect_err("an hour-old answer is no longer worth serving");
        let text = format!("{error:#}");
        assert!(text.contains("old"), "the age must be reported: {text}");
    }

    #[tokio::test]
    async fn a_dead_api_with_no_cache_at_all_fails_loudly() {
        // The distinction that matters: this is "we cannot see your positions", not "you have
        // none". Returning an empty list here would render as a wallet that lost its LPs.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock);
        let error = api
            .farm_balances(WALLET)
            .await
            .expect_err("no data anywhere");
        assert!(format!("{error:#}").contains("no cached copy"), "{error:#}");
    }

    #[tokio::test]
    async fn serving_stale_data_does_not_stop_the_next_call_retrying() {
        // Python never writes the stale answer into the 120s cache, so recovery is immediate. If
        // it did, an outage would pin the dashboard to stale data for two more minutes *after*
        // vfat came back.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock.clone());
        let primed = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        api.remember(
            &WALLET.to_lowercase(),
            primed.farm_balances(WALLET).await.unwrap(),
        );

        let stale_age_before = api.last_good_age(WALLET).unwrap();
        clock.advance(10.0);
        api.farm_balances(WALLET).await.expect("stale served");
        let stale_age_after = api.last_good_age(WALLET).unwrap();
        assert!(
            stale_age_after > stale_age_before,
            "serving from the cache must not restamp it, or the hour would never expire"
        );
    }

    #[tokio::test]
    async fn a_non_vfat_chain_is_skipped_without_touching_the_api() {
        // Double-counting guard: Base is read over RPC by the v3/Aerodrome adapters.
        let clock = Arc::new(ManualClock::new(0.0));
        let api = broken_api(clock);
        let base = chains::by_name("base").unwrap();
        assert!(!base.vfat_api);
        assert!(
            adapt_vfat_api(Arc::new(api), base, WALLET)
                .await
                .unwrap()
                .is_empty(),
            "an RPC-readable chain must not also come from the vfat feed"
        );
    }

    #[tokio::test]
    async fn the_adapter_reads_the_feed_for_a_vfat_chain() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock);
        let positions = adapt_vfat_api(Arc::new(api), hyperevm(), WALLET)
            .await
            .unwrap();
        assert!(
            positions.is_empty(),
            "the recorded wallet has no HyperEVM positions"
        );
    }

    // ---------------------------------------------------------------- yield radar

    /// A yield-opportunities item.
    ///
    /// **HAND-WRITTEN**, not recorded — the filters need specific APR/TVL/symbol combinations that
    /// a live response will not reliably contain. The field layout (`pool.underlying[].symbol`,
    /// `pool.address`, `pool.currentFee`, `options[].{apr,totalLiquidity,protocol{name,url}}`) is
    /// copied from the real recorded response in `a_real_recorded_opportunities_response_parses`.
    fn opportunity(sym0: &str, sym1: &str, apr: f64, tvl: f64) -> Value {
        json!({
          "chainId": 999,
          "pool": {"address": "0xpool00000000000000000000000000000000cafe",
                   "symbol": "UNI-V3", "type": "concentrated", "currentFee": 100,
                   "underlying": [{"symbol": sym0, "decimals": 18, "price": 1.0},
                                  {"symbol": sym1, "decimals": 6, "price": 1.0}]},
          "options": [{"kind": "lp-stake", "apr": apr, "totalLiquidity": tvl,
                       "protocol": {"id": "hyperswap", "name": "Hyperswap",
                                    "url": "https://app.hyperswap.exchange"}}]
        })
    }

    /// The user holds WHYPE/USDC on HyperEVM at 42.5% APR, in pool 0x…beef.
    fn profile() -> RadarProfile {
        let mut entry = cl_entry();
        entry["nft"]["poolAddress"] = json!("0xBEEF000000000000000000000000000000000000");
        radar_profile(&[entry])
    }

    fn radar(items: &[Value]) -> Vec<YieldOpportunity> {
        let profile = profile();
        let held = profile.held[0].1.clone();
        rank_radar(
            radar_candidates(&profile, Some(999), &held, items),
            RADAR_LIMIT_DEFAULT,
        )
    }

    #[test]
    fn the_profile_captures_what_the_user_already_has() {
        let profile = profile();
        assert_eq!(profile.held.len(), 1);
        assert_eq!(profile.held[0].0, Some(999));
        assert_eq!(profile.held[0].1, vec!["WHYPE", "USDC"], "upper-cased");
        assert_eq!(profile.best_apr, 42.5, "the APR a suggestion must beat");
        assert_eq!(
            profile.in_pools,
            vec![(
                Some(999),
                "0xbeef000000000000000000000000000000000000".to_string()
            )],
            "lower-cased, so the address compare is case-insensitive"
        );
    }

    #[test]
    fn a_better_pool_in_a_token_the_user_holds_is_suggested() {
        let found = radar(&[opportunity("WHYPE", "USDC", 90.0, 50_000.0)]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].pair, "WHYPE/USDC");
        assert_eq!(found[0].chain, "hyperevm", "the id is resolved to a name");
        assert_eq!(found[0].apr, 90.0);
        assert_eq!(found[0].tvl, 50_000.0);
        assert_eq!(found[0].protocol.as_deref(), Some("Hyperswap"));
        assert_eq!(found[0].fee, Some(100.0));
        assert_eq!(found[0].tokens, vec!["WHYPE", "USDC"]);
    }

    #[test]
    fn a_pool_no_better_than_the_users_own_is_not_an_opportunity() {
        assert!(
            radar(&[opportunity("WHYPE", "USDC", 42.5, 50_000.0)]).is_empty(),
            "equal to the current best APR is not better — the compare is `apr <= best`"
        );
        assert!(radar(&[opportunity("WHYPE", "USDC", 10.0, 50_000.0)]).is_empty());
        assert_eq!(
            radar(&[opportunity("WHYPE", "USDC", 42.6, 50_000.0)]).len(),
            1
        );
    }

    #[test]
    fn a_dust_pool_is_rejected_however_good_its_apr_looks() {
        // Incentive-driven APRs run to five figures on pools with no liquidity; the floor is what
        // keeps the radar honest.
        assert!(radar(&[opportunity("WHYPE", "USDC", 35_000.0, 9_999.0)]).is_empty());
        assert_eq!(
            radar(&[opportunity("WHYPE", "USDC", 35_000.0, 10_000.0)]).len(),
            1,
            "the floor is `tvl < 10_000`, so exactly the floor passes"
        );
    }

    #[test]
    fn a_pool_the_user_is_already_in_is_never_suggested_back() {
        let mut item = opportunity("WHYPE", "USDC", 90.0, 50_000.0);
        item["pool"]["address"] = json!("0xBeEf000000000000000000000000000000000000");
        assert!(
            radar(&[item]).is_empty(),
            "matched case-insensitively against the user's own pools"
        );
    }

    #[test]
    fn a_pair_must_contain_something_the_user_holds() {
        assert!(
            radar(&[opportunity("WBTC", "USDT", 90.0, 50_000.0)]).is_empty(),
            "both legs are majors, but the user holds neither"
        );
    }

    #[test]
    fn a_degen_leg_disqualifies_the_pair() {
        assert!(
            radar(&[opportunity("WHYPE", "SCAMCOIN", 90.0, 50_000.0)]).is_empty(),
            "one held token is not enough — the other leg must be a major or also held"
        );
        assert_eq!(
            radar(&[opportunity("WHYPE", "WSTETH", 90.0, 50_000.0)]).len(),
            1,
            "a major on the other side is fine"
        );
    }

    #[test]
    fn a_single_token_or_three_token_pool_is_skipped() {
        let mut item = opportunity("WHYPE", "USDC", 90.0, 50_000.0);
        item["pool"]["underlying"] = json!([{"symbol": "WHYPE"}]);
        assert!(radar(&[item.clone()]).is_empty());
        item["pool"]["underlying"] =
            json!([{"symbol": "WHYPE"}, {"symbol": "USDC"}, {"symbol": "DAI"}]);
        assert!(radar(&[item]).is_empty());
    }

    #[test]
    fn the_best_option_of_a_pool_wins_and_ties_keep_the_first() {
        let mut item = opportunity("WHYPE", "USDC", 60.0, 50_000.0);
        item["options"] = json!([
            {"apr": 60.0, "totalLiquidity": 50_000.0, "protocol": {"name": "First"}},
            {"apr": 90.0, "totalLiquidity": 80_000.0, "protocol": {"name": "Best"}},
            {"apr": 90.0, "totalLiquidity": 10_000.0, "protocol": {"name": "TiedButLater"}}
        ]);
        let found = radar(&[item]);
        assert_eq!(found[0].apr, 90.0);
        assert_eq!(
            found[0].protocol.as_deref(),
            Some("Best"),
            "Python's max() keeps the first maximal element"
        );
        assert_eq!(found[0].tvl, 80_000.0, "the TVL comes from the same option");
    }

    #[test]
    fn results_are_ranked_by_apr_and_deduped_by_chain_pair_protocol() {
        let mut duplicate = opportunity("WHYPE", "USDC", 70.0, 50_000.0);
        duplicate["pool"]["address"] = json!("0xanotherpool");
        let found = radar(&[
            opportunity("WHYPE", "USDC", 60.0, 50_000.0),
            opportunity("WHYPE", "WSTETH", 120.0, 50_000.0),
            duplicate, // same chain+pair+protocol as the first, higher APR
        ]);
        assert_eq!(
            found.iter().map(|o| o.apr).collect::<Vec<_>>(),
            vec![120.0, 70.0],
            "highest first; the 60% WHYPE/USDC loses to the 70% one on the same key"
        );
    }

    #[test]
    fn the_limit_is_a_default_the_caller_can_raise() {
        // `mcp_server.py:262` passes its own limit, `server.py:251` takes the default — so this is
        // a default, not a cap, and a caller asking for more must get more.
        let many: Vec<Value> = (0..10)
            .map(|i| {
                let mut item = opportunity("WHYPE", "USDC", 100.0 + i as f64, 50_000.0);
                item["options"][0]["protocol"]["name"] = json!(format!("Protocol{i}"));
                item
            })
            .collect();
        let profile = profile();
        let held = profile.held[0].1.clone();
        let candidates = radar_candidates(&profile, Some(999), &held, &many);
        assert_eq!(candidates.len(), 10);
        assert_eq!(rank_radar(candidates.clone(), RADAR_LIMIT_DEFAULT).len(), 6);
        assert_eq!(rank_radar(candidates.clone(), 10).len(), 10);
        assert_eq!(rank_radar(candidates, 1).len(), 1);
    }

    #[test]
    fn an_unknown_chain_id_falls_back_to_its_number() {
        assert_eq!(chain_name(Some(8453)), "base");
        assert_eq!(chain_name(Some(1234)), "1234");
        assert_eq!(chain_name(None), "None", "Python's str(None)");
    }

    #[tokio::test]
    async fn a_real_recorded_opportunities_response_parses() {
        // REAL fixture, recorded with LYRA_HTTP_CACHE=record against
        // api.vfat.io/v4/yield-opportunities?chainId=999… — the endpoint is wallet-independent,
        // so unlike the HyperEVM position shape this one could be captured live.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock);
        let items = api.yield_opportunities(Some(999)).await;

        assert!(!items.is_empty(), "HyperEVM has incentivised pools");
        assert!(
            items
                .iter()
                .all(|item| item.get("pool").is_some() && item.get("options").is_some()),
            "every item carries the pool and its deposit options"
        );
        // The shape the filters depend on must really be there.
        let first = &items[0];
        assert!(first["pool"]["underlying"].is_array());
        assert!(number(first["options"][0].get("apr")).is_some());
        assert!(number(first["options"][0].get("totalLiquidity")).is_some());
    }

    #[tokio::test]
    async fn opportunities_are_cached_for_ten_minutes_per_chain() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock.clone());
        let first = api.yield_opportunities(Some(999)).await;

        clock.advance(YIELD_OPPORTUNITIES_TTL_SECS - 1.0);
        let cached = api.yield_opportunities(Some(999)).await;
        assert!(Arc::ptr_eq(&first, &cached), "served from the 600s cache");

        clock.advance(2.0);
        let refetched = api.yield_opportunities(Some(999)).await;
        assert!(
            !Arc::ptr_eq(&first, &refetched),
            "past 600s it is read again"
        );
        assert_eq!(*first, *refetched);
    }

    #[tokio::test]
    async fn a_dead_opportunities_endpoint_empties_the_radar_rather_than_serving_stale() {
        // The deliberate asymmetry with farm-balances: money the user *owns* is worth showing
        // stale; a suggestion to move money is not.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock.clone());
        assert!(
            api.yield_opportunities(Some(999)).await.is_empty(),
            "a failure is an empty list, never an error"
        );
        assert!(
            api.yield_opportunities(Some(999)).await.is_empty(),
            "and it is not cached, so the next call retries instead of being pinned empty"
        );
    }

    #[tokio::test]
    async fn the_radar_fails_when_the_users_own_positions_are_unreadable() {
        // Without the baseline there is nothing to compare against, and an empty radar would read
        // as "nothing better out there" rather than "we could not check".
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock);
        assert!(api.yield_radar(WALLET, RADAR_LIMIT_DEFAULT).await.is_err());
    }

    #[tokio::test]
    async fn the_radar_runs_end_to_end_on_recorded_data() {
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock);
        let found = api
            .yield_radar(WALLET, RADAR_LIMIT_DEFAULT)
            .await
            .expect("farm-balances replays");
        assert!(
            found.len() <= RADAR_LIMIT_DEFAULT,
            "never more than asked for"
        );
        for opportunity in &found {
            assert!(opportunity.tvl >= RADAR_TVL_FLOOR);
            assert_eq!(opportunity.tokens.len(), 2);
        }
    }

    #[test]
    fn the_constants_match_python() {
        assert_eq!(FARM_BALANCES_TTL_SECS, 120.0);
        assert_eq!(LAST_GOOD_MAX_AGE_SECS, 3600.0);
        assert_eq!(MIN_POSITION_USD, 0.01);
        assert_eq!(VFAT_FACTORY, "0x9D70B9E5ac2862C405D64A0193b4A4757Aab7F95");
    }

    // ---- the enrich pass --------------------------------------------------

    /// A feed entry rich enough for `vfat_api_position` to build a position from.
    fn farm_entry(chain_id: u64, nft_id: &str, usd: f64, apr: f64) -> Value {
        serde_json::json!({
            "chainId": chain_id,
            "nft": {"id": nft_id},
            "sickleAddress": "0xSICKLE",
            "underlying": [
                {"symbol": "WETH", "balance": 1.0, "price": usd / 2.0, "decimals": 18},
                {"symbol": "USDC", "balance": usd / 2.0, "price": 1.0, "decimals": 6},
            ],
            "farm": {
                "snapshot": {"apr": apr},
                "protocol": {"name": "Aerodrome"},
            },
        })
    }

    /// An RPC-read position, as the univ3/aero_cl adapters would have produced it.
    fn rpc_position(id: &str, via: Option<&str>) -> Position {
        let mut position = Position::new("Aerodrome", "Liquidity Pool", "WETH/USDC", Some(500.0));
        position.id = Some(Some(id.to_string()));
        position.via = via.map(str::to_string);
        position
    }

    #[test]
    fn a_gauge_staked_farm_the_rpc_pass_cannot_see_is_added() {
        // The money-moving half: this NFT was transferred to the gauge, so `balanceOf` on the
        // wallet never returns it. Without this it is missing from the total outright.
        let mut positions = Vec::new();
        let added = reconcile(
            &[farm_entry(8453, "777", 1_000.0, 12.5)],
            8453,
            &mut positions,
        );

        assert_eq!(added, 1);
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].via.as_deref(), Some(VIA_VFAT));
        assert!(positions[0].usd.unwrap() > 0.0);
    }

    #[test]
    fn a_position_both_sources_see_is_enriched_not_duplicated() {
        // The dedup. Counting it twice would inflate net worth by the position's whole value.
        let mut positions = vec![rpc_position("#777", Some(VIA_VFAT))];
        let added = reconcile(
            &[farm_entry(8453, "777", 1_000.0, 12.5)],
            8453,
            &mut positions,
        );

        assert_eq!(added, 0);
        assert_eq!(positions.len(), 1, "still one position, not two");
        assert_eq!(positions[0].usd, Some(500.0), "the RPC read's value stands");
        assert_eq!(
            positions[0].apr,
            Some(12.5),
            "and it gained vfat's APR, which is the enrich half"
        );
    }

    #[test]
    fn a_numeric_feed_id_matches_a_hash_prefixed_position_id() {
        // The feed sends ids as strings or numbers; positions carry a display `#`. A mismatch
        // here would silently duplicate every position rather than enriching it.
        let mut positions = vec![rpc_position("#777", Some(VIA_VFAT))];
        let mut entry = farm_entry(8453, "777", 1_000.0, 9.0);
        entry["nft"]["id"] = serde_json::json!(777);

        assert_eq!(reconcile(&[entry], 8453, &mut positions), 0);
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].apr, Some(9.0));
    }

    #[test]
    fn only_vfat_proxy_positions_are_enrich_targets() {
        // NFT ids are per-manager, not global, so a Uniswap position can legitimately share an id
        // with a vfat farm. Matching on id alone would stamp it with an unrelated farm's APR and
        // then fail to add the farm at all.
        let mut positions = vec![rpc_position("#777", None)];
        let added = reconcile(
            &[farm_entry(8453, "777", 1_000.0, 12.5)],
            8453,
            &mut positions,
        );

        assert_eq!(added, 1, "the farm is a separate position");
        assert_eq!(
            positions[0].apr, None,
            "the unrelated position is untouched"
        );
        assert_eq!(positions.len(), 2);
    }

    #[test]
    fn entries_from_another_chain_are_ignored() {
        let mut positions = Vec::new();
        assert_eq!(
            reconcile(
                &[farm_entry(999, "777", 1_000.0, 12.5)],
                8453,
                &mut positions
            ),
            0
        );
        assert!(positions.is_empty());
    }

    #[test]
    fn a_dust_farm_is_not_worth_adding() {
        let mut positions = Vec::new();
        assert_eq!(
            reconcile(
                &[farm_entry(8453, "777", 0.001, 12.5)],
                8453,
                &mut positions
            ),
            0
        );
        assert!(positions.is_empty());
    }

    #[tokio::test]
    async fn a_vfat_api_chain_is_a_no_op() {
        // There the feed is the only source and `adapt_vfat_api` already added everything, so a
        // second pass would duplicate every position on the chain.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = VfatApi::with_clock(reqwest::Client::new(), fixtures(), clock);
        let hyperevm = crate::chains::by_name("hyperevm").expect("hyperevm is in the chain table");
        assert!(hyperevm.vfat_api, "fixture assumption");

        let mut positions = vec![rpc_position("#777", Some(VIA_VFAT))];
        enrich(Arc::new(api), hyperevm, WALLET, &mut positions)
            .await
            .expect("a no-op cannot fail");
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].apr, None, "nothing was stamped");
    }

    #[tokio::test]
    async fn a_vfat_outage_leaves_the_rpc_read_positions_alone() {
        // `enrich` returns Err and the caller logs it; what must not happen is the chain losing
        // the positions it did manage to read.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock);
        let base = crate::chains::by_name("base").expect("base is in the chain table");

        let mut positions = vec![rpc_position("#777", Some(VIA_VFAT))];
        assert!(
            enrich(Arc::new(api), base, WALLET, &mut positions)
                .await
                .is_err()
        );
        assert_eq!(positions.len(), 1, "the RPC-read position survives");
    }

    #[test]
    fn every_chain_the_feed_names_can_be_resolved_back_to_an_id() {
        // `enrich` is a no-op without a chain id, so a chain missing from this table silently
        // loses its gauge-staked farms. The two directions must stay in step.
        for (id, name) in ID_CHAIN {
            assert_eq!(evm_chain_id(name), Some(id), "{name}");
        }
    }

    // ---------------------------------------------------------------- lifecycle stamping

    /// A feed entry shaped like the fields `_vfat_stamp_lifecycle` actually reads.
    fn feed_entry(chain_id: u64, nft_id: &str) -> Value {
        json!({
            "chainId": chain_id,
            "sickleAddress": SICKLE,
            "nft": {"id": nft_id, "managerAddress": "0x2222222222222222222222222222222222222222"},
        })
    }

    fn lp(id: &str) -> Position {
        Position {
            id: Some(Some(id.to_string())),
            via: Some(VIA_VFAT.to_string()),
            ..Position::default()
        }
    }

    fn action(stamp: &str, kind: &str) -> Value {
        json!({"blockTimestamp": stamp, "actionType": kind})
    }

    #[test]
    fn lifecycle_takes_first_and_last_action() {
        let mut position = lp("#42");
        stamp_lifecycle(
            &mut position,
            &[
                action("2026-07-15T14:16:11.000Z", "deposited"),
                action("2026-07-20T09:00:00.000Z", "rebalanced"),
                action("2026-08-09T11:04:04.000Z", "increased"),
            ],
        );

        assert_eq!(
            position.deployed_at,
            Some(Some("2026-07-15T14:16:11.000Z".into()))
        );
        assert_eq!(
            position.updated_at,
            Some(Some("2026-08-09T11:04:04.000Z".into()))
        );
        assert_eq!(position.last_action, Some(Some("increased".into())));
        // No harvest in the list, so the cycle is anchored at the deploy.
        assert_eq!(position.last_harvest_at, None);
        assert_eq!(position.cycle_start, Some(Some(1_784_124_971)));
    }

    #[test]
    fn a_harvest_reanchors_the_cycle() {
        let mut position = lp("#42");
        stamp_lifecycle(
            &mut position,
            &[
                action("2026-07-15T14:16:11.000Z", "deposited"),
                action("2026-07-20T09:00:00.000Z", "harvested"),
                // Mixed case and a compound name: Python lowercases and looks for a substring,
                // so `AutoHarvest` counts and is the one that wins.
                action("2026-08-01T00:00:00.000Z", "AutoHarvest"),
                action("2026-08-09T11:04:04.000Z", "increased"),
            ],
        );

        assert_eq!(
            position.last_harvest_at,
            Some(Some("2026-08-01T00:00:00.000Z".into())),
            "the LATEST harvest anchors the cycle, not the first"
        );
        assert_eq!(position.cycle_start, Some(Some(1_785_542_400)));
        // The last action is still the last action, harvest or not.
        assert_eq!(position.last_action, Some(Some("increased".into())));
    }

    #[test]
    fn an_empty_history_stamps_nothing() {
        // `if acts:` — a position whose history could not be read keeps the shape it had rather
        // than gaining six null fields, which would be a visible contract change on the wire.
        let mut position = lp("#42");
        stamp_lifecycle(&mut position, &[]);
        assert_eq!(position.deployed_at, None);
        assert_eq!(position.updated_at, None);
        assert_eq!(position.last_action, None);
        assert_eq!(position.cycle_start, None);
    }

    #[test]
    fn a_missing_field_is_present_and_null() {
        // Python writes `pos["deployed_at"] = acts[0].get("blockTimestamp")`, so an action with no
        // timestamp yields the KEY with a null value — not an absent key. `Nullable` encodes that
        // difference and the UI depends on it.
        let mut position = lp("#42");
        stamp_lifecycle(&mut position, &[json!({"actionType": "deposited"})]);
        assert_eq!(position.deployed_at, Some(None));
        assert_eq!(position.updated_at, Some(None));
        assert_eq!(position.last_action, Some(Some("deposited".into())));
        assert_eq!(position.cycle_start, Some(None), "no stamp, no anchor");
    }

    #[test]
    fn actions_sort_oldest_first_with_missing_stamps_leading() {
        // `sorted(acts, key=lambda a: a.get("blockTimestamp") or "")`.
        let mut actions = [
            action("2026-08-09T11:04:04.000Z", "c"),
            json!({"actionType": "no-stamp"}),
            action("2026-07-15T14:16:11.000Z", "a"),
        ];
        actions.sort_by(|a, b| action_stamp(a).cmp(action_stamp(b)));
        let kinds: Vec<&str> = actions
            .iter()
            .map(|a| a["actionType"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["no-stamp", "a", "c"]);
    }

    #[test]
    fn perf_join_fills_in_range_time() {
        let mut positions = vec![lp("#42")];
        positions[0].perf_key = Some("8453:42".into());
        let perf = HashMap::from([(
            "8453:42".to_string(),
            PerfRecord {
                in_range_secs: 12_351.0,
                cycle_start: Some(1_700_000_000),
            },
        )]);

        apply_perf(&mut positions, &perf);
        assert_eq!(positions[0].in_range_secs, Some(12_351.0));
        assert_eq!(
            positions[0].cycle_start,
            Some(Some(1_700_000_000)),
            "no history anchor, so the cron's cycle_start fills in"
        );
    }

    #[test]
    fn a_history_anchor_beats_the_cron_one() {
        // `pos.setdefault("cycle_start", rec["cycle_start"])`. Getting this backwards would
        // re-anchor every position to whenever the cron first saw it, silently resetting the
        // "fees since harvest" figure the whole panel is built on.
        let mut positions = vec![lp("#42")];
        positions[0].perf_key = Some("8453:42".into());
        positions[0].cycle_start = Some(Some(1_784_124_971));

        apply_perf(
            &mut positions,
            &HashMap::from([(
                "8453:42".to_string(),
                PerfRecord {
                    in_range_secs: 60.0,
                    cycle_start: Some(1_700_000_000),
                },
            )]),
        );
        assert_eq!(positions[0].cycle_start, Some(Some(1_784_124_971)));
        assert_eq!(positions[0].in_range_secs, Some(60.0), "still joined");
    }

    #[test]
    fn an_unsampled_position_is_left_alone() {
        let mut positions = vec![lp("#42")];
        positions[0].perf_key = Some("8453:42".into());
        apply_perf(&mut positions, &HashMap::new());
        assert_eq!(positions[0].in_range_secs, None);
        assert_eq!(positions[0].cycle_start, None);
    }

    #[test]
    fn the_perf_key_matches_the_feed_not_the_display_id() {
        // The position renders as `#519288`; the cron keys off the feed's raw id. Both must
        // produce `999:519288` or the join silently never matches.
        let mut position = lp("#519288");
        stamp_perf_key(&mut position, &feed_entry(999, "519288"));
        assert_eq!(position.perf_key.as_deref(), Some("999:519288"));

        let mut hashed = lp("#519288");
        stamp_perf_key(&mut hashed, &feed_entry(999, "#519288"));
        assert_eq!(hashed.perf_key.as_deref(), Some("999:519288"));
    }

    #[test]
    fn pairs_match_on_chain_and_id() {
        let entries = vec![
            feed_entry(8453, "42"),
            feed_entry(999, "42"),  // same id, wrong chain
            feed_entry(8453, "77"), // right chain, no position
        ];
        let positions = vec![lp("#42")];
        assert_eq!(lifecycle_pairs(&entries, 8453, &positions), [(0, 0)]);
        // And the other chain pairs its own entry with the same position id.
        assert_eq!(lifecycle_pairs(&entries, 999, &positions), [(0, 1)]);
    }

    #[tokio::test]
    async fn an_unreachable_history_is_empty_not_an_error() {
        // `except: return []`. A position must still render with its balance when vfat is down.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock);
        let actions = api.nft_actions(8453, SICKLE, "42", "0x2222").await;
        assert!(actions.is_empty());
    }

    #[tokio::test]
    async fn an_incomplete_position_makes_no_request() {
        // `if not (chain_id and sickle and token_id and manager)` — `0` and `""` are both falsy.
        // Guarded before the fetch, so this passes against an API that cannot reach anything.
        let clock = Arc::new(ManualClock::new(1_000.0));
        let api = broken_api(clock);
        assert!(api.nft_actions(0, SICKLE, "42", "0x2222").await.is_empty());
        assert!(api.nft_actions(8453, "", "42", "0x2222").await.is_empty());
        assert!(api.nft_actions(8453, SICKLE, "", "0x2222").await.is_empty());
        assert!(api.nft_actions(8453, SICKLE, "42", "").await.is_empty());
    }

    // ---------------------------------------------------------------- campaign rewards

    #[test]
    fn merkl_attributes_a_reward_to_the_position_in_its_reason() {
        // The `reason` tail is the whole mechanism: `<PROTOCOL>_<pool>_<tokenId>`.
        let chain = json!({"rewards": [{
            "token": {"symbol": "NEST", "decimals": 18, "price": 2.0},
            "breakdowns": [
                {"reason": "PROJECTX_0xpool_519288", "amount": "3000000000000000000", "claimed": "1000000000000000000"},
            ],
        }]});
        let mut out = MerklRewards::new();
        merge_merkl_chain(&chain, &mut out);

        // amount - claimed = still claimable.
        assert_eq!(out["519288"][0].symbol, "NEST");
        assert_eq!(out["519288"][0].amount, 2.0);
        assert_eq!(out["519288"][0].usd, Some(4.0));
    }

    #[test]
    fn merkl_merges_the_same_token_across_breakdowns() {
        // One position earning the same token from two campaigns shows one line, not two.
        let chain = json!({"rewards": [{
            "token": {"symbol": "NEST", "decimals": 18, "price": 1.0},
            "breakdowns": [
                {"reason": "A_0xp_42", "amount": "1000000000000000000", "claimed": "0"},
                {"reason": "B_0xq_42", "amount": "2000000000000000000", "claimed": "0"},
            ],
        }]});
        let mut out = MerklRewards::new();
        merge_merkl_chain(&chain, &mut out);

        assert_eq!(out["42"].len(), 1);
        assert_eq!(out["42"][0].amount, 3.0);
        assert_eq!(out["42"][0].usd, Some(3.0));
    }

    #[test]
    fn merkl_drops_rows_it_cannot_attribute() {
        let chain = json!({"rewards": [{
            "token": {"symbol": "NEST", "decimals": 18, "price": 1.0},
            "breakdowns": [
                // No underscore at all -> Python's `else ""` -> not a digit -> dropped.
                {"reason": "nounderscore", "amount": "1000000000000000000", "claimed": "0"},
                // Tail is not all digits.
                {"reason": "A_0xp_abc", "amount": "1000000000000000000", "claimed": "0"},
                // Fully claimed: nothing left to report.
                {"reason": "A_0xp_7", "amount": "1000000000000000000", "claimed": "1000000000000000000"},
                // Claimed exceeds amount — negative claimable is not a reward.
                {"reason": "A_0xp_8", "amount": "1000000000000000000", "claimed": "9000000000000000000"},
            ],
        }]});
        let mut out = MerklRewards::new();
        merge_merkl_chain(&chain, &mut out);
        assert!(out.is_empty(), "got {out:?}");
    }

    #[test]
    fn merkl_skips_a_reward_with_no_symbol() {
        let chain = json!({"rewards": [{
            "token": {"decimals": 18, "price": 1.0},
            "breakdowns": [{"reason": "A_0xp_42", "amount": "1000000000000000000", "claimed": "0"}],
        }]});
        let mut out = MerklRewards::new();
        merge_merkl_chain(&chain, &mut out);
        assert!(out.is_empty());
    }

    /// A Nest-earning entry: the farm declares the campaign, and the position carries the
    /// wallet-level claim.
    fn nest_json(liquidity: f64, rewarded: f64, pool: f64, amount: &str) -> Value {
        json!({
            "chainId": 999,
            "nft": {"id": "42", "liquidity": liquidity},
            "farm": {
                "offChainRewards": [{
                    "protocol": "nest",
                    "rewardToken": {"address": "0xNEST"},
                    "campaignId": "camp-1",
                    "rewardsPerSecond": "1000000000000000000",
                }],
                "snapshot": {"rewardedLiquidity": rewarded, "poolLiquidity": pool},
            },
            "offChainRewards": [{
                "nestClaim": true,
                "protocol": "nest",
                "token": {"symbol": "NEST", "address": "0xnest", "decimals": 18, "price": 2.0},
                "amount": amount,
            }],
        })
    }

    #[test]
    fn a_nest_claim_is_read_from_the_position() {
        let entry = nest_json(100.0, 50.0, 200.0, "4000000000000000000");
        let nest = nest_entry(&entry).expect("a nest claim");

        assert_eq!(nest.symbol, "NEST");
        assert_eq!(nest.amount, 4.0);
        assert_eq!(nest.price, 2.0);
        assert_eq!(nest.campaign, "camp-1");
        assert_eq!(nest.liq, 100.0);
        // 1 NEST/s × (50/200 rewarded share).
        assert_eq!(nest.camp_rate, 0.25);
    }

    #[test]
    fn a_merkl_backed_claim_is_not_treated_as_nest() {
        // Without the `nestClaim` gate this would be counted twice — once here and once from the
        // Merkl API, which reports the same reward.
        let mut entry = nest_json(100.0, 50.0, 200.0, "4000000000000000000");
        entry["offChainRewards"][0]["nestClaim"] = json!(false);
        assert_eq!(nest_entry(&entry), None);
    }

    #[test]
    fn a_campaign_the_farm_does_not_list_is_not_earned() {
        // The wallet-level claim appears on positions that never earned it; the farm's own
        // `offChainRewards` is what says whether this one did.
        let mut entry = nest_json(100.0, 50.0, 200.0, "4000000000000000000");
        entry["offChainRewards"][0]["protocol"] = json!("someone-else");
        assert_eq!(nest_entry(&entry), None);
    }

    #[test]
    fn nest_splits_the_one_claim_by_emission_weight() {
        // Both positions carry the SAME wallet-level claim of 4 NEST. Liquidity 300 vs 100 in one
        // campaign means a 3:1 split — and the parts must sum back to the real claimable total.
        let entries = [
            nest_json(300.0, 100.0, 100.0, "4000000000000000000"),
            nest_json(100.0, 100.0, 100.0, "4000000000000000000"),
        ];
        let nests: Vec<Option<NestEntry>> = entries.iter().map(nest_entry).collect();
        let mut positions = vec![lp("#1"), lp("#2")];

        distribute_nest(&mut positions, &nests);

        let amount = |p: &Position| p.rewards.as_ref().unwrap()[0].amount;
        assert!((amount(&positions[0]) - 3.0).abs() < 1e-9);
        assert!((amount(&positions[1]) - 1.0).abs() < 1e-9);
        let total: f64 = positions.iter().map(amount).sum();
        assert!(
            (total - 4.0).abs() < 1e-9,
            "the split must sum to the claim"
        );
        // And no two positions read identically, which was the whole point.
        assert_ne!(amount(&positions[0]), amount(&positions[1]));
    }

    #[test]
    fn nest_falls_back_to_an_equal_split_with_no_live_rate() {
        // All dust: rewardsPerSecond zero everywhere, so weights are all zero.
        let mut a = nest_json(0.0, 0.0, 0.0, "4000000000000000000");
        a["farm"]["offChainRewards"][0]["rewardsPerSecond"] = json!("0");
        let mut b = a.clone();
        b["nft"]["id"] = json!("43");

        let nests: Vec<Option<NestEntry>> = [&a, &b].iter().map(|e| nest_entry(e)).collect();
        let mut positions = vec![lp("#1"), lp("#2")];
        distribute_nest(&mut positions, &nests);

        let amount = |p: &Position| p.rewards.as_ref().unwrap()[0].amount;
        assert_eq!(amount(&positions[0]), 2.0);
        assert_eq!(amount(&positions[1]), 2.0);
    }

    #[test]
    fn nest_does_nothing_when_no_position_earns_it() {
        let mut positions = vec![lp("#1")];
        distribute_nest(&mut positions, &[None]);
        assert_eq!(positions[0].rewards, None);
        assert_eq!(positions[0].rewards_usd, None);
    }

    #[test]
    fn a_reward_bumps_both_the_list_and_the_usd_total() {
        // `rewards` and `rewards_usd` are written by the same statement in the Python. A reward
        // appended without the total would be invisible in every figure the UI adds up.
        let mut position = lp("#1");
        position.rewards_usd = Some(Some(10.0));
        add_reward(
            &mut position,
            TokenAmt {
                symbol: "NEST".into(),
                amount: 1.0,
                usd: Some(2.5),
                ..Default::default()
            },
        );
        assert_eq!(position.rewards.as_ref().unwrap().len(), 1);
        assert_eq!(position.rewards_usd, Some(Some(12.5)));
    }

    #[test]
    fn campaign_rewards_reach_the_paired_position_only() {
        let entries = vec![
            json!({"chainId": 999, "nft": {"id": "42"}}),
            json!({"chainId": 999, "nft": {"id": "99"}}),
        ];
        let mut positions = vec![lp("#42")];
        let pairs = lifecycle_pairs(&entries, 999, &positions);
        let merkl = MerklRewards::from([(
            "42".to_string(),
            vec![TokenAmt {
                symbol: "NEST".into(),
                amount: 5.0,
                usd: Some(10.0),
                ..Default::default()
            }],
        )]);

        attach_campaign_rewards(&mut positions, &entries, &pairs, &merkl);

        assert_eq!(positions[0].rewards.as_ref().unwrap()[0].amount, 5.0);
        assert_eq!(positions[0].rewards_usd, Some(Some(10.0)));
    }
}
