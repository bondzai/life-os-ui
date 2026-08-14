//! Alert state — the memory behind the rules, in the `alert_state` table.
//!
//! **This module exists because the Python's dedup does not survive a restart.** `notify.py` keeps
//! its latches in a JSON file under the system temp directory (`/tmp/pow_alert_state.json`), which
//! the container wipes on redeploy. The consequence is not cosmetic: every "fees ready" ping and
//! every health-factor warning the user has already acknowledged fires again on the next sweep
//! after a restart. Alerts that cry wolf get muted, and a muted liquidation alarm is the failure
//! this whole crate exists to prevent.
//!
//! So state lives in SQLite, in the same database as everything else. `lyra-db` owns the schema
//! (migration v2→v3); this module only ever touches the `alert_state` table and never creates it,
//! so it cannot race the migrations.
//!
//! Time is injected (`now` parameters) rather than read, keeping these calls as testable as the
//! rules themselves.

use std::collections::HashMap;

use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::{Row, SqlitePool};

use crate::config::Overrides;
use crate::rules::{PositionState, PositionStates};

/// Namespace for per-position latches. The suffix is the Python's own key
/// (`chain:protocol:id`), kept verbatim so a state row is recognisable — and so the Python's file
/// could be imported row for row if it ever mattered.
pub const POSITION_PREFIX: &str = "alerts:position:";

/// Day (`%Y-%m-%d`) the digest was last **successfully sent**.
pub const DIGEST_DAY_KEY: &str = "alerts:digest_day";

/// The UI-saved config overrides — the Python's `_CFG_FILE`, which was equally temporary.
pub const CONFIG_KEY: &str = "alerts:config";

/// Read/write access to the alert rows of `alert_state`.
#[derive(Debug, Clone, Copy)]
pub struct AlertStore<'a> {
    pool: &'a SqlitePool,
}

impl<'a> AlertStore<'a> {
    pub fn new(pool: &'a SqlitePool) -> Self {
        Self { pool }
    }

    // --- low level ----------------------------------------------------------

    /// One stored value, or `None` when the key has never been written.
    ///
    /// A row whose JSON no longer parses reads as `None` rather than as an error: unreadable state
    /// must degrade to "no memory", never to a poller that refuses to run.
    pub async fn get_json(&self, key: &str) -> Result<Option<Value>> {
        let row = sqlx::query("SELECT value_json FROM alert_state WHERE key = ?")
            .bind(key)
            .fetch_optional(self.pool)
            .await
            .with_context(|| format!("reading alert_state {key}"))?;

        let Some(row) = row else { return Ok(None) };
        let raw: String = row.get("value_json");
        match serde_json::from_str(&raw) {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                tracing::warn!(key, %error, "discarding unreadable alert_state row");
                Ok(None)
            }
        }
    }

    /// Upsert one value. `now` is epoch seconds, injected by the caller.
    pub async fn put_json(&self, key: &str, value: &Value, now: i64) -> Result<()> {
        sqlx::query(
            "INSERT INTO alert_state (key, value_json, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
                                            updated_at = excluded.updated_at",
        )
        .bind(key)
        .bind(value.to_string())
        .bind(now)
        .execute(self.pool)
        .await
        .with_context(|| format!("writing alert_state {key}"))?;
        Ok(())
    }

    // --- position latches ---------------------------------------------------

    /// Every position latch from the last sweep.
    ///
    /// Individual corrupt rows are skipped with a warning rather than failing the load. The Python
    /// threw the *entire* state away on one bad byte, which silently re-armed every latch; losing
    /// one position's memory is the smaller wrong.
    pub async fn load_positions(&self) -> Result<PositionStates> {
        let rows = sqlx::query("SELECT key, value_json FROM alert_state WHERE key LIKE ?")
            .bind(format!("{POSITION_PREFIX}%"))
            .fetch_all(self.pool)
            .await
            .context("reading alert_state positions")?;

        let mut states = PositionStates::new();
        for row in rows {
            let key: String = row.get("key");
            let raw: String = row.get("value_json");
            let Some(suffix) = key.strip_prefix(POSITION_PREFIX) else {
                continue;
            };
            match serde_json::from_str::<PositionState>(&raw) {
                Ok(state) => {
                    states.insert(suffix.to_string(), state);
                }
                Err(error) => {
                    tracing::warn!(key, %error, "discarding unreadable position state");
                }
            }
        }
        Ok(states)
    }

    /// Replace every position latch with this sweep's.
    ///
    /// **Replace, not merge** — the rules rebuild state from the positions they were given, so a
    /// position that has disappeared (LP closed, wallet unwatched) must leave state too. Merging
    /// would keep stale latches alive forever, and a returning position would be judged against a
    /// reading from weeks ago rather than baselined afresh.
    ///
    /// The delete and the inserts share one transaction: a crash mid-save leaves the previous
    /// sweep's state intact, which is a far better failure than an empty table that re-arms every
    /// latch at once.
    pub async fn save_positions(&self, states: &PositionStates, now: i64) -> Result<()> {
        let mut tx = self.pool.begin().await.context("begin alert state tx")?;

        sqlx::query("DELETE FROM alert_state WHERE key LIKE ?")
            .bind(format!("{POSITION_PREFIX}%"))
            .execute(&mut *tx)
            .await
            .context("clearing previous position state")?;

        for (key, state) in states {
            let encoded = serde_json::to_string(state).context("encoding position state")?;
            sqlx::query("INSERT INTO alert_state (key, value_json, updated_at) VALUES (?, ?, ?)")
                .bind(format!("{POSITION_PREFIX}{key}"))
                .bind(encoded)
                .bind(now)
                .execute(&mut *tx)
                .await
                .with_context(|| format!("writing position state {key}"))?;
        }

        tx.commit().await.context("commit alert state tx")?;
        Ok(())
    }

    // --- digest -------------------------------------------------------------

    /// Day the digest last went out — `_digest_day`.
    pub async fn digest_day(&self) -> Result<Option<String>> {
        Ok(self
            .get_json(DIGEST_DAY_KEY)
            .await?
            .as_ref()
            .and_then(|value| value.get("day"))
            .and_then(Value::as_str)
            .map(str::to_string))
    }

    /// Record the day — `_set_digest_day`. Call this **only after a successful send**, so a
    /// delivery failure is retried on the next sweep instead of being swallowed for a day.
    pub async fn set_digest_day(&self, day: &str, now: i64) -> Result<()> {
        self.put_json(DIGEST_DAY_KEY, &serde_json::json!({ "day": day }), now)
            .await
    }

    // --- config -------------------------------------------------------------

    /// UI overrides — `load_cfg`. Unreadable or absent means "no overrides", never an error.
    pub async fn load_config(&self) -> Result<Overrides> {
        Ok(self
            .get_json(CONFIG_KEY)
            .await?
            .map(|value| Overrides::from_json(&value))
            .unwrap_or_default())
    }

    /// Persist the merged overrides — `save_cfg`'s write half.
    pub async fn save_config(&self, overrides: &Overrides, now: i64) -> Result<()> {
        self.put_json(CONFIG_KEY, &overrides.as_json(), now).await
    }
}

/// Every alert row, for debugging and for the `/api/alerts` status view.
pub async fn dump(pool: &SqlitePool) -> Result<HashMap<String, Value>> {
    let rows = sqlx::query("SELECT key, value_json FROM alert_state ORDER BY key")
        .fetch_all(pool)
        .await
        .context("dumping alert_state")?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let key: String = row.get("key");
            let raw: String = row.get("value_json");
            serde_json::from_str(&raw).ok().map(|value| (key, value))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{
        AlertKind, DigestClock, Evaluation, Health, PositionInput, Thresholds, evaluate,
        should_send_digest,
    };
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::path::Path;
    use tempfile::TempDir;

    /// The `alert_state` DDL, copied from `lyra-db`'s v2→v3 migration.
    ///
    /// Copied rather than imported on purpose: this crate does not depend on `lyra-db`, so nothing
    /// here can be broken by — or break — work in flight on that crate. If the two ever drift,
    /// this test module is where it shows up.
    const DDL: &str = r#"CREATE TABLE IF NOT EXISTS alert_state (
           key        TEXT PRIMARY KEY,
           value_json TEXT    NOT NULL,
           updated_at INTEGER NOT NULL
       )"#;

    /// Open (creating if needed) a file-backed database — a real file, because the whole point of
    /// these tests is what survives the process going away.
    async fn open(path: &Path) -> SqlitePool {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options)
            .await
            .expect("opening test db");
        sqlx::query(DDL)
            .execute(&pool)
            .await
            .expect("creating table");
        pool
    }

    fn lp(name: &str, in_range: bool, fees: f64) -> PositionInput {
        PositionInput {
            chain: "base".into(),
            protocol: Some("Aerodrome".into()),
            id: Some(format!("id-{name}")),
            name: Some(name.into()),
            in_range: Some(in_range),
            rewards_usd: Some(fees),
            health: None,
        }
    }

    fn lending(hf: f64) -> PositionInput {
        PositionInput {
            chain: "base".into(),
            protocol: Some("Aave".into()),
            id: Some("aave-1".into()),
            name: Some("USDC market".into()),
            in_range: None,
            rewards_usd: None,
            health: Some(Health {
                hf: Some(hf),
                debt_usd: Some(10_000.0),
                collateral_usd: Some(20_000.0),
            }),
        }
    }

    /// One full sweep against a *fresh* connection: load, evaluate, persist, close. Nothing is
    /// carried in memory between calls, so consecutive calls simulate a restarted process.
    async fn sweep_with_restart(
        path: &Path,
        positions: &[PositionInput],
        thresholds: &Thresholds,
        now: i64,
    ) -> Evaluation {
        let pool = open(path).await;
        let store = AlertStore::new(&pool);
        let prev = store.load_positions().await.unwrap();
        let result = evaluate(positions, &prev, thresholds);
        store.save_positions(&result.state, now).await.unwrap();
        pool.close().await;
        result
    }

    // --- the restart guarantee ----------------------------------------------

    #[tokio::test]
    async fn the_fee_ping_does_not_fire_twice_across_a_restart() {
        // THE test this module exists for. With the Python's temp-file state, a redeploy wipes the
        // latch and the second sweep pings again for fees the user already saw.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let thresholds = Thresholds {
            fee_usd: Some(25.0),
            hf: None,
        };

        let first = sweep_with_restart(&path, &[lp("P", true, 30.0)], &thresholds, 1).await;
        assert_eq!(first.alerts.len(), 1, "the first accrual pings");
        assert!(matches!(first.alerts[0].kind, AlertKind::FeesReady { .. }));

        // Process restarts: nothing in memory, everything from the database.
        let second = sweep_with_restart(&path, &[lp("P", true, 31.0)], &thresholds, 2).await;
        assert!(
            second.alerts.is_empty(),
            "the latch must survive the restart, got {:?}",
            second.alerts
        );

        // And once more, to prove it is not a one-off.
        let third = sweep_with_restart(&path, &[lp("P", true, 32.0)], &thresholds, 3).await;
        assert!(third.alerts.is_empty(), "{:?}", third.alerts);
    }

    #[tokio::test]
    async fn losing_the_state_is_exactly_the_bug_being_fixed() {
        // The control for the test above: with no persisted state, the same reading pings again.
        // This is what the temp-file version did on every redeploy.
        let dir = TempDir::new().unwrap();
        let thresholds = Thresholds {
            fee_usd: Some(25.0),
            hf: None,
        };

        let first = sweep_with_restart(
            &dir.path().join("a.db"),
            &[lp("P", true, 30.0)],
            &thresholds,
            1,
        )
        .await;
        assert_eq!(first.alerts.len(), 1);

        // A *different* database stands in for the wiped state file.
        let wiped = sweep_with_restart(
            &dir.path().join("b.db"),
            &[lp("P", true, 30.0)],
            &thresholds,
            2,
        )
        .await;
        assert_eq!(
            wiped.alerts.len(),
            1,
            "proves the dedup above comes from persistence, not from the rule itself"
        );
    }

    #[tokio::test]
    async fn the_health_warning_does_not_repeat_across_a_restart() {
        // The one that matters most: a liquidation alarm that cries wolf gets muted.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let thresholds = Thresholds {
            fee_usd: None,
            hf: Some(1.5),
        };

        let first = sweep_with_restart(&path, &[lending(1.2)], &thresholds, 1).await;
        assert_eq!(first.alerts.len(), 1);

        let after_restart = sweep_with_restart(&path, &[lending(1.15)], &thresholds, 2).await;
        assert!(
            after_restart.alerts.is_empty(),
            "{:?}",
            after_restart.alerts
        );

        // A genuine recovery past the clear band, then a fresh fall, still alerts.
        sweep_with_restart(&path, &[lending(1.7)], &thresholds, 3).await;
        let relapse = sweep_with_restart(&path, &[lending(1.2)], &thresholds, 4).await;
        assert_eq!(relapse.alerts.len(), 1, "a new fall is a new event");
    }

    #[tokio::test]
    async fn a_range_transition_is_judged_against_the_persisted_reading() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let thresholds = Thresholds::default();

        let baseline = sweep_with_restart(&path, &[lp("P", true, 0.0)], &thresholds, 1).await;
        assert!(baseline.alerts.is_empty(), "first sight is silent");

        let out = sweep_with_restart(&path, &[lp("P", false, 0.0)], &thresholds, 2).await;
        assert_eq!(out.alerts.len(), 1);
        assert_eq!(out.alerts[0].kind, AlertKind::OutOfRange);

        let still_out = sweep_with_restart(&path, &[lp("P", false, 0.0)], &thresholds, 3).await;
        assert!(still_out.alerts.is_empty());
    }

    // --- storage mechanics --------------------------------------------------

    #[tokio::test]
    async fn saving_replaces_rather_than_merges() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        let thresholds = Thresholds::default();

        sweep_with_restart(
            &path,
            &[lp("A", true, 0.0), lp("B", true, 0.0)],
            &thresholds,
            1,
        )
        .await;

        // B disappears — its row must go with it, or a returning B is judged against stale data.
        sweep_with_restart(&path, &[lp("A", true, 0.0)], &thresholds, 2).await;

        let pool = open(&path).await;
        let states = AlertStore::new(&pool).load_positions().await.unwrap();
        assert_eq!(states.len(), 1);
        assert!(states.contains_key("base:Aerodrome:id-A"));
        assert!(!states.contains_key("base:Aerodrome:id-B"));
        pool.close().await;
    }

    #[tokio::test]
    async fn state_round_trips_through_the_table() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);

        let mut states = PositionStates::new();
        states.insert(
            "base:Aerodrome:1".into(),
            PositionState {
                range: Some(false),
                fee_alerted: Some(true),
                hf_alerted: None,
            },
        );
        states.insert(
            "base:Aave:hf".into(),
            PositionState {
                hf_alerted: Some(true),
                ..Default::default()
            },
        );

        store.save_positions(&states, 100).await.unwrap();
        assert_eq!(store.load_positions().await.unwrap(), states);
        pool.close().await;
    }

    #[tokio::test]
    async fn stored_rows_use_the_pythons_own_json_shape() {
        // Recognisable by eye, and importable from the Python's state file if it ever matters.
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);

        let mut states = PositionStates::new();
        states.insert(
            "base:Aerodrome:1".into(),
            PositionState {
                range: Some(true),
                fee_alerted: Some(false),
                hf_alerted: None,
            },
        );
        store.save_positions(&states, 100).await.unwrap();

        let dumped = dump(&pool).await.unwrap();
        assert_eq!(
            dumped["alerts:position:base:Aerodrome:1"],
            serde_json::json!({"range": true, "fee_alerted": false}),
            "no null padding — exactly the keys Python writes"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn an_empty_sweep_clears_every_latch() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");
        sweep_with_restart(&path, &[lp("P", true, 0.0)], &Thresholds::default(), 1).await;
        sweep_with_restart(&path, &[], &Thresholds::default(), 2).await;

        let pool = open(&path).await;
        assert!(
            AlertStore::new(&pool)
                .load_positions()
                .await
                .unwrap()
                .is_empty()
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn a_corrupt_row_is_skipped_not_fatal() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);

        let mut states = PositionStates::new();
        states.insert(
            "good".into(),
            PositionState {
                range: Some(true),
                ..Default::default()
            },
        );
        store.save_positions(&states, 1).await.unwrap();

        sqlx::query("INSERT INTO alert_state (key, value_json, updated_at) VALUES (?, ?, ?)")
            .bind(format!("{POSITION_PREFIX}broken"))
            .bind("{not json")
            .bind(1)
            .execute(&pool)
            .await
            .unwrap();

        let loaded = store.load_positions().await.unwrap();
        assert_eq!(loaded.len(), 1, "the readable row survives");
        assert!(loaded.contains_key("good"));
        pool.close().await;
    }

    #[tokio::test]
    async fn alert_rows_do_not_collide_with_other_users_of_the_table() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);

        sqlx::query("INSERT INTO alert_state (key, value_json, updated_at) VALUES (?, ?, ?)")
            .bind("someone-elses-key")
            .bind(r#"{"mine": true}"#)
            .bind(1)
            .execute(&pool)
            .await
            .unwrap();

        let mut states = PositionStates::new();
        states.insert("base:Aero:1".into(), PositionState::default());
        store.save_positions(&states, 2).await.unwrap();
        store
            .save_positions(&PositionStates::new(), 3)
            .await
            .unwrap();

        // The replace-all must not have swept away a row this crate does not own.
        assert!(dump(&pool).await.unwrap().contains_key("someone-elses-key"));
        pool.close().await;
    }

    // --- digest -------------------------------------------------------------

    #[tokio::test]
    async fn the_digest_fires_once_a_day_across_restarts() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");

        // 09:00 — nothing recorded yet, so it sends and records the day.
        {
            let pool = open(&path).await;
            let store = AlertStore::new(&pool);
            let clock = DigestClock::new(9, "2026-08-14");
            let last = store.digest_day().await.unwrap();
            assert!(should_send_digest(&clock, Some(9), last.as_deref(), true));
            store.set_digest_day(&clock.day, 1).await.unwrap();
            pool.close().await;
        }

        // Restart, same hour, same day: must stay quiet.
        {
            let pool = open(&path).await;
            let store = AlertStore::new(&pool);
            let clock = DigestClock::new(9, "2026-08-14");
            let last = store.digest_day().await.unwrap();
            assert_eq!(last.as_deref(), Some("2026-08-14"));
            assert!(
                !should_send_digest(&clock, Some(9), last.as_deref(), true),
                "a redeploy must not re-send the morning brief"
            );
            pool.close().await;
        }

        // Next morning: fires again.
        {
            let pool = open(&path).await;
            let store = AlertStore::new(&pool);
            let clock = DigestClock::new(9, "2026-08-15");
            let last = store.digest_day().await.unwrap();
            assert!(should_send_digest(&clock, Some(9), last.as_deref(), true));
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn an_unsent_digest_leaves_no_day_recorded() {
        // The day is written only after a successful send, so a failed delivery retries.
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);
        assert_eq!(store.digest_day().await.unwrap(), None);
        pool.close().await;
    }

    // --- config -------------------------------------------------------------

    #[tokio::test]
    async fn config_overrides_survive_a_restart() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("lyra.db");

        {
            let pool = open(&path).await;
            let store = AlertStore::new(&pool);
            let mut overrides = store.load_config().await.unwrap();
            assert!(overrides.is_empty(), "nothing saved yet");
            overrides
                .merge_patch(&serde_json::json!({"interval": 300, "digest_hour": 7}))
                .unwrap();
            store.save_config(&overrides, 1).await.unwrap();
            pool.close().await;
        }

        let pool = open(&path).await;
        let overrides = AlertStore::new(&pool).load_config().await.unwrap();
        assert_eq!(overrides.get("interval"), Some(&serde_json::json!(300)));
        assert_eq!(overrides.get("digest_hour"), Some(&serde_json::json!(7)));
        pool.close().await;
    }

    #[tokio::test]
    async fn unreadable_config_reads_as_no_overrides() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;

        sqlx::query("INSERT INTO alert_state (key, value_json, updated_at) VALUES (?, ?, ?)")
            .bind(CONFIG_KEY)
            .bind("{ truncated")
            .bind(1)
            .execute(&pool)
            .await
            .unwrap();

        assert!(
            AlertStore::new(&pool)
                .load_config()
                .await
                .unwrap()
                .is_empty()
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn a_missing_key_reads_as_absent_rather_than_erroring() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        assert_eq!(
            AlertStore::new(&pool)
                .get_json("never-written")
                .await
                .unwrap(),
            None
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn writing_the_same_key_twice_updates_in_place() {
        let dir = TempDir::new().unwrap();
        let pool = open(&dir.path().join("lyra.db")).await;
        let store = AlertStore::new(&pool);

        store.set_digest_day("2026-08-14", 1).await.unwrap();
        store.set_digest_day("2026-08-15", 2).await.unwrap();
        assert_eq!(
            store.digest_day().await.unwrap().as_deref(),
            Some("2026-08-15")
        );

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alert_state")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1, "upsert, not append");
        pool.close().await;
    }
}
