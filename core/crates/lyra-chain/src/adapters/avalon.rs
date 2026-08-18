//! Avalon Finance supply/borrow — the port of `portfolio.py:adapt_avalon` (L1688).
//!
//! Avalon is an Aave fork, so the pool speaks the same `getUserAccountData` interface as
//! [`super::aave`]. Everything else about how it is accounted differs, for one reason:
//!
//! # Its collateral is invisible to spot
//!
//! Avalon's aTokens are niche BTC derivatives — `aSolvBTCSOLVBTCBBN` (SolvBTC.BBN) and friends —
//! that DefiLlama does not price. The spot reader sees the balance, fails the
//! [`crate::spam::MIN_CONFIDENCE`] price gate, and drops it. So unlike Aave, the supplied
//! collateral is **not** already counted, and this position must carry the full net equity:
//!
//! ```text
//! usd = collateral_usd − debt_usd
//! ```
//!
//! which is [`super::compound`]'s convention, not [`super::aave`]'s. The same fork, read two
//! different ways, because what the spot reader can see differs — that is the thing to hold onto
//! if these three modules ever get "unified".
//!
//! Two consequences follow from it:
//!
//! * **Supply-only positions are kept.** In Aave they are skipped as clutter, because the value
//!   is in spot anyway. Here, skipping one would delete the holding from net worth outright.
//! * **The legs are walked.** [`legs`] reads every reserve through the ProtocolDataProvider so
//!   the UI can show which BTC derivative this actually is, rather than a bare USD figure with no
//!   way to tell what backs it.
//!
//! # Failure isolation inside the walk
//!
//! The Python wraps both the reserve list and each per-reserve read in `try/except`, returning
//! `[]` or skipping that reserve. [`legs`] does the same: the position and its health block are
//! worth reporting even when the breakdown cannot be read, since the pool call is what produces
//! the money figure and the legs are presentation.

use crate::abi::{Fields, U256, Value};
use crate::evm::{EvmRpc, EvmRpcExt, TokenMeta};
use crate::model::{LendingHealth, Position, TokenAmt};

use anyhow::Result;

use super::aave::{GET_USER_ACCOUNT_DATA, GET_USER_ACCOUNT_DATA_OUTPUTS, account_data};
use super::aero_cl::PriceSource;

/// `AAVE_DATA_PROVIDER_ABI` (portfolio.py L1641).
pub const GET_ALL_RESERVES_TOKENS: &str = "getAllReservesTokens()";
pub const GET_ALL_RESERVES_TOKENS_OUTPUTS: &str = "(string,address)[]";
pub const GET_USER_RESERVE_DATA: &str = "getUserReserveData(address,address)";
/// `currentATokenBalance, currentStableDebt, currentVariableDebt, principalStableDebt,
/// scaledVariableDebt, stableBorrowRate, liquidityRate, usageAsCollateralEnabled`.
pub const GET_USER_RESERVE_DATA_OUTPUTS: &str =
    "uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool";

const CURRENT_A_TOKEN_BALANCE: usize = 0;
const CURRENT_STABLE_DEBT: usize = 1;
const CURRENT_VARIABLE_DEBT: usize = 2;

/// Below this, neither collateral nor debt is worth a row.
const MIN_USD: f64 = 0.01;

/// Protocol label, as it appears in the response and in the UI.
pub const PROTOCOL: &str = "Avalon Finance";

/// One Avalon deployment: the pool and its ProtocolDataProvider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deployment {
    pub pool: &'static str,
    pub data: &'static str,
}

/// `AVALON_POOLS` (portfolio.py L1637), keyed by chain name.
///
/// Beside the adapter rather than in [`crate::chains`], because that is where the Python keeps
/// it — this is one protocol's deployment table, not part of the per-chain config block. The
/// addresses were verified in the oracle against the wallet's own `aToken.POOL()`.
pub static DEPLOYMENTS: &[(&str, Deployment)] = &[(
    "base",
    Deployment {
        pool: "0x6374a1F384737bcCCcD8fAE13064C18F7C8392e5",
        data: "0xA9D15C669940a757Ab76C6604f2f8f1e198f7D50",
    },
)];

/// The Avalon deployment on `chain`, if there is one.
#[must_use]
pub fn deployment(chain: &str) -> Option<Deployment> {
    DEPLOYMENTS
        .iter()
        .find(|(name, _)| *name == chain)
        .map(|(_, deployment)| *deployment)
}

/// The wallet's Avalon position on one chain, or `None` when it has neither supply nor debt.
///
/// An RPC failure on the **pool** call propagates — that call is the money figure. A failure
/// inside the reserve walk does not: see [`legs`].
pub async fn position<R, P>(
    rpc: &R,
    prices: &P,
    chain: &crate::chains::Chain,
    owner: &str,
) -> Result<Option<Position>>
where
    R: EvmRpc + ?Sized,
    P: PriceSource + ?Sized,
{
    let Some(deployment) = deployment(chain.name) else {
        return Ok(None); // no Avalon on this chain
    };

    let data = rpc
        .call_typed(
            deployment.pool,
            GET_USER_ACCOUNT_DATA,
            &[Value::address(owner)?],
            GET_USER_ACCOUNT_DATA_OUTPUTS,
        )
        .await?;
    let account = account_data(&data)?;

    if account.collateral < MIN_USD && account.debt < MIN_USD {
        return Ok(None); // nothing supplied or borrowed here
    }

    // A borrower and a pure supplier are the same row shape with different meanings, and the name
    // is the only place the response says which.
    let name = if account.debt >= MIN_USD {
        "Borrow vs. collateral"
    } else {
        "Supplied collateral"
    };

    let mut found = Position::new(
        PROTOCOL,
        "Lending",
        name,
        // Full net equity: nothing here is in spot, so this is the only place it is counted.
        Some(account.collateral - account.debt),
    );
    found.tokens = legs(rpc, prices, chain, deployment.data, owner).await;
    found.health = Some(LendingHealth {
        hf: account.health_factor,
        ltv: account.ltv,
        liq_threshold: account.liq_threshold,
        collateral_usd: account.collateral,
        debt_usd: account.debt,
    });
    Ok(Some(found))
}

/// The underlying supply/borrow legs — the port of `_avalon_tokens` (portfolio.py L1659).
///
/// Returns `[]` rather than an error on every failure path, matching the Python's two `try`
/// blocks: an unreadable reserve list or a reverting `getUserReserveData` costs the breakdown,
/// never the position. A row that says "$1,234 supplied" with no legs is worth strictly more than
/// no row at all.
///
/// A reserve with neither balance nor debt is skipped before its metadata is read, which is what
/// keeps this to a handful of calls on a pool with dozens of listed assets.
pub async fn legs<R, P>(
    rpc: &R,
    prices: &P,
    chain: &crate::chains::Chain,
    data_provider: &str,
    owner: &str,
) -> Vec<TokenAmt>
where
    R: EvmRpc + ?Sized,
    P: PriceSource + ?Sized,
{
    let Ok(owner_arg) = Value::address(owner) else {
        return Vec::new();
    };
    let reserves = match rpc
        .call_one(
            data_provider,
            GET_ALL_RESERVES_TOKENS,
            &[],
            GET_ALL_RESERVES_TOKENS_OUTPUTS,
        )
        .await
    {
        Ok(reserves) => reserves,
        Err(e) => {
            tracing::warn!(
                chain = chain.name,
                error = format!("{e:#}"),
                "avalon reserve list failed"
            );
            return Vec::new();
        }
    };
    let Ok(reserves) = reserves.as_array() else {
        return Vec::new();
    };

    let meta = TokenMeta::new();
    let mut out = Vec::new();
    for reserve in reserves {
        let Ok(fields) = reserve.as_tuple() else {
            continue;
        };
        let (Ok(symbol), Ok(asset)) = (
            fields.at(0).and_then(Value::as_str),
            fields.at(1).and_then(Value::as_address_string),
        ) else {
            continue;
        };
        let symbol = symbol.to_string();

        let Ok(asset_arg) = Value::address(&asset) else {
            continue;
        };
        let Ok(user) = rpc
            .call_typed(
                data_provider,
                GET_USER_RESERVE_DATA,
                &[asset_arg, owner_arg.clone()],
                GET_USER_RESERVE_DATA_OUTPUTS,
            )
            .await
        else {
            continue; // this reserve reverted; the others still count
        };

        let (Ok(balance), Ok(stable), Ok(variable)) = (
            user.at(CURRENT_A_TOKEN_BALANCE).and_then(Value::as_u256),
            user.at(CURRENT_STABLE_DEBT).and_then(Value::as_u256),
            user.at(CURRENT_VARIABLE_DEBT).and_then(Value::as_u256),
        ) else {
            continue;
        };
        let debt = stable.wrapping_add(variable);
        if balance == U256::ZERO && debt == U256::ZERO {
            continue; // untouched reserve — skipped before paying for its metadata
        }

        let Ok((decimals, _)) = meta.get(rpc, &asset).await else {
            continue;
        };
        // `llama_price(...) or 0`: an unpriced leg still shows its amount, which is the whole
        // point of walking the reserves for a token no feed covers.
        let price = prices.price(chain, &asset).await.unwrap_or(0.0);
        let scale = 10f64.powi(decimals);

        for (raw, side) in [(balance, "supply"), (debt, "borrow")] {
            if raw == U256::ZERO {
                continue;
            }
            let amount = raw.as_f64() / scale;
            out.push(TokenAmt {
                symbol: symbol.clone(),
                amount,
                usd: Some(amount * price),
                side: Some(side.to_string()),
                ..TokenAmt::default()
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters::aero_cl::StaticPrices;
    use crate::evm::MockRpc;

    const OWNER: &str = "0x1111111111111111111111111111111111111111";
    const SOLVBTC: &str = "0x3B86Ad95859b6AB773f55f8d94B4b9d443EE931f";

    fn base() -> &'static crate::chains::Chain {
        crate::chains::by_name("base").expect("base is in the chain table")
    }

    fn cfg() -> Deployment {
        deployment("base").expect("base has an Avalon deployment")
    }

    /// The pool's `getUserAccountData`, in base units.
    fn pool_mock(collateral: f64, debt: f64) -> MockRpc {
        MockRpc::new()
            .returns(
                cfg().pool,
                GET_USER_ACCOUNT_DATA,
                &[Value::address(OWNER).unwrap()],
                &[
                    Value::uint((collateral * 1e8) as u64),
                    Value::uint((debt * 1e8) as u64),
                    Value::uint(0u64),
                    Value::uint(8_250u64), // liq threshold, 82.5%
                    Value::uint(8_000u64), // ltv, 80%
                    Value::uint(U256::from_dec_str("2000000000000000000").unwrap()), // hf 2.0
                ],
            )
            .unwrap()
    }

    /// Add one reserve with the given aToken balance and variable debt, raw.
    fn with_reserve(rpc: MockRpc, balance: u64, variable_debt: u64) -> MockRpc {
        rpc.returns(
            cfg().data,
            GET_ALL_RESERVES_TOKENS,
            &[],
            &[Value::Array(vec![Value::Tuple(vec![
                Value::String("SolvBTC.BBN".into()),
                Value::address(SOLVBTC).unwrap(),
            ])])],
        )
        .unwrap()
        .returns(
            cfg().data,
            GET_USER_RESERVE_DATA,
            &[
                Value::address(SOLVBTC).unwrap(),
                Value::address(OWNER).unwrap(),
            ],
            &[
                Value::uint(balance),
                Value::uint(0u64),
                Value::uint(variable_debt),
                Value::uint(0u64),
                Value::uint(0u64),
                Value::uint(0u64),
                Value::uint(0u64),
                Value::Bool(true),
            ],
        )
        .unwrap()
        .returns(SOLVBTC, "decimals()", &[], &[Value::uint(18u64)])
        .unwrap()
        .returns(
            SOLVBTC,
            "symbol()",
            &[],
            &[Value::String("SolvBTC.BBN".into())],
        )
        .unwrap()
    }

    fn priced() -> StaticPrices {
        StaticPrices::new().with(SOLVBTC, 60_000.0, Some(1.0))
    }

    #[tokio::test]
    async fn the_value_is_net_equity_not_negated_debt() {
        // The invariant. Avalon's collateral is not in spot, so `-debt` would delete it from net
        // worth entirely — the opposite mistake from the one Aave guards against.
        let rpc = with_reserve(pool_mock(10_000.0, 4_000.0), 0, 0);
        let found = position(&rpc, &priced(), base(), OWNER)
            .await
            .unwrap()
            .expect("a wallet with collateral gets a row");

        assert_eq!(found.usd, Some(6_000.0));
        assert_eq!(found.protocol, PROTOCOL);
        assert_eq!(found.category, "Lending");
        assert_eq!(found.name, "Borrow vs. collateral");
    }

    #[tokio::test]
    async fn a_supply_only_position_is_kept_unlike_aave() {
        // Skipping this would delete the holding from net worth, because nothing else counts it.
        let rpc = with_reserve(pool_mock(10_000.0, 0.0), 0, 0);
        let found = position(&rpc, &priced(), base(), OWNER)
            .await
            .unwrap()
            .expect("a pure supplier still holds something");

        assert_eq!(found.usd, Some(10_000.0));
        assert_eq!(found.name, "Supplied collateral");
        assert_eq!(found.health.unwrap().debt_usd, 0.0);
    }

    #[tokio::test]
    async fn an_empty_account_gets_no_row() {
        let rpc = with_reserve(pool_mock(0.0, 0.0), 0, 0);
        assert!(
            position(&rpc, &priced(), base(), OWNER)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_chain_without_an_avalon_deployment_makes_no_call() {
        let rpc = MockRpc::new();
        let ethereum = crate::chains::by_name("ethereum").unwrap();
        assert!(
            position(&rpc, &priced(), ethereum, OWNER)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(rpc.call_count(), 0);
    }

    #[tokio::test]
    async fn the_legs_carry_a_side_and_split_supply_from_borrow() {
        // 0.5 SolvBTC supplied, 0.1 borrowed.
        let rpc = with_reserve(
            pool_mock(30_000.0, 6_000.0),
            500_000_000_000_000_000,
            100_000_000_000_000_000,
        );
        let found = position(&rpc, &priced(), base(), OWNER)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(found.tokens.len(), 2, "one supply leg and one borrow leg");
        assert_eq!(found.tokens[0].side.as_deref(), Some("supply"));
        assert!((found.tokens[0].amount - 0.5).abs() < 1e-12);
        assert!((found.tokens[0].usd.unwrap() - 30_000.0).abs() < 1e-6);
        assert_eq!(found.tokens[1].side.as_deref(), Some("borrow"));
        assert!((found.tokens[1].amount - 0.1).abs() < 1e-12);
        assert_eq!(found.tokens[0].symbol, "SolvBTC.BBN");
    }

    #[tokio::test]
    async fn an_untouched_reserve_is_skipped_before_its_metadata_is_read() {
        let rpc = with_reserve(pool_mock(10_000.0, 0.0), 0, 0);
        let found = position(&rpc, &priced(), base(), OWNER)
            .await
            .unwrap()
            .unwrap();

        assert!(found.tokens.is_empty());
        assert!(
            !rpc.calls()
                .iter()
                .any(|c| c.to.eq_ignore_ascii_case(SOLVBTC)),
            "a zero reserve must not cost a decimals()/symbol() round trip"
        );
    }

    #[tokio::test]
    async fn an_unreadable_reserve_list_costs_the_legs_not_the_position() {
        // The money figure comes from the pool call; the breakdown is presentation. A row saying
        // "$6,000 net" with no legs beats no row at all.
        let rpc = pool_mock(10_000.0, 4_000.0); // no data-provider stubs at all
        let found = position(&rpc, &priced(), base(), OWNER)
            .await
            .unwrap()
            .expect("the position survives an unreadable breakdown");

        assert_eq!(found.usd, Some(6_000.0));
        assert!(found.tokens.is_empty());
        assert!(found.health.is_some());
    }

    #[tokio::test]
    async fn an_unpriced_leg_still_shows_its_amount() {
        // The reason the legs are walked at all: these are BTC derivatives no feed covers, and an
        // amount with no USD is far more use than nothing.
        let rpc = with_reserve(pool_mock(30_000.0, 0.0), 500_000_000_000_000_000, 0);
        let found = position(&rpc, &StaticPrices::new(), base(), OWNER)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(found.tokens.len(), 1);
        assert!((found.tokens[0].amount - 0.5).abs() < 1e-12);
        assert_eq!(found.tokens[0].usd, Some(0.0));
    }
}
