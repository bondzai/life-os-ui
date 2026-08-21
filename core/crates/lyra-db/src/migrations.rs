//! Forward-only schema migrations, tracked by `PRAGMA user_version`.
//!
//! The convention is inherited from `wallet-portfolio/db.py` and argued for in its `DB_DESIGN.md`:
//! `MIGRATIONS[i]` takes the database from `user_version = i` to `i + 1`. **Never edit or reorder a
//! shipped entry — only append.** There are no down-migrations; restore from a backup instead.
//!
//! This chain starts fresh rather than replaying the two legacy chains, because `lyra.db` is a new
//! database that legacy rows are *imported* into (see [`crate::import`]).

use anyhow::{Context, Result};
use sqlx::{AssertSqlSafe, SqlitePool};

pub const MIGRATIONS: &[&[&str]] = &[
    // v0 -> v1: Lyra core. Column names are camelCase to match the Drizzle schema they replace
    // (`api/src/db/schema.ts`) — renaming them would be a breaking API change for no gain.
    &[
        r#"CREATE TABLE IF NOT EXISTS users (
               id        TEXT PRIMARY KEY,
               name      TEXT,
               role      TEXT,
               pin       TEXT,           -- bcrypt hash; the algorithm is NOT negotiable, see docs
               avatarUrl TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS entities (
               id          TEXT PRIMARY KEY,
               type        TEXT,
               title       TEXT,
               description TEXT,
               status      TEXT DEFAULT 'todo',
               priority    TEXT DEFAULT 'medium',
               tags        TEXT,          -- JSON array
               metadata    TEXT,          -- JSON object
               parentId    TEXT,
               ownerId     TEXT,
               visibility  TEXT DEFAULT 'private',
               dueDate     TEXT,
               createdAt   TEXT,
               updatedAt   TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS trackers (
               id        TEXT PRIMARY KEY,
               entityId  TEXT,
               value     REAL,
               unit      TEXT,
               note      TEXT,
               timestamp TEXT,
               ownerId   TEXT
           )"#,
        r#"CREATE TABLE IF NOT EXISTS schedules (
               id            TEXT PRIMARY KEY,
               entityId      TEXT,
               recurrence    TEXT,
               nextDue       TEXT,
               lastCompleted TEXT,
               isActive      INTEGER DEFAULT 1
           )"#,
        r#"CREATE TABLE IF NOT EXISTS relations (
               id     TEXT PRIMARY KEY,
               fromId TEXT,
               toId   TEXT,
               type   TEXT
           )"#,
        // Declared in the Drizzle schema but missing from the live life-os.db, which is why
        // Google Calendar fails there today. Creating it here closes that drift.
        r#"CREATE TABLE IF NOT EXISTS google_tokens (
               userId       TEXT PRIMARY KEY,
               accessToken  TEXT,
               refreshToken TEXT,
               expiresAt    TEXT,
               calendarId   TEXT
           )"#,
        // The three filters every entity list query uses (`api/src/routes/entities.ts:44-52`).
        "CREATE INDEX IF NOT EXISTS idx_entities_owner_type ON entities(ownerId, type)",
        "CREATE INDEX IF NOT EXISTS idx_entities_parent ON entities(parentId)",
        "CREATE INDEX IF NOT EXISTS idx_trackers_entity ON trackers(entityId)",
    ],
    // v1 -> v2: the wealth tables, carried over from pow.db (db.py MIGRATIONS v1-v5).
    &[
        r#"CREATE TABLE IF NOT EXISTS nw_history (
               grp   TEXT    NOT NULL,   -- account-group id (sanitized)
               d     INTEGER NOT NULL,   -- UTC-midnight epoch ms (day key, client-stamped)
               v     REAL    NOT NULL,   -- net worth, USD
               tiers TEXT,               -- JSON {store,business,trading} or NULL
               debt  REAL,               -- borrow debt netted from v, or NULL
               PRIMARY KEY (grp, d)
           )"#,
        r#"CREATE TABLE IF NOT EXISTS snapshots (
               ts        INTEGER NOT NULL,   -- epoch seconds (server clock)
               grp       TEXT    NOT NULL,
               net_worth REAL    NOT NULL,   -- assets - debt, USD
               assets    REAL,
               debt      REAL,
               btc_usd   REAL,
               btc_sats  REAL,              -- price-invariant BTC reserves
               extra     TEXT               -- JSON escape hatch
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_snapshots_grp_ts ON snapshots(grp, ts)",
        // `archived_at` was pow.db's v4 ALTER; folded in here since this chain starts fresh.
        r#"CREATE TABLE IF NOT EXISTS analyses (
               id             TEXT    PRIMARY KEY,
               scope          TEXT    NOT NULL,
               version        INTEGER NOT NULL,   -- 1-based, per scope
               kind           TEXT    NOT NULL,
               title          TEXT    NOT NULL,
               summary        TEXT,
               body_md        TEXT    NOT NULL,   -- UNTRUSTED LLM text; never eval/render as HTML
               structured     TEXT,               -- JSON {conviction, actions[], evidence[], risks[], tags[]}
               snapshot_as_of INTEGER,
               snapshot_hash  TEXT,               -- anchors the analysis to a data state
               coverage       TEXT,
               net_worth_usd  REAL,
               author         TEXT,
               source         TEXT    NOT NULL,   -- 'mcp' | 'http'
               created_at     INTEGER NOT NULL,
               superseded_by  TEXT,
               archived_at    INTEGER
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_analyses_scope_ver ON analyses(scope, version)",
        "CREATE INDEX IF NOT EXISTS idx_analyses_latest ON analyses(scope) WHERE superseded_by IS NULL",
        "CREATE INDEX IF NOT EXISTS idx_analyses_kind_ts ON analyses(kind, created_at)",
        r#"CREATE TABLE IF NOT EXISTS pos_perf (
               key            TEXT    PRIMARY KEY,        -- "<chainId>:<tokenId>"
               harvest_anchor TEXT,                       -- a change resets the cycle
               cycle_start    INTEGER,
               in_range_secs  REAL    NOT NULL DEFAULT 0,
               last_sample_ts INTEGER
           )"#,
    ],
    // v2 -> v3: the two tables DB_DESIGN.md planned but never built. `alert_state` is what lets
    // notify.py's dedup survive a restart — today it lives in a temp JSON file and does not.
    &[
        r#"CREATE TABLE IF NOT EXISTS kv_cache (
               key        TEXT PRIMARY KEY,
               value_json TEXT    NOT NULL,
               fetched_at INTEGER NOT NULL,   -- epoch seconds
               ttl        INTEGER             -- seconds; NULL = no expiry
           )"#,
        r#"CREATE TABLE IF NOT EXISTS alert_state (
               key        TEXT PRIMARY KEY,
               value_json TEXT    NOT NULL,
               updated_at INTEGER NOT NULL
           )"#,
    ],
    // v3 -> v4: off-chain assets get a server-side home.
    //
    // These lived in the browser's `localStorage` under `lyra:wealth:manual-assets` — which is why
    // `snapshots` could only ever be the on-chain trend, and why the legacy `nw_history` series
    // (which *did* include them) was never comparable with it. One device, no backup, and gone
    // with a cleared cache.
    //
    // `value` is stored in the asset's own denomination with `ccy` naming it, rather than
    // pre-converted to USD: a THB balance is 180,000 THB whatever the rate did today, and
    // converting on write would freeze a rate into what is meant to be a standing fact.
    &[
        r#"CREATE TABLE IF NOT EXISTS manual_assets (
               id         TEXT PRIMARY KEY,
               name       TEXT    NOT NULL,
               kind       TEXT,               -- 'jlp' | 'kgold' | 'lightning' | NULL
               value      REAL,               -- in `ccy`, not USD
               ccy        TEXT,               -- 'usd' | 'thb' | 'sats'; NULL means usd
               units      REAL,
               code       TEXT,
               tier       TEXT    NOT NULL,   -- 'store' | 'business' | 'trading'
               chain      TEXT,
               note       TEXT,
               custody    TEXT,               -- 'cold' | 'custodial'
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
           )"#,
        "CREATE INDEX IF NOT EXISTS idx_manual_assets_tier ON manual_assets(tier)",
    ],
];

/// Applies every migration the database has not seen yet. Returns the resulting `user_version`.
pub async fn migrate(pool: &SqlitePool) -> Result<u32> {
    let current: i64 = sqlx::query_scalar("PRAGMA user_version")
        .fetch_one(pool)
        .await
        .context("reading user_version")?;
    let current = u32::try_from(current.max(0)).unwrap_or(0);

    if current as usize > MIGRATIONS.len() {
        anyhow::bail!(
            "database is at user_version {current} but this binary only knows {}. \
             Refusing to run against a newer schema — use a newer build.",
            MIGRATIONS.len()
        );
    }

    for (index, statements) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let version = index + 1;
        let mut tx = pool
            .begin()
            .await
            .context("opening migration transaction")?;
        for statement in *statements {
            sqlx::raw_sql(*statement)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("migration v{version}: {}", first_line(statement)))?;
        }
        // PRAGMA does not accept a bound parameter, hence the format!. `version` is a usize
        // from our own iteration, never user input.
        sqlx::raw_sql(AssertSqlSafe(format!("PRAGMA user_version = {version}")))
            .execute(&mut *tx)
            .await
            .with_context(|| format!("stamping user_version = {version}"))?;
        tx.commit()
            .await
            .with_context(|| format!("committing migration v{version}"))?;
        tracing::info!(version, "applied migration");
    }

    Ok(MIGRATIONS.len() as u32)
}

fn first_line(statement: &str) -> &str {
    statement.trim().lines().next().unwrap_or(statement).trim()
}
