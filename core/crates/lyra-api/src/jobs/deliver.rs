//! `deliver.telegram` — an outbound message with retries.
//!
//! Sending is the one thing this box does that depends on somebody else being up, and every send
//! outside the digest path is fire-and-forget: `alert_loop` logs `delivered = false` and moves on.
//! As a job it survives — the row stays, the backoff climbs, and an outage costs latency.
//!
//! An earlier version of this note said a digest failing at 08:00 was "simply lost". That was
//! wrong, and the mistake is worth leaving recorded: `maybe_digest` stamps its day key only on a
//! delivered brief, which is precisely what makes it retry on the next tick. The real limitation
//! is the *hour* — see [`super::digest`].
//!
//! The send is a job **of its own**, never a step inside the job that produced the text. If it
//! lived inside a handler that called a model, a Telegram outage would retry the *model call*:
//! minutes of compute to re-send one message.

use std::sync::Arc;

use anyhow::anyhow;
use lyra_alerts::channels::Channels;
use lyra_alerts::config::ProcessEnv;
use lyra_alerts::message::Message;
use lyra_alerts::telegram::Delivery;
use serde_json::json;

use lyra_db::jobs::{Lane, NewJob};

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};

/// The job kind. A wire contract: it is written into every row, so renaming it strands whatever
/// is already queued. Spelled once, here — it was a string literal in four places.
pub const KIND: &str = "deliver.telegram";

/// Whether the text already carries Telegram markup.
///
/// An enum rather than the `"plain"` / `"telegram"` strings it replaces: the handler treats any
/// value it does not recognise as plain, so a typo at an enqueue site used to change the
/// formatting silently instead of failing to compile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Markup {
    /// Escaped by the sender. The safe default for anything built from on-chain names.
    Plain,
    /// Already Telegram-formatted, by a renderer that stripped the untrusted parts itself.
    Telegram,
}

impl Markup {
    /// `pub(crate)` so `notify.deliver` writes the same values rather than a second copy of
    /// this mapping that could drift from it.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Markup::Plain => "plain",
            Markup::Telegram => "telegram",
        }
    }
}

/// A message to send, as a job. The one way to build one.
pub fn job(text: impl Into<String>, markup: Markup) -> NewJob {
    job_with(text, markup, &[])
}

/// The same, carrying taps.
///
/// This path matters more than it looks: while routing is empty, **everything** falls back to here,
/// including a decision that wants buttons on the one channel that can render them. Dropping them
/// here meant the inbox reached your phone as plain text on exactly the box that had not been
/// configured yet — which is every box, on day one.
pub fn job_with(
    text: impl Into<String>,
    markup: Markup,
    buttons: &[lyra_alerts::message::Button],
) -> NewJob {
    NewJob::new(KIND, Lane::Deliver).payload(json!({
        "text": text.into(),
        "markup": markup.as_str(),
        "buttons": buttons
            .iter()
            .map(|b| json!({ "label": b.label, "data": b.data }))
            .collect::<Vec<_>>(),
    }))
}

/// Sends a job's `payload.text` to every configured channel, and holds each channel to its own
/// outcome.
///
/// Named for Telegram because that is the channel anyone is waiting on, but a box with Discord
/// configured gets both. **"Delivered" means delivered to every channel**, not to one of them: the
/// job stays unfinished while any channel is still owed the message, and a retry attempts only the
/// channels that have not taken it. It previously reported success as soon as one channel accepted,
/// which is how a Discord outage could last for days without anything saying so.
pub struct DeliverTelegram {
    channels: Arc<Channels>,
}

impl DeliverTelegram {
    /// Read the channels once, at startup.
    ///
    /// Not per job: `from_env` builds an HTTP client per sender, and rebuilding one for every
    /// message throws away the connection pool that makes the second message fast.
    pub fn from_env() -> Self {
        Self::new(Channels::from_env(&ProcessEnv))
    }

    /// Build from an explicit channel list, the way [`Channels::new`] does — one channel only, or
    /// none at all, which is what a test wants and what an unconfigured box actually has.
    pub fn new(channels: Channels) -> Self {
        Self {
            channels: Arc::new(channels),
        }
    }
}

impl Handler for DeliverTelegram {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let text = ctx
                .payload()
                .get("text")
                .and_then(|text| text.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                // Permanent: no retry produces a `text` the enqueue never wrote.
                return Err(HandlerError::Permanent(anyhow!(
                    "deliver.telegram: payload.text is missing or empty"
                )));
            }
            // Plain unless the caller asked otherwise, because that is the safe direction: the
            // sender escapes plain text, and an unbalanced `*` in Markdown makes Telegram reject
            // the whole message — which is how a reply once vanished into `delivered = false`.
            let markup = ctx
                .payload()
                .get("markup")
                .and_then(|markup| markup.as_str())
                .unwrap_or("plain");

            let message = if markup == "telegram" {
                Message::telegram_markup(text)
            } else {
                Message::plain(text)
            }
            .with_buttons(crate::jobs::notify::buttons_of(ctx.payload()));

            // A box with no channels configured is the ordinary state of a fresh install. Recorded
            // as a completed step rather than a failure, so it does not put a row in the failed
            // list every time anything tries to talk.
            if !self.channels.can_send() {
                ctx.once("sent", || async {
                    Ok(json!({ "delivered": false, "reason": "no channel is configured" }))
                })
                .await?;
                return Ok(());
            }

            // One step per channel, keyed by its name.
            //
            // `Channels::send` cannot be used here. It returns one verdict for every channel, so
            // with a single `"sent"` effect the handler had two options and both were wrong:
            // report success when only some channels took the message — losing the others with
            // nothing but a `tracing::warn` — or report failure and have the retry re-send to the
            // channel that already succeeded. A Discord outage went silent that way.
            //
            // `ctx.once` only records a step that returned `Ok`, so a channel that failed is the
            // only one the retry attempts. That makes delivery exactly-once *per channel* using
            // `job_effects` exactly as it already is — the key is the handler's to choose, and
            // choosing the channel name is the whole fix. No schema change.
            let mut failures: Vec<(&'static str, anyhow::Error)> = Vec::new();
            for sender in self.channels.each() {
                let name = sender.name();
                let outcome = ctx
                    .once(&format!("sent:{name}"), || async {
                        match sender.send(&message).await {
                            Delivery::Sent => Ok(json!({ "delivered": true })),
                            // `from_env` drops unconfigured senders, so this should be
                            // unreachable; treating it as a completed non-delivery keeps it from
                            // retrying forever if it ever is reached.
                            Delivery::NotConfigured => Ok(json!({
                                "delivered": false,
                                "reason": "not configured"
                            })),
                            // Retryable: a router reboot or somebody else's 500, which is the
                            // whole reason the send is a job.
                            Delivery::Failed(error) => Err(anyhow!("{}", error.message())),
                        }
                    })
                    .await;

                // Every channel is attempted before anything is reported. Returning on the first
                // failure would mean a broken Discord stopped Telegram from being tried at all,
                // which is the same class of bug in the opposite direction.
                if let Err(error) = outcome {
                    failures.push((name, error));
                }
            }

            match failures.len() {
                0 => Ok(()),
                // Named, so `last_error` on the settings page says *which* channel is failing
                // rather than that something did.
                _ => Err(HandlerError::Retry(anyhow!(
                    "{}",
                    failures
                        .iter()
                        .map(|(name, error)| format!("{name}: {error}"))
                        .collect::<Vec<_>>()
                        .join("; ")
                ))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_alerts::channels::testing::ScriptedSender;
    use lyra_db::jobs::{Lane, NewJob, Queue, SqliteQueue, Status};
    use std::sync::Arc;
    use std::sync::atomic::Ordering;
    use tempfile::TempDir;

    use crate::jobs::{Handlers, Worker};

    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, SqliteQueue::new(pool))
    }

    fn worker(queue: SqliteQueue, now: i64) -> Worker {
        worker_with(queue, now, Channels::new(vec![]))
    }

    fn worker_with(queue: SqliteQueue, now: i64, channels: Channels) -> Worker {
        Worker::new(
            queue,
            Arc::new(Handlers::new().with(Arc::new(DeliverTelegram::new(channels)))),
            "deliver-0",
            vec![Lane::Deliver],
        )
        .clock(Arc::new(move || now))
    }

    /// The rule the old code could not honour: one channel failing must not lose the message for
    /// that channel, and must not re-send it to the channel that already took it.
    #[tokio::test]
    async fn a_retry_sends_only_to_the_channel_that_did_not_take_it() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "health factor 1.05" })),
                1000,
            )
            .await
            .unwrap()
            .id;

        // Pass one: Telegram takes it, Discord does not.
        {
            let good = ScriptedSender::sending("telegram");
            let bad = ScriptedSender::failing("discord", "503 from discord");
            let (good_sends, bad_sends) = (good.counter(), bad.counter());
            let channels = Channels::new(vec![Box::new(good), Box::new(bad)]);
            assert!(worker_with(queue.clone(), 1000, channels).tick().await);

            assert_eq!(good_sends.load(Ordering::SeqCst), 1);
            assert_eq!(bad_sends.load(Ordering::SeqCst), 1);

            let job = queue.get(&id).await.unwrap().unwrap();
            assert_eq!(job.status, Status::Queued, "still owed to one channel");
            assert!(
                job.last_error.as_deref().unwrap().contains("discord"),
                "the error names which channel failed: {:?}",
                job.last_error
            );
            assert_eq!(
                queue.recall(&id, "sent:telegram").await.unwrap().unwrap()["delivered"],
                serde_json::json!(true)
            );
            assert!(
                queue.recall(&id, "sent:discord").await.unwrap().is_none(),
                "a failed channel records nothing, which is what makes the retry try it again"
            );
        }

        // Pass two, past the backoff. Fresh senders, so the counts are only this attempt's.
        {
            let good = ScriptedSender::sending("telegram");
            let recovered = ScriptedSender::sending("discord");
            let (good_sends, recovered_sends) = (good.counter(), recovered.counter());
            let channels = Channels::new(vec![Box::new(good), Box::new(recovered)]);
            assert!(worker_with(queue.clone(), 9000, channels).tick().await);

            assert_eq!(
                good_sends.load(Ordering::SeqCst),
                0,
                "Telegram already took it — sending again would be the duplicate this design exists to avoid"
            );
            assert_eq!(
                recovered_sends.load(Ordering::SeqCst),
                1,
                "Discord is the only one still owed it"
            );
            assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);
        }
    }

    /// Every channel is attempted even when an earlier one fails.
    ///
    /// Returning on the first failure would mean a broken Discord stopped Telegram from being tried
    /// at all — the same silent loss in the opposite direction.
    #[tokio::test]
    async fn a_failing_channel_does_not_stop_the_others_being_tried() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "fees ready" })),
                1000,
            )
            .await
            .unwrap()
            .id;

        // The broken one first, so a short-circuit would skip the good one.
        let broken = ScriptedSender::failing("discord", "401 unauthorized");
        let good = ScriptedSender::sending("telegram");
        let (broken_sends, good_sends) = (broken.counter(), good.counter());
        let channels = Channels::new(vec![Box::new(broken), Box::new(good)]);
        assert!(worker_with(queue.clone(), 1000, channels).tick().await);

        assert_eq!(broken_sends.load(Ordering::SeqCst), 1);
        assert_eq!(
            good_sends.load(Ordering::SeqCst),
            1,
            "the good channel must still have been attempted"
        );
        assert_eq!(
            queue.recall(&id, "sent:telegram").await.unwrap().unwrap()["delivered"],
            serde_json::json!(true)
        );
    }

    /// Both channels taking it is the ordinary case, and it finishes.
    #[tokio::test]
    async fn a_message_every_channel_takes_is_done_with_an_effect_each() {
        let (_dir, queue) = fresh().await;
        let a = ScriptedSender::sending("telegram");
        let b = ScriptedSender::sending("discord");

        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "done" })),
                1000,
            )
            .await
            .unwrap()
            .id;

        let channels = Channels::new(vec![Box::new(a), Box::new(b)]);
        assert!(worker_with(queue.clone(), 1000, channels).tick().await);

        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);
        for key in ["sent:telegram", "sent:discord"] {
            assert_eq!(
                queue.recall(&id, key).await.unwrap().unwrap()["delivered"],
                serde_json::json!(true),
                "{key} should be recorded"
            );
        }
        // The old single flag is gone, so nothing reads it by accident.
        assert!(queue.recall(&id, "sent").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_message_with_no_text_is_never_retried() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "   " })),
                1000,
            )
            .await
            .unwrap()
            .id;

        assert!(worker(queue.clone(), 1000).tick().await);
        let job = queue.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, Status::Failed);
        assert_eq!(job.attempts, 1);
        assert!(job.last_error.unwrap().contains("payload.text"));
    }

    /// An unconfigured box is not a broken one. The job finishes, and the row says why nothing
    /// went out — rather than five attempts and a failure on every alert the box ever tries.
    #[tokio::test]
    async fn with_no_channel_configured_the_job_finishes_and_records_why() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "net worth is up" })),
                1000,
            )
            .await
            .unwrap()
            .id;

        assert!(worker(queue.clone(), 1000).tick().await);
        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);

        let effect = queue.recall(&id, "sent").await.unwrap().unwrap();
        assert_eq!(effect["delivered"], serde_json::json!(false));
        assert_eq!(
            effect["reason"],
            serde_json::json!("no channel is configured")
        );
    }

    /// The property that makes a reclaim safe: a job that already sent does not send again, even
    /// though the handler runs a second time.
    #[tokio::test]
    async fn a_job_that_already_sent_does_not_send_again() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver)
                    .payload(serde_json::json!({ "text": "only once" })),
                1000,
            )
            .await
            .unwrap()
            .id;

        // The first run's record, as the reclaimed attempt would find it.
        queue
            .remember(&id, "sent", &serde_json::json!({ "delivered": true }), 1000)
            .await
            .unwrap();

        assert!(worker(queue.clone(), 1000).tick().await);
        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);
        assert_eq!(
            queue.recall(&id, "sent").await.unwrap().unwrap()["delivered"],
            serde_json::json!(true),
            "the first answer stands; the unconfigured send never ran"
        );
    }
}
