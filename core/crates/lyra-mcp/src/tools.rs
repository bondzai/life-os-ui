//! Tool definitions and their bodies — port of the `@mcp.tool` surface in `mcp_server.py`.
//!
//! Two rules shape everything here, both inherited from `pow_mcp/DESIGN.md`:
//!
//! 1. **Nothing in this file can move funds.** Every tool reads; the single exception,
//!    `save_analysis`, appends *text* to the user's own journal. The only "action" any tool can
//!    emit is a proposal plus a host-pinned vfat deep link the user follows themselves. That is
//!    a property of the registry below — [`registry`] is a plain value, so a test can enumerate
//!    the entire capability surface and assert on it, which is the point.
//! 2. **Honest-only.** Derived numbers are returned inside the `{value, confidence, data_gaps}`
//!    envelope from `lyra-analytics`; a metric the snapshot cannot support is null-with-reason.
//!    Tools never substitute a zero for an unknown.
//!
//! The desk depends on three narrow traits rather than on a portfolio engine — [`PortfolioSource`],
//! [`MarketSource`] and [`AnalysisStore`]. Everything above them is pure assembly, so the whole
//! tool surface is testable against a double with no chain, no HTTP and no database.

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use lyra_analytics::envelope::{
    Confidence, Metric, TokenAmount, emission_dependency, fee_split, round_dp,
};
use lyra_analytics::exposure::{DefiPosition, concentration, exposure_map};
use lyra_analytics::tiers::{Holding, TIER_ORDER, TierTargets, rebalance_plan};

use crate::server::{sanitize_label, vfat_deeplink};

/// Bumped when the agent-facing contract changes. Mirrors `pow_mcp.SCHEMA_VERSION`.
pub const SCHEMA_VERSION: &str = "0.3";

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/// Why a tool could not answer.
///
/// These are *tool* failures, not protocol failures: they come back to the model as a normal
/// result with `isError: true`, so it can read the reason and correct itself, exactly as the
/// FastMCP `ToolError` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolError {
    /// The model asked for something that does not exist, or passed a bad argument.
    InvalidInput(String),
    /// A backing source could not answer right now (network, database, missing config).
    Unavailable(String),
}

impl ToolError {
    pub fn message(&self) -> &str {
        match self {
            ToolError::InvalidInput(m) | ToolError::Unavailable(m) => m,
        }
    }
}

impl std::fmt::Display for ToolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ToolError {}

// ---------------------------------------------------------------------------------------------
// The narrow input model — what the tools need, and nothing else
// ---------------------------------------------------------------------------------------------

/// What the fetch actually reached. `partial` stays `None` until the engine surfaces per-chain
/// failures — an unknown that is reported as unknown rather than guessed at.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Coverage {
    #[serde(default)]
    pub chains_seen: Vec<String>,
    #[serde(default)]
    pub wallets: usize,
    #[serde(default)]
    pub partial: Option<bool>,
}

/// One token leg with its on-chain amount. `usd` is `None` when the engine could not price it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PositionToken {
    pub symbol: String,
    #[serde(default)]
    pub amount: f64,
    #[serde(default)]
    pub usd: Option<f64>,
}

impl PositionToken {
    /// The reduced form the analytics maths takes.
    fn as_token_amount(&self) -> TokenAmount {
        TokenAmount::new(self.symbol.clone(), self.usd)
    }
}

/// A concentrated-liquidity price band, oriented by `base`/`quote` (never token0/token1).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PriceBand {
    #[serde(default)]
    pub lower: Option<f64>,
    #[serde(default)]
    pub upper: Option<f64>,
    #[serde(default)]
    pub cur: Option<f64>,
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub quote: Option<String>,
    /// A full-range position is always earning and can never be "out" — it gets its own state.
    #[serde(default)]
    pub full: bool,
}

/// One asset row of the book, as the Capital Ladder sees it.
///
/// The adapter should supply these the way Python's `analysis.holdings()` does: spot tokens plus
/// non-lending DeFi positions, **already filtered to `usd > 0`**, with lending lines excluded
/// (they are netted through [`LendingPosition::net_usd`] instead, never double-counted).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PortfolioHolding {
    #[serde(default)]
    pub symbol: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    pub usd: f64,
    /// Fractional 24h change (0.05 = +5%), or `None` when the engine has no price history for it.
    #[serde(default)]
    pub change_24h: Option<f64>,
}

impl PortfolioHolding {
    fn as_holding(&self) -> Holding {
        Holding {
            symbol: self.symbol.clone(),
            category: self.category.clone(),
            usd: self.usd,
            tier: None,
        }
    }
}

/// One concentrated-liquidity position.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LpPosition {
    #[serde(default)]
    pub id: Option<String>,
    /// Untrusted on-chain label. Sanitized on the way out and surfaced in a `*_raw` field so the
    /// model treats it as data, never as instructions.
    pub pair_raw: String,
    pub protocol: String,
    pub chain: String,
    pub value_usd: f64,
    /// Claimable rewards, both swap-fee and emission legs bundled — the split is derived.
    #[serde(default)]
    pub claimable_usd: f64,
    #[serde(default)]
    pub tokens: Vec<PositionToken>,
    #[serde(default)]
    pub rewards: Vec<PositionToken>,
    #[serde(default)]
    pub in_range: Option<bool>,
    #[serde(default)]
    pub price_band: Option<PriceBand>,
    /// Protocol-advertised, forward-looking APR. Never a realized fee APR.
    #[serde(default)]
    pub advertised_apr: Option<f64>,
}

/// One borrow position's liquidation health.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LendingPosition {
    pub protocol: String,
    pub chain: String,
    /// Health factor; `None` means no active debt — nothing to liquidate.
    #[serde(default)]
    pub hf: Option<f64>,
    #[serde(default)]
    pub collateral_usd: f64,
    #[serde(default)]
    pub debt_usd: f64,
    /// This position's exact net-worth contribution (Aave −debt; Compound/Morpho collateral−debt).
    #[serde(default)]
    pub net_usd: f64,
}

/// One trading bot, with its engine-shaped detail passed through untouched.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BotRow {
    pub protocol: String,
    #[serde(default)]
    pub name: Option<String>,
    pub value_usd: f64,
    #[serde(default)]
    pub change_24h: Option<f64>,
    #[serde(default)]
    pub pnl_usd: Option<f64>,
    #[serde(default)]
    pub pnl_pct: Option<f64>,
    /// Per-sub-bot breakdown, forwarded as-is. Credentials must never reach this field; the
    /// egress scrub in `server.rs` is the backstop that proves it.
    #[serde(default)]
    pub detail: Value,
}

/// A candidate pool from the yield radar.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PoolCandidate {
    pub pair_raw: String,
    #[serde(default)]
    pub protocol: Option<String>,
    #[serde(default)]
    pub chain: Option<String>,
    #[serde(default)]
    pub chain_id: Option<i64>,
    #[serde(default)]
    pub tvl_usd: Option<f64>,
    #[serde(default)]
    pub fee: Option<f64>,
    /// Advertised APR as a fraction (0.3 = 30%).
    #[serde(default)]
    pub apr: Option<f64>,
}

/// One coherent view of the book. Every tool call resolves exactly one of these, so a multi-tool
/// analysis reasons over a single consistent moment rather than a drifting one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    /// Unix seconds when the snapshot was taken.
    pub as_of: i64,
    /// Short fingerprint: the same value means the same underlying book.
    pub hash: String,
    /// The addresses actually fetched. Used only to pick EVM wallets for the yield radar.
    #[serde(default)]
    pub addrs: Vec<String>,
    #[serde(default)]
    pub coverage: Coverage,
    #[serde(default)]
    pub holdings: Vec<PortfolioHolding>,
    #[serde(default)]
    pub positions: Vec<LpPosition>,
    #[serde(default)]
    pub lending: Vec<LendingPosition>,
    #[serde(default)]
    pub bots: Vec<BotRow>,
    /// Spot legs for the exposure unwrap.
    #[serde(default)]
    pub spot: Vec<TokenAmount>,
    /// DeFi legs for the exposure unwrap — the same positions as above, in the shape the unwrap
    /// needs. Supplied separately because exposure is coin-level while `positions` is
    /// position-level; the adapter derives both from one walk of the wallet tree.
    #[serde(default)]
    pub defi: Vec<DefiPosition>,
}

impl Snapshot {
    /// Gross assets — the Capital Ladder base, before debt.
    pub fn asset_total(&self) -> f64 {
        self.holdings.iter().map(|h| h.usd).sum()
    }

    /// Sum of each lending position's net-worth contribution (negative when debt dominates).
    pub fn lending_net(&self) -> f64 {
        self.lending.iter().map(|r| r.net_usd).sum()
    }

    /// Net worth = gross assets + borrow net. Debt is subtracted, never ignored.
    pub fn net_worth(&self) -> f64 {
        self.asset_total() + self.lending_net()
    }

    fn envelope(&self) -> Value {
        json!({
            "as_of": self.as_of,
            "snapshot": self.hash,
            "schema_version": SCHEMA_VERSION,
            "coverage": self.coverage,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The seams the desk depends on
// ---------------------------------------------------------------------------------------------

/// The data room: one coherent, cached portfolio snapshot per call.
///
/// `wallets` is the raw user string (space/comma-separated `0x…` and/or `bc1…`); an empty string
/// means "use the configured default". Implementations own address parsing, caching and
/// coherence — the tools never touch the chain.
pub trait PortfolioSource: Send + Sync {
    fn snapshot(&self, wallets: &str) -> impl Future<Output = Result<Snapshot, ToolError>> + Send;
}

/// Keyless market context — the calls that need no wallet at all.
pub trait MarketSource: Send + Sync {
    /// fx rates (USD/THB/BTC), passed through as the engine shapes them.
    fn rates(&self) -> impl Future<Output = Result<Value, ToolError>> + Send;
    /// Fear & Greed plus the valuation models.
    fn sentiment(&self) -> impl Future<Output = Result<Value, ToolError>> + Send;
    /// Thai mutual-fund NAV by fund code.
    fn fund_nav(&self, code: &str) -> impl Future<Output = Result<Value, ToolError>> + Send;
    /// Higher-APR pools for tokens this address already holds.
    fn yield_radar(
        &self,
        address: &str,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<PoolCandidate>, ToolError>> + Send;
}

/// What the model wants to persist. The server stamps the anchor itself, so the model cannot
/// misrepresent which book it was looking at.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AnalysisDraft {
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub body_md: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub structured: Option<Value>,
    pub author: String,
}

/// The data state an analysis was written against — stamped server-side, so it cannot be faked.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AnalysisAnchor {
    pub as_of: i64,
    pub snapshot: String,
    #[serde(default)]
    pub coverage: Coverage,
    pub net_worth_usd: f64,
}

/// One stored analysis. `superseded_by` is null on the latest version of a scope.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AnalysisRecord {
    pub id: String,
    pub scope: String,
    pub version: i64,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub summary: Option<String>,
    /// UNTRUSTED model-authored markdown — render escaped, never execute.
    pub body_md: String,
    #[serde(default)]
    pub structured: Option<Value>,
    #[serde(default)]
    pub author: Option<String>,
    pub source: String,
    pub created_at: i64,
    #[serde(default)]
    pub net_worth_usd: Option<f64>,
    #[serde(default)]
    pub anchor: Option<AnalysisAnchor>,
    #[serde(default)]
    pub superseded_by: Option<String>,
}

/// Which analyses to list.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalysisQuery {
    pub scope: Option<String>,
    pub kind: Option<String>,
    /// Only the newest version per scope (the default view).
    pub latest_only: bool,
    pub limit: usize,
}

/// The append-only analysis journal.
///
/// The one thing on the desk that writes — and it writes *text*, versioned and append-only.
/// Implementations must never overwrite: saving the same scope creates a new version and
/// supersedes the prior one.
pub trait AnalysisStore: Send + Sync {
    fn save(
        &self,
        draft: AnalysisDraft,
        anchor: AnalysisAnchor,
    ) -> impl Future<Output = Result<AnalysisRecord, ToolError>> + Send;
    fn list(
        &self,
        query: AnalysisQuery,
    ) -> impl Future<Output = Result<Vec<AnalysisRecord>, ToolError>> + Send;
    fn get(
        &self,
        id: &str,
    ) -> impl Future<Output = Result<Option<AnalysisRecord>, ToolError>> + Send;
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

/// One tool as the protocol advertises it.
///
/// `read_only` is the load-bearing field: it becomes `annotations.readOnlyHint` on the wire, and
/// a test asserts that exactly one tool in the registry is not read-only. Annotations are a hint
/// to the client — the structural control is that no tool body has a signing path at all.
///
/// The schema is a function pointer rather than a lazily-built value so the registry stays a
/// `const`-shaped list with no start-up work and no interior mutability. (No `PartialEq`: two
/// function pointers can compare equal or unequal for reasons unrelated to the tools.)
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: fn() -> Value,
    pub read_only: bool,
}

impl ToolDef {
    /// The `tools/list` entry for this tool.
    pub fn to_wire(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": (self.input_schema)(),
            "annotations": {
                "readOnlyHint": self.read_only,
                // Nothing here can destroy state: the journal is append-only and everything
                // else is a read. This is true of `save_analysis` too.
                "destructiveHint": false,
                "openWorldHint": true,
            },
        })
    }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

const WALLETS_DESC: &str = "Wallet addresses, space/comma-separated (0x… and/or bc1…). Omit to \
use the server's configured wallets.";

fn wallets_only_schema() -> Value {
    schema(
        json!({ "wallets": { "type": "string", "description": WALLETS_DESC } }),
        &[],
    )
}

fn no_args_schema() -> Value {
    schema(json!({}), &[])
}

fn get_position_schema() -> Value {
    schema(
        json!({
            "id": { "type": "string",
                    "description": "Position id from get_portfolio's positions_index." },
            "wallets": { "type": "string", "description": WALLETS_DESC },
        }),
        &["id"],
    )
}

fn list_opportunities_schema() -> Value {
    schema(
        json!({
            "wallets": { "type": "string", "description": WALLETS_DESC },
            "min_apr": { "type": "number", "minimum": 0,
                         "description": "Filter on advertised APR, same fraction scale as the \
                                         field (0.3 = 30%)." },
            "limit": { "type": "integer", "minimum": 0,
                       "description": "Max pools to return; 0 uses the server default." },
        }),
        &[],
    )
}

fn get_fund_nav_schema() -> Value {
    schema(
        json!({
            "code": { "type": "string",
                      "description": "Thai fund code, e.g. \"K-GOLD-A(D)\"." },
        }),
        &[],
    )
}

fn save_analysis_schema() -> Value {
    schema(
        json!({
            "scope": { "type": "string",
                       "description": "Subject key '<namespace>:<id>' — strategy:<grp> | \
                                       position:<chain>:<id> | market:global | general:<slug>. \
                                       Reuse a scope to add a new version." },
            "kind": { "type": "string",
                      "enum": ["strategy_review", "position_note", "market_thesis", "risk_flag",
                               "general"] },
            "title": { "type": "string" },
            "body_md": { "type": "string",
                         "description": "Your full analysis in markdown. Separate fact from \
                                         opinion, cite external claims, carry through \
                                         {confidence, data_gaps}." },
            "summary": { "type": "string" },
            "structured": { "type": "object",
                            "description": "Optional machine-readable payload, e.g. \
                                            {conviction, actions, evidence, risks, \
                                            change_my_mind, tags}." },
            "author": { "type": "string" },
            "wallets": { "type": "string", "description": WALLETS_DESC },
        }),
        &["scope", "kind", "title", "body_md"],
    )
}

fn list_analyses_schema() -> Value {
    schema(
        json!({
            "scope": { "type": "string" },
            "kind": { "type": "string" },
            "limit": { "type": "integer", "minimum": 1 },
            "include_history": { "type": "boolean",
                                 "description": "Include superseded versions (default false: \
                                                 latest per scope only)." },
            "wallets": { "type": "string", "description": WALLETS_DESC },
        }),
        &[],
    )
}

fn get_analysis_schema() -> Value {
    schema(
        json!({ "id": { "type": "string", "description": "Record id from list_analyses." } }),
        &["id"],
    )
}

/// Every tool this server exposes — the complete capability surface, as a value.
///
/// Deliberately enumerable: a test walks this list and asserts that exactly one entry is not
/// read-only, that the one write is the append-only journal, and that no entry accepts anything
/// resembling a signing input. That is a much stronger statement than "we did not write a
/// trading tool", and it stays true as the list grows.
pub fn registry() -> &'static [ToolDef] {
    &[
        ToolDef {
            name: "get_portfolio",
            description: "Summary-first portfolio view: net worth, value-weighted 24h change, \
                Capital Ladder tier breakdown + drift-to-target, total claimable LP rewards, and \
                an INDEX of LP positions (id, pair, chain, value, range state). Drill into any \
                position with get_position(id). Off-chain manual assets are not included.",
            input_schema: wallets_only_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_position",
            description: "Full detail + honest analytics for ONE concentrated-liquidity position \
                (use the `id` from get_portfolio's positions_index): token amounts, tri-state \
                range with distance to the nearest edge, claimable rewards split into swap-fees \
                vs farm-emissions, emission-dependence, advertised APR (never presented as a \
                realized fee APR), risk flags, and a vfat deep-link to act. Impermanent loss and \
                break-even are NOT returned — they need entry price / gas the keyless snapshot \
                lacks.",
            input_schema: get_position_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_exposures",
            description: "True underlying-asset exposure: every basket, LP pair and bot unwrapped \
                into the coins you actually hold, summed across the book — plus concentration \
                (HHI over underlying assets, top-asset share, stablecoin share). Coin-level \
                exposure, not the position-level view.",
            input_schema: wallets_only_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_trading_bots",
            description: "Trading bots, full breakdown: the spot rebalance basket (per-coin \
                amount, USD, weight → Tier III Investment & Income) and the AI futures bots \
                (equity, unrealised PnL, margin in use, per-sub-bot rows → Tier IV High Risk). \
                Read-only; API keys never leave the server.",
            input_schema: wallets_only_schema,
            read_only: true,
        },
        ToolDef {
            name: "list_opportunities",
            description: "Higher-APR pools for tokens you already hold in vfat LPs (the yield \
                radar), across your EVM wallets. `min_apr` filters on advertised APR (same \
                fraction scale as the field, e.g. 0.3 = 30%). Advertised APRs are \
                incentive-driven and volatile — a scouting list, not a recommendation.",
            input_schema: list_opportunities_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_market_context",
            description: "Keyless market context (no wallet needed): fx rates (USD/THB/BTC) and \
                crypto valuation models — Fear & Greed, MVRV Z-Score, BTC rainbow band, \
                Stock-to-Flow, SOPR, Puell Multiple. Models for framing, not advice.",
            input_schema: no_args_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_fund_nav",
            description: "Live NAV (THB per unit) of a Thai mutual fund via WealthMagik, e.g. the \
                K-GOLD gold fund. Pass a fund code like \"K-GOLD-A(D)\".",
            input_schema: get_fund_nav_schema,
            read_only: true,
        },
        ToolDef {
            name: "save_analysis",
            description: "Persist YOUR analysis to the user's server so it survives the session. \
                APPEND-ONLY + VERSIONED: saving the same `scope` again creates a new version and \
                supersedes the prior one (history is kept, never overwritten). This is the only \
                tool that writes — and it writes DATA only; it cannot sign, trade or move funds. \
                The record is anchored SERVER-SIDE to the current snapshot (as_of / hash / net \
                worth), so it is honest about what you were looking at and you cannot fake that \
                context. Pass the SAME `wallets` you analyzed so the anchor matches.",
            input_schema: save_analysis_schema,
            read_only: false,
        },
        ToolDef {
            name: "list_analyses",
            description: "List saved analyses, newest first — recall your prior reasoning and \
                build on it. By default returns only the LATEST version per scope; set \
                include_history=true to see superseded versions. Filter by `scope` and/or `kind`. \
                Each record is anchored to the snapshot it saw — re-verify against current data \
                before acting on old conclusions.",
            input_schema: list_analyses_schema,
            read_only: true,
        },
        ToolDef {
            name: "get_analysis",
            description: "Fetch one saved analysis in full by its `id` (from list_analyses): the \
                complete markdown body, structured payload, and the data anchor it was written \
                against.",
            input_schema: get_analysis_schema,
            read_only: true,
        },
    ]
}

/// Look a tool up by name.
pub fn find(name: &str) -> Option<&'static ToolDef> {
    registry().iter().find(|t| t.name == name)
}

// ---------------------------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------------------------

/// Server-side tunables. No wallet address is ever baked in — wallets come from configuration or
/// the per-call argument, nothing else.
#[derive(Debug, Clone, PartialEq)]
pub struct DeskConfig {
    pub default_wallets: String,
    pub tier_targets: TierTargets,
    pub radar_limit: usize,
    pub analysis_list_limit: usize,
}

impl Default for DeskConfig {
    fn default() -> Self {
        Self {
            default_wallets: String::new(),
            tier_targets: TierTargets::default(),
            radar_limit: 8,
            analysis_list_limit: 20,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The desk
// ---------------------------------------------------------------------------------------------

/// The research desk: tool bodies over the three seams.
///
/// Generic rather than boxed so the futures stay `Send` and the whole thing monomorphizes to
/// direct calls — and so a test double is an ordinary struct, not a mock framework.
pub struct Desk<P, M, A> {
    portfolio: P,
    market: M,
    analyses: A,
    config: DeskConfig,
}

/// Argument helpers. Missing optional arguments take the Python default rather than erroring,
/// which is what FastMCP does for a defaulted parameter.
fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn arg_f64(args: &Value, key: &str) -> f64 {
    args.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn arg_usize(args: &Value, key: &str) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|v| v as usize)
        .unwrap_or(0)
}

fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn required_str(args: &Value, key: &str) -> Result<String, ToolError> {
    match args.get(key).and_then(Value::as_str) {
        Some(s) if !s.is_empty() => Ok(s.to_string()),
        _ => Err(ToolError::InvalidInput(format!(
            "missing required argument {key:?}"
        ))),
    }
}

/// Advertised APR, wrapped honestly: it is forward-looking marketing from the protocol, so it
/// ships at low confidence with the gap spelled out, and its absence is null-with-reason.
fn apr_metric(apr: Option<f64>, note: &str) -> Metric {
    match apr {
        None => Metric::unavailable("ratio", &["no advertised APR on this position"], None),
        Some(apr) => Metric::of(
            apr,
            "ratio",
            Confidence::Low,
            &["advertised / forward-looking — NOT a realized fee APR"],
            Some(note),
        ),
    }
}

/// Tri-state range, from `in_range` plus the band's full-range marker.
///
/// A full-range position is never "out of range", and a position with no band at all is
/// `unknown` — not `in_range`. Collapsing either into a boolean is how a dashboard ends up
/// telling someone they are earning fees when they are not.
fn range_state(position: &LpPosition) -> &'static str {
    if position.price_band.as_ref().is_some_and(|b| b.full) {
        return "full_range";
    }
    match position.in_range {
        Some(true) => "in_range",
        Some(false) => "out_of_range",
        None => "unknown",
    }
}

/// Human-readable range position and distance to the nearest edge.
///
/// Port of `analysis.lp_range_detail`. Returns `None` when the band cannot support the maths —
/// missing bounds, or an inverted band — rather than inventing a marker position.
fn range_health(position: &LpPosition) -> Value {
    let state = range_state(position);
    if state == "full_range" {
        return json!({
            "state": state,
            "note": "full-range — always earning, never out of range",
        });
    }
    let band = position.price_band.as_ref();
    let detail = band.and_then(|b| match (b.lower, b.upper, b.cur) {
        (Some(lo), Some(hi), Some(cur)) if hi > lo => Some((b, lo, hi, cur)),
        _ => None,
    });
    let Some((band, lo, hi, cur)) = detail else {
        return json!({ "state": state, "note": "no price band on this position" });
    };

    let out = position.in_range == Some(false);
    let marker = ((cur - lo) / (hi - lo)).clamp(0.0, 1.0) * 100.0;
    let edge = if out {
        if cur < lo {
            format!("{:.1}% below min", ((cur - lo) / lo * 100.0).abs())
        } else {
            format!("{:.1}% above max", ((cur - hi) / hi * 100.0).abs())
        }
    } else {
        let to_low = (cur - lo) / cur * 100.0;
        let to_high = (hi - cur) / cur * 100.0;
        if to_low <= to_high {
            format!("{to_low:.1}% to min")
        } else {
            format!("{to_high:.1}% to max")
        }
    };
    json!({
        "state": state,
        "min": lo,
        "max": hi,
        "now": cur,
        "unit": format!("{}/{}",
                        band.quote.clone().unwrap_or_default(),
                        band.base.clone().unwrap_or_default()),
        "marker_pct": round_dp(marker, 1),
        "distance_to_edge": edge,
    })
}

/// Machine-readable signals for the agent — never verdicts.
fn position_flags(position: &LpPosition, dependency: &Metric) -> Vec<Value> {
    let mut flags = Vec::new();
    if range_state(position) == "out_of_range" {
        flags.push(json!({
            "code": "out_of_range",
            "severity": "warn",
            "message": "out of range — earning no fees until price re-enters or you rebalance",
        }));
    }
    // Only flags when the ratio is actually known: a null emission-dependency means "no rewards
    // to attribute", which is not evidence of a healthy fee mix.
    if let Some(value) = dependency.value
        && value >= 0.6
    {
        flags.push(json!({
            "code": "incentive_dependent",
            "severity": "watch",
            "message": format!("{:.0}% of yield is farm emissions — APR is incentive-dependent",
                               value * 100.0),
        }));
    }
    flags
}

impl<P: PortfolioSource, M: MarketSource, A: AnalysisStore> Desk<P, M, A> {
    pub fn new(portfolio: P, market: M, analyses: A, config: DeskConfig) -> Self {
        Self {
            portfolio,
            market,
            analyses,
            config,
        }
    }

    pub fn config(&self) -> &DeskConfig {
        &self.config
    }

    /// Resolve the wallets argument: the per-call value wins, else the configured default.
    fn wallets<'a>(&'a self, args: &'a Value) -> String {
        let passed = arg_str(args, "wallets");
        if passed.trim().is_empty() {
            self.config.default_wallets.clone()
        } else {
            passed
        }
    }

    /// Dispatch one `tools/call`.
    pub async fn call(&self, name: &str, args: &Value) -> Result<Value, ToolError> {
        match name {
            "get_portfolio" => self.get_portfolio(args).await,
            "get_position" => self.get_position(args).await,
            "get_exposures" => self.get_exposures(args).await,
            "get_trading_bots" => self.get_trading_bots(args).await,
            "list_opportunities" => self.list_opportunities(args).await,
            "get_market_context" => self.get_market_context().await,
            "get_fund_nav" => self.get_fund_nav(args).await,
            "save_analysis" => self.save_analysis(args).await,
            "list_analyses" => self.list_analyses(args).await,
            "get_analysis" => self.get_analysis(args).await,
            other => Err(ToolError::InvalidInput(format!(
                "unknown tool {other:?} — call tools/list for the available tools"
            ))),
        }
    }

    async fn get_portfolio(&self, args: &Value) -> Result<Value, ToolError> {
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let asset_total = snap.asset_total();
        let net = snap.net_worth();

        // Value-weighted 24h change over the holdings that actually have a 24h price. Holdings
        // without one are excluded from BOTH sides of the ratio rather than counted as flat.
        let (mut weighted, mut weight) = (0.0, 0.0);
        for h in &snap.holdings {
            if let Some(change) = h.change_24h {
                weighted += change * h.usd;
                weight += h.usd;
            }
        }
        let change_24h = (weight != 0.0).then(|| round_dp(weighted / weight, 2));

        let claimable: f64 = snap.positions.iter().map(|p| p.claimable_usd).sum();

        let holdings: Vec<Holding> = snap.holdings.iter().map(|h| h.as_holding()).collect();
        let plan = rebalance_plan(&holdings, Some(&self.config.tier_targets));
        let ladder: Vec<Value> = TIER_ORDER
            .iter()
            .zip(&plan.tiers)
            .map(|(tier, row)| {
                json!({
                    "rank": tier.rank(),
                    "tier": tier.label(),
                    "usd": row.value_usd,
                    "pct": if asset_total != 0.0 {
                        round_dp(row.value_usd / asset_total * 100.0, 1)
                    } else {
                        0.0
                    },
                    "what": tier.desc(),
                })
            })
            .collect();
        let drift: Vec<Value> = plan
            .tiers
            .iter()
            .map(|row| {
                json!({
                    "tier": row.label,
                    "now_pct": row.now_pct,
                    "target_pct": row.target_pct,
                    "drift_pct": row.drift_pct,
                    "action": row.action.as_str(),
                    "action_usd": row.action_usd,
                })
            })
            .collect();

        let index: Vec<Value> = snap
            .positions
            .iter()
            .map(|p| {
                let state = range_state(p);
                json!({
                    "id": p.id,
                    "pair_raw": sanitize_label(&p.pair_raw),
                    "protocol": p.protocol,
                    "chain": p.chain,
                    "value_usd": round_dp(p.value_usd, 2),
                    "range_state": state,
                    "flags": if state == "out_of_range" { vec!["out_of_range"] } else { vec![] },
                })
            })
            .collect();

        let hfs: Vec<f64> = snap.lending.iter().filter_map(|r| r.hf).collect();
        let borrow_summary = if snap.lending.is_empty() {
            json!({})
        } else {
            json!({
                "total_debt_usd": round_dp(snap.lending.iter().map(|r| r.debt_usd).sum(), 2),
                "total_collateral_usd":
                    round_dp(snap.lending.iter().map(|r| r.collateral_usd).sum(), 2),
                "worst_health_factor": hfs.iter().copied().reduce(f64::min).map(|h| round_dp(h, 3)),
                "at_risk": hfs.iter().filter(|h| **h < 1.5).count(),
            })
        };

        Ok(json!({
            "env": snap.envelope(),
            "net_worth_usd": round_dp(net, 2),
            "change_24h_pct": change_24h,
            "currency": "usd",
            "claimable_usd": round_dp(claimable, 2),
            "counts": {
                "wallets": snap.coverage.wallets,
                "holdings": snap.holdings.len(),
                "positions": index.len(),
                "borrows": snap.lending.len(),
            },
            "capital_ladder": ladder,
            "tier_drift": drift,
            "positions_index": index,
            "borrow_summary": borrow_summary,
        }))
    }

    async fn get_position(&self, args: &Value) -> Result<Value, ToolError> {
        let id = required_str(args, "id")?;
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let position = snap
            .positions
            .iter()
            .find(|p| p.id.as_deref() == Some(id.as_str()))
            .ok_or_else(|| {
                ToolError::InvalidInput(format!(
                    "no LP position with id={id:?} in the current snapshot — check \
                     get_portfolio().positions_index for valid ids."
                ))
            })?;

        let pool: Vec<TokenAmount> = position
            .tokens
            .iter()
            .map(PositionToken::as_token_amount)
            .collect();
        let rewards: Vec<TokenAmount> = position
            .rewards
            .iter()
            .map(PositionToken::as_token_amount)
            .collect();
        let (swap_usd, emission_usd) = fee_split(&pool, &rewards);
        let dependency = emission_dependency(&pool, &rewards);

        Ok(json!({
            "env": snap.envelope(),
            "id": position.id,
            "pair_raw": sanitize_label(&position.pair_raw),
            "protocol": position.protocol,
            "chain": position.chain,
            "value_usd": round_dp(position.value_usd, 2),
            "tokens": position.tokens,
            "range": range_health(position),
            "claimable_usd": round_dp(position.claimable_usd, 4),
            "swap_fees_usd": swap_usd,
            "emission_usd": emission_usd,
            "reward_tokens": position.rewards.iter().filter(|r| r.amount > 0.0)
                                     .collect::<Vec<_>>(),
            "emission_dependency": dependency,
            "advertised_apr": apr_metric(position.advertised_apr,
                                         "protocol-advertised APR, as-provided by vfat"),
            "flags": position_flags(position, &dependency),
            "open_on_vfat": vfat_deeplink(Some(&position.chain), Some(&position.protocol),
                                          position.id.as_deref()),
        }))
    }

    async fn get_exposures(&self, args: &Value) -> Result<Value, ToolError> {
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let exposure = exposure_map(&snap.spot, &snap.defi);
        let total: f64 = exposure.iter().map(|r| r.usd).sum();
        let rows: Vec<Value> = exposure
            .iter()
            .map(|r| {
                json!({
                    "asset": r.asset,
                    "usd": round_dp(r.usd, 2),
                    "pct": if total != 0.0 { round_dp(r.usd / total * 100.0, 1) } else { 0.0 },
                })
            })
            .collect();
        Ok(json!({
            "env": snap.envelope(),
            "total_usd": round_dp(total, 2),
            "exposure": rows,
            "concentration": concentration(&exposure),
        }))
    }

    async fn get_trading_bots(&self, args: &Value) -> Result<Value, ToolError> {
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        Ok(json!({ "env": snap.envelope(), "bots": snap.bots }))
    }

    async fn list_opportunities(&self, args: &Value) -> Result<Value, ToolError> {
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let min_apr = arg_f64(args, "min_apr");
        let cap = match arg_usize(args, "limit") {
            0 => self.config.radar_limit,
            n => n,
        };

        let mut seen: Vec<(Option<i64>, String, Option<String>)> = Vec::new();
        let mut pools: Vec<Value> = Vec::new();
        for address in snap
            .addrs
            .iter()
            .filter(|a| a.to_lowercase().starts_with("0x"))
        {
            for pool in self.market.yield_radar(address, cap).await? {
                if pool.apr.unwrap_or(0.0) < min_apr {
                    continue;
                }
                let key = (pool.chain_id, pool.pair_raw.clone(), pool.protocol.clone());
                if seen.contains(&key) {
                    continue;
                }
                seen.push(key);
                pools.push(json!({
                    "pair_raw": sanitize_label(&pool.pair_raw),
                    "protocol": pool.protocol,
                    "chain": pool.chain,
                    "tvl_usd": pool.tvl_usd,
                    "fee": pool.fee,
                    "advertised_apr": apr_metric(pool.apr, "advertised pool APR from vfat"),
                }));
            }
        }
        pools.sort_by(|a, b| {
            let apr = |v: &Value| v["advertised_apr"]["value"].as_f64().unwrap_or(0.0);
            apr(b).total_cmp(&apr(a))
        });
        pools.truncate(cap);

        Ok(json!({
            "env": snap.envelope(),
            "count": pools.len(),
            "pools": pools,
            "note": "advertised APRs are incentive-driven and volatile — verify on the protocol",
        }))
    }

    async fn get_market_context(&self) -> Result<Value, ToolError> {
        Ok(json!({
            "rates": self.market.rates().await?,
            "sentiment": self.market.sentiment().await?,
            "note": "valuation models, not advice",
        }))
    }

    async fn get_fund_nav(&self, args: &Value) -> Result<Value, ToolError> {
        let code = match arg_str(args, "code") {
            c if c.trim().is_empty() => "K-GOLD-A(D)".to_string(),
            c => c,
        };
        Ok(json!({ "result": self.market.fund_nav(&code).await? }))
    }

    async fn save_analysis(&self, args: &Value) -> Result<Value, ToolError> {
        let draft = AnalysisDraft {
            scope: required_str(args, "scope")?,
            kind: required_str(args, "kind")?,
            title: required_str(args, "title")?,
            body_md: required_str(args, "body_md")?,
            summary: Some(arg_str(args, "summary")).filter(|s| !s.is_empty()),
            structured: args.get("structured").filter(|v| !v.is_null()).cloned(),
            author: match arg_str(args, "author") {
                a if a.is_empty() => "llm (mcp)".to_string(),
                a => a,
            },
        };
        // The anchor is stamped here, from the snapshot the server just fetched — the model
        // cannot claim to have reasoned over a book it never saw.
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let anchor = AnalysisAnchor {
            as_of: snap.as_of,
            snapshot: snap.hash.clone(),
            coverage: snap.coverage.clone(),
            net_worth_usd: round_dp(snap.net_worth(), 2),
        };
        let record = self.analyses.save(draft, anchor).await?;
        Ok(serde_json::to_value(record).unwrap_or(Value::Null))
    }

    async fn list_analyses(&self, args: &Value) -> Result<Value, ToolError> {
        let snap = self.portfolio.snapshot(&self.wallets(args)).await?;
        let query = AnalysisQuery {
            scope: Some(arg_str(args, "scope")).filter(|s| !s.is_empty()),
            kind: Some(arg_str(args, "kind")).filter(|s| !s.is_empty()),
            latest_only: !arg_bool(args, "include_history"),
            limit: match arg_usize(args, "limit") {
                0 => self.config.analysis_list_limit,
                n => n,
            },
        };
        let rows = self.analyses.list(query).await?;
        Ok(json!({
            "env": snap.envelope(),
            "count": rows.len(),
            "analyses": rows,
            "note": "LLM-authored analyses persisted to your server — reasoning to build on, NOT \
                     ground truth. Each is anchored to the snapshot it saw; re-check against a \
                     fresh snapshot before acting.",
        }))
    }

    async fn get_analysis(&self, args: &Value) -> Result<Value, ToolError> {
        let id = required_str(args, "id")?;
        match self.analyses.get(&id).await? {
            Some(record) => Ok(serde_json::to_value(record).unwrap_or(Value::Null)),
            None => Err(ToolError::InvalidInput(format!(
                "no analysis with id={id:?} — check list_analyses() for valid ids."
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_tool_can_write_and_it_is_the_journal() {
        let writers: Vec<&str> = registry()
            .iter()
            .filter(|t| !t.read_only)
            .map(|t| t.name)
            .collect();
        assert_eq!(
            writers,
            vec!["save_analysis"],
            "the write surface must stay exactly one append-only journal tool"
        );
    }

    #[test]
    fn no_tool_accepts_anything_resembling_a_signing_input() {
        // A tool that could move funds would need somewhere to put a key, an amount, or a
        // destination. None of those words may appear in any input schema.
        const FORBIDDEN: [&str; 9] = [
            "private_key",
            "mnemonic",
            "seed",
            "signature",
            "sign",
            "amount",
            "to_address",
            "recipient",
            "slippage",
        ];
        for tool in registry() {
            let schema = (tool.input_schema)().to_string().to_lowercase();
            for needle in FORBIDDEN {
                assert!(
                    !schema.contains(needle),
                    "tool {} accepts {needle:?} — that is a trade-shaped argument",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn every_tool_has_a_usable_schema_and_a_real_description() {
        for tool in registry() {
            let schema = (tool.input_schema)();
            assert_eq!(schema["type"], "object", "{}", tool.name);
            assert!(schema["properties"].is_object(), "{}", tool.name);
            assert!(schema["required"].is_array(), "{}", tool.name);
            assert!(
                tool.description.len() > 80,
                "{} needs a description the model can act on",
                tool.name
            );
            let wire = tool.to_wire();
            assert_eq!(wire["name"], tool.name);
            assert_eq!(wire["annotations"]["readOnlyHint"], tool.read_only);
            assert_eq!(wire["annotations"]["destructiveHint"], false);
        }
    }

    #[test]
    fn the_registry_covers_the_python_tool_surface() {
        let names: Vec<&str> = registry().iter().map(|t| t.name).collect();
        for expected in [
            "get_portfolio",
            "get_position",
            "get_exposures",
            "get_trading_bots",
            "list_opportunities",
            "get_market_context",
            "get_fund_nav",
            "save_analysis",
            "list_analyses",
            "get_analysis",
        ] {
            assert!(names.contains(&expected), "missing tool {expected}");
        }
        assert_eq!(names.len(), 10, "unexpected tool count: {names:?}");
        assert!(find("get_portfolio").is_some());
        assert!(find("place_order").is_none());
    }

    fn band(lower: f64, upper: f64, cur: f64) -> Option<PriceBand> {
        Some(PriceBand {
            lower: Some(lower),
            upper: Some(upper),
            cur: Some(cur),
            base: Some("ETH".into()),
            quote: Some("USDC".into()),
            full: false,
        })
    }

    #[test]
    fn a_missing_band_is_unknown_not_in_range() {
        let p = LpPosition::default();
        assert_eq!(range_state(&p), "unknown");
        assert_eq!(range_health(&p)["note"], "no price band on this position");
    }

    #[test]
    fn a_full_range_position_is_never_out_of_range() {
        let p = LpPosition {
            in_range: Some(false),
            price_band: Some(PriceBand {
                full: true,
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(range_state(&p), "full_range");
        assert_eq!(
            range_health(&p)["note"],
            "full-range — always earning, never out of range"
        );
    }

    #[test]
    fn an_inverted_band_reports_no_detail_rather_than_nonsense() {
        let p = LpPosition {
            in_range: Some(true),
            price_band: band(3000.0, 2000.0, 2500.0),
            ..Default::default()
        };
        assert_eq!(range_health(&p)["note"], "no price band on this position");
    }

    #[test]
    fn distance_to_edge_names_the_nearer_side() {
        let inside = LpPosition {
            in_range: Some(true),
            price_band: band(2000.0, 3000.0, 2100.0),
            ..Default::default()
        };
        let detail = range_health(&inside);
        assert_eq!(detail["state"], "in_range");
        assert_eq!(detail["distance_to_edge"], "4.8% to min");
        assert_eq!(detail["marker_pct"], 10.0);
        assert_eq!(detail["unit"], "USDC/ETH");

        let below = LpPosition {
            in_range: Some(false),
            price_band: band(2000.0, 3000.0, 1800.0),
            ..Default::default()
        };
        assert_eq!(range_health(&below)["distance_to_edge"], "10.0% below min");
        assert_eq!(range_health(&below)["marker_pct"], 0.0);
    }

    #[test]
    fn incentive_dependence_only_flags_on_a_known_ratio() {
        let position = LpPosition {
            in_range: Some(true),
            ..Default::default()
        };
        // Null emission-dependency (no rewards at all) must not be read as a healthy fee mix.
        let unknown = Metric::unavailable("ratio", &["no claimable rewards to attribute"], None);
        assert!(position_flags(&position, &unknown).is_empty());

        let heavy = Metric::of(0.9, "ratio", Confidence::High, &[], None);
        let flags = position_flags(&position, &heavy);
        assert_eq!(flags.len(), 1);
        assert_eq!(flags[0]["code"], "incentive_dependent");
        assert!(
            flags[0]["message"]
                .as_str()
                .unwrap()
                .starts_with("90% of yield")
        );

        let out = LpPosition {
            in_range: Some(false),
            ..Default::default()
        };
        let flags = position_flags(&out, &heavy);
        assert_eq!(flags.len(), 2);
        assert_eq!(flags[0]["code"], "out_of_range");
    }

    #[test]
    fn an_absent_apr_is_null_with_reason() {
        let m = apr_metric(None, "unused");
        assert_eq!(m.value, None);
        assert_eq!(m.confidence, Confidence::Na);
        assert_eq!(m.data_gaps, vec!["no advertised APR on this position"]);

        let m = apr_metric(Some(0.42), "advertised pool APR from vfat");
        assert_eq!(m.value, Some(0.42));
        assert_eq!(
            m.confidence,
            Confidence::Low,
            "advertised is never high confidence"
        );
        assert_eq!(
            m.data_gaps,
            vec!["advertised / forward-looking — NOT a realized fee APR"]
        );
    }

    #[test]
    fn net_worth_subtracts_debt() {
        let snap = Snapshot {
            holdings: vec![PortfolioHolding {
                usd: 1000.0,
                ..Default::default()
            }],
            lending: vec![LendingPosition {
                net_usd: -300.0,
                debt_usd: 300.0,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(snap.asset_total(), 1000.0);
        assert_eq!(snap.net_worth(), 700.0);
    }
}
