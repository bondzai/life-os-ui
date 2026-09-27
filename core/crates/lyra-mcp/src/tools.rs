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
    /// 24h change as a **percentage** (5.0 = +5%), or `None` when the engine has no price history
    /// for it. Percent, not a fraction: it is passed through from the engine unscaled and comes
    /// back out under `change_24h_pct`, so the oracle and this port report the same number.
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
// The life-OS seam
// ---------------------------------------------------------------------------------------------

/// How a life list is ordered — and therefore what its cursor means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LifeOrder {
    /// Newest change first. The default, because "what did I touch last" has no other answer.
    #[default]
    Recent,
    /// Soonest due first. Carries only rows that have a due date at all.
    Due,
}

/// What the desk asks the life store for. Every field narrows; all of them are `AND`ed.
///
/// **There is no `owner` field, and that is the design.** The store is constructed already knowing
/// whose life it is, resolved once at boot and refused if ambiguous. A model that could name an
/// owner could read someone else's tasks by guessing a string, and no amount of care in a tool
/// body fixes an argument that should not exist.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LifeQuery {
    pub kind: Option<String>,
    pub statuses: Vec<String>,
    pub parent_id: Option<String>,
    pub project_id: Option<String>,
    pub text: Option<String>,
    pub due_from: Option<String>,
    pub due_to: Option<String>,
    pub include_archived: bool,
    pub order: LifeOrder,
    pub limit: usize,
    pub cursor: Option<String>,
}

/// One page of rows, already projected, plus the opaque cursor that continues it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LifePage {
    pub rows: Vec<Value>,
    pub next: Option<String>,
}

/// Everything "what should I be doing" needs, in one round trip.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct LifeAgenda {
    pub day: String,
    pub overdue: Vec<Value>,
    pub due_today: Vec<Value>,
    pub in_progress: Vec<Value>,
    pub habits_due: Vec<Value>,
    pub upcoming: Vec<Value>,
}

/// The life-OS store: tasks, projects, goals, habits, notes, events, chores and their
/// measurements.
///
/// Rows cross this seam already projected to JSON, because the projection is not the desk's
/// decision to make — it has to match what `GET /api/entities` returns, or the assistant and the
/// web app describe the same row to the same person in two different vocabularies. The shaping
/// that *is* the desk's job (which lists go in an agenda, what a series summarises to) happens
/// above this line, where a test can reach it with a plain struct and no database.
pub trait LifeSource: Send + Sync {
    /// A page of entities. `to_brief` projections — small enough to list twenty of.
    fn list(&self, query: LifeQuery) -> impl Future<Output = Result<LifePage, ToolError>> + Send;
    /// One entity in full, or `None` when it does not exist *or* is not visible. The two are
    /// deliberately indistinguishable: confirming that an id exists is itself information.
    fn get(&self, id: &str) -> impl Future<Output = Result<Option<Value>, ToolError>> + Send;
    /// Relations touching a visible entity.
    fn relations(
        &self,
        entity: Option<String>,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Value>, ToolError>> + Send;
    /// Measurements, oldest first. Owner-only — a shared habit does not share its numbers.
    fn trackers(
        &self,
        entity: Option<String>,
        start: Option<String>,
        end: Option<String>,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Value>, ToolError>> + Send;
    /// Recurrences. `schedules` is entity recurrence and not a job queue — see
    /// `docs/core-engine.md`.
    fn schedules(
        &self,
        entity: Option<String>,
        active_only: bool,
        due_on_or_before: Option<String>,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Value>, ToolError>> + Send;
    /// The day's agenda, assembled by the store in one pass over the same tables.
    fn agenda(
        &self,
        day: String,
        limit: usize,
    ) -> impl Future<Output = Result<LifeAgenda, ToolError>> + Send;
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

/// How far a tool can reach. The whole ladder, and there is no rung above the top one.
///
/// This replaces a `read_only: bool`, and the replacement is the point rather than a tidy-up.
/// The old flag supported one assertion — *exactly one tool writes* — which was a proxy for the
/// thing actually worth protecting: that nothing here can move funds. That proxy held only while
/// every tool was a wealth tool. The moment a task list arrives it starts firing on honest
/// changes, and a tripwire that fires constantly gets disabled.
///
/// So the guarantee is restated as two facts that stay checkable as the surface grows:
///
/// 1. **Nothing can sign, because there is no rung for it.** There is no `Sign` variant, and
///    [`Capability::blast_radius`] matches exhaustively — so adding one does not slip past review,
///    it fails the build, at every call site at once. The old test could only notice a signing
///    tool *after* someone wrote it.
/// 2. **The wealth desk still has exactly one writer**, `save_analysis` — asserted over
///    [`Domain::Wealth`] alone, which is the half of the old sentence that was ever load-bearing.
///
/// The argument for why a row in the user's own SQLite file is not in the blast radius of a
/// signature is in `docs/assistant-roadmap.md` §D1. It is not obvious and it should not be
/// re-derived from this comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Capability {
    /// Answers a question. Changes nothing anywhere.
    Read,
    /// Writes a row the user owns, in the user's own database, which the web app shows and can
    /// undo. Nothing leaves the box.
    WriteOwnData,
    /// Causes an effect the user cannot undo from the web app because it is not in the database —
    /// a message sent, a calendar invitation delivered. Nothing carries this yet; it exists so
    /// that the first tool that does has to be classified as such rather than passed off as a
    /// write.
    Reach,
}

/// Every rung, in order. A test asserts this list against the match below, so the two cannot
/// disagree about what the ladder contains.
pub const ALL_CAPABILITIES: [Capability; 3] = [
    Capability::Read,
    Capability::WriteOwnData,
    Capability::Reach,
];

impl Capability {
    /// What this rung means, in one phrase.
    ///
    /// The exhaustive match is the enforcement mechanism described above: this function has no
    /// wildcard arm, on purpose, so a new variant cannot be added quietly.
    pub const fn blast_radius(self) -> &'static str {
        match self {
            Capability::Read => "reads only",
            Capability::WriteOwnData => "writes a row in the user's own database",
            Capability::Reach => "causes an effect outside this box",
        }
    }

    pub const fn is_read(self) -> bool {
        matches!(self, Capability::Read)
    }
}

/// What a tool is about. Used to keep an invariant scoped to the surface it was written for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    /// The portfolio, the market and the analysis journal — the original desk.
    Wealth,
    /// Tasks, projects, goals, habits, notes, events, chores, and their measurements.
    Life,
}

/// Which write tools this process is willing to list at all.
///
/// The default is deliberately the status quo and not "everything off": `save_analysis` predates
/// this gate and is part of the contract a client already has with the desk, so switching a
/// classification model on must not silently remove a tool that has been there all along.
///
/// What the gate buys is the property a second binary would have bought — with `LYRA_MCP_WRITE`
/// unset, a client **cannot list** a life-OS write tool, so it cannot call one either. That is
/// checkable from the outside, by reading `tools/list`, rather than by auditing tool bodies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WriteMode {
    /// The default. The append-only analysis journal may write; nothing else may.
    #[default]
    JournalOnly,
    /// `LYRA_MCP_WRITE=1`. Life-OS write tools are listed too.
    Life,
}

impl WriteMode {
    /// Read the gate from an environment. Only an explicit `1` / `true` / `yes` opens it; anything
    /// else, including a typo, leaves it shut, because the failure that matters is a box that is
    /// writable when its operator believes it is not.
    pub fn from_var(value: Option<&str>) -> Self {
        match value.map(|v| v.trim().to_ascii_lowercase()).as_deref() {
            Some("1") | Some("true") | Some("yes") => WriteMode::Life,
            _ => WriteMode::JournalOnly,
        }
    }

    pub fn from_env() -> Self {
        Self::from_var(std::env::var("LYRA_MCP_WRITE").ok().as_deref())
    }
}

/// One tool as the protocol advertises it.
///
/// `capability` is the load-bearing field: it becomes `annotations.readOnlyHint` on the wire, and
/// the registry tests assert over it. Annotations are a hint to the client — the structural
/// control is that no tool body has a signing path at all, and no [`Capability`] admits one.
///
/// The schema is a function pointer rather than a lazily-built value so the registry stays a
/// `const`-shaped list with no start-up work and no interior mutability. (No `PartialEq`: two
/// function pointers can compare equal or unequal for reasons unrelated to the tools.)
#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: fn() -> Value,
    pub capability: Capability,
    pub domain: Domain,
}

impl ToolDef {
    /// What `annotations.readOnlyHint` says. Derived, never stored twice.
    pub fn read_only(&self) -> bool {
        self.capability.is_read()
    }

    /// Whether this process will admit this tool at all.
    ///
    /// Reads are always listed. `Domain::Wealth` is always listed because `save_analysis` is the
    /// desk's existing contract and the gate is not retroactive. Everything else waits for
    /// [`WriteMode::Life`].
    pub fn listed_under(&self, mode: WriteMode) -> bool {
        match (self.capability, self.domain) {
            (Capability::Read, _) => true,
            (_, Domain::Wealth) => true,
            _ => mode == WriteMode::Life,
        }
    }

    /// The `tools/list` entry for this tool.
    pub fn to_wire(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": (self.input_schema)(),
            "annotations": {
                "readOnlyHint": self.read_only(),
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

/* ─── The life-OS schemas ───
 *
 * One `entity_list` rather than seven per-type tools. The types share a table, a visibility rule
 * and a filter set, so seven tools would be seven copies of one schema differing in a string —
 * and the cost lands on the model, which pays for every tool description in its context on every
 * turn whether it calls one or not. A `type` argument is the same expressiveness for a seventh of
 * the budget.
 *
 * A note on wording, because it will bite whoever edits this next: a registry test scans every
 * input schema, lowercased and whole, for substrings that would betray a trade-shaped tool —
 * among them `sign`, `seed` and `amount`. Those match inside ordinary words. Say "owner", not
 * "assignee"; "value", not "amount". The test is right to be blunt about the thing it guards, and
 * the cost of that bluntness is paid here rather than by loosening it. */

const LIFE_TYPES: &str = "One of: task, project, goal, habit, note, event, chore. The column is \
open, so a type the web app added later works too. Omit for every type.";

const LIMIT_DESC: &str = "Max rows (default 20, cap 100). Page with `cursor` rather than raising \
it — the cap is a frame budget, not a database limit.";

const CURSOR_DESC: &str = "Opaque `next_cursor` from a previous call in the SAME `order`. Pages \
by the last row actually returned, so rows added while you page are neither skipped nor repeated.";

fn entity_list_schema() -> Value {
    schema(
        json!({
            "type": { "type": "string", "description": LIFE_TYPES },
            "status": { "type": "string",
                        "description": "Comma-separated statuses to keep: backlog, todo, \
                                        in-progress, done, archived. Omit for everything still \
                                        open." },
            "project_id": { "type": "string",
                            "description": "Only rows whose metadata.projectId is this id — the \
                                            tasks belonging to a project or a goal." },
            "parent_id": { "type": "string", "description": "Only direct children of this id." },
            "text": { "type": "string",
                      "description": "Substring of the title or body, case-insensitive." },
            "due_from": { "type": "string",
                          "description": "Inclusive earliest due day, YYYY-MM-DD." },
            "due_to": { "type": "string",
                        "description": "Inclusive latest due day, YYYY-MM-DD." },
            "include_archived": { "type": "boolean",
                                  "description": "Default false. Archived work is filed on \
                                                  purpose; surfacing it undoes that." },
            "order": { "type": "string", "enum": ["recent", "due"],
                       "description": "recent = newest change first (default). due = soonest due \
                                       first, and lists ONLY rows that have a due date." },
            "limit": { "type": "integer", "minimum": 1, "description": LIMIT_DESC },
            "cursor": { "type": "string", "description": CURSOR_DESC },
        }),
        &[],
    )
}

fn entity_get_schema() -> Value {
    schema(
        json!({
            "id": { "type": "string", "description": "Entity id from any list." },
            "limit": { "type": "integer", "minimum": 1,
                       "description": "Max related rows in each attached list (default 20)." },
        }),
        &["id"],
    )
}

fn search_life_schema() -> Value {
    schema(
        json!({
            "q": { "type": "string",
                   "description": "Text to look for in titles and bodies, case-insensitive. \
                                   A literal % or _ matches itself." },
            "type": { "type": "string", "description": LIFE_TYPES },
            "include_archived": { "type": "boolean", "description": "Default false." },
            "limit": { "type": "integer", "minimum": 1, "description": LIMIT_DESC },
            "cursor": { "type": "string", "description": CURSOR_DESC },
        }),
        &["q"],
    )
}

fn get_agenda_schema() -> Value {
    schema(
        json!({
            "day": { "type": "string",
                     "description": "The day to build the agenda for, YYYY-MM-DD. PASS THIS if \
                                     you know the user's local date: the server otherwise uses \
                                     its own, and a box on UTC disagrees with a phone that is not \
                                     for part of every day." },
            "limit": { "type": "integer", "minimum": 1,
                       "description": "Max rows per section (default 20, cap 100)." },
        }),
        &[],
    )
}

fn schedule_list_schema() -> Value {
    schema(
        json!({
            "entity_id": { "type": "string",
                           "description": "Only the recurrence of this entity." },
            "include_paused": { "type": "boolean",
                                "description": "Default false: only active recurrences." },
            "due_on_or_before": { "type": "string",
                                  "description": "Only recurrences whose nextDue has arrived by \
                                                  this day, YYYY-MM-DD." },
            "limit": { "type": "integer", "minimum": 1, "description": LIMIT_DESC },
        }),
        &[],
    )
}

fn tracker_series_schema() -> Value {
    schema(
        json!({
            "entity_id": { "type": "string",
                           "description": "The entity whose measurements to read — a habit, a \
                                           goal, anything being tracked." },
            "start": { "type": "string",
                       "description": "Inclusive earliest timestamp, ISO 8601." },
            "end": { "type": "string", "description": "Inclusive latest timestamp, ISO 8601." },
            "limit": { "type": "integer", "minimum": 1,
                       "description": "Max points (default 20, cap 100). Points come oldest \
                                       first; narrow with `start` to read the recent end." },
        }),
        &["entity_id"],
    )
}

fn relation_list_schema() -> Value {
    schema(
        json!({
            "entity_id": { "type": "string",
                           "description": "Only edges incident on this id. Omit for every edge \
                                           with a visible endpoint." },
            "limit": { "type": "integer", "minimum": 1, "description": LIMIT_DESC },
        }),
        &[],
    )
}

/// Every tool this server knows how to run — the complete capability surface, as a value.
///
/// Deliberately enumerable: tests walk this list and assert that no capability admits signing,
/// that the wealth desk has exactly one writer and it is the append-only journal, and that no
/// entry accepts anything resembling a signing input. That is a much stronger statement than "we
/// did not write a trading tool", and it stays true as the list grows.
///
/// This is the *whole* list. What a client is allowed to see is [`registry_for`].
pub fn registry() -> &'static [ToolDef] {
    &[
        ToolDef {
            name: "get_portfolio",
            description: "Summary-first portfolio view: net worth, value-weighted 24h change, \
                Capital Ladder tier breakdown + drift-to-target, total claimable LP rewards, and \
                an INDEX of LP positions (id, pair, chain, value, range state). Drill into any \
                position with get_position(id). Off-chain manual assets are not included.",
            input_schema: wallets_only_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
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
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "get_exposures",
            description: "True underlying-asset exposure: every basket, LP pair and bot unwrapped \
                into the coins you actually hold, summed across the book — plus concentration \
                (HHI over underlying assets, top-asset share, stablecoin share). Coin-level \
                exposure, not the position-level view.",
            input_schema: wallets_only_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "get_trading_bots",
            description: "Trading bots, full breakdown: the spot rebalance basket (per-coin \
                amount, USD, weight → Tier III Investment & Income) and the AI futures bots \
                (equity, unrealised PnL, margin in use, per-sub-bot rows → Tier IV High Risk). \
                Read-only; API keys never leave the server.",
            input_schema: wallets_only_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "list_opportunities",
            description: "Higher-APR pools for tokens you already hold in vfat LPs (the yield \
                radar), across your EVM wallets. `min_apr` filters on advertised APR (same \
                fraction scale as the field, e.g. 0.3 = 30%). Advertised APRs are \
                incentive-driven and volatile — a scouting list, not a recommendation.",
            input_schema: list_opportunities_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "get_market_context",
            description: "Keyless market context (no wallet needed): fx rates (USD/THB/BTC) and \
                crypto valuation models — Fear & Greed, MVRV Z-Score, BTC rainbow band, \
                Stock-to-Flow, SOPR, Puell Multiple. Models for framing, not advice.",
            input_schema: no_args_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "get_fund_nav",
            description: "Live NAV (THB per unit) of a Thai mutual fund via WealthMagik, e.g. the \
                K-GOLD gold fund. Pass a fund code like \"K-GOLD-A(D)\".",
            input_schema: get_fund_nav_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
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
            capability: Capability::WriteOwnData,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "list_analyses",
            description: "List saved analyses, newest first — recall your prior reasoning and \
                build on it. By default returns only the LATEST version per scope; set \
                include_history=true to see superseded versions. Filter by `scope` and/or `kind`. \
                Each record is anchored to the snapshot it saw — re-verify against current data \
                before acting on old conclusions.",
            input_schema: list_analyses_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        ToolDef {
            name: "get_analysis",
            description: "Fetch one saved analysis in full by its `id` (from list_analyses): the \
                complete markdown body, structured payload, and the data anchor it was written \
                against.",
            input_schema: get_analysis_schema,
            capability: Capability::Read,
            domain: Domain::Wealth,
        },
        // ── The life OS. Reads only: nothing below can create, change or file anything. ──
        ToolDef {
            name: "get_agenda",
            description: "START HERE for anything about the user's day. One call returns overdue \
                work, what is due today, what is already in progress, the habits and chores due, \
                and the next seven days — each as a short list. Ask this before reaching for \
                entity_list: the alternative is five list calls whose results you then have to \
                reconcile. Pass `day` as the user's local YYYY-MM-DD when you know it. Calendar \
                events are NOT included and the response says so rather than pretending the day \
                is empty.",
            input_schema: get_agenda_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "entity_list",
            description: "List the user's tasks, projects, goals, habits, notes, events and \
                chores — ONE tool for every type, narrowed by `type`. Filter by status, by the \
                project or goal a task belongs to (`project_id`), by parent, by due-day window or \
                by text. Order by most recently changed (default) or by soonest due. Returns a \
                short projection per row — id, type, title, status, priority, due date, project, \
                tags — plus `next_cursor` when more rows exist. Archived work is left out unless \
                you ask for it. Use entity_get for one row's full body.",
            input_schema: entity_list_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "entity_get",
            description: "ONE entity in full — body, tags, metadata, timestamps — together with \
                the context that makes it actionable: its parent, its direct children, the tasks \
                that name it as their project or goal, its recurrence if it has one, and the \
                relations touching it. This is the drill-in after entity_list, and the right call \
                before you say anything specific about a piece of work. An id the user cannot see \
                is reported as not found, exactly as a nonexistent one is.",
            input_schema: entity_get_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "search_life",
            description: "Find entities by text across titles and bodies, of any type or one \
                type. This searches the user's OWN life OS — their tasks, notes and projects — \
                and never the web. Use it when the user refers to something by name rather than \
                by id: 'the accountant thing', 'my reading note about X'. Same projection and \
                same cursor paging as entity_list.",
            input_schema: search_life_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "schedule_list",
            description: "The user's recurrences: which habit or chore repeats on what rhythm, \
                when it next falls due, and when it was last completed. A recurrence is NOT a job \
                queue entry — `nextDue` is a date shown to the user on the habits page, so treat \
                it as a plan and never as a promise that something ran. Paused recurrences are \
                left out unless you ask for them.",
            input_schema: schedule_list_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "tracker_series",
            description: "The measurements logged against one entity, oldest first, with a small \
                summary alongside: how many points, their total, smallest, largest, mean, and the \
                latest one. Use it for 'how am I doing on X' questions — reps, minutes, weight, \
                pages. Measurements are private to whoever logged them even when the entity \
                itself is shared, so an empty series means yours is empty, not that nothing was \
                ever logged.",
            input_schema: tracker_series_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
        ToolDef {
            name: "relation_list",
            description: "The typed edges between entities — what blocks what, what relates to \
                what — either for one entity or across everything visible. An edge is returned \
                when EITHER of its endpoints is visible to the user, so an edge may point at an \
                id that entity_get will then decline to show.",
            input_schema: relation_list_schema,
            capability: Capability::Read,
            domain: Domain::Life,
        },
    ]
}

/// The tools this process will advertise, given its write gate.
///
/// A tool left out of this list is not merely hidden: [`find_listed`] is what `tools/call`
/// resolves through, so a tool the client cannot see is also one it cannot invoke by guessing the
/// name. Listing and dispatch have to agree, or the gate is decoration.
pub fn registry_for(mode: WriteMode) -> Vec<&'static ToolDef> {
    registry().iter().filter(|t| t.listed_under(mode)).collect()
}

/// Look a tool up by name, across the whole surface.
pub fn find(name: &str) -> Option<&'static ToolDef> {
    registry().iter().find(|t| t.name == name)
}

/// Look a tool up by name, but only among the ones this process advertises.
pub fn find_listed(name: &str, mode: WriteMode) -> Option<&'static ToolDef> {
    find(name).filter(|t| t.listed_under(mode))
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
pub struct Desk<P, M, A, L> {
    portfolio: P,
    market: M,
    analyses: A,
    life: L,
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

/// An optional string argument: absent, null and blank all mean "not supplied".
///
/// A model that fills in `""` for a filter it does not want is common enough that treating the
/// empty string as a filter would silently return nothing and look like an empty life.
fn opt_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
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

impl<P: PortfolioSource, M: MarketSource, A: AnalysisStore, L: LifeSource> Desk<P, M, A, L> {
    pub fn new(portfolio: P, market: M, analyses: A, life: L, config: DeskConfig) -> Self {
        Self {
            portfolio,
            market,
            analyses,
            life,
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
            "get_agenda" => self.get_agenda(args).await,
            "entity_list" => self.entity_list(args).await,
            "entity_get" => self.entity_get(args).await,
            "search_life" => self.search_life(args).await,
            "schedule_list" => self.schedule_list(args).await,
            "tracker_series" => self.tracker_series(args).await,
            "relation_list" => self.relation_list(args).await,
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

    /* ─── The life OS ─── */

    /// Build the shared filter set out of one call's arguments.
    ///
    /// Shared by `entity_list` and `search_life` so the two cannot end up disagreeing about what
    /// `include_archived` means — which would be the sort of difference nobody notices until an
    /// archived task turns up in an answer.
    fn life_query(&self, args: &Value, order: LifeOrder) -> LifeQuery {
        LifeQuery {
            kind: opt_str(args, "type"),
            // A comma-separated list rather than an array: every other string argument on this
            // desk is a string, and a model that has to guess between the two guesses wrong.
            statuses: opt_str(args, "status")
                .map(|raw| {
                    raw.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            parent_id: opt_str(args, "parent_id"),
            project_id: opt_str(args, "project_id"),
            text: opt_str(args, "text"),
            due_from: opt_str(args, "due_from"),
            due_to: opt_str(args, "due_to"),
            include_archived: arg_bool(args, "include_archived"),
            order,
            limit: arg_usize(args, "limit"),
            cursor: opt_str(args, "cursor"),
        }
    }

    fn page_to_json(page: LifePage, kind: &str) -> Value {
        let count = page.rows.len();
        json!({
            "schema_version": SCHEMA_VERSION,
            kind: page.rows,
            "count": count,
            // Present and null when the list is exhausted, rather than absent: a missing key
            // reads as "I forgot to look", and a model that cannot tell the difference asks again.
            "next_cursor": page.next,
        })
    }

    async fn entity_list(&self, args: &Value) -> Result<Value, ToolError> {
        let order = match opt_str(args, "order").as_deref() {
            None | Some("recent") => LifeOrder::Recent,
            Some("due") => LifeOrder::Due,
            Some(other) => {
                return Err(ToolError::InvalidInput(format!(
                    "order={other:?} is not an order — use \"recent\" or \"due\"."
                )));
            }
        };
        let page = self.life.list(self.life_query(args, order)).await?;
        Ok(Self::page_to_json(page, "entities"))
    }

    async fn search_life(&self, args: &Value) -> Result<Value, ToolError> {
        let q = required_str(args, "q")?;
        let mut query = self.life_query(args, LifeOrder::Recent);
        query.text = Some(q.clone());
        let page = self.life.list(query).await?;
        let mut out = Self::page_to_json(page, "matches");
        out["query"] = json!(q);
        Ok(out)
    }

    async fn entity_get(&self, args: &Value) -> Result<Value, ToolError> {
        let id = required_str(args, "id")?;
        let limit = arg_usize(args, "limit");

        let Some(entity) = self.life.get(&id).await? else {
            // The same message whether the row is absent or merely invisible. Distinguishing them
            // would confirm that an id the user may not see exists, which is itself information.
            return Err(ToolError::InvalidInput(format!(
                "no entity with id={id:?} that this user can see."
            )));
        };

        // The parent is fetched rather than listed so an invisible parent comes back as null,
        // the same way an invisible entity does.
        let parent_id = entity
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string);
        let parent = match &parent_id {
            Some(pid) => self.life.get(pid).await?,
            None => None,
        };

        let children = self
            .life
            .list(LifeQuery {
                parent_id: Some(id.clone()),
                limit,
                ..Default::default()
            })
            .await?;
        // Two different links, deliberately kept apart: `parentId` is containment and
        // `metadata.projectId` is belonging, and a project's tasks are usually the second.
        let members = self
            .life
            .list(LifeQuery {
                project_id: Some(id.clone()),
                limit,
                ..Default::default()
            })
            .await?;
        let schedule = self
            .life
            .schedules(Some(id.clone()), false, None, 1)
            .await?
            .into_iter()
            .next();
        let relations = self.life.relations(Some(id.clone()), limit).await?;

        Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "entity": entity,
            "parent": parent,
            "children": children.rows,
            "children_next_cursor": children.next,
            "project_members": members.rows,
            "project_members_next_cursor": members.next,
            "schedule": schedule,
            "relations": relations,
        }))
    }

    async fn schedule_list(&self, args: &Value) -> Result<Value, ToolError> {
        let rows = self
            .life
            .schedules(
                opt_str(args, "entity_id"),
                !arg_bool(args, "include_paused"),
                opt_str(args, "due_on_or_before"),
                arg_usize(args, "limit"),
            )
            .await?;
        Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "schedules": rows,
            "count": rows.len(),
            // Said here rather than only in the tool description, because the description is read
            // once and the response is read every time.
            "note": "A recurrence is a plan shown to the user, not a record that anything ran.",
        }))
    }

    async fn relation_list(&self, args: &Value) -> Result<Value, ToolError> {
        let rows = self
            .life
            .relations(opt_str(args, "entity_id"), arg_usize(args, "limit"))
            .await?;
        Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "relations": rows,
            "count": rows.len(),
        }))
    }

    async fn tracker_series(&self, args: &Value) -> Result<Value, ToolError> {
        let entity = required_str(args, "entity_id")?;
        let points = self
            .life
            .trackers(
                Some(entity.clone()),
                opt_str(args, "start"),
                opt_str(args, "end"),
                arg_usize(args, "limit"),
            )
            .await?;

        // Points with no numeric value are kept in the series (the note may be the whole point of
        // the entry) but left out of the statistics, so a row logged as a comment does not read as
        // a zero and drag a mean down.
        let values: Vec<f64> = points
            .iter()
            .filter_map(|p| p.get("value").and_then(Value::as_f64))
            .collect();
        let summary = if values.is_empty() {
            json!({ "count": 0 })
        } else {
            let sum: f64 = values.iter().sum();
            json!({
                "count": values.len(),
                "sum": round_dp(sum, 4),
                "min": round_dp(values.iter().cloned().fold(f64::INFINITY, f64::min), 4),
                "max": round_dp(values.iter().cloned().fold(f64::NEG_INFINITY, f64::max), 4),
                "mean": round_dp(sum / values.len() as f64, 4),
                "last": round_dp(*values.last().unwrap_or(&0.0), 4),
            })
        };

        Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "entity_id": entity,
            "points": points,
            "summary": summary,
            "unit": points
                .iter()
                .rev()
                .find_map(|p| p.get("unit").and_then(Value::as_str))
                .map(str::to_string),
        }))
    }

    async fn get_agenda(&self, args: &Value) -> Result<Value, ToolError> {
        // The caller's day wins. Falling back to the process's own local date is what makes the
        // tool usable without one, but it is the wrong answer whenever the box and the phone are
        // in different zones — so the response reports which one it used.
        let (day, source) = match opt_str(args, "day") {
            Some(day) => (day, "caller"),
            None => (today_local(), "server-local"),
        };
        let agenda = self
            .life
            .agenda(day.clone(), arg_usize(args, "limit"))
            .await?;

        Ok(json!({
            "schema_version": SCHEMA_VERSION,
            "day": agenda.day,
            "day_source": source,
            "overdue": agenda.overdue,
            "due_today": agenda.due_today,
            "in_progress": agenda.in_progress,
            "habits_due": agenda.habits_due,
            "upcoming_7_days": agenda.upcoming,
            // Stated rather than omitted. An agenda that silently leaves out the calendar looks
            // like a free afternoon, and the model has no way to tell that it was not asked.
            "calendar": Value::Null,
            "calendar_reason": "not connected — this desk cannot read Google Calendar. Do not \
                                report the day as free on the strength of this.",
        }))
    }
}

/// The process's own local date, `YYYY-MM-DD`.
///
/// Only ever a fallback — see `get_agenda`. It is a free function so a test can compare against
/// it without going near the desk.
fn today_local() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exactly_one_tool_can_write_and_it_is_the_journal() {
        let writers: Vec<&str> = registry()
            .iter()
            .filter(|t| !t.read_only())
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
            assert_eq!(wire["annotations"]["readOnlyHint"], tool.read_only());
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
        // Changed from `names.len() == 10` when the life-OS surface landed. The bare count was
        // never the thing worth pinning — it only worked while *every* tool was a wealth tool, so
        // it would have had to be edited by whoever added the eleventh whatever it was. Asserting
        // the Wealth domain is exactly those ten pins the same fact where it still means
        // something, and now a new wealth tool has to be argued for rather than absorbed into a
        // bumped number.
        let wealth: Vec<&str> = registry()
            .iter()
            .filter(|t| t.domain == Domain::Wealth)
            .map(|t| t.name)
            .collect();
        assert_eq!(wealth.len(), 10, "the wealth desk grew: {wealth:?}");
        assert!(find("get_portfolio").is_some());
        assert!(find("place_order").is_none());
    }

    #[test]
    fn the_wealth_desk_still_has_exactly_one_writer_and_it_is_the_journal() {
        // The narrowed form of `exactly_one_tool_can_write_and_it_is_the_journal`, and the one
        // that survives the life OS. The old assertion is kept alongside it deliberately: it is
        // still true today, and leaving it to fail on the first life write is what forces that
        // change to be made on purpose, in a commit that says so, rather than noticed afterwards.
        let writers: Vec<&str> = registry()
            .iter()
            .filter(|t| t.domain == Domain::Wealth && !t.read_only())
            .map(|t| t.name)
            .collect();
        assert_eq!(writers, vec!["save_analysis"]);
    }

    #[test]
    fn the_capability_ladder_has_no_rung_for_signing() {
        // The replacement for "count the writers". `blast_radius` matches exhaustively, so a
        // `Sign` variant fails the build rather than being noticed by a test after someone wrote
        // the tool — and this asserts the ladder is the three rungs it is documented to be, so
        // the exhaustive match cannot be quietly widened either.
        assert_eq!(ALL_CAPABILITIES.len(), 3);
        let described: Vec<&str> = ALL_CAPABILITIES.iter().map(|c| c.blast_radius()).collect();
        assert_eq!(
            described,
            [
                "reads only",
                "writes a row in the user's own database",
                "causes an effect outside this box",
            ]
        );
        for capability in ALL_CAPABILITIES {
            let radius = capability.blast_radius().to_lowercase();
            assert!(
                !radius.contains("sign") && !radius.contains("send funds"),
                "{radius:?} describes something this desk must not be able to do"
            );
        }
    }

    #[test]
    fn with_the_write_gate_shut_the_life_os_is_read_only_and_visibly_so() {
        // The property a second binary would have bought: a client can check it by reading
        // `tools/list`, without auditing a single tool body.
        for tool in registry_for(WriteMode::JournalOnly) {
            assert!(
                tool.read_only() || tool.domain == Domain::Wealth,
                "{} is listed with the write gate shut",
                tool.name
            );
        }
        // And the gate must be shut by anything that is not an explicit yes — including a typo,
        // because the failure that matters is a box writable while its operator believes not.
        for value in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("ture"),
            Some("on"),
        ] {
            assert_eq!(
                WriteMode::from_var(value),
                WriteMode::JournalOnly,
                "{value:?}"
            );
        }
        for value in ["1", "true", "YES", " yes "] {
            assert_eq!(WriteMode::from_var(Some(value)), WriteMode::Life, "{value}");
        }
    }

    #[test]
    fn listing_and_dispatch_agree_about_what_exists() {
        // A tool withheld from `tools/list` that `tools/call` would still run is not a gate.
        for mode in [WriteMode::JournalOnly, WriteMode::Life] {
            let listed: Vec<&str> = registry_for(mode).iter().map(|t| t.name).collect();
            for tool in registry() {
                assert_eq!(
                    find_listed(tool.name, mode).is_some(),
                    listed.contains(&tool.name),
                    "{} disagrees under {mode:?}",
                    tool.name
                );
            }
        }
    }

    #[test]
    fn every_life_tool_is_a_read() {
        // This pass added a read surface and nothing else. The moment that stops being true it
        // should stop being true in a commit that changes this test.
        let life: Vec<&str> = registry()
            .iter()
            .filter(|t| t.domain == Domain::Life)
            .map(|t| t.name)
            .collect();
        assert_eq!(
            life,
            [
                "get_agenda",
                "entity_list",
                "entity_get",
                "search_life",
                "schedule_list",
                "tracker_series",
                "relation_list",
            ]
        );
        for tool in registry().iter().filter(|t| t.domain == Domain::Life) {
            assert_eq!(tool.capability, Capability::Read, "{}", tool.name);
        }
    }

    #[test]
    fn one_tool_covers_every_entity_type_rather_than_one_tool_each() {
        // Seven tools differing in a string would cost the model seven descriptions of context on
        // every turn, whether or not it called any of them.
        let per_type = registry()
            .iter()
            .filter(|t| {
                ["task", "project", "goal", "habit", "note", "event", "chore"]
                    .iter()
                    .any(|kind| t.name.starts_with(kind) || t.name.ends_with(kind))
            })
            .count();
        assert_eq!(
            per_type, 0,
            "entity types belong in an argument, not in a tool name"
        );
        let schema = (find("entity_list").unwrap().input_schema)().to_string();
        for kind in ["task", "project", "goal", "habit", "note", "event", "chore"] {
            assert!(schema.contains(kind), "entity_list does not mention {kind}");
        }
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
