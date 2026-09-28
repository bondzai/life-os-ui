//! `notify.deliver` — one job, one channel.
//!
//! This is the shape `deliver.telegram` could not have. That handler covers every configured channel
//! in one job with one `"sent"` effect per channel, which works, but it cannot express *routing*:
//! every channel gets the same message or none does. Here the routing decision has already happened
//! — [`crate::notify::notify`] resolved which channels a notification reaches — and each of them
//! gets its own job, its own backoff, its own dead letter, and its own row in the failure state the
//! settings screen reads.
//!
//! A hung Discord therefore delays nothing else: it is a different job in the same lane, not a
//! twelve-second timeout in front of Telegram.

use anyhow::anyhow;
use lyra_db::channels::ChannelStore;
use lyra_db::jobs::{Lane, NewJob, now_secs};
use serde_json::json;

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;
use crate::jobs::deliver::Markup;

pub const KIND: &str = "notify.deliver";

/// One channel's copy of a notification.
///
/// `key` is the notification's own occurrence name, and it is optional because not every producer
/// has one. The daily brief does — one per day — and a key makes every tick in the hour produce the
/// same job. An alert does not: `rules::evaluate` only emits on a transition, and a position that
/// goes out of range, comes back, and goes out again has two things to say rather than one. A key
/// there would swallow the second.
pub fn job(channel_id: &str, key: Option<&str>, text: impl Into<String>, markup: Markup) -> NewJob {
    job_with(channel_id, key, text, markup, &[])
}

/// The same, carrying taps.
///
/// Separate rather than a fifth argument on `job`, because every existing producer has nothing to
/// attach and threading an empty slice through all of them would only make them harder to read.
pub fn job_with(
    channel_id: &str,
    key: Option<&str>,
    text: impl Into<String>,
    markup: Markup,
    buttons: &[lyra_alerts::message::Button],
) -> NewJob {
    let job = NewJob::new(KIND, Lane::Deliver).payload(json!({
        "channel_id": channel_id,
        "text": text.into(),
        "markup": markup.as_str(),
        "buttons": buttons
            .iter()
            .map(|b| json!({ "label": b.label, "data": b.data }))
            .collect::<Vec<_>>(),
    }));
    match key {
        // Per channel, so one notification's two deliveries are two jobs rather than one that
        // dedupes the second away.
        Some(key) => job.key(format!("notify:{key}:{channel_id}")),
        None => job,
    }
}

pub struct NotifyDeliver {
    state: AppState,
}

impl NotifyDeliver {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for NotifyDeliver {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let channel_id = ctx.require_str("channel_id")?.to_string();
            let text = ctx.require_str("text")?.trim().to_string();
            if text.is_empty() {
                return Err(HandlerError::Permanent(anyhow!(
                    "notify.deliver: payload.text is empty"
                )));
            }
            let markup = ctx
                .payload()
                .get("markup")
                .and_then(|m| m.as_str())
                .unwrap_or("plain");

            let store = ChannelStore::new(
                self.state.pool.clone(),
                self.state.secret_key.as_deref().cloned(),
            );

            let Ok(Some(channel)) = store.get(&channel_id).await else {
                // Permanent: a channel that has been deleted will not come back, and five attempts
                // would only turn one removal into five rows in the failed list.
                return Err(HandlerError::Permanent(anyhow!(
                    "no such channel {channel_id}"
                )));
            };

            // Disabled *after* the job was queued. Not a failure and not a send: recorded as a
            // completed step so the row says what happened instead of the job vanishing into done
            // with no explanation.
            if !channel.enabled {
                ctx.once("sent", || async {
                    Ok(json!({ "delivered": false, "reason": "the channel is disabled" }))
                })
                .await?;
                return Ok(());
            }

            let secret = store
                .secret_of(&channel_id)
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("{e}")))?;

            let transport = lyra_alerts::channels::Transport::parse(&channel.transport)
                .ok_or_else(|| {
                    HandlerError::Permanent(anyhow!(
                        "channel {channel_id} has transport {:?}, which this build does not know",
                        channel.transport
                    ))
                })?;

            // Re-checked here, not trusted from the row: a row can outlive the rules that admitted
            // it, and this is the code that would hand the credential over.
            let sender = crate::notify::sender_for(transport, secret.as_deref())
                .map_err(|why| HandlerError::Permanent(anyhow!("{why}")))?;

            let message = if markup == "telegram" {
                lyra_alerts::message::Message::telegram_markup(text)
            } else {
                lyra_alerts::message::Message::plain(text)
            }
            .with_buttons(buttons_of(ctx.payload()));

            let now = now_secs();
            let outcome = ctx
                .once("sent", || async {
                    match sender.send(&message).await {
                        lyra_alerts::telegram::Delivery::Sent => Ok(json!({ "delivered": true })),
                        lyra_alerts::telegram::Delivery::NotConfigured => Ok(json!({
                            "delivered": false,
                            "reason": "the channel has nothing to send with"
                        })),
                        lyra_alerts::telegram::Delivery::Failed(e) => {
                            Err(anyhow!("{}", e.message()))
                        }
                    }
                })
                .await;

            // The channel row carries the health the settings screen shows, so it is written here
            // rather than left to the job's own status: a reader wants "Discord has been failing
            // since Tuesday", which is a fact about the channel and not about one job.
            match outcome {
                Ok(_) => {
                    let _ = store.record_success(&channel_id, now).await;
                    Ok(())
                }
                Err(e) => {
                    let _ = store
                        .record_failure(&channel_id, &format!("{e}"), now)
                        .await;
                    Err(HandlerError::Retry(e))
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::channels::{ChannelInput, Route, Severity};
    use lyra_db::jobs::{Queue, SqliteQueue, Status};
    use std::sync::Arc;
    use tempfile::TempDir;

    use crate::jobs::{Handlers, Worker};

    const KEY: [u8; 32] = [5u8; 32];
    const URL: &str = "https://discord.com/api/webhooks/1234567890/abcdefghijklmnopqrstuvwxyz";

    async fn app() -> (TempDir, AppState, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state =
            AppState::new(pool.clone(), "test-secret".into()).with_secret_key(Some(KEY.to_vec()));
        (dir, state, SqliteQueue::new(pool))
    }

    fn store(state: &AppState) -> ChannelStore {
        ChannelStore::new(state.pool.clone(), state.secret_key.as_deref().cloned())
    }

    /// **The property that protects a live box.**
    ///
    /// This ships to a machine already sending real alerts about real money, where there are no
    /// channels and no routes until somebody opens Settings. Routing correctly to nowhere would stop
    /// every alert silently — the exact failure the feature exists to remove — so until a group has
    /// somewhere to go, it goes where it used to.
    #[tokio::test]
    async fn with_nothing_configured_a_notification_still_goes_out_the_old_way() {
        let (_dir, state, queue) = app().await;

        let queued = crate::notify::notify(
            &state,
            "money",
            Severity::Warning,
            None,
            "health factor 1.05",
            Markup::Telegram,
        )
        .await;

        assert_eq!(queued, 1);
        let recent = queue.recent(10).await.unwrap();
        assert_eq!(recent.len(), 1);
        assert_eq!(
            recent[0].kind, "deliver.telegram",
            "the fallback is the old all-channels job, not a routed one"
        );
    }

    /// One routed notification, two channels, two jobs.
    #[tokio::test]
    async fn a_routed_notification_becomes_one_job_per_channel() {
        let (_dir, state, queue) = app().await;
        let store = store(&state);

        let a = store
            .create(
                &ChannelInput {
                    name: "discord-money".into(),
                    transport: "discord".into(),
                    secret: Some(URL.into()),
                },
                1000,
            )
            .await
            .unwrap();
        let b = store
            .create(
                &ChannelInput {
                    name: "discord-backup".into(),
                    transport: "discord".into(),
                    secret: Some(URL.into()),
                },
                1000,
            )
            .await
            .unwrap();
        // A third that is *not* routed, to prove routing selects rather than fans out.
        let unrouted = store
            .create(
                &ChannelInput {
                    name: "discord-unused".into(),
                    transport: "discord".into(),
                    secret: Some(URL.into()),
                },
                1000,
            )
            .await
            .unwrap();

        store
            .set_routes(&[
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: a.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
                Route {
                    id: String::new(),
                    group: "money".into(),
                    channel_id: b.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
                Route {
                    id: String::new(),
                    group: "day".into(),
                    channel_id: unrouted.id.clone(),
                    min_severity: Severity::Info,
                    quiet_from: None,
                    quiet_to: None,
                },
            ])
            .await
            .unwrap();

        let queued = crate::notify::notify(
            &state,
            "money",
            Severity::Warning,
            None,
            "fees ready",
            Markup::Plain,
        )
        .await;

        assert_eq!(queued, 2);
        let recent = queue.recent(10).await.unwrap();
        assert_eq!(recent.len(), 2);
        assert!(recent.iter().all(|job| job.kind == KIND));

        let targets: std::collections::BTreeSet<String> = recent
            .iter()
            .map(|job| job.payload["channel_id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(
            targets,
            [a.id, b.id].into_iter().collect(),
            "only the routed channels, and the day-only one is not among them"
        );
    }

    /// A severity below a route's threshold reaches nothing — and then falls back rather than
    /// vanishing, which is the transitional behaviour above and worth pinning so its removal is
    /// deliberate.
    #[tokio::test]
    async fn a_notification_under_the_threshold_falls_back_rather_than_disappearing() {
        let (_dir, state, queue) = app().await;
        let store = store(&state);
        let channel = store
            .create(
                &ChannelInput {
                    name: "loud-only".into(),
                    transport: "discord".into(),
                    secret: Some(URL.into()),
                },
                1000,
            )
            .await
            .unwrap();
        store
            .set_routes(&[Route {
                id: String::new(),
                group: "money".into(),
                channel_id: channel.id,
                min_severity: Severity::Critical,
                quiet_from: None,
                quiet_to: None,
            }])
            .await
            .unwrap();

        let queued = crate::notify::notify(
            &state,
            "money",
            Severity::Info,
            None,
            "small news",
            Markup::Plain,
        )
        .await;

        assert_eq!(queued, 1);
        assert_eq!(queue.recent(10).await.unwrap()[0].kind, "deliver.telegram");
    }

    /// A job for a channel that has since been deleted is permanent, not retried five times.
    #[tokio::test]
    async fn a_deleted_channel_fails_the_job_once() {
        let (_dir, state, queue) = app().await;
        let id = queue
            .enqueue(&job("chan-gone", None, "anything", Markup::Plain), 1000)
            .await
            .unwrap()
            .id;

        let worker = Worker::new(
            queue.clone(),
            Arc::new(Handlers::new().with(Arc::new(NotifyDeliver::new(state)))),
            "deliver-0",
            vec![Lane::Deliver],
        )
        .clock(Arc::new(|| 1000));
        assert!(worker.tick().await);

        let done = queue.get(&id).await.unwrap().unwrap();
        assert_eq!(done.status, Status::Failed);
        assert_eq!(done.attempts, 1, "permanent, so it is not attempted again");
        assert!(done.last_error.unwrap().contains("chan-gone"));
    }

    /// A channel disabled after the job was queued is not a failure and not a send.
    #[tokio::test]
    async fn a_disabled_channel_completes_without_sending_and_says_so() {
        let (_dir, state, queue) = app().await;
        let store = store(&state);
        let channel = store
            .create(
                &ChannelInput {
                    name: "off".into(),
                    transport: "discord".into(),
                    secret: Some(URL.into()),
                },
                1000,
            )
            .await
            .unwrap();
        let id = queue
            .enqueue(&job(&channel.id, None, "anything", Markup::Plain), 1000)
            .await
            .unwrap()
            .id;
        store
            .update(&channel.id, None, None, Some(false), 1000)
            .await
            .unwrap();

        let worker = Worker::new(
            queue.clone(),
            Arc::new(Handlers::new().with(Arc::new(NotifyDeliver::new(state)))),
            "deliver-0",
            vec![Lane::Deliver],
        )
        .clock(Arc::new(|| 1000));
        assert!(worker.tick().await);

        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);
        let effect = queue.recall(&id, "sent").await.unwrap().unwrap();
        assert_eq!(effect["delivered"], serde_json::json!(false));
        assert!(effect["reason"].as_str().unwrap().contains("disabled"));
    }

    #[test]
    fn a_key_makes_one_job_per_channel_rather_than_one_overall() {
        // Two channels, one notification: the keys must differ or the second delivery would be
        // deduped away as "already queued".
        let a = job("chan-1", Some("digest:2026-09-27"), "x", Markup::Plain);
        let b = job("chan-2", Some("digest:2026-09-27"), "x", Markup::Plain);
        assert_ne!(a.idempotency_key, b.idempotency_key);
        assert!(a.idempotency_key.unwrap().contains("chan-1"));
        // And no key at all stays no key, for producers whose events are already de-duplicated by
        // being transitions.
        assert!(
            job("chan-1", None, "x", Markup::Plain)
                .idempotency_key
                .is_none()
        );
    }

    #[test]
    fn the_alert_severities_are_the_ones_quiet_hours_depend_on() {
        use lyra_alerts::rules::AlertKind;
        // Critical is the only level that pierces quiet hours, so which kinds get it is a decision
        // and not a detail: approaching liquidation, and nothing else.
        assert_eq!(
            crate::notify::severity_of(&AlertKind::HealthFactorLow {
                hf: 1.01,
                threshold: 1.1,
                debt_usd: 1.0,
                collateral_usd: 2.0
            }),
            Severity::Critical
        );
        assert_eq!(
            crate::notify::severity_of(&AlertKind::OutOfRange),
            Severity::Warning
        );
        assert_eq!(
            crate::notify::severity_of(&AlertKind::BackInRange),
            Severity::Info
        );
    }
}

/// `notify.message` — a scheduled message, fanned out to whatever its group is routed to.
///
/// This is the action a cron you create in Settings uses. It is a *producer*, not a delivery: it
/// turns one scheduled firing into one `notify.deliver` per routed channel.
///
/// The fan-out is enqueued as **follow-ups**, written in the same commit as this job's completion, so
/// the queue can never hold a message job that ran and deliveries that were never queued. That is why
/// it uses `crate::notify::deliveries` rather than `notify`, which would enqueue immediately and
/// outside that commit.
/// The taps a job carries, if any.
///
/// Absent, malformed or empty all mean the same thing: no buttons. A notification that arrives
/// without its buttons is still the notification; refusing to send it because a label was missing
/// would trade the whole message for a tap.
pub(crate) fn buttons_of(payload: &serde_json::Value) -> Vec<lyra_alerts::message::Button> {
    payload
        .get("buttons")
        .and_then(|b| b.as_array())
        .map(|buttons| {
            buttons
                .iter()
                .filter_map(|button| {
                    Some(lyra_alerts::message::Button {
                        label: button.get("label")?.as_str()?.to_string(),
                        data: button.get("data")?.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub mod message {
    use super::*;
    use lyra_db::channels::Severity;

    pub const KIND: &str = "notify.message";

    /// A message to send on a schedule. `group` and `severity` decide where it lands.
    pub fn job(text: impl Into<String>, group: &str, severity: Severity) -> NewJob {
        NewJob::new(KIND, Lane::Deliver).payload(json!({
            "text": text.into(),
            "group": group,
            "severity": severity.as_str(),
        }))
    }

    pub struct NotifyMessage {
        state: AppState,
    }

    impl NotifyMessage {
        pub fn new(state: AppState) -> Self {
            Self { state }
        }
    }

    impl Handler for NotifyMessage {
        fn kind(&self) -> &'static str {
            KIND
        }

        fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
            Box::pin(async move {
                let text = ctx.require_str("text")?.trim().to_string();
                if text.is_empty() {
                    return Err(HandlerError::Permanent(anyhow!(
                        "notify.message: payload.text is empty"
                    )));
                }
                let group = ctx
                    .payload()
                    .get("group")
                    .and_then(|g| g.as_str())
                    .unwrap_or("day")
                    .to_string();
                let severity = Severity::parse(
                    ctx.payload()
                        .get("severity")
                        .and_then(|s| s.as_str())
                        .unwrap_or("info"),
                );

                // Keyed by this job's own id, so a retry of *this* job lands as the same deliveries
                // rather than a second copy. The cron's own key already made this job unique for its
                // occurrence; this makes the fan-out unique for this job.
                let key = format!("message:{}", ctx.job.id);
                let jobs = crate::notify::deliveries(
                    &self.state,
                    &group,
                    severity,
                    Some(&key),
                    &text,
                    Markup::Plain,
                )
                .await;
                if jobs.is_empty() {
                    return Err(HandlerError::Retry(anyhow!(
                        "nowhere to send a {group} message"
                    )));
                }
                for job in jobs {
                    ctx.enqueue(job);
                }
                Ok(())
            })
        }
    }
}
