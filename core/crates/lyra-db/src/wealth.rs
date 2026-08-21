//! Wealth storage — port of `wallet-portfolio/history.py`, `snapshots.py`, and `journal.py`.
//!
//! Three separate series live in this crate's tables, and confusing them is the easiest mistake to
//! make when reading the code:
//!
//! * **`nw_history`** — the daily net-worth series the chart draws. Historically the *browser*
//!   POSTed it, because only the browser knew the off-chain assets; the server now writes it too,
//!   from the same reading it files as a snapshot. One point per UTC day, last write wins.
//! * **`snapshots`** — the *server's* net worth, written by the always-on notify cron. It accrues
//!   24/7 with no browser open.
//! * **`manual_assets`** — the off-chain book: cold-storage BTC, metals, a bank balance. This is
//!   what used to live in `localStorage`, and moving it here is what makes the two series above
//!   measure the same thing. **Points written before 2026-08-21 do not include it** — see
//!   `docs/parity.md` on why the legacy series was not spliced onto the live one.
//! * **`analyses`** — append-only, versioned LLM-authored reasoning about the book.
//!
//! The schema is owned by [`crate::migrations`]; nothing here creates or alters a table.
//!
//! Four invariants carry real operational weight, and each has a test named after it:
//!
//! 1. `nw_history`'s `PRIMARY KEY (grp, d)` makes the daily POST an **idempotent upsert** — the
//!    incoming row wins its day, so re-posting is a no-op rather than a duplicate.
//! 2. The snapshot throttle is **durable**: it reads the last stored row rather than remembering
//!    anything in process, so a restart cannot produce a double write. That is the exact bug the
//!    old JSON-file implementation had.
//! 3. `analyses` versions are **1-based per scope**, and writing a new version stamps the previous
//!    row's `superseded_by` in the same transaction, so "latest per scope" is a single indexed
//!    predicate (`superseded_by IS NULL`) rather than a correlated subquery.
//! 4. `archived_at` is a **soft delete**: the rows stay, the scope simply drops out of the default
//!    listing, and saving a new version brings it back.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::types::JsonValue;
use sqlx::{AssertSqlSafe, Row, SqlitePool};

/// Epoch seconds now. Every write takes `now: Option<i64>` so tests can pin the clock, mirroring
/// the Python's `now=None` parameter.
fn now_or(now: Option<i64>) -> i64 {
    now.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    })
}

/// A 32-hex-character identifier, the shape `uuid.uuid4().hex` produced in the Python.
///
/// Hand-rolled because this crate has no `uuid` dependency and one is not worth adding for a single
/// call site. Uniqueness comes from the nanosecond clock plus a process-local counter, so two ids
/// can only collide across processes within the same nanosecond — and `id` is the PRIMARY KEY, so
/// even then the insert fails loudly rather than overwriting an analysis. Ask for the `uuid` crate
/// if this ever needs to be globally unique by construction.
fn new_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    // Mixed so the id does not read as a sortable timestamp — callers must not infer order from it.
    let hi = nanos.rotate_left(17) ^ seq.wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let lo = nanos.wrapping_mul(0xD6E8_FEB8_6659_FD93) ^ seq;
    format!("{hi:016x}{lo:016x}")
}

/// Reads a `TEXT` column holding JSON, tolerating rows written before a shape changed.
///
/// A malformed blob is treated as absent rather than fatal: these columns are decoration on a row
/// whose numbers are still perfectly good, and the Python swallows the same parse errors.
fn json_column(row: &sqlx::sqlite::SqliteRow, column: &str) -> Option<JsonValue> {
    row.try_get::<Option<String>, _>(column)
        .ok()
        .flatten()
        .and_then(|raw| raw.parse::<JsonValue>().ok())
}

// =============================================================================================
// nw_history — the browser's net-worth series
// =============================================================================================

/// Roughly two years of daily points. Older days are pruned on write.
pub const MAX_POINTS: i64 = 730;

/// Ceiling on one POST. A real client cannot have more days than this, so anything larger is a
/// buggy or hostile payload and is truncated before it reaches the database.
pub const MAX_INGEST: usize = 1000;

/// Sanitizes a client-supplied group id to a safe token.
///
/// Lowercase first, then drop anything outside `[a-z0-9_-]`, then truncate — in that order,
/// because it is what produced the legacy `history_<group>.json` filenames the importer still has
/// to match. An id that sanitizes away entirely becomes `default` rather than empty.
pub fn safe_group(raw: &str) -> String {
    let cleaned: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

/// One day of the net-worth series.
#[derive(Debug, Clone, PartialEq)]
pub struct Point {
    /// UTC-midnight epoch **milliseconds**, stamped client-side so both ends agree on where a day
    /// begins regardless of server timezone.
    pub d: i64,
    /// Net worth in USD.
    pub v: f64,
    /// Optional `{store, business, trading}` split.
    pub tiers: Option<JsonValue>,
    /// Borrow debt already netted out of `v`, kept for display.
    pub debt: Option<f64>,
}

/// Validates one incoming point, returning `None` if it is not well formed.
///
/// `d` and `v` are required and must be numeric; everything else is optional. Tier entries that are
/// not numbers are dropped individually rather than rejecting the whole point — the Python does the
/// same, and losing one bad tier beats losing the day.
pub fn clean_point(raw: &JsonValue) -> Option<Point> {
    let d = raw.get("d").and_then(as_i64)?;
    let v = raw.get("v").and_then(as_f64)?;

    let tiers = raw.get("tiers").and_then(|t| t.as_object()).map(|obj| {
        let kept: Vec<(String, JsonValue)> = obj
            .iter()
            .filter_map(|(k, x)| Some((k.clone(), JsonValue::from(x.as_f64()?))))
            .collect();
        JsonValue::Object(kept.into_iter().collect())
    });

    Some(Point {
        d,
        v,
        tiers,
        debt: raw.get("debt").and_then(|x| x.as_f64()),
    })
}

/// A JSON number as `i64`, accepting a float day key the way Python's `int()` would.
fn as_i64(value: &JsonValue) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_f64().map(|f| f.trunc() as i64))
}

fn as_f64(value: &JsonValue) -> Option<f64> {
    value.as_f64()
}

fn row_to_point(row: &sqlx::sqlite::SqliteRow) -> Result<Point> {
    Ok(Point {
        d: row.try_get("d")?,
        v: row.try_get("v")?,
        tiers: json_column(row, "tiers"),
        debt: row.try_get("debt")?,
    })
}

/// The stored series for a group, oldest to newest.
pub async fn load_history(pool: &SqlitePool, group: &str) -> Result<Vec<Point>> {
    let group = safe_group(group);
    let rows = sqlx::query("SELECT d, v, tiers, debt FROM nw_history WHERE grp = ? ORDER BY d")
        .bind(&group)
        .fetch_all(pool)
        .await
        .with_context(|| format!("loading nw_history for {group}"))?;
    rows.iter().map(row_to_point).collect()
}

/// Merges `points` into the stored series and returns the full merged result.
///
/// The upsert deliberately overwrites `tiers` and `debt` from the incoming row, not just `v`: the
/// client owns its day completely, so a point that arrives *without* tiers clears whatever was
/// there. Anything else would leave a day showing a stale tier split next to a fresh total.
///
/// Returning the whole series (rather than an ack) is what lets one call both backfill the client
/// and sync it across devices — it adopts the union of what it sent and what was already stored.
pub async fn save_history(pool: &SqlitePool, group: &str, points: &[Point]) -> Result<Vec<Point>> {
    let group = safe_group(group);
    let incoming: Vec<&Point> = points.iter().take(MAX_INGEST).collect();

    if !incoming.is_empty() {
        let mut tx = pool.begin().await.context("opening nw_history write")?;
        for point in &incoming {
            sqlx::query(
                "INSERT INTO nw_history (grp, d, v, tiers, debt) VALUES (?, ?, ?, ?, ?) \
                 ON CONFLICT(grp, d) DO UPDATE SET v = excluded.v, tiers = excluded.tiers, \
                 debt = excluded.debt",
            )
            .bind(&group)
            .bind(point.d)
            .bind(point.v)
            .bind(point.tiers.as_ref().map(|t| t.to_string()))
            .bind(point.debt)
            .execute(&mut *tx)
            .await
            .with_context(|| format!("upserting nw_history day {}", point.d))?;
        }

        // Prune only after an actual write, matching the Python: a read-shaped call that happens to
        // carry no valid points must not silently delete history.
        sqlx::query(
            "DELETE FROM nw_history WHERE grp = ? AND d NOT IN \
             (SELECT d FROM nw_history WHERE grp = ? ORDER BY d DESC LIMIT ?)",
        )
        .bind(&group)
        .bind(&group)
        .bind(MAX_POINTS)
        .execute(&mut *tx)
        .await
        .context("capping nw_history")?;

        tx.commit().await.context("committing nw_history write")?;
    }

    load_history(pool, &group).await
}

/// Folds pre-SQLite `history_<group>.json` files into the database.
///
/// A group is imported **only if it has no rows yet**, so this never clobbers newer data and is
/// safe to re-run; that guard is why this is an explicit startup call here rather than the Python's
/// hidden once-per-process global. A bad file is skipped rather than aborting the rest — one
/// corrupt legacy group must not block the others from upgrading.
///
/// Returns the number of points imported.
pub async fn import_legacy_history(pool: &SqlitePool, dir: &Path) -> Result<usize> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Ok(0); // no legacy directory at all is the normal case on a fresh install
    };

    let mut imported = 0usize;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(group) = name
            .strip_prefix("history_")
            .and_then(|rest| rest.strip_suffix(".json"))
        else {
            continue;
        };
        let group = safe_group(group);

        let existing: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM nw_history WHERE grp = ? LIMIT 1")
                .bind(&group)
                .fetch_optional(pool)
                .await
                .with_context(|| format!("checking existing rows for {group}"))?;
        if existing.is_some() {
            continue;
        }

        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(parsed) = text.parse::<JsonValue>() else {
            continue;
        };
        let Some(array) = parsed.as_array() else {
            continue;
        };
        let points: Vec<Point> = array.iter().filter_map(clean_point).collect();

        for point in &points {
            // OR IGNORE, not upsert: within one legacy file a repeated day keeps the first.
            sqlx::query(
                "INSERT OR IGNORE INTO nw_history (grp, d, v, tiers, debt) VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&group)
            .bind(point.d)
            .bind(point.v)
            .bind(point.tiers.as_ref().map(|t| t.to_string()))
            .bind(point.debt)
            .execute(pool)
            .await
            .with_context(|| format!("importing legacy point for {group}"))?;
            imported += 1;
        }
    }
    Ok(imported)
}

// =============================================================================================
// snapshots — the server's net-worth series
// =============================================================================================

/// Roughly two years at hourly cadence — a guardrail against unbounded growth, per group.
pub const SNAPSHOT_MAX_ROWS: i64 = 20_000;

/// Default minimum gap between snapshots for one group.
pub const DEFAULT_MIN_INTERVAL: i64 = 3600;

/// Default page size for [`snapshot_series`].
pub const DEFAULT_SERIES_LIMIT: i64 = 2000;

/// What the cron records each time it reads the keyless book.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotInput {
    /// Assets minus debt, USD. The only required figure.
    pub net_worth: f64,
    pub assets: Option<f64>,
    pub debt: Option<f64>,
    pub btc_usd: Option<f64>,
    /// BTC reserves in sats — price-invariant, so a drawdown in USD terms is distinguishable from
    /// actually holding less bitcoin.
    pub btc_sats: Option<f64>,
    /// JSON escape hatch for fields that have not earned a column yet.
    pub extra: Option<JsonValue>,
}

/// One row of the server-recorded series.
#[derive(Debug, Clone, PartialEq)]
pub struct SnapshotPoint {
    pub ts: i64,
    /// `net_worth`, named `v` on the wire to match the browser series' point shape.
    pub v: f64,
    pub assets: Option<f64>,
    pub debt: Option<f64>,
    pub btc_usd: Option<f64>,
    pub btc_sats: Option<f64>,
}

/// Epoch seconds of the most recent snapshot for a group, or `0` if there are none.
///
/// Zero (rather than an `Option`) is deliberate: it makes the throttle arithmetic in
/// [`record_snapshot`] fall through to "write" on an empty group with no special case.
pub async fn last_snapshot_ts(pool: &SqlitePool, group: &str) -> Result<i64> {
    let ts: Option<i64> =
        sqlx::query_scalar("SELECT ts FROM snapshots WHERE grp = ? ORDER BY ts DESC LIMIT 1")
            .bind(group)
            .fetch_optional(pool)
            .await
            .with_context(|| format!("reading last snapshot ts for {group}"))?;
    Ok(ts.unwrap_or(0))
}

/// Appends a snapshot unless one was already written within `min_interval` seconds.
///
/// **The throttle reads the last stored row, deliberately.** An in-process timer looks equivalent
/// and is not: the cron restarts (deploys, crashes, the mini PC rebooting), and every restart would
/// reset an in-memory timer and write again immediately. That is the bug the JSON-file version had.
/// Reading the database means the throttle survives anything that does not delete data.
///
/// Returns `true` if a row was written.
pub async fn record_snapshot(
    pool: &SqlitePool,
    group: &str,
    input: &SnapshotInput,
    min_interval: i64,
    now: Option<i64>,
) -> Result<bool> {
    let now = now_or(now);
    if now - last_snapshot_ts(pool, group).await? < min_interval {
        return Ok(false);
    }

    let mut tx = pool.begin().await.context("opening snapshot write")?;
    sqlx::query(
        "INSERT INTO snapshots (ts, grp, net_worth, assets, debt, btc_usd, btc_sats, extra) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(now)
    .bind(group)
    .bind(input.net_worth)
    .bind(input.assets)
    .bind(input.debt)
    .bind(input.btc_usd)
    .bind(input.btc_sats)
    // An empty `extra` stores as NULL rather than "{}", matching the Python's truthiness check —
    // it keeps the column meaning "there is something extra here".
    .bind(
        input
            .extra
            .as_ref()
            .filter(|e| !is_empty_json(e))
            .map(|e| e.to_string()),
    )
    .execute(&mut *tx)
    .await
    .with_context(|| format!("recording snapshot for {group}"))?;

    // The same reading, filed as a daily point.
    //
    // `snapshots` is a fine-grained log that gets pruned; `nw_history` is the daily series the
    // net-worth chart draws, and until now the only thing that wrote it was the old browser app
    // POSTing to `/history`. Nothing in Lyra does, so the chart could never fill in — it read a
    // table that had stopped growing the day the port landed. One point per UTC day, last write
    // wins, which is exactly what the browser did.
    let day_ms = (now.div_euclid(86_400)) * 86_400 * 1_000;
    sqlx::query(
        "INSERT INTO nw_history (grp, d, v, debt) VALUES (?, ?, ?, ?) \
         ON CONFLICT(grp, d) DO UPDATE SET v = excluded.v, debt = excluded.debt",
    )
    .bind(group)
    .bind(day_ms)
    .bind(input.net_worth)
    .bind(input.debt)
    .execute(&mut *tx)
    .await
    .with_context(|| format!("recording daily net worth for {group}"))?;

    // Prune by timestamp value, so rows sharing a second are kept or dropped together.
    sqlx::query(
        "DELETE FROM snapshots WHERE grp = ? AND ts NOT IN \
         (SELECT ts FROM snapshots WHERE grp = ? ORDER BY ts DESC LIMIT ?)",
    )
    .bind(group)
    .bind(group)
    .bind(SNAPSHOT_MAX_ROWS)
    .execute(&mut *tx)
    .await
    .context("capping snapshots")?;

    tx.commit().await.context("committing snapshot")?;
    Ok(true)
}

/// Whether a JSON value carries nothing worth storing (Python's `if extra`).
fn is_empty_json(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => true,
        JsonValue::Object(o) => o.is_empty(),
        JsonValue::Array(a) => a.is_empty(),
        JsonValue::String(s) => s.is_empty(),
        _ => false,
    }
}

/// The stored snapshots for a group, oldest to newest, capped to the newest `limit`.
///
/// The query takes the newest rows and the result is then reversed, so a `limit` smaller than the
/// series returns the most *recent* window rather than the oldest one.
pub async fn snapshot_series(
    pool: &SqlitePool,
    group: &str,
    limit: i64,
) -> Result<Vec<SnapshotPoint>> {
    let rows = sqlx::query(
        "SELECT ts, net_worth, assets, debt, btc_usd, btc_sats FROM snapshots \
         WHERE grp = ? ORDER BY ts DESC LIMIT ?",
    )
    .bind(group)
    .bind(limit)
    .fetch_all(pool)
    .await
    .with_context(|| format!("reading snapshots for {group}"))?;

    let mut out: Vec<SnapshotPoint> = rows
        .iter()
        .map(|row| {
            Ok(SnapshotPoint {
                ts: row.try_get("ts")?,
                v: row.try_get("net_worth")?,
                assets: row.try_get("assets")?,
                debt: row.try_get("debt")?,
                btc_usd: row.try_get("btc_usd")?,
                btc_sats: row.try_get("btc_sats")?,
            })
        })
        .collect::<Result<_>>()?;
    out.reverse();
    Ok(out)
}

// =============================================================================================
// analyses — the append-only journal
// =============================================================================================

pub const MAX_TITLE: usize = 200;
pub const MAX_SUMMARY: usize = 1_000;
pub const MAX_BODY: usize = 100_000;
/// Cap on the serialized `structured` payload.
pub const MAX_STRUCTURED: usize = 32_768;
/// Ceiling on one listing, and the default when none is given.
pub const MAX_LIST_LIMIT: i64 = 200;
pub const DEFAULT_LIST_LIMIT: i64 = 50;

/// The kinds of reasoning the journal accepts. Closed on purpose: the Journal panel renders each
/// differently, so an unknown kind would display as nothing.
pub const KINDS: [&str; 5] = [
    "strategy_review",
    "position_note",
    "market_thesis",
    "risk_flag",
    "general",
];

/// A rejected write. Callers map [`JournalError::RateLimited`] to 429 and the rest to 422.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    BadScope,
    BadKind,
    MissingTitle,
    MissingBody,
    TooLarge(&'static str),
    RateLimited,
}

impl std::fmt::Display for JournalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadScope => write!(
                f,
                "scope must match '<namespace>:<id>' (e.g. strategy:main, position:hyperevm:64176)"
            ),
            Self::BadKind => write!(f, "kind must be one of {:?}", KINDS),
            Self::MissingTitle => write!(f, "title is required"),
            Self::MissingBody => write!(f, "body_md is required"),
            Self::TooLarge(field) => write!(f, "{field} exceeds its size cap"),
            Self::RateLimited => {
                write!(f, "rate limit exceeded — too many analyses saved recently")
            }
        }
    }
}

impl std::error::Error for JournalError {}

// ===========================================================================================
// pos_perf — the cron's in-range accumulators (read side)
// ===========================================================================================

/// One position's accumulated in-range time, as `_vfat_stamp_lifecycle` reads it.
///
/// Mirrors `position_perf.get_many`'s row: the writer is the alert loop, and every build is
/// strictly read-only against this table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PerfRecord {
    pub in_range_secs: f64,
    pub cycle_start: Option<i64>,
}

/// Cap on the time one sample may attribute — `position_perf._MAX_SAMPLE_GAP`.
///
/// Without it a cron gap or an overnight outage is credited in full as "in range", and a position
/// that was idle the whole time reads as though it had been earning.
pub const MAX_SAMPLE_GAP_SECS: f64 = 2.0 * 3600.0;

/// One observation of a position's range state, as the alert sweep produces it.
#[derive(Debug, Clone, PartialEq)]
pub struct PerfSample {
    pub key: String,
    pub in_range: bool,
    /// The position's `last_harvest_at`, or `""` when it has never been harvested. A *change* here
    /// is what opens a new cycle, so an empty string must round-trip as an empty string rather
    /// than as SQL `NULL` — otherwise every sweep would look like a fresh harvest.
    pub harvest_anchor: String,
    /// Where the cycle started, when one has to be opened.
    pub cycle_start_ts: Option<i64>,
}

/// Advance the in-range accumulators from a batch of observations — port of
/// `position_perf.sample`.
///
/// Only the alert loop may call this: it mutates persisted time, and a second writer would
/// double-count. Every build is read-only against this table (see [`perf_records`]).
///
/// Two behaviours worth keeping straight:
///
/// * A key that is new, **or** whose `harvest_anchor` differs from what is stored, opens a fresh
///   cycle at zero. That is the whole point — a harvest zeroes the fees, so the in-range clock it
///   is compared against has to zero with it.
/// * Otherwise the elapsed time since the last sample is credited to the *current* reading, capped
///   by [`MAX_SAMPLE_GAP_SECS`]. Sampling is coarse and forward-only by design: it can only measure
///   from the first sample after a harvest onward.
pub async fn record_perf_samples(
    pool: &SqlitePool,
    samples: &[PerfSample],
    now: i64,
) -> Result<usize> {
    let mut wanted: Vec<String> = Vec::new();
    for sample in samples {
        if !sample.key.is_empty() && !wanted.contains(&sample.key) {
            wanted.push(sample.key.clone());
        }
    }
    if wanted.is_empty() {
        return Ok(0);
    }

    let mut rows = perf_rows(pool, &wanted).await?;

    for sample in samples.iter().filter(|s| !s.key.is_empty()) {
        match rows.get_mut(&sample.key) {
            // Same cycle: credit the gap to whatever the position is doing right now.
            Some(row) if row.harvest_anchor == sample.harvest_anchor => {
                if sample.in_range {
                    let last = row.last_sample_ts.unwrap_or(now);
                    let gap = (now - last) as f64;
                    row.in_range_secs += gap.clamp(0.0, MAX_SAMPLE_GAP_SECS);
                }
                // Advanced whether or not the position was in range — otherwise the next tick
                // would credit the whole idle stretch the moment it comes back into range.
                row.last_sample_ts = Some(now);
            }
            // New position, or a harvest since the last sweep: open a cycle.
            _ => {
                rows.insert(
                    sample.key.clone(),
                    PerfRow {
                        harvest_anchor: sample.harvest_anchor.clone(),
                        cycle_start: Some(sample.cycle_start_ts.unwrap_or(now)),
                        in_range_secs: 0.0,
                        last_sample_ts: Some(now),
                    },
                );
            }
        }
    }

    let mut tx = pool.begin().await.context("opening pos_perf transaction")?;
    for (key, row) in &rows {
        sqlx::query(
            "INSERT INTO pos_perf(key, harvest_anchor, cycle_start, in_range_secs, last_sample_ts) \
             VALUES(?, ?, ?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET \
               harvest_anchor = excluded.harvest_anchor, \
               cycle_start    = excluded.cycle_start, \
               in_range_secs  = excluded.in_range_secs, \
               last_sample_ts = excluded.last_sample_ts",
        )
        .bind(key)
        .bind(&row.harvest_anchor)
        .bind(row.cycle_start)
        .bind(row.in_range_secs)
        .bind(row.last_sample_ts)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("writing pos_perf row {key}"))?;
    }
    tx.commit().await.context("committing pos_perf samples")?;
    Ok(rows.len())
}

/// The full row, as the writer needs it. [`perf_records`] returns only the two columns a build
/// reads; this one also carries the cycle bookkeeping.
#[derive(Debug, Clone, PartialEq)]
struct PerfRow {
    harvest_anchor: String,
    cycle_start: Option<i64>,
    in_range_secs: f64,
    last_sample_ts: Option<i64>,
}

/// The one read both the build and the sweep go through.
///
/// SQLite's default ceiling is 999 bound parameters and a single `IN (...)` past it errors, so the
/// keys are chunked. A portfolio with more LP positions than that is not worth a failed query.
async fn perf_rows(pool: &SqlitePool, keys: &[String]) -> Result<HashMap<String, PerfRow>> {
    const CHUNK: usize = 900;
    let mut out = HashMap::with_capacity(keys.len());

    for chunk in keys.chunks(CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT key, harvest_anchor, cycle_start, in_range_secs, last_sample_ts \
             FROM pos_perf WHERE key IN ({placeholders})"
        );
        // `AssertSqlSafe` is sound here: the only interpolation is a run of `?` placeholders whose
        // count comes from `chunk.len()`. Every key is bound, never formatted in.
        let mut query = sqlx::query(AssertSqlSafe(sql));
        for key in chunk {
            query = query.bind(key);
        }
        let rows = query
            .fetch_all(pool)
            .await
            .context("reading pos_perf rows")?;

        for row in &rows {
            let key: String = row.try_get("key")?;
            out.insert(
                key,
                PerfRow {
                    // A NULL anchor and an empty one must compare equal, or a never-harvested
                    // position would open a new cycle on every sweep and never accumulate.
                    harvest_anchor: row
                        .try_get::<Option<String>, _>("harvest_anchor")?
                        .unwrap_or_default(),
                    cycle_start: row.try_get("cycle_start")?,
                    // NOT NULL DEFAULT 0 in the schema, so always a real number.
                    in_range_secs: row.try_get("in_range_secs")?,
                    last_sample_ts: row.try_get("last_sample_ts")?,
                },
            );
        }
    }
    Ok(out)
}

/// Batch-read the accumulators for a set of `"<chainId>:<tokenId>"` keys.
///
/// One query for the whole portfolio rather than Python's one per chain — the keys are collected
/// from the finished snapshot, so there is nothing to gain from splitting it.
///
/// An unknown key is simply absent from the map, which is what makes the caller's join a no-op for
/// a position the cron has never sampled. Python swallows any error here and returns `{}`; this
/// propagates instead, because the caller is `Result`-shaped anyway and a silently empty map would
/// look exactly like "the cron has not run yet".
pub async fn perf_records(
    pool: &SqlitePool,
    keys: &[String],
) -> Result<HashMap<String, PerfRecord>> {
    Ok(perf_rows(pool, keys)
        .await?
        .into_iter()
        .map(|(key, row)| {
            (
                key,
                PerfRecord {
                    in_range_secs: row.in_range_secs,
                    cycle_start: row.cycle_start,
                },
            )
        })
        .collect())
}

/// What a caller submits.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AnalysisInput {
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    /// **Untrusted LLM text.** Never rendered as HTML — see the column comment in the migration.
    pub body_md: String,
    pub structured: Option<JsonValue>,
    pub author: Option<String>,
}

/// A validated payload, ready to insert. Only [`validate`] can produce one.
#[derive(Debug, Clone, PartialEq)]
pub struct CleanAnalysis {
    pub scope: String,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub body_md: String,
    pub structured_json: Option<String>,
    pub author: Option<String>,
}

/// The data state an analysis was reasoning about, stamped server-side from a fresh read.
///
/// The model never supplies this. If it could, a stale or invented analysis would be
/// indistinguishable from one grounded in real numbers.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SnapshotAnchor {
    pub as_of: Option<i64>,
    pub hash: Option<String>,
    pub coverage: Option<JsonValue>,
}

/// A stored analysis, in the shape the Journal panel reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Analysis {
    pub id: String,
    pub scope: String,
    pub version: i64,
    pub kind: String,
    pub title: String,
    pub summary: Option<String>,
    pub body_md: String,
    pub structured: Option<JsonValue>,
    pub author: Option<String>,
    /// `"mcp"` or `"http"` — which writer created it.
    pub source: String,
    pub created_at: i64,
    pub net_worth_usd: Option<f64>,
    /// Set to the id of the version that replaced this one; `None` means this is the latest.
    pub superseded_by: Option<String>,
    pub archived_at: Option<i64>,
    /// Present only when the row carries a snapshot hash.
    pub anchor: Option<SnapshotAnchor>,
}

/// Whether a scope is well formed: `<namespace>:<id>`, matching `^[a-z]+:[A-Za-z0-9:_-]{1,64}$`.
///
/// The id half may itself contain colons (`position:hyperevm:64176`), so the split is on the
/// **first** colon only.
fn scope_is_valid(scope: &str) -> bool {
    let Some((namespace, id)) = scope.split_once(':') else {
        return false;
    };
    if namespace.is_empty() || !namespace.chars().all(|c| c.is_ascii_lowercase()) {
        return false;
    }
    let len = id.chars().count();
    (1..=64).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-'))
}

/// Validates and normalizes a payload.
///
/// Pure, so the whole rule set is testable without a database. The caps are defence in depth: the
/// HTTP path may reach [`save_analysis`] without having gone through the schema layer, and a
/// runaway agent should hit a wall here rather than in the disk usage graph.
pub fn validate(input: &AnalysisInput) -> std::result::Result<CleanAnalysis, JournalError> {
    let scope = input.scope.trim();
    if !scope_is_valid(scope) {
        return Err(JournalError::BadScope);
    }
    let kind = input.kind.trim();
    if !KINDS.contains(&kind) {
        return Err(JournalError::BadKind);
    }
    let title = input.title.trim();
    if title.is_empty() {
        return Err(JournalError::MissingTitle);
    }
    if input.body_md.trim().is_empty() {
        return Err(JournalError::MissingBody);
    }

    let summary = input.summary.as_deref().unwrap_or("").trim();
    if title.chars().count() > MAX_TITLE {
        return Err(JournalError::TooLarge("title"));
    }
    if summary.chars().count() > MAX_SUMMARY {
        return Err(JournalError::TooLarge("summary"));
    }
    if input.body_md.chars().count() > MAX_BODY {
        return Err(JournalError::TooLarge("body_md"));
    }

    let structured_json = match &input.structured {
        Some(value) => {
            let encoded = value.to_string();
            if encoded.chars().count() > MAX_STRUCTURED {
                return Err(JournalError::TooLarge("structured"));
            }
            Some(encoded)
        }
        None => None,
    };

    Ok(CleanAnalysis {
        scope: scope.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        summary: (!summary.is_empty()).then(|| summary.to_string()),
        body_md: input.body_md.clone(),
        structured_json,
        author: input
            .author
            .as_deref()
            .map(|a| a.trim().chars().take(200).collect::<String>())
            .filter(|a| !a.is_empty()),
    })
}

/// A fresh scope for a standalone user note: `note:<title-slug>-<short id>`.
///
/// Every new note gets its own thread at version 1; revising one reuses the returned scope to add a
/// version instead of starting over.
pub fn note_scope(title: &str) -> String {
    let lowered = title.to_lowercase();
    // Collapse every run of non-alphanumerics to a single dash, then trim dashes, then truncate —
    // truncating last can leave a trailing dash, which the Python also produces.
    let mut slug = String::new();
    let mut pending_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch);
        } else {
            pending_dash = true;
        }
    }
    let slug: String = slug.chars().take(40).collect();
    let slug = if slug.is_empty() { "note" } else { &slug };
    format!("note:{slug}-{}", &new_id()[..6])
}

/// Per-process write rate limit, so a misbehaving agent cannot flood the journal.
///
/// Deliberately in-process and therefore *not* durable — unlike the snapshot throttle. This one
/// guards against a runaway loop inside a single run, where a restart is a fine reset; the snapshot
/// throttle guards against duplicate data, where a restart must not be.
#[derive(Debug)]
pub struct RateLimiter {
    max: usize,
    window_secs: i64,
    hits: Mutex<Vec<i64>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new(20, 60)
    }
}

impl RateLimiter {
    pub fn new(max: usize, window_secs: i64) -> Self {
        Self {
            max,
            window_secs,
            hits: Mutex::new(Vec::new()),
        }
    }

    /// Records an attempt, returning `false` when the window is already full.
    pub fn check(&self, now: Option<i64>) -> bool {
        let now = now_or(now);
        let Ok(mut hits) = self.hits.lock() else {
            return true; // a poisoned lock must not wedge writes shut
        };
        hits.retain(|t| now - t < self.window_secs);
        if hits.len() >= self.max {
            return false;
        }
        hits.push(now);
        true
    }
}

fn row_to_analysis(row: &sqlx::sqlite::SqliteRow) -> Result<Analysis> {
    let snapshot_hash: Option<String> = row.try_get("snapshot_hash")?;
    Ok(Analysis {
        id: row.try_get("id")?,
        scope: row.try_get("scope")?,
        version: row.try_get("version")?,
        kind: row.try_get("kind")?,
        title: row.try_get("title")?,
        summary: row.try_get("summary")?,
        body_md: row.try_get("body_md")?,
        structured: json_column(row, "structured"),
        author: row.try_get("author")?,
        source: row.try_get("source")?,
        created_at: row.try_get("created_at")?,
        net_worth_usd: row.try_get("net_worth_usd")?,
        superseded_by: row.try_get("superseded_by")?,
        archived_at: row.try_get("archived_at")?,
        // The anchor exists only if the row was hashed; an as_of with no hash anchors nothing.
        anchor: snapshot_hash.map(|hash| SnapshotAnchor {
            as_of: row.try_get("snapshot_as_of").ok().flatten(),
            hash: Some(hash),
            coverage: json_column(row, "coverage"),
        }),
    })
}

/// Appends a new version of `input.scope`, superseding its prior latest, in one transaction.
///
/// Append-only: a correction never mutates a row, it adds a version and stamps the old one's
/// `superseded_by`. Both statements share a transaction because a crash between them would leave
/// two rows claiming to be the latest for one scope, which every listing query would then double.
pub async fn save_analysis(
    pool: &SqlitePool,
    input: &AnalysisInput,
    source: &str,
    anchor: Option<&SnapshotAnchor>,
    net_worth_usd: Option<f64>,
    now: Option<i64>,
) -> Result<Analysis> {
    let clean = validate(input)?;
    let id = new_id();
    let created_at = now_or(now);
    let anchor = anchor.cloned().unwrap_or_default();

    let mut tx = pool.begin().await.context("opening analysis write")?;

    // The previous latest by version, which this row is about to supersede.
    let previous: Option<(String, i64)> = sqlx::query(
        "SELECT id, version FROM analyses WHERE scope = ? ORDER BY version DESC LIMIT 1",
    )
    .bind(&clean.scope)
    .fetch_optional(&mut *tx)
    .await
    .context("reading the previous analysis version")?
    .map(|row| Ok::<_, sqlx::Error>((row.try_get("id")?, row.try_get("version")?)))
    .transpose()?;

    // 1-based per scope, so "version 1" always means the first thought on this subject.
    let version = previous.as_ref().map_or(1, |(_, v)| v + 1);

    sqlx::query(
        "INSERT INTO analyses (id, scope, version, kind, title, summary, body_md, structured, \
         snapshot_as_of, snapshot_hash, coverage, net_worth_usd, author, source, created_at, \
         superseded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    )
    .bind(&id)
    .bind(&clean.scope)
    .bind(version)
    .bind(&clean.kind)
    .bind(&clean.title)
    .bind(&clean.summary)
    .bind(&clean.body_md)
    .bind(&clean.structured_json)
    .bind(anchor.as_of)
    .bind(&anchor.hash)
    .bind(anchor.coverage.as_ref().map(|c| c.to_string()))
    .bind(net_worth_usd)
    .bind(&clean.author)
    .bind(source)
    .bind(created_at)
    .execute(&mut *tx)
    .await
    .context("inserting the analysis")?;

    if let Some((previous_id, _)) = &previous {
        sqlx::query("UPDATE analyses SET superseded_by = ? WHERE id = ?")
            .bind(&id)
            .bind(previous_id)
            .execute(&mut *tx)
            .await
            .context("retiring the previous version")?;
    }

    tx.commit().await.context("committing the analysis")?;

    get_analysis(pool, &id)
        .await?
        .context("the analysis vanished immediately after being written")
}

/// Filters for [`list_analyses`].
#[derive(Debug, Clone, PartialEq)]
pub struct AnalysisQuery {
    pub scope: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    /// Keep only the current version of each scope.
    pub latest_only: bool,
    pub include_archived: bool,
    pub limit: i64,
}

impl Default for AnalysisQuery {
    fn default() -> Self {
        Self {
            scope: None,
            kind: None,
            source: None,
            latest_only: true,
            include_archived: false,
            limit: DEFAULT_LIST_LIMIT,
        }
    }
}

/// Resolves a requested page size, reproducing Python's `max(1, min(limit or 50, 200))`.
///
/// The `or 50` is why zero is not simply clamped to one: an unset limit arrives as zero from the
/// HTTP layer and must mean "the default page", not "a single row".
fn effective_limit(requested: i64) -> i64 {
    if requested == 0 {
        DEFAULT_LIST_LIMIT
    } else {
        requested.clamp(1, MAX_LIST_LIMIT)
    }
}

/// Lists analyses, newest first.
///
/// Note the archived filter applies **only when `latest_only` is set**, faithfully to the Python:
/// asking for the full version history is treated as an explicitly archival request, so hiding
/// archived rows there would make a thread's own history unreadable after archiving it.
pub async fn list_analyses(pool: &SqlitePool, query: &AnalysisQuery) -> Result<Vec<Analysis>> {
    let mut sql = String::from("SELECT * FROM analyses WHERE 1=1");
    if query.scope.is_some() {
        sql.push_str(" AND scope = ?");
    }
    if query.kind.is_some() {
        sql.push_str(" AND kind = ?");
    }
    if query.source.is_some() {
        sql.push_str(" AND source = ?");
    }
    if query.latest_only {
        sql.push_str(" AND superseded_by IS NULL");
        if !query.include_archived {
            sql.push_str(" AND archived_at IS NULL");
        }
    }
    sql.push_str(" ORDER BY created_at DESC LIMIT ?");

    // Every fragment above is a literal; only the values are bound.
    let mut statement = sqlx::query(AssertSqlSafe(sql));
    for value in [&query.scope, &query.kind, &query.source]
        .into_iter()
        .flatten()
    {
        statement = statement.bind(value);
    }
    let rows = statement
        .bind(effective_limit(query.limit))
        .fetch_all(pool)
        .await
        .context("listing analyses")?;

    rows.iter().map(row_to_analysis).collect()
}

/// Soft-archives (or restores) a scope by stamping `archived_at` on its latest row.
///
/// Nothing is deleted — the thread simply drops out of the default listing. Saving a new version
/// later brings the scope back, because the new latest row starts with a null `archived_at`.
///
/// Returns the number of rows affected.
pub async fn archive_scope(
    pool: &SqlitePool,
    scope: &str,
    archived: bool,
    now: Option<i64>,
) -> Result<u64> {
    let stamp = archived.then(|| now_or(now));
    let result = sqlx::query(
        "UPDATE analyses SET archived_at = ? WHERE scope = ? AND superseded_by IS NULL",
    )
    .bind(stamp)
    .bind(scope)
    .execute(pool)
    .await
    .with_context(|| format!("archiving {scope}"))?;
    Ok(result.rows_affected())
}

/// One analysis by id.
pub async fn get_analysis(pool: &SqlitePool, id: &str) -> Result<Option<Analysis>> {
    let row = sqlx::query("SELECT * FROM analyses WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .with_context(|| format!("reading analysis {id}"))?;
    row.as_ref().map(row_to_analysis).transpose()
}

/// The full version history of one scope, newest version first.
pub async fn analysis_versions(pool: &SqlitePool, scope: &str) -> Result<Vec<Analysis>> {
    let rows = sqlx::query("SELECT * FROM analyses WHERE scope = ? ORDER BY version DESC")
        .bind(scope)
        .fetch_all(pool)
        .await
        .with_context(|| format!("reading versions of {scope}"))?;
    rows.iter().map(row_to_analysis).collect()
}

// ===========================================================================================
// manual_assets — the off-chain book
// ===========================================================================================

/// An asset the chain cannot see: cold-storage BTC, a Kinesis gold balance, a THB bank account.
///
/// `value` is denominated in `ccy`, **not** USD. Converting on write would freeze one day's
/// exchange rate into what is meant to be a standing fact — 180,000 THB stays 180,000 THB — so the
/// USD figure is derived at read time from the portfolio's live rates.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManualAsset {
    pub id: String,
    pub name: String,
    /// A recognised off-chain product (`jlp`, `kgold`, `lightning`), or `None` for a plain balance.
    pub kind: Option<String>,
    pub value: Option<f64>,
    /// `usd` | `thb` | `sats`. `None` reads as USD, matching the front end's optional field.
    pub ccy: Option<String>,
    pub units: Option<f64>,
    pub code: Option<String>,
    pub tier: String,
    pub chain: Option<String>,
    pub note: Option<String>,
    /// BTC custody: `cold` (you hold the keys) or `custodial` (someone else does).
    pub custody: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The writable half of a [`ManualAsset`] — everything except the id and the stamps.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ManualAssetInput {
    pub name: String,
    pub kind: Option<String>,
    pub value: Option<f64>,
    pub ccy: Option<String>,
    pub units: Option<f64>,
    pub code: Option<String>,
    pub tier: String,
    pub chain: Option<String>,
    pub note: Option<String>,
    pub custody: Option<String>,
}

/// A rejected off-chain write. Callers map every variant to 422, as they do [`JournalError`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManualAssetError {
    MissingName,
    BadTier,
    BadCcy,
    BadCustody,
    BadNumber(&'static str),
}

impl std::fmt::Display for ManualAssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingName => write!(f, "name is required"),
            Self::BadTier => write!(f, "tier must be one of {TIERS:?}"),
            Self::BadCcy => write!(f, "ccy must be one of {CCYS:?}"),
            Self::BadCustody => write!(f, "custody must be one of {CUSTODIES:?}"),
            Self::BadNumber(field) => write!(f, "{field} must be a finite number"),
        }
    }
}

impl std::error::Error for ManualAssetError {}

/// The three buckets the wealth pages group by. Kept in step with `Tier` in `types.ts`.
pub const TIERS: [&str; 3] = ["store", "business", "trading"];
/// What `value` may be denominated in. `sats` is a BTC amount, not a currency the market quotes.
pub const CCYS: [&str; 3] = ["usd", "thb", "sats"];
const CUSTODIES: [&str; 2] = ["cold", "custodial"];

/// Trims, caps and lowercases the closed-set fields, rejecting what no reader could make sense of.
///
/// The sets are checked here rather than by a CHECK constraint so the caller gets a message naming
/// the field. A blank optional string stores as NULL — that is how an untouched form field
/// arrives, and `""` and absent must not become two different states in the database.
fn clean_manual(input: &ManualAssetInput) -> Result<ManualAssetInput> {
    fn opt(raw: Option<&String>, cap: usize) -> Option<String> {
        raw.map(|s| s.trim().chars().take(cap).collect::<String>())
            .filter(|s| !s.is_empty())
    }

    let name = input.name.trim().chars().take(200).collect::<String>();
    if name.is_empty() {
        return Err(ManualAssetError::MissingName.into());
    }

    let tier = input.tier.trim().to_ascii_lowercase();
    if !TIERS.contains(&tier.as_str()) {
        return Err(ManualAssetError::BadTier.into());
    }

    let ccy = opt(input.ccy.as_ref(), 8).map(|c| c.to_ascii_lowercase());
    if ccy.as_deref().is_some_and(|c| !CCYS.contains(&c)) {
        return Err(ManualAssetError::BadCcy.into());
    }

    let custody = opt(input.custody.as_ref(), 16).map(|c| c.to_ascii_lowercase());
    if custody.as_deref().is_some_and(|c| !CUSTODIES.contains(&c)) {
        return Err(ManualAssetError::BadCustody.into());
    }

    // A NaN here would propagate into the net-worth total and poison every chart drawn from it,
    // and NaN is not even storable as a comparable REAL. Refused at the door instead.
    for (field, number) in [("value", input.value), ("units", input.units)] {
        if number.is_some_and(|n| !n.is_finite()) {
            return Err(ManualAssetError::BadNumber(field).into());
        }
    }

    Ok(ManualAssetInput {
        name,
        kind: opt(input.kind.as_ref(), 32).map(|k| k.to_ascii_lowercase()),
        value: input.value,
        ccy,
        units: input.units,
        code: opt(input.code.as_ref(), 32),
        tier,
        chain: opt(input.chain.as_ref(), 64),
        note: opt(input.note.as_ref(), 2000),
        custody,
    })
}

fn row_to_manual(row: &sqlx::sqlite::SqliteRow) -> Result<ManualAsset> {
    Ok(ManualAsset {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        kind: row.try_get("kind")?,
        value: row.try_get("value")?,
        ccy: row.try_get("ccy")?,
        units: row.try_get("units")?,
        code: row.try_get("code")?,
        tier: row.try_get("tier")?,
        chain: row.try_get("chain")?,
        note: row.try_get("note")?,
        custody: row.try_get("custody")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// Writes a whole row, insert or replace. Both callers have already validated.
async fn put_manual(pool: &SqlitePool, asset: &ManualAsset) -> Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO manual_assets \
         (id, name, kind, value, ccy, units, code, tier, chain, note, custody, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&asset.id)
    .bind(&asset.name)
    .bind(&asset.kind)
    .bind(asset.value)
    .bind(&asset.ccy)
    .bind(asset.units)
    .bind(&asset.code)
    .bind(&asset.tier)
    .bind(&asset.chain)
    .bind(&asset.note)
    .bind(&asset.custody)
    .bind(asset.created_at)
    .bind(asset.updated_at)
    .execute(pool)
    .await
    .with_context(|| format!("writing manual asset {}", asset.id))?;
    Ok(())
}

/// Every off-chain asset, newest first.
///
/// Tie-broken by `id` so the list does not reshuffle between reads when two assets share a
/// second — an order that moves under the user mid-edit is worse than an arbitrary one.
pub async fn list_manual_assets(pool: &SqlitePool) -> Result<Vec<ManualAsset>> {
    let rows = sqlx::query("SELECT * FROM manual_assets ORDER BY created_at DESC, id DESC")
        .fetch_all(pool)
        .await
        .context("listing manual assets")?;
    rows.iter().map(row_to_manual).collect()
}

/// One asset by id, or `None`.
pub async fn get_manual_asset(pool: &SqlitePool, id: &str) -> Result<Option<ManualAsset>> {
    let row = sqlx::query("SELECT * FROM manual_assets WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .context("reading manual asset")?;
    row.as_ref().map(row_to_manual).transpose()
}

/// Inserts one asset and returns it as stored.
///
/// The id is generated here rather than accepted from the caller: the browser list this replaces
/// had no ids at all, so there is nothing to preserve, and a client-chosen key is a client-chosen
/// collision.
pub async fn create_manual_asset(
    pool: &SqlitePool,
    input: &ManualAssetInput,
    now: Option<i64>,
) -> Result<ManualAsset> {
    let clean = clean_manual(input)?;
    let now = now_or(now);
    let asset = ManualAsset {
        id: new_id(),
        name: clean.name,
        kind: clean.kind,
        value: clean.value,
        ccy: clean.ccy,
        units: clean.units,
        code: clean.code,
        tier: clean.tier,
        chain: clean.chain,
        note: clean.note,
        custody: clean.custody,
        created_at: now,
        updated_at: now,
    };
    put_manual(pool, &asset).await?;
    Ok(asset)
}

/// Replaces one asset wholesale, keeping its id and `created_at`. `Ok(None)` means no such id.
///
/// A whole-row replace rather than a field-wise patch, because the editor sends the whole form:
/// under a patch, clearing a note would be indistinguishable from not touching it.
pub async fn update_manual_asset(
    pool: &SqlitePool,
    id: &str,
    input: &ManualAssetInput,
    now: Option<i64>,
) -> Result<Option<ManualAsset>> {
    let clean = clean_manual(input)?;
    let Some(existing) = get_manual_asset(pool, id).await? else {
        return Ok(None);
    };

    let asset = ManualAsset {
        id: existing.id,
        name: clean.name,
        kind: clean.kind,
        value: clean.value,
        ccy: clean.ccy,
        units: clean.units,
        code: clean.code,
        tier: clean.tier,
        chain: clean.chain,
        note: clean.note,
        custody: clean.custody,
        created_at: existing.created_at,
        updated_at: now_or(now),
    };
    put_manual(pool, &asset).await?;
    Ok(Some(asset))
}

/// Returns `true` if a row was removed.
///
/// A hard delete, where `analyses` soft-archives: an off-chain asset is a present-tense claim
/// about what you own, and a sold one is not a version of anything.
pub async fn delete_manual_asset(pool: &SqlitePool, id: &str) -> Result<bool> {
    let result = sqlx::query("DELETE FROM manual_assets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .context("deleting manual asset")?;
    Ok(result.rows_affected() > 0)
}

/// USD value of one off-chain asset, given the portfolio's live rates.
///
/// The port of `manualUsd` in `src/pages/wealth/derive.ts`, moved server-side so the snapshot cron
/// and the browser agree by construction rather than by two implementations staying in step.
///
/// A missing or non-positive rate yields `0.0` rather than an error: one unpriceable asset must not
/// take down a net-worth read, and a zero is visibly wrong where a stale rate is not.
pub fn manual_usd(asset: &ManualAsset, thb_per_usd: Option<f64>, btc_usd: Option<f64>) -> f64 {
    let value = asset.value.unwrap_or(0.0);
    match asset.ccy.as_deref() {
        Some("thb") => match thb_per_usd {
            Some(rate) if rate > 0.0 => value / rate,
            _ => 0.0,
        },
        Some("sats") => match btc_usd {
            Some(price) => (value / 100_000_000.0) * price,
            None => 0.0,
        },
        // `usd` and an absent ccy are the same case — see the field's doc comment.
        _ => value,
    }
}

/// The off-chain book's total in USD, and what it is made of.
///
/// Returned together because a caller that adds the total to a net worth almost always also needs
/// to say how many assets were behind it — "+$18,400 across 4 off-chain assets" is auditable where
/// a bare number is not.
pub async fn manual_total_usd(
    pool: &SqlitePool,
    thb_per_usd: Option<f64>,
    btc_usd: Option<f64>,
) -> Result<(f64, usize)> {
    let assets = list_manual_assets(pool).await?;
    let total = assets
        .iter()
        .map(|a| manual_usd(a, thb_per_usd, btc_usd))
        .sum();
    Ok((total, assets.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_and_migrate;
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        (dir, pool)
    }

    fn json(raw: &str) -> JsonValue {
        raw.parse().expect("test JSON should parse")
    }

    fn point(d: i64, v: f64) -> Point {
        Point {
            d,
            v,
            tiers: None,
            debt: None,
        }
    }

    /// A realistic epoch-seconds base for snapshot tests.
    ///
    /// Not an arbitrary small number: `last_snapshot_ts` returns `0` for an empty group, so the
    /// throttle compares `now - 0` against the interval. Under a toy clock like `now = 50` that
    /// suppresses the very first write — faithfully to the Python, which has the same sentinel, but
    /// nothing like production, where `now` is ~1.7e9. See
    /// `the_zero_sentinel_only_bites_under_a_toy_clock`.
    const T0: i64 = 1_700_000_000;

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    fn analysis(scope: &str, title: &str) -> AnalysisInput {
        AnalysisInput {
            scope: scope.to_string(),
            kind: "strategy_review".to_string(),
            title: title.to_string(),
            body_md: "Some reasoning.".to_string(),
            ..Default::default()
        }
    }

    // ----- nw_history -------------------------------------------------------------------

    #[tokio::test]
    async fn posting_the_same_day_twice_updates_instead_of_duplicating() {
        // INVARIANT 1: PRIMARY KEY (grp, d) makes the daily POST idempotent, and the incoming row
        // wins its day. Without this the series would grow a duplicate every time a client retried.
        let (_dir, pool) = fresh().await;

        save_history(&pool, "main", &[point(1_000, 100.0)])
            .await
            .unwrap();
        let series = save_history(&pool, "main", &[point(1_000, 250.0)])
            .await
            .unwrap();

        assert_eq!(series.len(), 1, "the day must not duplicate");
        assert_eq!(series[0].v, 250.0, "the incoming value wins");
        assert_eq!(count(&pool, "nw_history").await, 1);
    }

    #[tokio::test]
    async fn re_posting_an_identical_day_changes_nothing() {
        let (_dir, pool) = fresh().await;
        let points = [point(1, 10.0), point(2, 20.0)];

        let first = save_history(&pool, "main", &points).await.unwrap();
        let second = save_history(&pool, "main", &points).await.unwrap();
        assert_eq!(first, second, "re-posting is a no-op");
    }

    #[tokio::test]
    async fn an_incoming_point_without_tiers_clears_the_stored_tiers() {
        // The client owns its day completely: a fresh total with a stale tier split beside it
        // would be worse than no split at all.
        let (_dir, pool) = fresh().await;
        let with_tiers = Point {
            tiers: Some(json(r#"{"store":1.0,"trading":2.0}"#)),
            debt: Some(5.0),
            ..point(7, 100.0)
        };

        save_history(&pool, "main", &[with_tiers]).await.unwrap();
        let series = save_history(&pool, "main", &[point(7, 110.0)])
            .await
            .unwrap();

        assert_eq!(series[0].v, 110.0);
        assert_eq!(series[0].tiers, None, "tiers must be cleared, not kept");
        assert_eq!(series[0].debt, None, "debt must be cleared too");
    }

    #[tokio::test]
    async fn the_history_is_capped_to_two_years_of_days() {
        let (_dir, pool) = fresh().await;
        let points: Vec<Point> = (0..MAX_POINTS + 25).map(|d| point(d, d as f64)).collect();

        let series = save_history(&pool, "main", &points).await.unwrap();

        assert_eq!(series.len() as i64, MAX_POINTS);
        assert_eq!(series[0].d, 25, "the oldest days are the ones pruned");
        assert_eq!(series.last().unwrap().d, MAX_POINTS + 24);
    }

    #[tokio::test]
    async fn an_oversized_payload_is_truncated_rather_than_rejected() {
        let (_dir, pool) = fresh().await;
        let points: Vec<Point> = (0..MAX_INGEST as i64 + 500)
            .map(|d| point(d, 1.0))
            .collect();

        let series = save_history(&pool, "main", &points).await.unwrap();
        // MAX_INGEST accepted, then capped to MAX_POINTS.
        assert_eq!(series.len() as i64, MAX_POINTS);
        assert_eq!(
            series.last().unwrap().d,
            MAX_INGEST as i64 - 1,
            "the tail beyond MAX_INGEST is dropped"
        );
    }

    #[tokio::test]
    async fn saving_nothing_reads_without_pruning() {
        // A save-shaped call carrying no valid points must behave as a read. Pruning here would
        // let an empty POST silently delete history.
        let (_dir, pool) = fresh().await;
        let points: Vec<Point> = (0..MAX_POINTS + 10).map(|d| point(d, 1.0)).collect();

        // Seed past the cap by writing directly, bypassing save_history's prune.
        for p in &points {
            sqlx::query("INSERT INTO nw_history (grp, d, v) VALUES ('main', ?, ?)")
                .bind(p.d)
                .bind(p.v)
                .execute(&pool)
                .await
                .unwrap();
        }
        let series = save_history(&pool, "main", &[]).await.unwrap();
        assert_eq!(
            series.len() as i64,
            MAX_POINTS + 10,
            "an empty save must not prune"
        );
    }

    #[tokio::test]
    async fn groups_do_not_see_each_others_days() {
        let (_dir, pool) = fresh().await;
        save_history(&pool, "main", &[point(1, 10.0)])
            .await
            .unwrap();
        save_history(&pool, "other", &[point(1, 99.0)])
            .await
            .unwrap();

        assert_eq!(load_history(&pool, "main").await.unwrap()[0].v, 10.0);
        assert_eq!(load_history(&pool, "other").await.unwrap()[0].v, 99.0);
    }

    #[test]
    fn group_ids_are_sanitized_to_a_safe_token() {
        assert_eq!(safe_group("Main"), "main");
        assert_eq!(safe_group("my group!"), "mygroup");
        assert_eq!(safe_group("keep_this-one"), "keep_this-one");
        assert_eq!(
            safe_group(""),
            "default",
            "an empty id must not produce an empty key"
        );
        assert_eq!(
            safe_group("!!!"),
            "default",
            "nor must one that sanitizes away"
        );
        assert_eq!(safe_group(&"a".repeat(100)).len(), 64, "truncated to 64");
    }

    #[test]
    fn malformed_points_are_dropped_rather_than_poisoning_the_series() {
        assert_eq!(
            clean_point(&json(r#"{"v":1.0}"#)),
            None,
            "a day key is required"
        );
        assert_eq!(
            clean_point(&json(r#"{"d":1}"#)),
            None,
            "a value is required"
        );
        assert_eq!(
            clean_point(&json(r#"{"d":"x","v":1}"#)),
            None,
            "a non-numeric day"
        );

        let good = clean_point(&json(r#"{"d":5,"v":1.5,"debt":2.5}"#)).unwrap();
        assert_eq!((good.d, good.v, good.debt), (5, 1.5, Some(2.5)));
    }

    #[test]
    fn a_non_numeric_tier_is_dropped_without_losing_the_day() {
        let p = clean_point(&json(r#"{"d":1,"v":2,"tiers":{"store":5,"junk":"nope"}}"#)).unwrap();
        let tiers = p.tiers.unwrap();
        assert_eq!(tiers.get("store").and_then(|v| v.as_f64()), Some(5.0));
        assert!(
            tiers.get("junk").is_none(),
            "the bad tier goes, the day stays"
        );
    }

    #[tokio::test]
    async fn legacy_json_files_are_imported_but_never_clobber_existing_rows() {
        let (dir, pool) = fresh().await;
        let legacy = dir.path().join("legacy");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("history_main.json"),
            r#"[{"d":1,"v":10},{"d":2,"v":20}]"#,
        )
        .unwrap();
        std::fs::write(legacy.join("history_taken.json"), r#"[{"d":1,"v":999}]"#).unwrap();
        std::fs::write(legacy.join("history_broken.json"), "not json at all").unwrap();
        std::fs::write(legacy.join("unrelated.txt"), "ignored").unwrap();

        // `taken` already has data, so it must be left alone.
        save_history(&pool, "taken", &[point(1, 1.0)])
            .await
            .unwrap();

        let imported = import_legacy_history(&pool, &legacy).await.unwrap();
        assert_eq!(imported, 2, "only the untouched group imports");
        assert_eq!(load_history(&pool, "main").await.unwrap().len(), 2);
        assert_eq!(
            load_history(&pool, "taken").await.unwrap()[0].v,
            1.0,
            "a group with rows is never clobbered"
        );

        // Idempotent: a second run finds every group populated and does nothing.
        assert_eq!(import_legacy_history(&pool, &legacy).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn a_missing_legacy_directory_is_not_an_error() {
        let (dir, pool) = fresh().await;
        let missing = dir.path().join("nope");
        assert_eq!(import_legacy_history(&pool, &missing).await.unwrap(), 0);
    }

    // ----- snapshots --------------------------------------------------------------------

    #[tokio::test]
    async fn a_snapshot_also_files_a_daily_net_worth_point() {
        // The chart reads `nw_history`, and until the sweep wrote it the only writer was the old
        // browser app POSTing to /history. Nothing in Lyra does, so the series stopped growing
        // the day the port landed and the chart could never fill in.
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let input = SnapshotInput {
            net_worth: 1_234.5,
            debt: Some(200.0),
            ..Default::default()
        };

        assert!(
            record_snapshot(&pool, "server", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
        let points = load_history(&pool, "server").await.unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].v, 1_234.5);
        assert_eq!(points[0].debt, Some(200.0));
        // UTC midnight of T0, in milliseconds — the day key the browser used.
        assert_eq!(points[0].d, (T0 / 86_400) * 86_400 * 1_000);
    }

    #[tokio::test]
    async fn a_second_snapshot_the_same_day_overwrites_its_point_rather_than_adding_one() {
        // One point per day, last write wins. Two rows for one day would draw a vertical jump on
        // a chart whose x-axis is days.
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();

        record_snapshot(&pool, "server", &SnapshotInput { net_worth: 100.0, ..Default::default() }, 0, Some(T0))
            .await
            .unwrap();
        record_snapshot(&pool, "server", &SnapshotInput { net_worth: 175.0, ..Default::default() }, 0, Some(T0 + 3_600))
            .await
            .unwrap();

        let points = load_history(&pool, "server").await.unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].v, 175.0);
        // The fine-grained log still has both readings; only the daily series collapses them.
        assert_eq!(count(&pool, "snapshots").await, 2);
    }

    #[tokio::test]
    async fn the_snapshot_throttle_survives_a_restart() {
        // INVARIANT 2: the throttle reads the last stored row, so it is durable. This test closes
        // the pool and reopens the file — the strongest available stand-in for a process restart.
        // An in-memory timer would reset here and double-write, which is the bug this replaces.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let input = SnapshotInput {
            net_worth: 100.0,
            ..Default::default()
        };

        let pool = open_and_migrate(&path).await.unwrap();
        assert!(
            record_snapshot(&pool, "main", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
        pool.close().await;

        // "Restart": brand-new pool, no in-process state whatsoever.
        let pool = open_and_migrate(&path).await.unwrap();
        let wrote = record_snapshot(&pool, "main", &input, 3600, Some(T0 + 500))
            .await
            .unwrap();

        assert!(!wrote, "a restart must not defeat the throttle");
        assert_eq!(count(&pool, "snapshots").await, 1);
    }

    #[tokio::test]
    async fn the_first_snapshot_for_a_group_is_always_written() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1.0,
            ..Default::default()
        };
        assert!(
            record_snapshot(&pool, "brand-new", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn the_zero_sentinel_only_bites_under_a_toy_clock() {
        // `last_snapshot_ts` returns 0 for an empty group, so the throttle really compares
        // `now - 0` against the interval. Under a toy clock that suppresses the FIRST ever write.
        // The Python has the identical sentinel and the identical quirk; it never fires in
        // production because `now` is ~1.7e9. Pinned here so nobody "fixes" it into a divergence.
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1.0,
            ..Default::default()
        };

        assert!(
            !record_snapshot(&pool, "main", &input, 3600, Some(1_000))
                .await
                .unwrap(),
            "now=1000 is inside 3600 of the zero sentinel, so even the first write is skipped"
        );
        assert!(
            record_snapshot(&pool, "main", &input, 3600, Some(T0))
                .await
                .unwrap(),
            "a realistic clock is always far past the sentinel"
        );
    }

    #[tokio::test]
    async fn a_snapshot_past_the_interval_is_written_and_one_inside_it_is_not() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1.0,
            ..Default::default()
        };

        assert!(
            record_snapshot(&pool, "main", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
        assert!(
            !record_snapshot(&pool, "main", &input, 3600, Some(T0 + 3_599))
                .await
                .unwrap()
        );
        assert!(
            record_snapshot(&pool, "main", &input, 3600, Some(T0 + 3_600))
                .await
                .unwrap(),
            "exactly one interval later is allowed — the guard is a strict less-than"
        );
        assert_eq!(count(&pool, "snapshots").await, 2);
    }

    #[tokio::test]
    async fn one_groups_snapshot_does_not_throttle_another() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1.0,
            ..Default::default()
        };
        assert!(
            record_snapshot(&pool, "a", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
        assert!(
            record_snapshot(&pool, "b", &input, 3600, Some(T0))
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn the_snapshot_table_is_capped_per_group() {
        let (_dir, pool) = fresh().await;
        // Seed just past the cap directly; going through record_snapshot 20k times would only
        // test the throttle slowly.
        sqlx::raw_sql(
            "INSERT INTO snapshots (ts, grp, net_worth) \
             WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 20005) \
             SELECT n, 'main', 1.0 FROM seq",
        )
        .execute(&pool)
        .await
        .unwrap();
        // A second group must be untouched by the prune.
        sqlx::query("INSERT INTO snapshots (ts, grp, net_worth) VALUES (1, 'other', 1.0)")
            .execute(&pool)
            .await
            .unwrap();

        let input = SnapshotInput {
            net_worth: 2.0,
            ..Default::default()
        };
        assert!(
            record_snapshot(&pool, "main", &input, 3600, Some(T0))
                .await
                .unwrap()
        );

        let main: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM snapshots WHERE grp='main'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let other: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM snapshots WHERE grp='other'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(main, SNAPSHOT_MAX_ROWS, "capped to the newest rows");
        assert_eq!(other, 1, "another group is never pruned");
    }

    #[tokio::test]
    async fn the_series_returns_the_newest_window_oldest_first() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 0.0,
            ..Default::default()
        };
        for i in 1..=5i64 {
            let point = SnapshotInput {
                net_worth: i as f64,
                ..input.clone()
            };
            record_snapshot(&pool, "main", &point, 1, Some(T0 + i * 10))
                .await
                .unwrap();
        }

        let all = snapshot_series(&pool, "main", DEFAULT_SERIES_LIMIT)
            .await
            .unwrap();
        assert_eq!(
            all.iter().map(|p| p.v).collect::<Vec<_>>(),
            vec![1.0, 2.0, 3.0, 4.0, 5.0]
        );

        let window = snapshot_series(&pool, "main", 2).await.unwrap();
        assert_eq!(
            window.iter().map(|p| p.v).collect::<Vec<_>>(),
            vec![4.0, 5.0],
            "a small limit returns the most recent window, still oldest-first"
        );
    }

    #[tokio::test]
    async fn snapshot_columns_round_trip() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1234.5,
            assets: Some(1500.0),
            debt: Some(265.5),
            btc_usd: Some(95_000.0),
            btc_sats: Some(1_000_000.0),
            extra: Some(json(r#"{"note":"hi"}"#)),
        };
        record_snapshot(&pool, "main", &input, 3600, Some(T0))
            .await
            .unwrap();

        let series = snapshot_series(&pool, "main", 10).await.unwrap();
        assert_eq!(series[0].v, 1234.5);
        assert_eq!(series[0].assets, Some(1500.0));
        assert_eq!(series[0].btc_sats, Some(1_000_000.0));
    }

    #[tokio::test]
    async fn an_empty_extra_is_stored_as_null() {
        let (_dir, pool) = fresh().await;
        let input = SnapshotInput {
            net_worth: 1.0,
            extra: Some(json("{}")),
            ..Default::default()
        };
        record_snapshot(&pool, "main", &input, 3600, Some(T0))
            .await
            .unwrap();

        let extra: Option<String> = sqlx::query_scalar("SELECT extra FROM snapshots LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(extra, None, "an empty object means there is nothing extra");
    }

    // ----- analyses ---------------------------------------------------------------------

    #[tokio::test]
    async fn analysis_versions_are_one_based_per_scope() {
        // INVARIANT 3: versions count from 1 within each scope, independently.
        let (_dir, pool) = fresh().await;

        let a1 = save_analysis(
            &pool,
            &analysis("strategy:main", "v1"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        let a2 = save_analysis(
            &pool,
            &analysis("strategy:main", "v2"),
            "http",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();
        let b1 = save_analysis(
            &pool,
            &analysis("position:hyperevm:64176", "other"),
            "mcp",
            None,
            None,
            Some(3),
        )
        .await
        .unwrap();

        assert_eq!(a1.version, 1);
        assert_eq!(a2.version, 2);
        assert_eq!(b1.version, 1, "a different scope starts its own count at 1");
    }

    #[tokio::test]
    async fn a_new_version_supersedes_the_previous_one_and_keeps_it() {
        // INVARIANT 3: append-only. The correction adds a row and stamps the old one; it never
        // mutates or deletes, so the audit trail stays intact.
        let (_dir, pool) = fresh().await;

        let first = save_analysis(
            &pool,
            &analysis("strategy:main", "first"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        let second = save_analysis(
            &pool,
            &analysis("strategy:main", "second"),
            "http",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();

        let stored_first = get_analysis(&pool, &first.id).await.unwrap().unwrap();
        assert_eq!(stored_first.superseded_by, Some(second.id.clone()));
        assert_eq!(
            stored_first.title, "first",
            "the old row is untouched otherwise"
        );
        assert_eq!(second.superseded_by, None, "the newest is the latest");
        assert_eq!(count(&pool, "analyses").await, 2, "both rows survive");
    }

    #[tokio::test]
    async fn the_latest_listing_returns_exactly_one_row_per_scope() {
        // INVARIANT 3: this is what superseded_by buys — a single indexed predicate for "latest".
        let (_dir, pool) = fresh().await;
        for scope in ["strategy:main", "position:hyperevm:64176"] {
            for v in 1..=3 {
                save_analysis(
                    &pool,
                    &analysis(scope, &format!("v{v}")),
                    "http",
                    None,
                    None,
                    Some(v),
                )
                .await
                .unwrap();
            }
        }

        let latest = list_analyses(&pool, &AnalysisQuery::default())
            .await
            .unwrap();

        assert_eq!(latest.len(), 2, "one row per scope, not six");
        assert!(
            latest
                .iter()
                .all(|a| a.version == 3 && a.superseded_by.is_none())
        );
        let scopes: Vec<&str> = latest.iter().map(|a| a.scope.as_str()).collect();
        assert!(scopes.contains(&"strategy:main") && scopes.contains(&"position:hyperevm:64176"));
    }

    #[tokio::test]
    async fn every_version_is_still_reachable_through_the_history() {
        let (_dir, pool) = fresh().await;
        for v in 1..=3 {
            save_analysis(
                &pool,
                &analysis("strategy:main", &format!("v{v}")),
                "http",
                None,
                None,
                Some(v),
            )
            .await
            .unwrap();
        }

        let history = analysis_versions(&pool, "strategy:main").await.unwrap();
        assert_eq!(
            history.iter().map(|a| a.version).collect::<Vec<_>>(),
            vec![3, 2, 1],
            "newest first"
        );
    }

    #[tokio::test]
    async fn archiving_hides_the_scope_but_keeps_every_row() {
        // INVARIANT 4: a soft delete. The thread leaves the default list; nothing leaves the table.
        let (_dir, pool) = fresh().await;
        save_analysis(
            &pool,
            &analysis("strategy:main", "keep"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        save_analysis(
            &pool,
            &analysis("note:other-abc123", "visible"),
            "http",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();

        let affected = archive_scope(&pool, "strategy:main", true, Some(500))
            .await
            .unwrap();
        assert_eq!(affected, 1, "only the latest row is stamped");

        let visible = list_analyses(&pool, &AnalysisQuery::default())
            .await
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].scope, "note:other-abc123");

        assert_eq!(
            count(&pool, "analyses").await,
            2,
            "the archived row still exists"
        );
        let with_archived = list_analyses(
            &pool,
            &AnalysisQuery {
                include_archived: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(with_archived.len(), 2, "and is reachable on request");
        let archived = with_archived
            .iter()
            .find(|a| a.scope == "strategy:main")
            .unwrap();
        assert_eq!(archived.archived_at, Some(500));
    }

    #[tokio::test]
    async fn a_later_revision_clears_the_archive() {
        // INVARIANT 4: the new latest row starts with a null archived_at, so writing again is how
        // a thread comes back — no explicit un-archive call needed.
        let (_dir, pool) = fresh().await;
        save_analysis(
            &pool,
            &analysis("strategy:main", "first"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        archive_scope(&pool, "strategy:main", true, Some(500))
            .await
            .unwrap();
        assert!(
            list_analyses(&pool, &AnalysisQuery::default())
                .await
                .unwrap()
                .is_empty()
        );

        let revived = save_analysis(
            &pool,
            &analysis("strategy:main", "second"),
            "http",
            None,
            None,
            Some(600),
        )
        .await
        .unwrap();

        assert_eq!(revived.archived_at, None);
        let visible = list_analyses(&pool, &AnalysisQuery::default())
            .await
            .unwrap();
        assert_eq!(visible.len(), 1, "the scope is back in the default list");
        assert_eq!(visible[0].version, 2);
    }

    #[tokio::test]
    async fn archiving_can_be_undone_explicitly() {
        let (_dir, pool) = fresh().await;
        save_analysis(
            &pool,
            &analysis("strategy:main", "x"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        archive_scope(&pool, "strategy:main", true, Some(500))
            .await
            .unwrap();
        archive_scope(&pool, "strategy:main", false, None)
            .await
            .unwrap();

        let visible = list_analyses(&pool, &AnalysisQuery::default())
            .await
            .unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].archived_at, None);
    }

    #[tokio::test]
    async fn the_full_version_history_stays_visible_after_archiving() {
        // Faithful to the Python: the archived filter only applies alongside `latest_only`, so
        // asking for a thread's history still shows it once archived.
        let (_dir, pool) = fresh().await;
        save_analysis(
            &pool,
            &analysis("strategy:main", "v1"),
            "http",
            None,
            None,
            Some(1),
        )
        .await
        .unwrap();
        save_analysis(
            &pool,
            &analysis("strategy:main", "v2"),
            "http",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();
        archive_scope(&pool, "strategy:main", true, Some(500))
            .await
            .unwrap();

        let all = list_analyses(
            &pool,
            &AnalysisQuery {
                latest_only: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            all.len(),
            2,
            "history is readable even when the scope is archived"
        );
    }

    #[tokio::test]
    async fn listings_filter_by_scope_kind_and_source() {
        let (_dir, pool) = fresh().await;
        let mut risk = analysis("note:risk-aaa111", "risky");
        risk.kind = "risk_flag".to_string();
        save_analysis(&pool, &risk, "mcp", None, None, Some(1))
            .await
            .unwrap();
        save_analysis(
            &pool,
            &analysis("strategy:main", "plan"),
            "http",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();

        let by_kind = list_analyses(
            &pool,
            &AnalysisQuery {
                kind: Some("risk_flag".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(by_kind.len(), 1);

        let by_source = list_analyses(
            &pool,
            &AnalysisQuery {
                source: Some("http".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(by_source.len(), 1);
        assert_eq!(by_source[0].source, "http");

        let by_scope = list_analyses(
            &pool,
            &AnalysisQuery {
                scope: Some("strategy:main".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(by_scope.len(), 1);
    }

    #[tokio::test]
    async fn an_anchor_round_trips_and_is_absent_without_a_hash() {
        let (_dir, pool) = fresh().await;
        let anchor = SnapshotAnchor {
            as_of: Some(1700),
            hash: Some("abc123".into()),
            coverage: Some(json(r#"{"chains":3}"#)),
        };
        let anchored = save_analysis(
            &pool,
            &analysis("strategy:main", "anchored"),
            "mcp",
            Some(&anchor),
            Some(42.5),
            Some(1),
        )
        .await
        .unwrap();
        assert_eq!(
            anchored.anchor.as_ref().unwrap().hash.as_deref(),
            Some("abc123")
        );
        assert_eq!(anchored.anchor.as_ref().unwrap().as_of, Some(1700));
        assert_eq!(anchored.net_worth_usd, Some(42.5));

        let bare = save_analysis(
            &pool,
            &analysis("note:bare-abc123", "bare"),
            "mcp",
            None,
            None,
            Some(2),
        )
        .await
        .unwrap();
        assert_eq!(bare.anchor, None, "no hash means nothing was anchored");
    }

    #[tokio::test]
    async fn structured_payloads_round_trip() {
        let (_dir, pool) = fresh().await;
        let mut input = analysis("strategy:main", "structured");
        input.structured = Some(json(r#"{"conviction":0.8,"tags":["btc"]}"#));

        let saved = save_analysis(&pool, &input, "mcp", None, None, Some(1))
            .await
            .unwrap();
        let structured = saved.structured.unwrap();
        assert_eq!(
            structured.get("conviction").and_then(|v| v.as_f64()),
            Some(0.8)
        );
    }

    #[tokio::test]
    async fn a_rejected_write_stores_nothing() {
        let (_dir, pool) = fresh().await;
        let bad = analysis("no-namespace", "title");
        let err = save_analysis(&pool, &bad, "http", None, None, Some(1))
            .await
            .unwrap_err();

        assert_eq!(
            err.downcast_ref::<JournalError>(),
            Some(&JournalError::BadScope)
        );
        assert_eq!(count(&pool, "analyses").await, 0);
    }

    // ----- pure validation ---------------------------------------------------------------

    #[test]
    fn a_scope_must_be_namespace_colon_id() {
        for good in [
            "strategy:main",
            "position:hyperevm:64176",
            "note:a-b_c",
            "x:1",
        ] {
            assert!(
                validate(&analysis(good, "t")).is_ok(),
                "{good} should be valid"
            );
        }
        for bad in [
            "",
            "main",
            ":main",
            "Strategy:main",
            "strategy:",
            "strategy:has space",
            "1x:main",
        ] {
            assert_eq!(
                validate(&analysis(bad, "t")).unwrap_err(),
                JournalError::BadScope,
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn a_scope_id_longer_than_sixty_four_characters_is_rejected() {
        let ok = format!("note:{}", "a".repeat(64));
        let too_long = format!("note:{}", "a".repeat(65));
        assert!(validate(&analysis(&ok, "t")).is_ok());
        assert_eq!(
            validate(&analysis(&too_long, "t")).unwrap_err(),
            JournalError::BadScope
        );
    }

    #[test]
    fn only_known_kinds_are_accepted() {
        for kind in KINDS {
            let input = AnalysisInput {
                kind: kind.to_string(),
                ..analysis("strategy:main", "t")
            };
            assert!(validate(&input).is_ok(), "{kind} should be valid");
        }
        let input = AnalysisInput {
            kind: "freeform".to_string(),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(validate(&input).unwrap_err(), JournalError::BadKind);
    }

    #[test]
    fn a_title_and_body_are_both_required() {
        let no_title = analysis("strategy:main", "   ");
        assert_eq!(validate(&no_title).unwrap_err(), JournalError::MissingTitle);

        let no_body = AnalysisInput {
            body_md: "  \n ".into(),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(validate(&no_body).unwrap_err(), JournalError::MissingBody);
    }

    #[test]
    fn oversized_fields_are_rejected_at_their_documented_caps() {
        let at_cap = AnalysisInput {
            title: "a".repeat(MAX_TITLE),
            ..analysis("strategy:main", "t")
        };
        assert!(validate(&at_cap).is_ok(), "the cap itself is allowed");

        let over = AnalysisInput {
            title: "a".repeat(MAX_TITLE + 1),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(
            validate(&over).unwrap_err(),
            JournalError::TooLarge("title")
        );

        let body = AnalysisInput {
            body_md: "a".repeat(MAX_BODY + 1),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(
            validate(&body).unwrap_err(),
            JournalError::TooLarge("body_md")
        );

        let summary = AnalysisInput {
            summary: Some("a".repeat(MAX_SUMMARY + 1)),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(
            validate(&summary).unwrap_err(),
            JournalError::TooLarge("summary")
        );
    }

    #[test]
    fn an_oversized_structured_payload_is_rejected() {
        let big = format!(r#"{{"x":"{}"}}"#, "a".repeat(MAX_STRUCTURED));
        let input = AnalysisInput {
            structured: Some(json(&big)),
            ..analysis("strategy:main", "t")
        };
        assert_eq!(
            validate(&input).unwrap_err(),
            JournalError::TooLarge("structured")
        );
    }

    #[test]
    fn validation_trims_and_normalizes_empty_optionals_to_none() {
        let input = AnalysisInput {
            summary: Some("   ".into()),
            author: Some("  Claude  ".into()),
            ..analysis("  strategy:main  ", "  Titled  ")
        };
        let clean = validate(&input).unwrap();
        assert_eq!(clean.scope, "strategy:main");
        assert_eq!(clean.title, "Titled");
        assert_eq!(
            clean.summary, None,
            "a whitespace-only summary is absent, not empty"
        );
        assert_eq!(clean.author.as_deref(), Some("Claude"));
    }

    #[test]
    fn a_page_size_of_zero_means_the_default_not_one_row() {
        assert_eq!(effective_limit(0), DEFAULT_LIST_LIMIT);
        assert_eq!(effective_limit(10), 10);
        assert_eq!(effective_limit(-5), 1);
        assert_eq!(effective_limit(9_999), MAX_LIST_LIMIT);
    }

    #[test]
    fn a_note_scope_is_a_slug_plus_a_unique_suffix() {
        let scope = note_scope("My Big Idea!");
        assert!(scope.starts_with("note:my-big-idea-"), "got {scope}");
        assert!(
            validate(&analysis(&scope, "t")).is_ok(),
            "must be a valid scope: {scope}"
        );

        // Two notes with the same title must not collide into one thread.
        assert_ne!(note_scope("Same"), note_scope("Same"));
        assert!(
            note_scope("!!!").starts_with("note:note-"),
            "an unsluggable title still works"
        );
    }

    #[test]
    fn the_rate_limiter_opens_again_once_the_window_passes() {
        let limiter = RateLimiter::new(3, 60);
        for _ in 0..3 {
            assert!(limiter.check(Some(1_000)));
        }
        assert!(!limiter.check(Some(1_000)), "the window is full");
        assert!(!limiter.check(Some(1_059)), "still inside the window");
        assert!(limiter.check(Some(1_060)), "the oldest hit has aged out");
    }

    #[test]
    fn generated_ids_are_unique_and_the_right_shape() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_id()).collect();
        assert_eq!(ids.len(), 1000, "ids must not collide");
        assert!(
            ids.iter()
                .all(|id| id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()))
        );
    }

    // ---------------------------------------------------------------- pos_perf

    async fn seed_perf(pool: &SqlitePool, key: &str, secs: f64, cycle_start: Option<i64>) {
        sqlx::query("INSERT INTO pos_perf(key, in_range_secs, cycle_start) VALUES(?, ?, ?)")
            .bind(key)
            .bind(secs)
            .bind(cycle_start)
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn perf_records_reads_only_the_keys_asked_for() {
        let (_dir, pool) = fresh().await;
        seed_perf(&pool, "8453:42", 12_351.0, Some(1_784_124_971)).await;
        seed_perf(&pool, "999:519288", 60.5, None).await;
        seed_perf(&pool, "1:999", 7.0, Some(5)).await;

        let out = perf_records(&pool, &["8453:42".into(), "999:519288".into()])
            .await
            .unwrap();

        assert_eq!(out.len(), 2, "the third row was not asked for");
        assert_eq!(out["8453:42"].in_range_secs, 12_351.0);
        assert_eq!(out["8453:42"].cycle_start, Some(1_784_124_971));
        // A NULL cycle_start is `None`, which is what makes the caller's `setdefault` a no-op
        // rather than anchoring the cycle at zero.
        assert_eq!(out["999:519288"].cycle_start, None);
    }

    #[tokio::test]
    async fn an_unknown_key_is_absent_rather_than_zero() {
        // The difference matters: absent leaves `in_range_secs` off the wire entirely, while a
        // zero would render as "this position has never been in range".
        let (_dir, pool) = fresh().await;
        seed_perf(&pool, "8453:42", 10.0, None).await;

        let out = perf_records(&pool, &["8453:42".into(), "8453:404".into()])
            .await
            .unwrap();
        assert_eq!(out.len(), 1);
        assert!(!out.contains_key("8453:404"));
    }

    #[tokio::test]
    async fn no_keys_means_no_query() {
        let (_dir, pool) = fresh().await;
        assert!(perf_records(&pool, &[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn more_keys_than_sqlite_allows_parameters() {
        // SQLite's default ceiling is 999 bound parameters; a single `IN (...)` past it errors.
        // 2_000 keys must chunk rather than fail, and must still find the rows that exist.
        let (_dir, pool) = fresh().await;
        seed_perf(&pool, "8453:1", 1.0, None).await;
        seed_perf(&pool, "8453:1500", 2.0, None).await;

        let keys: Vec<String> = (0..2_000).map(|i| format!("8453:{i}")).collect();
        let out = perf_records(&pool, &keys).await.unwrap();

        assert_eq!(out.len(), 2);
        assert_eq!(out["8453:1"].in_range_secs, 1.0);
        assert_eq!(out["8453:1500"].in_range_secs, 2.0);
    }

    // ---------------------------------------------------------------- pos_perf, writing

    fn sample(key: &str, in_range: bool, anchor: &str, cycle_start: Option<i64>) -> PerfSample {
        PerfSample {
            key: key.into(),
            in_range,
            harvest_anchor: anchor.into(),
            cycle_start_ts: cycle_start,
        }
    }

    async fn row(pool: &SqlitePool, key: &str) -> (f64, Option<i64>, Option<i64>, String) {
        let r = sqlx::query(
            "SELECT harvest_anchor, cycle_start, in_range_secs, last_sample_ts \
             FROM pos_perf WHERE key = ?",
        )
        .bind(key)
        .fetch_one(pool)
        .await
        .unwrap();
        (
            r.try_get("in_range_secs").unwrap(),
            r.try_get("cycle_start").unwrap(),
            r.try_get("last_sample_ts").unwrap(),
            r.try_get::<Option<String>, _>("harvest_anchor")
                .unwrap()
                .unwrap_or_default(),
        )
    }

    #[tokio::test]
    async fn a_first_sighting_opens_a_cycle_at_zero() {
        let (_dir, pool) = fresh().await;
        let samples = [sample("8453:42", true, "", Some(1_000))];

        record_perf_samples(&pool, &samples, 5_000).await.unwrap();

        let (secs, cycle_start, last, _) = row(&pool, "8453:42").await;
        assert_eq!(secs, 0.0, "the first sample can only start the clock");
        assert_eq!(cycle_start, Some(1_000), "anchored where the position says");
        assert_eq!(last, Some(5_000));
    }

    #[tokio::test]
    async fn an_in_range_position_accrues_the_gap() {
        let (_dir, pool) = fresh().await;
        let samples = [sample("8453:42", true, "h1", Some(1_000))];
        record_perf_samples(&pool, &samples, 5_000).await.unwrap();
        record_perf_samples(&pool, &samples, 5_600).await.unwrap();

        let (secs, cycle_start, last, _) = row(&pool, "8453:42").await;
        assert_eq!(secs, 600.0);
        assert_eq!(cycle_start, Some(1_000), "same cycle, same anchor");
        assert_eq!(last, Some(5_600));
    }

    #[tokio::test]
    async fn an_out_of_range_position_accrues_nothing_but_still_advances() {
        // The clock must move even while idle. If `last_sample_ts` stayed put, the next in-range
        // tick would credit the entire idle stretch as earning time.
        let (_dir, pool) = fresh().await;
        record_perf_samples(&pool, &[sample("8453:42", true, "h1", Some(1_000))], 5_000)
            .await
            .unwrap();
        record_perf_samples(&pool, &[sample("8453:42", false, "h1", Some(1_000))], 5_600)
            .await
            .unwrap();
        record_perf_samples(&pool, &[sample("8453:42", true, "h1", Some(1_000))], 5_900)
            .await
            .unwrap();

        let (secs, _, _, _) = row(&pool, "8453:42").await;
        assert_eq!(secs, 300.0, "only the last 300s counted, not all 900");
    }

    #[tokio::test]
    async fn a_harvest_resets_the_accumulator() {
        let (_dir, pool) = fresh().await;
        record_perf_samples(&pool, &[sample("8453:42", true, "h1", Some(1_000))], 5_000)
            .await
            .unwrap();
        record_perf_samples(&pool, &[sample("8453:42", true, "h1", Some(1_000))], 5_600)
            .await
            .unwrap();
        assert_eq!(row(&pool, "8453:42").await.0, 600.0);

        // A new harvest anchor opens a new fee cycle, so the in-range clock it is compared
        // against has to zero with it.
        record_perf_samples(&pool, &[sample("8453:42", true, "h2", Some(6_000))], 6_200)
            .await
            .unwrap();

        let (secs, cycle_start, _, anchor) = row(&pool, "8453:42").await;
        assert_eq!(secs, 0.0);
        assert_eq!(cycle_start, Some(6_000));
        assert_eq!(anchor, "h2");
    }

    #[tokio::test]
    async fn a_never_harvested_position_keeps_accumulating() {
        // The empty anchor must round-trip as empty rather than as SQL NULL. If a NULL read back
        // as something other than "", every sweep would look like a fresh harvest and the counter
        // would sit at zero forever — silently, since nothing errors.
        let (_dir, pool) = fresh().await;
        let samples = [sample("8453:42", true, "", Some(1_000))];
        record_perf_samples(&pool, &samples, 5_000).await.unwrap();
        record_perf_samples(&pool, &samples, 5_600).await.unwrap();
        record_perf_samples(&pool, &samples, 6_200).await.unwrap();

        assert_eq!(row(&pool, "8453:42").await.0, 1_200.0);
    }

    #[tokio::test]
    async fn an_outage_is_capped_not_credited_in_full() {
        // The box was down for a day. Crediting the whole gap would report a position as having
        // earned through an outage it was not even observed during.
        let (_dir, pool) = fresh().await;
        let samples = [sample("8453:42", true, "h1", Some(1_000))];
        record_perf_samples(&pool, &samples, 5_000).await.unwrap();
        record_perf_samples(&pool, &samples, 5_000 + 86_400)
            .await
            .unwrap();

        assert_eq!(row(&pool, "8453:42").await.0, MAX_SAMPLE_GAP_SECS);
    }

    #[tokio::test]
    async fn a_clock_that_went_backwards_credits_nothing() {
        // NTP correction, or a container started with a bad clock. `clamp` floors at zero, so the
        // accumulator can never run backwards.
        let (_dir, pool) = fresh().await;
        let samples = [sample("8453:42", true, "h1", Some(1_000))];
        record_perf_samples(&pool, &samples, 5_000).await.unwrap();
        record_perf_samples(&pool, &samples, 4_000).await.unwrap();

        assert_eq!(row(&pool, "8453:42").await.0, 0.0);
    }

    #[tokio::test]
    async fn a_cycle_with_no_anchor_time_starts_now() {
        let (_dir, pool) = fresh().await;
        record_perf_samples(&pool, &[sample("8453:42", true, "", None)], 5_000)
            .await
            .unwrap();
        assert_eq!(row(&pool, "8453:42").await.1, Some(5_000));
    }

    #[tokio::test]
    async fn the_sampler_and_the_reader_agree() {
        // The round trip that matters: what the sweep writes is what a build reads back, under the
        // same key. These are the two halves of a cross-process contract.
        let (_dir, pool) = fresh().await;
        let samples = [sample("999:519288", true, "h1", Some(1_000))];
        record_perf_samples(&pool, &samples, 5_000).await.unwrap();
        record_perf_samples(&pool, &samples, 5_600).await.unwrap();

        let read = perf_records(&pool, &["999:519288".into()]).await.unwrap();
        assert_eq!(read["999:519288"].in_range_secs, 600.0);
        assert_eq!(read["999:519288"].cycle_start, Some(1_000));
    }

    #[tokio::test]
    async fn empty_input_writes_nothing() {
        let (_dir, pool) = fresh().await;
        assert_eq!(record_perf_samples(&pool, &[], 5_000).await.unwrap(), 0);
        // A sample with no key is skipped rather than stored under "".
        assert_eq!(
            record_perf_samples(&pool, &[sample("", true, "", None)], 5_000)
                .await
                .unwrap(),
            0
        );
    }

    // ---- manual_assets ----

    fn manual_input(name: &str, tier: &str) -> ManualAssetInput {
        ManualAssetInput {
            name: name.into(),
            tier: tier.into(),
            ..ManualAssetInput::default()
        }
    }

    fn manual_error(e: &anyhow::Error) -> ManualAssetError {
        e.downcast_ref::<ManualAssetError>()
            .expect("should be a ManualAssetError")
            .clone()
    }

    #[tokio::test]
    async fn a_manual_asset_round_trips_every_field() {
        let (_dir, pool) = fresh().await;
        let input = ManualAssetInput {
            name: "Cold storage BTC".into(),
            kind: Some("lightning".into()),
            value: Some(14_000_000.0),
            ccy: Some("sats".into()),
            units: Some(0.14),
            code: Some("BTC".into()),
            tier: "store".into(),
            chain: Some("bitcoin".into()),
            note: Some("Hardware wallet".into()),
            custody: Some("cold".into()),
        };

        let created = create_manual_asset(&pool, &input, Some(1_700_000_000))
            .await
            .unwrap();
        let read = get_manual_asset(&pool, &created.id).await.unwrap().unwrap();

        assert_eq!(read, created);
        assert_eq!(read.name, "Cold storage BTC");
        assert_eq!(read.ccy.as_deref(), Some("sats"));
        assert_eq!(read.custody.as_deref(), Some("cold"));
        assert_eq!(read.created_at, 1_700_000_000);
        assert_eq!(read.updated_at, read.created_at);
    }

    #[tokio::test]
    async fn an_update_keeps_the_id_and_created_at_but_moves_updated_at() {
        let (_dir, pool) = fresh().await;
        let created = create_manual_asset(&pool, &manual_input("THB savings", "business"), Some(1_700_000_000))
            .await
            .unwrap();

        let mut next = manual_input("THB savings", "store");
        next.value = Some(180_000.0);
        next.ccy = Some("thb".into());
        let updated = update_manual_asset(&pool, &created.id, &next, Some(1_700_090_000))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.created_at, created.created_at);
        assert_eq!(updated.updated_at, 1_700_090_000);
        assert_eq!(updated.tier, "store");
        assert_eq!(updated.value, Some(180_000.0));
        // One row, not two — the replace is keyed on the id.
        assert_eq!(list_manual_assets(&pool).await.unwrap().len(), 1);
    }

    /// The whole-row replace has to be able to *clear* a field, which a patch could not express.
    #[tokio::test]
    async fn an_update_can_clear_an_optional_field() {
        let (_dir, pool) = fresh().await;
        let mut input = manual_input("Kinesis gold", "store");
        input.note = Some("vault receipt 4471".into());
        let created = create_manual_asset(&pool, &input, None).await.unwrap();
        assert!(created.note.is_some());

        let cleared = update_manual_asset(&pool, &created.id, &manual_input("Kinesis gold", "store"), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cleared.note, None);
    }

    #[tokio::test]
    async fn updating_or_deleting_an_unknown_id_is_not_an_error() {
        let (_dir, pool) = fresh().await;
        assert!(
            update_manual_asset(&pool, "nope", &manual_input("x", "store"), None)
                .await
                .unwrap()
                .is_none()
        );
        assert!(!delete_manual_asset(&pool, "nope").await.unwrap());
    }

    #[tokio::test]
    async fn delete_removes_the_row_outright() {
        let (_dir, pool) = fresh().await;
        let created = create_manual_asset(&pool, &manual_input("Sold gold", "store"), None)
            .await
            .unwrap();
        assert!(delete_manual_asset(&pool, &created.id).await.unwrap());
        assert!(get_manual_asset(&pool, &created.id).await.unwrap().is_none());
        assert!(list_manual_assets(&pool).await.unwrap().is_empty());
    }

    /// A blank optional field and an absent one must not become two states in the database.
    #[tokio::test]
    async fn blank_optional_strings_store_as_null_and_the_closed_sets_are_lowercased() {
        let (_dir, pool) = fresh().await;
        let input = ManualAssetInput {
            name: "  Spaced  ".into(),
            note: Some("   ".into()),
            code: Some("".into()),
            ccy: Some("THB".into()),
            custody: Some("Cold".into()),
            tier: " Store ".into(),
            ..ManualAssetInput::default()
        };

        let created = create_manual_asset(&pool, &input, None).await.unwrap();
        assert_eq!(created.name, "Spaced");
        assert_eq!(created.note, None);
        assert_eq!(created.code, None);
        assert_eq!(created.ccy.as_deref(), Some("thb"));
        assert_eq!(created.custody.as_deref(), Some("cold"));
        assert_eq!(created.tier, "store");
    }

    #[tokio::test]
    async fn the_closed_sets_are_enforced_by_name() {
        let (_dir, pool) = fresh().await;

        let cases = [
            (manual_input("", "store"), ManualAssetError::MissingName),
            (manual_input("x", "savings"), ManualAssetError::BadTier),
            (
                ManualAssetInput { ccy: Some("eur".into()), ..manual_input("x", "store") },
                ManualAssetError::BadCcy,
            ),
            (
                ManualAssetInput { custody: Some("warm".into()), ..manual_input("x", "store") },
                ManualAssetError::BadCustody,
            ),
        ];

        for (input, want) in cases {
            let e = create_manual_asset(&pool, &input, None).await.unwrap_err();
            assert_eq!(manual_error(&e), want);
        }
        assert!(list_manual_assets(&pool).await.unwrap().is_empty());
    }

    /// A NaN would propagate into the net-worth total and poison every chart drawn from it.
    #[tokio::test]
    async fn a_non_finite_number_is_refused_naming_its_field() {
        let (_dir, pool) = fresh().await;

        for (field, input) in [
            ("value", ManualAssetInput { value: Some(f64::NAN), ..manual_input("x", "store") }),
            ("units", ManualAssetInput { units: Some(f64::INFINITY), ..manual_input("x", "store") }),
        ] {
            let e = create_manual_asset(&pool, &input, None).await.unwrap_err();
            assert_eq!(manual_error(&e), ManualAssetError::BadNumber(field));
        }
    }

    #[tokio::test]
    async fn the_list_is_newest_first() {
        let (_dir, pool) = fresh().await;
        create_manual_asset(&pool, &manual_input("older", "store"), Some(1_700_000_000))
            .await
            .unwrap();
        create_manual_asset(&pool, &manual_input("newer", "store"), Some(1_700_000_500))
            .await
            .unwrap();

        let names: Vec<_> = list_manual_assets(&pool)
            .await
            .unwrap()
            .into_iter()
            .map(|a| a.name)
            .collect();
        assert_eq!(names, ["newer", "older"]);
    }

    /// The port of `manualUsd` in `derive.ts`; these are the cases that file's tests cover.
    #[test]
    fn manual_usd_converts_from_each_denomination() {
        let asset = |value: f64, ccy: Option<&str>| ManualAsset {
            value: Some(value),
            ccy: ccy.map(str::to_string),
            ..ManualAsset::default()
        };

        assert_eq!(manual_usd(&asset(4200.0, Some("usd")), Some(36.0), Some(60_000.0)), 4200.0);
        // An absent ccy is USD, not an error.
        assert_eq!(manual_usd(&asset(4200.0, None), Some(36.0), Some(60_000.0)), 4200.0);
        assert_eq!(manual_usd(&asset(180_000.0, Some("thb")), Some(36.0), None), 5000.0);
        assert_eq!(
            manual_usd(&asset(14_000_000.0, Some("sats")), None, Some(60_000.0)),
            8400.0
        );
        // No value at all is zero, not a panic on unwrap.
        assert_eq!(manual_usd(&ManualAsset::default(), Some(36.0), Some(60_000.0)), 0.0);
    }

    /// A missing rate yields zero rather than an error: one unpriceable asset must not take down
    /// the whole net-worth read, and a zero is visibly wrong where a stale rate is not.
    #[test]
    fn a_missing_or_zero_rate_prices_the_asset_at_zero() {
        let thb = ManualAsset {
            value: Some(180_000.0),
            ccy: Some("thb".into()),
            ..ManualAsset::default()
        };
        let sats = ManualAsset {
            value: Some(14_000_000.0),
            ccy: Some("sats".into()),
            ..ManualAsset::default()
        };

        assert_eq!(manual_usd(&thb, None, Some(60_000.0)), 0.0);
        // A zero rate would divide to infinity, which is the same poison as a NaN.
        assert_eq!(manual_usd(&thb, Some(0.0), Some(60_000.0)), 0.0);
        assert_eq!(manual_usd(&sats, Some(36.0), None), 0.0);
    }

    #[tokio::test]
    async fn the_off_chain_total_sums_across_denominations() {
        let (_dir, pool) = fresh().await;
        for (name, value, ccy) in [
            ("btc", 14_000_000.0, "sats"),
            ("gold", 4_200.0, "usd"),
            ("bank", 180_000.0, "thb"),
        ] {
            create_manual_asset(
                &pool,
                &ManualAssetInput {
                    value: Some(value),
                    ccy: Some(ccy.into()),
                    ..manual_input(name, "store")
                },
                None,
            )
            .await
            .unwrap();
        }

        let (total, count) = manual_total_usd(&pool, Some(36.0), Some(60_000.0))
            .await
            .unwrap();
        // 8400 + 4200 + 5000
        assert!((total - 17_600.0).abs() < 1e-9, "total was {total}");
        assert_eq!(count, 3);
    }

    #[tokio::test]
    async fn an_empty_off_chain_book_totals_zero() {
        let (_dir, pool) = fresh().await;
        assert_eq!(
            manual_total_usd(&pool, Some(36.0), Some(60_000.0)).await.unwrap(),
            (0.0, 0)
        );
    }

}
