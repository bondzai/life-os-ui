//! `lyra-db` — the single SQLite store behind everything.
//!
//! Replaces Lyra's Drizzle schema (`api/src/db/schema.ts`) and wallet-portfolio's `db.py`, merging
//! both into one `lyra.db`. Keeps the conventions `wallet-portfolio/DB_DESIGN.md` argues for: WAL,
//! `synchronous=NORMAL`, a 5s busy timeout, and forward-only migrations tracked by
//! `PRAGMA user_version` — append entries, never edit shipped ones.
//!
//! One file, no daemon, and a small enough surface that graduating to Postgres later would touch
//! only this crate.

pub mod import;
pub mod migrations;

use anyhow::{Context, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use std::path::Path;
use std::time::Duration;

/// Opens (creating if needed) the database with the pragma set `DB_DESIGN.md` specifies.
///
/// * `journal_mode = WAL` — readers do not block the writer, and it is crash-safe.
/// * `synchronous = NORMAL` — durable under WAL, much faster than `FULL`.
/// * `busy_timeout = 5s` — wait out a brief writer lock instead of returning `SQLITE_BUSY`.
pub async fn open(path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5))
        .foreign_keys(true);

    SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(options)
        .await
        .with_context(|| format!("opening {}", path.display()))
}

/// The normal startup path: open, then bring the schema up to date.
pub async fn open_and_migrate(path: &Path) -> Result<SqlitePool> {
    let pool = open(path).await?;
    let version = migrations::migrate(&pool).await?;
    tracing::info!(path = %path.display(), version, "database ready");
    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::AssertSqlSafe;
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        (dir, pool)
    }

    async fn table_names(pool: &SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn migrating_a_fresh_database_creates_every_table() {
        let (_dir, pool) = fresh().await;
        let tables = table_names(&pool).await;
        for expected in [
            "alert_state",
            "analyses",
            "entities",
            "google_tokens",
            "kv_cache",
            "nw_history",
            "pos_perf",
            "relations",
            "schedules",
            "snapshots",
            "trackers",
            "users",
        ] {
            assert!(
                tables.contains(&expected.to_string()),
                "missing {expected}: {tables:?}"
            );
        }
    }

    #[tokio::test]
    async fn user_version_matches_the_migration_count() {
        let (_dir, pool) = fresh().await;
        let version: i64 = sqlx::query_scalar("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version as usize, migrations::MIGRATIONS.len());
    }

    #[tokio::test]
    async fn migrating_twice_is_a_no_op() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let pool = open_and_migrate(&path).await.unwrap();
        let before = table_names(&pool).await;

        // Re-running must not error or duplicate anything — this happens on every restart.
        let version = migrations::migrate(&pool).await.unwrap();
        assert_eq!(version as usize, migrations::MIGRATIONS.len());
        assert_eq!(table_names(&pool).await, before);
    }

    #[tokio::test]
    async fn a_partially_migrated_database_is_brought_forward() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");

        // Stop after v1 — the state an older build would have left behind.
        let pool = open(&path).await.unwrap();
        for statement in migrations::MIGRATIONS[0] {
            sqlx::raw_sql(*statement).execute(&pool).await.unwrap();
        }
        sqlx::raw_sql("PRAGMA user_version = 1")
            .execute(&pool)
            .await
            .unwrap();

        let tables = table_names(&pool).await;
        assert!(tables.contains(&"users".to_string()));
        assert!(!tables.contains(&"snapshots".to_string()));

        migrations::migrate(&pool).await.unwrap();
        let tables = table_names(&pool).await;
        assert!(tables.contains(&"snapshots".to_string()));
        assert!(tables.contains(&"alert_state".to_string()));
    }

    #[tokio::test]
    async fn refuses_to_run_against_a_newer_schema() {
        // Downgrading the binary must not silently re-run old migrations over newer data.
        let (_dir, pool) = fresh().await;
        let ahead = migrations::MIGRATIONS.len() + 1;
        sqlx::raw_sql(AssertSqlSafe(format!("PRAGMA user_version = {ahead}")))
            .execute(&pool)
            .await
            .unwrap();

        let err = migrations::migrate(&pool).await.unwrap_err();
        assert!(err.to_string().contains("Refusing"), "{err}");
    }

    #[tokio::test]
    async fn wal_and_busy_timeout_are_actually_set() {
        let (_dir, pool) = fresh().await;
        let mode: String = sqlx::query_scalar("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let timeout: i64 = sqlx::query_scalar("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(timeout, 5000);
    }

    #[tokio::test]
    async fn creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested/deeper/lyra.db");
        assert!(open_and_migrate(&path).await.is_ok());
        assert!(path.exists());
    }
}
