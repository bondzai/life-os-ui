//! The live [`PortfolioSources`] — the wiring that turns this crate's readers into a portfolio.
//!
//! [`crate::aggregate`] describes *how* a snapshot is fanned out and assembled, but it reads
//! everything through a trait so it can be tested without a network. This module is the one
//! implementation of that trait which actually talks to chains, and the port of the Python's
//! `_chain_portfolio` (portfolio.py L2135) — the dispatcher that decides, per chain kind, what
//! "read this wallet" means.
//!
//! # The four chain kinds
//!
//! | Kind | Path |
//! |---|---|
//! | [`ChainKind::Evm`] | spot balances + Sickle resolution, then the adapter registry |
//! | [`ChainKind::Btc`] | [`crate::bitcoin::btc_chain_portfolio`] |
//! | [`ChainKind::Solana`] | [`crate::solana::solana_chain_portfolio`] |
//! | [`ChainKind::Hypercore`] | [`crate::hyperliquid::hypercore_portfolio`] |
//!
//! Only the EVM path has adapters; the other three read one API and shape the answer directly.
//!
//! # Registry order is load-bearing
//!
//! [`ADAPTER_ORDER`] mirrors `ADAPTERS` at portfolio.py L1849. The order decides which adapter
//! claims a position when two of them can see the same one, so it is asserted in a test rather
//! than left to the reader to keep in step.
//!
//! All ten are present. Three of them account for money in visibly different ways, which is the
//! part to keep straight when reading a total:
//!
//! * [`aave`] contributes **`−debt`**, because its aTokens sit in the wallet and spot has already
//!   valued the collateral;
//! * [`avalon`] and [`compound`] contribute the **full net equity**, because their collateral is
//!   invisible to spot — Avalon's aTokens are BTC derivatives no price feed covers, and Comet
//!   holds collateral inside the contract.
//!
//! Getting either convention backwards silently double-counts or deletes collateral, so each of
//! those modules states its own at the top and pins it in a test.
//!
//! [`vfat::enrich`] then runs after the registry on every non-`vfat_api` chain, exactly where the
//! Python calls `_vfat_enrich`: it stamps vfat's APR and range onto the LPs the RPC pass already
//! read, and appends the farms that pass cannot see at all — a gauge-staked Aerodrome NFT has left
//! the wallet, so no `balanceOf` enumeration will ever find it. It runs **before** the totals are
//! summed, because it adds value rather than only decorating it.
//!
//! ## The decorations, all ported
//!
//! `_vfat_stamp_lifecycle` — [`vfat::stamp_lifecycle_all`] runs at the tail of both
//! [`vfat::enrich`] and [`vfat::adapt_vfat_api`], as it does in the Python. Its `in_range_secs`
//! half is not here: it reads the `pos_perf` table, and this crate holds no database handle, so
//! the caller joins it on afterwards with [`vfat::apply_perf`].
//!
//! `_attach_campaign_rewards` / `_merkl_rewards` — [`vfat::attach_campaign_rewards`], covering
//! both halves: exact per-position Merkl rewards (attributed through the `reason` field's
//! `<PROTOCOL>_<pool>_<tokenId>` tail) and the Nest claim, split across the positions that earned
//! it by live emission rate. Neither changes a position's `usd` — they are *claimable* yield — so
//! what they fix is an understated harvest figure rather than net worth.
//!
//! Note the two run over **different pair sets** in [`vfat::enrich`]: lifecycle covers every
//! matched position, campaign rewards only the farms that pass appended. An RPC-read position
//! already carries its rewards from the adapter that read it, and adding Merkl on top would
//! double-count.
//!
//! # Errors, and the distinction worth keeping
//!
//! [`PortfolioSources::chain_portfolio`] returns `Ok(None)` for "read fine, nothing above dust"
//! and `Err` for "the read failed". The Python conflates the two — `_chain_portfolio` swallows
//! its exception and returns `None` either way — and this port refuses to inherit that, because
//! "you hold nothing on Base" and "we could not reach Base" must not render identically.
//!
//! Adapter-level failures are the exception: [`run_adapters`] already logs each one and drops
//! only that protocol, so they reach the operator through the log rather than through the return
//! value. The trait has no channel to report them per chain, which means a wallet whose Morpho
//! read failed looks like a wallet with no Morpho position in the response body.

use std::sync::Arc;

use anyhow::Result;

use crate::adapters::{
    aave, aero_cl, avalon, compound, erc4626, morpho, sickle_rpc, univ3, univ4, vfat,
};
use crate::aggregate::{
    Adapter, AdapterCtx, AdapterFuture, PortfolioSources, assemble_chain, run_adapters,
};
use crate::chains::{Chain, ChainKind};
use crate::evm::HttpRpc;
use crate::http_cache::HttpCache;
use crate::kucoin::{self, Credentials, KucoinClient};
use crate::market::{FearGreed, Market, Rates};
use crate::model::{
    BotInfo, BotWeight, ChainBucket, Position, SpotToken, SubBot, TokenAmt, Wallet,
};
use crate::prices::Prices;
use crate::spot::{DEFAULT_DUST_USD, Spot};
use crate::{bitcoin, hyperliquid, solana};

/// The adapter registry, in the Python's order (portfolio.py L1849).
///
/// `None` would mark a slot whose adapter is not ported. There are none left, but the shape is
/// kept: closing a hole up rather than marking it is how a ten-entry registry quietly becomes a
/// seven-entry one that still looks complete.
pub const ADAPTER_ORDER: [Option<&str>; 10] = [
    Some("adapt_erc4626"),
    Some("adapt_univ3"),
    Some("adapt_univ4"),
    Some("adapt_aero_cl"),
    Some("adapt_vfat_api"),
    Some("adapt_sickle_rpc"),
    Some("adapt_aave"),
    Some("adapt_avalon"),
    Some("adapt_compound"),
    Some("adapt_morpho"),
];

// ===========================================================================================
// Shared upstreams
// ===========================================================================================

/// What every EVM adapter needs to reach a chain and price what it finds.
///
/// Cloning this is cheap — a `reqwest::Client` is an `Arc` internally, [`HttpCache`] is a path
/// plus a mode, and the two caches are behind `Arc`s — which is what lets each adapter hold its
/// own copy rather than borrowing from [`LiveSources`].
#[derive(Clone)]
struct Upstreams {
    client: reqwest::Client,
    cache: HttpCache,
    prices: Arc<Prices>,
    vfat: Arc<vfat::VfatApi>,
    /// Holds the 60s per-(chain, owner) cache for the registry's slowest adapter.
    sickle: Arc<sickle_rpc::Scanner>,
}

impl Upstreams {
    /// A JSON-RPC client for one chain.
    ///
    /// Built per adapter call rather than once per chain because [`Adapter`] deliberately carries
    /// no transport — the trait's whole point is that a stub adapter needs no network. The cost is
    /// a string clone and two `Arc` bumps, against an adapter that is about to make RPC calls.
    fn rpc(&self, chain: &Chain) -> Result<HttpRpc> {
        HttpRpc::for_chain(self.client.clone(), self.cache.clone(), chain)
    }
}

// ===========================================================================================
// The adapter shims
// ===========================================================================================
//
// Each of these adapts one reader to the `Adapter` trait. They exist because the readers were
// written to their protocol's shape — some take owners, some take one address, some need the
// chain's spot list, some return `Result` and some cannot fail — while the registry needs one
// uniform signature. Putting the reconciliation here keeps it out of the readers, which are the
// parity-gated code, and out of `aggregate`, which must stay network-free.

/// `adapt_erc4626` — every held ERC-20 checked for being a vault share.
struct Erc4626(Upstreams);

impl Adapter for Erc4626 {
    fn name(&self) -> &'static str {
        "adapt_erc4626"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(
                erc4626::adapt_erc4626(&rpc, &self.0.prices, ctx.chain, &ctx.owner, &ctx.spot)
                    .await,
            )
        })
    }
}

/// `adapt_univ3` — Uniswap v3 LPs held by the wallet or its Sickle.
struct UniV3(Upstreams);

impl Adapter for UniV3 {
    fn name(&self) -> &'static str {
        "adapt_univ3"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            univ3::adapt_univ3(&rpc, self.0.prices.as_ref(), ctx.chain, &ctx.owners).await
        })
    }
}

/// `adapt_univ4` — Uniswap v4 LPs, with token ids discovered through Blockscout.
struct UniV4(Upstreams);

impl Adapter for UniV4 {
    fn name(&self) -> &'static str {
        "adapt_univ4"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(univ4::adapt_univ4(
                &rpc,
                &self.0.client,
                &self.0.cache,
                self.0.prices.as_ref(),
                ctx.chain,
                &ctx.owners,
            )
            .await)
        })
    }
}

/// `adapt_aero_cl` — Aerodrome/Velodrome Slipstream LPs.
struct AeroCl(Upstreams);

impl Adapter for AeroCl {
    fn name(&self) -> &'static str {
        "adapt_aero_cl"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            // `aero_cl::Owner` borrows, so the pairs are re-borrowed here rather than cloned.
            let owners: Vec<aero_cl::Owner<'_>> = ctx
                .owners
                .iter()
                .map(|(address, via)| aero_cl::Owner {
                    address,
                    via: via.as_deref(),
                })
                .collect();
            aero_cl::positions(&rpc, self.0.prices.as_ref(), ctx.chain, &owners).await
        })
    }
}

/// `adapt_vfat_api` — LPs read from vfat's indexer, for the chains whose explorers index neither
/// the Sickle-held NFTs nor their transactions.
struct VfatApiAdapter(Upstreams);

impl Adapter for VfatApiAdapter {
    fn name(&self) -> &'static str {
        "adapt_vfat_api"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        // No RPC: this adapter's whole point is that the chain cannot answer the question.
        Box::pin(vfat::adapt_vfat_api(
            Arc::clone(&self.0.vfat),
            ctx.chain,
            &ctx.owner,
        ))
    }
}

/// `adapt_sickle_rpc` — on-chain Sickle LP NFTs the vfat feed omitted.
struct SickleRpc(Upstreams);

impl Adapter for SickleRpc {
    fn name(&self) -> &'static str {
        "adapt_sickle_rpc"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            // The chain gate lives inside `scan`, but building an RPC client for a chain that is
            // not flagged `sickle_rpc` would error on the chains that have no endpoint at all.
            if !ctx.chain.sickle_rpc {
                return Ok(Vec::new());
            }
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(self
                .0
                .sickle
                .scan(
                    &rpc,
                    self.0.prices.as_ref(),
                    &self.0.vfat,
                    ctx.chain,
                    &ctx.owners,
                    &ctx.owner,
                    // The same clock the price caches use, so a test can move both together.
                    self.0.prices.now(),
                )
                .await)
        })
    }
}

/// `adapt_aave` — Aave v3 borrow health. Contributes `−debt`; the collateral is already in spot.
struct Aave(Upstreams);

impl Adapter for Aave {
    fn name(&self) -> &'static str {
        "adapt_aave"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(aave::position(&rpc, ctx.chain, &ctx.owner)
                .await?
                .into_iter()
                .collect())
        })
    }
}

/// `adapt_avalon` — Avalon Finance supply/borrow. Contributes the full net equity.
struct Avalon(Upstreams);

impl Adapter for Avalon {
    fn name(&self) -> &'static str {
        "adapt_avalon"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(
                avalon::position(&rpc, self.0.prices.as_ref(), ctx.chain, &ctx.owner)
                    .await?
                    .into_iter()
                    .collect(),
            )
        })
    }
}

/// `adapt_compound` — Compound v3 (Comet) supply and borrow positions.
struct Compound(Upstreams);

impl Adapter for Compound {
    fn name(&self) -> &'static str {
        "adapt_compound"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            let rpc = self.0.rpc(ctx.chain)?;
            Ok(compound::positions(&rpc, ctx.chain.name, &ctx.owner).await)
        })
    }
}

/// `adapt_morpho` — Morpho Blue borrow positions, read from Morpho's API rather than the chain.
struct Morpho(Upstreams);

impl Adapter for Morpho {
    fn name(&self) -> &'static str {
        "adapt_morpho"
    }

    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
        Box::pin(async move {
            Ok(
                morpho::adapt_morpho(&self.0.client, &self.0.cache, ctx.chain.name, &ctx.owner)
                    .await,
            )
        })
    }
}

// ===========================================================================================
// The live sources
// ===========================================================================================

/// Everything the fan-out reads from, wired to real upstreams.
///
/// Built once for the process. The caches inside [`Prices`], [`Spot`], [`Market`] and
/// [`vfat::VfatApi`] are the reason: rebuilding this per request would throw away every TTL
/// window and turn each page load into a fresh round of upstream calls.
pub struct LiveSources {
    upstreams: Upstreams,
    spot: Spot,
    market: Market,
    /// `None` when KuCoin is not configured, which is a normal install, not a failure.
    kucoin: Option<Credentials>,
    dust_usd: f64,
    adapters: Vec<Arc<dyn Adapter>>,
    adapter_concurrency: usize,
}

impl std::fmt::Debug for LiveSources {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Written out rather than derived so that adding a field cannot start printing a
        // credential: `Credentials` is Debug-safe, but nothing here should depend on that.
        f.debug_struct("LiveSources")
            .field("adapters", &self.adapters.len())
            .field("kucoin_configured", &self.kucoin.is_some())
            .field("dust_usd", &self.dust_usd)
            .finish_non_exhaustive()
    }
}

impl LiveSources {
    /// Wire the readers to a client and a record/replay cache.
    ///
    /// `adapter_concurrency` should come from [`crate::aggregate::AggregateConfig`], so the
    /// process honours one `ADAPTER_CONCURRENCY` rather than two that can disagree.
    #[must_use]
    pub fn new(client: reqwest::Client, cache: HttpCache, adapter_concurrency: usize) -> Self {
        let prices = Arc::new(Prices::new(client.clone(), cache.clone()));
        let upstreams = Upstreams {
            vfat: Arc::new(vfat::VfatApi::new(client.clone(), cache.clone())),
            sickle: Arc::new(sickle_rpc::Scanner::new()),
            prices: Arc::clone(&prices),
            client: client.clone(),
            cache: cache.clone(),
        };

        Self {
            spot: Spot::new(Arc::clone(&prices)),
            market: Market::new(client, cache),
            // Read once at construction: a credential appearing in the environment mid-process is
            // not a case worth supporting, and re-reading per request would mean a spawned
            // subprocess could change what the portfolio contains.
            kucoin: Credentials::from_env(),
            dust_usd: DEFAULT_DUST_USD,
            adapters: registry(&upstreams),
            adapter_concurrency,
            upstreams,
        }
    }

    /// Override the dust cut-off, below which a spot token is dropped.
    #[must_use]
    pub fn with_dust_usd(mut self, dust_usd: f64) -> Self {
        self.dust_usd = dust_usd;
        self
    }

    /// The shared price cache, so a caller that also needs prices does not build a second one.
    #[must_use]
    pub fn prices(&self) -> &Arc<Prices> {
        &self.upstreams.prices
    }

    /// The shared market-metric cache.
    #[must_use]
    pub fn market(&self) -> &Market {
        &self.market
    }

    /// The shared vfat client, which the yield radar reads through as well.
    #[must_use]
    pub fn vfat(&self) -> &Arc<vfat::VfatApi> {
        &self.upstreams.vfat
    }

    /// The EVM path — port of `_evm_chain_portfolio` (portfolio.py L1872).
    ///
    /// Spot balances and the Sickle lookup run concurrently, as the Python's two-worker pool does:
    /// spot is needed before the vault check and the Sickle before the LP adapters, so neither can
    /// start the adapters alone and running them in sequence would add a round trip per chain.
    ///
    /// A failure to read spot fails the chain. That is deliberate: spot is not one protocol among
    /// several, it is the wallet's actual balances, and a chain reporting only its DeFi positions
    /// would understate itself while looking perfectly well-formed.
    async fn evm_chain_portfolio(
        &self,
        chain: &'static Chain,
        address: &str,
    ) -> Result<Option<ChainBucket>> {
        let rpc = self.upstreams.rpc(chain)?;
        let factory = vfat::factory_for(chain);

        let (spot, sickle) = tokio::join!(
            self.spot.get_spot(chain, address, self.dust_usd),
            vfat::vfat_sickle(&rpc, address, factory),
        );
        // `Spot` reads into the reduced shape; the adapters and `assemble_chain` speak the
        // canonical one. See the bridge below for why they still differ.
        let spot: Vec<SpotToken> = spot?.into_iter().map(spot_from).collect();

        // The Sickle is already resolved, so it is passed in rather than looked up again — the
        // `sickle=` parameter exists for exactly this, and `""` is the Python's falsy sentinel
        // meaning "there is none", which appends no proxy owner.
        let owners = vfat::resolve_owners(
            &rpc,
            address,
            factory,
            Some(sickle.as_deref().unwrap_or("")),
        )
        .await;

        let ctx = Arc::new(AdapterCtx {
            chain,
            owner: address.to_string(),
            owners: owners
                .into_iter()
                .map(|owner| (owner.address, owner.via.map(str::to_string)))
                .collect(),
            spot: spot.clone(),
        });

        // Failures are logged inside `run_adapters` and cost only their own protocol.
        let (mut defi, _failures) =
            run_adapters(&self.adapters, ctx, self.adapter_concurrency).await;

        // The vfat reconciliation, in the Python's position: after the adapters, before the
        // totals. It adds gauge-staked farms no RPC pass can see, so it must run before
        // `assemble_chain` sums — and it is wrapped like an adapter rather than propagating,
        // because a vfat outage must not cost the chain its RPC-read positions.
        if let Err(e) =
            vfat::enrich(Arc::clone(&self.upstreams.vfat), chain, address, &mut defi).await
        {
            tracing::warn!(
                chain = chain.name,
                error = format!("{e:#}"),
                "(vfat enrich skipped)"
            );
        }

        Ok(assemble_chain(chain.name, spot, defi))
    }
}

/// The registry, built in [`ADAPTER_ORDER`]'s order.
fn registry(upstreams: &Upstreams) -> Vec<Arc<dyn Adapter>> {
    vec![
        Arc::new(Erc4626(upstreams.clone())),
        Arc::new(UniV3(upstreams.clone())),
        Arc::new(UniV4(upstreams.clone())),
        Arc::new(AeroCl(upstreams.clone())),
        Arc::new(VfatApiAdapter(upstreams.clone())),
        Arc::new(SickleRpc(upstreams.clone())),
        Arc::new(Aave(upstreams.clone())),
        Arc::new(Avalon(upstreams.clone())),
        Arc::new(Compound(upstreams.clone())),
        Arc::new(Morpho(upstreams.clone())),
    ]
}

impl PortfolioSources for LiveSources {
    async fn chain_portfolio(
        &self,
        chain: &'static Chain,
        address: String,
    ) -> Result<Option<ChainBucket>> {
        let client = &self.upstreams.client;
        let cache = &self.upstreams.cache;
        match chain.kind {
            ChainKind::Evm => self.evm_chain_portfolio(chain, &address).await,
            ChainKind::Btc => bitcoin::btc_chain_portfolio(client, cache, chain.name, &address)
                .await
                .map(|found| found.map(bucket_from)),
            ChainKind::Solana => {
                solana::solana_chain_portfolio(client, cache, chain.name, &address)
                    .await
                    .map(|found| found.map(bucket_from))
            }
            ChainKind::Hypercore => {
                hyperliquid::hypercore_portfolio(client, cache, chain.name, &address)
                    .await
                    .map(|found| found.map(bucket_from))
            }
        }
    }

    async fn rates(&self) -> Result<Rates> {
        Ok(self.market.get_rates().await)
    }

    async fn fear_greed(&self) -> Result<Option<FearGreed>> {
        Ok(self.market.fear_greed().await)
    }

    async fn kucoin_wallet(&self) -> Result<Option<Wallet>> {
        let Some(credentials) = self.kucoin.clone() else {
            return Ok(None); // not configured
        };
        let client = KucoinClient::new(credentials, &self.upstreams.client, &self.upstreams.cache);
        Ok(client.balances().await.map(kucoin_wallet))
    }
}

// ===========================================================================================
// Bridging the readers' shapes
// ===========================================================================================
//
// Three sets of portfolio types exist in this crate, because the modules were written in
// parallel against the same Python dicts:
//
// * `model::*` — the canonical set, deliberately the **union** of every producer. Its field list
//   carries a "KuCoin-only" group and a `spot_addr` the EVM orchestrator pops, which is what
//   makes it the union rather than one more variant. `aggregate` and every DeFi adapter use it.
// * `bitcoin::{SpotToken, Position, PositionToken, ChainPortfolio}` — a reduced set, used by
//   `spot.rs`, `solana.rs` and `hyperliquid.rs` as well as `bitcoin.rs` itself. Its own note asks
//   for it to be hoisted "when wiring `lib.rs`", which is this module.
// * `kucoin::{SpotHolding, DefiToken, DefiPosition, Bot, ChainBucket, Wallet}` — a third set,
//   richer than the reduced one (bots, PnL, tier) and a subset of the canonical one.
//
// They are converted here rather than unified in place. The reduced and KuCoin types are what
// those modules' parity tests are written against, so collapsing them would mean editing
// parity-verified code as part of a wiring change — the two should not land together. Unifying
// them afterwards, with parity green and able to say so, is the safer order.
//
// Every conversion below is lossless: each source field has a destination, checked by the tests
// at the bottom. What the conversions are actually deciding is *key presence*, not values — the
// narrower types skip a `None` field on serialize, while the canonical one distinguishes "key
// absent" (`None`) from "key present and null" (`Some(None)`).

/// One reduced spot token, widened to the canonical shape.
fn spot_from(token: bitcoin::SpotToken) -> SpotToken {
    SpotToken {
        symbol: Some(token.symbol),
        amount: token.amount,
        price: Some(token.price),
        usd: Some(token.usd),
        // Absent, not null: the reduced type skips the key when it has no change, and so does
        // the Python on these paths.
        change24h: token.change24h.map(Some),
        coin: token.coin.map(Some),
        address: token.address,
        kind: Some(token.kind.to_string()),
        // Declared by `types.ts`, never emitted by Python on any path.
        category: None,
    }
}

/// One reduced position, widened to the canonical shape.
///
/// `id` and `via` are written as `null` rather than omitted, because that is what the reduced
/// type's serializer does — neither carries `skip_serializing_if` — and `_position` writes both
/// unconditionally too.
fn position_from(position: bitcoin::Position) -> Position {
    Position {
        protocol: position.protocol,
        category: position.category,
        name: position.name,
        id: Some(position.id),
        via: position.via,
        tokens: position
            .tokens
            .into_iter()
            .map(|token| TokenAmt {
                symbol: token.symbol,
                amount: token.amount,
                // The reduced `PositionToken` is amount-only: these legs carry no valuation, and
                // `Some(0.0)` would be a claim the reader never made.
                ..TokenAmt::default()
            })
            .collect(),
        usd: Some(position.usd),
        change24h: position.change24h.map(Some),
        ..Position::default()
    }
}

/// A whole non-EVM chain result, widened to the canonical bucket.
fn bucket_from(portfolio: bitcoin::ChainPortfolio) -> ChainBucket {
    ChainBucket {
        chain: portfolio.chain,
        usd: portfolio.usd,
        spot: portfolio.spot.into_iter().map(spot_from).collect(),
        defi: portfolio.defi.into_iter().map(position_from).collect(),
    }
}

// ---- KuCoin ----------------------------------------------------------------------------

/// One KuCoin spot holding, widened.
///
/// `change24h` is a plain `f64` on the KuCoin path — `kucoin.py` always computes one — so it
/// widens to present-and-known rather than to an absent key.
fn kucoin_spot(holding: kucoin::SpotHolding) -> SpotToken {
    SpotToken {
        symbol: Some(holding.symbol),
        amount: holding.amount,
        price: Some(holding.price),
        usd: Some(holding.usd),
        change24h: Some(Some(holding.change24h)),
        // No DefiLlama key and no contract: a KuCoin balance is an exchange ledger entry.
        coin: None,
        address: None,
        kind: Some(holding.kind.to_string()),
        category: None,
    }
}

/// One token line inside a KuCoin position.
fn kucoin_token(token: kucoin::DefiToken) -> TokenAmt {
    TokenAmt {
        symbol: token.symbol,
        amount: token.amount,
        // Already `Option`: spot-bot baskets emit symbol+amount only.
        usd: token.usd,
        ..TokenAmt::default()
    }
}

/// Trading-bot metadata, widened.
fn kucoin_bot(bot: kucoin::Bot) -> BotInfo {
    BotInfo {
        kind: bot.kind,
        status: bot.status,
        // `usize` upstream, `i64` in the canonical type — a bot count cannot approach either
        // bound, so the cast is total in practice and saturating rather than wrapping in
        // principle.
        count: bot
            .count
            .map(|count| i64::try_from(count).unwrap_or(i64::MAX)),
        weights: bot.weights.map(|weights| {
            weights
                .into_iter()
                .map(|weight| BotWeight {
                    symbol: weight.symbol,
                    amount: weight.amount,
                    usd: weight.usd,
                    pct: weight.pct,
                })
                .collect()
        }),
        margin_usd: bot.margin_usd,
        // `i64` upstream, `f64` canonically: `margin_pct` is a percentage the Python computes as
        // a float and KuCoin's own rounding already happened, so widening cannot lose precision.
        margin_pct: bot.margin_pct.map(|pct| pct as f64),
        bots: bot.bots.map(|bots| {
            bots.into_iter()
                .map(|sub| SubBot {
                    id: sub.id,
                    usd: sub.usd,
                    pnl_usd: sub.pnl_usd,
                    pnl_pct: sub.pnl_pct,
                    margin: sub.margin,
                })
                .collect()
        }),
    }
}

/// One KuCoin yield/bot position, widened.
///
/// `id` stays **absent** rather than null: `kucoin.py` builds its position dicts by hand and
/// omits the key entirely, which is the case [`Nullable`] exists to keep distinct from the
/// `_position` path's explicit null.
fn kucoin_position(position: kucoin::DefiPosition) -> Position {
    Position {
        protocol: position.protocol,
        category: position.category,
        name: position.name,
        id: None,
        via: position.via,
        tokens: position.tokens.into_iter().map(kucoin_token).collect(),
        usd: Some(position.usd),
        change24h: position.change24h.map(Some),
        apr: position.apr,
        bot: position.bot.map(kucoin_bot),
        pnl_usd: position.pnl_usd,
        pnl_pct: position.pnl_pct,
        tier: Some(position.tier.to_string()),
        ..Position::default()
    }
}

/// The KuCoin account, shaped as a wallet like any other address.
fn kucoin_wallet(wallet: kucoin::Wallet) -> Wallet {
    Wallet {
        address: wallet.address.to_string(),
        // Carried over rather than recomputed: `Wallet::new` would re-sum the buckets, and the
        // KuCoin total is the exchange's own, which is the number that must survive.
        total: wallet.total,
        chains: wallet
            .chains
            .into_iter()
            .map(|bucket| ChainBucket {
                chain: bucket.chain.to_string(),
                usd: bucket.usd,
                spot: bucket.spot.into_iter().map(kucoin_spot).collect(),
                defi: bucket.defi.into_iter().map(kucoin_position).collect(),
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_cache::Mode;
    use tempfile::TempDir;

    fn sources() -> LiveSources {
        // `Mode::Replay` with an empty fixture directory: every upstream call misses, which is
        // what keeps these tests off the network.
        let dir = TempDir::new().unwrap();
        LiveSources::new(
            reqwest::Client::new(),
            HttpCache::new(dir.path(), Mode::Replay),
            4,
        )
    }

    #[test]
    fn the_registry_follows_the_pythons_order() {
        let live = sources();
        let names: Vec<&str> = live.adapters.iter().map(|a| a.name()).collect();
        let expected: Vec<&str> = ADAPTER_ORDER.iter().flatten().copied().collect();
        assert_eq!(
            names, expected,
            "registry order decides which adapter claims a position when two can see it"
        );
    }

    #[test]
    fn every_slot_in_the_pythons_registry_is_filled() {
        assert_eq!(
            ADAPTER_ORDER.len(),
            10,
            "the Python registry has ten entries (portfolio.py:1849)"
        );
        let missing: Vec<usize> = ADAPTER_ORDER
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.is_none())
            .map(|(i, _)| i)
            .collect();
        assert!(
            missing.is_empty(),
            "unported adapters remain at registry slots {missing:?}"
        );
        assert_eq!(sources().adapters.len(), 10);
    }

    #[test]
    fn kucoin_is_absent_rather_than_failing_when_unconfigured() {
        // An install with no exchange connected is normal, not broken.
        let live = sources();
        if std::env::var("KUCOIN_API_KEY").is_err() {
            assert!(live.kucoin.is_none());
        }
    }

    #[tokio::test]
    async fn a_chain_with_no_rpc_fails_rather_than_reporting_an_empty_wallet() {
        // Bitcoin has no EVM endpoint, so routing it down the EVM path must error. It never
        // happens in practice — `chains_for_address` pairs a `bc1…` wallet only with Bitcoin —
        // but "no RPC configured" reading as "you hold nothing" is the exact conflation this
        // module refuses.
        let live = sources();
        let bitcoin = crate::chains::by_name("bitcoin").unwrap();
        let error = live
            .evm_chain_portfolio(bitcoin, "0x1111111111111111111111111111111111111111")
            .await
            .expect_err("bitcoin has no EVM RPC");
        assert!(format!("{error:#}").contains("no EVM RPC endpoint"));
    }

    // ---- the shape bridge -------------------------------------------------

    #[test]
    fn a_widened_spot_token_keeps_absent_keys_absent() {
        let token = bitcoin::SpotToken {
            symbol: "BTC".into(),
            amount: 0.5,
            price: 60_000.0,
            usd: 30_000.0,
            change24h: None,
            kind: "native",
            coin: None,
            address: None,
        };
        let widened = spot_from(token);

        assert_eq!(widened.symbol.as_deref(), Some("BTC"));
        assert_eq!(widened.usd, Some(30_000.0));
        assert_eq!(widened.kind.as_deref(), Some("native"));
        assert_eq!(
            widened.change24h, None,
            "the Bitcoin path omits change24h; it must not become an explicit null"
        );
        assert_eq!(widened.coin, None);

        let json = serde_json::to_value(&widened).unwrap();
        assert!(!json.as_object().unwrap().contains_key("change24h"));
        assert!(!json.as_object().unwrap().contains_key("coin"));
    }

    #[test]
    fn a_widened_spot_token_keeps_a_known_change_present() {
        let token = bitcoin::SpotToken {
            symbol: "SOL".into(),
            amount: 3.0,
            price: 150.0,
            usd: 450.0,
            change24h: Some(-2.5),
            kind: "native",
            coin: Some("coingecko:solana".into()),
            address: None,
        };
        let widened = spot_from(token);

        assert_eq!(widened.change24h, Some(Some(-2.5)));
        assert_eq!(widened.coin, Some(Some("coingecko:solana".into())));
    }

    #[test]
    fn a_widened_position_writes_id_and_via_as_null_not_absent() {
        let position = bitcoin::Position::new(
            "Hyperliquid",
            "Perps",
            "Account value",
            1_234.0,
            vec![bitcoin::PositionToken {
                symbol: "USDC".into(),
                amount: 1_234.0,
            }],
            None,
        );
        let widened = position_from(position);

        assert_eq!(
            widened.id,
            Some(None),
            "`_position` writes id unconditionally"
        );
        assert_eq!(widened.via, None);

        let json = serde_json::to_value(&widened).unwrap();
        assert!(json.get("id").unwrap().is_null());
        assert!(json.get("via").unwrap().is_null());
        assert!(
            !json.as_object().unwrap().contains_key("change24h"),
            "absent, because the reduced type had none"
        );
    }

    #[test]
    fn a_widened_position_leg_carries_no_invented_valuation() {
        // The reduced `PositionToken` is amount-only. Filling `usd` with 0.0 would be a claim the
        // reader never made, and it would serialize as a real number rather than an absent key.
        let position = bitcoin::Position::new(
            "Bitcoin",
            "Wallet",
            "BTC",
            0.0,
            vec![bitcoin::PositionToken {
                symbol: "BTC".into(),
                amount: 0.25,
            }],
            None,
        );
        let widened = position_from(position);

        assert_eq!(widened.tokens[0].usd, None);
        let json = serde_json::to_value(&widened).unwrap();
        let leg = &json.get("tokens").unwrap()[0];
        assert!(!leg.as_object().unwrap().contains_key("usd"));
    }

    // ---- the KuCoin bridge -------------------------------------------------

    #[test]
    fn a_widened_kucoin_position_omits_id_rather_than_nulling_it() {
        // The distinction the two bridges disagree on, and the reason `Nullable` exists:
        // `_position` writes `id` unconditionally, `kucoin.py` never writes it at all.
        let position = kucoin::DefiPosition {
            protocol: "KuCoin".into(),
            category: "Earn".into(),
            name: "USDT Flexible".into(),
            via: None,
            tier: "cashflow",
            tokens: vec![kucoin::DefiToken {
                symbol: "USDT".into(),
                amount: 500.0,
                usd: Some(500.0),
            }],
            usd: 500.0,
            change24h: None,
            apr: Some(4.2),
            pnl_usd: None,
            pnl_pct: None,
            bot: None,
        };
        let widened = kucoin_position(position);

        assert_eq!(widened.id, None);
        assert_eq!(widened.tier.as_deref(), Some("cashflow"));
        assert_eq!(widened.apr, Some(4.2));

        let json = serde_json::to_value(&widened).unwrap();
        assert!(
            !json.as_object().unwrap().contains_key("id"),
            "kucoin.py omits the key; nulling it would be a shape the oracle never emits"
        );
    }

    #[test]
    fn a_widened_kucoin_position_keeps_its_bot_detail() {
        // The bot block is the richest thing on the KuCoin path. Dropping it in the bridge would
        // silently empty the Bots surface while every total still added up.
        let position = kucoin::DefiPosition {
            protocol: "KuCoin".into(),
            category: "Trading Bot".into(),
            name: "BTC-USDT spot grid".into(),
            via: None,
            tier: "highrisk",
            tokens: Vec::new(),
            usd: 1_000.0,
            change24h: Some(1.25),
            apr: None,
            pnl_usd: Some(42.0),
            pnl_pct: Some(4.2),
            bot: Some(kucoin::Bot {
                kind: "spot".into(),
                status: "running".into(),
                weights: Some(vec![kucoin::Weight {
                    symbol: "BTC".into(),
                    amount: 0.01,
                    usd: 600.0,
                    pct: 60.0,
                }]),
                count: Some(3),
                margin_usd: Some(250.0),
                margin_pct: Some(25),
                bots: Some(vec![kucoin::FuturesBot {
                    id: Some("sub-1".into()),
                    usd: 400.0,
                    pnl_usd: 12.0,
                    pnl_pct: 3.0,
                    margin: 100.0,
                }]),
            }),
        };
        let widened = kucoin_position(position);

        let bot = widened.bot.expect("the bot block survives the widening");
        assert_eq!(bot.kind, "spot");
        assert_eq!(bot.count, Some(3));
        assert_eq!(bot.margin_pct, Some(25.0));
        assert_eq!(bot.weights.as_ref().unwrap()[0].pct, 60.0);
        assert_eq!(bot.bots.as_ref().unwrap()[0].id.as_deref(), Some("sub-1"));
        assert_eq!(widened.pnl_usd, Some(42.0));
        assert_eq!(widened.change24h, Some(Some(1.25)));
    }

    #[test]
    fn a_widened_kucoin_wallet_keeps_the_exchanges_own_total() {
        // Not recomputed from the buckets: KuCoin's total is the exchange's number, and a
        // rounding disagreement between it and the rows must not be resolved by inventing one.
        let wallet = kucoin::Wallet {
            address: "kucoin",
            total: 1_500.5,
            chains: vec![kucoin::ChainBucket {
                chain: "kucoin",
                usd: 1_500.0,
                spot: vec![kucoin::SpotHolding {
                    symbol: "BTC".into(),
                    amount: 0.02,
                    price: 60_000.0,
                    usd: 1_200.0,
                    change24h: 1.5,
                    kind: "token",
                }],
                defi: Vec::new(),
            }],
        };
        let widened = kucoin_wallet(wallet);

        assert_eq!(widened.address, "kucoin");
        assert_eq!(widened.total, 1_500.5);
        assert_eq!(widened.chains[0].spot[0].change24h, Some(Some(1.5)));
        assert_eq!(widened.chains[0].spot[0].coin, None);
    }

    #[test]
    fn a_widened_bucket_preserves_the_total_and_both_lists() {
        let portfolio = bitcoin::ChainPortfolio {
            chain: "bitcoin".into(),
            usd: 30_000.0,
            spot: vec![bitcoin::SpotToken {
                symbol: "BTC".into(),
                amount: 0.5,
                price: 60_000.0,
                usd: 30_000.0,
                change24h: Some(1.0),
                kind: "native",
                coin: None,
                address: None,
            }],
            defi: Vec::new(),
        };
        let bucket = bucket_from(portfolio);

        assert_eq!(bucket.chain, "bitcoin");
        assert_eq!(bucket.usd, 30_000.0);
        assert_eq!(bucket.spot.len(), 1);
        assert!(bucket.defi.is_empty());
    }
}
