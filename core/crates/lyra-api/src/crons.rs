//! Firing the crons, and configuring them over HTTP.
//!
//! The tick is [`run_due`], called from `alert_loop` on the same thirty-second beat as everything
//! else. It is the fifth `maybe_*` in that loop, except that its list is a table.
//!
//! The three built-in schedules — the brief, the nudge, the snapshot — are **not** here. They still
//! read their hours from the environment, and migrating them is a separate deliberate change: they
//! carry the morning brief, and moving them in the same breath as introducing this would mean a bug
//! here is a brief that never arrives. This runs alongside them and fires only rows you created.

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lyra_db::channels::Severity;
use lyra_db::crons::{Cron, CronInput, CronPatch, CronStore, Due, Now, Schedule};
use lyra_db::jobs::{NewJob, Queue, SqliteQueue, now_secs};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::{error, not_found};

/// The actions a cron may take.
///
/// A short allowlist rather than "any registered kind", and that is the safer direction: a kind that
/// exists is not necessarily one that makes sense on a timer, and a cron pointed at the wrong one
/// produces jobs that fail forever. `notify.message` is the one a person wants; the rest of the
/// registry is reachable by adding a line here, deliberately.
pub const ACTIONS: [&str; 1] = ["notify.message"];

/// Local clock facts for the schedules, from `chrono`.
///
/// Gathered here because `lyra-db` deliberately has no clock — see [`Now`].
fn local_now() -> Now {
    use chrono::{Datelike, Timelike};
    let now = chrono::Local::now();
    Now {
        epoch: now.timestamp(),
        date: now.format("%Y-%m-%d").to_string(),
        minute_of_day: i64::from(now.hour()) * 60 + i64::from(now.minute()),
        // chrono counts Monday as 0 through `num_days_from_monday`, which is the convention
        // `Schedule::Weekly` documents.
        weekday: now.weekday().num_days_from_monday() as u8,
    }
}

/// Fire whatever is due. Called from the sweep's tick.
///
/// Returns how many jobs were queued, for the log line and for tests.
pub async fn run_due(state: &AppState) -> usize {
    let store = CronStore::new(state.pool.clone());
    let queue = SqliteQueue::new(state.pool.clone());
    let now = local_now();
    let epoch = now.epoch;

    let crons = match store.enabled().await {
        Ok(crons) => crons,
        Err(e) => {
            tracing::error!(error = %e, "could not read the crons");
            return 0;
        }
    };

    let mut queued = 0;
    for cron in crons {
        match cron
            .schedule
            .due(&now, cron.last_occurrence.as_deref(), cron.catch_up_minutes)
        {
            Due::NotYet => {}
            Due::Missed {
                occurrence,
                late_by_minutes,
            } => {
                // Counted and said out loud. A schedule that silently stops is the failure the
                // `missed` column exists to make visible.
                tracing::warn!(
                    cron = %cron.id,
                    name = %cron.name,
                    occurrence = %occurrence,
                    late_by_minutes,
                    "a scheduled firing was missed — past its catch-up window"
                );
                if let Err(e) = store.mark_missed(&cron.id, &occurrence, epoch).await {
                    tracing::error!(cron = %cron.id, error = %e, "recording a missed firing");
                }
            }
            Due::Fire { occurrence } => {
                let job = job_for(&cron, &occurrence);
                match queue.enqueue(&job, epoch).await {
                    Ok(enqueued) => {
                        // Marked fired whether or not the job was *new*: every tick in the window
                        // produces the same key, so the second one returning the existing job is the
                        // normal case and not a reason to keep trying.
                        if let Err(e) = store.mark_fired(&cron.id, &occurrence, epoch).await {
                            tracing::error!(cron = %cron.id, error = %e, "marking a cron fired");
                        }
                        if enqueued.created {
                            queued += 1;
                            tracing::info!(
                                cron = %cron.id, name = %cron.name, job = %enqueued.id,
                                occurrence = %occurrence, "a scheduled job is queued"
                            );
                        }
                    }
                    // Left unmarked on purpose: the database refused, and the next tick should try
                    // the same occurrence again rather than treat it as done.
                    Err(e) => {
                        tracing::error!(cron = %cron.id, error = %e, "queueing a scheduled job")
                    }
                }
            }
        }
    }
    queued
}

/// The job one firing becomes.
///
/// Keyed `<action>:<cron id>:<occurrence>`, so every tick inside the window produces the same single
/// job — the same mechanism the daily brief has always used, and the reason exactly-once needs no new
/// machinery here.
fn job_for(cron: &Cron, occurrence: &str) -> NewJob {
    let key = format!("{}:{}:{}", cron.action, cron.id, occurrence);
    match cron.action.as_str() {
        crate::jobs::notify::message::KIND => {
            let text = cron
                .payload
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            let group = cron
                .payload
                .get("group")
                .and_then(|g| g.as_str())
                .unwrap_or("day");
            let severity = Severity::parse(
                cron.payload
                    .get("severity")
                    .and_then(|s| s.as_str())
                    .unwrap_or("info"),
            );
            crate::jobs::notify::message::job(text, group, severity).key(key)
        }
        // Unreachable while `ACTIONS` is the allowlist and it is checked on write. Built anyway
        // rather than skipped, so a row that predates a change to that list fails loudly as a job
        // with no handler instead of disappearing from the tick with no trace.
        other => NewJob::new(other, lyra_db::jobs::Lane::Deliver)
            .payload(cron.payload.clone())
            .key(key),
    }
}

/* ─── HTTP ─── */

fn store(state: &AppState) -> CronStore {
    CronStore::new(state.pool.clone())
}

/// A cron as the UI sees it: the row, plus the schedule in words.
///
/// Rendered here rather than in the front end so the two cannot disagree about what "every 15
/// minutes" means. Every endpoint that returns a cron goes through this — a response missing
/// `describes` would make the field optional in the client's type for no reason.
fn described(cron: &Cron) -> serde_json::Value {
    let mut value = serde_json::to_value(cron).unwrap_or(json!({}));
    value["describes"] = json!(cron.schedule.describe());
    value
}

/// Everything a form needs: the rows, the actions, and the groups a message can belong to.
pub async fn index(_user: AuthUser, State(state): State<AppState>) -> Response {
    match store(&state).list().await {
        Ok(crons) => {
            let described: Vec<_> = crons.iter().map(described).collect();
            Json(json!({
                "crons": described,
                "actions": ACTIONS,
                "groups": crate::notify::GROUPS,
            }))
            .into_response()
        }
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("listing crons: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct NewCron {
    pub name: String,
    pub schedule: Schedule,
    pub action: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default = "default_catch_up")]
    pub catch_up_minutes: i64,
}

/// An hour. Long enough that a reboot does not lose the morning, short enough that a nudge does not
/// arrive at lunchtime.
fn default_catch_up() -> i64 {
    60
}

pub async fn create(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<NewCron>,
) -> Response {
    if body.name.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "a schedule needs a name");
    }
    if let Err(why) = check(&body.action, &body.payload) {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    match store(&state)
        .create(
            &CronInput {
                name: body.name.trim().to_string(),
                schedule: body.schedule,
                action: body.action,
                payload: body.payload,
                catch_up_minutes: body.catch_up_minutes.clamp(0, 24 * 60),
            },
            now_secs(),
        )
        .await
    {
        Ok(cron) => (StatusCode::CREATED, Json(described(&cron))).into_response(),
        // `Schedule::validate` refuses a schedule that can never fire, and its message names the
        // rule, so this is the caller's problem rather than the server's.
        Err(e) => error(StatusCode::BAD_REQUEST, &format!("{e}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct CronBody {
    pub name: Option<String>,
    pub schedule: Option<Schedule>,
    pub payload: Option<serde_json::Value>,
    pub enabled: Option<bool>,
    pub catch_up_minutes: Option<i64>,
}

pub async fn update(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<CronBody>,
) -> Response {
    let store = store(&state);
    let Ok(Some(existing)) = store.get(&id).await else {
        return not_found("no such schedule");
    };
    if let Some(payload) = &body.payload
        && let Err(why) = check(&existing.action, payload)
    {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    let patch = CronPatch {
        name: body
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty()),
        schedule: body.schedule,
        payload: body.payload,
        enabled: body.enabled,
        catch_up_minutes: body.catch_up_minutes.map(|m| m.clamp(0, 24 * 60)),
    };
    match store.update(&id, &patch, now_secs()).await {
        Ok(Some(cron)) => Json(described(&cron)).into_response(),
        Ok(None) => not_found("no such schedule"),
        Err(e) => error(StatusCode::BAD_REQUEST, &format!("{e}")),
    }
}

pub async fn delete(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match store(&state).delete(&id).await {
        Ok(true) => crate::common::ok_true(),
        Ok(false) => not_found("no such schedule"),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("deleting a schedule: {e}"),
        ),
    }
}

/// Run one now, without waiting for its time.
///
/// Keyed by the moment rather than the occurrence, so a manual run is always a new job and never
/// deduped against the scheduled one — and never consumes the day's occurrence either, so the real
/// firing still happens.
pub async fn run_now(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let Ok(Some(cron)) = store(&state).get(&id).await else {
        return not_found("no such schedule");
    };
    let now = now_secs();
    let job = job_for(&cron, &format!("manual:{now}"));
    match SqliteQueue::new(state.pool.clone())
        .enqueue(&job, now)
        .await
    {
        Ok(enqueued) => Json(json!({ "ok": true, "job": enqueued.id })).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("queueing: {e}")),
    }
}

/// Whether this action, with this payload, could ever do anything.
fn check(action: &str, payload: &serde_json::Value) -> Result<String, String> {
    if !ACTIONS.contains(&action) {
        return Err(format!(
            "{action:?} is not something a schedule can run — try one of: {}",
            ACTIONS.join(", ")
        ));
    }
    if action == crate::jobs::notify::message::KIND {
        let text = payload
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            return Err("a message needs something to say".into());
        }
        if let Some(group) = payload.get("group").and_then(|g| g.as_str())
            && !crate::notify::GROUPS.contains(&group)
        {
            return Err(format!("unknown group {group:?}"));
        }
    }
    Ok(action.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::crons::Schedule;
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState, SqliteQueue, CronStore) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state =
            AppState::new(pool.clone(), "test-secret".into()).with_secret_key(Some(vec![5u8; 32]));
        (
            dir,
            state,
            SqliteQueue::new(pool.clone()),
            CronStore::new(pool),
        )
    }

    fn message(at_minute: i64) -> CronInput {
        CronInput {
            name: "stand up".into(),
            schedule: Schedule::Daily { at_minute },
            action: "notify.message".into(),
            payload: json!({ "text": "stand up and stretch", "group": "day" }),
            catch_up_minutes: 60,
        }
    }

    /// The whole point of the tick: a due cron queues exactly one job, and running again inside the
    /// same window queues nothing more.
    #[tokio::test]
    async fn a_due_cron_queues_one_job_and_the_next_tick_queues_none() {
        let (_dir, state, queue, store) = app().await;
        // Midnight-to-now, so it is always past its time and inside a generous catch-up window.
        let mut input = message(0);
        input.catch_up_minutes = 24 * 60;
        let cron = store.create(&input, 1000).await.unwrap();

        assert_eq!(run_due(&state).await, 1);
        let jobs = queue.recent(10).await.unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].kind, "notify.message");
        // Keyed by action, cron and occurrence — the same mechanism the daily brief uses.
        let key = jobs[0].idempotency_key.as_deref().unwrap();
        assert!(key.starts_with("notify.message:"), "{key}");
        assert!(key.contains(&cron.id), "{key}");

        // Thirty seconds later. The key is the same, so nothing new is created.
        assert_eq!(run_due(&state).await, 0);
        assert_eq!(queue.recent(10).await.unwrap().len(), 1);

        let after = store.get(&cron.id).await.unwrap().unwrap();
        assert!(after.last_occurrence.is_some());
        assert_eq!(after.missed, 0);
    }

    /// A slot that went by while nothing was running is counted, and counted **once**.
    #[tokio::test]
    async fn a_missed_slot_is_recorded_once_and_queues_nothing() {
        let (_dir, state, queue, store) = app().await;
        // Due at 00:00 with no catch-up at all, so any time past midnight is already too late.
        let mut input = message(0);
        input.catch_up_minutes = 0;
        let cron = store.create(&input, 1000).await.unwrap();

        assert_eq!(run_due(&state).await, 0, "too late to be worth sending");
        assert!(queue.recent(10).await.unwrap().is_empty());
        assert_eq!(store.get(&cron.id).await.unwrap().unwrap().missed, 1);

        // The tick runs every thirty seconds. Without recording the occurrence this would count a
        // miss on every one of them for the rest of the day.
        run_due(&state).await;
        run_due(&state).await;
        assert_eq!(
            store.get(&cron.id).await.unwrap().unwrap().missed,
            1,
            "one missed slot is one miss, not one per tick"
        );
    }

    #[tokio::test]
    async fn a_disabled_cron_is_not_considered() {
        let (_dir, state, queue, store) = app().await;
        let mut input = message(0);
        input.catch_up_minutes = 24 * 60;
        let cron = store.create(&input, 1000).await.unwrap();
        store
            .update(
                &cron.id,
                &CronPatch {
                    enabled: Some(false),
                    ..Default::default()
                },
                1000,
            )
            .await
            .unwrap();

        assert_eq!(run_due(&state).await, 0);
        assert!(queue.recent(10).await.unwrap().is_empty());
        assert_eq!(
            store.get(&cron.id).await.unwrap().unwrap().missed,
            0,
            "off is not the same as missed"
        );
    }

    /// Running by hand must not consume the day's occurrence.
    #[tokio::test]
    async fn a_manual_run_does_not_use_up_the_scheduled_firing() {
        let (_dir, state, queue, store) = app().await;
        let mut input = message(0);
        input.catch_up_minutes = 24 * 60;
        let cron = store.create(&input, 1000).await.unwrap();

        // What the endpoint does.
        let manual = job_for(&cron, &format!("manual:{}", 1234));
        queue.enqueue(&manual, 1234).await.unwrap();

        // The scheduled firing still happens, as its own job.
        assert_eq!(run_due(&state).await, 1);
        assert_eq!(queue.recent(10).await.unwrap().len(), 2);
    }

    #[test]
    fn an_action_outside_the_allowlist_is_refused_by_name() {
        let refused = check("snapshot.networth", &json!({})).unwrap_err();
        assert!(refused.contains("snapshot.networth") && refused.contains("notify.message"));
        // A message with nothing to say could only ever deliver an empty string.
        assert!(
            check("notify.message", &json!({ "text": "  " }))
                .unwrap_err()
                .contains("say")
        );
        assert!(
            check(
                "notify.message",
                &json!({ "text": "hi", "group": "nonsense" })
            )
            .unwrap_err()
            .contains("nonsense")
        );
        assert!(check("notify.message", &json!({ "text": "hi", "group": "day" })).is_ok());
    }
}
