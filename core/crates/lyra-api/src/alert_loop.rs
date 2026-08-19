//! The always-on sweep — port of `notify.py`'s `_run_loop` / `check_once` / `_maybe_snapshot`.
//!
//! `lyra-alerts` already holds every *decision*: `rules::evaluate` diffs range state and latches,
//! `digest` renders the brief, `state::AlertStore` persists both. What was missing was the thing
//! that drives them on a clock. This is that driver, and nothing more — no rule lives here.
//!
//! It runs **in-process**, as a `tokio` task alongside the HTTP server, because `server.py` starts
//! `notify.start()` the same way and because the whole point of the port was one binary on the
//! mini PC. That is what makes `/api/wealth/alerts` able to answer `running: true` truthfully.
//!
//! # What one tick does
//!
//! 1. **Sweep** — build every watched wallet, evaluate the rules, send what fired, save the new
//!    latches, and sample each vfat LP's in-range state into `pos_perf`.
//! 2. **Digest** — send the daily brief if the hour has come round and today's has not gone out.
//! 3. **Snapshot** — record a net-worth point if `SNAPSHOT_INTERVAL` has elapsed.
//!
//! # Why the errors are swallowed
//!
//! Every step is wrapped: a failed wallet build, a Telegram outage, an unwritable row. The loop's
//! job is to still be running tomorrow. A tick that dies takes the alerts, the brief and the
//! net-worth series with it, so failures are recorded in `last_error` (which the settings page
//! shows) and the loop goes round again.
//!
//! The one thing deliberately *not* swallowed is `pos_perf`: see [`sample_positions`].

use std::sync::{Arc, Mutex};
use std::time::Duration;

use lyra_alerts::config::{AlertConfig, ProcessEnv};
use lyra_alerts::digest::day_key;
use lyra_alerts::rules::{self, Health, PositionInput, PositionStates, Thresholds};
use lyra_alerts::state::AlertStore;
use lyra_alerts::telegram::{MessageSender, TelegramSender};
use lyra_chain::model::Wallet;
use lyra_db::wealth::{self as store, PerfSample, SnapshotInput};

use crate::AppState;
use crate::wealth;

/// The four fields `notify.py` keeps in its module-level `_META`, reported by `/alerts`.
///
/// A `Mutex` rather than atomics because they are read as a set: a status showing a fresh
/// `last_check` beside a stale `watching` would be a lie about a single moment.
#[derive(Debug, Clone, Default)]
pub struct Meta {
    /// Epoch seconds, fractional — `time.time()`, matching the Python's JSON exactly.
    pub last_check: Option<f64>,
    /// How many position keys the last sweep tracked.
    pub watching: Option<usize>,
    /// The most recent failure, kept until something overwrites it. Python never clears this
    /// either: a fault that has stopped happening is still worth seeing once.
    pub last_error: Option<String>,
    pub running: bool,
}

/// Shared handle to [`Meta`], held by both the loop and the `/alerts` handler.
pub type SharedMeta = Arc<Mutex<Meta>>;

/// Read the current meta, tolerating a poisoned lock.
///
/// A panicked writer costs the *status display*, never the loop — so this degrades to defaults
/// rather than propagating, and `running: false` on a poisoned lock is the honest answer.
pub fn snapshot(meta: &SharedMeta) -> Meta {
    meta.lock().map(|m| m.clone()).unwrap_or_default()
}

fn update(meta: &SharedMeta, f: impl FnOnce(&mut Meta)) {
    if let Ok(mut guard) = meta.lock() {
        f(&mut guard);
    }
}

fn record_error(meta: &SharedMeta, message: String) {
    tracing::warn!(error = %message, "alert loop");
    update(meta, |m| m.last_error = Some(message));
}

/// Start the loop, unless there is nothing for it to do.
///
/// Mirrors `notify.start()`'s guard: the loop drives range alerts, the daily digest **and** the
/// net-worth series, so it starts if any one of the three is wired. A box with wallets but no
/// Telegram token still accrues history.
pub fn spawn(state: AppState) {
    // Env only: the database is not read here. `spawn` runs before the server accepts a request,
    // and the loop re-reads the saved overrides on every tick anyway.
    let overrides = lyra_alerts::config::Overrides::new();
    let config = AlertConfig::new(&overrides, &ProcessEnv);
    let wallets = wealth::watched_wallets();
    let sender = TelegramSender::from_env(&ProcessEnv);

    let alerting = sender.can_send() && !wallets.is_empty();
    let digesting = sender.can_send() && config.digest_hour().is_some();
    let snapshotting = !wallets.is_empty() || lyra_chain::kucoin::configured();

    if !(alerting || digesting || snapshotting) {
        tracing::info!("alert loop not started: no watched wallets, no digest hour, no KuCoin key");
        return;
    }

    let interval = config
        .interval()
        .unwrap_or(lyra_alerts::config::DEFAULT_INTERVAL);
    if alerting {
        tracing::info!(wallets = wallets.len(), interval, "range alerts on");
    }
    if let Some(hour) = config.digest_hour().filter(|_| digesting) {
        tracing::info!(hour, "daily digest on");
    }
    if snapshotting {
        tracing::info!(
            group = %snapshot_group(),
            interval = config.snapshot_interval(),
            "net-worth snapshots on"
        );
    }

    let meta = Arc::clone(&state.alert_meta);
    update(&meta, |m| m.running = true);
    tokio::spawn(async move { run(state).await });
}

async fn run(state: AppState) {
    let meta = Arc::clone(&state.alert_meta);
    loop {
        // Re-read config every tick, exactly as the Python does: a change saved through
        // `/alerts/config` then takes effect on the next cycle with no restart.
        let overrides = AlertStore::new(&state.pool)
            .load_config()
            .await
            .unwrap_or_default();
        let config = AlertConfig::new(&overrides, &ProcessEnv);
        let interval = match config.interval() {
            Ok(seconds) => seconds,
            Err(e) => {
                // A schedule nobody chose is worse than a loud failure, so this is reported —
                // but the loop still needs *a* cadence, and stopping would be worse again.
                record_error(&meta, format!("config: {e}"));
                lyra_alerts::config::DEFAULT_INTERVAL
            }
        };

        sweep(&state, &config).await;
        maybe_digest(&state, &config).await;
        maybe_snapshot(&state, &config).await;

        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

// ===========================================================================================
// The sweep — `check_once`
// ===========================================================================================

async fn sweep(state: &AppState, config: &AlertConfig<'_>) {
    let meta = Arc::clone(&state.alert_meta);
    let sender = TelegramSender::from_env(&ProcessEnv);
    let wallets = wealth::watched_wallets();

    // `if not configured(): return 0`. Note this gates the *alerting*, not the snapshotting
    // below — a box with no Telegram token still builds its net-worth series.
    if !sender.can_send() || wallets.is_empty() {
        return;
    }

    let store_handle = AlertStore::new(&state.pool);
    let previous: PositionStates = match store_handle.load_positions().await {
        Ok(states) => states,
        Err(e) => {
            record_error(&meta, format!("state: {e}"));
            return;
        }
    };

    let thresholds = Thresholds {
        fee_usd: config.fee_threshold(),
        hf: config.hf_threshold(),
    };

    let mut positions = Vec::new();
    let mut samples = Vec::new();
    for address in &wallets {
        let (wallet, missing_chains) = wealth::build_watched_wallet(&state.pool, address).await;
        if missing_chains > 0 {
            // The Python's `except Exception: _META["last_error"] = f"build {addr[:8]}: {e}"`.
            // Here the read cannot fail outright — it degrades per chain — so the equivalent is
            // to report how much of the wallet is missing. The sweep continues on what it did
            // read: those positions are real, and suppressing their alerts would be worse.
            record_error(
                &meta,
                format!(
                    "build {}: {missing_chains} chain(s) unreadable",
                    &address[..8.min(address.len())]
                ),
            );
        }
        collect_inputs(&wallet, &mut positions, &mut samples);
    }

    let evaluation = rules::evaluate(&positions, &previous, &thresholds);

    for alert in &evaluation.alerts {
        let text = lyra_alerts::digest::render_alert(alert, None);
        if let lyra_alerts::telegram::Delivery::Failed(e) = sender.send(&text).await {
            record_error(&meta, format!("telegram: {e}"));
        }
    }

    if let Err(e) = store_handle
        .save_positions(&evaluation.state, wealth::now_secs())
        .await
    {
        record_error(&meta, format!("state: {e}"));
    }

    sample_positions(state, &samples).await;

    let watching = evaluation.state.len();
    update(&meta, |m| {
        m.last_check = Some(wealth::now_secs() as f64);
        m.watching = Some(watching);
    });
}

/// Flatten one wallet into the rules' inputs and the in-range samples, in one pass.
///
/// The two travel together because they read the same positions and the Python builds them in the
/// same loop — splitting them would mean walking the tree twice and inviting them to drift.
fn collect_inputs(
    wallet: &Wallet,
    positions: &mut Vec<PositionInput>,
    samples: &mut Vec<PerfSample>,
) {
    for bucket in &wallet.chains {
        for position in &bucket.defi {
            // `if d.get("cycle_start") is not None and d.get("perf_key")` — a position with no
            // harvest cycle has nothing to accumulate against, so it is not sampled at all.
            if let (Some(Some(cycle_start)), Some(perf_key), Some(in_range)) = (
                position.cycle_start,
                position.perf_key.as_ref(),
                position.in_range,
            ) {
                samples.push(PerfSample {
                    key: perf_key.clone(),
                    in_range,
                    // `d.get("last_harvest_at") or ""` — never harvested reads as empty, and must
                    // stay empty or every sweep looks like a fresh harvest.
                    harvest_anchor: position
                        .last_harvest_at
                        .clone()
                        .flatten()
                        .unwrap_or_default(),
                    cycle_start_ts: Some(cycle_start),
                });
            }

            positions.push(PositionInput {
                chain: bucket.chain.clone(),
                protocol: Some(position.protocol.clone()),
                id: position.id.clone().flatten(),
                name: Some(position.name.clone()),
                in_range: position.in_range,
                rewards_usd: position.rewards_usd.flatten(),
                health: position.health.as_ref().map(|h| Health {
                    hf: h.hf,
                    debt_usd: Some(h.debt_usd),
                    collateral_usd: Some(h.collateral_usd),
                }),
            });
        }
    }
}

/// Write the in-range observations — the only writer of `pos_perf` in the system.
///
/// Kept in its own function because it is the half of `_vfat_stamp_lifecycle` that every portfolio
/// build *reads*: if this stops running, `in_range_secs` silently freezes at whatever it last
/// reached, which looks like a position that stopped earning rather than like a broken sweep.
/// Hence a `warn`, not a `debug`.
async fn sample_positions(state: &AppState, samples: &[PerfSample]) {
    if samples.is_empty() {
        return;
    }
    if let Err(e) = store::record_perf_samples(&state.pool, samples, wealth::now_secs()).await {
        record_error(&state.alert_meta, format!("perf sample: {e}"));
    }
}

// ===========================================================================================
// Digest and snapshot
// ===========================================================================================

async fn maybe_digest(state: &AppState, config: &AlertConfig<'_>) {
    let meta = Arc::clone(&state.alert_meta);
    let sender = TelegramSender::from_env(&ProcessEnv);
    if !sender.can_send() || config.digest_hour().is_none() {
        return;
    }

    let now = chrono::Local::now();
    let today = day_key(&now);
    let store_handle = AlertStore::new(&state.pool);
    let last_sent = store_handle.digest_day().await.unwrap_or_default();

    if !lyra_alerts::digest::digest_due(
        true,
        config.digest_hour(),
        chrono::Timelike::hour(&now),
        &today,
        last_sent.as_deref(),
    ) {
        return;
    }

    match wealth::deliver_digest(state, &sender).await {
        Ok(wealth::DigestOutcome::Sent) => {
            // Stamped only on a delivered brief, so a Telegram outage retries on the next tick
            // within the same hour instead of silently skipping the day.
            if let Err(e) = store_handle
                .set_digest_day(&today, wealth::now_secs())
                .await
            {
                record_error(&meta, format!("digest: {e}"));
            }
        }
        Ok(_) => {}
        Err(e) => record_error(&meta, format!("digest: {e}")),
    }
}

/// `SNAPSHOT_GROUP`, defaulting to `server` — the series the always-on box owns, kept separate
/// from the browser's per-group history because the server only ever sees the keyless book.
pub fn snapshot_group() -> String {
    let raw = std::env::var("SNAPSHOT_GROUP").unwrap_or_default();
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        "server".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn maybe_snapshot(state: &AppState, config: &AlertConfig<'_>) {
    let meta = Arc::clone(&state.alert_meta);
    if wealth::watched_wallets().is_empty() && !lyra_chain::kucoin::configured() {
        return;
    }

    let group = snapshot_group();
    let interval = config.snapshot_interval() as i64;

    // The cheap check first, exactly as the Python does — `_collect()` is a full portfolio read
    // and must not run on every tick just to discover a snapshot is not due.
    match store::last_snapshot_ts(&state.pool, &group).await {
        Ok(last) if wealth::now_secs() - last < interval => return,
        Ok(_) => {}
        Err(e) => {
            record_error(&meta, format!("snapshot: {e}"));
            return;
        }
    }

    let Some(figures) = wealth::collect_figures().await else {
        record_error(
            &meta,
            "snapshot: the portfolio read returned nothing".into(),
        );
        return;
    };

    let input = SnapshotInput {
        net_worth: figures.total - figures.debt,
        assets: Some(figures.total),
        debt: Some(figures.debt),
        btc_usd: Some(figures.btc_usd),
        btc_sats: figures.btc_sats,
        extra: None,
    };
    if let Err(e) = store::record_snapshot(&state.pool, &group, &input, interval, None).await {
        record_error(&meta, format!("snapshot: {e}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_chain::model::{ChainBucket, LendingHealth, Position};

    fn lp(id: &str, in_range: Option<bool>) -> Position {
        Position {
            protocol: "Aerodrome".into(),
            name: "WETH/USDC".into(),
            id: Some(Some(id.into())),
            in_range,
            ..Position::default()
        }
    }

    fn wallet_with(defi: Vec<Position>) -> Wallet {
        Wallet {
            address: "0xabc".into(),
            total: 0.0,
            chains: vec![ChainBucket {
                chain: "base".into(),
                usd: 0.0,
                spot: Vec::new(),
                defi,
            }],
        }
    }

    #[test]
    fn a_stored_cycle_keeps_a_position_sampled_through_a_history_failure() {
        // The regression that motivated joining `pos_perf` inside `build_watched_wallet`. When
        // `sickle-nft-actions` fails on a tick, `stamp_lifecycle` leaves `cycle_start` unset — and
        // the sampling gate drops the position, freezing its accumulator. Python does not have
        // this hole because its join runs inside the build, before `check_once` looks. Here the
        // join fills the anchor back in, and the position keeps being sampled.
        let mut position = lp("#1", Some(true));
        position.perf_key = Some("8453:1".into());
        assert_eq!(position.cycle_start, None, "history failed this tick");

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(
            &wallet_with(vec![position.clone()]),
            &mut positions,
            &mut samples,
        );
        assert!(samples.is_empty(), "unjoined, it would be skipped");

        // What `join_perf` does before `collect_inputs` sees it.
        let perf = std::collections::HashMap::from([(
            "8453:1".to_string(),
            lyra_chain::adapters::vfat::PerfRecord {
                in_range_secs: 500.0,
                cycle_start: Some(1_784_124_971),
            },
        )]);
        let mut joined = vec![position];
        lyra_chain::adapters::vfat::apply_perf(&mut joined, &perf);

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(&wallet_with(joined), &mut positions, &mut samples);
        assert_eq!(samples.len(), 1, "the stored anchor keeps it in the sweep");
        assert_eq!(samples[0].cycle_start_ts, Some(1_784_124_971));
    }

    #[test]
    fn only_positions_with_a_harvest_cycle_are_sampled() {
        // `if d.get("cycle_start") is not None and d.get("perf_key")`. A lending position or an
        // exchange bot has no cycle to accumulate against, and sampling it would create a row the
        // reader never joins to.
        let mut tracked = lp("#1", Some(true));
        tracked.perf_key = Some("8453:1".into());
        tracked.cycle_start = Some(Some(1_000));

        let mut no_key = lp("#2", Some(true));
        no_key.cycle_start = Some(Some(1_000));

        let mut no_cycle = lp("#3", Some(true));
        no_cycle.perf_key = Some("8453:3".into());

        let mut null_cycle = lp("#4", Some(true));
        null_cycle.perf_key = Some("8453:4".into());
        null_cycle.cycle_start = Some(None); // present but null — still no anchor

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(
            &wallet_with(vec![tracked, no_key, no_cycle, null_cycle]),
            &mut positions,
            &mut samples,
        );

        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].key, "8453:1");
        assert_eq!(positions.len(), 4, "all four still go to the rules");
    }

    #[test]
    fn a_never_harvested_position_samples_an_empty_anchor() {
        // `d.get("last_harvest_at") or ""`. If this became "None" or a null, every sweep would
        // read as a fresh harvest and the accumulator would never leave zero.
        let mut position = lp("#1", Some(false));
        position.perf_key = Some("8453:1".into());
        position.cycle_start = Some(Some(1_000));
        assert_eq!(position.last_harvest_at, None);

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(&wallet_with(vec![position]), &mut positions, &mut samples);

        assert_eq!(samples[0].harvest_anchor, "");
        assert!(!samples[0].in_range);
    }

    #[test]
    fn a_harvested_position_carries_its_anchor() {
        let mut position = lp("#1", Some(true));
        position.perf_key = Some("8453:1".into());
        position.cycle_start = Some(Some(2_000));
        position.last_harvest_at = Some(Some("2026-07-20T09:00:00.000Z".into()));

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(&wallet_with(vec![position]), &mut positions, &mut samples);

        assert_eq!(samples[0].harvest_anchor, "2026-07-20T09:00:00.000Z");
        assert_eq!(samples[0].cycle_start_ts, Some(2_000));
    }

    #[test]
    fn the_chain_comes_from_the_bucket_not_the_position() {
        // The state key is `f"{chain}:{protocol}:{id or name}"`, and a key that changed shape
        // would re-baseline every position exactly once — silently losing a sweep of alerts.
        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(
            &wallet_with(vec![lp("#1", Some(true))]),
            &mut positions,
            &mut samples,
        );

        assert_eq!(positions[0].chain, "base");
        assert_eq!(positions[0].protocol.as_deref(), Some("Aerodrome"));
        assert_eq!(positions[0].id.as_deref(), Some("#1"));
    }

    #[test]
    fn lending_health_reaches_the_rules() {
        let mut borrow = lp("#1", None);
        borrow.health = Some(LendingHealth {
            hf: Some(1.2),
            ltv: 0.5,
            liq_threshold: 0.8,
            collateral_usd: 1_000.0,
            debt_usd: 400.0,
        });

        let (mut positions, mut samples) = (Vec::new(), Vec::new());
        collect_inputs(&wallet_with(vec![borrow]), &mut positions, &mut samples);

        let health = positions[0].health.as_ref().expect("health carried across");
        assert_eq!(health.hf, Some(1.2));
        assert_eq!(health.debt_usd, Some(400.0));
        assert_eq!(health.collateral_usd, Some(1_000.0));
        // No range concept, so nothing to sample.
        assert!(samples.is_empty());
        assert_eq!(positions[0].in_range, None);
    }

    #[test]
    fn meta_starts_inert() {
        // What `/api/wealth/alerts` reports when the loop was never started. `running: false` with
        // nulls is the truth; a fabricated timestamp is not.
        let meta = SharedMeta::default();
        let seen = snapshot(&meta);
        assert!(!seen.running);
        assert_eq!(seen.last_check, None);
        assert_eq!(seen.watching, None);
        assert_eq!(seen.last_error, None);
    }

    #[test]
    fn meta_survives_a_poisoned_lock() {
        // A panicked writer must cost the status display, never the loop.
        let meta = SharedMeta::default();
        update(&meta, |m| m.running = true);

        let poisoned = Arc::clone(&meta);
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.lock().unwrap();
            panic!("poison it");
        })
        .join();

        assert!(meta.lock().is_err(), "the lock really is poisoned");
        assert!(
            !snapshot(&meta).running,
            "degrades to inert, does not panic"
        );
    }

    #[test]
    fn the_snapshot_group_defaults_to_server() {
        // SAFETY: single-threaded test, and the variable is not read concurrently here.
        unsafe {
            std::env::remove_var("SNAPSHOT_GROUP");
        }
        assert_eq!(snapshot_group(), "server");

        unsafe {
            std::env::set_var("SNAPSHOT_GROUP", "   ");
        }
        assert_eq!(snapshot_group(), "server", "blank is not a group name");

        unsafe {
            std::env::set_var("SNAPSHOT_GROUP", "  box  ");
        }
        assert_eq!(snapshot_group(), "box");

        unsafe {
            std::env::remove_var("SNAPSHOT_GROUP");
        }
    }
}
