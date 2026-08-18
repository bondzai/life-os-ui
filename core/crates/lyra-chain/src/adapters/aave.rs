//! Aave v3 borrow health — the port of `portfolio.py:adapt_aave` (L1609).
//!
//! # Net-of-debt accounting, and why this adapter is not like Compound
//!
//! On every chain here, Aave gives the supplier an **aToken** (`aEthWETH`, `aBasUSDC`, …) which
//! sits in the wallet as an ordinary ERC-20. The spot reader therefore already values the
//! supplied collateral. If this adapter reported `collateral − debt`, the collateral would be
//! counted **twice** — once as the aToken balance and once here.
//!
//! So the position's value is the debt alone, negated:
//!
//! ```text
//! usd = −debt_usd
//! ```
//!
//! and net worth comes out as `(aTokens in spot) − debt`. [`super::compound`] does the opposite,
//! for the opposite reason: Comet holds collateral inside the contract where spot cannot see it.
//! Swapping the two conventions is a silent, expensive error in either direction, which is why
//! both modules say so at the top and the tests pin it.
//!
//! # Supply-only wallets are skipped
//!
//! No debt means no liquidation risk and nothing to net against spot, so a supplier gets no row
//! rather than a zero-value one. That is the Python's `if debt < 0.01: return []`, and it is also
//! what makes the health block below always meaningful — every position this adapter emits has a
//! real borrow behind it.
//!
//! # One call per chain
//!
//! `getUserAccountData` aggregates every reserve the wallet touches, so the whole adapter is a
//! single `eth_call`. There is no per-asset breakdown here as a result — [`super::avalon`] walks
//! its reserves precisely because its collateral is *not* in spot and the legs would otherwise be
//! invisible.

use crate::abi::{Fields, Value};
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt};
use crate::model::{LendingHealth, Position};

use anyhow::Result;

/// `AAVE_POOL_ABI` (portfolio.py L1596).
pub const GET_USER_ACCOUNT_DATA: &str = "getUserAccountData(address)";

/// `totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold,
/// ltv, healthFactor`.
pub const GET_USER_ACCOUNT_DATA_OUTPUTS: &str = "uint256,uint256,uint256,uint256,uint256,uint256";

const TOTAL_COLLATERAL_BASE: usize = 0;
const TOTAL_DEBT_BASE: usize = 1;
const CURRENT_LIQUIDATION_THRESHOLD: usize = 3;
const LTV: usize = 4;
const HEALTH_FACTOR: usize = 5;

/// Aave reports USD in a "base currency" with 8 decimals.
const BASE_SCALE: f64 = 1e8;

/// `ltv` and `currentLiquidationThreshold` are basis points; the response carries fractions.
const BPS_SCALE: f64 = 1e4;

/// The health factor is a 1e18-scaled ray-ish fraction.
const HF_SCALE: f64 = 1e18;

/// Below this the Python drops the position rather than reporting a rounding artefact as debt.
const MIN_DEBT_USD: f64 = 0.01;

/// Protocol label, as it appears in the response and in the UI.
pub const PROTOCOL: &str = "Aave v3";

/// The decoded `getUserAccountData` tuple, in the units the response uses.
///
/// Shared with [`super::avalon`], which is an Aave fork and speaks the identical interface. The
/// decode is the part that is genuinely the same; what the two do with these numbers is not, and
/// deliberately lives in each adapter rather than here.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AccountData {
    /// USD.
    pub collateral: f64,
    /// USD.
    pub debt: f64,
    /// Fraction, e.g. `0.80`.
    pub ltv: f64,
    /// Fraction, e.g. `0.825`.
    pub liq_threshold: f64,
    /// `None` when the pool reported the no-debt sentinel.
    pub health_factor: Option<f64>,
}

/// Decode `getUserAccountData`'s six words, scaling each into the response's units.
///
/// The health factor's `uint256::MAX` sentinel becomes `None` here rather than at each call site:
/// passing the raw word through renders as an astronomically healthy position, which is the most
/// dangerous possible way to be wrong about a borrow.
pub fn account_data(data: &[Value]) -> Result<AccountData> {
    let raw_hf = data.at(HEALTH_FACTOR)?.as_u256()?;
    Ok(AccountData {
        collateral: data.at(TOTAL_COLLATERAL_BASE)?.as_u256()?.as_f64() / BASE_SCALE,
        debt: data.at(TOTAL_DEBT_BASE)?.as_u256()?.as_f64() / BASE_SCALE,
        ltv: data.at(LTV)?.as_u256()?.as_f64() / BPS_SCALE,
        liq_threshold: data.at(CURRENT_LIQUIDATION_THRESHOLD)?.as_u256()?.as_f64() / BPS_SCALE,
        health_factor: if raw_hf == crate::abi::U256::MAX {
            None
        } else {
            Some(raw_hf.as_f64() / HF_SCALE)
        },
    })
}

/// The wallet's Aave v3 borrow position on one chain, or `None` when it has no debt.
///
/// Returns `Ok(None)` — not an empty position — for a chain with no Aave deployment and for a
/// wallet that only supplies. Both are "nothing to report", which the registry turns into no row.
///
/// An RPC failure propagates: unlike a per-market read, this one call *is* the adapter, so there
/// is nothing partial to salvage and `_safe` at the registry level is the right place to absorb it.
pub async fn position<R: EvmRpc + ?Sized>(
    rpc: &R,
    chain: &Chain,
    owner: &str,
) -> Result<Option<Position>> {
    let Some(pool) = chain.aave_pool else {
        return Ok(None); // no Aave v3 on this chain
    };

    let data = rpc
        .call_typed(
            pool,
            GET_USER_ACCOUNT_DATA,
            &[Value::address(owner)?],
            GET_USER_ACCOUNT_DATA_OUTPUTS,
        )
        .await?;

    let account = account_data(&data)?;
    if account.debt < MIN_DEBT_USD {
        return Ok(None); // supply-only: no liquidation risk, nothing to net
    }

    let mut found = Position::new(
        PROTOCOL,
        "Borrowing",
        "Borrow vs. supplied collateral",
        // The debt alone, negated — the collateral is already in spot as aTokens.
        Some(-account.debt),
    );
    found.health = Some(LendingHealth {
        hf: account.health_factor,
        ltv: account.ltv,
        liq_threshold: account.liq_threshold,
        collateral_usd: account.collateral,
        debt_usd: account.debt,
    });
    Ok(Some(found))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::U256;
    use crate::evm::MockRpc;

    const OWNER: &str = "0x1111111111111111111111111111111111111111";

    fn ethereum() -> &'static Chain {
        crate::chains::by_name("ethereum").expect("ethereum is in the chain table")
    }

    /// `getUserAccountData` answering with the six values, in base units.
    ///
    /// `collateral`/`debt` are USD, `ltv`/`liq` are fractions, `hf` is the raw word so a test can
    /// pass the `uint256::MAX` sentinel.
    fn mock(collateral: f64, debt: f64, ltv: f64, liq: f64, hf: U256) -> MockRpc {
        let pool = ethereum().aave_pool.expect("ethereum has an Aave pool");
        MockRpc::new()
            .returns(
                pool,
                GET_USER_ACCOUNT_DATA,
                &[Value::address(OWNER).unwrap()],
                &[
                    Value::uint((collateral * BASE_SCALE) as u64),
                    Value::uint((debt * BASE_SCALE) as u64),
                    Value::uint(0u64), // availableBorrowsBase, unused
                    Value::uint((liq * BPS_SCALE) as u64),
                    Value::uint((ltv * BPS_SCALE) as u64),
                    Value::uint(hf),
                ],
            )
            .unwrap()
    }

    /// `hf * 1e18` as a word.
    fn hf(value: f64) -> U256 {
        U256::from_dec_str(&format!("{:.0}", value * HF_SCALE)).unwrap()
    }

    #[tokio::test]
    async fn a_borrow_reports_the_debt_as_a_negative_never_the_net_equity() {
        // The invariant this module exists for. `10000 - 4000 = 6000` would double-count the
        // collateral, which is already in spot as aTokens.
        let rpc = mock(10_000.0, 4_000.0, 0.80, 0.825, hf(2.06));
        let found = position(&rpc, ethereum(), OWNER)
            .await
            .unwrap()
            .expect("a wallet with debt gets a row");

        assert_eq!(found.usd, Some(-4_000.0));
        assert_eq!(found.protocol, PROTOCOL);
        assert_eq!(found.category, "Borrowing");

        let health = found.health.unwrap();
        assert_eq!(health.collateral_usd, 10_000.0);
        assert_eq!(health.debt_usd, 4_000.0);
        assert_eq!(health.ltv, 0.80);
        assert_eq!(health.liq_threshold, 0.825);
        assert!((health.hf.unwrap() - 2.06).abs() < 1e-9);
    }

    #[tokio::test]
    async fn a_supply_only_wallet_gets_no_row() {
        // No debt means no liquidation risk, and the supplied aTokens are already in spot. A
        // zero-value row here would be clutter that also implies a borrow exists.
        let rpc = mock(10_000.0, 0.0, 0.80, 0.825, U256::MAX);
        assert!(position(&rpc, ethereum(), OWNER).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn dust_debt_is_below_the_floor_and_dropped() {
        let rpc = mock(10_000.0, 0.009, 0.80, 0.825, hf(900.0));
        assert!(position(&rpc, ethereum(), OWNER).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_chain_without_an_aave_deployment_makes_no_call() {
        let rpc = MockRpc::new();
        let hyperevm = crate::chains::by_name("hyperevm").expect("hyperevm is in the chain table");
        assert!(hyperevm.aave_pool.is_none(), "fixture assumption");
        assert!(position(&rpc, hyperevm, OWNER).await.unwrap().is_none());
        assert_eq!(rpc.call_count(), 0);
    }

    #[tokio::test]
    async fn the_max_sentinel_becomes_a_null_health_factor_not_an_astronomical_one() {
        // Reachable only if Aave ever reports MAX alongside real debt. Passing the raw word
        // through would render as an extremely healthy position — the opposite of the truth.
        let rpc = mock(10_000.0, 4_000.0, 0.80, 0.825, U256::MAX);
        let found = position(&rpc, ethereum(), OWNER).await.unwrap().unwrap();
        assert_eq!(found.health.unwrap().hf, None);
    }

    #[tokio::test]
    async fn an_underwater_position_keeps_its_sub_one_health_factor() {
        // hf < 1 is liquidatable. It must survive as a real number rather than being clamped.
        let rpc = mock(5_000.0, 4_800.0, 0.80, 0.825, hf(0.859));
        let found = position(&rpc, ethereum(), OWNER).await.unwrap().unwrap();
        let health = found.health.unwrap();
        assert!(health.hf.unwrap() < 1.0);
        assert_eq!(found.usd, Some(-4_800.0));
    }

    #[tokio::test]
    async fn the_id_key_is_written_as_null_like_every_other_position() {
        let rpc = mock(10_000.0, 4_000.0, 0.80, 0.825, hf(2.06));
        let found = position(&rpc, ethereum(), OWNER).await.unwrap().unwrap();
        let json = serde_json::to_value(&found).unwrap();
        assert!(json.get("id").unwrap().is_null());
        assert!(json.get("via").unwrap().is_null());
        assert_eq!(json.get("tokens").unwrap(), &serde_json::json!([]));
    }
}
