//! Compound III (Comet) borrow positions — the port of `portfolio.py:adapt_compound` (~L1760).
//!
//! # What this adapter is for
//!
//! Compound III holds a wallet's collateral **inside the Comet contract**, not in the wallet, so
//! the spot reader never sees it. That makes this adapter the only place that collateral is
//! counted, and it is why the position's value is
//!
//! ```text
//! usd = collateral_usd − debt_usd
//! ```
//!
//! and **not** `−debt` (which is what the Aave adapter emits, because Aave's aTokens *are* held
//! by the wallet and so are already valued in spot). Getting that distinction backwards either
//! double-counts collateral or drops it; see [`positions`] for the invariants the tests pin.
//!
//! A wallet that only supplies is skipped entirely (`borrowBalanceOf == 0`): with no debt there
//! is no borrow health to report, and its supplied base token is a plain balance.
//!
//! # Prices come from the chain
//!
//! Unlike the LP adapters, nothing here touches DefiLlama. Comet exposes its own Chainlink-style
//! feeds (`getPrice`, 8 decimals) and per-asset `scale`, so a position can be valued from the
//! same RPC that read it — which is also why every test in this module is hermetic.
//!
//! # Failure isolation
//!
//! The Python wraps each market in its own `try/except` and writes a line to stderr on failure,
//! so one unreachable market cannot cost the wallet its other Compound positions. [`positions`]
//! does the same with `tracing::warn!` and therefore returns a `Vec`, not a `Result`.

use crate::abi::{Fields, U256, Value};
use crate::evm::{EvmRpc, EvmRpcExt};
use crate::lp_math;
use crate::model::{LendingHealth, Position};

use anyhow::{Context, Result};

/// Comet's `getAssetInfo` struct — `COMET_ABI` in `portfolio.py` (~L1724).
const ASSET_INFO_OUTPUTS: &str = "(uint8,address,address,uint64,uint64,uint64,uint64,uint128)";

/// Field offsets inside that struct, named so the reads below do not read as magic numbers.
const ASSET: usize = 1;
const PRICE_FEED: usize = 2;
const SCALE: usize = 3;
const LIQUIDATE_COLLATERAL_FACTOR: usize = 5;

/// Comet price feeds report USD with 8 decimals.
const PRICE_SCALE: f64 = 1e8;

/// Collateral factors are `uint64` fractions scaled by 1e18.
const FACTOR_SCALE: f64 = 1e18;

/// Below this the Python drops the position rather than reporting a rounding artefact as debt.
const MIN_DEBT_USD: f64 = 0.01;

/// The Comet deployments the oracle reads, per chain — `COMET_MARKETS` (`portfolio.py` ~L1737).
///
/// This lives here rather than in [`crate::chains`] because it does in the Python too: it is a
/// module-level table beside the adapter, not part of the per-chain config block.
pub const MARKETS: &[(&str, &[&str])] = &[
    (
        "ethereum",
        &[
            "0xc3d688B66703497DAA19211EEdff47f25384cdc3", // USDC
            "0x5D409e56D886231aDAf00c8775665AD0f9897b56", // USDS
            "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840", // USDT
            "0xe85Dc543813B8c2CFEaAc371517b925a166a9293", // WBTC
            "0xA17581A9E3356d9A858b789D68B4d866e593aE94", // WETH
            "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3", // wstETH
        ],
    ),
    (
        "base",
        &[
            "0x784efeB622244d2348d4F2522f8860B96fbEcE89", // AERO
            "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // USDbC
            "0xb125E6687d4313864e53df431d5425969c15Eb2F", // USDC
            "0x2c776041CCFe903071AF44aa147368a9c8EEA518", // USDS
            "0x46e6b214b524310239732D51387075E0e70970bf", // WETH
        ],
    ),
    (
        "arbitrum",
        &[
            "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA", // USDC.e
            "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf", // USDC
            "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07", // USDT
            "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486", // WETH
        ],
    ),
    (
        "optimism",
        &[
            "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB", // USDC
            "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214", // USDT
            "0xE36A30D249f7761327fd973001A32010b521b6Fd", // WETH
        ],
    ),
    (
        "polygon",
        &[
            "0xF25212E676D1F7F89Cd72fFEe66158f541246445", // USDC.e
            "0xaeB318360f27748Acb200CE616E389A6C9409a07", // USDT
        ],
    ),
];

/// The Comet markets on a chain — empty for a chain Compound III is not deployed on.
#[must_use]
pub fn markets_for(chain: &str) -> &'static [&'static str] {
    MARKETS
        .iter()
        .find(|(name, _)| *name == chain)
        .map_or(&[], |(_, markets)| *markets)
}

/// Every Compound III **borrow** position `owner` holds on `chain`.
///
/// Returns an empty vector — never an error — when the chain has no markets, the wallet has no
/// debt, or every market read failed; that mirrors the Python, where a per-market `except` keeps
/// one bad market from costing the others. Failures are logged at `warn`.
///
/// # What a returned position means
///
/// * `usd` is `collateral − debt`, so it is **negative** when the wallet owes more than the
///   collateral held inside Comet is worth. Callers must not clamp it at zero: the negative value
///   *is* the liability, and dropping it inflates net worth.
/// * `health.debt_usd` carries the gross debt as a positive number, alongside `collateral_usd`,
///   the health factor, the LTV and the liquidation threshold.
/// * `tokens` is empty and `id`/`via` are null, exactly as `_position` writes them here — the
///   Python does not enumerate the collateral legs for Compound the way it does for Avalon.
pub async fn positions<R: EvmRpc>(rpc: &R, chain: &str, owner: &str) -> Vec<Position> {
    let mut out = Vec::new();
    for &comet in markets_for(chain) {
        match market_position(rpc, comet, owner).await {
            Ok(Some(position)) => out.push(position),
            Ok(None) => {}
            // `sys.stderr.write(f"(compound {chain} {addr[:8]}…: {e})")` in the Python.
            Err(err) => tracing::warn!(chain, market = comet, "compound market skipped: {err:#}"),
        }
    }
    out
}

/// One market. `Ok(None)` means "nothing to report" (no debt, or debt below the dust floor).
async fn market_position<R: EvmRpc>(rpc: &R, comet: &str, owner: &str) -> Result<Option<Position>> {
    let owner_arg = [Value::address(owner)?];

    let debt_raw = rpc
        .call_one(comet, "borrowBalanceOf(address)", &owner_arg, "uint256")
        .await?
        .as_u256()?;
    if debt_raw.is_zero() {
        // A net supplier: no borrow, so no health to report and no liability to net off.
        return Ok(None);
    }

    let base_feed = rpc
        .call_one(comet, "baseTokenPriceFeed()", &[], "address")
        .await?
        .as_address_string()?;
    let base_price = price(rpc, comet, &base_feed).await?;
    let base_scale = rpc
        .call_one(comet, "baseScale()", &[], "uint256")
        .await?
        .as_u256()?;

    // `(debt_raw / baseScale) * (base_price / 1e8)` — two float divisions, in the Python's order.
    let debt = (to_f64(debt_raw) / to_f64(base_scale)) * base_price;
    if debt < MIN_DEBT_USD {
        return Ok(None);
    }

    let num_assets = rpc
        .call_one(comet, "numAssets()", &[], "uint8")
        .await?
        .as_u8()?;

    let (mut collateral, mut collateral_liquidatable) = (0.0f64, 0.0f64);
    for i in 0..num_assets {
        let info = rpc
            .call_one(
                comet,
                "getAssetInfo(uint8)",
                &[Value::uint(u64::from(i))],
                ASSET_INFO_OUTPUTS,
            )
            .await?;
        let info = info.as_tuple()?;
        let asset = info.at(ASSET)?.as_address_string()?;
        let feed = info.at(PRICE_FEED)?.as_address_string()?;
        let scale = info.at(SCALE)?.as_u256()?;
        let liquidation_factor = info.at(LIQUIDATE_COLLATERAL_FACTOR)?.as_u64()?;

        let balance = rpc
            .call_typed(
                comet,
                "userCollateral(address,address)",
                &[Value::address(owner)?, Value::address(&asset)?],
                "uint128,uint128",
            )
            .await
            .with_context(|| format!("userCollateral for {asset}"))?
            .at(0)?
            .as_u256()?;
        if balance.is_zero() {
            continue;
        }

        let value = (to_f64(balance) / to_f64(scale)) * price(rpc, comet, &feed).await?;
        collateral += value;
        // Liquidation-adjusted value: what the position is worth to the protocol's risk model.
        collateral_liquidatable += value * (liquidation_factor as f64 / FACTOR_SCALE);
    }

    // `debt` is >= MIN_DEBT_USD here, so the Python's `if debt > 0` guard is always taken; the
    // collateral guards are not, and a wallet whose collateral was fully liquidated away really
    // does reach `ltv = 0.0` in the oracle. Kept as-is rather than "fixed" to infinity.
    let health = LendingHealth {
        hf: Some(collateral_liquidatable / debt),
        ltv: if collateral > 0.0 {
            debt / collateral
        } else {
            0.0
        },
        liq_threshold: if collateral > 0.0 {
            collateral_liquidatable / collateral
        } else {
            0.0
        },
        collateral_usd: collateral,
        debt_usd: debt,
    };

    let mut position = Position::new(
        "Compound v3",
        "Borrowing",
        "Borrow vs. supplied collateral",
        // Net equity: collateral is inside Comet, so it is counted here and nowhere else.
        // Negative when the debt exceeds it — that is a real liability, not an error.
        Some(collateral - debt),
    );
    position.health = Some(health);
    Ok(Some(position))
}

/// `getPrice(feed)` in USD — the raw `uint256` divided by the feed's fixed 1e8 scale.
async fn price<R: EvmRpc>(rpc: &R, comet: &str, feed: &str) -> Result<f64> {
    let raw = rpc
        .call_one(
            comet,
            "getPrice(address)",
            &[Value::address(feed)?],
            "uint256",
        )
        .await
        .with_context(|| format!("getPrice({feed})"))?
        .as_u256()?;
    Ok(to_f64(raw) / PRICE_SCALE)
}

/// A raw on-chain integer as `f64`, through the crate's parity-checked conversion.
///
/// Python divides arbitrary-precision ints (`bal_raw / scale`), which rounds once at the
/// division; this rounds when each operand is converted. The two can differ in the last bit of a
/// USD figure and never more, because the ratio itself is far inside `f64`'s exact range.
fn to_f64(v: U256) -> f64 {
    lp_math::u256_hex_to_f64(&v.to_hex()).unwrap_or_else(|| v.as_f64())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evm::MockRpc;

    // A real Compound III USDC market on Base, and the assets it accepts as collateral.
    const COMET: &str = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
    const OWNER: &str = "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e";
    const WETH: &str = "0x4200000000000000000000000000000000000006";
    const CBBTC: &str = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
    const FEED_USDC: &str = "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B";
    const FEED_WETH: &str = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
    const FEED_BTC: &str = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";

    fn asset_info(index: u64, asset: &str, feed: &str, scale: u128, liquidate_cf: u64) -> Value {
        Value::Tuple(vec![
            Value::uint(index),
            Value::address(asset).unwrap(),
            Value::address(feed).unwrap(),
            Value::uint(scale),
            Value::uint(780_000_000_000_000_000u64), // borrowCollateralFactor, unused here
            Value::uint(liquidate_cf),
            Value::uint(950_000_000_000_000_000u64), // liquidationFactor, unused here
            Value::uint(10u128.pow(24)),             // supplyCap, unused here
        ])
    }

    /// The market every test starts from: USDC base token, WETH + cbBTC collateral, prices from
    /// the feeds. `debt_raw` and the collateral balances are what each test varies.
    fn market(debt_raw: u128, weth_balance: u128, cbbtc_balance: u128) -> MockRpc {
        MockRpc::new()
            .returns_for_any_args(COMET, "borrowBalanceOf(address)", &[Value::uint(debt_raw)])
            .unwrap()
            .returns_for_any_args(
                COMET,
                "baseTokenPriceFeed()",
                &[Value::address(FEED_USDC).unwrap()],
            )
            .unwrap()
            .returns_for_any_args(COMET, "baseScale()", &[Value::uint(1_000_000u64)])
            .unwrap()
            .returns_for_any_args(COMET, "numAssets()", &[Value::uint(2u64)])
            .unwrap()
            // Feed prices, 8 decimals: USDC $1, ETH $2,500, BTC $60,000.
            .returns(
                COMET,
                "getPrice(address)",
                &[Value::address(FEED_USDC).unwrap()],
                &[Value::uint(100_000_000u64)],
            )
            .unwrap()
            .returns(
                COMET,
                "getPrice(address)",
                &[Value::address(FEED_WETH).unwrap()],
                &[Value::uint(250_000_000_000u64)],
            )
            .unwrap()
            .returns(
                COMET,
                "getPrice(address)",
                &[Value::address(FEED_BTC).unwrap()],
                &[Value::uint(6_000_000_000_000u64)],
            )
            .unwrap()
            .returns(
                COMET,
                "getAssetInfo(uint8)",
                &[Value::uint(0u64)],
                &[asset_info(
                    0,
                    WETH,
                    FEED_WETH,
                    10u128.pow(18),
                    860_000_000_000_000_000,
                )],
            )
            .unwrap()
            .returns(
                COMET,
                "getAssetInfo(uint8)",
                &[Value::uint(1u64)],
                &[asset_info(
                    1,
                    CBBTC,
                    FEED_BTC,
                    10u128.pow(8),
                    800_000_000_000_000_000,
                )],
            )
            .unwrap()
            .returns(
                COMET,
                "userCollateral(address,address)",
                &[
                    Value::address(OWNER).unwrap(),
                    Value::address(WETH).unwrap(),
                ],
                &[Value::uint(weth_balance), Value::uint(0u64)],
            )
            .unwrap()
            .returns(
                COMET,
                "userCollateral(address,address)",
                &[
                    Value::address(OWNER).unwrap(),
                    Value::address(CBBTC).unwrap(),
                ],
                &[Value::uint(cbbtc_balance), Value::uint(0u64)],
            )
            .unwrap()
    }

    /// Relative comparison — the arithmetic is float end to end on both sides.
    fn close(a: f64, b: f64) -> bool {
        if a == b {
            return true;
        }
        (a - b).abs() / a.abs().max(b.abs()) <= 1e-12
    }

    #[tokio::test]
    async fn a_borrow_backed_by_collateral_nets_to_equity() {
        // Oracle (adapt_compound with these exact returns): 12,500 USDC of debt against
        // 5 WETH ($12,500) + 0.25 cbBTC ($15,000).
        let rpc = market(12_500_000_000, 5 * 10u128.pow(18), 25_000_000);
        let out = positions(&rpc, "base", OWNER).await;

        assert_eq!(out.len(), 1);
        let p = &out[0];
        assert_eq!(p.protocol, "Compound v3");
        assert_eq!(p.category, "Borrowing");
        assert_eq!(p.name, "Borrow vs. supplied collateral");
        assert_eq!(p.id, Some(None), "_position writes a null id here");
        assert_eq!(p.via, None);
        assert!(p.tokens.is_empty());
        assert_eq!(p.usd, Some(15000.0), "collateral 27,500 − debt 12,500");

        let h = p.health.as_ref().expect("a borrow always carries health");
        assert_eq!(h.debt_usd, 12500.0, "gross debt, positive");
        assert_eq!(h.collateral_usd, 27500.0);
        assert!(close(h.hf.unwrap(), 1.82), "hf {:?}", h.hf);
        assert!(close(h.ltv, 0.454_545_454_545_454_53), "ltv {}", h.ltv);
        assert!(
            close(h.liq_threshold, 0.827_272_727_272_727_3),
            "liq_threshold {}",
            h.liq_threshold
        );
    }

    #[tokio::test]
    async fn debt_is_never_dropped_or_sign_flipped() {
        // The invariant that matters most: the reported value is equity, and the debt leg is
        // subtracted, not added and not discarded.
        let rpc = market(12_500_000_000, 5 * 10u128.pow(18), 25_000_000);
        let p = positions(&rpc, "base", OWNER).await.remove(0);
        let h = p.health.clone().unwrap();

        assert!(h.debt_usd > 0.0, "debt is stored as a positive magnitude");
        assert!(
            close(p.usd.unwrap(), h.collateral_usd - h.debt_usd),
            "usd must be collateral − debt, got {:?}",
            p.usd
        );
        assert!(
            p.usd.unwrap() < h.collateral_usd,
            "a borrow must be worth less than its collateral"
        );
    }

    #[tokio::test]
    async fn a_debt_larger_than_the_collateral_is_reported_as_negative_net_worth() {
        // 20,000 USDC borrowed against 0.25 cbBTC ($15,000) only.
        let rpc = market(20_000_000_000, 0, 25_000_000);
        let p = positions(&rpc, "base", OWNER).await.remove(0);

        assert_eq!(p.usd, Some(-5000.0), "underwater positions stay negative");
        let h = p.health.unwrap();
        assert_eq!(h.debt_usd, 20000.0);
        assert_eq!(h.collateral_usd, 15000.0);
        assert!(close(h.hf.unwrap(), 0.6), "hf {:?}", h.hf);
        assert!(close(h.ltv, 1.333_333_333_333_333_3), "ltv {}", h.ltv);
        assert!(close(h.liq_threshold, 0.8), "liq {}", h.liq_threshold);
    }

    #[tokio::test]
    async fn debt_with_no_collateral_left_is_the_full_liability() {
        // Collateral fully liquidated, debt outstanding: usd is exactly −debt.
        let rpc = market(3_333_333_333, 0, 0);
        let p = positions(&rpc, "base", OWNER).await.remove(0);

        assert!(close(p.usd.unwrap(), -3333.333333), "usd {:?}", p.usd);
        let h = p.health.unwrap();
        assert!(close(h.debt_usd, 3333.333333));
        assert_eq!(h.collateral_usd, 0.0);
        assert_eq!(h.hf, Some(0.0), "no collateral to cover it");
        // The oracle's `if collat > 0` guards make both of these 0.0 rather than infinite.
        assert_eq!(h.ltv, 0.0);
        assert_eq!(h.liq_threshold, 0.0);
    }

    #[tokio::test]
    async fn a_wallet_with_no_borrow_yields_nothing_and_reads_nothing_else() {
        let rpc = market(0, 5 * 10u128.pow(18), 25_000_000);
        assert!(positions(&rpc, "base", OWNER).await.is_empty());
        // One call per market and no further reads: `borrowBalanceOf == 0` short-circuits.
        assert_eq!(rpc.call_count(), markets_for("base").len());
    }

    #[tokio::test]
    async fn a_dust_debt_is_dropped() {
        // 0.005 USDC of debt — under the oracle's 0.01 floor.
        let rpc = market(5_000, 5 * 10u128.pow(18), 0);
        assert!(positions(&rpc, "base", OWNER).await.is_empty());
    }

    #[tokio::test]
    async fn collateral_the_wallet_does_not_hold_is_skipped_without_pricing_it() {
        // cbBTC balance is zero, so its feed is never read — the Python `continue`s first.
        let rpc = MockRpc::new()
            .returns_for_any_args(
                COMET,
                "borrowBalanceOf(address)",
                &[Value::uint(1_000_000u64)],
            )
            .unwrap()
            .returns_for_any_args(
                COMET,
                "baseTokenPriceFeed()",
                &[Value::address(FEED_USDC).unwrap()],
            )
            .unwrap()
            .returns_for_any_args(COMET, "baseScale()", &[Value::uint(1_000_000u64)])
            .unwrap()
            .returns_for_any_args(COMET, "numAssets()", &[Value::uint(1u64)])
            .unwrap()
            .returns(
                COMET,
                "getPrice(address)",
                &[Value::address(FEED_USDC).unwrap()],
                &[Value::uint(100_000_000u64)],
            )
            .unwrap()
            .returns(
                COMET,
                "getAssetInfo(uint8)",
                &[Value::uint(0u64)],
                &[asset_info(
                    0,
                    WETH,
                    FEED_WETH,
                    10u128.pow(18),
                    860_000_000_000_000_000,
                )],
            )
            .unwrap()
            .returns(
                COMET,
                "userCollateral(address,address)",
                &[
                    Value::address(OWNER).unwrap(),
                    Value::address(WETH).unwrap(),
                ],
                &[Value::uint(0u64), Value::uint(0u64)],
            )
            .unwrap();

        // No stub for getPrice(FEED_WETH): if the adapter priced a zero balance this would error.
        let p = positions(&rpc, "base", OWNER).await.remove(0);
        assert_eq!(p.usd, Some(-1.0), "1 USDC of debt, no collateral");
    }

    #[tokio::test]
    async fn one_unreadable_market_does_not_cost_the_others() {
        // Only the USDC market answers; the other four Base markets are unstubbed and error.
        let rpc = market(12_500_000_000, 5 * 10u128.pow(18), 25_000_000);
        let out = positions(&rpc, "base", OWNER).await;
        assert_eq!(out.len(), 1, "the readable market still reports");
    }

    #[tokio::test]
    async fn a_chain_without_comet_markets_reads_nothing() {
        let rpc = MockRpc::new();
        assert!(positions(&rpc, "hyperevm", OWNER).await.is_empty());
        assert!(positions(&rpc, "avalanche", OWNER).await.is_empty());
        assert_eq!(rpc.call_count(), 0, "no markets means no RPC at all");
    }

    #[test]
    fn the_market_table_matches_the_oracle() {
        assert_eq!(markets_for("ethereum").len(), 6);
        assert_eq!(markets_for("base").len(), 5);
        assert_eq!(markets_for("arbitrum").len(), 4);
        assert_eq!(markets_for("optimism").len(), 3);
        assert_eq!(markets_for("polygon").len(), 2);
        assert!(markets_for("solana").is_empty());
        for (chain, markets) in MARKETS {
            assert!(
                crate::chains::by_name(chain).is_some(),
                "{chain} is not a configured chain"
            );
            for market in markets.iter().copied() {
                assert!(
                    crate::address::is_evm(market),
                    "{chain} market {market} is not an EVM address"
                );
            }
        }
    }
}
