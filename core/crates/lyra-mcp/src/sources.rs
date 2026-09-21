//! The data room: the desk's three seams, wired to the real engine.
//!
//! Port of `wallet-portfolio/pow_mcp/sources.py`. Everything the desk can reach goes through
//! here, which is what makes the read-only claim checkable — there is exactly one file to audit
//! for "what can this process actually do", and the only write in it is the analysis journal.
//!
//! The snapshot cache is the other reason this exists. A single analysis calls several tools, and
//! each one wants the book; without a cache they would each trigger their own multi-chain fan-out
//! and the model would reason across a *drifting* portfolio, where two tools disagree because
//! prices moved between them. One bounded TTL cache means a burst of calls sees one coherent
//! moment.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use lyra_chain::address::parse_addresses;
use lyra_chain::adapters::vfat;
use lyra_chain::aggregate::{AggregateConfig, build_portfolios};
use lyra_chain::sources::LiveSources;
use lyra_db::life;
use lyra_db::wealth as store;
use serde_json::Value;
use sqlx::SqlitePool;

use crate::book;
use crate::tools::{
    AnalysisAnchor, AnalysisDraft, AnalysisQuery, AnalysisRecord, AnalysisStore, Coverage,
    LifeAgenda, LifeOrder, LifePage, LifeQuery, LifeSource, MarketSource, PoolCandidate,
    PortfolioSource, Snapshot, ToolError,
};

fn usize_var(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(default)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

/// Tunables, with the Python's names and defaults so one `.env` drives either implementation.
#[derive(Debug, Clone)]
pub struct RoomConfig {
    pub max_wallets: usize,
    pub cache_ttl: Duration,
    pub cache_max_entries: usize,
}

impl Default for RoomConfig {
    fn default() -> Self {
        Self {
            max_wallets: 10,
            cache_ttl: Duration::from_secs(120),
            cache_max_entries: 32,
        }
    }
}

impl RoomConfig {
    pub fn from_env() -> Self {
        Self {
            max_wallets: usize_var("POW_MCP_MAX_WALLETS", 10),
            cache_ttl: Duration::from_secs(usize_var("POW_MCP_TTL", 120) as u64),
            cache_max_entries: usize_var("POW_MCP_CACHE_MAX", 32),
        }
    }
}

/// One cached read, keyed by the normalised address set.
struct Cached {
    key: Vec<String>,
    at: Instant,
    snapshot: Arc<Snapshot>,
}

/// The live book, behind a bounded LRU+TTL cache.
pub struct LivePortfolio {
    sources: Arc<LiveSources>,
    aggregate: AggregateConfig,
    config: RoomConfig,
    cache: Mutex<Vec<Cached>>,
}

impl LivePortfolio {
    pub fn new(sources: Arc<LiveSources>, aggregate: AggregateConfig, config: RoomConfig) -> Self {
        Self {
            sources,
            aggregate,
            config,
            cache: Mutex::new(Vec::new()),
        }
    }

    /// Parse the caller's wallet string into addresses.
    ///
    /// An empty string is [`ToolError::InvalidInput`] rather than an empty portfolio: the model
    /// asked about a book and there is no book to answer for, and returning "$0 net worth" for a
    /// misconfigured server would be a lie it could not detect.
    fn resolve(&self, wallets: &str) -> Result<Vec<String>, ToolError> {
        let raw = wallets.trim();
        if raw.is_empty() {
            return Err(ToolError::InvalidInput(
                "no wallets supplied — pass `wallets` (space/comma-separated 0x… and/or bc1…) \
                 or set POW_WALLETS in the environment."
                    .into(),
            ));
        }
        parse_addresses(raw, self.config.max_wallets)
            .map_err(|e| ToolError::InvalidInput(format!("invalid wallet input: {e}")))
    }

    /// The cache key: addresses lower-cased and sorted, so the same set in a different order is
    /// the same read.
    fn cache_key(addresses: &[String]) -> Vec<String> {
        let mut key: Vec<String> = addresses.iter().map(|a| a.to_lowercase()).collect();
        key.sort();
        key
    }

    fn cached(&self, key: &[String]) -> Option<Arc<Snapshot>> {
        let mut cache = self.cache.lock().ok()?;
        let found = cache.iter().position(|entry| entry.key == key)?;
        if cache[found].at.elapsed() >= self.config.cache_ttl {
            cache.remove(found);
            return None;
        }
        // Move to the back: eviction takes from the front, so "recently used" must be last.
        let entry = cache.remove(found);
        let snapshot = Arc::clone(&entry.snapshot);
        cache.push(entry);
        Some(snapshot)
    }

    fn store(&self, key: Vec<String>, snapshot: Arc<Snapshot>) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        cache.retain(|entry| entry.key != key);
        cache.push(Cached {
            key,
            at: Instant::now(),
            snapshot,
        });
        while cache.len() > self.config.cache_max_entries {
            cache.remove(0);
        }
    }
}

impl PortfolioSource for LivePortfolio {
    async fn snapshot(&self, wallets: &str) -> Result<Snapshot, ToolError> {
        let addresses = self.resolve(wallets)?;
        let key = Self::cache_key(&addresses);
        if let Some(hit) = self.cached(&key) {
            return Ok((*hit).clone());
        }

        // The fan-out is deliberately outside the lock: it is seconds of network, and holding the
        // mutex across it would serialise every concurrent tool call behind the first one.
        let outcome =
            build_portfolios(Arc::clone(&self.sources), &addresses, &self.aggregate).await;
        if !outcome.health.is_complete() {
            // Worth a log line and nothing more. A partial read is still the best answer
            // available, and `coverage.partial` stays `None` because this walk cannot say which
            // chains were missed — see `book::coverage`.
            tracing::warn!(
                wallets = addresses.len(),
                "portfolio fan-out was incomplete; the snapshot understates the book"
            );
        }

        let snapshot = Arc::new(book::snapshot_from(
            &outcome.portfolio,
            addresses,
            now_secs(),
        ));
        self.store(key, Arc::clone(&snapshot));
        Ok((*snapshot).clone())
    }
}

/// Keyless market context. Nothing here touches a wallet.
pub struct LiveMarket {
    sources: Arc<LiveSources>,
}

impl LiveMarket {
    pub fn new(sources: Arc<LiveSources>) -> Self {
        Self { sources }
    }
}

fn to_json<T: serde::Serialize>(what: &str, value: &T) -> Result<Value, ToolError> {
    serde_json::to_value(value)
        .map_err(|e| ToolError::Unavailable(format!("could not serialise {what}: {e}")))
}

impl MarketSource for LiveMarket {
    async fn rates(&self) -> Result<Value, ToolError> {
        to_json("rates", &self.sources.market().get_rates().await)
    }

    async fn sentiment(&self) -> Result<Value, ToolError> {
        to_json("sentiment", &self.sources.market().market_sentiment().await)
    }

    /// An unknown fund code answers `null`, not an error — "no NAV published for this code" is an
    /// answer, and the HTTP route makes the same choice for the same reason.
    async fn fund_nav(&self, code: &str) -> Result<Value, ToolError> {
        to_json("fund nav", &self.sources.market().thai_fund_nav(code).await)
    }

    /// Higher-APR pools for tokens this address already holds.
    ///
    /// A wallet whose vfat feed cannot be read is an error here, unlike the HTTP route which
    /// skips it: the route radars several wallets and one bad feed should not blank the board,
    /// while this call is about exactly one address, so a silent empty list would read as "no
    /// opportunities" when the truth is "could not look".
    async fn yield_radar(&self, address: &str, limit: usize) -> Result<Vec<PoolCandidate>, ToolError> {
        let found = vfat::vfat_yield_radar(self.sources.vfat(), address, vfat::RADAR_LIMIT)
            .await
            .map_err(|e| ToolError::Unavailable(format!("yield radar: {e:#}")))?;

        Ok(vfat::rank_radar(found, limit)
            .into_iter()
            .map(|o| PoolCandidate {
                pair_raw: o.pair,
                protocol: o.protocol,
                chain: Some(o.chain),
                chain_id: o.chain_id.map(|id| id as i64),
                tvl_usd: Some(o.tvl),
                fee: o.fee,
                apr: Some(o.apr),
            })
            .collect())
    }
}

/// The analysis journal, on the same SQLite database the HTTP API writes.
///
/// Deliberately the same table rather than a private one: an analysis the desk wrote has to show
/// up in the Journal page, and a review written through the UI has to be visible to the model.
/// The `source` column is what tells them apart afterwards.
pub struct SqliteAnalyses {
    pool: SqlitePool,
}

impl SqliteAnalyses {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }
}

fn record_from(row: store::Analysis) -> AnalysisRecord {
    // An anchor needs both halves to mean anything: a stamp with no snapshot hash cannot be
    // matched back to a read, so a half-filled one is reported as absent rather than as fact.
    let anchor = row.anchor.as_ref().and_then(|a| {
        let (Some(as_of), Some(hash)) = (a.as_of, a.hash.clone()) else {
            return None;
        };
        Some(AnalysisAnchor {
            as_of,
            snapshot: hash,
            coverage: a
                .coverage
                .clone()
                .and_then(|c| serde_json::from_value::<Coverage>(c).ok())
                .unwrap_or_default(),
            net_worth_usd: row.net_worth_usd.unwrap_or_default(),
        })
    });

    AnalysisRecord {
        id: row.id,
        scope: row.scope,
        version: row.version,
        kind: row.kind,
        title: row.title,
        summary: row.summary,
        body_md: row.body_md,
        structured: row.structured,
        author: row.author,
        source: row.source,
        created_at: row.created_at,
        net_worth_usd: row.net_worth_usd,
        anchor,
        superseded_by: row.superseded_by,
    }
}

impl AnalysisStore for SqliteAnalyses {
    async fn save(
        &self,
        draft: AnalysisDraft,
        anchor: AnalysisAnchor,
    ) -> Result<AnalysisRecord, ToolError> {
        let input = store::AnalysisInput {
            scope: draft.scope,
            kind: draft.kind,
            title: draft.title,
            summary: draft.summary,
            body_md: draft.body_md,
            structured: draft.structured,
            author: Some(draft.author),
        };

        // Validated up front so a malformed scope comes back as `InvalidInput` — something the
        // model can fix and retry — rather than as `Unavailable`, which reads as "try later".
        store::validate(&input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let stamped = store::SnapshotAnchor {
            as_of: Some(anchor.as_of),
            hash: Some(anchor.snapshot.clone()),
            coverage: serde_json::to_value(&anchor.coverage).ok(),
        };

        store::save_analysis(
            &self.pool,
            &input,
            "mcp",
            Some(&stamped),
            Some(anchor.net_worth_usd),
            None,
        )
        .await
        .map(record_from)
        .map_err(|e| ToolError::Unavailable(format!("saving the analysis: {e:#}")))
    }

    async fn list(&self, query: AnalysisQuery) -> Result<Vec<AnalysisRecord>, ToolError> {
        let stored = store::AnalysisQuery {
            scope: query.scope,
            kind: query.kind,
            // Both writers' entries, on purpose: the desk should see what the user wrote by hand.
            source: None,
            latest_only: query.latest_only,
            include_archived: false,
            limit: query.limit as i64,
        };
        store::list_analyses(&self.pool, &stored)
            .await
            .map(|rows| rows.into_iter().map(record_from).collect())
            .map_err(|e| ToolError::Unavailable(format!("listing analyses: {e:#}")))
    }

    async fn get(&self, id: &str) -> Result<Option<AnalysisRecord>, ToolError> {
        store::get_analysis(&self.pool, id)
            .await
            .map(|row| row.map(record_from))
            .map_err(|e| ToolError::Unavailable(format!("reading the analysis: {e:#}")))
    }
}

/// The life OS, on the same SQLite database the web app writes.
///
/// It holds the owner id, resolved once at boot by `lyra_db::life::resolve_owner`, and **no tool
/// argument can change it**. That is the whole reason the owner lives here rather than in a tool
/// schema: the model never gets to name whose tasks it is reading, so there is no argument to get
/// wrong and none to talk it into.
///
/// Every method is a read. There is no write path in this type, which keeps the audit that
/// `sources.rs` exists for — one file that answers "what can this process actually do" — as short
/// as it was before the life OS arrived.
pub struct SqliteLife {
    pool: SqlitePool,
    owner: String,
}

impl SqliteLife {
    pub fn new(pool: SqlitePool, owner: impl Into<String>) -> Self {
        Self {
            pool,
            owner: owner.into(),
        }
    }
}

/// Anything that goes wrong reading the life store is `Unavailable`, never `InvalidInput`.
///
/// The distinction is what the model does next: `InvalidInput` means "you asked wrongly, fix the
/// arguments", and a database that is locked or missing is not something better arguments fix.
/// The one exception is a malformed cursor, which the caller genuinely can fix — see `list`.
fn unavailable(what: &str, e: anyhow::Error) -> ToolError {
    ToolError::Unavailable(format!("{what}: {e:#}"))
}

fn query_from(query: LifeQuery) -> life::EntityQuery {
    life::EntityQuery {
        kind: query.kind,
        statuses: query.statuses,
        parent_id: query.parent_id,
        project_id: query.project_id,
        text: query.text,
        due_from: query.due_from,
        due_to: query.due_to,
        include_archived: query.include_archived,
        order: match query.order {
            LifeOrder::Recent => life::EntityOrder::Recent,
            LifeOrder::Due => life::EntityOrder::Due,
        },
        limit: query.limit,
        cursor: query.cursor,
    }
}

fn briefs(rows: &[life::Entity]) -> Vec<Value> {
    rows.iter().map(life::Entity::to_brief).collect()
}

impl LifeSource for SqliteLife {
    async fn list(&self, query: LifeQuery) -> Result<LifePage, ToolError> {
        let had_cursor = query.cursor.is_some();
        let page = life::list_entities(&self.pool, &self.owner, &query_from(query))
            .await
            .map_err(|e| {
                // A cursor the caller made up is the one failure here it can actually correct, so
                // it comes back as InvalidInput with the reason attached rather than as "try
                // later", which would have it retry the same bad cursor forever.
                if had_cursor {
                    ToolError::InvalidInput(format!("{e:#}"))
                } else {
                    unavailable("listing entities", e)
                }
            })?;
        Ok(LifePage {
            rows: briefs(&page.rows),
            next: page.next.map(|c| c.encode()),
        })
    }

    async fn get(&self, id: &str) -> Result<Option<Value>, ToolError> {
        life::get_entity(&self.pool, &self.owner, id)
            .await
            .map(|row| row.as_ref().map(life::Entity::to_json))
            .map_err(|e| unavailable("fetching an entity", e))
    }

    async fn relations(
        &self,
        entity: Option<String>,
        limit: usize,
    ) -> Result<Vec<Value>, ToolError> {
        life::list_relations(&self.pool, &self.owner, entity.as_deref(), limit)
            .await
            .map(|rows| rows.iter().map(life::Relation::to_json).collect())
            .map_err(|e| unavailable("listing relations", e))
    }

    async fn trackers(
        &self,
        entity: Option<String>,
        start: Option<String>,
        end: Option<String>,
        limit: usize,
    ) -> Result<Vec<Value>, ToolError> {
        life::list_trackers(
            &self.pool,
            &self.owner,
            entity.as_deref(),
            start.as_deref(),
            end.as_deref(),
            limit,
        )
        .await
        .map(|rows| rows.iter().map(life::Tracker::to_json).collect())
        .map_err(|e| unavailable("listing measurements", e))
    }

    async fn schedules(
        &self,
        entity: Option<String>,
        active_only: bool,
        due_on_or_before: Option<String>,
        limit: usize,
    ) -> Result<Vec<Value>, ToolError> {
        life::list_schedules(
            &self.pool,
            &self.owner,
            entity.as_deref(),
            active_only,
            due_on_or_before.as_deref(),
            limit,
        )
        .await
        .map(|rows| rows.iter().map(life::Schedule::to_json).collect())
        .map_err(|e| unavailable("listing recurrences", e))
    }

    async fn agenda(&self, day: String, limit: usize) -> Result<LifeAgenda, ToolError> {
        let out = life::agenda(&self.pool, &self.owner, &day, limit)
            .await
            .map_err(|e| unavailable("building the agenda", e))?;
        Ok(LifeAgenda {
            day: out.day,
            overdue: briefs(&out.overdue),
            due_today: briefs(&out.due_today),
            in_progress: briefs(&out.in_progress),
            habits_due: out.habits_due.iter().map(life::Schedule::to_json).collect(),
            upcoming: briefs(&out.upcoming),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// The glue between `lyra_db::life` and the desk, against a real database.
    ///
    /// The store's SQL is tested in `lyra-db` and the desk's assembly is tested against a double
    /// in `server.rs`; what neither reaches is this file's two decisions — which projection each
    /// method hands up, and which errors the model is told it can correct.
    async fn life(rows: &[(&str, &str, &str)]) -> (TempDir, SqliteLife) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        for (id, title, description) in rows {
            sqlx::query(
                "INSERT INTO entities (id, type, title, description, status, priority, tags, \
                 metadata, ownerId, visibility, createdAt, updatedAt) \
                 VALUES (?, 'task', ?, ?, 'todo', 'medium', '[]', '{}', 'me', 'private', ?, ?)",
            )
            .bind(id)
            .bind(title)
            .bind(description)
            .bind(*id)
            .bind(*id)
            .execute(&pool)
            .await
            .unwrap();
        }
        (dir, SqliteLife::new(pool, "me"))
    }

    #[tokio::test]
    async fn a_list_is_brief_and_one_row_is_whole() {
        let (_dir, store) = life(&[("a", "one", "a long body")]).await;

        let page = store.list(LifeQuery::default()).await.unwrap();
        assert_eq!(page.rows.len(), 1);
        assert!(
            page.rows[0].get("description").is_none(),
            "a list must not carry bodies: {:?}",
            page.rows[0]
        );

        let whole = store.get("a").await.unwrap().unwrap();
        assert_eq!(whole["description"], "a long body");
    }

    #[tokio::test]
    async fn a_cursor_survives_the_round_trip_and_a_made_up_one_is_the_callers_to_fix() {
        let (_dir, store) = life(&[("a", "one", ""), ("b", "two", "")]).await;

        let first = store
            .list(LifeQuery {
                limit: 1,
                ..Default::default()
            })
            .await
            .unwrap();
        let cursor = first.next.expect("two rows and a limit of one continues");
        let second = store
            .list(LifeQuery {
                limit: 1,
                cursor: Some(cursor),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_ne!(second.rows[0]["id"], first.rows[0]["id"]);

        // A cursor the model invented is the one failure here it can actually correct, so it must
        // not come back as "try later" — which would have it retry the same bad cursor forever.
        let err = store
            .list(LifeQuery {
                cursor: Some("nonsense".into()),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn the_store_answers_for_its_owner_and_nobody_elses() {
        let (_dir, store) = life(&[("a", "mine", "")]).await;
        assert_eq!(store.list(LifeQuery::default()).await.unwrap().rows.len(), 1);

        let stranger = SqliteLife::new(store.pool.clone(), "someone-else");
        assert!(stranger.list(LifeQuery::default()).await.unwrap().rows.is_empty());
        assert!(stranger.get("a").await.unwrap().is_none());
    }
}
