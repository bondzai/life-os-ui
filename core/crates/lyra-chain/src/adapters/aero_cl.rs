//! Aerodrome / Velodrome Slipstream concentrated-liquidity LPs — the port of
//! `portfolio.py:adapt_aero_cl` (~L910).
//!
//! Slipstream is a Uniswap v3 fork, so the position pipeline is the v3 one and the maths comes
//! from [`crate::lp_math`], which is already parity-checked against the oracle. Three things
//! differ from Uniswap and every one of them is a place a naive port goes quietly wrong:
//!
//! 1. **The factory keys pools by tick spacing, not fee tier.** `getPool` takes an `int24`
//!    spacing where Uniswap takes a `uint24` fee, and the value comes out of the *fee* slot of
//!    the shared `positions()` tuple (`p[4]`). The fee itself is read separately from the pool's
//!    `fee()`.
//! 2. **The pool's `slot0` is one field shorter** — no `feeProtocol` byte — so decoding it with
//!    the Uniswap output list mis-reads the trailing `unlocked` flag.
//! 3. **The `ticks()` struct inserts `stakedLiquidityNet`** before the fee-growth fields, moving
//!    `feeGrowthOutside0X128` from index 2 to index 3. Reading the Uniswap index here silently
//!    computes fees from the wrong number (`fo_i=3` in the Python).
//!
//! Ticks are `int24` and routinely negative — a WETH/USDC range sits near tick −198,000 — so
//! every tick is decoded as `int24` and read with `as_i32`, never as an unsigned word. See the
//! sign-extension note in [`crate::abi`].
//!
//! # Seams this module defines locally
//!
//! [`PriceSource`] and the LP helpers below belong in shared code once more than one adapter
//! needs them (Uniswap v3/v4 will). They live here because this module may not edit its
//! neighbours; lifting them into a shared `adapters::lp` module later is a pure move.

use std::collections::HashMap;

use anyhow::{Context, Result};

use crate::abi::{Fields, U256, Value};
use crate::chains::Chain;
use crate::evm::{BoxFuture, EvmRpc, EvmRpcExt, TokenMeta};
use crate::lp_math;
use crate::model::{Position, PriceBand, TokenAmt};
use crate::prices::Prices;

/// The NonfungiblePositionManager tuple. Slipstream reuses Uniswap's `positions()` layout, which
/// is why `p[4]` is declared `uint24` even though Aerodrome stores a tick spacing there — it is
/// always positive, so the shared ABI decodes it correctly.
const POSITIONS_OUTPUTS: &str =
    "uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128";

/// `AERO_CL_POOL_ABI.slot0` — six fields, one fewer than Uniswap v3 (no `feeProtocol`).
const SLOT0_OUTPUTS: &str = "uint160,int24,uint16,uint16,uint16,bool";

/// `AERO_CL_POOL_ABI.ticks` — note `stakedLiquidityNet` at index 2, ahead of the fee growth.
const TICKS_OUTPUTS: &str =
    "uint128,int128,int128,uint256,uint256,uint256,int56,uint160,uint32,bool";

/// Index of `feeGrowthOutside0X128` in that struct — the Python's `fo_i=3`.
const FEE_GROWTH_OUTSIDE_0: usize = 3;

// Field offsets in the `positions()` tuple, so the reads below are not a wall of integers.
const P_TOKEN0: usize = 2;
const P_TOKEN1: usize = 3;
const P_TICK_SPACING: usize = 4;
const P_TICK_LOWER: usize = 5;
const P_TICK_UPPER: usize = 6;
const P_LIQUIDITY: usize = 7;
const P_FEE_GROWTH_INSIDE_0_LAST: usize = 8;
const P_FEE_GROWTH_INSIDE_1_LAST: usize = 9;
const P_TOKENS_OWED_0: usize = 10;
const P_TOKENS_OWED_1: usize = 11;

/// A wallet to read, and the proxy it was reached through — one entry of `ctx.owners`.
///
/// `via` is `None` for the EOA itself and `Some("vfat.io")` for a Sickle proxy, and it is
/// stamped onto every position so the UI can say where the LP actually lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Owner<'a> {
    /// The address holding the position NFTs.
    pub address: &'a str,
    /// The aggregator the position was reached through, if any.
    pub via: Option<&'a str>,
}

impl<'a> Owner<'a> {
    /// The wallet itself, with no proxy in between.
    #[must_use]
    pub fn wallet(address: &'a str) -> Self {
        Self { address, via: None }
    }

    /// A position held by a proxy contract on the wallet's behalf.
    #[must_use]
    pub fn via(address: &'a str, via: &'a str) -> Self {
        Self {
            address,
            via: Some(via),
        }
    }
}

/// Token prices and 24h changes — `llama_price` / `llama_change` in the Python.
///
/// An adapter depends on this rather than on [`Prices`] directly so its tests can price a pool
/// without a network, the same way [`crate::evm::MockRpc`] stands in for a node.
pub trait PriceSource: Send + Sync {
    /// USD price of a token, `None` when no source covers it.
    fn price<'a>(&'a self, chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>>;

    /// 24h change in percent, `None` when no source covers it.
    fn change<'a>(&'a self, chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>>;
}

impl PriceSource for Prices {
    fn price<'a>(&'a self, chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(self.llama_price(chain, address))
    }

    fn change<'a>(&'a self, chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>> {
        Box::pin(self.llama_change(chain, address))
    }
}

/// A fixed price table — the [`PriceSource`] equivalent of [`crate::evm::MockRpc`].
///
/// Tokens that were never added price as `None`, which is what an unlisted token gets from
/// DefiLlama, so a test can exercise the unpriced path deliberately.
#[derive(Debug, Default)]
pub struct StaticPrices {
    /// address (lowercase) -> (price, 24h change)
    table: HashMap<String, (Option<f64>, Option<f64>)>,
}

impl StaticPrices {
    /// An empty table: every token is unpriced.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Price a token, with an optional 24h change.
    #[must_use]
    pub fn with(mut self, address: &str, price: f64, change: Option<f64>) -> Self {
        self.table
            .insert(address.to_lowercase(), (Some(price), change));
        self
    }
}

impl PriceSource for StaticPrices {
    fn price<'a>(&'a self, _chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>> {
        let hit = self
            .table
            .get(&address.to_lowercase())
            .and_then(|(price, _)| *price);
        Box::pin(async move { hit })
    }

    fn change<'a>(&'a self, _chain: &'a Chain, address: &'a str) -> BoxFuture<'a, Option<f64>> {
        let hit = self
            .table
            .get(&address.to_lowercase())
            .and_then(|(_, change)| *change);
        Box::pin(async move { hit })
    }
}

/// Every Slipstream LP held by `owners` on `chain`.
///
/// Returns an empty vector for a chain with no Slipstream deployment, and for a wallet with no
/// position NFTs. Closed positions (`liquidity == 0`) are skipped without reading their pool,
/// exactly as the Python `continue`s on them.
///
/// An RPC or decode failure aborts the whole adapter with an `Err`, which mirrors the oracle:
/// `adapt_aero_cl` has no per-position `try`, so `_safe` turns any failure into "no Aerodrome
/// positions on this chain" rather than a partial list.
pub async fn positions<R, P>(
    rpc: &R,
    prices: &P,
    chain: &Chain,
    owners: &[Owner<'_>],
) -> Result<Vec<Position>>
where
    R: EvmRpc,
    P: PriceSource + ?Sized,
{
    let Some(cfg) = chain.aero_cl else {
        return Ok(Vec::new()); // no Slipstream fork on this chain
    };
    let meta = TokenMeta::default();
    let mut out = Vec::new();

    for owner in owners {
        let held = rpc
            .call_one(
                cfg.npm,
                "balanceOf(address)",
                &[Value::address(owner.address)?],
                "uint256",
            )
            .await?
            .as_u64()?;

        for index in 0..held {
            let token_id = rpc
                .call_one(
                    cfg.npm,
                    "tokenOfOwnerByIndex(address,uint256)",
                    &[Value::address(owner.address)?, Value::uint(index)],
                    "uint256",
                )
                .await?
                .as_u256()?;

            let p = rpc
                .call_typed(
                    cfg.npm,
                    "positions(uint256)",
                    &[Value::Uint(token_id)],
                    POSITIONS_OUTPUTS,
                )
                .await
                .with_context(|| format!("positions(#{token_id})"))?;

            let liquidity = p.at(P_LIQUIDITY)?.as_u128()?;
            if liquidity == 0 {
                continue; // closed position: the NFT survives its liquidity
            }

            let token0 = p.at(P_TOKEN0)?.as_address_string()?;
            let token1 = p.at(P_TOKEN1)?.as_address_string()?;
            // Aerodrome's factory keys pools by tick spacing; the shared ABI calls this slot
            // `fee`, and the pool's real fee is read from `fee()` further down.
            let tick_spacing = i128::from(p.at(P_TICK_SPACING)?.as_u64()?);
            let tick_lower = p.at(P_TICK_LOWER)?.as_i32()?;
            let tick_upper = p.at(P_TICK_UPPER)?.as_i32()?;

            let pool = rpc
                .call_one(
                    cfg.factory,
                    "getPool(address,address,int24)",
                    &[
                        Value::address(&token0)?,
                        Value::address(&token1)?,
                        Value::int(tick_spacing),
                    ],
                    "address",
                )
                .await?
                .as_address_string()?;

            let slot0 = rpc.call_typed(&pool, "slot0()", &[], SLOT0_OUTPUTS).await?;
            let sqrt_price = slot0.at(0)?.as_u256()?;
            let cur_tick = slot0.at(1)?.as_i32()?;

            let legs = lp_amounts(
                rpc,
                prices,
                chain,
                &meta,
                LegInputs {
                    token0: &token0,
                    token1: &token1,
                    liquidity,
                    sqrt_price,
                    tick_lower,
                    tick_upper,
                },
            )
            .await?;

            let (fee0, fee1) =
                uncollected_fees(rpc, &pool, cur_tick, tick_lower, tick_upper, liquidity, &p)
                    .await?;

            // Read last, as the Python does — it is evaluated inside the `_lp_position(...)`
            // argument list, after the fee maths.
            let fee = rpc
                .call_one(&pool, "fee()", &[], "uint24")
                .await?
                .as_u64()?;

            let band = lp_math::lp_range(
                tick_lower, tick_upper, cur_tick, legs.dec0, legs.dec1, &legs.sym0, &legs.sym1,
            );

            out.push(lp_position(
                cfg.label,
                &token_id.to_string(),
                &legs,
                fee,
                tick_lower <= cur_tick && cur_tick < tick_upper,
                fee0,
                fee1,
                owner.via,
                &band,
                tick_spacing,
            ));
        }
    }
    Ok(out)
}

/// Both sides of a pair, valued — the Python's `_LP` namedtuple.
#[derive(Debug, Clone, PartialEq)]
struct LpLegs {
    /// token0 amount, decimal-adjusted.
    q0: f64,
    /// token1 amount, decimal-adjusted.
    q1: f64,
    dec0: i32,
    dec1: i32,
    sym0: String,
    sym1: String,
    /// USD price, `0.0` when unpriced — the Python's `llama_price(...) or 0`.
    price0: f64,
    price1: f64,
    change0: Option<f64>,
    change1: Option<f64>,
}

/// What [`lp_amounts`] needs about a position, grouped so the call site stays readable.
struct LegInputs<'a> {
    token0: &'a str,
    token1: &'a str,
    liquidity: u128,
    sqrt_price: U256,
    tick_lower: i32,
    tick_upper: i32,
}

/// `_lp_amounts`: liquidity to token amounts, plus each side's decimals, symbol, price, change.
async fn lp_amounts<R, P>(
    rpc: &R,
    prices: &P,
    chain: &Chain,
    meta: &TokenMeta,
    input: LegInputs<'_>,
) -> Result<LpLegs>
where
    R: EvmRpc,
    P: PriceSource + ?Sized,
{
    // sqrtPriceX96 is a uint160 and does not fit u128; this is the conversion lp_math documents.
    let sqrt_p = lp_math::u256_hex_to_f64(&input.sqrt_price.to_hex())
        .with_context(|| format!("sqrtPriceX96 {} is not a 256-bit value", input.sqrt_price))?;
    let (amt0, amt1) = lp_math::amounts_from_liquidity(
        input.liquidity,
        sqrt_p,
        lp_math::sqrt_ratio_at_tick(input.tick_lower),
        lp_math::sqrt_ratio_at_tick(input.tick_upper),
    );

    let (dec0, sym0) = meta.get(rpc, input.token0).await?;
    let (dec1, sym1) = meta.get(rpc, input.token1).await?;

    Ok(LpLegs {
        q0: amt0 / 10f64.powi(dec0),
        q1: amt1 / 10f64.powi(dec1),
        dec0,
        dec1,
        sym0,
        sym1,
        price0: prices.price(chain, input.token0).await.unwrap_or(0.0),
        price1: prices.price(chain, input.token1).await.unwrap_or(0.0),
        change0: prices.change(chain, input.token0).await,
        change1: prices.change(chain, input.token1).await,
    })
}

/// `_lp_position`: assemble the shared position shape from the already-computed pieces.
#[allow(clippy::too_many_arguments)] // one-for-one with the Python factory it ports
fn lp_position(
    protocol: &str,
    token_id: &str,
    legs: &LpLegs,
    fee: u64,
    in_range: bool,
    fee0_raw: U256,
    fee1_raw: U256,
    via: Option<&str>,
    band: &lp_math::PriceBand<'_>,
    tick_spacing: i128,
) -> Position {
    let f0 = to_f64(fee0_raw) / 10f64.powi(legs.dec0);
    let f1 = to_f64(fee1_raw) / 10f64.powi(legs.dec1);
    let (usd0, usd1) = (legs.q0 * legs.price0, legs.q1 * legs.price1);
    let (rewards0, rewards1) = (f0 * legs.price0, f1 * legs.price1);

    let mut position = Position::new(
        protocol,
        "Liquidity Pool",
        // e.g. "WETH/USDC 0.05%" — the fee tier is in hundredths of a bip.
        format!("{}/{} {:.2}%", legs.sym0, legs.sym1, fee as f64 / 1e4),
        Some(usd0 + usd1),
    );
    position.id = Some(Some(format!("#{token_id}")));
    position.via = via.map(str::to_string);
    position.tokens = vec![
        TokenAmt {
            symbol: legs.sym0.clone(),
            amount: legs.q0,
            usd: Some(usd0),
            ..Default::default()
        },
        TokenAmt {
            symbol: legs.sym1.clone(),
            amount: legs.q1,
            usd: Some(usd1),
            ..Default::default()
        },
    ];
    position.in_range = Some(in_range);
    position = position.with_rewards(
        vec![
            TokenAmt {
                symbol: legs.sym0.clone(),
                amount: f0,
                usd: Some(rewards0),
                ..Default::default()
            },
            TokenAmt {
                symbol: legs.sym1.clone(),
                amount: f1,
                usd: Some(rewards1),
                ..Default::default()
            },
        ],
        Some(rewards0 + rewards1),
    );
    // `_position` writes `change24h` only when it is not None, so an unpriced pair omits the key.
    position.change24h = lp_math::blend_change(usd0, legs.change0, usd1, legs.change1).map(Some);
    position.tick_spacing = i64::try_from(tick_spacing).ok();
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

/// `_v3_uncollected_fees` with the Aerodrome tick-struct offset: raw token0/token1 fees owed.
///
/// Every subtraction here is deliberately **wrapping**. Uniswap's fee accounting stores
/// `feeGrowth*` as Q128.128 counters that are allowed to overflow, and the differences are only
/// meaningful mod 2^256 — the Python spells this `(a - b) & U256`, and a checked subtraction
/// would turn a perfectly normal position into an error.
async fn uncollected_fees<R: EvmRpc>(
    rpc: &R,
    pool: &str,
    cur_tick: i32,
    tick_lower: i32,
    tick_upper: i32,
    liquidity: u128,
    p: &[Value],
) -> Result<(U256, U256)> {
    let global0 = rpc
        .call_one(pool, "feeGrowthGlobal0X128()", &[], "uint256")
        .await?
        .as_u256()?;
    let global1 = rpc
        .call_one(pool, "feeGrowthGlobal1X128()", &[], "uint256")
        .await?
        .as_u256()?;

    let lower = rpc
        .call_typed(
            pool,
            "ticks(int24)",
            &[Value::int(i128::from(tick_lower))],
            TICKS_OUTPUTS,
        )
        .await?;
    let upper = rpc
        .call_typed(
            pool,
            "ticks(int24)",
            &[Value::int(i128::from(tick_upper))],
            TICKS_OUTPUTS,
        )
        .await?;

    let i = FEE_GROWTH_OUTSIDE_0;
    let (out0_lower, out1_lower) = (lower.at(i)?.as_u256()?, lower.at(i + 1)?.as_u256()?);
    let (out0_upper, out1_upper) = (upper.at(i)?.as_u256()?, upper.at(i + 1)?.as_u256()?);

    // Growth below the range, and above it, as seen from the current tick.
    let below0 = if cur_tick >= tick_lower {
        out0_lower
    } else {
        global0.wrapping_sub(out0_lower)
    };
    let below1 = if cur_tick >= tick_lower {
        out1_lower
    } else {
        global1.wrapping_sub(out1_lower)
    };
    let above0 = if cur_tick < tick_upper {
        out0_upper
    } else {
        global0.wrapping_sub(out0_upper)
    };
    let above1 = if cur_tick < tick_upper {
        out1_upper
    } else {
        global1.wrapping_sub(out1_upper)
    };

    let inside0 = global0.wrapping_sub(below0).wrapping_sub(above0);
    let inside1 = global1.wrapping_sub(below1).wrapping_sub(above1);

    let earned = |inside: U256, last: U256| -> Result<U256> {
        // liquidity * growth >> 128: the product needs more than 256 bits even though the
        // result does not, which is exactly what `mul_shr` is for.
        U256::from_u128(liquidity)
            .mul_shr(inside.wrapping_sub(last), 128)
            .context("uncollected fees overflowed 256 bits")
    };
    let owed0 = U256::from_u128(p.at(P_TOKENS_OWED_0)?.as_u128()?);
    let owed1 = U256::from_u128(p.at(P_TOKENS_OWED_1)?.as_u128()?);
    let fee0 = owed0
        .checked_add(earned(
            inside0,
            p.at(P_FEE_GROWTH_INSIDE_0_LAST)?.as_u256()?,
        )?)
        .context("token0 fees overflowed 256 bits")?;
    let fee1 = owed1
        .checked_add(earned(
            inside1,
            p.at(P_FEE_GROWTH_INSIDE_1_LAST)?.as_u256()?,
        )?)
        .context("token1 fees overflowed 256 bits")?;
    Ok((fee0, fee1))
}

/// A raw on-chain integer as `f64`, through the crate's parity-checked conversion.
fn to_f64(v: U256) -> f64 {
    lp_math::u256_hex_to_f64(&v.to_hex()).unwrap_or_else(|| v.as_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains;
    use crate::evm::MockRpc;

    // A WETH/USDC Slipstream pool on Base. Every expected number below was produced by running
    // the oracle's own `_amounts_from_liquidity` / `_v3_uncollected_fees` / `_lp_range` /
    // `_lp_position` over these same inputs.
    const POOL: &str = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59";
    const WETH: &str = "0x4200000000000000000000000000000000000006";
    const USDC: &str = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const WALLET: &str = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
    const SICKLE: &str = "0x1111111111111111111111111111111111111111";

    const TICK_LOWER: i32 = -199_000;
    const TICK_UPPER: i32 = -197_000;
    const LIQUIDITY: u128 = 1_234_567_890_123_456_789;
    const TICK_SPACING: u64 = 100;
    const FEE: u64 = 500;
    const TOKEN_ID: u64 = 12_345;

    /// slot0().sqrtPriceX96 at tick −198,000 and at −200,000 (below the range).
    const SQRT_IN_RANGE: u128 = 3_977_215_967_604_875_236_212_736;
    const SQRT_BELOW_RANGE: u128 = 3_598_751_819_613_650_932_465_664;

    // Q128.128 fee-growth counters, as the oracle was fed them.
    const GLOBAL0: &str = "17014118346046923173168730371588410572";
    const GLOBAL1: &str = "2381976568446569244243622252022377480";
    const LOWER_OUT0: &str = "3402823669209384634633746074317682114";
    const LOWER_OUT1: &str = "680564733841876926926749214863536422";
    const UPPER_OUT0: &str = "10208471007628153903901238222953046343";
    const UPPER_OUT1: &str = "340282366920938463463374607431768211";
    const INSIDE0_LAST: &str = "340282366920938463463374607431768211";
    const INSIDE1_LAST: &str = "34028236692093846346337460743176821";
    const OWED0: u128 = 123_456_789_012_345;
    const OWED1: u128 = 4_567;

    fn base() -> &'static Chain {
        chains::by_name("base").expect("base is configured")
    }

    fn u(dec: &str) -> Value {
        Value::Uint(U256::from_dec_str(dec).unwrap())
    }

    fn prices() -> StaticPrices {
        StaticPrices::new()
            .with(WETH, 2500.0, Some(3.25))
            .with(USDC, 1.0, Some(-0.01))
    }

    /// The `positions()` return for our fixture, with `liquidity` varied by the caller.
    fn positions_return(liquidity: u128) -> Vec<Value> {
        vec![
            Value::uint(0u64),
            Value::address("0x0000000000000000000000000000000000000000").unwrap(),
            Value::address(WETH).unwrap(),
            Value::address(USDC).unwrap(),
            Value::uint(TICK_SPACING), // the fee slot holds Aerodrome's tick spacing
            Value::int(i128::from(TICK_LOWER)),
            Value::int(i128::from(TICK_UPPER)),
            Value::uint(liquidity),
            u(INSIDE0_LAST),
            u(INSIDE1_LAST),
            Value::uint(OWED0),
            Value::uint(OWED1),
        ]
    }

    fn ticks_return(out0: &str, out1: &str, liquidity_net: i128) -> Vec<Value> {
        vec![
            Value::uint(10u128.pow(20)),
            Value::int(liquidity_net),
            Value::int(0), // stakedLiquidityNet — the extra field that shifts fee growth to [3]
            u(out0),
            u(out1),
            Value::uint(0u64), // rewardGrowthOutsideX128
            Value::int(0),     // tickCumulativeOutside
            Value::uint(0u64), // secondsPerLiquidityOutsideX128
            Value::uint(0u64), // secondsOutside
            Value::Bool(true),
        ]
    }

    /// A mock holding one NFT for `owner`, with the pool sitting at `cur_tick`.
    fn node(owner: &str, held: u64, liquidity: u128, cur_tick: i32, sqrt_price: u128) -> MockRpc {
        let cfg = base().aero_cl.expect("base has Aerodrome");
        MockRpc::new()
            .returns(
                cfg.npm,
                "balanceOf(address)",
                &[Value::address(owner).unwrap()],
                &[Value::uint(held)],
            )
            .unwrap()
            .returns(
                cfg.npm,
                "tokenOfOwnerByIndex(address,uint256)",
                &[Value::address(owner).unwrap(), Value::uint(0u64)],
                &[Value::uint(TOKEN_ID)],
            )
            .unwrap()
            .returns(
                cfg.npm,
                "positions(uint256)",
                &[Value::uint(TOKEN_ID)],
                &positions_return(liquidity),
            )
            .unwrap()
            .returns(
                cfg.factory,
                "getPool(address,address,int24)",
                &[
                    Value::address(WETH).unwrap(),
                    Value::address(USDC).unwrap(),
                    Value::int(i128::from(TICK_SPACING)),
                ],
                &[Value::address(POOL).unwrap()],
            )
            .unwrap()
            .returns_for_any_args(
                POOL,
                "slot0()",
                &[
                    Value::uint(sqrt_price),
                    Value::int(i128::from(cur_tick)),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::uint(0u64),
                    Value::Bool(true),
                ],
            )
            .unwrap()
            .returns_for_any_args(POOL, "fee()", &[Value::uint(FEE)])
            .unwrap()
            .returns_for_any_args(POOL, "feeGrowthGlobal0X128()", &[u(GLOBAL0)])
            .unwrap()
            .returns_for_any_args(POOL, "feeGrowthGlobal1X128()", &[u(GLOBAL1)])
            .unwrap()
            .returns(
                POOL,
                "ticks(int24)",
                &[Value::int(i128::from(TICK_LOWER))],
                &ticks_return(LOWER_OUT0, LOWER_OUT1, 50_000_000_000_000_000_000),
            )
            .unwrap()
            .returns(
                POOL,
                "ticks(int24)",
                &[Value::int(i128::from(TICK_UPPER))],
                &ticks_return(UPPER_OUT0, UPPER_OUT1, -50_000_000_000_000_000_000),
            )
            .unwrap()
            .returns_for_any_args(WETH, "decimals()", &[Value::uint(18u64)])
            .unwrap()
            .returns_for_any_args(WETH, "symbol()", &[Value::String("WETH".into())])
            .unwrap()
            .returns_for_any_args(USDC, "decimals()", &[Value::uint(6u64)])
            .unwrap()
            .returns_for_any_args(USDC, "symbol()", &[Value::String("USDC".into())])
            .unwrap()
    }

    /// Relative comparison — the maths is float end to end, as in `lp_math`'s own tests.
    fn close(a: f64, b: f64) -> bool {
        if a == b {
            return true;
        }
        (a - b).abs() / a.abs().max(b.abs()) <= 1e-12
    }

    #[tokio::test]
    async fn an_in_range_position_matches_the_oracle_field_for_field() {
        let rpc = node(WALLET, 1, LIQUIDITY, -198_000, SQRT_IN_RANGE);
        let out = positions(&rpc, &prices(), base(), &[Owner::via(WALLET, "vfat.io")])
            .await
            .unwrap();

        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p.protocol, "Aerodrome");
        assert_eq!(p.category, "Liquidity Pool");
        assert_eq!(p.name, "WETH/USDC 0.05%");
        assert_eq!(p.id, Some(Some("#12345".to_string())));
        assert_eq!(p.via.as_deref(), Some("vfat.io"));
        assert_eq!(p.in_range, Some(true));
        assert_eq!(p.tick_spacing, Some(100));

        assert!(
            close(p.usd.unwrap(), 6_020_812.825_424_323),
            "usd {:?}",
            p.usd
        );
        assert!(close(p.tokens[0].amount, 1_199.366_989_493_765_7));
        assert!(close(p.tokens[0].usd.unwrap(), 2_998_417.473_734_414));
        assert_eq!(p.tokens[0].symbol, "WETH");
        assert!(close(p.tokens[1].amount, 3_022_395.351_689_908_7));
        assert!(close(p.tokens[1].usd.unwrap(), 3_022_395.351_689_908_7));

        let rewards = p.rewards.as_ref().expect("LPs always carry swap fees");
        assert!(
            close(rewards[0].amount, 0.011_234_567_800_123_456),
            "fee0 {}",
            rewards[0].amount
        );
        assert!(
            close(rewards[1].amount, 4_814_814_771.486_048),
            "fee1 {}",
            rewards[1].amount
        );
        assert!(close(
            p.rewards_usd.flatten().unwrap(),
            4_814_814_799.572_467
        ));

        // Value-weighted 24h change of the two legs.
        assert!(close(
            p.change24h.flatten().unwrap(),
            1.613_508_527_469_511_6
        ));

        let band = p.price_band.as_ref().expect("a CL position has a band");
        assert!(close(band.lower.unwrap(), 2_280.194_555_351_237_3));
        assert!(close(band.upper.unwrap(), 2_785.008_070_684_335_5));
        assert!(close(band.cur.unwrap(), 2_519.992_110_976_476));
        assert_eq!((band.base.as_str(), band.quote.as_str()), ("WETH", "USDC"));
        assert!(!band.full);
    }

    #[tokio::test]
    async fn a_position_below_its_range_is_all_token0_and_wraps_the_fee_growth() {
        // cur_tick < tickLower, so `_v3_uncollected_fees` takes the `(global - outside) & U256`
        // branch on both edges; the oracle produces exactly these (deliberately huge) values.
        let rpc = node(WALLET, 1, LIQUIDITY, -200_000, SQRT_BELOW_RANGE);
        let p = positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap()
            .remove(0);

        assert_eq!(p.in_range, Some(false));
        assert_eq!(p.via, None, "held by the wallet itself");
        assert!(
            close(p.tokens[0].amount, 2_460.223_687_560_529),
            "q0 {}",
            p.tokens[0].amount
        );
        assert_eq!(p.tokens[1].amount, 0.0, "below the range: no token1 left");
        assert!(close(p.usd.unwrap(), 6_150_559.218_901_322));

        let rewards = p.rewards.as_ref().unwrap();
        assert!(
            close(rewards[0].amount, 4.201_016_837_757_989e38),
            "wrapped fee0 {}",
            rewards[0].amount
        );
        assert!(close(rewards[1].amount, 1_111_111_101.115_678));

        // token1 is worth nothing here, so the blend collapses onto token0's change.
        assert!(close(p.change24h.flatten().unwrap(), 3.25));
    }

    #[tokio::test]
    async fn a_negative_tick_is_read_as_signed_everywhere_it_is_used() {
        // The whole fixture sits at ticks near −198,000. If any of them were read unsigned the
        // band would be astronomically wrong rather than ~$2,500 per ETH, so this is really an
        // assertion about the int24 decode surviving three hops: positions(), slot0(), ticks().
        let rpc = node(WALLET, 1, LIQUIDITY, -198_000, SQRT_IN_RANGE);
        let p = positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap()
            .remove(0);
        let band = p.price_band.unwrap();
        assert!(
            (2000.0..3000.0).contains(&band.cur.unwrap()),
            "current price {:?} — an unsigned tick read would be ~1e86",
            band.cur
        );
        // And the calldata really did carry the sign-extended words.
        let ticks_calls: Vec<_> = rpc
            .calls()
            .into_iter()
            .filter(|c| c.data.starts_with("0xf30dba93"))
            .collect();
        assert_eq!(ticks_calls.len(), 2);
        assert!(
            ticks_calls[0]
                .data
                .contains("fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf6a8"),
            "ticks(-199000) calldata: {}",
            ticks_calls[0].data
        );
    }

    #[tokio::test]
    async fn a_closed_position_is_skipped_without_reading_its_pool() {
        let rpc = node(WALLET, 1, 0, -198_000, SQRT_IN_RANGE);
        let out = positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap();
        assert!(out.is_empty(), "liquidity == 0 is a burnt position");
        assert!(
            !rpc.calls().iter().any(|c| c.to == POOL),
            "no pool reads for a closed position"
        );
    }

    #[tokio::test]
    async fn a_wallet_with_no_nfts_yields_nothing() {
        let rpc = node(WALLET, 0, LIQUIDITY, -198_000, SQRT_IN_RANGE);
        let out = positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap();
        assert!(out.is_empty());
        assert_eq!(rpc.call_count(), 1, "just the balanceOf");
    }

    #[tokio::test]
    async fn a_chain_without_a_slipstream_fork_reads_nothing() {
        let rpc = MockRpc::new();
        let ethereum = chains::by_name("ethereum").unwrap();
        assert!(ethereum.aero_cl.is_none(), "fixture assumption");
        let out = positions(&rpc, &prices(), ethereum, &[Owner::wallet(WALLET)])
            .await
            .unwrap();
        assert!(out.is_empty());
        assert_eq!(rpc.call_count(), 0);
    }

    #[tokio::test]
    async fn both_the_wallet_and_its_proxy_are_read() {
        let cfg = base().aero_cl.unwrap();
        // The wallet holds nothing; the Sickle proxy holds the position.
        let rpc = node(SICKLE, 1, LIQUIDITY, -198_000, SQRT_IN_RANGE)
            .returns(
                cfg.npm,
                "balanceOf(address)",
                &[Value::address(WALLET).unwrap()],
                &[Value::uint(0u64)],
            )
            .unwrap();

        let out = positions(
            &rpc,
            &prices(),
            base(),
            &[Owner::wallet(WALLET), Owner::via(SICKLE, "vfat.io")],
        )
        .await
        .unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].via.as_deref(), Some("vfat.io"));
    }

    #[tokio::test]
    async fn an_unpriced_pair_values_at_zero_and_omits_the_change_key() {
        // `llama_price(...) or 0` in the Python: an unlisted token contributes no value, and
        // with no change data for either side `_position` never writes `change24h`.
        let rpc = node(WALLET, 1, LIQUIDITY, -198_000, SQRT_IN_RANGE);
        let p = positions(&rpc, &StaticPrices::new(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap()
            .remove(0);

        assert_eq!(p.usd, Some(0.0));
        assert_eq!(p.tokens[0].usd, Some(0.0));
        assert_eq!(p.change24h, None, "absent, not null");
        // The amounts themselves are still real.
        assert!(close(p.tokens[0].amount, 1_199.366_989_493_765_7));
    }

    #[tokio::test]
    async fn a_missing_pool_read_fails_the_whole_adapter() {
        // The oracle has no per-position `try` here, so a broken pool costs the chain its
        // Aerodrome positions rather than silently returning a partial list.
        let cfg = base().aero_cl.unwrap();
        let rpc = MockRpc::new()
            .returns(
                cfg.npm,
                "balanceOf(address)",
                &[Value::address(WALLET).unwrap()],
                &[Value::uint(1u64)],
            )
            .unwrap()
            .returns(
                cfg.npm,
                "tokenOfOwnerByIndex(address,uint256)",
                &[Value::address(WALLET).unwrap(), Value::uint(0u64)],
                &[Value::uint(TOKEN_ID)],
            )
            .unwrap();
        assert!(
            positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn token_metadata_is_read_once_per_token() {
        // Two positions in the same pool must not re-read decimals()/symbol() four times.
        let cfg = base().aero_cl.unwrap();
        let rpc = node(WALLET, 2, LIQUIDITY, -198_000, SQRT_IN_RANGE)
            .returns(
                cfg.npm,
                "tokenOfOwnerByIndex(address,uint256)",
                &[Value::address(WALLET).unwrap(), Value::uint(1u64)],
                &[Value::uint(TOKEN_ID)],
            )
            .unwrap();

        let out = positions(&rpc, &prices(), base(), &[Owner::wallet(WALLET)])
            .await
            .unwrap();
        assert_eq!(out.len(), 2);

        let decimals_calls = rpc
            .calls()
            .iter()
            .filter(|c| c.data == "0x313ce567")
            .count();
        assert_eq!(decimals_calls, 2, "one per token, not one per position");
    }
}
