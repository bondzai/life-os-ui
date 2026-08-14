//! The portfolio snapshot data model — the serde mirror of `portfolio.py`'s JSON.
//!
//! Every adapter in the Python oracle builds its DeFi entries through one factory,
//! `_position(...)` (portfolio.py ~L203), and the orchestrator wraps those in
//! `_chain_result` → `_wallet` → `build_portfolios`. This module is the Rust half of
//! that contract: serialising [`PortfolioSnapshot`] must produce byte-for-byte the same
//! *key set* as the Python dict, because the existing React front end
//! (`web/src/lib/types.ts`) reads it directly.
//!
//! # Absent is not null
//!
//! A key Python omits and a key Python writes as `null` are different bytes, and the front
//! end can tell them apart (`in_range?: boolean` vs `usd: number | null`), so the model must
//! too. Four cases, four spellings:
//!
//! | Python                              | Rust                                    | JSON       |
//! |-------------------------------------|-----------------------------------------|------------|
//! | key always written                  | `T`                                     | value      |
//! | key always written, value may be `None` | `Option<T>` (no `skip_serializing_if`) | value or `null` |
//! | key written only when not `None`    | `Option<T>` + `skip_serializing_if`     | value or *absent* |
//! | key written only sometimes, value may be `None` | [`Nullable<T>`]              | value, `null`, or *absent* |
//!
//! [`Nullable<T>`] is the awkward fourth case and it is not hypothetical: `_position`
//! writes `rewards_usd` *inside* the `if rewards is not None` branch, so
//! `rewards=[...] , rewards_usd=None` yields `{"rewards": [...], "rewards_usd": null}`
//! while `rewards=None, rewards_usd=1.0` yields **neither key**. A plain `Option<f64>`
//! cannot round-trip that.
//!
//! # Internal fields
//!
//! `_spot_addr` is **not** part of the serialised shape. `_position` stores it, but
//! `_evm_chain_portfolio` (~L1903) does `p.pop("_spot_addr", None)` for every position
//! during spot dedup *before* the chain result is built, so it can never reach the wire.
//! It is therefore modelled as a plain (non-serde) field, [`Position::spot_addr`], and
//! skipped on serialisation.
//!
//! `perf_key` **is** serialised (portfolio.py L1303) even though `types.ts` does not
//! declare it; `notify.py` L831 reads it back off the response. It stays.
//!
//! # Unknown keys
//!
//! Nothing here uses `deny_unknown_fields`: the Python side gains keys faster than the
//! port will, and a hard failure on an unmodelled key would blank the whole page. Keys
//! that are not modelled are dropped on a parse/re-emit round-trip — `tests/model_parity.rs`
//! asserts the corpus is fully covered so that stays a deliberate choice, not a silent one.

use serde::{Deserialize, Deserializer, Serialize};

use crate::market::{FearGreed, Rainbow, Rates};

/// A key that may be **absent**, present as `null`, or present with a value.
///
/// * `None` — key absent from the JSON object.
/// * `Some(None)` — key present, value `null`.
/// * `Some(Some(v))` — key present with value `v`.
///
/// Always pair it with `#[serde(default, skip_serializing_if = "Option::is_none",
/// deserialize_with = "nullable")]`.
pub type Nullable<T> = Option<Option<T>>;

/// Deserialiser for [`Nullable<T>`]: an explicit `null` must land on `Some(None)`, not
/// `None`, or a present-but-null key would vanish on re-serialisation.
pub fn nullable<'de, T, D>(de: D) -> Result<Nullable<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Option::<T>::deserialize(de).map(Some)
}

/// One token leg of a position: a `tokens[]` entry, or a `rewards[]` entry.
///
/// Mirrors `TokenAmt` in `types.ts`. `usd` is omitted by the adapters that only know an
/// amount (e.g. the ERC-4626 vault at portfolio.py L662, Hyperliquid perps at L2001).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct TokenAmt {
    pub symbol: String,
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
    /// Lending legs only (portfolio.py L1684): `"supply"` or `"borrow"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    /// Reward legs only: a wallet-level claim shown on every earning position.
    ///
    /// Declared by `types.ts` but **not currently emitted by any Python adapter**; kept
    /// so the front-end contract is representable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
    /// Reward legs only: claim id, deduped so a shared claim counts once. Same status as
    /// [`TokenAmt::shared`] — declared by `types.ts`, not emitted by Python today.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim: Option<String>,
}

/// The human price band of a concentrated-liquidity position (`_lp_range`, portfolio.py L585).
///
/// `lower`/`upper`/`cur` are `None` whenever the tick maths overflows to a non-finite
/// value — the Python `fin()` helper nulls them explicitly, so the keys are always present.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PriceBand {
    pub lower: Option<f64>,
    pub upper: Option<f64>,
    pub cur: Option<f64>,
    pub base: String,
    pub quote: String,
    pub full: bool,
}

/// How far price can move before the position leaves its range, as % of spot
/// (`_vfat_stamp_meta`, portfolio.py L1265).
///
/// `min`/`max` come straight from vfat's `guaranteedAprPricePercentRange` via `.get()`,
/// so either can be `null` while `width` is a number — the branch is only entered when
/// `widthPercent is not None`. `types.ts` declares all three as required `number`;
/// see the module docs in `tests/model_parity.rs` for that divergence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RangePct {
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub width: f64,
}

/// A borrow position's risk snapshot (Aave L1621, Avalon L1701, Compound L1788, Morpho L1841).
///
/// `hf` is `null` when there is no debt — Aave returns `u256::MAX` as the health factor
/// and the oracle maps that to `None`. `ltv` and `liq_threshold` are fractions (0.80 = 80%).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LendingHealth {
    pub hf: Option<f64>,
    pub ltv: f64,
    pub liq_threshold: f64,
    pub collateral_usd: f64,
    pub debt_usd: f64,
}

/// One coin in a spot trading bot's basket (kucoin.py L154).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BotWeight {
    pub symbol: String,
    pub amount: f64,
    pub usd: f64,
    pub pct: f64,
}

/// One futures sub-account inside an "AI Futures" bot group (kucoin.py L182).
///
/// `id` is `a.get("accountName") or a.get("subName") or a.get("accountId")` — the key is
/// always written and can be `null` when KuCoin returns none of the three.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubBot {
    pub id: Option<String>,
    pub usd: f64,
    pub pnl_usd: f64,
    pub pnl_pct: f64,
    pub margin: f64,
}

/// Trading-bot metadata attached to a KuCoin position (kucoin.py L162 / L191).
///
/// Spot bots carry `weights`; futures bots carry `count`, `margin_usd`, `margin_pct`, `bots`.
/// No producer emits both, so every field past `kind`/`status` is skip-if-absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BotInfo {
    pub kind: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weights: Option<Vec<BotWeight>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_pct: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bots: Option<Vec<SubBot>>,
}

/// A DeFi position — the output of `_position(...)` plus everything later stages stamp on it.
///
/// Field order below follows the Python insertion order so the emitted JSON reads the same.
/// Grouped by how the key gets there:
///
/// 1. **Always written by `_position`** — `protocol`, `category`, `name`, `id`, `via`,
///    `tokens`, `usd`. (`id` is the one exception: KuCoin builds its position dicts by
///    hand and omits the key entirely, hence [`Nullable`].)
/// 2. **Written by `_position` only when the argument is not `None`** — `in_range`,
///    `rewards`/`rewards_usd`, `change24h`, `health`.
/// 3. **Stamped afterwards** by `_lp_position`, `_vfat_api_position`, `_vfat_stamp_meta`,
///    `_vfat_stamp_lifecycle`, or built by hand by `kucoin.py`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Position {
    // ---- group 1: `_position` always writes these ----
    pub protocol: String,
    pub category: String,
    pub name: String,
    /// `_position` always writes it (`null` when there is no id); `kucoin.py` omits the
    /// key entirely. [`Nullable`] preserves both. Use [`Position::new`] to get the
    /// `_position` behaviour (`Some(None)`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub id: Nullable<String>,
    /// Always present, `null` when the position was not reached through a proxy/aggregator.
    pub via: Option<String>,
    /// Always present; `_position` substitutes `[]` for a `None` argument.
    pub tokens: Vec<TokenAmt>,
    /// Always present. `null` is legal (`types.ts`: `usd: number | null`) — a position
    /// whose value could not be computed still renders as a row.
    pub usd: Option<f64>,

    // ---- group 2: written only when the `_position` argument is not None ----
    /// Concentrated-liquidity only. Never `null`: the key exists iff the value is a bool.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_range: Option<bool>,
    /// Claimable yield. Never `null` when present, and always accompanied by
    /// [`Position::rewards_usd`] — the two keys are written by the same statement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewards: Option<Vec<TokenAmt>>,
    /// USD value of `rewards`. Present **iff** `rewards` is present, but may be `null`
    /// within that branch (an adapter that passes `rewards=` without `rewards_usd=`).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub rewards_usd: Nullable<f64>,
    /// 24h change, %. `_position` never writes it as `null`, but `kucoin.py` does
    /// (`_earn_holdings` L124 passes an unpriced currency's `None` straight through).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub change24h: Nullable<f64>,
    /// Lending/borrow risk. Never `null`: the key exists iff the value is an object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health: Option<LendingHealth>,

    // ---- group 3a: stamped by `_lp_position` / `_vfat_api_position` ----
    /// `"pool"` (swap-fee LP) or `"farm"` (earns reward tokens). vfat positions only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_type: Option<String>,
    /// Swap fees alone — `rewards_usd` also includes gauge + campaign rewards.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub swap_fees_usd: Option<f64>,
    /// Uniswap tick spacing; the front end renders it as `CL{spacing}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tick_spacing: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_band: Option<PriceBand>,

    // ---- group 3b: stamped by `_vfat_stamp_meta` ----
    /// vfat's computed yield (`farm.snapshot.apr`, else `lpApr`). Also set by KuCoin Earn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apr: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_pct: Option<RangePct>,

    // ---- group 3c: stamped by `_vfat_stamp_lifecycle` ----
    /// Stable key for the cron-tracked in-range accumulator. Written before the lifecycle
    /// fetch and read back by `notify.py`; **not** declared in `types.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub perf_key: Option<String>,
    /// ISO-8601 — first on-chain action. Sourced from `acts[0].get("blockTimestamp")`, so
    /// the key can be present with `null` when vfat returns an action without a timestamp.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub deployed_at: Nullable<String>,
    /// ISO-8601 — latest action. Same `.get()` nullability as [`Position::deployed_at`].
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub updated_at: Nullable<String>,
    /// e.g. `deposited` | `rebalanced` | `harvested`. Same `.get()` nullability.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub last_action: Nullable<String>,
    /// ISO-8601 — latest harvest, the anchor of the current fee cycle. Same nullability.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub last_harvest_at: Nullable<String>,
    /// Epoch seconds the current fee cycle began (last harvest, else deploy). `_iso_epoch`
    /// returns `None` on an unparseable timestamp, so present-and-`null` is reachable.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub cycle_start: Nullable<i64>,
    /// Real in-range seconds this cycle, sampled server-side. Read from a `NOT NULL`
    /// column, so never `null` when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_range_secs: Option<f64>,

    // ---- group 3d: KuCoin-only, built by hand in kucoin.py ----
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot: Option<BotInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pnl_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pnl_pct: Option<f64>,
    /// Risk bucket (`"cashflow"`, `"highrisk"`, …) — emitted by `kucoin.py` only, and
    /// **not** declared on `DefiPosition` in `types.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,

    // ---- internal: never serialised ----
    /// The spot-token address this position consumes, so the orchestrator can drop that
    /// token from the chain's `spot` list. `_evm_chain_portfolio` **pops** it before the
    /// chain result is built (portfolio.py L1903), so it is invisible on the wire.
    #[serde(skip)]
    pub spot_addr: Option<String>,
}

impl Position {
    /// The `_position(protocol, category, name, usd)` minimum: `id`/`via` written as
    /// `null`, `tokens` written as `[]`, every optional key absent.
    pub fn new(
        protocol: impl Into<String>,
        category: impl Into<String>,
        name: impl Into<String>,
        usd: Option<f64>,
    ) -> Self {
        Self {
            protocol: protocol.into(),
            category: category.into(),
            name: name.into(),
            id: Some(None),
            via: None,
            tokens: Vec::new(),
            usd,
            ..Default::default()
        }
    }

    /// Set `rewards` and `rewards_usd` together, the way `_position` does — writing one
    /// without the other is not a shape the oracle can produce.
    pub fn with_rewards(mut self, rewards: Vec<TokenAmt>, rewards_usd: Option<f64>) -> Self {
        self.rewards = Some(rewards);
        self.rewards_usd = Some(rewards_usd);
        self
    }
}

/// A spot token balance — one entry of a chain bucket's `spot[]`.
///
/// Emitted by six producers (EVM native/ERC-20, Bitcoin, Hyperliquid, Solana, KuCoin);
/// they agree on `symbol`/`amount`/`price`/`usd`/`kind` and disagree on the rest, which
/// is why `change24h`, `coin` and `address` are optional here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SpotToken {
    /// `tok.get("symbol")` on the Blockscout path (portfolio.py L319) — a priced token
    /// with no symbol yields `null`. `types.ts` declares this as a required `string`.
    pub symbol: Option<String>,
    pub amount: f64,
    /// Always present; `null` when no price source covered the token.
    pub price: Option<f64>,
    /// Always present. Non-null in practice — every producer filters on `usd > dust`.
    pub usd: Option<f64>,
    /// 24h change, %. Absent on the Hyperliquid path and for ERC-20s with no address;
    /// present-and-`null` when DefiLlama has no percentage for the key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub change24h: Nullable<f64>,
    /// DefiLlama price key (e.g. `coingecko:bitcoin`). Absent on the Bitcoin/Hyperliquid/
    /// KuCoin paths; `null` when the chain has no DefiLlama prefix configured.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "nullable"
    )]
    pub coin: Nullable<String>,
    /// Contract address / SPL mint. EVM ERC-20 and Solana SPL only; never `null`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// `"native"` or `"token"`. Every producer sets it; **not** declared in `types.ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Declared by `types.ts` (`SpotToken.category`) but never emitted by Python.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// One chain's slice of a wallet — `_chain_result` (portfolio.py L1866).
///
/// The oracle returns `None` instead of this struct when `usd < 0.01`, and `_wallet`
/// filters those out, so a bucket in the response always carries at least dust value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ChainBucket {
    pub chain: String,
    pub usd: f64,
    pub spot: Vec<SpotToken>,
    pub defi: Vec<Position>,
}

/// One wallet — `_wallet` (portfolio.py L2364), also the shape of `build_portfolio` and
/// `build_wallet`, and of the synthetic KuCoin "wallet" (`address: "KuCoin"`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Wallet {
    pub address: String,
    pub total: f64,
    /// Ordered by `_order_chains`, i.e. by the declaration order of `CHAINS`.
    pub chains: Vec<ChainBucket>,
}

impl Wallet {
    /// `_wallet(address, chains)`: total is the sum of the buckets' `usd`. Callers must
    /// have ordered/filtered `chains` already, as `_order_chains` does.
    pub fn new(address: impl Into<String>, chains: Vec<ChainBucket>) -> Self {
        Self {
            address: address.into(),
            total: chains.iter().map(|c| c.usd).sum(),
            chains,
        }
    }
}

/// The portfolio envelope's `sentiment` block — **exactly two keys**.
///
/// `build_portfolios` (portfolio.py L2413) writes
/// `{"fear_greed": …, "btc_rainbow": …}` inline. It is *not* the same object as
/// [`crate::market::Sentiment`], which is what `market_sentiment()` returns for the
/// standalone `/api/sentiment` endpoint (server.py L211) and which additionally carries
/// `mvrv_zscore`, `sopr`, `puell` and `fetched_at`. Serialising the richer type here would
/// add four keys the oracle never emits inside a portfolio response, so the two containers
/// stay separate; the leaf types ([`FearGreed`], [`Rainbow`]) are shared.
///
/// Both keys are always written; either value may be `null` — the fetch failed, or BTC had
/// no price to place on the curve.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PortfolioSentiment {
    pub fear_greed: Option<FearGreed>,
    pub btc_rainbow: Option<Rainbow>,
}

/// The top-level response — `build_portfolios` (portfolio.py L2378).
///
/// `types.ts`'s `PortfolioData` declares only `wallets`, `total`, `rates` and `fetched_at`;
/// `addresses` and `sentiment` are emitted by Python and simply undeclared front-end side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PortfolioSnapshot {
    /// The requested addresses, de-duplicated, order preserved. Note this does **not**
    /// include the synthetic `"KuCoin"` wallet, which is appended to `wallets` only.
    pub addresses: Vec<String>,
    pub total: f64,
    pub wallets: Vec<Wallet>,
    /// Always an object. `types.ts` types it `Rates | null`; the oracle has no code path
    /// that emits `null` here.
    pub rates: Rates,
    pub sentiment: PortfolioSentiment,
    /// `time.time()` — epoch **seconds, fractional**, not milliseconds.
    pub fetched_at: f64,
}

/// The oracle's own everything-timed-out response: no wallets, fallback rates, no sentiment.
impl Default for PortfolioSnapshot {
    fn default() -> Self {
        Self {
            addresses: Vec::new(),
            total: 0.0,
            wallets: Vec::new(),
            rates: fallback_rates(),
            sentiment: PortfolioSentiment::default(),
            fetched_at: 0.0,
        }
    }
}

/// `build_portfolios`' deadline fallback for [`Rates`] (portfolio.py L2404):
/// `{"usd": 1.0, "thb": None, "btc_usd": None}`. All three keys are always written, so
/// `thb`/`btc_usd` are nullable, not optional.
pub fn fallback_rates() -> Rates {
    Rates {
        usd: 1.0,
        thb: None,
        btc_usd: None,
    }
}

impl PortfolioSnapshot {
    /// `build_portfolios`' final assembly: total is the sum of the wallets' totals.
    pub fn new(
        addresses: Vec<String>,
        wallets: Vec<Wallet>,
        rates: Rates,
        sentiment: PortfolioSentiment,
        fetched_at: f64,
    ) -> Self {
        Self {
            addresses,
            total: wallets.iter().map(|w| w.total).sum(),
            wallets,
            rates,
            sentiment,
            fetched_at,
        }
    }
}
