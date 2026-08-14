//! One-shot import of the two legacy databases into `lyra.db`.
//!
//! The mini PC has real history in both — Lyra's `api/data/life-os.db` and pow's `pow.db` — and
//! losing it to the port would be the worst possible outcome of a "no user-visible change" phase.
//!
//! Two properties this is built for, both learned from the actual files:
//!
//! * **Tables may be absent.** The live `life-os.db` has no `google_tokens` table even though the
//!   Drizzle schema declares one, so a missing table is a normal condition, not an error.
//! * **Columns may not line up.** Only the intersection of source and destination columns is
//!   copied, so a legacy DB that predates a column still imports.
//!
//! Re-running is safe: every statement is `INSERT OR IGNORE`, so primary keys make a second pass a
//! no-op rather than a duplication.
//!
//! **Back up the legacy files first, with their `-wal`/`-shm` sidecars.** SQLite may need to
//! recover a hot WAL to read the newest rows, which writes to the source database.

use anyhow::{Context, Result};
use sqlx::{AssertSqlSafe, SqlitePool};
use std::collections::BTreeSet;
use std::path::Path;

/// Tables carried over from Lyra's Drizzle database.
pub const LYRA_TABLES: &[&str] = &[
    "users",
    "entities",
    "trackers",
    "schedules",
    "relations",
    "google_tokens",
];

/// Tables carried over from wallet-portfolio's `pow.db`.
pub const POW_TABLES: &[&str] = &["nw_history", "snapshots", "analyses", "pos_perf"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TableImport {
    pub table: String,
    pub outcome: Outcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Imported {
        rows: u64,
    },
    /// The source database has no such table — expected, not a failure.
    AbsentInSource,
    /// The table exists but shares no columns with the destination; nothing to copy.
    NoSharedColumns,
}

#[derive(Debug, Default)]
pub struct ImportReport {
    pub tables: Vec<TableImport>,
}

impl ImportReport {
    pub fn total_rows(&self) -> u64 {
        self.tables
            .iter()
            .map(|t| match t.outcome {
                Outcome::Imported { rows } => rows,
                _ => 0,
            })
            .sum()
    }

    /// A human-readable summary, one line per table.
    pub fn summary(&self) -> String {
        self.tables
            .iter()
            .map(|t| match &t.outcome {
                Outcome::Imported { rows } => format!("  {:<16} {rows} rows", t.table),
                Outcome::AbsentInSource => format!("  {:<16} absent in source (skipped)", t.table),
                Outcome::NoSharedColumns => {
                    format!("  {:<16} no shared columns (skipped)", t.table)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Imports `tables` from the SQLite file at `source` into the connected database.
pub async fn import_from(
    pool: &SqlitePool,
    source: &Path,
    tables: &[&str],
) -> Result<ImportReport> {
    if !source.exists() {
        anyhow::bail!("legacy database not found: {}", source.display());
    }
    let source_str = source
        .to_str()
        .with_context(|| format!("legacy path is not valid UTF-8: {}", source.display()))?;

    // A dedicated connection: ATTACH is per-connection, and taking one from the pool would
    // leave the attachment visible to unrelated later queries.
    let mut conn = pool
        .acquire()
        .await
        .context("acquiring a connection for import")?;

    sqlx::query("ATTACH DATABASE ? AS legacy")
        .bind(source_str)
        .execute(&mut *conn)
        .await
        .with_context(|| format!("attaching {}", source.display()))?;

    let mut report = ImportReport::default();
    let result = async {
        for table in tables {
            let outcome = import_table(&mut conn, table).await?;
            report.tables.push(TableImport {
                table: (*table).to_string(),
                outcome,
            });
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;

    // Detach even if a table failed, so the connection returns to the pool clean.
    let _ = sqlx::query("DETACH DATABASE legacy")
        .execute(&mut *conn)
        .await;
    result?;

    Ok(report)
}

async fn import_table(conn: &mut sqlx::SqliteConnection, table: &str) -> Result<Outcome> {
    assert!(
        table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        "table names are compile-time constants, never user input: {table:?}"
    );

    if !table_exists(conn, "legacy", table).await? {
        return Ok(Outcome::AbsentInSource);
    }

    let source_columns = columns_of(conn, "legacy", table).await?;
    let dest_columns = columns_of(conn, "main", table).await?;
    let shared: Vec<String> = dest_columns
        .iter()
        .filter(|c| source_columns.contains(*c))
        .cloned()
        .collect();

    if shared.is_empty() {
        return Ok(Outcome::NoSharedColumns);
    }

    // Backticks, not double quotes. SQLite's double-quoted-string misfeature silently degrades a
    // double-quoted identifier that resolves to nothing into a *string literal*, so a column-name
    // mistake writes the literal text into every row instead of raising an error. Backticked
    // identifiers have no such fallback.
    let list = shared
        .iter()
        .map(|c| format!("`{c}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT OR IGNORE INTO main.`{table}` ({list}) SELECT {list} FROM legacy.`{table}`"
    );

    let result = sqlx::query(AssertSqlSafe(sql))
        .execute(&mut *conn)
        .await
        .with_context(|| format!("importing {table}"))?;

    Ok(Outcome::Imported {
        rows: result.rows_affected(),
    })
}

async fn table_exists(
    conn: &mut sqlx::SqliteConnection,
    schema: &str,
    table: &str,
) -> Result<bool> {
    let sql =
        format!("SELECT COUNT(*) FROM {schema}.sqlite_master WHERE type='table' AND name = ?");
    let count: i64 = sqlx::query_scalar(AssertSqlSafe(sql))
        .bind(table)
        .fetch_one(&mut *conn)
        .await
        .with_context(|| format!("checking for {schema}.{table}"))?;
    Ok(count > 0)
}

async fn columns_of(
    conn: &mut sqlx::SqliteConnection,
    schema: &str,
    table: &str,
) -> Result<BTreeSet<String>> {
    // The schema must be the pragma function's SECOND ARGUMENT. Writing it as a qualifier —
    // `legacy.pragma_table_info('t')` — silently returns `main`'s columns instead, which reads
    // as "the source has every column the destination has" and corrupts the import.
    let sql = format!("SELECT name FROM pragma_table_info('{table}', '{schema}')");
    let names: Vec<String> = sqlx::query_scalar(AssertSqlSafe(sql))
        .fetch_all(&mut *conn)
        .await
        .with_context(|| format!("reading columns of {schema}.{table}"))?;
    Ok(names.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_and_migrate;
    use tempfile::TempDir;

    /// Builds a throwaway legacy database from raw SQL.
    async fn legacy_db(dir: &TempDir, name: &str, setup: &[&'static str]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        let pool = crate::open(&path).await.unwrap();
        for statement in setup {
            sqlx::raw_sql(*statement).execute(&pool).await.unwrap();
        }
        pool.close().await;
        path
    }

    async fn count(pool: &SqlitePool, table: &str) -> i64 {
        sqlx::query_scalar(AssertSqlSafe(format!("SELECT COUNT(*) FROM {table}")))
            .fetch_one(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn imports_rows_from_a_matching_legacy_database() {
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "life-os.db",
            &[
                "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, role TEXT, pin TEXT, avatarUrl TEXT)",
                "INSERT INTO users VALUES ('u1', 'James', 'owner', '$2a$10$hash', NULL)",
                "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, title TEXT, description TEXT, status TEXT, priority TEXT, tags TEXT, metadata TEXT, parentId TEXT, ownerId TEXT, visibility TEXT, dueDate TEXT, createdAt TEXT, updatedAt TEXT)",
                "INSERT INTO entities (id, type, title) VALUES ('e1', 'goal', 'Ship the port')",
                "INSERT INTO entities (id, type, title) VALUES ('e2', 'wallet', 'Main wallet')",
            ],
        )
        .await;

        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let report = import_from(&pool, &source, LYRA_TABLES).await.unwrap();

        assert_eq!(count(&pool, "users").await, 1);
        assert_eq!(count(&pool, "entities").await, 2);
        assert_eq!(report.total_rows(), 3);

        // The bcrypt hash must survive verbatim — rewriting it would lock the user out.
        let pin: String = sqlx::query_scalar("SELECT pin FROM users WHERE id = 'u1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(pin, "$2a$10$hash");
    }

    #[tokio::test]
    async fn a_table_missing_from_the_source_is_skipped_not_fatal() {
        // The real life-os.db has no google_tokens table.
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "life-os.db",
            &[
                "CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT)",
                "INSERT INTO users VALUES ('u1', 'James')",
            ],
        )
        .await;

        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let report = import_from(&pool, &source, LYRA_TABLES).await.unwrap();

        let google = report
            .tables
            .iter()
            .find(|t| t.table == "google_tokens")
            .unwrap();
        assert_eq!(google.outcome, Outcome::AbsentInSource);
        assert_eq!(count(&pool, "users").await, 1);
    }

    #[tokio::test]
    async fn columns_absent_from_the_source_are_left_at_their_defaults() {
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "old.db",
            &[
                // An older schema: no priority, no visibility.
                "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, title TEXT)",
                "INSERT INTO entities VALUES ('e1', 'task', 'Old row')",
            ],
        )
        .await;

        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        import_from(&pool, &source, &["entities"]).await.unwrap();

        let (title, priority): (String, String) =
            sqlx::query_as("SELECT title, priority FROM entities WHERE id = 'e1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "Old row");
        assert_eq!(priority, "medium", "destination default should apply");
    }

    #[tokio::test]
    async fn importing_twice_does_not_duplicate() {
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "life-os.db",
            &[
                "CREATE TABLE entities (id TEXT PRIMARY KEY, type TEXT, title TEXT)",
                "INSERT INTO entities VALUES ('e1', 'goal', 'Only once')",
            ],
        )
        .await;

        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        import_from(&pool, &source, &["entities"]).await.unwrap();
        let second = import_from(&pool, &source, &["entities"]).await.unwrap();

        assert_eq!(count(&pool, "entities").await, 1);
        assert_eq!(second.total_rows(), 0, "second pass should insert nothing");
    }

    #[tokio::test]
    async fn imports_the_pow_wealth_tables() {
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "pow.db",
            &[
                "CREATE TABLE nw_history (grp TEXT NOT NULL, d INTEGER NOT NULL, v REAL NOT NULL, tiers TEXT, debt REAL, PRIMARY KEY (grp, d))",
                "INSERT INTO nw_history VALUES ('server', 1755000000000, 12345.67, NULL, NULL)",
                "CREATE TABLE snapshots (ts INTEGER NOT NULL, grp TEXT NOT NULL, net_worth REAL NOT NULL, assets REAL, debt REAL, btc_usd REAL, btc_sats REAL, extra TEXT)",
                "INSERT INTO snapshots VALUES (1755000000, 'server', 12345.67, 13000.0, 654.33, 5000.0, 12345678.0, NULL)",
            ],
        )
        .await;

        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let report = import_from(&pool, &source, POW_TABLES).await.unwrap();

        assert_eq!(count(&pool, "nw_history").await, 1);
        assert_eq!(count(&pool, "snapshots").await, 1);
        // analyses and pos_perf were never created in this source.
        assert_eq!(
            report
                .tables
                .iter()
                .filter(|t| t.outcome == Outcome::AbsentInSource)
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn a_missing_source_file_is_an_error() {
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let err = import_from(&pool, &dir.path().join("nope.db"), LYRA_TABLES)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("not found"), "{err}");
    }

    #[tokio::test]
    async fn the_connection_is_usable_after_an_import() {
        // ATTACH leaks across pooled connections if it is not detached.
        let dir = TempDir::new().unwrap();
        let source = legacy_db(
            &dir,
            "life-os.db",
            &["CREATE TABLE users (id TEXT PRIMARY KEY)"],
        )
        .await;
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        import_from(&pool, &source, &["users"]).await.unwrap();

        let attached: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_database_list")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(
            !attached.contains(&"legacy".to_string()),
            "still attached: {attached:?}"
        );
    }
}
