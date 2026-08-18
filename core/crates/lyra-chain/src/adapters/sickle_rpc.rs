//! On-chain Sickle LP NFTs, reconciled against the vfat feed — the port of
//! `portfolio.py:adapt_sickle_rpc` (L1536).
//!
//! # The gap this exists to close
//!
//! vfat's farm-balances feed lists only **farming** positions. When a concentrated-liquidity
//! position drifts out of range it gets unstaked from its gauge, and it falls off that feed — even
//! though the liquidity, and its value, are still sitting on-chain in the Sickle proxy.
//!
//! Without this adapter, a position going out of range looks exactly like a position being
//! closed: it simply vanishes from the portfolio. That is the worst possible moment to lose sight
//! of it, since out-of-range is when an LP most needs attention.
//!
//! So the scan runs **unconditionally** and surfaces any token id the vfat feed did not return.
//! Matching is by id, which is what keeps a position from being counted twice when both sources
//! can see it — and when the vfat API is down entirely, `seen` is empty and every position is
//! surfaced rather than none.
//!
//! # Protocol labels are resolved, not hardcoded
//!
//! HyperEVM's LP managers are Uniswap v3 forks with their own names, and new ones appear. Rather
//! than a hardcoded address→name table that silently goes stale, [`label`] asks vfat first (it
//! knows each factory's and manager's protocol name), then falls back to parsing the NFT's own
//! `name()`, and only then to a generic `Uniswap v3`. A pristine fork keeps Uniswap's default
//! name, and calling that anything else would be a guess.
//!
//! # Cost, and why it is cached
//!
//! This is the slowest adapter in the registry — dozens of sequential RPC round trips across three
//! managers — while its result, positions the feed omits, changes slowly. The Python caches it for
//! 60s per (chain, owner); [`Scanner`] holds the same TTL cache so a refresh inside the window
//! skips the scan entirely.
//!
//! # Failure isolation
//!
//! Per **position**, not per manager: the Python's inner `try/except` skips one bad token id and
//! keeps the rest, and a manager that is not ERC-721-enumerable for an owner is skipped without
//! costing the others. Reusing [`super::univ3::read_positions`] here would have been tempting and
//! wrong — it propagates, so a single exotic pool would hide every other position on the chain.

use std::sync::Arc;

use serde_json::Value as Json;

use crate::abi::{Fields, Value};
use crate::adapters::aero_cl::PriceSource;
use crate::adapters::univ3::{
    self, BALANCE_OF, FEE_GROWTH_OUTSIDE_INDEX, GET_POOL, POSITIONS, POSITIONS_OUTPUTS,
    PositionRead, RawPosition, SLOT0, SLOT0_OUTPUTS, TICKS_OUTPUTS, TOKEN_OF_OWNER_BY_INDEX,
    build_position, valuation,
};
use crate::adapters::vfat::VfatApi;
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt, TokenMeta};
use crate::model::Position;
use crate::prices::SharedTtlCache;

/// `factory()` on a v3 position manager.
pub const FACTORY: &str = "factory()";
/// `name()` on the position-manager NFT.
pub const NAME: &str = "name()";

/// How long a completed scan is reused, per (chain, owner) — the Python's `_ttl(..., 60, ...)`.
pub const SCAN_TTL_SECS: f64 = 60.0;

/// The label stamped on every position this adapter finds.
///
/// Not the owner's `via`: these are read straight from the chain rather than through vfat's
/// index, and the UI uses this to say so. The Python passes the literal `"rpc"`.
pub const VIA: &str = "rpc";

/// `_HYPEREVM_MANAGERS` (portfolio.py L1472).
///
/// Nest (`0xeaf5…`) is deliberately absent: it is Algebra-based, so its `positions()` ABI differs
/// and this reader would mis-decode it. vfat covers Nest when the feed is up.
pub const MANAGERS: [&str; 3] = [
    "0xead19ae861c29bbb2101e834922b2feee69b9091",
    "0x6eda206207c09e5428f281761ddc0d300851fbc8",
    "0x934c4f47b2d3ffca0156a45deb3a436202af1efa",
];

// ===========================================================================
// Labels
// ===========================================================================

/// Protocol label from a manager's `name()` — the port of `_parse_v3_name` (L1479).
///
/// `"PRJX V3 Positions NFT-V1"` → `"PRJX"`, `"Hyperswap V3 Positions NFT-V1"` → `"Hyperswap"`.
/// A pristine fork keeps Uniswap's default name, which we can only honestly call `Uniswap v3`.
#[must_use]
pub fn parse_v3_name(name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    // Python splits on `\s+v3\b|\s+positions\b` and keeps `[0]`, so the cut is whichever marker
    // appears first — hence the `min` rather than a first-match-wins loop.
    let mut end = lower.len();
    for marker in [" v3", " positions"] {
        if let Some(at) = find_word_boundary(&lower, marker) {
            end = end.min(at);
        }
    }
    let base = name[..end].trim();
    if base.is_empty() {
        return None;
    }
    Some(if base.eq_ignore_ascii_case("uniswap") {
        "Uniswap v3".to_string()
    } else {
        base.to_string()
    })
}

/// Index of `marker` in `haystack` when it is followed by a word boundary.
///
/// The Python's `\s+v3\b` requires the token to end at a boundary, so `"Foo v3x Positions"` is
/// **not** split at `v3` — matching that matters, because splitting it would rename the protocol.
fn find_word_boundary(haystack: &str, marker: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(at) = haystack[from..].find(marker) {
        let start = from + at;
        let after = start + marker.len();
        let boundary = haystack[after..]
            .chars()
            .next()
            .is_none_or(|c| !c.is_alphanumeric() && c != '_');
        if boundary {
            return Some(start);
        }
        from = after;
    }
    None
}

/// The protocol label for one manager — the port of `_v3_label` (L1491).
///
/// vfat's own name wins when it knows this factory or manager, because it is the name the rest of
/// the UI already uses for that protocol. Only then do we fall back to the chain.
pub async fn label<R: EvmRpc + ?Sized>(
    rpc: &R,
    manager: &str,
    factory: &str,
    vfat_labels: &[(String, String)],
) -> String {
    for key in [factory.to_lowercase(), manager.to_lowercase()] {
        if let Some((_, name)) = vfat_labels.iter().find(|(k, _)| *k == key) {
            return name.clone();
        }
    }
    rpc.call_one(manager, NAME, &[], "string")
        .await
        .ok()
        .and_then(|v| v.as_str().ok().map(str::to_string))
        .and_then(|name| parse_v3_name(&name))
        .unwrap_or_else(|| "Uniswap v3".to_string())
}

/// Every `(factory-or-manager address, protocol name)` pair the vfat feed knows.
///
/// Lower-cased keys, so [`label`] can match either side without re-normalising.
#[must_use]
pub fn vfat_labels(entries: &[Json]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for entry in entries.iter().filter(|e| e.is_object()) {
        let Some(name) = entry
            .pointer("/farm/protocol/name")
            .and_then(Json::as_str)
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
        for key in [
            entry.get("poolFactoryAddress").and_then(Json::as_str),
            entry
                .pointer("/farm/nftManagerAddress")
                .and_then(Json::as_str),
        ]
        .into_iter()
        .flatten()
        .filter(|k| !k.is_empty())
        {
            let key = key.to_lowercase();
            if !out.iter().any(|(k, _)| *k == key) {
                out.push((key, name.to_string()));
            }
        }
    }
    out
}

/// The token ids the vfat feed already covers on this chain.
///
/// Anything not in here is what this adapter exists to surface. Ids are compared as strings
/// because the feed sends them either way and a numeric parse would silently drop the odd one.
#[must_use]
pub fn covered_ids(entries: &[Json], chain_id: Option<u64>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for entry in entries.iter().filter(|e| e.is_object()) {
        if entry.get("chainId").and_then(Json::as_u64) != chain_id {
            continue;
        }
        let Some(id) = entry.pointer("/nft/id") else {
            continue;
        };
        let id = match id {
            Json::String(s) => s.clone(),
            Json::Number(n) => n.to_string(),
            _ => continue,
        };
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

// ===========================================================================
// Reading one manager
// ===========================================================================

/// Every live LP the owners hold in one position manager — the port of `_read_v3_manager` (L1500).
///
/// A manager that is not ERC-721-enumerable for an owner is skipped for that owner (the Python's
/// `except: continue` around `balanceOf`). A position that fails to read is skipped alone.
pub async fn read_manager<R, P>(
    rpc: &R,
    prices: &P,
    chain: &Chain,
    manager: &str,
    owners: &[(String, Option<String>)],
    vfat_labels: &[(String, String)],
) -> Vec<Position>
where
    R: EvmRpc + ?Sized,
    P: PriceSource + ?Sized,
{
    let Ok(factory) = rpc
        .call_one(manager, FACTORY, &[], "address")
        .await
        .and_then(|v| v.as_address_string())
    else {
        tracing::warn!(manager, "sickle-rpc: manager has no readable factory()");
        return Vec::new();
    };
    let protocol = label(rpc, manager, &factory, vfat_labels).await;

    let meta = TokenMeta::new();
    let mut out = Vec::new();
    for (owner, _via) in owners {
        let Ok(owner_arg) = Value::address(owner) else {
            continue;
        };
        let Ok(count) = rpc
            .call_one(
                manager,
                BALANCE_OF,
                std::slice::from_ref(&owner_arg),
                "uint256",
            )
            .await
            .and_then(|v| v.as_u64())
        else {
            continue; // not enumerable for this owner
        };

        for index in 0..count {
            match read_one(
                rpc, prices, &meta, chain, manager, &factory, &owner_arg, index, &protocol,
            )
            .await
            {
                Ok(Some(position)) => out.push(position),
                Ok(None) => {}
                Err(e) => {
                    tracing::warn!(
                        protocol = %protocol,
                        index,
                        error = format!("{e:#}"),
                        "sickle-rpc position skipped"
                    );
                }
            }
        }
    }
    out
}

/// One position by index, or `None` when it is closed or its pool does not exist.
#[allow(clippy::too_many_arguments)]
async fn read_one<R, P>(
    rpc: &R,
    prices: &P,
    meta: &TokenMeta,
    chain: &Chain,
    manager: &str,
    factory: &str,
    owner: &Value,
    index: u64,
    protocol: &str,
) -> anyhow::Result<Option<Position>>
where
    R: EvmRpc + ?Sized,
    P: PriceSource + ?Sized,
{
    let token_id = rpc
        .call_one(
            manager,
            TOKEN_OF_OWNER_BY_INDEX,
            &[owner.clone(), Value::uint(index)],
            "uint256",
        )
        .await?
        .as_u256()?;
    let values = rpc
        .call_typed(
            manager,
            POSITIONS,
            &[Value::uint(token_id)],
            POSITIONS_OUTPUTS,
        )
        .await?;
    let position = PositionRead::from_values(&values)?;
    if position.liquidity == 0 {
        return Ok(None); // closed position, NFT kept
    }

    let pool = rpc
        .call_one(
            factory,
            GET_POOL,
            &[
                Value::address(&position.token0)?,
                Value::address(&position.token1)?,
                Value::uint(u64::from(position.fee)),
            ],
            "address",
        )
        .await?
        .as_address_string()?;
    // `int(pool, 16) == 0`: the factory answers the zero address for a pair it never deployed,
    // and reading slot0() off it would fail anyway — this is the cheaper, clearer stop.
    if is_zero_address(&pool) {
        return Ok(None);
    }

    let slot0 = rpc.call_typed(&pool, SLOT0, &[], SLOT0_OUTPUTS).await?;
    let sqrt_price_x96 = slot0.at(0)?.as_u256()?;
    let cur_tick = slot0.at(1)?.as_i32()?;

    // `&R` already implements `EvmRpc` (the blanket impl in `evm`), so a reference *to* it
    // coerces to the `&dyn EvmRpc` the shared v3 helpers take. `R` itself is `?Sized` and so
    // cannot unsize directly.
    let dynamic: &dyn EvmRpc = &rpc;

    let (fee0_raw, fee1_raw) = univ3::read_uncollected_fees(
        dynamic,
        &pool,
        &position,
        cur_tick,
        TICKS_OUTPUTS,
        FEE_GROWTH_OUTSIDE_INDEX,
    )
    .await?;

    let raw = RawPosition {
        token_id,
        position,
        pool,
        sqrt_price_x96,
        cur_tick,
        fee0_raw,
        fee1_raw,
        // Read from the chain rather than through vfat's index, and labelled as such.
        via: Some(VIA.to_string()),
        // A stock v3 fork: spacing follows from the fee tier.
        tick_spacing: None,
    };
    let token0 = valuation(dynamic, meta, prices, chain, &raw.position.token0).await?;
    let token1 = valuation(dynamic, meta, prices, chain, &raw.position.token1).await?;
    Ok(Some(build_position(
        protocol,
        &raw,
        &token0,
        &token1,
        raw.tick_spacing,
    )))
}

/// `0x000…0` in any casing or length.
fn is_zero_address(address: &str) -> bool {
    address
        .trim_start_matches("0x")
        .chars()
        .all(|c| c == '0' || c == 'x')
}

// ===========================================================================
// The adapter
// ===========================================================================

/// Holds the 60s per-(chain, owner) scan cache — the Python's `_ttl(f"sicklerpc:…", 60, …)`.
///
/// Built once and shared, like the other upstream readers: a per-request instance would throw the
/// cache away and make the slowest adapter in the registry run on every page load.
#[derive(Debug, Default)]
pub struct Scanner {
    cached: SharedTtlCache<Arc<Vec<Position>>>,
}

impl Scanner {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Positions the vfat feed omitted for this wallet on this chain.
    ///
    /// Returns `[]` for a chain not flagged `sickle_rpc`. `now` is passed in rather than read so
    /// the cache can be tested without sleeping.
    // Eight parameters, because this scan genuinely depends on eight things: two upstreams, the
    // chain, both forms of owner (the proxy list to scan and the wallet the cache is keyed by),
    // and the clock. Bundling them into a struct would only move the list.
    #[allow(clippy::too_many_arguments)]
    pub async fn scan<R, P>(
        &self,
        rpc: &R,
        prices: &P,
        vfat: &VfatApi,
        chain: &Chain,
        owners: &[(String, Option<String>)],
        owner: &str,
        now: f64,
    ) -> Vec<Position>
    where
        R: EvmRpc + ?Sized,
        P: PriceSource + ?Sized,
    {
        if !chain.sickle_rpc {
            return Vec::new();
        }
        let key = format!("sicklerpc:{}:{}", chain.name, owner.to_lowercase());
        if let Some(hit) = self.cached.get(&key, SCAN_TTL_SECS, now) {
            return hit.as_ref().clone();
        }

        // A cache hit shared with `adapt_vfat_api`, so this usually costs nothing. When the feed
        // is down, `entries` is empty — which is exactly when every position should surface.
        let entries = vfat.farm_balances(owner).await.unwrap_or_default();
        let covered = covered_ids(&entries, chain.chain_id);
        let labels = vfat_labels(&entries);

        let mut found = Vec::new();
        for manager in MANAGERS {
            found.extend(read_manager(rpc, prices, chain, manager, owners, &labels).await);
        }

        // Match by id so a position both sources can see is not counted twice. vfat's copy is
        // richer (APR, lifecycle), so when both have it, vfat's wins by virtue of already being
        // in the list this one is filtered against.
        let fresh: Vec<Position> = found
            .into_iter()
            .filter(|position| {
                let id = position
                    .id
                    .as_ref()
                    .and_then(|inner| inner.as_deref())
                    .map(|id| id.trim_start_matches('#').to_string())
                    .unwrap_or_default();
                !covered.contains(&id)
            })
            .collect();

        if !fresh.is_empty() {
            let why = if covered.is_empty() {
                "vfat down"
            } else {
                "out-of-range / unstaked — kept visible"
            };
            tracing::info!(
                chain = chain.name,
                count = fresh.len(),
                why,
                "surfaced on-chain LP(s) vfat omitted"
            );
        }

        self.cached.put(&key, Arc::new(fresh.clone()), now);
        fresh
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---- label parsing ----------------------------------------------------

    #[test]
    fn parses_a_fork_name_down_to_its_protocol() {
        assert_eq!(
            parse_v3_name("PRJX V3 Positions NFT-V1").as_deref(),
            Some("PRJX")
        );
        assert_eq!(
            parse_v3_name("Hyperswap V3 Positions NFT-V1").as_deref(),
            Some("Hyperswap")
        );
    }

    #[test]
    fn a_pristine_fork_is_only_honestly_called_uniswap_v3() {
        // It kept Uniswap's default name, so that is all we actually know about it.
        assert_eq!(
            parse_v3_name("Uniswap V3 Positions NFT-V1").as_deref(),
            Some("Uniswap v3")
        );
    }

    #[test]
    fn a_name_with_no_marker_survives_whole() {
        assert_eq!(parse_v3_name("Kittenswap").as_deref(), Some("Kittenswap"));
    }

    #[test]
    fn an_empty_or_marker_only_name_yields_nothing() {
        assert_eq!(parse_v3_name(""), None);
        assert_eq!(parse_v3_name(" V3 Positions"), None);
    }

    #[test]
    fn the_marker_must_end_at_a_word_boundary() {
        // Python's `\s+v3\b` does not match inside `v3x`. Splitting there would rename the
        // protocol to something the contract never claimed.
        assert_eq!(parse_v3_name("Foo v3x Bar").as_deref(), Some("Foo v3x Bar"));
    }

    #[test]
    fn the_earlier_of_the_two_markers_wins() {
        assert_eq!(
            parse_v3_name("Some Positions V3 NFT").as_deref(),
            Some("Some")
        );
    }

    // ---- feed reconciliation ----------------------------------------------

    fn feed() -> Vec<Json> {
        vec![
            json!({
                "chainId": 999,
                "nft": {"id": "12345"},
                "poolFactoryAddress": "0xFACTORY1",
                "farm": {
                    "protocol": {"name": "Hyperswap"},
                    "nftManagerAddress": "0xMANAGER1",
                },
            }),
            json!({
                "chainId": 8453,
                "nft": {"id": "999"},
                "farm": {"protocol": {"name": "Aerodrome"}},
            }),
            json!({"chainId": 999, "nft": {"id": 6789}}),
        ]
    }

    #[test]
    fn covered_ids_are_scoped_to_the_chain_being_scanned() {
        let ids = covered_ids(&feed(), Some(999));
        assert!(ids.contains(&"12345".to_string()));
        assert!(ids.contains(&"6789".to_string()), "a numeric id counts too");
        assert!(
            !ids.contains(&"999".to_string()),
            "that id belongs to another chain and must not mask this one's"
        );
    }

    #[test]
    fn labels_map_both_the_factory_and_the_manager() {
        let labels = vfat_labels(&feed());
        assert_eq!(
            labels
                .iter()
                .find(|(k, _)| k == "0xfactory1")
                .map(|(_, n)| n.as_str()),
            Some("Hyperswap")
        );
        assert_eq!(
            labels
                .iter()
                .find(|(k, _)| k == "0xmanager1")
                .map(|(_, n)| n.as_str()),
            Some("Hyperswap")
        );
    }

    #[test]
    fn an_entry_with_no_protocol_name_contributes_no_label() {
        let labels = vfat_labels(&[json!({"poolFactoryAddress": "0xabc"})]);
        assert!(labels.is_empty());
    }

    #[test]
    fn a_zero_pool_address_is_recognised_in_any_form() {
        assert!(is_zero_address(
            "0x0000000000000000000000000000000000000000"
        ));
        assert!(is_zero_address("0x0"));
        assert!(!is_zero_address(
            "0x0000000000000000000000000000000000000001"
        ));
    }

    #[test]
    fn the_manager_table_omits_the_algebra_based_one() {
        // Nest is Algebra-based: its `positions()` ABI differs, so this reader would mis-decode
        // it into plausible nonsense. vfat covers it when the feed is up.
        assert_eq!(MANAGERS.len(), 3);
        assert!(
            !MANAGERS.iter().any(|m| m.starts_with("0xeaf5")),
            "Nest must not be scanned by the v3 reader"
        );
    }
}
