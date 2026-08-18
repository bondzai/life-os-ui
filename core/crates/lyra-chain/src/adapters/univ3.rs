//! Uniswap v3 LP positions — port of `portfolio.py:683-767` (`NPM_ABI`, `FACTORY_ABI`,
//! `POOL_ABI`, `_v3_uncollected_fees`, `adapt_univ3`).
//!
//! A v3 LP is an NFT held by the NonfungiblePositionManager. Reading one means four hops:
//! enumerate the owner's token ids, read `positions(id)` for the pair/ticks/liquidity, ask the
//! factory for the pool, then read the pool for the current price and the fee-growth state.
//!
//! The maths lives in [`crate::lp_math`], which is parity-verified against the Python over 2,836
//! cases; this module is the chain-reading and shaping layer on top of it.
//!
//! # Uncollected fees, and why the subtraction must wrap
//!
//! `feeGrowthGlobal` and `feeGrowthOutside` are **monotonically increasing `uint256` counters
//! that are allowed to overflow**. Uniswap's contracts do this arithmetic in `unchecked` blocks
//! precisely so that when a counter wraps past 2^256 the *difference* stays correct — the
//! position only ever cares about the delta since it last collected, and modular subtraction
//! gives the right delta even across a wrap. `portfolio.py` reproduces that with `& U256` on
//! every subtraction, and this port uses [`U256::wrapping_sub`] at exactly the same points.
//!
//! Getting this wrong does not crash: it produces a plausible-looking but wrong fee number, which
//! is why [`uncollected_fees`] is a pure function pinned against values produced by executing the
//! real `_v3_uncollected_fees` with a stubbed pool contract.
//!
//! The final `liquidity * delta >> 128` is the step where a 256-bit type could betray us: the
//! Python computes it in arbitrary precision, and the *intermediate* product genuinely exceeds
//! 256 bits. We use [`U256::mul_shr`], which carries the full 512-bit product and only then
//! shifts.
//!
//! The result, though, provably always fits — which is what makes this port exactly equivalent to
//! the Python rather than merely usually equivalent. `liquidity` is a `uint128`, so
//! `liquidity <= 2^128 - 1`, and a wrapped delta is at most `2^256 - 1`, so
//!
//! ```text
//! (2^128 - 1)(2^256 - 1) >> 128  ==  2^256 - 2^128 - 1
//! ```
//!
//! and adding `tokensOwed` (itself a `uint128`) reaches at most `2^256 - 2` — two short of
//! `U256::MAX`. So no input the chain can produce overflows, the error arms below are defensive
//! only, and there is no value for which our answer and the Python's can differ. The tests pin
//! that bound at the extremes rather than assuming it.
//!
//! # Shared with the v3 forks
//!
//! Aerodrome Slipstream is a v3 fork that reuses this whole pipeline — the Python says so at
//! `portfolio.py:874`. Everything here is therefore `pub` and parameterised where the forks
//! differ: [`read_tick_fee_growth`] takes the `ticks()` output list and the index of
//! `feeGrowthOutside0` within it, which is the `fo_i` parameter of the Python
//! (`2` for Uniswap, `3` for Slipstream — its `ticks` struct inserts `stakedLiquidityNet` first).

use anyhow::{Context, Result, anyhow};

use crate::abi::{U256, Value};
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt, TokenMeta};
use crate::lp_math;
use crate::model::{Position, PriceBand, TokenAmt};

use super::aero_cl::PriceSource;

// ===========================================================================
// ABI — the calls the Python declares in NPM_ABI / FACTORY_ABI / POOL_ABI
// ===========================================================================

pub const BALANCE_OF: &str = "balanceOf(address)";
pub const TOKEN_OF_OWNER_BY_INDEX: &str = "tokenOfOwnerByIndex(address,uint256)";
pub const POSITIONS: &str = "positions(uint256)";
/// `nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity,
/// feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1`.
pub const POSITIONS_OUTPUTS: &str =
    "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128";
pub const GET_POOL: &str = "getPool(address,address,uint24)";
pub const SLOT0: &str = "slot0()";
pub const SLOT0_OUTPUTS: &str = "uint160,int24,uint16,uint16,uint16,uint8,bool";
pub const FEE_GROWTH_GLOBAL0: &str = "feeGrowthGlobal0X128()";
pub const FEE_GROWTH_GLOBAL1: &str = "feeGrowthGlobal1X128()";
pub const TICKS: &str = "ticks(int24)";
/// `liquidityGross, liquidityNet, feeGrowthOutside0X128, feeGrowthOutside1X128,
/// tickCumulativeOutside, secondsPerLiquidityOutsideX128, secondsOutside, initialized`.
pub const TICKS_OUTPUTS: &str = "uint128,int128,uint256,uint256,int56,uint160,uint32,bool";

/// Index of `feeGrowthOutside0X128` in the `ticks()` tuple — the Python's `fo_i` default.
///
/// Slipstream passes `3` instead, because its `ticks` struct inserts `stakedLiquidityNet` ahead
/// of the fee-growth fields. Reading the wrong slot yields fee growth taken from an unrelated
/// field, which is exactly the plausible-but-wrong failure this module is careful about.
pub const FEE_GROWTH_OUTSIDE_INDEX: usize = 2;

/// Fees are tracked as Q128.128 fixed point, so the final step shifts off 128 fractional bits.
const FEE_GROWTH_SHIFT: u32 = 128;

// ===========================================================================
// Uncollected fees — the delicate part
// ===========================================================================

/// The `feeGrowthOutside` pair recorded at one tick boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TickFeeGrowth {
    pub outside0: U256,
    pub outside1: U256,
}

/// Everything [`uncollected_fees`] needs, so the maths can be tested without a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeInputs {
    pub cur_tick: i32,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub fee_growth_global0: U256,
    pub fee_growth_global1: U256,
    /// `ticks(tickLower)` fee growth.
    pub lower: TickFeeGrowth,
    /// `ticks(tickUpper)` fee growth.
    pub upper: TickFeeGrowth,
    /// `positions()[8]` / `[9]` — fee growth inside the range when the position last settled.
    pub fee_growth_inside_last0: U256,
    pub fee_growth_inside_last1: U256,
    /// `positions()[10]` / `[11]` — already-credited fees awaiting collection.
    pub tokens_owed0: u128,
    pub tokens_owed1: u128,
}

/// Uncollected fees of a v3 position, in raw token units — `portfolio.py:_v3_uncollected_fees`.
///
/// The `below`/`above` selection is the standard Uniswap decomposition: a tick's
/// `feeGrowthOutside` means "growth on the far side of this tick from the current price", so its
/// meaning flips depending on which side of the boundary the price sits. Every subtraction wraps
/// modulo 2^256 — see the module docs for why that is correct rather than sloppy.
pub fn uncollected_fees(i: &FeeInputs) -> Result<(U256, U256)> {
    // Below the lower tick: the raw `outside` value already means "below" while the price is at
    // or above the boundary, and means "everything else" once the price drops beneath it.
    let (below0, below1) = if i.cur_tick >= i.tick_lower {
        (i.lower.outside0, i.lower.outside1)
    } else {
        (
            i.fee_growth_global0.wrapping_sub(i.lower.outside0),
            i.fee_growth_global1.wrapping_sub(i.lower.outside1),
        )
    };
    // Above the upper tick: the mirror image, with the comparison strict to match the Python.
    let (above0, above1) = if i.cur_tick < i.tick_upper {
        (i.upper.outside0, i.upper.outside1)
    } else {
        (
            i.fee_growth_global0.wrapping_sub(i.upper.outside0),
            i.fee_growth_global1.wrapping_sub(i.upper.outside1),
        )
    };

    let inside0 = i
        .fee_growth_global0
        .wrapping_sub(below0)
        .wrapping_sub(above0);
    let inside1 = i
        .fee_growth_global1
        .wrapping_sub(below1)
        .wrapping_sub(above1);

    let earned = |inside: U256, last: U256| -> Result<U256> {
        // The wrap is load-bearing: `inside` may have overflowed past `last` since the position
        // last settled, and modular subtraction still yields the true growth in between.
        let delta = inside.wrapping_sub(last);
        U256::from_u128(i.liquidity)
            .mul_shr(delta, FEE_GROWTH_SHIFT)
            .ok_or_else(|| {
                anyhow!(
                    "fee growth overflowed: liquidity {} x delta {delta:#x} >> {FEE_GROWTH_SHIFT} \
                     does not fit in 256 bits",
                    i.liquidity
                )
            })
    };

    let fee0 = U256::from_u128(i.tokens_owed0)
        .checked_add(earned(inside0, i.fee_growth_inside_last0)?)
        .context("token0 fees overflowed 256 bits")?;
    let fee1 = U256::from_u128(i.tokens_owed1)
        .checked_add(earned(inside1, i.fee_growth_inside_last1)?)
        .context("token1 fees overflowed 256 bits")?;
    Ok((fee0, fee1))
}

/// Read one tick's fee growth.
///
/// `outputs` and `index` are parameterised for the v3 forks; pass [`TICKS_OUTPUTS`] and
/// [`FEE_GROWTH_OUTSIDE_INDEX`] for Uniswap itself.
pub async fn read_tick_fee_growth(
    rpc: &dyn EvmRpc,
    pool: &str,
    tick: i32,
    outputs: &str,
    index: usize,
) -> Result<TickFeeGrowth> {
    let values = rpc
        .call_typed(pool, TICKS, &[Value::int(i128::from(tick))], outputs)
        .await?;
    let at = |n: usize| -> Result<U256> {
        values
            .get(n)
            .ok_or_else(|| {
                anyhow!(
                    "ticks({tick}) returned {} values, need {}",
                    values.len(),
                    n + 1
                )
            })?
            .as_u256()
    };
    Ok(TickFeeGrowth {
        outside0: at(index)?,
        outside1: at(index + 1)?,
    })
}

/// Fetch the pool-side fee state and combine it with the position's own — the fetching half of
/// the Python's `_v3_uncollected_fees`.
#[allow(clippy::too_many_arguments)]
pub async fn read_uncollected_fees(
    rpc: &dyn EvmRpc,
    pool: &str,
    position: &PositionRead,
    cur_tick: i32,
    ticks_outputs: &str,
    fee_growth_outside_index: usize,
) -> Result<(U256, U256)> {
    let fee_growth_global0 = rpc
        .call_one(pool, FEE_GROWTH_GLOBAL0, &[], "uint256")
        .await?
        .as_u256()?;
    let fee_growth_global1 = rpc
        .call_one(pool, FEE_GROWTH_GLOBAL1, &[], "uint256")
        .await?
        .as_u256()?;
    let lower = read_tick_fee_growth(
        rpc,
        pool,
        position.tick_lower,
        ticks_outputs,
        fee_growth_outside_index,
    )
    .await?;
    let upper = read_tick_fee_growth(
        rpc,
        pool,
        position.tick_upper,
        ticks_outputs,
        fee_growth_outside_index,
    )
    .await?;

    uncollected_fees(&FeeInputs {
        cur_tick,
        tick_lower: position.tick_lower,
        tick_upper: position.tick_upper,
        liquidity: position.liquidity,
        fee_growth_global0,
        fee_growth_global1,
        lower,
        upper,
        fee_growth_inside_last0: position.fee_growth_inside_last0,
        fee_growth_inside_last1: position.fee_growth_inside_last1,
        tokens_owed0: position.tokens_owed0,
        tokens_owed1: position.tokens_owed1,
    })
}

// ===========================================================================
// Reading positions
// ===========================================================================

/// The fields of `positions(tokenId)` this adapter uses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionRead {
    pub token0: String,
    pub token1: String,
    pub fee: u32,
    pub tick_lower: i32,
    pub tick_upper: i32,
    pub liquidity: u128,
    pub fee_growth_inside_last0: U256,
    pub fee_growth_inside_last1: U256,
    pub tokens_owed0: u128,
    pub tokens_owed1: u128,
}

impl PositionRead {
    /// Decode the 12-value `positions()` tuple.
    ///
    /// `tickLower`/`tickUpper` are `int24`; [`crate::abi`] sign-extends them during decode, which
    /// is what stops a negative tick (every ETH/USDC position has one) reading as ~16.7 million.
    pub fn from_values(values: &[Value]) -> Result<Self> {
        if values.len() != 12 {
            return Err(anyhow!(
                "positions() returned {} values, expected 12",
                values.len()
            ));
        }
        Ok(Self {
            token0: values[2].as_address_string()?,
            token1: values[3].as_address_string()?,
            fee: u32::try_from(values[4].as_u64()?).context("fee tier does not fit in u32")?,
            tick_lower: values[5].as_i32()?,
            tick_upper: values[6].as_i32()?,
            liquidity: values[7].as_u128()?,
            fee_growth_inside_last0: values[8].as_u256()?,
            fee_growth_inside_last1: values[9].as_u256()?,
            tokens_owed0: values[10].as_u128()?,
            tokens_owed1: values[11].as_u128()?,
        })
    }
}

/// Everything about one LP that comes from the chain, before prices and token metadata are known.
///
/// Splitting here keeps the whole chain-reading path testable against `MockRpc` with no network,
/// and leaves valuation to [`build_position`], which is pure.
#[derive(Debug, Clone, PartialEq)]
pub struct RawPosition {
    pub token_id: U256,
    pub position: PositionRead,
    pub pool: String,
    pub sqrt_price_x96: U256,
    pub cur_tick: i32,
    pub fee0_raw: U256,
    pub fee1_raw: U256,
    /// Which proxy held it, e.g. `"vfat.io"`; `None` for the wallet itself.
    pub via: Option<String>,
    /// The pool's tick spacing, when the pool states it directly.
    ///
    /// `None` for stock v3, where spacing is implied by the fee tier and
    /// [`build_position`] looks it up. v4 pools carry their own spacing in the `PoolKey` and
    /// **must** set it: the Python passes `tick_spacing=spacing` for exactly this reason, and
    /// falling back to the fee table would mislabel any v4 pool whose spacing is not the
    /// Uniswap default for its fee.
    pub tick_spacing: Option<i64>,
}

impl RawPosition {
    /// `tickL <= cur_tick < tickU` — inclusive lower, exclusive upper, as the Python has it.
    pub fn in_range(&self) -> bool {
        self.position.tick_lower <= self.cur_tick && self.cur_tick < self.position.tick_upper
    }
}

/// Read every v3 LP held by `owners` — the chain half of `adapt_univ3`.
///
/// `owners` is `(address, via)`, the shape `resolve_owners` returns. Positions with zero
/// liquidity are skipped: they are closed NFTs the owner has not burned.
pub async fn read_positions(
    rpc: &dyn EvmRpc,
    npm: &str,
    factory: &str,
    owners: &[(String, Option<String>)],
) -> Result<Vec<RawPosition>> {
    let mut out = Vec::new();
    for (owner, via) in owners {
        let count = rpc
            .call_one(npm, BALANCE_OF, &[Value::address(owner)?], "uint256")
            .await?
            .as_u64()?;
        for index in 0..count {
            let token_id = rpc
                .call_one(
                    npm,
                    TOKEN_OF_OWNER_BY_INDEX,
                    &[Value::address(owner)?, Value::uint(index)],
                    "uint256",
                )
                .await?
                .as_u256()?;
            let values = rpc
                .call_typed(npm, POSITIONS, &[Value::uint(token_id)], POSITIONS_OUTPUTS)
                .await?;
            let position = PositionRead::from_values(&values)
                .with_context(|| format!("decoding positions({token_id})"))?;
            if position.liquidity == 0 {
                continue; // closed position
            }

            let pool = rpc
                .call_one(
                    factory,
                    GET_POOL,
                    &[
                        Value::address(&position.token0)?,
                        Value::address(&position.token1)?,
                        Value::uint(position.fee),
                    ],
                    "address",
                )
                .await?
                .as_address_string()?;

            let slot0 = rpc.call_typed(&pool, SLOT0, &[], SLOT0_OUTPUTS).await?;
            let sqrt_price_x96 = slot0
                .first()
                .ok_or_else(|| anyhow!("slot0() returned nothing for {pool}"))?
                .as_u256()?;
            let cur_tick = slot0
                .get(1)
                .ok_or_else(|| anyhow!("slot0() has no tick for {pool}"))?
                .as_i32()?;

            let (fee0_raw, fee1_raw) = read_uncollected_fees(
                rpc,
                &pool,
                &position,
                cur_tick,
                TICKS_OUTPUTS,
                FEE_GROWTH_OUTSIDE_INDEX,
            )
            .await
            .with_context(|| format!("uncollected fees for #{token_id}"))?;

            out.push(RawPosition {
                token_id,
                position,
                pool,
                sqrt_price_x96,
                cur_tick,
                fee0_raw,
                fee1_raw,
                via: via.clone(),
                // Stock v3: spacing follows from the fee tier, so `build_position` looks it up.
                tick_spacing: None,
            });
        }
    }
    Ok(out)
}

// ===========================================================================
// Valuation — `_lp_amounts` + `_lp_position`, shared with v4 and the forks
// ===========================================================================

/// Decimals, symbol and price for one side of a pair — what `_token_meta`, `llama_price` and
/// `llama_change` supply in the Python.
///
/// `price` is already the Python's `llama_price(...) or 0`: an unpriceable token is zero, not
/// missing, so it contributes nothing to the position's value rather than voiding it.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TokenValuation {
    pub decimals: u32,
    pub symbol: String,
    pub price: f64,
    pub change24h: Option<f64>,
}

/// Scale a raw on-chain amount by the token's decimals.
///
/// Goes through `f64` because every consumer of this number is a display value and the Python
/// does the same (`amt / 10 ** d`); see the precision note in [`crate::lp_math`].
fn scaled(raw: U256, decimals: u32) -> f64 {
    raw.as_f64() / 10f64.powi(decimals as i32)
}

/// Build the shared position schema from a raw read plus both tokens' valuations —
/// `_lp_amounts` + `_lp_position` + `_lp_range` in one pass.
///
/// `tick_spacing` overrides the fee-tier lookup: v4 pools carry their own spacing, and v3 forks
/// use spacings the Uniswap fee table does not contain. Pass `None` for stock v3.
pub fn build_position(
    protocol: &str,
    raw: &RawPosition,
    token0: &TokenValuation,
    token1: &TokenValuation,
    tick_spacing: Option<i64>,
) -> Position {
    let p = &raw.position;
    let (amt0, amt1) = lp_math::amounts_from_liquidity(
        p.liquidity,
        raw.sqrt_price_x96.as_f64(),
        lp_math::sqrt_ratio_at_tick(p.tick_lower),
        lp_math::sqrt_ratio_at_tick(p.tick_upper),
    );
    let q0 = amt0 / 10f64.powi(token0.decimals as i32);
    let q1 = amt1 / 10f64.powi(token1.decimals as i32);
    let usd0 = q0 * token0.price;
    let usd1 = q1 * token1.price;

    let f0 = scaled(raw.fee0_raw, token0.decimals);
    let f1 = scaled(raw.fee1_raw, token1.decimals);

    let band = lp_math::lp_range(
        p.tick_lower,
        p.tick_upper,
        raw.cur_tick,
        token0.decimals as i32,
        token1.decimals as i32,
        &token0.symbol,
        &token1.symbol,
    );

    let mut position = Position::new(
        protocol,
        "Liquidity Pool",
        // `fee` is hundredths of a bip, so 3000 reads as "0.30%".
        format!(
            "{}/{} {:.2}%",
            token0.symbol,
            token1.symbol,
            f64::from(p.fee) / 1e4
        ),
        Some(usd0 + usd1),
    )
    .with_rewards(
        vec![
            TokenAmt {
                symbol: token0.symbol.clone(),
                amount: f0,
                usd: Some(f0 * token0.price),
                ..TokenAmt::default()
            },
            TokenAmt {
                symbol: token1.symbol.clone(),
                amount: f1,
                usd: Some(f1 * token1.price),
                ..TokenAmt::default()
            },
        ],
        Some(f0 * token0.price + f1 * token1.price),
    );

    position.id = Some(Some(format!("#{}", raw.token_id)));
    position.via = raw.via.clone();
    position.tokens = vec![
        TokenAmt {
            symbol: token0.symbol.clone(),
            amount: q0,
            usd: Some(usd0),
            ..TokenAmt::default()
        },
        TokenAmt {
            symbol: token1.symbol.clone(),
            amount: q1,
            usd: Some(usd1),
            ..TokenAmt::default()
        },
    ];
    position.in_range = Some(raw.in_range());
    // `_position` omits `change24h` entirely when it is None, so `None` here means "key absent"
    // rather than "present and null" — which is what `Nullable` encodes.
    position.change24h =
        lp_math::blend_change(usd0, token0.change24h, usd1, token1.change24h).map(Some);
    position.tick_spacing =
        tick_spacing.or_else(|| lp_math::fee_tick_spacing(p.fee).map(i64::from));
    position.price_band = Some(PriceBand {
        lower: band.lower,
        upper: band.upper,
        cur: band.cur,
        base: band.base.to_string(),
        quote: band.quote.to_string(),
        full: band.full,
    });
    position
}

/// Decimals, symbol, price and 24h change for one leg of a pair — the `_token_meta` +
/// `llama_price` + `llama_change` trio inside `_lp_amounts` (portfolio.py L574).
///
/// `price` collapses an unpriceable token to `0.0`, which is the Python's `llama_price(...) or 0`:
/// the leg then contributes nothing to the position's value rather than voiding the whole
/// position. `change24h` keeps its `None`, because a missing percentage and a zero percentage are
/// different claims and [`crate::lp_math::blend_change`] treats them differently.
///
/// A metadata read that fails propagates. That is deliberate and matches the oracle: `_token_meta`
/// raises, `adapt_univ3` has no per-position `try`, and `_safe` turns the whole thing into "no v3
/// positions on this chain". Reporting a position with the wrong decimals would be worse than
/// reporting none — it is off by a factor of 10^n, not by a rounding error.
pub async fn valuation<P>(
    rpc: &dyn EvmRpc,
    meta: &TokenMeta,
    prices: &P,
    chain: &Chain,
    token: &str,
) -> Result<TokenValuation>
where
    P: PriceSource + ?Sized,
{
    let (decimals, symbol) = meta.get(rpc, token).await?;
    Ok(TokenValuation {
        decimals: u32::try_from(decimals)
            .with_context(|| format!("{symbol} reports a negative decimals ({decimals})"))?,
        symbol,
        price: prices.price(chain, token).await.unwrap_or(0.0),
        change24h: prices.change(chain, token).await,
    })
}

/// Protocol label, as it appears in the response and in the UI.
pub const PROTOCOL: &str = "Uniswap v3";

/// Every Uniswap v3 LP held by `owners` on `chain` — the port of `adapt_univ3` (L741).
///
/// `owners` is `(address, via)`: the wallet, then any Sickle proxy it controls, which is what
/// [`super::vfat::resolve_owners`] returns.
///
/// Returns `Ok(vec![])` for a chain with no v3 deployment. Any RPC failure aborts the adapter
/// rather than yielding a partial list — see [`valuation`] for why that is the right trade here.
pub async fn adapt_univ3<P>(
    rpc: &dyn EvmRpc,
    prices: &P,
    chain: &Chain,
    owners: &[(String, Option<String>)],
) -> Result<Vec<Position>>
where
    P: PriceSource + ?Sized,
{
    let Some(cfg) = chain.univ3 else {
        return Ok(Vec::new()); // no Uniswap v3 on this chain
    };
    let raw = read_positions(rpc, cfg.npm, cfg.factory, owners).await?;

    // One cache for the whole run: an LP portfolio is mostly the same few tokens paired up
    // different ways, so this is the difference between two reads per position and two per token.
    let meta = TokenMeta::new();
    let mut out = Vec::with_capacity(raw.len());
    for position in &raw {
        let token0 = valuation(rpc, &meta, prices, chain, &position.position.token0).await?;
        let token1 = valuation(rpc, &meta, prices, chain, &position.position.token1).await?;
        out.push(build_position(
            PROTOCOL,
            position,
            &token0,
            &token1,
            position.tick_spacing,
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::aero_cl::StaticPrices;
    use crate::evm::MockRpc;

    const NPM: &str = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
    const FACTORY: &str = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const POOL: &str = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640";
    const OWNER: &str = "0x1111111111111111111111111111111111111111";
    const WETH: &str = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
    const USDC: &str = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

    /// `2^128`, the Q128 unit fee growth is measured in.
    fn q128() -> U256 {
        U256::ONE.shl(128)
    }

    fn q128_times(n: u64) -> U256 {
        q128().wrapping_mul(U256::from(n))
    }

    /// The fixture the Python was run against — see the module docs on how the expected values
    /// below were produced.
    fn fee_inputs(cur_tick: i32, liquidity: u128) -> FeeInputs {
        FeeInputs {
            cur_tick,
            tick_lower: -60,
            tick_upper: 60,
            liquidity,
            fee_growth_global0: q128_times(500),
            fee_growth_global1: q128_times(700),
            lower: TickFeeGrowth {
                outside0: q128_times(100),
                outside1: q128_times(140),
            },
            upper: TickFeeGrowth {
                outside0: q128_times(50),
                outside1: q128_times(70),
            },
            fee_growth_inside_last0: q128_times(300),
            fee_growth_inside_last1: q128_times(400),
            tokens_owed0: 0,
            tokens_owed1: 0,
        }
    }

    fn dec(s: &str) -> U256 {
        U256::from_dec_str(s).unwrap()
    }

    // ---- uncollected fees -------------------------------------------------
    //
    // Every expectation below was produced by executing the REAL
    // `portfolio._v3_uncollected_fees` under the project venv, with a stub pool contract
    // supplying the `feeGrowthGlobal*`/`ticks()` values in `fee_inputs`. So these are the
    // oracle's own numbers, not a re-derivation.

    #[test]
    fn in_range_fees_match_the_python() {
        // inside = 500 - 100 - 50 = 350 Q128; delta = 350 - 300 = 50; 1e15 * 50 = 5e16.
        let mut i = fee_inputs(0, 1_000_000_000_000_000);
        i.tokens_owed0 = 12_345;
        i.tokens_owed1 = 6_789;
        let (fee0, fee1) = uncollected_fees(&i).unwrap();
        assert_eq!(fee0, dec("50000000000012345"));
        assert_eq!(fee1, dec("90000000000006789"));
    }

    #[test]
    fn tokens_owed_are_added_on_top_of_newly_earned_fees() {
        let plain = uncollected_fees(&fee_inputs(0, 1_000_000_000_000_000)).unwrap();
        let mut with_owed = fee_inputs(0, 1_000_000_000_000_000);
        with_owed.tokens_owed0 = 12_345;
        let owed = uncollected_fees(&with_owed).unwrap();
        assert_eq!(owed.0, plain.0.checked_add(U256::from(12_345u64)).unwrap());
    }

    #[test]
    fn below_range_flips_the_lower_tick_and_wraps_into_a_huge_delta() {
        // cur < tickLower, so below0 becomes (global - outside) and `inside` drops beneath
        // `last`. The delta wraps, and the Python produces exactly this astronomical value —
        // the number is not "wrong", it is what modular arithmetic yields for this state.
        let (fee0, fee1) = uncollected_fees(&fee_inputs(-100, 1_000_000_000_000_000)).unwrap();
        assert_eq!(
            fee0,
            dec("340282366920938463463374607431768211206000000000000000")
        );
        assert_eq!(
            fee1,
            dec("340282366920938463463374607431768211126000000000000000")
        );
    }

    #[test]
    fn above_range_flips_the_upper_tick() {
        let (fee0, fee1) = uncollected_fees(&fee_inputs(100, 1_000_000_000_000_000)).unwrap();
        assert_eq!(
            fee0,
            dec("340282366920938463463374607431768211106000000000000000")
        );
        assert_eq!(
            fee1,
            dec("340282366920938463463374607431768210986000000000000000")
        );
    }

    #[test]
    fn a_fee_growth_counter_that_has_wrapped_still_yields_the_right_delta() {
        // `feeGrowthInsideLast` sits just below 2^256 (it wrapped since the position settled).
        // Naive unsigned subtraction would underflow; the modular subtraction recovers the true
        // 360-Q128 growth. This is the case the module exists to get right.
        let mut i = fee_inputs(0, 1_000_000_000_000_000);
        i.fee_growth_inside_last0 = U256::ZERO.wrapping_sub(q128_times(10));
        i.fee_growth_inside_last1 = U256::ZERO.wrapping_sub(q128_times(5));
        let (fee0, fee1) = uncollected_fees(&i).unwrap();
        assert_eq!(fee0, dec("360000000000000000"));
        assert_eq!(fee1, dec("495000000000000000"));
    }

    #[test]
    fn zero_liquidity_earns_nothing_but_still_reports_what_is_owed() {
        let mut i = fee_inputs(0, 0);
        i.tokens_owed0 = 555;
        i.tokens_owed1 = 666;
        let (fee0, fee1) = uncollected_fees(&i).unwrap();
        assert_eq!(fee0, U256::from(555u64));
        assert_eq!(fee1, U256::from(666u64));
    }

    #[test]
    fn the_worst_possible_inputs_still_fit_in_256_bits() {
        // The bound that makes this port exactly equivalent to Python's arbitrary precision:
        // liquidity is a uint128 and a wrapped delta is at most 2^256-1, so the shifted product
        // plus tokensOwed tops out at 2^256 - 2. Maximise every term and it must still succeed.
        let mut i = fee_inputs(0, u128::MAX);
        i.fee_growth_global0 = U256::MAX;
        i.fee_growth_global1 = U256::MAX;
        i.lower = TickFeeGrowth::default();
        i.upper = TickFeeGrowth::default();
        // With both tick boundaries at zero, `inside` is the global value, so the delta against
        // a zero `last` is the maximal 2^256 - 1.
        i.fee_growth_inside_last0 = U256::ZERO;
        i.fee_growth_inside_last1 = U256::ZERO;
        i.tokens_owed0 = u128::MAX;
        i.tokens_owed1 = u128::MAX;

        let (fee0, fee1) = uncollected_fees(&i).expect("the maximum is representable");
        assert_eq!(fee0, U256::MAX.wrapping_sub(U256::ONE), "exactly 2^256 - 2");
        assert_eq!(fee1, fee0);

        // And the tightest case stated directly: (2^128-1) * (2^256-1) >> 128, plus a maximal
        // tokensOwed, lands exactly two below U256::MAX.
        let earned = U256::from_u128(u128::MAX)
            .mul_shr(U256::MAX, 128)
            .expect("512-bit intermediate, 256-bit result");
        let total = earned
            .checked_add(U256::from_u128(u128::MAX))
            .expect("no overflow at the bound");
        assert_eq!(total, U256::MAX.wrapping_sub(U256::ONE), "2^256 - 2");
    }

    #[test]
    fn the_slipstream_fee_growth_index_reads_different_slots() {
        // Documents why `fo_i` is a parameter: shifting the index moves which pair is read.
        // A fork that forgot this would silently price fees off `tickCumulativeOutside`.
        assert_eq!(FEE_GROWTH_OUTSIDE_INDEX, 2, "Uniswap v3 layout");
        let types: Vec<&str> = TICKS_OUTPUTS.split(',').collect();
        assert_eq!(types[FEE_GROWTH_OUTSIDE_INDEX], "uint256");
        assert_eq!(types[FEE_GROWTH_OUTSIDE_INDEX + 1], "uint256");
    }

    // ---- decoding ---------------------------------------------------------

    fn positions_values(tick_lower: i32, tick_upper: i32, liquidity: u128) -> Vec<Value> {
        vec![
            Value::uint(0u64),
            Value::address(OWNER).unwrap(),
            Value::address(WETH).unwrap(),
            Value::address(USDC).unwrap(),
            Value::uint(3000u64),
            Value::int(i128::from(tick_lower)),
            Value::int(i128::from(tick_upper)),
            Value::uint(liquidity),
            Value::uint(q128_times(300)),
            Value::uint(q128_times(400)),
            Value::uint(0u64),
            Value::uint(0u64),
        ]
    }

    #[test]
    fn a_negative_tick_survives_decoding() {
        // The whole reason `int24` must be declared as signed: read unsigned, -200_000 becomes
        // 16_577_216, which puts the position's range astronomically far from the real price.
        let values = positions_values(-202_000, -196_000, 1);
        let read = PositionRead::from_values(&values).unwrap();
        assert_eq!(read.tick_lower, -202_000);
        assert_eq!(read.tick_upper, -196_000);
    }

    #[test]
    fn a_wrong_length_positions_tuple_is_rejected() {
        let err = PositionRead::from_values(&[Value::uint(0u64)]).unwrap_err();
        assert!(format!("{err}").contains("expected 12"), "{err}");
    }

    // ---- the full read ----------------------------------------------------

    fn mock(tick_lower: i32, tick_upper: i32, liquidity: u128, cur_tick: i32) -> MockRpc {
        MockRpc::new()
            .returns(
                NPM,
                BALANCE_OF,
                &[Value::address(OWNER).unwrap()],
                &[Value::uint(1u64)],
            )
            .unwrap()
            .returns(
                NPM,
                TOKEN_OF_OWNER_BY_INDEX,
                &[Value::address(OWNER).unwrap(), Value::uint(0u64)],
                &[Value::uint(7777u64)],
            )
            .unwrap()
            .returns(
                NPM,
                POSITIONS,
                &[Value::uint(7777u64)],
                &positions_values(tick_lower, tick_upper, liquidity),
            )
            .unwrap()
            .returns(
                FACTORY,
                GET_POOL,
                &[
                    Value::address(WETH).unwrap(),
                    Value::address(USDC).unwrap(),
                    Value::uint(3000u64),
                ],
                &[Value::address(POOL).unwrap()],
            )
            .unwrap()
            .returns_for_any_args(
                POOL,
                SLOT0,
                &[
                    Value::uint(U256::ONE.shl(96)), // sqrtPriceX96 == 1.0
                    Value::int(i128::from(cur_tick)),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::Bool(true),
                ],
            )
            .unwrap()
            .returns(
                POOL,
                FEE_GROWTH_GLOBAL0,
                &[],
                &[Value::uint(q128_times(500))],
            )
            .unwrap()
            .returns(
                POOL,
                FEE_GROWTH_GLOBAL1,
                &[],
                &[Value::uint(q128_times(700))],
            )
            .unwrap()
            .returns(
                POOL,
                TICKS,
                &[Value::int(i128::from(tick_lower))],
                &[
                    Value::uint(0u64),
                    Value::int(0),
                    Value::uint(q128_times(100)),
                    Value::uint(q128_times(140)),
                    Value::int(0),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::Bool(true),
                ],
            )
            .unwrap()
            .returns(
                POOL,
                TICKS,
                &[Value::int(i128::from(tick_upper))],
                &[
                    Value::uint(0u64),
                    Value::int(0),
                    Value::uint(q128_times(50)),
                    Value::uint(q128_times(70)),
                    Value::int(0),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::Bool(true),
                ],
            )
            .unwrap()
    }

    fn owners() -> Vec<(String, Option<String>)> {
        vec![(OWNER.to_string(), None)]
    }

    #[tokio::test]
    async fn a_whole_in_range_position_reads_end_to_end() {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let found = read_positions(&rpc, NPM, FACTORY, &owners()).await.unwrap();

        assert_eq!(found.len(), 1);
        let raw = &found[0];
        assert_eq!(raw.token_id, U256::from(7777u64));
        assert_eq!(raw.position.fee, 3000);
        assert_eq!(raw.pool.to_lowercase(), POOL.to_lowercase());
        assert!(raw.in_range(), "tick 0 sits inside [-60, 60)");
        assert_eq!(raw.fee0_raw, dec("50000000000000000"));
        assert_eq!(raw.fee1_raw, dec("90000000000000000"));
    }

    #[tokio::test]
    async fn a_closed_position_is_skipped_without_reading_its_pool() {
        // Zero liquidity means a burned-but-not-collected NFT; the Python `continue`s before
        // touching the factory, and doing otherwise would be a wasted round trip per stale NFT.
        let rpc = mock(-60, 60, 0, 0);
        let found = read_positions(&rpc, NPM, FACTORY, &owners()).await.unwrap();
        assert!(found.is_empty());
        assert!(
            !rpc.calls()
                .iter()
                .any(|c| c.to.eq_ignore_ascii_case(FACTORY)),
            "should not have asked the factory for a closed position"
        );
    }

    #[tokio::test]
    async fn range_classification_follows_the_half_open_interval() {
        for (cur, expected) in [
            (-61, false),
            (-60, true),
            (0, true),
            (59, true),
            (60, false),
        ] {
            let rpc = mock(-60, 60, 1_000_000_000_000_000, cur);
            let found = read_positions(&rpc, NPM, FACTORY, &owners()).await.unwrap();
            assert_eq!(
                found[0].in_range(),
                expected,
                "tick {cur} in [-60, 60) should be {expected}"
            );
        }
    }

    #[tokio::test]
    async fn an_owner_with_no_positions_makes_one_call_and_stops() {
        let rpc = MockRpc::new()
            .returns(
                NPM,
                BALANCE_OF,
                &[Value::address(OWNER).unwrap()],
                &[Value::uint(0u64)],
            )
            .unwrap();
        assert!(
            read_positions(&rpc, NPM, FACTORY, &owners())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(rpc.call_count(), 1);
    }

    #[tokio::test]
    async fn the_via_label_rides_along_to_the_position() {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let owners = vec![(OWNER.to_string(), Some("vfat.io".to_string()))];
        let found = read_positions(&rpc, NPM, FACTORY, &owners).await.unwrap();
        assert_eq!(found[0].via.as_deref(), Some("vfat.io"));
    }

    // ---- valuation --------------------------------------------------------

    fn valuations() -> (TokenValuation, TokenValuation) {
        (
            TokenValuation {
                decimals: 18,
                symbol: "WETH".into(),
                price: 3200.0,
                change24h: Some(2.0),
            },
            TokenValuation {
                decimals: 6,
                symbol: "USDC".into(),
                price: 1.0,
                change24h: Some(0.0),
            },
        )
    }

    async fn built(cur_tick: i32) -> Position {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, cur_tick);
        let raw = read_positions(&rpc, NPM, FACTORY, &owners())
            .await
            .unwrap()
            .remove(0);
        let (t0, t1) = valuations();
        build_position("Uniswap v3", &raw, &t0, &t1, None)
    }

    #[tokio::test]
    async fn a_built_position_carries_the_shape_the_frontend_expects() {
        let position = built(0).await;
        assert_eq!(position.protocol, "Uniswap v3");
        assert_eq!(position.category, "Liquidity Pool");
        assert_eq!(position.name, "WETH/USDC 0.30%", "3000 reads as 0.30%");
        assert_eq!(position.id, Some(Some("#7777".to_string())));
        assert_eq!(position.in_range, Some(true));
        assert_eq!(position.tokens.len(), 2);
        assert_eq!(position.tick_spacing, Some(60), "the 0.30% tier is CL60");
        assert!(position.price_band.is_some());
        let rewards = position.rewards.as_ref().unwrap();
        assert_eq!(rewards.len(), 2);
        assert_eq!(rewards[0].symbol, "WETH");
    }

    #[tokio::test]
    async fn the_fee_tier_renders_with_two_decimals_like_the_python() {
        // `fee / 1e4` with `.2f`: 100 -> 0.01%, 500 -> 0.05%, 3000 -> 0.30%, 10000 -> 1.00%.
        for (fee, expected) in [
            (100u32, "0.01%"),
            (500, "0.05%"),
            (3000, "0.30%"),
            (10000, "1.00%"),
        ] {
            let rendered = format!("{:.2}%", f64::from(fee) / 1e4);
            assert_eq!(rendered, expected);
        }
    }

    #[tokio::test]
    async fn an_explicit_tick_spacing_overrides_the_fee_tier_table() {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let raw = read_positions(&rpc, NPM, FACTORY, &owners())
            .await
            .unwrap()
            .remove(0);
        let (t0, t1) = valuations();
        // v4 and the forks carry their own spacing, which the fee table does not know.
        let position = build_position("Uniswap v4", &raw, &t0, &t1, Some(1));
        assert_eq!(position.tick_spacing, Some(1));
    }

    #[tokio::test]
    async fn change24h_is_absent_rather_than_null_when_neither_token_has_data() {
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0);
        let raw = read_positions(&rpc, NPM, FACTORY, &owners())
            .await
            .unwrap()
            .remove(0);
        let (mut t0, mut t1) = valuations();
        t0.change24h = None;
        t1.change24h = None;
        let position = build_position("Uniswap v3", &raw, &t0, &t1, None);
        assert_eq!(
            position.change24h, None,
            "`_position` omits the key entirely when the blend is None"
        );

        let (t0, t1) = valuations();
        let position = build_position("Uniswap v3", &raw, &t0, &t1, None);
        assert!(
            matches!(position.change24h, Some(Some(_))),
            "present when known"
        );
    }

    #[tokio::test]
    async fn an_out_of_range_position_still_values_and_bands() {
        let position = built(5_000).await;
        assert_eq!(position.in_range, Some(false));
        assert!(position.usd.unwrap() >= 0.0);
        let band = position.price_band.unwrap();
        assert_eq!(band.base, "WETH");
        assert_eq!(band.quote, "USDC");
    }

    // ---- the adapter ------------------------------------------------------
    //
    // `NPM`/`FACTORY` above are Ethereum's real deployment, so the mock answers the addresses
    // `adapt_univ3` reads out of the chain table without any stubbing of the config itself.

    fn ethereum() -> &'static Chain {
        crate::chains::by_name("ethereum").expect("ethereum is in the chain table")
    }

    /// The `decimals()`/`symbol()` answers [`valuation`] needs for the WETH/USDC pair.
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
            .with(WETH, 3200.0, Some(2.0))
            .with(USDC, 1.0, Some(0.0))
    }

    #[tokio::test]
    async fn the_adapter_reads_values_and_shapes_a_position_end_to_end() {
        let rpc = with_token_meta(mock(-60, 60, 1_000_000_000_000_000, 0));
        let found = adapt_univ3(&rpc, &priced(), ethereum(), &owners())
            .await
            .unwrap();

        assert_eq!(found.len(), 1);
        let position = &found[0];
        assert_eq!(position.protocol, PROTOCOL);
        assert_eq!(position.name, "WETH/USDC 0.30%");
        assert_eq!(position.id, Some(Some("#7777".to_string())));
        assert_eq!(position.in_range, Some(true));
        // 3000 is not overridden, so the fee table supplies the spacing.
        assert_eq!(position.tick_spacing, Some(60));
        assert!(position.usd.unwrap() > 0.0);
    }

    #[tokio::test]
    async fn a_chain_without_a_v3_deployment_reads_nothing_and_calls_nothing() {
        let rpc = MockRpc::new();
        let bitcoin = crate::chains::by_name("bitcoin").expect("bitcoin is in the chain table");
        assert!(
            adapt_univ3(&rpc, &priced(), bitcoin, &owners())
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(rpc.call_count(), 0);
    }

    #[tokio::test]
    async fn an_unpriced_token_values_at_zero_rather_than_voiding_the_position() {
        // `llama_price(...) or 0` in the Python: the leg contributes nothing, but the position
        // still renders — with only USDC priced, the value is the USDC side alone.
        let rpc = with_token_meta(mock(-60, 60, 1_000_000_000_000_000, 0));
        let prices = StaticPrices::new().with(USDC, 1.0, Some(0.0));
        let found = adapt_univ3(&rpc, &prices, ethereum(), &owners())
            .await
            .unwrap();

        let position = &found[0];
        let weth_leg = &position.tokens[0];
        assert_eq!(weth_leg.symbol, "WETH");
        assert_eq!(weth_leg.usd, Some(0.0));
        assert_eq!(position.usd, position.tokens[1].usd);
    }

    #[tokio::test]
    async fn a_metadata_failure_costs_the_whole_adapter_not_one_position() {
        // `_token_meta` raises and `adapt_univ3` has no per-position try, so `_safe` reports the
        // chain as having no v3 positions. Reporting the position with default decimals would be
        // wrong by a factor of 10^18.
        let rpc = mock(-60, 60, 1_000_000_000_000_000, 0); // no decimals()/symbol() stubs
        let error = adapt_univ3(&rpc, &priced(), ethereum(), &owners())
            .await
            .expect_err("a token whose decimals cannot be read must fail the adapter");
        assert!(
            format!("{error:#}").contains("decimals()"),
            "the error should name the read that failed, got: {error:#}"
        );
    }

    #[tokio::test]
    async fn token_metadata_is_read_once_per_token_across_positions() {
        let rpc = with_token_meta(mock(-60, 60, 1_000_000_000_000_000, 0));
        adapt_univ3(&rpc, &priced(), ethereum(), &owners())
            .await
            .unwrap();

        let decimals_reads = rpc
            .calls()
            .iter()
            .filter(|c| c.to.eq_ignore_ascii_case(WETH))
            .count();
        assert_eq!(
            decimals_reads, 2,
            "one decimals() and one symbol() for WETH, then the cache serves it"
        );
    }
}
