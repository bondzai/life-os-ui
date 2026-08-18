//! Morpho Blue borrow positions — port of `portfolio.py:adapt_morpho` (L1812).
//!
//! Morpho is the one adapter with **no on-chain path**. A Morpho market is identified by a
//! `marketId`, and there is no way to enumerate the markets a given wallet is in by reading the
//! chain: you would have to know the ids in advance. The keyless GraphQL API at api.morpho.org
//! resolves them from an address, and returns health factor and USD values already computed, so
//! that is what the Python uses and what this port uses.
//!
//! # This adapter carries debt, and the sign matters
//!
//! A borrow position is two numbers — collateral held *inside* Morpho, and a loan drawn against
//! it. The collateral is not in the wallet's spot balances (Morpho custodies it), so it has to be
//! added; the debt is real money owed, so it has to be subtracted:
//!
//! ```text
//! usd = collateralUsd − borrowAssetsUsd
//! ```
//!
//! Dropping the debt term would inflate net worth by the full loan — and a leveraged position can
//! easily borrow most of its collateral's value, so this is not a rounding error. Flipping the
//! sign would do the same in reverse. Both legs are also preserved individually in
//! [`crate::model::LendingHealth`], which is what feeds the health-factor alarm in
//! `lyra-alerts::rules`.
//!
//! # Only borrows
//!
//! Supply-only positions (a MetaMorpho vault deposit) are deliberately **not** returned here: they
//! are ERC-4626 vault shares and `adapters::erc4626` already reports them. Returning them from
//! both adapters would count the same deposit twice. The `debt >= 0.01` filter is what enforces
//! that, so it is load-bearing rather than cosmetic.
//!
//! # Why a zero-collateral position is skipped
//!
//! The Python requires **both** USD legs to be non-trivial, with a comment worth repeating: a real
//! borrow always has collateral, so a null or zero `collateralUsd` means the API has no price feed
//! for that collateral — the market is exotic or mispriced. Its USD figures cannot be trusted, and
//! trusting them would inject a bogus multi-billion liability into net worth. Skipping is the safe
//! direction.

use serde_json::{Value, json};

use crate::http_cache::HttpCache;
use crate::model::{LendingHealth, Position};

pub const PROTOCOL: &str = "Morpho";
pub const CATEGORY: &str = "Borrowing";
pub const MORPHO_API: &str = "https://api.morpho.org/graphql";

/// Both USD legs must clear this for the position to be trusted at all.
pub const MIN_USD: f64 = 0.01;

/// `lltv` is a WAD-scaled ratio (0.86e18 = 86%).
const WAD: f64 = 1e18;

/// The query, byte-for-byte as the Python sends it — it is part of the cache key, so reformatting
/// it would silently invalidate every recorded fixture.
pub const MORPHO_QUERY: &str = "query($c:Int!,$a:String!){userByAddress(chainId:$c,address:$a){marketPositions{\
healthFactor market{lltv loanAsset{symbol}collateralAsset{symbol}}\
state{collateralUsd borrowAssetsUsd}}}}";

/// Chains Morpho Blue is deployed on — `_MORPHO_CHAIN_IDS`. A chain that is absent is not an
/// error, it simply has no Morpho.
pub fn chain_id(chain: &str) -> Option<i64> {
    Some(match chain {
        "ethereum" => 1,
        "base" => 8453,
        "arbitrum" => 42161,
        "optimism" => 10,
        "polygon" => 137,
        _ => return None,
    })
}

/// The GraphQL request body. Shared by the adapter and its tests so a fixture key can never drift
/// from the request that looks it up.
pub fn request_body(chain_id: i64, owner: &str) -> Value {
    json!({"query": MORPHO_QUERY, "variables": {"c": chain_id, "a": owner}})
}

/// One market position as the API reports it, reduced to the fields that take part in a decision.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MarketPosition {
    /// `null` for a supply-only position, and for a borrow the API cannot price.
    pub health_factor: Option<f64>,
    /// Liquidation LTV, already unscaled from WAD.
    pub liq_threshold: f64,
    /// Symbol of the collateral asset, as rendered into the pair label.
    pub collateral_symbol: String,
    /// Symbol of the borrowed asset.
    pub loan_symbol: String,
    pub collateral_usd: f64,
    pub debt_usd: f64,
}

impl MarketPosition {
    /// `"WBTC/USDC"` — collateral first, then what was borrowed against it.
    pub fn pair(&self) -> String {
        format!("{}/{}", self.collateral_symbol, self.loan_symbol)
    }
}

/// Python's `x or 0` over a JSON number that may be `null`, absent, or a numeric string.
fn number_or_zero(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// A symbol as the Python's f-string renders it.
///
/// `(mkt.get("collateralAsset") or {}).get("symbol", "?")` gives `"?"` when the **key is missing**
/// but `None` — which an f-string prints as the literal `"None"` — when the key is present and
/// null. The two spellings are preserved because they end up in the position's name, and a name
/// that changed shape would look like a different position to anything keying on it.
fn symbol_of(asset: Option<&Value>) -> String {
    let Some(asset) = asset else {
        return "?".to_string();
    };
    match asset.get("symbol") {
        None => "?".to_string(),
        Some(Value::Null) => "None".to_string(),
        Some(Value::String(symbol)) => symbol.clone(),
        Some(other) => other.to_string(),
    }
}

/// Pull the market positions out of a GraphQL response.
///
/// Every level is optional in the Python (`(r.json().get("data") or {})...`), because the API
/// answers an unknown address with nulls rather than an error. An unparseable body yields an empty
/// list, not a failure.
pub fn parse_positions(body: &str) -> Vec<MarketPosition> {
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    let Some(entries) = json
        .get("data")
        .and_then(|data| data.get("userByAddress"))
        .and_then(|user| user.get("marketPositions"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    entries
        .iter()
        .map(|entry| {
            let state = entry.get("state");
            let market = entry.get("market");
            MarketPosition {
                health_factor: entry.get("healthFactor").and_then(Value::as_f64),
                liq_threshold: number_or_zero(market.and_then(|m| m.get("lltv"))) / WAD,
                collateral_symbol: symbol_of(market.and_then(|m| m.get("collateralAsset"))),
                loan_symbol: symbol_of(market.and_then(|m| m.get("loanAsset"))),
                collateral_usd: number_or_zero(state.and_then(|s| s.get("collateralUsd"))),
                debt_usd: number_or_zero(state.and_then(|s| s.get("borrowAssetsUsd"))),
            }
        })
        .collect()
}

/// Turn one market position into a portfolio position, or `None` if it should not be reported.
///
/// Both USD legs must clear [`MIN_USD`]; see the module docs for why a zero-collateral borrow is
/// dropped rather than trusted, and why supply-only positions belong to the ERC-4626 adapter.
pub fn borrow_position_from(position: &MarketPosition) -> Option<Position> {
    if position.debt_usd < MIN_USD || position.collateral_usd < MIN_USD {
        return None;
    }

    let health = LendingHealth {
        hf: position.health_factor,
        // Guarded even though the filter above already proved collateral is positive — the
        // Python guards it too, and a division by zero here would produce a NaN LTV on the wire.
        ltv: if position.collateral_usd > 0.0 {
            position.debt_usd / position.collateral_usd
        } else {
            0.0
        },
        liq_threshold: position.liq_threshold,
        collateral_usd: position.collateral_usd,
        debt_usd: position.debt_usd,
    };

    // The whole point: equity, not gross collateral.
    let equity = position.collateral_usd - position.debt_usd;

    let mut built = Position::new(
        PROTOCOL,
        CATEGORY,
        format!("Borrow · {}", position.pair()),
        Some(equity),
    );
    built.health = Some(health);
    Some(built)
}

/// Morpho Blue borrow positions for one wallet on one chain.
///
/// Returns an empty list rather than an error on every failure path — an unsupported chain, an
/// unreachable API, a malformed body. That matches `adapt_morpho`'s own try/except *and* the
/// `_safe` wrapper the registry applies (portfolio.py L1857): one adapter having a bad day must
/// never cost the chain its other positions.
pub async fn adapt_morpho(
    client: &reqwest::Client,
    cache: &HttpCache,
    chain: &str,
    owner: &str,
) -> Vec<Position> {
    let Some(chain_id) = chain_id(chain) else {
        return Vec::new();
    };

    let body = request_body(chain_id, owner);
    let recorded = match cache.post_json(client, MORPHO_API, &body).await {
        Ok(recorded) => recorded,
        Err(error) => {
            tracing::warn!(chain, error = format!("{error:#}"), "morpho api failed");
            return Vec::new();
        }
    };
    if !(200..300).contains(&recorded.status) {
        tracing::warn!(
            chain,
            status = recorded.status,
            "morpho api returned an error"
        );
        return Vec::new();
    }

    parse_positions(&recorded.body)
        .iter()
        .filter_map(borrow_position_from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_cache::{Mode, Recorded, cache_key};
    use std::path::Path;
    use tempfile::TempDir;

    const OWNER: &str = "0x1234567890abcdef1234567890abcdef12345678";

    /// A wallet with one WBTC/USDC borrow: $50k collateral against $20k of debt.
    const ONE_BORROW: &str = r#"{"data":{"userByAddress":{"marketPositions":[
        {"healthFactor":1.85,
         "market":{"lltv":"860000000000000000",
                   "loanAsset":{"symbol":"USDC"},
                   "collateralAsset":{"symbol":"WBTC"}},
         "state":{"collateralUsd":50000.0,"borrowAssetsUsd":20000.0}}]}}}"#;

    fn borrow(collateral: f64, debt: f64) -> MarketPosition {
        MarketPosition {
            health_factor: Some(1.85),
            liq_threshold: 0.86,
            collateral_symbol: "WBTC".into(),
            loan_symbol: "USDC".into(),
            collateral_usd: collateral,
            debt_usd: debt,
        }
    }

    /// Write a fixture for the exact request the adapter will make.
    fn seed(dir: &Path, chain: &str, body: &str, status: u16) {
        let request = request_body(chain_id(chain).unwrap(), OWNER);
        let key = cache_key("POST", MORPHO_API, Some(&request.to_string()));
        let recorded = Recorded {
            url: MORPHO_API.to_string(),
            method: "POST".into(),
            status,
            body: body.to_string(),
        };
        std::fs::write(
            dir.join(format!("{key}.json")),
            serde_json::to_string_pretty(&recorded).unwrap(),
        )
        .unwrap();
    }

    async fn run(dir: &Path, chain: &str) -> Vec<Position> {
        let cache = HttpCache::new(dir, Mode::Replay);
        adapt_morpho(&reqwest::Client::new(), &cache, chain, OWNER).await
    }

    // --- debt ---------------------------------------------------------------

    #[test]
    fn the_value_is_collateral_minus_debt() {
        // $50k of collateral against $20k borrowed is $30k of equity. Reporting the collateral
        // alone would overstate this wallet by the entire size of the loan.
        let position = borrow_position_from(&borrow(50_000.0, 20_000.0)).unwrap();
        assert_eq!(position.usd, Some(30_000.0));
    }

    #[test]
    fn the_debt_is_subtracted_not_added() {
        // Guards against a sign flip, which would read as +$70k instead of +$30k.
        let position = borrow_position_from(&borrow(50_000.0, 20_000.0)).unwrap();
        let usd = position.usd.unwrap();
        assert!(
            usd < 50_000.0,
            "equity must be below gross collateral: {usd}"
        );
        assert_eq!(usd, 50_000.0 - 20_000.0);
    }

    #[test]
    fn an_underwater_position_reports_negative_equity() {
        // Collateral has fallen below the loan. That is a real (bad) state and must not be clamped
        // to zero — the number is what tells the owner how bad it is.
        let position = borrow_position_from(&borrow(18_000.0, 20_000.0)).unwrap();
        assert_eq!(position.usd, Some(-2_000.0));
    }

    #[test]
    fn both_legs_survive_into_the_health_block() {
        // The alert rules read these; losing either would silently disarm the liquidation alarm.
        let position = borrow_position_from(&borrow(50_000.0, 20_000.0)).unwrap();
        let health = position.health.expect("health is present");

        assert_eq!(health.collateral_usd, 50_000.0);
        assert_eq!(health.debt_usd, 20_000.0);
        assert_eq!(health.hf, Some(1.85));
        assert_eq!(health.ltv, 0.4, "20k borrowed against 50k");
        assert_eq!(health.liq_threshold, 0.86);
    }

    #[test]
    fn a_position_the_api_cannot_score_still_reports_its_money() {
        // healthFactor is null often enough (fresh position, oracle hiccup) that it must not
        // disqualify the row.
        let mut raw = borrow(50_000.0, 20_000.0);
        raw.health_factor = None;
        let position = borrow_position_from(&raw).unwrap();
        assert_eq!(position.usd, Some(30_000.0));
        assert_eq!(position.health.unwrap().hf, None);
    }

    // --- the trust filter ---------------------------------------------------

    #[test]
    fn a_supply_only_position_is_left_to_the_vault_adapter() {
        // No debt: this is a MetaMorpho deposit, which adapt_erc4626 already reports. Returning it
        // here too would count the same deposit twice.
        assert!(borrow_position_from(&borrow(50_000.0, 0.0)).is_none());
    }

    #[test]
    fn a_borrow_with_unpriced_collateral_is_skipped_entirely() {
        // collateralUsd of 0 alongside real debt means the API has no price feed for the
        // collateral — not that the collateral is worthless. Trusting it would book a -$20k
        // liability that does not exist.
        assert!(borrow_position_from(&borrow(0.0, 20_000.0)).is_none());
    }

    #[test]
    fn dust_on_either_leg_is_ignored() {
        assert!(borrow_position_from(&borrow(50_000.0, 0.005)).is_none());
        assert!(borrow_position_from(&borrow(0.005, 20_000.0)).is_none());
        assert!(
            borrow_position_from(&borrow(MIN_USD, MIN_USD)).is_some(),
            "the boundary is inclusive"
        );
    }

    // --- parsing ------------------------------------------------------------

    #[test]
    fn a_real_shaped_response_parses() {
        let positions = parse_positions(ONE_BORROW);
        assert_eq!(positions.len(), 1);

        let position = &positions[0];
        assert_eq!(position.health_factor, Some(1.85));
        assert_eq!(position.collateral_usd, 50_000.0);
        assert_eq!(position.debt_usd, 20_000.0);
        assert_eq!(position.pair(), "WBTC/USDC");
        assert_eq!(
            position.liq_threshold, 0.86,
            "lltv arrives as a WAD-scaled string"
        );
    }

    #[test]
    fn the_lltv_is_unscaled_from_wad() {
        // 0.86e18 is 86%, not 860000000000000000%.
        let body = r#"{"data":{"userByAddress":{"marketPositions":[
            {"market":{"lltv":"945000000000000000"},"state":{}}]}}}"#;
        assert_eq!(parse_positions(body)[0].liq_threshold, 0.945);

        let numeric = r#"{"data":{"userByAddress":{"marketPositions":[
            {"market":{"lltv":770000000000000000},"state":{}}]}}}"#;
        assert_eq!(parse_positions(numeric)[0].liq_threshold, 0.77);
    }

    #[test]
    fn a_missing_lltv_is_zero_rather_than_an_error() {
        let body = r#"{"data":{"userByAddress":{"marketPositions":[{"market":{},"state":{}}]}}}"#;
        assert_eq!(parse_positions(body)[0].liq_threshold, 0.0);
    }

    #[test]
    fn an_unknown_wallet_yields_no_positions() {
        // The API answers a never-seen address with nulls, not an error.
        for body in [
            r#"{"data":{"userByAddress":null}}"#,
            r#"{"data":{}}"#,
            r#"{"data":{"userByAddress":{"marketPositions":[]}}}"#,
            r#"{"data":{"userByAddress":{"marketPositions":null}}}"#,
        ] {
            assert!(parse_positions(body).is_empty(), "{body}");
        }
    }

    #[test]
    fn a_graphql_error_body_yields_no_positions() {
        let body = r#"{"errors":[{"message":"chainId 999 is not supported"}],"data":null}"#;
        assert!(parse_positions(body).is_empty());
    }

    #[test]
    fn an_unparseable_body_yields_no_positions() {
        assert!(parse_positions("<html>502 Bad Gateway</html>").is_empty());
        assert!(parse_positions("").is_empty());
    }

    #[test]
    fn a_missing_asset_symbol_renders_the_way_python_renders_it() {
        // Two different spellings, both reachable, both preserved: an absent key is "?" while an
        // explicit null becomes the string "None" via Python's f-string.
        let missing = r#"{"data":{"userByAddress":{"marketPositions":[
            {"market":{"loanAsset":{},"collateralAsset":{}},"state":{}}]}}}"#;
        assert_eq!(parse_positions(missing)[0].pair(), "?/?");

        let null_symbol = r#"{"data":{"userByAddress":{"marketPositions":[
            {"market":{"loanAsset":{"symbol":null},"collateralAsset":{"symbol":null}},
             "state":{}}]}}}"#;
        assert_eq!(parse_positions(null_symbol)[0].pair(), "None/None");

        let absent_assets = r#"{"data":{"userByAddress":{"marketPositions":[
            {"market":{},"state":{}}]}}}"#;
        assert_eq!(parse_positions(absent_assets)[0].pair(), "?/?");
    }

    #[test]
    fn a_null_usd_leg_reads_as_zero_and_is_then_skipped() {
        let body = r#"{"data":{"userByAddress":{"marketPositions":[
            {"state":{"collateralUsd":null,"borrowAssetsUsd":20000.0},"market":{}}]}}}"#;
        let parsed = parse_positions(body);
        assert_eq!(parsed[0].collateral_usd, 0.0);
        assert!(borrow_position_from(&parsed[0]).is_none());
    }

    // --- the adapter --------------------------------------------------------

    #[tokio::test]
    async fn a_chain_without_morpho_makes_no_request() {
        // No fixtures exist, so a request would fail the replay — reaching the end proves the
        // chain check short-circuits first.
        let dir = TempDir::new().unwrap();
        for chain in ["hyperevm", "bsc", "avalanche", "bitcoin", "solana"] {
            assert!(chain_id(chain).is_none(), "{chain} should have no Morpho");
            let cache = HttpCache::new(dir.path(), Mode::Replay);
            assert!(
                adapt_morpho(&reqwest::Client::new(), &cache, chain, OWNER)
                    .await
                    .is_empty()
            );
        }
    }

    #[test]
    fn the_supported_chain_ids_match_the_python() {
        assert_eq!(chain_id("ethereum"), Some(1));
        assert_eq!(chain_id("base"), Some(8453));
        assert_eq!(chain_id("arbitrum"), Some(42161));
        assert_eq!(chain_id("optimism"), Some(10));
        assert_eq!(chain_id("polygon"), Some(137));
    }

    #[tokio::test]
    async fn the_adapter_reads_a_borrow_end_to_end() {
        let dir = TempDir::new().unwrap();
        seed(dir.path(), "base", ONE_BORROW, 200);

        let positions = run(dir.path(), "base").await;
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].protocol, "Morpho");
        assert_eq!(positions[0].category, "Borrowing");
        assert_eq!(positions[0].name, "Borrow · WBTC/USDC");
        assert_eq!(positions[0].usd, Some(30_000.0));
        assert_eq!(positions[0].health.as_ref().unwrap().debt_usd, 20_000.0);
    }

    #[tokio::test]
    async fn several_markets_are_reported_independently() {
        let dir = TempDir::new().unwrap();
        let body = r#"{"data":{"userByAddress":{"marketPositions":[
            {"healthFactor":1.85,
             "market":{"lltv":"860000000000000000","loanAsset":{"symbol":"USDC"},
                       "collateralAsset":{"symbol":"WBTC"}},
             "state":{"collateralUsd":50000.0,"borrowAssetsUsd":20000.0}},
            {"healthFactor":1.05,
             "market":{"lltv":"915000000000000000","loanAsset":{"symbol":"USDC"},
                       "collateralAsset":{"symbol":"wstETH"}},
             "state":{"collateralUsd":10000.0,"borrowAssetsUsd":8000.0}},
            {"healthFactor":null,
             "market":{"lltv":"860000000000000000","loanAsset":{"symbol":"USDC"},
                       "collateralAsset":{"symbol":"cbBTC"}},
             "state":{"collateralUsd":9000.0,"borrowAssetsUsd":0}}]}}}"#;
        seed(dir.path(), "base", body, 200);

        let positions = run(dir.path(), "base").await;
        assert_eq!(positions.len(), 2, "the supply-only market is not ours");
        assert_eq!(positions[0].usd, Some(30_000.0));
        assert_eq!(positions[1].usd, Some(2_000.0));
        assert_eq!(positions[1].name, "Borrow · wstETH/USDC");
        assert_eq!(positions[1].health.as_ref().unwrap().hf, Some(1.05));
    }

    #[tokio::test]
    async fn an_api_error_status_costs_the_chain_nothing() {
        // `_safe` semantics: a bad day at api.morpho.org must not take the rest of the chain down.
        let dir = TempDir::new().unwrap();
        seed(dir.path(), "base", r#"{"message":"rate limited"}"#, 429);
        assert!(run(dir.path(), "base").await.is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_api_costs_the_chain_nothing() {
        // No fixture at all: the replay cache errors, which the adapter swallows.
        let dir = TempDir::new().unwrap();
        assert!(run(dir.path(), "base").await.is_empty());
    }

    #[tokio::test]
    async fn a_wallet_with_no_morpho_activity_yields_nothing() {
        let dir = TempDir::new().unwrap();
        seed(
            dir.path(),
            "base",
            r#"{"data":{"userByAddress":null}}"#,
            200,
        );
        assert!(run(dir.path(), "base").await.is_empty());
    }

    #[test]
    fn the_request_names_the_chain_and_the_wallet() {
        let body = request_body(8453, OWNER);
        assert_eq!(body["variables"]["c"], 8453);
        assert_eq!(body["variables"]["a"], OWNER);
        assert!(
            body["query"].as_str().unwrap().contains("borrowAssetsUsd"),
            "the debt leg must be requested or it can never be reported"
        );
        assert!(body["query"].as_str().unwrap().contains("collateralUsd"));
        assert!(body["query"].as_str().unwrap().contains("healthFactor"));
    }
}
