//! Uniswap v4 LP positions — port of `portfolio.py:773-870` (`V4_PM_ABI`, `V4_SV_ABI`,
//! `_v4_token_ids`, `_v4_uncollected_fees`, `adapt_univ4`).
//!
//! v4 keeps every pool's liquidity in one singleton `PoolManager`, so there is no per-pool
//! contract to read. Price and fee state come from a read-only `StateView` helper instead, keyed
//! by a `poolId` derived from the pool's five identifying fields.
//!
//! Three things make v4 meaningfully different from [`super::univ3`]:
//!
//! 1. **Positions are not enumerable.** v4's NFT has no `tokenOfOwnerByIndex`, so token ids are
//!    discovered out-of-band from Blockscout's NFT index ([`parse_token_ids`]) rather than from
//!    the chain.
//! 2. **The ticks are packed into one word.** `getPoolAndPositionInfo` returns a `PositionInfo`
//!    word laid out `[poolId | tickUpper | tickLower | hasSubscriber]`; the two ticks are 24-bit
//!    signed fields that must be sign-extended with [`lp_math::s24`].
//! 3. **Fees need no tick maths.** `StateView` exposes `getFeeGrowthInside` directly, so the
//!    below/above decomposition v3 has to do by hand is already done on-chain. What remains is
//!    the same wrapping subtraction — see [`uncollected_fees`].
//!
//! Per-position failures are logged and skipped, not propagated: the Python wraps each token id
//! in `try/except` and writes to stderr, because one pool with an exotic hook must not hide the
//! rest of the wallet.

use anyhow::{Context, Result, anyhow};
use serde_json::Value as Json;

use crate::abi::{self, U256, Value};
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt, TokenMeta};
use crate::http_cache::HttpCache;
use crate::lp_math;
use crate::model::Position;

use super::aero_cl::PriceSource;
use super::univ3::{PositionRead, RawPosition, build_position, valuation};

// ===========================================================================
// ABI
// ===========================================================================

pub const GET_POOL_AND_POSITION_INFO: &str = "getPoolAndPositionInfo(uint256)";
/// A `PoolKey` tuple followed by the packed `PositionInfo` word.
pub const GET_POOL_AND_POSITION_INFO_OUTPUTS: &str =
    "(address,address,uint24,int24,address),uint256";
pub const GET_POSITION_LIQUIDITY: &str = "getPositionLiquidity(uint256)";
pub const GET_SLOT0: &str = "getSlot0(bytes32)";
pub const GET_SLOT0_OUTPUTS: &str = "uint160,int24,uint24,uint24";
pub const GET_FEE_GROWTH_INSIDE: &str = "getFeeGrowthInside(bytes32,int24,int24)";
pub const GET_FEE_GROWTH_INSIDE_OUTPUTS: &str = "uint256,uint256";
pub const GET_POSITION_INFO: &str = "getPositionInfo(bytes32,bytes32)";
pub const GET_POSITION_INFO_OUTPUTS: &str = "uint128,uint256,uint256";

/// Bit offset of `tickLower` inside the `PositionInfo` word.
const TICK_LOWER_SHIFT: u32 = 8;
/// Bit offset of `tickUpper`.
const TICK_UPPER_SHIFT: u32 = 32;
/// Both ticks are 24-bit fields.
const TICK_MASK: u64 = 0xFF_FFFF;
/// Fee growth is Q128.128, so the earned amount shifts off 128 fractional bits.
const FEE_GROWTH_SHIFT: u32 = 128;

// ===========================================================================
// Identifiers
// ===========================================================================

/// `poolId = keccak(abi.encode(currency0, currency1, fee, tickSpacing, hooks))`.
///
/// Standard (32-byte-padded) encoding, not packed — v4 hashes the `PoolKey` struct as ABI-encoded
/// data. Pinned in the tests against the value the Python produces for a real Base pool.
pub fn pool_id(
    currency0: &str,
    currency1: &str,
    fee: u32,
    tick_spacing: i32,
    hooks: &str,
) -> Result<[u8; 32]> {
    let encoded = abi::encode(&[
        Value::address(currency0)?,
        Value::address(currency1)?,
        Value::uint(fee),
        Value::int(i128::from(tick_spacing)),
        Value::address(hooks)?,
    ]);
    Ok(abi::keccak256(&encoded))
}

/// `positionId = keccak(abi.encodePacked(positionManager, tickLower, tickUpper, salt=tokenId))`.
///
/// **Packed**, unlike [`pool_id`] — so the ticks occupy three bytes each, not thirty-two. Mixing
/// the two encodings yields a valid-looking hash that addresses nothing, which reads as a
/// position with no fees rather than as an error.
pub fn position_id(
    position_manager: &str,
    tick_lower: i32,
    tick_upper: i32,
    token_id: U256,
) -> Result<[u8; 32]> {
    let packed = abi::encode_packed(
        "address,int24,int24,bytes32",
        &[
            Value::address(position_manager)?,
            Value::int(i128::from(tick_lower)),
            Value::int(i128::from(tick_upper)),
            Value::bytes32(token_id.to_be_bytes()),
        ],
    )?;
    Ok(abi::keccak256(&packed))
}

/// Unpack `tickLower`/`tickUpper` from a `PositionInfo` word.
///
/// The fields are 24-bit two's-complement, so they go through [`lp_math::s24`]; read unsigned, a
/// tick of `-202000` would become `16575216` and put the position's range in another universe.
pub fn ticks_from_position_info(info: U256) -> (i32, i32) {
    let field = |shift: u32| -> u32 {
        // Mask first, so only the 24 bits of interest survive into the narrowing.
        (info.shr(shift).low_u64() & TICK_MASK) as u32
    };
    (
        lp_math::s24(field(TICK_LOWER_SHIFT)),
        lp_math::s24(field(TICK_UPPER_SHIFT)),
    )
}

// ===========================================================================
// Token id discovery — Blockscout, because v4 NFTs are not enumerable
// ===========================================================================

/// Pull the v4 token ids out of a Blockscout `/addresses/{a}/nft` response.
///
/// Matches the position manager case-insensitively, exactly as the Python lowercases both sides.
/// Entries with an unparseable id are skipped rather than aborting the page — the Python would
/// raise, but one malformed NFT should not cost the wallet every other position.
pub fn parse_token_ids(body: &Json, position_manager: &str) -> Vec<U256> {
    let pm = position_manager.to_lowercase();
    let Some(items) = body.get("items").and_then(Json::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| {
            item.pointer("/token/address_hash")
                .and_then(Json::as_str)
                .is_some_and(|a| a.to_lowercase() == pm)
        })
        .filter_map(|item| {
            let id = item.get("id")?;
            let text = id
                .as_str()
                .map(str::to_string)
                .or_else(|| id.as_u64().map(|n| n.to_string()))?;
            U256::from_dec_str(&text).ok()
        })
        .collect()
}

/// Fetch one owner's v4 token ids through the record/replay cache.
///
/// Returns an empty list rather than an error when Blockscout is unreachable or the body is not
/// JSON — the Python swallows the failure per owner and moves on, since a missing NFT index means
/// "no v4 positions found", not "the wallet is broken".
pub async fn fetch_token_ids(
    client: &reqwest::Client,
    cache: &HttpCache,
    blockscout: &str,
    owner: &str,
    position_manager: &str,
) -> Vec<U256> {
    let url = format!("{blockscout}/api/v2/addresses/{owner}/nft?type=ERC-721");
    let Ok(recorded) = cache.get(client, &url).await else {
        return Vec::new();
    };
    match serde_json::from_str::<Json>(&recorded.body) {
        Ok(body) => parse_token_ids(&body, position_manager),
        Err(_) => Vec::new(),
    }
}

// ===========================================================================
// Uncollected fees
// ===========================================================================

/// Uncollected fees of a v4 position — `portfolio.py:_v4_uncollected_fees`.
///
/// Two differences from v3 worth stating, because both are easy to "fix" into a bug:
///
/// * the liquidity used is the one `getPositionInfo` reports for **this position**, not the
///   `getPositionLiquidity` value the adapter reads for the range check;
/// * there is no `tokensOwed` term — v4 has no such concept, so uncollected fees are purely the
///   growth since the position last settled.
///
/// The subtraction wraps modulo 2^256 for the same reason as v3: fee-growth counters are allowed
/// to overflow, and the modular delta stays correct across the wrap.
pub fn uncollected_fees(
    liquidity: u128,
    fee_growth_inside0: U256,
    fee_growth_inside1: U256,
    last0: U256,
    last1: U256,
) -> Result<(U256, U256)> {
    let earned = |inside: U256, last: U256| -> Result<U256> {
        let delta = inside.wrapping_sub(last);
        U256::from_u128(liquidity)
            .mul_shr(delta, FEE_GROWTH_SHIFT)
            .ok_or_else(|| {
                anyhow!(
                    "v4 fee growth overflowed: liquidity {liquidity} x delta {delta:#x} \
                     >> {FEE_GROWTH_SHIFT} does not fit in 256 bits"
                )
            })
    };
    Ok((
        earned(fee_growth_inside0, last0)?,
        earned(fee_growth_inside1, last1)?,
    ))
}

/// Read a position's fee state from `StateView` and reduce it to raw token amounts.
pub async fn read_uncollected_fees(
    rpc: &dyn EvmRpc,
    stateview: &str,
    pool_id: [u8; 32],
    position_id: [u8; 32],
    tick_lower: i32,
    tick_upper: i32,
) -> Result<(U256, U256)> {
    let info = rpc
        .call_typed(
            stateview,
            GET_POSITION_INFO,
            &[Value::bytes32(pool_id), Value::bytes32(position_id)],
            GET_POSITION_INFO_OUTPUTS,
        )
        .await?;
    let liquidity = info
        .first()
        .ok_or_else(|| anyhow!("getPositionInfo returned nothing"))?
        .as_u128()?;
    let last0 = info[1].as_u256()?;
    let last1 = info[2].as_u256()?;

    let inside = rpc
        .call_typed(
            stateview,
            GET_FEE_GROWTH_INSIDE,
            &[
                Value::bytes32(pool_id),
                Value::int(i128::from(tick_lower)),
                Value::int(i128::from(tick_upper)),
            ],
            GET_FEE_GROWTH_INSIDE_OUTPUTS,
        )
        .await?;

    uncollected_fees(
        liquidity,
        inside[0].as_u256()?,
        inside[1].as_u256()?,
        last0,
        last1,
    )
}

// ===========================================================================
// Reading positions
// ===========================================================================

/// The `PoolKey` plus the unpacked position state for one v4 token id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V4Position {
    pub token_id: U256,
    pub currency0: String,
    pub currency1: String,
    pub fee: u32,
    pub tick_spacing: i32,
    pub hooks: String,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub pool_id: [u8; 32],
}

/// Read one v4 position, or `None` if its liquidity is zero (a closed position).
pub async fn read_position(
    rpc: &dyn EvmRpc,
    position_manager: &str,
    token_id: U256,
) -> Result<Option<V4Position>> {
    let out = rpc
        .call_typed(
            position_manager,
            GET_POOL_AND_POSITION_INFO,
            &[Value::uint(token_id)],
            GET_POOL_AND_POSITION_INFO_OUTPUTS,
        )
        .await?;
    let key = out
        .first()
        .ok_or_else(|| anyhow!("getPoolAndPositionInfo returned nothing"))?
        .as_tuple()?;
    if key.len() != 5 {
        return Err(anyhow!("PoolKey has {} fields, expected 5", key.len()));
    }
    let info = out[1].as_u256()?;

    let liquidity = rpc
        .call_one(
            position_manager,
            GET_POSITION_LIQUIDITY,
            &[Value::uint(token_id)],
            "uint128",
        )
        .await?
        .as_u128()?;
    if liquidity == 0 {
        return Ok(None);
    }

    let currency0 = key[0].as_address_string()?;
    let currency1 = key[1].as_address_string()?;
    let fee = u32::try_from(key[2].as_u64()?).context("fee tier does not fit in u32")?;
    let tick_spacing = key[3].as_i32()?;
    let hooks = key[4].as_address_string()?;
    let (tick_lower, tick_upper) = ticks_from_position_info(info);

    Ok(Some(V4Position {
        token_id,
        pool_id: pool_id(&currency0, &currency1, fee, tick_spacing, &hooks)?,
        currency0,
        currency1,
        fee,
        tick_spacing,
        hooks,
        tick_lower,
        tick_upper,
        liquidity,
    }))
}

/// Read every v4 LP for the given `(tokenId, via)` pairs.
///
/// Produces [`RawPosition`]s so the shared [`super::univ3::build_position`] can value them —
/// the same reuse the Python gets from calling `_lp_position` for both versions. The v3-only
/// fields of the embedded [`PositionRead`] carry v4's equivalents where they exist and zero
/// where they do not (v4 has no `tokensOwed`).
///
/// A failure on one token id is logged and skipped, matching the Python's per-position
/// `try/except`.
pub async fn read_positions(
    rpc: &dyn EvmRpc,
    position_manager: &str,
    stateview: &str,
    ids: &[(U256, Option<String>)],
) -> Vec<RawPosition> {
    let mut out = Vec::new();
    for (token_id, via) in ids {
        match read_one(rpc, position_manager, stateview, *token_id, via.clone()).await {
            Ok(Some(position)) => out.push(position),
            Ok(None) => {}
            Err(e) => tracing::warn!(token_id = %token_id, error = ?e, "v4 position skipped"),
        }
    }
    out
}

async fn read_one(
    rpc: &dyn EvmRpc,
    position_manager: &str,
    stateview: &str,
    token_id: U256,
    via: Option<String>,
) -> Result<Option<RawPosition>> {
    let Some(v4) = read_position(rpc, position_manager, token_id).await? else {
        return Ok(None);
    };

    let slot0 = rpc
        .call_typed(
            stateview,
            GET_SLOT0,
            &[Value::bytes32(v4.pool_id)],
            GET_SLOT0_OUTPUTS,
        )
        .await?;
    let sqrt_price_x96 = slot0
        .first()
        .ok_or_else(|| anyhow!("getSlot0 returned nothing"))?
        .as_u256()?;
    let cur_tick = slot0[1].as_i32()?;

    let position_id = position_id(position_manager, v4.tick_lower, v4.tick_upper, token_id)?;
    let (fee0_raw, fee1_raw) = read_uncollected_fees(
        rpc,
        stateview,
        v4.pool_id,
        position_id,
        v4.tick_lower,
        v4.tick_upper,
    )
    .await
    .with_context(|| format!("uncollected fees for v4 #{token_id}"))?;

    Ok(Some(RawPosition {
        token_id,
        position: PositionRead {
            token0: v4.currency0,
            token1: v4.currency1,
            fee: v4.fee,
            tick_lower: v4.tick_lower,
            tick_upper: v4.tick_upper,
            liquidity: v4.liquidity,
            // v4 settles fee growth per position inside StateView, and has no `tokensOwed`;
            // these carry no information once `fee*_raw` is computed.
            fee_growth_inside_last0: U256::ZERO,
            fee_growth_inside_last1: U256::ZERO,
            tokens_owed0: 0,
            tokens_owed1: 0,
        },
        // v4 has no per-pool contract; the singleton PoolManager holds the liquidity, so the
        // pool "address" is the derived id.
        pool: abi::hex_encode(&v4.pool_id),
        sqrt_price_x96,
        cur_tick,
        fee0_raw,
        fee1_raw,
        via,
        // The `PoolKey` states the spacing, so it is used verbatim rather than inferred from the
        // fee tier — `_lp_position(..., tick_spacing=spacing)` in the Python.
        tick_spacing: Some(i64::from(v4.tick_spacing)),
    }))
}

// ===========================================================================
// The adapter
// ===========================================================================

/// Protocol label, as it appears in the response and in the UI.
pub const PROTOCOL: &str = "Uniswap v4";

/// Every Uniswap v4 LP held by `owners` on `chain` — the port of `adapt_univ4` (L837).
///
/// Returns `Ok(vec![])` in three cases the Python also treats as "nothing here": the chain has no
/// v4 deployment, the chain has no Blockscout instance to discover token ids with, or no owner
/// holds a PositionManager NFT. The middle one is not hypothetical — token id discovery is the
/// one part of this adapter that cannot fall back to the RPC, so a chain without an indexer can
/// run v4 and still be unreadable here.
///
/// Unlike [`super::univ3::adapt_univ3`] this cannot fail as a whole: [`read_positions`] already
/// logs and skips a bad token id, and a leg whose metadata cannot be read costs that position
/// alone. That asymmetry is the Python's — `adapt_univ4` wraps its per-id body in `try/except`
/// and `adapt_univ3` does not.
pub async fn adapt_univ4<P>(
    rpc: &dyn EvmRpc,
    client: &reqwest::Client,
    cache: &HttpCache,
    prices: &P,
    chain: &Chain,
    owners: &[(String, Option<String>)],
) -> Vec<Position>
where
    P: PriceSource + ?Sized,
{
    let (Some(cfg), Some(blockscout)) = (chain.univ4, chain.blockscout) else {
        return Vec::new();
    };

    let mut ids: Vec<(U256, Option<String>)> = Vec::new();
    for (owner, via) in owners {
        for token_id in fetch_token_ids(client, cache, blockscout, owner, cfg.pm).await {
            ids.push((token_id, via.clone()));
        }
    }
    if ids.is_empty() {
        return Vec::new();
    }

    let raw = read_positions(rpc, cfg.pm, cfg.stateview, &ids).await;
    let meta = TokenMeta::new();
    let mut out = Vec::with_capacity(raw.len());
    for position in &raw {
        let token0 = valuation(rpc, &meta, prices, chain, &position.position.token0).await;
        let token1 = valuation(rpc, &meta, prices, chain, &position.position.token1).await;
        match (token0, token1) {
            (Ok(token0), Ok(token1)) => out.push(build_position(
                PROTOCOL,
                position,
                &token0,
                &token1,
                position.tick_spacing,
            )),
            (Err(e), _) | (_, Err(e)) => {
                tracing::warn!(
                    token_id = %position.token_id,
                    chain = chain.name,
                    error = format!("{e:#}"),
                    "v4 position skipped: could not value its tokens"
                );
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::aero_cl::StaticPrices;
    use crate::adapters::univ3::TokenValuation;
    use crate::evm::MockRpc;
    use crate::http_cache::{Mode, Recorded, cache_key};
    use serde_json::json;
    use std::path::Path;
    use tempfile::TempDir;

    // Base mainnet deployment, matching `chains.rs`.
    const PM: &str = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
    const SV: &str = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
    const WETH: &str = "0x4200000000000000000000000000000000000006";
    const USDC: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const NO_HOOKS: &str = "0x0000000000000000000000000000000000000000";
    const OWNER: &str = "0x1111111111111111111111111111111111111111";

    fn q128() -> U256 {
        U256::ONE.shl(128)
    }

    fn q128_times(n: u64) -> U256 {
        q128().wrapping_mul(U256::from(n))
    }

    fn dec(s: &str) -> U256 {
        U256::from_dec_str(s).unwrap()
    }

    // ---- identifiers ------------------------------------------------------
    //
    // Both expectations come from running the real Python: `pool_id` from the same
    // `keccak(abi_encode(...))` line `adapt_univ4` uses, and `pos_id` captured out of a call to
    // the real `portfolio._v4_uncollected_fees` with a stubbed StateView.

    #[test]
    fn the_pool_id_matches_the_python_derivation() {
        let id = pool_id(WETH, USDC, 500, 10, NO_HOOKS).unwrap();
        assert_eq!(
            abi::hex_encode(&id),
            "0x90333bb05c258fe0dddb2840ef66f1a05165aa7dac6815d24e807cc6ebd943a0"
        );
    }

    #[test]
    fn the_position_id_matches_the_python_derivation() {
        let id = position_id(PM, -60, 60, U256::from(12345u64)).unwrap();
        assert_eq!(
            abi::hex_encode(&id),
            "0x600f31d61de4684f1ebafdb4ddd0454d2c26c31dc0f725c1b4f3944af2e67540"
        );
    }

    #[test]
    fn the_position_id_is_packed_not_padded() {
        // 20-byte address + 3 + 3 + 32 = 58 bytes. Padded encoding would be 128 and would hash
        // to something else entirely — a position whose fees always read as zero.
        let packed = abi::encode_packed(
            "address,int24,int24,bytes32",
            &[
                Value::address(PM).unwrap(),
                Value::int(-60),
                Value::int(60),
                Value::bytes32(U256::from(12345u64).to_be_bytes()),
            ],
        )
        .unwrap();
        assert_eq!(packed.len(), 58);
    }

    #[test]
    fn the_two_id_encodings_are_not_interchangeable() {
        let padded = abi::encode(&[
            Value::address(PM).unwrap(),
            Value::int(-60),
            Value::int(60),
            Value::bytes32(U256::from(12345u64).to_be_bytes()),
        ]);
        assert_eq!(padded.len(), 128);
        assert_ne!(
            abi::keccak256(&padded),
            position_id(PM, -60, 60, U256::from(12345u64)).unwrap()
        );
    }

    // ---- PositionInfo unpacking ------------------------------------------

    fn pack_info(tick_lower: i32, tick_upper: i32) -> U256 {
        let enc = |t: i32| U256::from((i64::from(t) & TICK_MASK as i64) as u64);
        enc(tick_lower)
            .shl(TICK_LOWER_SHIFT)
            .wrapping_add(enc(tick_upper).shl(TICK_UPPER_SHIFT))
    }

    #[test]
    fn the_packed_ticks_round_trip_including_negative_ones() {
        for (lower, upper) in [
            (-60, 60),
            (0, 1),
            (-202_000, -196_000),
            (-887_272, 887_272),
            (-1, 1),
        ] {
            assert_eq!(
                ticks_from_position_info(pack_info(lower, upper)),
                (lower, upper),
                "ticks [{lower}, {upper}]"
            );
        }
    }

    #[test]
    fn a_high_pool_id_in_the_info_word_does_not_bleed_into_the_ticks() {
        // The real word carries the poolId in the bits above 56; masking must isolate the ticks.
        let info = pack_info(-60, 60).wrapping_add(U256::MAX.shl(56));
        assert_eq!(ticks_from_position_info(info), (-60, 60));
    }

    #[test]
    fn a_subscriber_flag_in_the_low_bits_does_not_shift_the_ticks() {
        let info = pack_info(-60, 60).wrapping_add(U256::ONE);
        assert_eq!(ticks_from_position_info(info), (-60, 60));
    }

    // ---- fees -------------------------------------------------------------
    //
    // Expectations produced by executing the real `portfolio._v4_uncollected_fees` with a stub
    // StateView returning these exact values.

    #[test]
    fn v4_fees_match_the_python() {
        let (fee0, fee1) = uncollected_fees(
            1_000_000_000_000_000,
            q128_times(350),
            q128_times(500),
            q128_times(300),
            q128_times(400),
        )
        .unwrap();
        assert_eq!(fee0, dec("50000000000000000"));
        assert_eq!(fee1, dec("100000000000000000"));
    }

    #[test]
    fn a_wrapped_v4_fee_counter_yields_the_right_delta() {
        // `last` sits just below 2^256; the modular subtraction recovers 360 and 505 Q128 units.
        let (fee0, fee1) = uncollected_fees(
            1_000_000_000_000_000,
            q128_times(350),
            q128_times(500),
            U256::ZERO.wrapping_sub(q128_times(10)),
            U256::ZERO.wrapping_sub(q128_times(5)),
        )
        .unwrap();
        assert_eq!(fee0, dec("360000000000000000"));
        assert_eq!(fee1, dec("505000000000000000"));
    }

    #[test]
    fn zero_liquidity_earns_no_v4_fees_and_there_is_no_tokens_owed_term() {
        // Unlike v3 there is no `tokensOwed` fallback, so a zero-liquidity position is zero.
        let (fee0, fee1) = uncollected_fees(
            0,
            q128_times(350),
            q128_times(500),
            q128_times(300),
            q128_times(400),
        )
        .unwrap();
        assert_eq!(fee0, U256::ZERO);
        assert_eq!(fee1, U256::ZERO);
    }

    #[test]
    fn the_worst_possible_v4_inputs_still_fit_in_256_bits() {
        // Same bound as v3, minus the tokensOwed term: liquidity is a uint128 and the wrapped
        // delta is at most 2^256-1, so `liquidity * delta >> 128` can never exceed U256. The
        // error arm is defensive only, and our answer can never differ from the Python's.
        let (fee0, fee1) =
            uncollected_fees(u128::MAX, U256::MAX, U256::MAX, U256::ZERO, U256::ZERO)
                .expect("the maximum is representable");
        assert_eq!(fee0, fee1);
        assert_eq!(
            fee0,
            U256::from_u128(u128::MAX).mul_shr(U256::MAX, 128).unwrap()
        );
    }

    // ---- token id discovery -----------------------------------------------

    #[test]
    fn token_ids_are_matched_against_the_position_manager_case_insensitively() {
        let body = json!({"items": [
            {"id": "12345", "token": {"address_hash": PM.to_lowercase()}},
            {"id": "6789",  "token": {"address_hash": PM.to_uppercase()}},
            {"id": "1",     "token": {"address_hash": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}},
        ]});
        let ids = parse_token_ids(&body, PM);
        assert_eq!(ids, vec![U256::from(12345u64), U256::from(6789u64)]);
    }

    #[test]
    fn a_missing_or_malformed_nft_page_yields_no_ids_rather_than_an_error() {
        for body in [
            json!({}),
            json!({"items": []}),
            json!({"items": [{"id": "nonsense", "token": {"address_hash": PM}}]}),
            json!({"items": [{"token": {"address_hash": PM}}]}),
            json!({"items": [{"id": "5"}]}),
        ] {
            assert!(parse_token_ids(&body, PM).is_empty(), "{body}");
        }
    }

    #[test]
    fn a_numeric_json_id_is_accepted_as_well_as_a_string() {
        let body = json!({"items": [{"id": 42, "token": {"address_hash": PM}}]});
        assert_eq!(parse_token_ids(&body, PM), vec![U256::from(42u64)]);
    }

    // ---- the full read ----------------------------------------------------

    fn mock(tick_lower: i32, tick_upper: i32, liquidity: u128, cur_tick: i32) -> MockRpc {
        let token_id = U256::from(12345u64);
        let pid = pool_id(WETH, USDC, 500, 10, NO_HOOKS).unwrap();
        let posid = position_id(PM, tick_lower, tick_upper, token_id).unwrap();
        MockRpc::new()
            .returns(
                PM,
                GET_POOL_AND_POSITION_INFO,
                &[Value::uint(token_id)],
                &[
                    Value::Tuple(vec![
                        Value::address(WETH).unwrap(),
                        Value::address(USDC).unwrap(),
                        Value::uint(500u64),
                        Value::int(10),
                        Value::address(NO_HOOKS).unwrap(),
                    ]),
                    Value::uint(pack_info(tick_lower, tick_upper)),
                ],
            )
            .unwrap()
            .returns(
                PM,
                GET_POSITION_LIQUIDITY,
                &[Value::uint(token_id)],
                &[Value::uint(liquidity)],
            )
            .unwrap()
            .returns(
                SV,
                GET_SLOT0,
                &[Value::bytes32(pid)],
                &[
                    Value::uint(U256::ONE.shl(96)),
                    Value::int(i128::from(cur_tick)),
                    Value::uint(0u64),
                    Value::uint(0u64),
                ],
            )
            .unwrap()
            .returns(
                SV,
                GET_POSITION_INFO,
                &[Value::bytes32(pid), Value::bytes32(posid)],
                &[
                    Value::uint(liquidity),
                    Value::uint(q128_times(300)),
                    Value::uint(q128_times(400)),
                ],
            )
            .unwrap()
            .returns(
                SV,
                GET_FEE_GROWTH_INSIDE,
                &[
                    Value::bytes32(pid),
                    Value::int(i128::from(tick_lower)),
                    Value::int(i128::from(tick_upper)),
                ],
                &[Value::uint(q128_times(350)), Value::uint(q128_times(500))],
            )
            .unwrap()
    }

    fn ids() -> Vec<(U256, Option<String>)> {
        vec![(U256::from(12345u64), None)]
    }

    #[tokio::test]
    async fn a_whole_v4_position_reads_end_to_end() {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let found = read_positions(&rpc, PM, SV, &ids()).await;

        assert_eq!(found.len(), 1);
        let raw = &found[0];
        assert_eq!(raw.token_id, U256::from(12345u64));
        assert_eq!(raw.position.fee, 500);
        assert_eq!(
            (raw.position.tick_lower, raw.position.tick_upper),
            (-60, 60)
        );
        assert!(raw.in_range());
        assert_eq!(raw.fee0_raw, dec("50000000000000000"));
        assert_eq!(raw.fee1_raw, dec("100000000000000000"));
    }

    #[tokio::test]
    async fn a_closed_v4_position_is_skipped_before_any_stateview_call() {
        let rpc = mock(-60, 60, 0, 0);
        assert!(read_positions(&rpc, PM, SV, &ids()).await.is_empty());
        assert!(
            !rpc.calls().iter().any(|c| c.to.eq_ignore_ascii_case(SV)),
            "no StateView reads for a closed position"
        );
    }

    #[tokio::test]
    async fn one_broken_position_does_not_hide_the_others() {
        // The Python catches per token id and writes to stderr; losing a whole wallet because a
        // single pool has an exotic hook would be much worse than losing one row.
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let ids = vec![
            (U256::from(999u64), None), // never stubbed -> the read fails
            (U256::from(12345u64), None),
        ];
        let found = read_positions(&rpc, PM, SV, &ids).await;
        assert_eq!(found.len(), 1, "the good position still comes through");
        assert_eq!(found[0].token_id, U256::from(12345u64));
    }

    #[tokio::test]
    async fn the_range_check_uses_the_unpacked_ticks() {
        for (cur, expected) in [(-61, false), (-60, true), (59, true), (60, false)] {
            let rpc = mock(-60, 60, 1_000_000_000_000_000, cur);
            let found = read_positions(&rpc, PM, SV, &ids()).await;
            assert_eq!(found[0].in_range(), expected, "tick {cur}");
        }
    }

    #[tokio::test]
    async fn a_v4_position_values_through_the_shared_v3_builder() {
        // The Python calls the same `_lp_position` for both versions; so do we, which is what
        // keeps the two adapters' output shapes identical.
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let raw = read_positions(&rpc, PM, SV, &ids()).await.remove(0);
        let t0 = TokenValuation {
            decimals: 18,
            symbol: "WETH".into(),
            price: 3200.0,
            change24h: Some(1.5),
        };
        let t1 = TokenValuation {
            decimals: 6,
            symbol: "USDC".into(),
            price: 1.0,
            change24h: Some(0.0),
        };
        let position = build_position("Uniswap v4", &raw, &t0, &t1, Some(10));

        assert_eq!(position.protocol, "Uniswap v4");
        assert_eq!(position.name, "WETH/USDC 0.05%");
        assert_eq!(position.id, Some(Some("#12345".to_string())));
        assert_eq!(
            position.tick_spacing,
            Some(10),
            "v4 carries its own spacing rather than using the v3 fee table"
        );
        assert_eq!(position.in_range, Some(true));
        assert!(position.price_band.is_some());
    }

    // ---- the adapter ------------------------------------------------------

    fn base() -> &'static Chain {
        crate::chains::by_name("base").expect("base is in the chain table")
    }

    fn owners() -> Vec<(String, Option<String>)> {
        vec![(OWNER.to_string(), None)]
    }

    /// The `decimals()`/`symbol()` answers [`valuation`] needs for the pair.
    fn with_token_meta(rpc: MockRpc) -> MockRpc {
        rpc.returns(WETH, "decimals()", &[], &[Value::uint(18u64)])
            .unwrap()
            .returns(WETH, "symbol()", &[], &[Value::String("WETH".into())])
            .unwrap()
            .returns(USDC, "decimals()", &[], &[Value::uint(6u64)])
            .unwrap()
            .returns(USDC, "symbol()", &[], &[Value::String("USDC".into())])
            .unwrap()
    }

    fn priced() -> StaticPrices {
        StaticPrices::new()
            .with(WETH, 3200.0, Some(1.5))
            .with(USDC, 1.0, Some(0.0))
    }

    /// A replay-only cache holding one Blockscout NFT page for `owner`.
    ///
    /// `Mode::Replay` is the point: the adapter cannot reach the network in a test, so a miss is
    /// an explicit empty answer rather than a silent live call.
    fn seeded_nfts(dir: &Path, owner: &str, body: &str) -> HttpCache {
        let url = format!(
            "{}/api/v2/addresses/{owner}/nft?type=ERC-721",
            base().blockscout.expect("base has a blockscout instance")
        );
        let recorded = Recorded {
            url: url.clone(),
            method: "GET".into(),
            status: 200,
            body: body.to_string(),
        };
        let path = dir.join(format!("{}.json", cache_key("GET", &url, None)));
        std::fs::write(path, serde_json::to_string_pretty(&recorded).unwrap()).unwrap();
        HttpCache::new(dir, Mode::Replay)
    }

    /// A Blockscout NFT page holding one PositionManager token plus an unrelated NFT.
    fn nft_page() -> String {
        json!({
            "items": [
                {"id": "12345", "token": {"address_hash": PM}},
                {"id": "999", "token": {"address_hash": "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"}},
            ]
        })
        .to_string()
    }

    #[tokio::test]
    async fn the_adapter_discovers_a_token_id_and_values_it() {
        let dir = TempDir::new().unwrap();
        let cache = seeded_nfts(dir.path(), OWNER, &nft_page());
        let rpc = with_token_meta(mock(-60, 60, 1_000_000_000_000_000, 0));

        let found = adapt_univ4(
            &rpc,
            &reqwest::Client::new(),
            &cache,
            &priced(),
            base(),
            &owners(),
        )
        .await;

        assert_eq!(found.len(), 1, "the non-PositionManager NFT is not a v4 LP");
        let position = &found[0];
        assert_eq!(position.protocol, PROTOCOL);
        assert_eq!(position.name, "WETH/USDC 0.05%");
        assert_eq!(
            position.tick_spacing,
            Some(10),
            "the PoolKey's spacing rides through, rather than the v3 fee table's 10 by luck"
        );
        assert_eq!(position.in_range, Some(true));
    }

    #[tokio::test]
    async fn no_position_manager_nfts_means_no_chain_reads_at_all() {
        let dir = TempDir::new().unwrap();
        let cache = seeded_nfts(dir.path(), OWNER, r#"{"items":[]}"#);
        let rpc = MockRpc::new();

        let found = adapt_univ4(
            &rpc,
            &reqwest::Client::new(),
            &cache,
            &priced(),
            base(),
            &owners(),
        )
        .await;

        assert!(found.is_empty());
        assert_eq!(
            rpc.call_count(),
            0,
            "discovery comes first; with no ids there is nothing to read"
        );
    }

    #[tokio::test]
    async fn a_chain_without_a_v4_deployment_reads_nothing_and_calls_nothing() {
        let dir = TempDir::new().unwrap();
        let cache = HttpCache::new(dir.path(), Mode::Replay);
        let rpc = MockRpc::new();
        let bnb = crate::chains::by_name("bnb").expect("bnb is in the chain table");

        let found = adapt_univ4(
            &rpc,
            &reqwest::Client::new(),
            &cache,
            &priced(),
            bnb,
            &owners(),
        )
        .await;

        assert!(found.is_empty());
        assert_eq!(rpc.call_count(), 0);
    }

    #[test]
    fn every_v4_chain_has_an_indexer_to_discover_token_ids_with() {
        // Token id discovery is the one step of this adapter with no RPC fallback, so a chain
        // configured for v4 but with no Blockscout instance would be silently unreadable — the
        // adapter would answer `[]` for a wallet that holds positions. There is no such chain
        // today; this fails the moment one is added, which is when the empty-vs-unreadable
        // distinction stops being hypothetical.
        for chain in crate::chains::CHAINS {
            assert!(
                chain.univ4.is_none() || chain.blockscout.is_some(),
                "{} runs Uniswap v4 but has no Blockscout to enumerate its NFTs",
                chain.name
            );
        }
    }

    #[tokio::test]
    async fn a_leg_whose_metadata_cannot_be_read_costs_that_position_alone() {
        // The asymmetry with v3: `adapt_univ4` wraps each token id in try/except, so an
        // unreadable token is a skipped position, not a failed adapter.
        let dir = TempDir::new().unwrap();
        let cache = seeded_nfts(dir.path(), OWNER, &nft_page());
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0); // no decimals()/symbol() stubs

        let found = adapt_univ4(
            &rpc,
            &reqwest::Client::new(),
            &cache,
            &priced(),
            base(),
            &owners(),
        )
        .await;

        assert!(
            found.is_empty(),
            "the position is dropped, and the adapter still returns normally"
        );
    }

    #[tokio::test]
    async fn the_via_label_rides_from_the_owner_list_to_the_position() {
        let dir = TempDir::new().unwrap();
        let cache = seeded_nfts(dir.path(), OWNER, &nft_page());
        let rpc = with_token_meta(mock(-60, 60, 1_000_000_000_000_000, 0));
        let owners = vec![(OWNER.to_string(), Some("vfat.io".to_string()))];

        let found = adapt_univ4(
            &rpc,
            &reqwest::Client::new(),
            &cache,
            &priced(),
            base(),
            &owners,
        )
        .await;

        assert_eq!(found[0].via.as_deref(), Some("vfat.io"));
    }
}
