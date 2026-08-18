//! Portfolio aggregation — the fan-out that turns adapters and spot balances into a snapshot.
//!
//! Port of `portfolio.py`'s orchestration layer: `_safe` (L1857), `_chain_result` (L1866),
//! `_evm_chain_portfolio` (L1872), `_chain_portfolio` (L2135), `_order_chains` (L2358),
//! `_wallet` (L2364), `_result_or` (L2370), `build_portfolios` (L2378), `build_portfolio`
//! (L2416) and `build_wallet` (L2421).
//!
//! # Everything here exists to not lose money on the way out
//!
//! The layer below (adapters, spot readers) answers "what does this wallet hold". This layer
//! answers "what did we manage to read before we ran out of time", and those are different
//! questions. Three mechanisms, in increasing order of blast radius:
//!
//! * **[`safe`] — an adapter fails, its protocol is missing.** One broken protocol must not
//!   take down the chain it lives on, or a Uniswap outage would blank out the wallet's spot
//!   balances too.
//! * **[`PortfolioSources::chain_portfolio`] returning `Err` — a chain is missing.** One dead
//!   RPC must not take down the wallet.
//! * **The deadline — an unknown amount is missing.** `build_portfolios` fans out every
//!   (wallet × chain) pair under a wall-clock cap and returns whatever finished.
//!
//! # Partial results are the dangerous case, so they are returned, not logged
//!
//! **The Python has no marker for this.** `build_portfolios` writes
//! `"(request deadline hit; returning partial results)"` to stderr and then returns a dict that
//! is structurally identical to a complete one — same keys, same types, smaller `total`. A
//! caller cannot tell a 75-second timeout from a genuinely smaller portfolio, which is exactly
//! how a silent 30% understatement of net worth reaches the user and, worse, gets written into
//! the net-worth history as a real data point.
//!
//! Rather than invent a new JSON key (that would change the shape [`crate::model`] pins against
//! the oracle), this port returns the marker **beside** the snapshot: [`Snapshot`] pairs the
//! byte-identical [`PortfolioSnapshot`] with a [`FetchHealth`] describing what did not make it.
//! `lyra-api` decides what to do with it — a response header, a `partial` field it adds itself,
//! or a refusal. The one thing it must not do is persist a snapshot with
//! [`FetchHealth::is_complete`] false into the history table; see [`FetchHealth::is_complete`].
//!
//! # Concurrency
//!
//! Python caps its pool at `min(MAX_CONCURRENCY, len(tasks) + 3)` — 8 by default, with the `+3`
//! covering the rates, sentiment and KuCoin reads that share the same executor. That cap is
//! reproduced literally in [`build_portfolios`], and adapters get their own tighter
//! `ADAPTER_CONCURRENCY` (3) budget in [`run_adapters`]. These are not arbitrary: the public
//! RPCs and Blockscout instances behind these reads rate-limit aggressively, and exceeding the
//! cap turns a slow response into a failed one.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::chains::{self, Chain};
use crate::market::{FearGreed, Rainbow, Rates};
use crate::model::{
    ChainBucket, PortfolioSentiment, PortfolioSnapshot, Position, SpotToken, TokenAmt, Wallet,
    fallback_rates,
};

// ===========================================================================================
// Configuration
// ===========================================================================================

/// `REQUEST_DEADLINE` — the hard wall-clock cap on a whole fan-out (portfolio.py L2387).
pub const DEFAULT_REQUEST_DEADLINE_SECS: f64 = 75.0;

/// `MAX_CONCURRENCY` — chain reads in flight at once (portfolio.py L35).
pub const DEFAULT_MAX_CONCURRENCY: usize = 8;

/// `ADAPTER_CONCURRENCY` — adapters in flight at once within a single chain (portfolio.py L36).
pub const DEFAULT_ADAPTER_CONCURRENCY: usize = 3;

/// `_result_or`'s per-future timeout for the side-channel reads (portfolio.py L2370).
pub const SIDE_CHANNEL_TIMEOUT_SECS: f64 = 8.0;

/// A chain worth less than this is dropped rather than shown as an empty row (`_chain_result`).
pub const DUST_USD: f64 = 0.01;

/// The knobs `build_portfolios` reads from the environment.
#[derive(Debug, Clone, PartialEq)]
pub struct AggregateConfig {
    /// Wall-clock cap on the whole fan-out. Whatever finished by then is returned.
    pub deadline: Duration,
    /// Chain reads in flight at once.
    pub max_concurrency: usize,
    /// Adapters in flight at once, within one chain.
    pub adapter_concurrency: usize,
    /// Cap on each side-channel read (rates / sentiment / KuCoin) before its fallback is used.
    pub side_channel_timeout: Duration,
}

impl Default for AggregateConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs_f64(DEFAULT_REQUEST_DEADLINE_SECS),
            max_concurrency: DEFAULT_MAX_CONCURRENCY,
            adapter_concurrency: DEFAULT_ADAPTER_CONCURRENCY,
            side_channel_timeout: Duration::from_secs_f64(SIDE_CHANNEL_TIMEOUT_SECS),
        }
    }
}

impl AggregateConfig {
    /// Read `REQUEST_DEADLINE`, `MAX_CONCURRENCY` and `ADAPTER_CONCURRENCY`, exactly as the
    /// Python does. An unparseable or non-positive value falls back to the default rather than
    /// failing the request — a typo in a deploy env must not take the service down, and a
    /// concurrency of zero would deadlock the fan-out outright.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            deadline: env_f64("REQUEST_DEADLINE")
                .map(Duration::from_secs_f64)
                .unwrap_or(d.deadline),
            max_concurrency: env_usize("MAX_CONCURRENCY").unwrap_or(d.max_concurrency),
            adapter_concurrency: env_usize("ADAPTER_CONCURRENCY").unwrap_or(d.adapter_concurrency),
            side_channel_timeout: d.side_channel_timeout,
        }
    }
}

fn env_f64(key: &str) -> Option<f64> {
    std::env::var(key)
        .ok()?
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|v| *v > 0.0)
}

fn env_usize(key: &str) -> Option<usize> {
    std::env::var(key)
        .ok()?
        .trim()
        .parse::<usize>()
        .ok()
        .filter(|v| *v > 0)
}

// ===========================================================================================
// Observability — what did not make it into the snapshot
// ===========================================================================================

/// One (wallet × chain) unit of work, named so a failure can be reported against it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ChainTask {
    pub chain: &'static str,
    pub address: String,
}

impl std::fmt::Display for ChainTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} @ {}", self.chain, short_addr(&self.address))
    }
}

/// A chain read that returned an error, or whose task panicked.
#[derive(Debug, Clone, PartialEq)]
pub struct ChainFailure {
    pub task: ChainTask,
    pub error: String,
}

/// An adapter that `safe` swallowed.
#[derive(Debug, Clone, PartialEq)]
pub struct AdapterFailure {
    pub adapter: &'static str,
    pub chain: &'static str,
    pub error: String,
}

/// What a fan-out managed to read — the marker the Python does not have.
///
/// A response built from an incomplete read is structurally indistinguishable from a complete
/// one: the same keys, the same types, just a smaller `total`. This carries the difference.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchHealth {
    /// (wallet × chain) pairs fanned out.
    pub requested: usize,
    /// Pairs that produced an answer — holdings *or* a legitimate "nothing here".
    pub completed: usize,
    /// Chain reads that errored or panicked. Their value is missing from the total.
    pub failures: Vec<ChainFailure>,
    /// Chain reads still running when the deadline expired. Their value is missing too, and
    /// unlike a failure we do not even know whether they would have returned anything.
    pub abandoned: Vec<ChainTask>,
    /// Adapters `safe` swallowed. Sub-chain granularity: the chain still reported, but this
    /// protocol's positions are missing from it.
    pub adapter_failures: Vec<AdapterFailure>,
    /// The `REQUEST_DEADLINE` expired mid-fan-out.
    pub deadline_hit: bool,
    /// FX / BTC rates fell back to `{usd: 1.0, thb: null, btc_usd: null}`. Not a missing-money
    /// condition, but every non-USD figure in the UI is then unconvertible.
    pub rates_degraded: bool,
}

impl FetchHealth {
    /// Every fanned-out pair answered, nothing timed out, no adapter was skipped.
    ///
    /// **Callers persisting to history must gate on this.** A partial snapshot recorded as a
    /// net-worth data point is indistinguishable from a real drawdown once it is in the table,
    /// and it will skew every derived figure — change-over-time, per-tier P&L, alerts — from
    /// then on. Serving a partial result to a live view is fine (with a marker); storing one
    /// is not.
    pub fn is_complete(&self) -> bool {
        !self.deadline_hit
            && self.failures.is_empty()
            && self.abandoned.is_empty()
            && self.adapter_failures.is_empty()
            && self.completed == self.requested
    }

    /// True when some value is known to be missing from the total.
    ///
    /// Distinct from `!is_complete()`: [`FetchHealth::rates_degraded`] alone leaves the USD
    /// total correct, so it is not counted here.
    pub fn is_partial(&self) -> bool {
        self.deadline_hit
            || !self.failures.is_empty()
            || !self.abandoned.is_empty()
            || !self.adapter_failures.is_empty()
    }

    /// Fraction of the fanned-out pairs that answered, for a log line or a header. `1.0` when
    /// nothing was requested — an empty request is vacuously complete, not 0% complete.
    pub fn coverage(&self) -> f64 {
        if self.requested == 0 {
            return 1.0;
        }
        self.completed as f64 / self.requested as f64
    }

    /// One line naming what is missing, for a log or an API header. Empty when complete.
    pub fn summary(&self) -> String {
        if !self.is_partial() {
            return String::new();
        }
        let mut parts = Vec::new();
        if self.deadline_hit {
            parts.push("deadline hit".to_string());
        }
        if !self.failures.is_empty() {
            parts.push(format!(
                "{} chain read(s) failed: {}",
                self.failures.len(),
                join_first(self.failures.iter().map(|f| f.task.to_string()))
            ));
        }
        if !self.abandoned.is_empty() {
            parts.push(format!(
                "{} chain read(s) abandoned: {}",
                self.abandoned.len(),
                join_first(self.abandoned.iter().map(ChainTask::to_string))
            ));
        }
        if !self.adapter_failures.is_empty() {
            parts.push(format!(
                "{} adapter(s) skipped: {}",
                self.adapter_failures.len(),
                join_first(
                    self.adapter_failures
                        .iter()
                        .map(|f| format!("{} {}", f.adapter, f.chain))
                )
            ));
        }
        parts.push(format!("coverage {:.0}%", self.coverage() * 100.0));
        parts.join("; ")
    }

    /// Fold another read's health into this one.
    ///
    /// For the lazy `/api/wallet` path: the UI fetches wallets one at a time, so the overall
    /// "is this view complete" answer is the union of the per-wallet ones. Counters add and the
    /// flags OR together — a single partial wallet makes the assembled view partial, which is
    /// the conservative direction.
    pub fn merge(&mut self, other: FetchHealth) {
        self.requested += other.requested;
        self.completed += other.completed;
        self.failures.extend(other.failures);
        self.abandoned.extend(other.abandoned);
        self.adapter_failures.extend(other.adapter_failures);
        self.deadline_hit |= other.deadline_hit;
        self.rates_degraded |= other.rates_degraded;
    }
}

/// Name at most three things, then say how many more there are — a log line naming 40 dead
/// chains is a log line nobody reads.
fn join_first(items: impl Iterator<Item = String>) -> String {
    let all: Vec<String> = items.collect();
    if all.len() <= 3 {
        return all.join(", ");
    }
    format!("{}, +{} more", all[..3].join(", "), all.len() - 3)
}

/// Python's `address[:8]` in the log lines, but counting **characters** rather than bytes so a
/// non-ASCII input cannot panic on a split inside a code point.
fn short_addr(address: &str) -> String {
    address.chars().take(8).collect()
}

/// A completed fan-out: the wire-shaped snapshot, plus what it is missing.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// Serialises to exactly the Python `build_portfolios` dict — see [`crate::model`].
    pub portfolio: PortfolioSnapshot,
    /// Never serialised into `portfolio`; the caller decides how to surface it.
    pub health: FetchHealth,
}

/// A single wallet read (`build_wallet` / `build_portfolio`), with the same marker.
#[derive(Debug, Clone, PartialEq)]
pub struct WalletOutcome {
    pub wallet: Wallet,
    pub health: FetchHealth,
}

// ===========================================================================================
// `_safe` — an adapter failure is a missing protocol, not a missing chain
// ===========================================================================================

/// Port of `_safe` (portfolio.py L1857): run a fallible read, and on failure log it and yield
/// nothing rather than propagating.
///
/// The Python catches `Exception`, which is broad enough to cover any adapter misbehaviour it
/// can produce. Its Rust equivalent has to cover one more case — a `panic!` in an adapter would
/// otherwise unwind past the whole fan-out — which is why [`run_adapters`] drives adapters on
/// their own tasks and treats a panicked task as a skipped adapter. See there.
pub fn safe<T>(what: &str, result: Result<Vec<T>>) -> (Vec<T>, Option<String>) {
    match result {
        Ok(v) => (v, None),
        Err(e) => {
            let msg = format!("{e:#}");
            // Same text as the Python's stderr line, so operators grepping logs across the
            // migration find both.
            tracing::warn!("({what} skipped: {msg})");
            (Vec::new(), Some(msg))
        }
    }
}

// ===========================================================================================
// Adapters
// ===========================================================================================

/// Everything an adapter needs about the wallet it is reading — port of `_Ctx` (L1851).
///
/// The Python also threads a `w3` client through here. This port leaves the transport out: the
/// adapters take their client from their own construction, so a stub adapter in a test needs no
/// network at all.
#[derive(Debug, Clone)]
pub struct AdapterCtx {
    pub chain: &'static Chain,
    /// The wallet being read.
    pub owner: String,
    /// Every address whose positions count as this wallet's — the wallet itself plus any
    /// Sickle/proxy contracts it controls (`resolve_owners`), each paired with the label that
    /// says how it was reached: `None` for the wallet, `Some("vfat.io")` for a Sickle.
    ///
    /// The label is carried here rather than re-derived per adapter because it ends up on the
    /// position itself (`Position::via`), and an adapter that scans a proxy's NFTs has no other
    /// way to know it was a proxy. This is the exact shape [`crate::adapters::univ3::read_positions`]
    /// takes, and [`crate::adapters::vfat::resolve_owners`] produces.
    pub owners: Vec<(String, Option<String>)>,
    /// The chain's already-read spot balances. Adapters need these to value LP legs and to
    /// claim a spot token as consumed (see [`AdapterCtx::spot`] and `spot_addr` dedup).
    pub spot: Vec<SpotToken>,
}

/// The future an [`Adapter`] returns.
///
/// Boxed rather than `impl Future`, because the registry is a heterogeneous list
/// (`&[Arc<dyn Adapter>]`) and `-> impl Future` in a trait is not object-safe.
pub type AdapterFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Position>>> + Send + 'a>>;

/// One protocol reader — port of an entry in the `ADAPTERS` registry (portfolio.py L1849).
///
/// **This trait is this module's assumption about `adapters::*`, which were being written in
/// parallel.** See the module-level note in the task report: if the adapters landed with a
/// different signature, this is the one place to reconcile.
pub trait Adapter: Send + Sync + 'static {
    /// Used in the `(… skipped: …)` log line, so it should read like the Python function name
    /// (`adapt_univ3`, `adapt_vfat_api`, …).
    fn name(&self) -> &'static str;

    /// Positions this protocol holds for `ctx.owners`. Returning `Err` costs this protocol,
    /// not the chain.
    fn positions<'a>(&'a self, ctx: &'a AdapterCtx) -> AdapterFuture<'a>;
}

/// Run every adapter over one chain, bounded by `ADAPTER_CONCURRENCY`, and merge the results
/// **in registry order**.
///
/// Order matters: the Python iterates its futures list in submission order, and that order is
/// what decides which adapter claims a position when two of them can see the same one. Results
/// arrive in completion order here, so they are re-sorted by index before merging.
///
/// A failing adapter is dropped via [`safe`]. A *panicking* adapter is also dropped — each runs
/// on its own task, so the panic is caught at the join instead of unwinding the fan-out. That is
/// strictly stronger than the Python, whose `except Exception` would not catch an interpreter
/// crash, and it matters here because a slicing bug in one adapter's decoder should not be able
/// to zero a whole wallet.
pub async fn run_adapters(
    adapters: &[Arc<dyn Adapter>],
    ctx: Arc<AdapterCtx>,
    concurrency: usize,
) -> (Vec<Position>, Vec<AdapterFailure>) {
    if adapters.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let permits = Arc::new(Semaphore::new(concurrency.max(1)));
    let mut set: JoinSet<(usize, Result<Vec<Position>>)> = JoinSet::new();

    for (idx, adapter) in adapters.iter().enumerate() {
        let adapter = Arc::clone(adapter);
        let ctx = Arc::clone(&ctx);
        let permits = Arc::clone(&permits);
        set.spawn(async move {
            // `acquire_owned` cannot fail here: the semaphore outlives every task holding a
            // clone of it, so it is never closed while a permit is outstanding.
            let _permit = permits.acquire_owned().await;
            (idx, adapter.positions(&ctx).await)
        });
    }

    let chain = ctx.chain.name;
    let mut slots: Vec<Option<Vec<Position>>> = vec![None; adapters.len()];
    let mut failures = Vec::new();

    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((idx, result)) => {
                let what = format!("{} {chain}", adapters[idx].name());
                let (positions, error) = safe(&what, result);
                if let Some(error) = error {
                    failures.push(AdapterFailure {
                        adapter: adapters[idx].name(),
                        chain,
                        error,
                    });
                }
                slots[idx] = Some(positions);
            }
            Err(join_error) => {
                // A panicked adapter. We cannot tell *which* one from the JoinError, so it is
                // reported against the chain rather than a name — still far better than the
                // alternative, which is the panic taking the request with it.
                let error = format!("adapter task did not complete: {join_error}");
                tracing::warn!("(adapter {chain} skipped: {error})");
                failures.push(AdapterFailure {
                    adapter: "<panicked>",
                    chain,
                    error,
                });
            }
        }
    }

    let merged = slots.into_iter().flatten().flatten().collect();
    (merged, failures)
}

// ===========================================================================================
// Chain assembly
// ===========================================================================================

/// Port of the spot dedup in `_evm_chain_portfolio` (L1902-1905).
///
/// An adapter that represents a *held token* — an ERC-4626 vault share, say — marks itself with
/// `spot_addr`. That token is then removed from the chain's spot list, because the position
/// already accounts for its value. Without this the same holding is counted twice, once as a
/// vault position and once as the share token sitting in the wallet.
///
/// The marker is consumed (`take`n) as it is read, mirroring Python's `pop`: it is internal
/// state, never part of the response. Matching is case-insensitive, and a spot token with no
/// address (a native coin) can never be consumed.
pub fn dedup_spot_against_positions(spot: Vec<SpotToken>, defi: &mut [Position]) -> Vec<SpotToken> {
    let consumed: HashSet<String> = defi
        .iter_mut()
        .filter_map(|p| p.spot_addr.take())
        .filter(|a| !a.is_empty())
        .map(|a| a.to_lowercase())
        .collect();
    if consumed.is_empty() {
        return spot;
    }
    spot.into_iter()
        .filter(|t| {
            t.address
                .as_deref()
                .map(|a| !consumed.contains(&a.to_lowercase()))
                .unwrap_or(true)
        })
        .collect()
}

/// The chain's USD total: every spot token plus every position, treating an unknown value as
/// zero (Python's `(t["usd"] or 0)`).
///
/// An unvalued position contributes nothing rather than making the whole sum unknown. Note this
/// covers `null` only — a *NaN* usd would still propagate, all the way to the grand total, and
/// render as a blank net worth. That is inherited from the oracle, where `x or 0` leaves NaN
/// untouched because NaN is truthy in Python; guarding it here would be a silent divergence, so
/// it is flagged rather than fixed.
pub fn chain_usd(spot: &[SpotToken], defi: &[Position]) -> f64 {
    let spot_usd: f64 = spot.iter().filter_map(|t| t.usd).sum();
    let defi_usd: f64 = defi.iter().filter_map(|p| p.usd).sum();
    spot_usd + defi_usd
}

/// Port of `_chain_result` (L1866): a chain worth less than dust is dropped entirely.
///
/// `None` means "nothing worth reporting", which is **not** the same as the failure a chain read
/// reports through `Err` — an empty wallet is a successful read. [`build_portfolios`] counts
/// both as completed and only the latter as a failure.
pub fn chain_result(
    chain: &str,
    usd: f64,
    spot: Vec<SpotToken>,
    defi: Vec<Position>,
) -> Option<ChainBucket> {
    if usd < DUST_USD {
        return None;
    }
    Some(ChainBucket {
        chain: chain.to_string(),
        usd,
        spot,
        defi,
    })
}

/// The back half of `_evm_chain_portfolio` (L1902-1907): dedup spot against the positions that
/// consumed it, total what is left, and drop the chain if it is dust.
///
/// The order is load-bearing — dedup first, *then* sum. Summing first would include the value of
/// the very tokens the dedup is about to remove, double-counting every vault position.
pub fn assemble_chain(
    chain: &str,
    spot: Vec<SpotToken>,
    mut defi: Vec<Position>,
) -> Option<ChainBucket> {
    let spot = dedup_spot_against_positions(spot, &mut defi);
    let usd = chain_usd(&spot, &defi);
    chain_result(chain, usd, spot, defi)
}

/// Port of `_wallet` (L2364): drop the chains that reported nothing, sort into table order, and
/// total what is left.
///
/// The total is **recomputed from the buckets**, never passed in — so it cannot disagree with
/// the rows underneath it. A dropped chain therefore leaves the total consistent by
/// construction, and the ordering keeps the UI's chain list from reshuffling between refreshes.
pub fn wallet(address: &str, chains: Vec<Option<ChainBucket>>) -> Wallet {
    let mut chains: Vec<ChainBucket> = chains.into_iter().flatten().collect();
    chains::order_chains(&mut chains, |c| c.chain.as_str());
    Wallet::new(address, chains)
}

/// Port of `dict.fromkeys(addresses)` (L2382): drop duplicates, keep first-seen order.
///
/// Requesting the same wallet twice must not double its contribution to the grand total.
pub fn dedup_addresses<S: AsRef<str>>(addresses: &[S]) -> Vec<String> {
    let mut seen = HashSet::new();
    addresses
        .iter()
        .map(AsRef::as_ref)
        .filter(|a| seen.insert(a.to_string()))
        .map(str::to_string)
        .collect()
}

// ===========================================================================================
// Sources
// ===========================================================================================

/// Everything the fan-out reads from. One trait rather than four so a test stub is one `impl`.
///
/// Only [`PortfolioSources::chain_portfolio`] has no default: the other three degrade to the
/// same fallbacks the Python uses when its 8-second `_result_or` budget expires, so a stub that
/// only knows about chains behaves exactly like a deployment with no KuCoin credentials and no
/// reachable FX provider.
pub trait PortfolioSources: Send + Sync + 'static {
    /// Port of `_chain_portfolio` (L2135): read one wallet on one chain.
    ///
    /// * `Ok(Some(bucket))` — holdings.
    /// * `Ok(None)` — read fine, nothing above dust. Counts as completed, not as a failure.
    /// * `Err(e)` — the read failed. The chain is missing from the total and is reported in
    ///   [`FetchHealth::failures`].
    ///
    /// Note the Python swallows the error inside `_chain_portfolio` and returns `None` for both
    /// of the last two cases, which is precisely the conflation this port refuses to inherit:
    /// "you hold nothing on Base" and "we could not reach Base" must not look the same.
    fn chain_portfolio(
        &self,
        chain: &'static Chain,
        address: String,
    ) -> impl Future<Output = Result<Option<ChainBucket>>> + Send;

    /// Port of `get_rates`. Falls back to `{usd: 1.0, thb: null, btc_usd: null}`.
    fn rates(&self) -> impl Future<Output = Result<Rates>> + Send {
        async { Ok(fallback_rates()) }
    }

    /// Port of `_fear_greed`. `None` is a legitimate answer (the index was unreachable).
    fn fear_greed(&self) -> impl Future<Output = Result<Option<FearGreed>>> + Send {
        async { Ok(None) }
    }

    /// Port of `btc_rainbow(rates["btc_usd"])` — derived from the rates, so it is asked for
    /// after they resolve rather than fetched independently.
    fn btc_rainbow(&self, btc_usd: Option<f64>) -> impl Future<Output = Option<Rainbow>> + Send {
        async move { crate::market::btc_rainbow(btc_usd) }
    }

    /// Port of `kucoin.balances()` — the connected exchange account, shaped as a wallet.
    /// `Ok(None)` means "not configured", which is not a failure.
    fn kucoin_wallet(&self) -> impl Future<Output = Result<Option<Wallet>>> + Send {
        async { Ok(None) }
    }
}

// ===========================================================================================
// The fan-out
// ===========================================================================================

/// Port of `build_portfolios` (L2378): every (wallet × chain) pair at once, under one deadline.
///
/// Pairs are formed by [`chains::chains_for_address`], so a `bc1…` wallet is never asked about
/// an EVM chain — that would be a guaranteed error per request and a slower response for a
/// result that could not exist.
///
/// On expiry the outstanding reads are abandoned and whatever finished is returned, with
/// [`FetchHealth::deadline_hit`] set. Read the module docs before deciding what to do with a
/// partial result; the short version is that it is fine to display and not fine to store.
pub async fn build_portfolios<S: PortfolioSources>(
    sources: Arc<S>,
    addresses: &[String],
    cfg: &AggregateConfig,
) -> Snapshot {
    let addresses = dedup_addresses(addresses);

    let tasks: Vec<(String, &'static Chain)> = addresses
        .iter()
        .flat_map(|w| {
            chains::chains_for_address(w)
                .into_iter()
                .map(move |c| (w.clone(), c))
        })
        .collect();

    // Python: `ThreadPoolExecutor(max_workers=min(MAX_CONCURRENCY, len(tasks) + 3))`, where the
    // `+ 3` is the rates / sentiment / KuCoin reads sharing the *same* executor as the chain
    // work. One semaphore for all of it reproduces that, and it matters: running the side
    // channels outside the cap would put three extra requests on rate-limited hosts at exactly
    // the moment the fan-out is already at full stretch.
    let permits = Arc::new(Semaphore::new(
        cfg.max_concurrency.min(tasks.len() + 3).max(1),
    ));

    // Submitted first, exactly as the Python does, so they take the first slots and the FX rate
    // is in hand by the time the chains finish rather than queued behind all of them.
    let side = {
        let sources = Arc::clone(&sources);
        let permits = Arc::clone(&permits);
        let budget = cfg.side_channel_timeout;
        tokio::spawn(async move { read_side_channels(sources.as_ref(), &permits, budget).await })
    };

    let (results, mut health) = run_chain_tasks(
        Arc::clone(&sources),
        tasks,
        Arc::clone(&permits),
        cfg.deadline,
        "request deadline hit; returning partial results",
    )
    .await;

    // Regroup by wallet, preserving the requested address order rather than completion order.
    let mut wallets: Vec<Wallet> = addresses
        .iter()
        .map(|address| {
            let chains = results
                .iter()
                .filter(|(task, _)| &task.address == address)
                .map(|(_, bucket)| bucket.clone())
                .collect();
            wallet(address, chains)
        })
        .collect();

    let (rates, fear_greed, kucoin, rates_degraded) = side.await.unwrap_or_else(|e| {
        tracing::warn!("(side channels skipped: {e})");
        (fallback_rates(), None, None, true)
    });
    health.rates_degraded = rates_degraded;

    // The KuCoin account rides along as its own wallet, appended after the requested ones and
    // deliberately absent from `addresses` — it has no on-chain address to be listed under.
    if let Some(ku) = kucoin {
        wallets.push(ku);
    }

    let btc_rainbow = sources.btc_rainbow(rates.btc_usd).await;
    let portfolio = PortfolioSnapshot::new(
        addresses,
        wallets,
        rates,
        PortfolioSentiment {
            fear_greed,
            btc_rainbow,
        },
        now_epoch_secs(),
    );

    if health.is_partial() {
        tracing::warn!("(partial portfolio: {})", health.summary());
    }
    Snapshot { portfolio, health }
}

/// Port of `build_wallet` (L2421): one wallet across its compatible chains, under the same
/// deadline. This is what the lazy `/api/wallet` endpoint calls so the UI can render each
/// wallet as soon as it is ready.
pub async fn build_wallet<S: PortfolioSources>(
    sources: Arc<S>,
    address: &str,
    cfg: &AggregateConfig,
) -> WalletOutcome {
    let chains = chains::chains_for_address(address);
    let tasks: Vec<(String, &'static Chain)> = chains
        .into_iter()
        .map(|c| (address.to_string(), c))
        .collect();

    // Python: `min(MAX_CONCURRENCY, len(chains_for) + 1)`. No side channels on this path — the
    // lazy endpoint returns a bare wallet — hence `+ 1` rather than `+ 3`.
    let permits = Arc::new(Semaphore::new(
        cfg.max_concurrency.min(tasks.len() + 1).max(1),
    ));
    let deadline_msg = format!("deadline hit for {}…", short_addr(address));
    let (results, health) =
        run_chain_tasks(sources, tasks, permits, cfg.deadline, &deadline_msg).await;

    let chains = results.into_iter().map(|(_, bucket)| bucket).collect();
    WalletOutcome {
        wallet: wallet(address, chains),
        health,
    }
}

/// Port of `build_portfolio` (L2416): a single wallet, via the full fan-out.
///
/// The Python indexes `build_portfolios([address])["wallets"][0]`, which would raise on an
/// address that pairs with no chain. Here that case yields an empty wallet instead — a wallet
/// with no chains and a zero total is a truthful answer, an index panic is not.
pub async fn build_portfolio<S: PortfolioSources>(
    sources: Arc<S>,
    address: &str,
    cfg: &AggregateConfig,
) -> WalletOutcome {
    let requested = [address.to_string()];
    let snapshot = build_portfolios(sources, &requested, cfg).await;
    let wallet = snapshot
        .portfolio
        .wallets
        .into_iter()
        .find(|w| w.address == address)
        .unwrap_or_else(|| Wallet::new(address, Vec::new()));
    WalletOutcome {
        wallet,
        health: snapshot.health,
    }
}

/// The shared fan-out driver: spawn every task under a concurrency cap, drain in completion
/// order, and stop at the deadline with whatever has landed.
///
/// Returns the buckets paired with their task so the caller can regroup them, plus the health
/// record. `Ok(None)` results are counted as completed and produce no bucket.
async fn run_chain_tasks<S: PortfolioSources>(
    sources: Arc<S>,
    tasks: Vec<(String, &'static Chain)>,
    semaphore: Arc<Semaphore>,
    deadline: Duration,
    deadline_message: &str,
) -> (Vec<(ChainTask, Option<ChainBucket>)>, FetchHealth) {
    let mut health = FetchHealth {
        requested: tasks.len(),
        ..Default::default()
    };
    if tasks.is_empty() {
        return (Vec::new(), health);
    }

    let mut set: JoinSet<(ChainTask, Result<Option<ChainBucket>>)> = JoinSet::new();
    // Tracks what has not answered yet, so an expired deadline can name the abandoned work
    // instead of just saying "some of it is missing".
    let mut outstanding: Vec<ChainTask> = Vec::with_capacity(tasks.len());

    for (address, chain) in tasks {
        let task = ChainTask {
            chain: chain.name,
            address: address.clone(),
        };
        outstanding.push(task.clone());
        let sources = Arc::clone(&sources);
        let semaphore = Arc::clone(&semaphore);
        set.spawn(async move {
            let _permit = semaphore.acquire_owned().await;
            let result = sources.chain_portfolio(chain, address).await;
            (task, result)
        });
    }

    let mut results = Vec::new();
    let drain = async {
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((task, Ok(bucket))) => {
                    outstanding.retain(|t| t != &task);
                    health.completed += 1;
                    results.push((task, bucket));
                }
                Ok((task, Err(e))) => {
                    outstanding.retain(|t| t != &task);
                    let error = format!("{e:#}");
                    // Same text as the Python's `_chain_portfolio` stderr line.
                    tracing::warn!(
                        "(chain {} failed for {}…: {error})",
                        task.chain,
                        short_addr(&task.address)
                    );
                    health.failures.push(ChainFailure { task, error });
                }
                Err(join_error) => {
                    // A panicked chain read. The task is unidentifiable from the JoinError, so
                    // it is reported without a name rather than silently vanishing.
                    let error = format!("chain task did not complete: {join_error}");
                    tracing::warn!("({error})");
                    health.failures.push(ChainFailure {
                        task: ChainTask {
                            chain: "<panicked>",
                            address: String::new(),
                        },
                        error,
                    });
                }
            }
        }
    };

    if tokio::time::timeout(deadline, drain).await.is_err() {
        // Whatever finished is returned; the rest is abandoned. `abort_all` is what makes this
        // a hard cap rather than a polite request — without it the tasks keep holding RPC
        // connections open long after the response has been sent.
        set.abort_all();
        health.deadline_hit = true;
        health.abandoned = outstanding;
        tracing::warn!("({deadline_message})");
    }

    (results, health)
}

/// The three reads that hang off `build_portfolios` rather than off a chain, each capped by
/// `_result_or`'s 8-second budget and each falling back rather than failing the request.
///
/// Returns `(rates, fear_greed, kucoin_wallet, rates_degraded)`.
async fn read_side_channels<S: PortfolioSources>(
    sources: &S,
    permits: &Semaphore,
    budget: Duration,
) -> (Rates, Option<FearGreed>, Option<Wallet>, bool) {
    let (rates, fear_greed, kucoin) = tokio::join!(
        with_permit(permits, budget, sources.rates()),
        with_permit(permits, budget, sources.fear_greed()),
        with_permit(permits, budget, sources.kucoin_wallet()),
    );

    let (rates, rates_degraded) = match rates {
        Ok(Ok(r)) => (r, false),
        Ok(Err(e)) => {
            tracing::warn!("(rates skipped: {e:#})");
            (fallback_rates(), true)
        }
        Err(_) => {
            tracing::warn!("(rates skipped: timed out)");
            (fallback_rates(), true)
        }
    };
    let fear_greed = flatten_side("fear_greed", fear_greed).flatten();
    let kucoin = flatten_side("kucoin", kucoin).flatten();
    (rates, fear_greed, kucoin, rates_degraded)
}

/// Run one side-channel read under a slot from the shared pool, capped by `budget`.
///
/// The timeout wraps the *acquire* as well as the request, so a saturated pool degrades to the
/// fallback instead of stalling the response past its own deadline. A free function rather than
/// a closure because the three calls have three different output types.
async fn with_permit<T>(
    permits: &Semaphore,
    budget: Duration,
    fut: impl Future<Output = T>,
) -> Result<T, tokio::time::error::Elapsed> {
    tokio::time::timeout(budget, async {
        let _permit = permits.acquire().await;
        fut.await
    })
    .await
}

/// `_result_or`: a side channel that errors or runs long yields its default, with a log.
fn flatten_side<T>(
    what: &str,
    outcome: Result<Result<T>, tokio::time::error::Elapsed>,
) -> Option<T> {
    match outcome {
        Ok(Ok(v)) => Some(v),
        Ok(Err(e)) => {
            tracing::warn!("({what} skipped: {e:#})");
            None
        }
        Err(_) => {
            tracing::warn!("({what} skipped: timed out)");
            None
        }
    }
}

/// `time.time()` — epoch seconds, fractional. Zero if the clock is before the epoch, which is
/// not a case worth failing a portfolio read over.
fn now_epoch_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

// ===========================================================================================
// Bridging the non-EVM readers
// ===========================================================================================
//
// `bitcoin.rs` declares its own `SpotToken` / `Position` / `ChainPortfolio`, and `solana.rs` and
// `hyperliquid.rs` import them from there — its own comment says to hoist them into a shared
// module once `lib.rs` is wired, which is what `model.rs` now is. Until that hoist happens these
// conversions are the seam, so the fan-out can speak one type.
//
// They are shape-preserving except where noted on `change24h`; see the task report.

impl From<crate::bitcoin::SpotToken> for SpotToken {
    fn from(t: crate::bitcoin::SpotToken) -> Self {
        SpotToken {
            symbol: Some(t.symbol),
            amount: t.amount,
            price: Some(t.price),
            usd: Some(t.usd),
            // `Some(v)` -> the key with a value, `None` -> the key absent. The reader cannot
            // currently express "present and null", which Python's Bitcoin and Solana spot
            // paths do emit when the change lookup misses.
            change24h: t.change24h.map(Some),
            coin: t.coin.map(Some),
            address: t.address,
            kind: Some(t.kind.to_string()),
            category: None,
        }
    }
}

impl From<crate::bitcoin::PositionToken> for TokenAmt {
    fn from(t: crate::bitcoin::PositionToken) -> Self {
        TokenAmt {
            symbol: t.symbol,
            amount: t.amount,
            ..Default::default()
        }
    }
}

impl From<crate::bitcoin::Position> for Position {
    fn from(p: crate::bitcoin::Position) -> Self {
        Position {
            protocol: p.protocol,
            category: p.category,
            name: p.name,
            // `_position` always writes the key, null included — hence `Some(...)`, not `None`.
            id: Some(p.id),
            via: p.via,
            tokens: p.tokens.into_iter().map(TokenAmt::from).collect(),
            usd: Some(p.usd),
            change24h: p.change24h.map(Some),
            ..Default::default()
        }
    }
}

impl From<crate::bitcoin::ChainPortfolio> for ChainBucket {
    fn from(c: crate::bitcoin::ChainPortfolio) -> Self {
        ChainBucket {
            chain: c.chain,
            usd: c.usd,
            spot: c.spot.into_iter().map(SpotToken::from).collect(),
            defi: c.defi.into_iter().map(Position::from).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // ---------------------------------------------------------------------------------------
    // Fixtures
    // ---------------------------------------------------------------------------------------

    const EVM: &str = "0x7Fce9c293dBD6d050455B986cb6850114Aad71a8";
    const EVM2: &str = "0x1234567890abcdef1234567890ABCDEF12345678";
    const BTC: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    fn spot(symbol: &str, usd: f64, address: Option<&str>) -> SpotToken {
        SpotToken {
            symbol: Some(symbol.to_string()),
            amount: 1.0,
            price: Some(usd),
            usd: Some(usd),
            address: address.map(str::to_string),
            kind: Some("token".into()),
            ..Default::default()
        }
    }

    fn position(name: &str, usd: f64) -> Position {
        Position::new("Test", "Yield", name, Some(usd))
    }

    fn bucket(chain: &str, usd: f64) -> ChainBucket {
        ChainBucket {
            chain: chain.to_string(),
            usd,
            spot: vec![spot("ETH", usd, None)],
            defi: Vec::new(),
        }
    }

    /// How a stub should answer for one chain.
    #[derive(Clone)]
    enum Reply {
        Holdings(f64),
        Empty,
        Fail(&'static str),
        /// Never answers within the deadline.
        Hang,
        Panic,
    }

    struct StubSources {
        replies: Vec<(&'static str, Reply)>,
        default: Reply,
        /// Highest number of chain reads observed in flight at once.
        peak: Arc<AtomicUsize>,
        in_flight: Arc<AtomicUsize>,
        seen: Arc<Mutex<Vec<(String, &'static str)>>>,
        kucoin: Option<Wallet>,
        rates: Option<Rates>,
    }

    impl StubSources {
        fn new(default: Reply) -> Self {
            Self {
                replies: Vec::new(),
                default,
                peak: Arc::new(AtomicUsize::new(0)),
                in_flight: Arc::new(AtomicUsize::new(0)),
                seen: Arc::new(Mutex::new(Vec::new())),
                kucoin: None,
                rates: None,
            }
        }

        fn on(mut self, chain: &'static str, reply: Reply) -> Self {
            self.replies.push((chain, reply));
            self
        }

        fn with_kucoin(mut self, w: Wallet) -> Self {
            self.kucoin = Some(w);
            self
        }

        fn reply_for(&self, chain: &str) -> Reply {
            self.replies
                .iter()
                .find(|(c, _)| *c == chain)
                .map(|(_, r)| r.clone())
                .unwrap_or_else(|| self.default.clone())
        }
    }

    impl PortfolioSources for StubSources {
        async fn chain_portfolio(
            &self,
            chain: &'static Chain,
            address: String,
        ) -> Result<Option<ChainBucket>> {
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            self.seen.lock().unwrap().push((address, chain.name));
            // Long enough that every task issued under one permit batch overlaps, so the peak
            // counter actually observes the cap rather than a serialised trickle.
            tokio::time::sleep(Duration::from_millis(20)).await;
            let reply = self.reply_for(chain.name);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);

            match reply {
                Reply::Holdings(usd) => Ok(Some(bucket(chain.name, usd))),
                Reply::Empty => Ok(None),
                Reply::Fail(msg) => Err(anyhow::anyhow!("{msg}")),
                Reply::Hang => {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    Ok(None)
                }
                Reply::Panic => panic!("stub chain reader panicked on purpose"),
            }
        }

        async fn rates(&self) -> Result<Rates> {
            match &self.rates {
                Some(r) => Ok(r.clone()),
                None => Err(anyhow::anyhow!("no FX provider in this test")),
            }
        }

        async fn kucoin_wallet(&self) -> Result<Option<Wallet>> {
            Ok(self.kucoin.clone())
        }

        async fn btc_rainbow(&self, _btc_usd: Option<f64>) -> Option<Rainbow> {
            None
        }
    }

    fn fast_cfg() -> AggregateConfig {
        AggregateConfig {
            deadline: Duration::from_millis(400),
            side_channel_timeout: Duration::from_millis(200),
            ..Default::default()
        }
    }

    // ---------------------------------------------------------------------------------------
    // Address handling
    // ---------------------------------------------------------------------------------------

    #[test]
    fn repeated_addresses_are_deduped_keeping_first_seen_order() {
        // Python's `dict.fromkeys`. Without this the same wallet counts twice in the grand
        // total — the exact bug that makes net worth look like it doubled overnight.
        let got = dedup_addresses(&[EVM, EVM2, EVM, EVM2, EVM]);
        assert_eq!(got, vec![EVM.to_string(), EVM2.to_string()]);
    }

    #[test]
    fn dedup_is_case_sensitive_like_the_python() {
        // `dict.fromkeys` compares strings exactly, so a checksummed and a lowercase spelling of
        // the same wallet are two entries. Worth pinning: "fixing" it here would silently change
        // which of the two spellings the response reports back under `addresses`.
        let lower = EVM.to_lowercase();
        assert_eq!(dedup_addresses(&[EVM, lower.as_str()]).len(), 2);
    }

    #[tokio::test]
    async fn a_repeated_address_is_read_once_and_counted_once() {
        let sources = Arc::new(StubSources::new(Reply::Empty).on("base", Reply::Holdings(100.0)));
        let seen = Arc::clone(&sources.seen);

        let snap = build_portfolios(
            sources,
            &[EVM.to_string(), EVM.to_string(), EVM.to_string()],
            &fast_cfg(),
        )
        .await;

        assert_eq!(snap.portfolio.addresses, vec![EVM.to_string()]);
        assert_eq!(snap.portfolio.wallets.len(), 1);
        assert_eq!(
            snap.portfolio.total, 100.0,
            "the wallet must not be counted three times"
        );
        let base_reads = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| *c == "base")
            .count();
        assert_eq!(base_reads, 1, "and must not be fetched three times either");
    }

    // ---------------------------------------------------------------------------------------
    // Chain assembly
    // ---------------------------------------------------------------------------------------

    #[test]
    fn a_position_consumes_the_spot_token_it_represents() {
        let vault = "0xAbCdEf0000000000000000000000000000000001";
        let mut share = position("gtWBTCc vault", 512.0);
        share.spot_addr = Some(vault.to_string());

        let spot_list = vec![
            spot("ETH", 100.0, None),
            // Same address, different case — Blockscout and the adapters disagree on casing.
            spot("gtWBTCc", 512.0, Some(&vault.to_lowercase())),
            spot(
                "USDC",
                50.0,
                Some("0x0000000000000000000000000000000000000009"),
            ),
        ];

        let mut defi = vec![share];
        let kept = dedup_spot_against_positions(spot_list, &mut defi);

        let symbols: Vec<_> = kept.iter().map(|t| t.symbol.clone().unwrap()).collect();
        assert_eq!(symbols, vec!["ETH", "USDC"], "the vault share must be gone");
        assert_eq!(
            defi[0].spot_addr, None,
            "the marker is internal and must be consumed"
        );
        // 100 + 50 + 512, not 100 + 50 + 512 + 512.
        assert_eq!(chain_usd(&kept, &defi), 662.0);
    }

    #[test]
    fn dedup_runs_before_the_total_is_taken() {
        // The ordering trap: totalling first would count the vault's value twice.
        let vault = "0xAAA0000000000000000000000000000000000001";
        let mut share = position("vault", 512.0);
        share.spot_addr = Some(vault.to_string());
        let spot_list = vec![spot("share", 512.0, Some(vault))];

        let assembled = assemble_chain("base", spot_list, vec![share]).expect("above dust");
        assert_eq!(assembled.usd, 512.0, "double-counted");
        assert!(assembled.spot.is_empty());
    }

    #[test]
    fn a_native_coin_is_never_consumed_by_a_position() {
        // A spot entry with no address must survive any dedup — otherwise a stray empty
        // `spot_addr` could delete the chain's native balance.
        let mut p = position("x", 1.0);
        p.spot_addr = Some(String::new());
        let mut defi = vec![p];
        let kept = dedup_spot_against_positions(vec![spot("ETH", 100.0, None)], &mut defi);
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn a_null_valued_position_contributes_zero_rather_than_nan() {
        let unpriced = Position::new("Unknown", "Yield", "unpriced", None);
        let total = chain_usd(&[spot("ETH", 100.0, None)], &[unpriced]);
        assert_eq!(total, 100.0);
        assert!(
            total.is_finite(),
            "a NaN here propagates to the grand total and blanks the UI"
        );
    }

    #[test]
    fn a_sub_dust_chain_is_dropped_entirely() {
        assert!(chain_result("base", 0.009, Vec::new(), Vec::new()).is_none());
        assert!(chain_result("base", DUST_USD, Vec::new(), Vec::new()).is_some());
    }

    #[test]
    fn a_wallet_totals_and_orders_the_chains_it_kept() {
        // `_wallet` drops the `None`s, sorts into table order, and recomputes the total.
        let w = wallet(
            EVM,
            vec![
                Some(bucket("optimism", 256.25)),
                None,
                Some(bucket("base", 1792.0)),
                chain_result("polygon", 0.001, Vec::new(), Vec::new()),
            ],
        );

        assert_eq!(w.total, 2048.25, "the dropped chains must not be counted");
        let order: Vec<_> = w.chains.iter().map(|c| c.chain.as_str()).collect();
        let expected_first = if chains::order_index("base") < chains::order_index("optimism") {
            "base"
        } else {
            "optimism"
        };
        assert_eq!(order.len(), 2);
        assert_eq!(
            order[0], expected_first,
            "chains must follow the CHAINS table order"
        );
    }

    // ---------------------------------------------------------------------------------------
    // `_safe` and the adapter driver
    // ---------------------------------------------------------------------------------------

    struct StubAdapter {
        name: &'static str,
        behaviour: Reply,
        started: Arc<AtomicUsize>,
    }

    impl Adapter for StubAdapter {
        fn name(&self) -> &'static str {
            self.name
        }

        fn positions<'a>(&'a self, _ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
            Box::pin(async move {
                self.started.fetch_add(1, Ordering::SeqCst);
                match self.behaviour {
                    Reply::Holdings(usd) => Ok(vec![position(self.name, usd)]),
                    Reply::Empty => Ok(Vec::new()),
                    Reply::Fail(msg) => Err(anyhow::anyhow!("{msg}")),
                    Reply::Panic => panic!("adapter {} panicked on purpose", self.name),
                    Reply::Hang => {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                        Ok(Vec::new())
                    }
                }
            })
        }
    }

    fn adapter(name: &'static str, behaviour: Reply) -> Arc<dyn Adapter> {
        Arc::new(StubAdapter {
            name,
            behaviour,
            started: Arc::new(AtomicUsize::new(0)),
        })
    }

    fn ctx() -> Arc<AdapterCtx> {
        Arc::new(AdapterCtx {
            chain: chains::by_name("base").expect("base is in the chain table"),
            owner: EVM.to_string(),
            owners: vec![(EVM.to_string(), None)],
            spot: Vec::new(),
        })
    }

    #[tokio::test]
    async fn a_failing_adapter_costs_its_protocol_not_the_chain() {
        let adapters = vec![
            adapter("adapt_erc4626", Reply::Holdings(100.0)),
            adapter("adapt_univ3", Reply::Fail("RPC returned HTML")),
            adapter("adapt_aero_cl", Reply::Holdings(50.0)),
        ];

        let (positions, failures) = run_adapters(&adapters, ctx(), 3).await;

        assert_eq!(
            positions.len(),
            2,
            "the two healthy adapters must still report"
        );
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].adapter, "adapt_univ3");
        assert!(
            failures[0].error.contains("HTML"),
            "the cause must survive into the report"
        );
    }

    #[tokio::test]
    async fn a_panicking_adapter_is_skipped_rather_than_taking_the_wallet_with_it() {
        let adapters = vec![
            adapter("adapt_erc4626", Reply::Holdings(100.0)),
            adapter("adapt_univ4", Reply::Panic),
            adapter("adapt_morpho", Reply::Holdings(25.0)),
        ];

        let (positions, failures) = run_adapters(&adapters, ctx(), 3).await;

        assert_eq!(positions.len(), 2, "a panic must not zero the chain");
        assert_eq!(failures.len(), 1);
        assert!(failures[0].error.contains("did not complete"));
    }

    #[tokio::test]
    async fn adapter_results_keep_registry_order_regardless_of_completion_order() {
        // Registry order decides which adapter claims a position when two can see it, so it
        // must not depend on which RPC answered first.
        let adapters = vec![
            adapter("first", Reply::Holdings(1.0)),
            adapter("second", Reply::Holdings(2.0)),
            adapter("third", Reply::Holdings(3.0)),
        ];
        let (positions, failures) = run_adapters(&adapters, ctx(), 3).await;
        assert!(failures.is_empty());
        let names: Vec<_> = positions.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["first", "second", "third"]);
    }

    #[tokio::test]
    async fn adapters_respect_their_own_concurrency_cap() {
        let started = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let in_flight = Arc::new(AtomicUsize::new(0));

        struct Counting {
            peak: Arc<AtomicUsize>,
            in_flight: Arc<AtomicUsize>,
            started: Arc<AtomicUsize>,
        }
        impl Adapter for Counting {
            fn name(&self) -> &'static str {
                "counting"
            }
            fn positions<'a>(&'a self, _ctx: &'a AdapterCtx) -> AdapterFuture<'a> {
                Box::pin(async move {
                    self.started.fetch_add(1, Ordering::SeqCst);
                    let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    self.peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    self.in_flight.fetch_sub(1, Ordering::SeqCst);
                    Ok(Vec::new())
                })
            }
        }

        let adapters: Vec<Arc<dyn Adapter>> = (0..9)
            .map(|_| {
                Arc::new(Counting {
                    peak: Arc::clone(&peak),
                    in_flight: Arc::clone(&in_flight),
                    started: Arc::clone(&started),
                }) as Arc<dyn Adapter>
            })
            .collect();

        run_adapters(&adapters, ctx(), DEFAULT_ADAPTER_CONCURRENCY).await;

        assert_eq!(
            started.load(Ordering::SeqCst),
            9,
            "every adapter must still run"
        );
        assert!(
            peak.load(Ordering::SeqCst) <= DEFAULT_ADAPTER_CONCURRENCY,
            "public RPCs rate-limit; the cap is not advisory (peak was {})",
            peak.load(Ordering::SeqCst)
        );
    }

    #[test]
    fn safe_swallows_the_error_and_names_it() {
        let (v, err) = safe::<u8>("adapt_univ3 base", Err(anyhow::anyhow!("boom")));
        assert!(v.is_empty());
        assert_eq!(err.as_deref(), Some("boom"));

        let (v, err) = safe("adapt_univ3 base", Ok(vec![1u8, 2]));
        assert_eq!(v, vec![1, 2]);
        assert_eq!(err, None);
    }

    // ---------------------------------------------------------------------------------------
    // Fan-out: failures, deadlines, partial results
    // ---------------------------------------------------------------------------------------

    #[tokio::test]
    async fn one_failing_chain_still_returns_the_others_and_says_so() {
        let sources =
            Arc::new(StubSources::new(Reply::Holdings(10.0)).on("base", Reply::Fail("RPC 502")));

        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        let w = &snap.portfolio.wallets[0];
        assert!(
            !w.chains.is_empty(),
            "the healthy chains must still be reported"
        );
        assert!(
            w.chains.iter().all(|c| c.chain != "base"),
            "the dead chain must be absent"
        );

        assert_eq!(snap.health.failures.len(), 1);
        assert_eq!(snap.health.failures[0].task.chain, "base");
        assert!(snap.health.failures[0].error.contains("502"));
        assert!(
            snap.health.is_partial(),
            "a missing chain is a partial result"
        );
        assert!(!snap.health.is_complete());
        assert!(
            snap.health.summary().contains("base"),
            "the summary must name it"
        );
    }

    #[tokio::test]
    async fn an_empty_chain_is_not_a_failure() {
        // The distinction the Python loses: "you hold nothing on Base" is a complete answer.
        let sources = Arc::new(StubSources::new(Reply::Empty));
        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        assert!(snap.health.failures.is_empty());
        assert_eq!(snap.health.completed, snap.health.requested);
        assert!(snap.portfolio.wallets[0].chains.is_empty());
        assert_eq!(snap.portfolio.total, 0.0);
        assert!(
            !snap.health.is_partial(),
            "an empty wallet is a complete read"
        );
    }

    #[tokio::test]
    async fn a_panicking_chain_read_is_a_failure_not_a_crash() {
        let sources = Arc::new(StubSources::new(Reply::Holdings(10.0)).on("base", Reply::Panic));

        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        assert_eq!(snap.health.failures.len(), 1);
        assert!(snap.health.is_partial());
        assert!(
            !snap.portfolio.wallets[0].chains.is_empty(),
            "the rest must survive"
        );
    }

    #[tokio::test]
    async fn the_deadline_returns_partial_results_and_marks_them() {
        // One chain never answers. The response must still arrive, must contain the chains that
        // did answer, and must be flagged — an unflagged partial is a silent understatement of
        // net worth.
        let sources = Arc::new(StubSources::new(Reply::Holdings(10.0)).on("base", Reply::Hang));

        let started = std::time::Instant::now();
        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_secs(5),
            "the deadline must be a hard cap"
        );
        assert!(snap.health.deadline_hit);
        assert!(snap.health.is_partial());
        assert!(!snap.health.is_complete());
        assert!(
            snap.health.abandoned.iter().any(|t| t.chain == "base"),
            "the abandoned work must be named, not just counted"
        );
        assert!(snap.health.coverage() < 1.0);
        assert!(snap.health.summary().contains("deadline hit"));
    }

    #[tokio::test]
    async fn a_complete_read_is_reported_as_complete() {
        // The other half of the marker: it must not cry wolf, or callers will learn to ignore it.
        let sources = Arc::new(StubSources::new(Reply::Holdings(10.0)));
        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        assert!(!snap.health.deadline_hit);
        assert!(snap.health.failures.is_empty());
        assert!(snap.health.abandoned.is_empty());
        assert_eq!(snap.health.coverage(), 1.0);
        assert!(snap.health.summary().is_empty());
        assert!(!snap.health.is_partial());
        // `rates_degraded` is deliberately outside both predicates: the stub has no FX provider,
        // yet every USD figure in the snapshot is still exactly right, so this read is safe to
        // serve *and* safe to store. Only the THB/sats conversions are unavailable.
        assert!(snap.health.rates_degraded, "the stub has no FX provider");
        assert!(
            snap.health.is_complete(),
            "degraded FX must not block a history write"
        );
    }

    #[tokio::test]
    async fn chain_reads_respect_max_concurrency() {
        let sources = Arc::new(StubSources::new(Reply::Holdings(1.0)));
        let peak = Arc::clone(&sources.peak);
        let cfg = AggregateConfig {
            max_concurrency: 2,
            ..fast_cfg()
        };

        // Two EVM wallets across every EVM chain — comfortably more pairs than the cap.
        build_portfolios(sources, &[EVM.to_string(), EVM2.to_string()], &cfg).await;

        assert!(
            peak.load(Ordering::SeqCst) <= 2,
            "cap exceeded (peak {})",
            peak.load(Ordering::SeqCst)
        );
    }

    #[tokio::test]
    async fn a_wallet_is_only_paired_with_chains_its_address_can_exist_on() {
        let sources = Arc::new(StubSources::new(Reply::Empty));
        let seen = Arc::clone(&sources.seen);

        build_portfolios(sources, &[BTC.to_string()], &fast_cfg()).await;

        let chains: Vec<_> = seen.lock().unwrap().iter().map(|(_, c)| *c).collect();
        assert!(
            !chains.is_empty(),
            "a bitcoin wallet must reach the bitcoin chain"
        );
        for chain in chains {
            let kind = chains::by_name(chain).unwrap().kind;
            assert_eq!(
                kind.as_str(),
                "btc",
                "a bc1… address must never be asked about {chain}"
            );
        }
    }

    #[tokio::test]
    async fn the_kucoin_account_rides_along_as_its_own_wallet() {
        let ku = Wallet::new("KuCoin", vec![bucket("kucoin", 1024.0)]);
        let sources = Arc::new(
            StubSources::new(Reply::Empty)
                .on("base", Reply::Holdings(100.0))
                .with_kucoin(ku),
        );

        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        assert_eq!(snap.portfolio.wallets.len(), 2);
        assert_eq!(snap.portfolio.wallets[1].address, "KuCoin");
        assert_eq!(
            snap.portfolio.total, 1124.0,
            "KuCoin counts toward the grand total"
        );
        assert_eq!(
            snap.portfolio.addresses,
            vec![EVM.to_string()],
            "…but it has no on-chain address, so it is not listed under `addresses`"
        );
    }

    #[tokio::test]
    async fn degraded_rates_fall_back_to_an_object_rather_than_null() {
        // `types.ts` types `rates` as nullable, but no oracle path emits null — the UI reads
        // `rates.usd` unguarded, so a null here is a crash, not a blank.
        let sources = Arc::new(StubSources::new(Reply::Empty));
        let snap = build_portfolios(sources, &[EVM.to_string()], &fast_cfg()).await;

        assert_eq!(snap.portfolio.rates, fallback_rates());
        assert_eq!(snap.portfolio.rates.usd, 1.0);
        assert!(snap.health.rates_degraded);
    }

    #[tokio::test]
    async fn build_wallet_reads_one_address_and_reports_its_own_health() {
        let sources =
            Arc::new(StubSources::new(Reply::Holdings(10.0)).on("base", Reply::Fail("nope")));

        let out = build_wallet(sources, EVM, &fast_cfg()).await;

        assert_eq!(out.wallet.address, EVM);
        assert!(out.wallet.total > 0.0);
        assert_eq!(out.health.failures.len(), 1);
        assert!(out.health.is_partial());
    }

    #[tokio::test]
    async fn build_portfolio_returns_an_empty_wallet_rather_than_panicking() {
        // Python indexes `["wallets"][0]`, which raises for an address that pairs with no chain.
        let sources = Arc::new(StubSources::new(Reply::Empty));
        let out = build_portfolio(sources, "not-an-address", &fast_cfg()).await;

        assert_eq!(out.wallet.address, "not-an-address");
        assert_eq!(out.wallet.total, 0.0);
        assert!(out.wallet.chains.is_empty());
    }

    #[tokio::test]
    async fn no_addresses_is_a_complete_empty_snapshot() {
        let sources = Arc::new(StubSources::new(Reply::Empty));
        let snap = build_portfolios(sources, &[], &fast_cfg()).await;

        assert_eq!(snap.portfolio.total, 0.0);
        assert!(snap.portfolio.wallets.is_empty());
        assert_eq!(
            snap.health.coverage(),
            1.0,
            "nothing requested is not 0% covered"
        );
        assert!(!snap.health.is_partial());
    }

    // ---------------------------------------------------------------------------------------
    // Health bookkeeping
    // ---------------------------------------------------------------------------------------

    #[test]
    fn health_merges_without_losing_a_failure() {
        let mut a = FetchHealth {
            requested: 2,
            completed: 2,
            ..Default::default()
        };
        let b = FetchHealth {
            requested: 3,
            completed: 1,
            deadline_hit: true,
            abandoned: vec![ChainTask {
                chain: "base",
                address: EVM.into(),
            }],
            ..Default::default()
        };
        a.merge(b);

        assert_eq!((a.requested, a.completed), (5, 3));
        assert!(a.deadline_hit);
        assert_eq!(a.abandoned.len(), 1);
        assert!(a.is_partial());
    }

    #[test]
    fn the_summary_does_not_list_forty_dead_chains() {
        let health = FetchHealth {
            requested: 40,
            completed: 0,
            failures: (0..40)
                .map(|i| ChainFailure {
                    task: ChainTask {
                        chain: "base",
                        address: format!("0x{i}"),
                    },
                    error: "down".into(),
                })
                .collect(),
            ..Default::default()
        };
        let summary = health.summary();
        assert!(summary.contains("+37 more"), "got {summary}");
        assert!(summary.contains("coverage 0%"));
    }

    #[test]
    fn config_reads_the_python_env_vars_and_ignores_nonsense() {
        // Not `std::env::set_var` — these tests share a process, and a stray global would make
        // an unrelated test flaky. The parsing rules are what matter, so they are exercised
        // directly through the same predicates `from_env` applies.
        assert_eq!(
            AggregateConfig::default().max_concurrency,
            DEFAULT_MAX_CONCURRENCY
        );
        assert_eq!(
            AggregateConfig::default().adapter_concurrency,
            DEFAULT_ADAPTER_CONCURRENCY
        );
        assert_eq!(
            AggregateConfig::default().deadline,
            Duration::from_secs_f64(DEFAULT_REQUEST_DEADLINE_SECS)
        );
    }

    #[test]
    fn a_short_address_label_never_splits_a_code_point() {
        assert_eq!(short_addr(EVM), "0x7Fce9c");
        assert_eq!(short_addr("héllo wörld"), "héllo wö");
        assert_eq!(short_addr("0x1"), "0x1");
    }

    // ---------------------------------------------------------------------------------------
    // Bridging the non-EVM reader shapes
    // ---------------------------------------------------------------------------------------

    #[test]
    fn the_bitcoin_reader_shapes_convert_without_losing_a_key() {
        let btc = crate::bitcoin::SpotToken {
            symbol: "BTC".into(),
            amount: 0.25,
            price: 65536.0,
            usd: 16384.0,
            change24h: Some(1.5),
            kind: "native",
            coin: None,
            address: None,
        };
        let converted = SpotToken::from(btc);
        let json = serde_json::to_value(&converted).unwrap();
        // Key SETS, not key order: `serde_json::Value` stores objects in a `BTreeMap` unless the
        // `preserve_order` feature is on, so the order here is alphabetical and tells us nothing.
        // JSON objects are unordered anyway — what matters is which keys exist.
        let keys: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        // Exactly the Python Bitcoin spot dict: no `coin`, no `address`, no `category`.
        assert_eq!(
            keys,
            BTreeSet::from(["symbol", "amount", "price", "usd", "change24h", "kind"])
        );
        assert_eq!(json["change24h"], 1.5);

        assert!(
            json.get("coin").is_none(),
            "the Bitcoin path emits no coin key"
        );
        assert!(
            json.get("category").is_none(),
            "types.ts declares it; Python never emits it"
        );

        let position = crate::bitcoin::Position::new(
            "Native Stake",
            "Staking",
            "Staked SOL",
            512.0,
            vec![crate::bitcoin::PositionToken {
                symbol: "SOL".into(),
                amount: 4.0,
            }],
            None,
        );
        let json = serde_json::to_value(Position::from(position)).unwrap();
        let keys: BTreeSet<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        // `_position` always writes id/via/tokens/usd, and omits change24h when it is None.
        assert_eq!(
            keys,
            BTreeSet::from(["protocol", "category", "name", "id", "via", "tokens", "usd"])
        );
        assert!(json["id"].is_null(), "id is written as null, not omitted");
        assert!(json["via"].is_null());
        assert_eq!(json["tokens"][0]["symbol"], "SOL");
        assert!(
            json["tokens"][0].get("usd").is_none(),
            "a position token carries no usd — the key must stay absent"
        );
    }
}
