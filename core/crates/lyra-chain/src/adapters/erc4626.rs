//! ERC-4626 vaults — port of `portfolio.py:_vault_position` (L646) and `adapt_erc4626` (L669).
//!
//! A vault share is not the asset it represents. Deposit 1 WBTC into a yield vault and you get
//! back some number of shares; as the vault earns, each share becomes worth **more** than one
//! WBTC, and the exchange rate is whatever `convertToAssets` says it is. Nothing about the share
//! balance reveals this — a vault holding 1.0 shares at a 1.08 share price looks exactly like a
//! wallet holding 1.0 WBTC unless you ask.
//!
//! So the one thing this adapter must never do is treat shares as assets. Everything else here is
//! bookkeeping around that single call:
//!
//! ```text
//! balanceOf(owner) -> shares      // nothing held? not a position
//! asset()          -> address     // succeeds only on a real 4626; this is the type test
//! convertToAssets(shares) -> raw  // THE conversion: shares priced in the underlying
//! decimals()/symbol() on the asset // scale and label
//! ```
//!
//! **Detection is by attempt, not by list.** There is no registry of vaults; the adapter tries
//! every ERC-20 the wallet holds and keeps the ones that answer. That makes failure completely
//! routine — plain ERC-20s have no `asset()` and revert — so a failure here is *not* an error, it
//! is the answer "not a vault". The Python expresses that with a bare `except: return None` around
//! the whole read, and this module matches it: [`vault_position`] returns `Option`, never `Result`.
//!
//! The position also carries `spot_addr`, which tells the orchestrator to drop the vault share
//! token from the chain's spot list — otherwise the same money is counted twice, once as a share
//! token and once as the vault position.

use crate::abi::{Address, U256, Value};
use crate::chains::Chain;
use crate::evm::{EvmRpc, EvmRpcExt};
use crate::model::{Position, SpotToken, TokenAmt};
use crate::prices::Prices;

pub const PROTOCOL: &str = "ERC-4626 vault";
pub const CATEGORY: &str = "Yield";

/// Used when the vault contract has no readable `name()` — the Python's
/// `_token_name(...) or "ERC-4626 vault"`.
pub const FALLBACK_NAME: &str = "ERC-4626 vault";

/// `_token_meta`'s native shortcut: `address(0)` is the chain's own coin, and asking it for
/// `decimals()` would revert.
pub const NATIVE_DECIMALS: u8 = 18;
pub const NATIVE_SYMBOL: &str = "ETH";

/// What one vault told us about a wallet's holding.
///
/// Kept as raw integers plus decimals rather than a pre-divided float so the scaling happens in
/// exactly one place ([`VaultReading::assets`]) and can be tested on its own.
#[derive(Debug, Clone, PartialEq)]
pub struct VaultReading {
    /// Vault shares the wallet holds, in the vault's own units.
    pub shares: U256,
    /// The underlying token, from `asset()`.
    pub asset: String,
    /// `convertToAssets(shares)` — the holding expressed in the underlying, still unscaled.
    pub assets_raw: U256,
    /// Decimals of the **asset**, not of the vault. The two can differ.
    pub decimals: u8,
    /// Symbol of the asset — what the position's token leg is labelled with.
    pub symbol: String,
    /// The vault's own `name()`, e.g. `"Gauntlet WBTC Core"`.
    pub name: Option<String>,
}

impl VaultReading {
    /// The holding in whole units of the underlying asset.
    ///
    /// This is the number that differs from the share balance whenever the vault has earned
    /// anything, which is the entire reason this adapter exists.
    pub fn assets(&self) -> f64 {
        self.assets_raw.as_f64() / 10f64.powi(self.decimals as i32)
    }

    /// Assets per share — not used in the valuation, but the number a human wants when asking
    /// "is this vault actually earning?".
    pub fn share_price(&self) -> Option<f64> {
        if self.shares.is_zero() {
            return None;
        }
        Some(self.assets_raw.as_f64() / self.shares.as_f64())
    }
}

/// `int(addr, 16) == 0` — the native-coin sentinel.
fn is_zero_address(address: &str) -> bool {
    Address::from_hex(address.trim()).is_ok_and(|parsed| parsed.is_zero())
}

/// Assemble the position from an already-read vault and an already-resolved price.
///
/// Split out from the I/O so the valuation can be tested directly. `usd` is `None` when the asset
/// has no price — the Python's `qty * price if price else None` — which renders the position as a
/// row with an unknown value rather than pretending it is worth zero.
pub fn vault_position_from(
    share_token: &str,
    reading: &VaultReading,
    price: Option<f64>,
    change24h: Option<f64>,
) -> Position {
    let quantity = reading.assets();
    let usd = price.map(|price| quantity * price);

    let mut position = Position::new(
        PROTOCOL,
        CATEGORY,
        reading.name.clone().unwrap_or_else(|| FALLBACK_NAME.into()),
        usd,
    );
    position.tokens = vec![TokenAmt {
        symbol: reading.symbol.clone(),
        amount: quantity,
        ..Default::default()
    }];
    // `_position` writes change24h only when it is not None, so an unknown change is an absent
    // key rather than a null one.
    position.change24h = change24h.map(Some);
    // Consumed from spot by the orchestrator; never serialised.
    position.spot_addr = Some(share_token.to_string());
    position
}

/// `_token_meta`: `(decimals, symbol)` of a token, with the native shortcut.
async fn token_meta<R: EvmRpc + ?Sized>(rpc: &R, token: &str) -> Option<(u8, String)> {
    if is_zero_address(token) {
        return Some((NATIVE_DECIMALS, NATIVE_SYMBOL.to_string()));
    }
    let decimals = rpc
        .call_one(token, "decimals()", &[], "uint8")
        .await
        .ok()?
        .as_u8()
        .ok()?;
    let symbol = rpc
        .call_one(token, "symbol()", &[], "string")
        .await
        .ok()?
        .as_str()
        .ok()?
        .to_string();
    Some((decimals, symbol))
}

/// Read one candidate vault. `None` means "not a vault, or nothing held" — both are ordinary.
///
/// The call order matters and is the Python's: the cheap disqualifiers come first, so a wallet
/// full of plain ERC-20s costs one `balanceOf` each rather than four calls each.
pub async fn read_vault<R: EvmRpc + ?Sized>(
    rpc: &R,
    share_token: &str,
    owner: &str,
) -> Option<VaultReading> {
    let owner_address = Address::from_hex(owner).ok()?;
    let shares = rpc
        .call_one(
            share_token,
            "balanceOf(address)",
            &[Value::Address(owner_address)],
            "uint256",
        )
        .await
        .ok()?
        .as_u256()
        .ok()?;

    // Nothing held: not a position, and no reason to ask three more questions.
    if shares.is_zero() {
        return None;
    }

    // The type test. A plain ERC-20 reverts here, which is how a non-vault is rejected.
    let asset = rpc
        .call_one(share_token, "asset()", &[], "address")
        .await
        .ok()?
        .as_address_string()
        .ok()?;

    let assets_raw = rpc
        .call_one(
            share_token,
            "convertToAssets(uint256)",
            &[Value::Uint(shares)],
            "uint256",
        )
        .await
        .ok()?
        .as_u256()
        .ok()?;

    let (decimals, symbol) = token_meta(rpc, &asset).await?;

    // `_token_name` has its own try/except: a vault with no name() is still a vault.
    let name = rpc
        .call_one(share_token, "name()", &[], "string")
        .await
        .ok()
        .and_then(|value| value.as_str().ok().map(str::to_string))
        .filter(|name| !name.is_empty());

    Some(VaultReading {
        shares,
        asset,
        assets_raw,
        decimals,
        symbol,
        name,
    })
}

/// One spot token, checked for being a vault — `_vault_position`.
pub async fn vault_position<R: EvmRpc + ?Sized>(
    rpc: &R,
    prices: &Prices,
    chain: &Chain,
    share_token: &str,
    owner: &str,
) -> Option<Position> {
    let reading = read_vault(rpc, share_token, owner).await?;
    let price = prices.llama_price(chain, &reading.asset).await;
    let change = prices.llama_change(chain, &reading.asset).await;
    Some(vault_position_from(share_token, &reading, price, change))
}

/// Check every held ERC-20 for being a vault — `adapt_erc4626`.
///
/// Native coins are skipped (`kind == "token"` in the Python), as are tokens with no address:
/// there is nothing to call `asset()` on.
pub async fn adapt_erc4626<R: EvmRpc + ?Sized>(
    rpc: &R,
    prices: &Prices,
    chain: &Chain,
    owner: &str,
    spot: &[SpotToken],
) -> Vec<Position> {
    let candidates: Vec<&str> = spot
        .iter()
        .filter(|token| token.kind.as_deref() == Some("token"))
        .filter_map(|token| token.address.as_deref())
        .collect();

    // The Python fans these out across a thread pool; the ordering of the result is the ordering
    // of the input either way, and keeping it sequential here keeps the adapter's RPC load
    // predictable. Concurrency is the orchestrator's decision to make, not this module's.
    let mut positions = Vec::new();
    for share_token in candidates {
        if let Some(position) = vault_position(rpc, prices, chain, share_token, owner).await {
            positions.push(position);
        }
    }
    positions
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::abi::hex_encode;
    use crate::evm::MockRpc;
    use crate::http_cache::{HttpCache, Mode, Recorded, cache_key};
    use crate::model::Nullable;
    use std::path::Path;
    use tempfile::TempDir;

    const VAULT: &str = "0x1111111111111111111111111111111111111111";
    const WBTC: &str = "0x2222222222222222222222222222222222222222";
    const OWNER: &str = "0x3333333333333333333333333333333333333333";
    const PLAIN_ERC20: &str = "0x4444444444444444444444444444444444444444";

    fn chain() -> &'static Chain {
        crate::chains::by_name("base").expect("base is configured")
    }

    fn owner_arg() -> Value {
        Value::Address(Address::from_hex(OWNER).unwrap())
    }

    /// A vault that converts `shares` into `assets_raw`, with an 8-decimal WBTC underneath.
    fn vault_rpc(shares: u128, assets_raw: u128, name: &str) -> MockRpc {
        MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u128(shares))],
            )
            .unwrap()
            .returns(
                VAULT,
                "asset()",
                &[],
                &[Value::Address(Address::from_hex(WBTC).unwrap())],
            )
            .unwrap()
            .returns(
                VAULT,
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u128(shares))],
                &[Value::Uint(U256::from_u128(assets_raw))],
            )
            .unwrap()
            .returns(VAULT, "name()", &[], &[Value::String(name.into())])
            .unwrap()
            .returns(WBTC, "decimals()", &[], &[Value::Uint(U256::from_u64(8))])
            .unwrap()
            .returns(WBTC, "symbol()", &[], &[Value::String("WBTC".into())])
            .unwrap()
    }

    /// A `Prices` that can only replay: any lookup it was not given a fixture for returns `None`,
    /// and nothing can reach the network.
    fn offline_prices(dir: &Path) -> Prices {
        Prices::new(reqwest::Client::new(), HttpCache::new(dir, Mode::Replay))
    }

    /// Write a DefiLlama price/change fixture for one coin key.
    fn seed_llama(dir: &Path, key: &str, price: f64, change: f64) {
        for (url, body) in [
            (
                format!("https://coins.llama.fi/prices/current/{key}"),
                format!(r#"{{"coins":{{"{key}":{{"price":{price},"confidence":0.99}}}}}}"#),
            ),
            (
                format!("https://coins.llama.fi/percentage/{key}?period=24h"),
                format!(r#"{{"coins":{{"{key}":{change}}}}}"#),
            ),
        ] {
            let recorded = Recorded {
                url: url.clone(),
                method: "GET".into(),
                status: 200,
                body,
            };
            let path = dir.join(format!("{}.json", cache_key("GET", &url, None)));
            std::fs::write(path, serde_json::to_string_pretty(&recorded).unwrap()).unwrap();
        }
    }

    // --- the conversion -----------------------------------------------------

    #[tokio::test]
    async fn a_vault_that_has_earned_is_worth_more_than_its_share_count() {
        // 1.0 shares, but convertToAssets says 1.08 WBTC — the vault has earned 8%. Reading the
        // share balance as if it were the asset would understate this holding by 8% forever, and
        // nothing in the response would look wrong.
        let rpc = vault_rpc(100_000_000, 108_000_000, "Gauntlet WBTC Core");
        let reading = read_vault(&rpc, VAULT, OWNER).await.expect("a vault");

        assert_eq!(reading.shares, U256::from_u64(100_000_000));
        assert_eq!(reading.assets(), 1.08, "assets, not shares");
        assert_eq!(reading.share_price(), Some(1.08));
        assert_eq!(reading.symbol, "WBTC");
        assert_eq!(reading.decimals, 8, "the asset's decimals, not the vault's");

        let position = vault_position_from(VAULT, &reading, Some(100_000.0), None);
        assert_eq!(position.usd, Some(108_000.0), "1.08 WBTC at 100k");
        assert_eq!(position.tokens[0].amount, 1.08);
        assert_eq!(position.tokens[0].symbol, "WBTC");
    }

    #[tokio::test]
    async fn the_conversion_is_asked_for_the_shares_actually_held() {
        // convertToAssets takes the share balance as its argument. Calling it with 1e18, or with a
        // hard-coded 1, would return a rate rather than this wallet's holding.
        let rpc = vault_rpc(250_000_000, 270_000_000, "Vault");
        read_vault(&rpc, VAULT, OWNER).await.unwrap();

        let expected = hex_encode(
            &crate::abi::encode_call(
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u64(250_000_000))],
            )
            .unwrap(),
        );
        assert!(
            rpc.calls().iter().any(|call| call.data == expected),
            "convertToAssets was not called with the held share balance; calls: {:?}",
            rpc.calls()
        );
    }

    #[tokio::test]
    async fn a_share_price_below_one_is_carried_faithfully() {
        // Vaults can lose money (a bad debt socialisation, a slashing). Reporting shares as assets
        // would overstate the position — the same bug in the other direction.
        let rpc = vault_rpc(100_000_000, 92_000_000, "Sad Vault");
        let reading = read_vault(&rpc, VAULT, OWNER).await.unwrap();
        assert_eq!(reading.assets(), 0.92);
        assert_eq!(reading.share_price(), Some(0.92));
    }

    #[tokio::test]
    async fn an_eighteen_decimal_asset_scales_correctly() {
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u128(1_000_000_000_000_000_000))],
            )
            .unwrap()
            .returns(
                VAULT,
                "asset()",
                &[],
                &[Value::Address(Address::from_hex(WBTC).unwrap())],
            )
            .unwrap()
            .returns(
                VAULT,
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u128(1_000_000_000_000_000_000))],
                &[Value::Uint(U256::from_u128(1_234_500_000_000_000_000))],
            )
            .unwrap()
            .returns(VAULT, "name()", &[], &[Value::String("stETH Vault".into())])
            .unwrap()
            .returns(WBTC, "decimals()", &[], &[Value::Uint(U256::from_u64(18))])
            .unwrap()
            .returns(WBTC, "symbol()", &[], &[Value::String("WETH".into())])
            .unwrap();

        let reading = read_vault(&rpc, VAULT, OWNER).await.unwrap();
        assert_eq!(reading.assets(), 1.2345);
    }

    // --- rejection ----------------------------------------------------------

    #[tokio::test]
    async fn a_plain_erc20_is_skipped_rather_than_fatal() {
        // The routine case: most held tokens are not vaults. `asset()` reverts and the token is
        // simply not a position — this must never propagate as an error.
        let rpc = MockRpc::new()
            .returns(
                PLAIN_ERC20,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u64(5_000))],
            )
            .unwrap()
            .reverts(PLAIN_ERC20, "asset()", "execution reverted")
            .unwrap();

        assert!(read_vault(&rpc, PLAIN_ERC20, OWNER).await.is_none());
    }

    #[tokio::test]
    async fn a_contract_with_no_code_is_skipped() {
        // `0x` back from the node — `decode` turns that into an error, not a zero.
        let rpc = MockRpc::new()
            .returns_nothing(PLAIN_ERC20, "balanceOf(address)")
            .unwrap();
        assert!(read_vault(&rpc, PLAIN_ERC20, OWNER).await.is_none());
    }

    #[tokio::test]
    async fn a_zero_share_balance_is_not_a_position() {
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::ZERO)],
            )
            .unwrap();

        assert!(read_vault(&rpc, VAULT, OWNER).await.is_none());
        assert_eq!(
            rpc.call_count(),
            1,
            "an empty holding must not cost three more calls"
        );
    }

    #[tokio::test]
    async fn a_vault_whose_conversion_reverts_is_skipped() {
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u64(100))],
            )
            .unwrap()
            .returns(
                VAULT,
                "asset()",
                &[],
                &[Value::Address(Address::from_hex(WBTC).unwrap())],
            )
            .unwrap()
            .reverts(VAULT, "convertToAssets(uint256)", "ERC4626: paused")
            .unwrap();

        assert!(read_vault(&rpc, VAULT, OWNER).await.is_none());
    }

    #[tokio::test]
    async fn an_unreadable_asset_symbol_skips_the_vault() {
        // Without decimals the amount cannot be scaled, and a wrongly scaled amount is worse than
        // a missing one.
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u64(100))],
            )
            .unwrap()
            .returns(
                VAULT,
                "asset()",
                &[],
                &[Value::Address(Address::from_hex(WBTC).unwrap())],
            )
            .unwrap()
            .returns(
                VAULT,
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u64(100))],
                &[Value::Uint(U256::from_u64(108))],
            )
            .unwrap()
            .reverts(WBTC, "decimals()", "no such function")
            .unwrap();

        assert!(read_vault(&rpc, VAULT, OWNER).await.is_none());
    }

    #[tokio::test]
    async fn a_nameless_vault_falls_back_to_a_generic_label() {
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u64(100_000_000))],
            )
            .unwrap()
            .returns(
                VAULT,
                "asset()",
                &[],
                &[Value::Address(Address::from_hex(WBTC).unwrap())],
            )
            .unwrap()
            .returns(
                VAULT,
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u64(100_000_000))],
                &[Value::Uint(U256::from_u64(100_000_000))],
            )
            .unwrap()
            .reverts(VAULT, "name()", "no name")
            .unwrap()
            .returns(WBTC, "decimals()", &[], &[Value::Uint(U256::from_u64(8))])
            .unwrap()
            .returns(WBTC, "symbol()", &[], &[Value::String("WBTC".into())])
            .unwrap();

        let reading = read_vault(&rpc, VAULT, OWNER).await.unwrap();
        assert_eq!(reading.name, None);
        let position = vault_position_from(VAULT, &reading, Some(1.0), None);
        assert_eq!(position.name, "ERC-4626 vault");
    }

    // --- native asset -------------------------------------------------------

    #[tokio::test]
    async fn a_vault_over_the_native_coin_short_circuits_its_metadata() {
        // `_token_meta` answers (18, "ETH") for address(0) rather than calling it — asking the
        // zero address for decimals() reverts.
        let native = "0x0000000000000000000000000000000000000000";
        let rpc = MockRpc::new()
            .returns(
                VAULT,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u128(2_000_000_000_000_000_000))],
            )
            .unwrap()
            .returns(VAULT, "asset()", &[], &[Value::Address(Address::ZERO)])
            .unwrap()
            .returns(
                VAULT,
                "convertToAssets(uint256)",
                &[Value::Uint(U256::from_u128(2_000_000_000_000_000_000))],
                &[Value::Uint(U256::from_u128(2_500_000_000_000_000_000))],
            )
            .unwrap()
            .returns(VAULT, "name()", &[], &[Value::String("ETH Vault".into())])
            .unwrap();

        let reading = read_vault(&rpc, VAULT, OWNER).await.unwrap();
        assert_eq!(reading.asset, native);
        assert_eq!(reading.symbol, "ETH");
        assert_eq!(reading.decimals, 18);
        assert_eq!(reading.assets(), 2.5);
    }

    // --- position shape -----------------------------------------------------

    #[test]
    fn the_position_carries_the_share_token_for_spot_dedup() {
        // Without this the vault's money is counted twice: once as the share token in spot, once
        // as this position.
        let reading = VaultReading {
            shares: U256::from_u64(100_000_000),
            asset: WBTC.into(),
            assets_raw: U256::from_u64(108_000_000),
            decimals: 8,
            symbol: "WBTC".into(),
            name: Some("Gauntlet WBTC Core".into()),
        };
        let position = vault_position_from(VAULT, &reading, Some(100_000.0), Some(-2.5));

        assert_eq!(position.spot_addr.as_deref(), Some(VAULT));
        assert_eq!(position.protocol, "ERC-4626 vault");
        assert_eq!(position.category, "Yield");
        assert_eq!(position.name, "Gauntlet WBTC Core");
        assert_eq!(position.change24h, Some(Some(-2.5)));
    }

    #[test]
    fn an_unpriced_asset_leaves_the_value_unknown_rather_than_zero() {
        // `qty * price if price else None`: a vault whose asset DefiLlama does not cover still
        // shows as a row, with its amount, and no dollar figure invented for it.
        let reading = VaultReading {
            shares: U256::from_u64(100),
            asset: WBTC.into(),
            assets_raw: U256::from_u64(108),
            decimals: 2,
            symbol: "WBTC".into(),
            name: None,
        };
        let position = vault_position_from(VAULT, &reading, None, None);
        assert_eq!(position.usd, None);
        assert_eq!(position.tokens[0].amount, 1.08, "the amount is still known");
    }

    #[test]
    fn an_unknown_change_is_an_absent_key_not_a_null_one() {
        let reading = VaultReading {
            shares: U256::from_u64(1),
            asset: WBTC.into(),
            assets_raw: U256::from_u64(1),
            decimals: 0,
            symbol: "WBTC".into(),
            name: None,
        };
        let position = vault_position_from(VAULT, &reading, Some(1.0), None);
        let absent: Nullable<f64> = None;
        assert_eq!(position.change24h, absent);

        let json = serde_json::to_value(&position).unwrap();
        assert!(
            json.get("change24h").is_none(),
            "_position omits the key entirely: {json}"
        );
        assert!(
            json.get("_spot_addr").is_none() && json.get("spot_addr").is_none(),
            "spot_addr is internal: {json}"
        );
    }

    // --- the sweep ----------------------------------------------------------

    #[tokio::test]
    async fn every_held_token_is_checked_and_only_vaults_are_kept() {
        let dir = TempDir::new().unwrap();
        seed_llama(
            dir.path(),
            &crate::prices::coin_key(chain(), WBTC).unwrap(),
            100_000.0,
            -2.5,
        );
        let prices = offline_prices(dir.path());

        let rpc = vault_rpc(100_000_000, 108_000_000, "Gauntlet WBTC Core")
            .returns(
                PLAIN_ERC20,
                "balanceOf(address)",
                &[owner_arg()],
                &[Value::Uint(U256::from_u64(5_000))],
            )
            .unwrap()
            .reverts(PLAIN_ERC20, "asset()", "execution reverted")
            .unwrap();

        let spot = vec![
            SpotToken {
                symbol: Some("gtWBTC".into()),
                address: Some(VAULT.into()),
                kind: Some("token".into()),
                ..Default::default()
            },
            SpotToken {
                symbol: Some("USDC".into()),
                address: Some(PLAIN_ERC20.into()),
                kind: Some("token".into()),
                ..Default::default()
            },
            SpotToken {
                symbol: Some("ETH".into()),
                kind: Some("native".into()),
                ..Default::default()
            },
        ];

        let positions = adapt_erc4626(&rpc, &prices, chain(), OWNER, &spot).await;
        assert_eq!(positions.len(), 1, "only the vault: {positions:?}");
        assert_eq!(positions[0].usd, Some(108_000.0));
        assert_eq!(positions[0].change24h, Some(Some(-2.5)));
        assert_eq!(positions[0].spot_addr.as_deref(), Some(VAULT));
    }

    #[tokio::test]
    async fn the_native_coin_is_never_probed() {
        // It has no address to call, and `kind == "token"` filters it out before any RPC.
        let dir = TempDir::new().unwrap();
        let prices = offline_prices(dir.path());
        let rpc = MockRpc::new();
        let spot = vec![SpotToken {
            symbol: Some("ETH".into()),
            kind: Some("native".into()),
            ..Default::default()
        }];

        assert!(
            adapt_erc4626(&rpc, &prices, chain(), OWNER, &spot)
                .await
                .is_empty()
        );
        assert_eq!(rpc.call_count(), 0, "no calls at all");
    }

    #[tokio::test]
    async fn an_empty_wallet_yields_no_positions() {
        let dir = TempDir::new().unwrap();
        let prices = offline_prices(dir.path());
        let rpc = MockRpc::new();
        assert!(
            adapt_erc4626(&rpc, &prices, chain(), OWNER, &[])
                .await
                .is_empty()
        );
        assert_eq!(rpc.call_count(), 0);
    }

    #[tokio::test]
    async fn a_vault_with_no_price_still_reports_its_amount() {
        // No fixture seeded, so every DefiLlama lookup misses and returns None.
        let dir = TempDir::new().unwrap();
        let prices = offline_prices(dir.path());
        let rpc = vault_rpc(100_000_000, 108_000_000, "Gauntlet WBTC Core");
        let spot = vec![SpotToken {
            symbol: Some("gtWBTC".into()),
            address: Some(VAULT.into()),
            kind: Some("token".into()),
            ..Default::default()
        }];

        let positions = adapt_erc4626(&rpc, &prices, chain(), OWNER, &spot).await;
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].usd, None);
        assert_eq!(positions[0].tokens[0].amount, 1.08);
    }
}
