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
    fn as_str(self) -> &'static str {
        match self {
            Markup::Plain => "plain",
            Markup::Telegram => "telegram",
        }
    }
}

/// A message to send, as a job. The one way to build one.
pub fn job(text: impl Into<String>, markup: Markup) -> NewJob {
    NewJob::new(KIND, Lane::Deliver)
        .payload(json!({ "text": text.into(), "markup": markup.as_str() }))
}

/// Sends a job's `payload.text` to every configured channel.
///
/// Named for Telegram because that is the channel anyone is waiting on, but it goes through
/// [`Channels`], so a box with Discord configured gets both — "delivered" means delivered
/// *somewhere*, which is the rule the alert path already follows.
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

            let channels = Arc::clone(&self.channels);
            ctx.once("sent", || async move {
                let message = if markup == "telegram" {
                    Message::telegram_markup(text)
                } else {
                    Message::plain(text)
                };
                match channels.send(&message).await {
                    Delivery::Sent => Ok(json!({ "delivered": true })),
                    // Not a failure. A box with no channels configured is the ordinary state of a
                    // fresh install, and retrying five times would only turn that into a row in
                    // the failed list every time anything tries to talk.
                    Delivery::NotConfigured => Ok(json!({
                        "delivered": false,
                        "reason": "no channel is configured"
                    })),
                    // Retryable: this is a router reboot or somebody else's 500, and it is the
                    // whole reason the send is a job.
                    Delivery::Failed(error) => Err(anyhow!("{}", error.message())),
                }
            })
            .await?;

            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Lane, NewJob, Queue, SqliteQueue, Status};
    use std::sync::Arc;
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
        Worker::new(
            queue,
            Arc::new(Handlers::new().with(Arc::new(DeliverTelegram::new(Channels::new(vec![]))))),
            "deliver-0",
            vec![Lane::Deliver],
        )
        .clock(Arc::new(move || now))
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
