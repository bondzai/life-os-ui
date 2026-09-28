//! `digest.daily` — the morning brief, as a job that survives the hour it was due in.
//!
//! # What was actually wrong, and what was not
//!
//! The loop version is more careful than it looks, and an earlier note in this codebase was wrong
//! about it. `maybe_digest` stamps the day key **only on a delivered brief**, and that is
//! deliberate: it means a Telegram blip at 08:00 retries on the next tick, so a short outage costs
//! nothing at all. Anyone reading "the key is only written on success" as the bug had it backwards
//! — that is the retry.
//!
//! The real limitation is narrower and it is the hour. `digest_due` gates on
//! `digest_hour == Some(now_hour)`, so the retrying stops when the clock leaves 08:00. An outage
//! that outlasts the hour loses the day, silently, and the only trace is a `delivered = false`.
//!
//! As a job that stops being true. The tick enqueues under `digest.daily:<day>`, and the partial
//! unique index on `idempotency_key` means calling it every thirty seconds all hour produces
//! exactly **one** job — the index *is* the "have I already done today" flag, which is a fact the
//! database keeps rather than a variable this code has to remember. The job's own backoff then
//! climbs across the hour boundary, because a job does not know what time it was created.
//!
//! And because a job that exhausts its attempts releases its key, a digest that genuinely could
//! not be sent can be asked for again — rather than being blocked until the pruner forgets it.

use anyhow::anyhow;
use lyra_alerts::channels::Channels;
use lyra_alerts::config::ProcessEnv;
use lyra_alerts::message::Message;
use lyra_alerts::state::AlertStore;
use lyra_alerts::telegram::Delivery;
use lyra_db::channels::{ChannelStore, Severity};
use serde_json::{Value as JsonValue, json};

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;
use crate::wealth;

/// The job kind. A wire contract: renaming it strands whatever is already queued.
pub const KIND: &str = "digest.daily";

/// One brief a day, keyed by the day.
///
/// The day is the *caller's* idea of today, not this handler's. `day_key` is process-local, and if
/// the box runs UTC while the user does not, "today" here and "today" on the phone disagree for
/// part of every day — so whoever knows the answer says it, and this carries it.
pub fn key_for(day: &str) -> String {
    format!("{KIND}:{day}")
}

/// How many attempts the brief gets, and why it is not the default five.
///
/// **This number is the whole point of moving the digest onto the queue, and getting it wrong makes
/// the change a regression.** The loop retried on every 30-second tick for the length of the digest
/// hour — 120 attempts across 3600 seconds — and then stopped dead at the top of the hour. Five
/// attempts at the default backoff spans about 150 seconds, so a naive move would have turned "one
/// hour of trying" into "two and a half minutes of trying", which is worse in every case anyone
/// cares about.
///
/// The backoff is 10s doubling to a 900s cap. Twelve attempts means **eleven** waits, not twelve —
/// `fail` dead-letters on the last attempt instead of scheduling another one — so the cumulative
/// span runs 10, 30, 70, 150, 310, 630, 1270, 2170, 3070, 3970, **4870**: a little over eighty
/// minutes. It comfortably outlasts the hour the loop was confined to, and it still ends, so a
/// permanently broken channel dead-letters instead of retrying forever.
///
/// (This list previously ran one entry further, to 5770, by counting a wait after the final
/// attempt. The off-by-one did not change behaviour, only what the comment promised.)
pub const ATTEMPTS: i64 = 12;

/// Today's brief, as a job — kind, lane, key and attempt budget in one place.
///
/// The one way to build it. Every enqueue site used to assemble these four separately, and the
/// attempt count in particular is the one whose omission makes the queue a regression rather than
/// a fix; a builder is where it cannot be forgotten.
pub fn job(day: &str) -> lyra_db::jobs::NewJob {
    lyra_db::jobs::NewJob::new(KIND, lyra_db::jobs::Lane::Batch)
        .payload(serde_json::json!({ "day": day }))
        .key(key_for(day))
        .max_attempts(ATTEMPTS)
}

pub struct DailyDigest {
    state: AppState,
}

impl DailyDigest {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for DailyDigest {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            // A job with no day is a job that cannot stamp anything, and retrying will not grow
            // one — `require_str` makes that permanent rather than five identical failures.
            let day = ctx.require_str("day")?.to_string();

            // Built once and remembered, then delivered per channel.
            //
            // `ctx.once` is what makes the split safe. Building used to be fused to sending
            // precisely so the delta baseline could not advance for a brief nobody received — and
            // that reasoning was right about the risk and wrong about the remedy. Recording the
            // built text as a step means a retry an hour later sends **the brief that was built at
            // 08:00**, rather than rebuilding it against a portfolio that has since moved. The
            // baseline still advances only after somebody has taken it; see below.
            let built = ctx
                .once("built", || async {
                    match wealth::build_digest(&self.state).await {
                        Ok(wealth::DigestBuild::Ready(built)) => Ok(json!({
                            "text": built.text,
                            "snapshot": built.snapshot,
                        })),
                        // "Nothing to report" at 08:00 is almost always an upstream that flaked, not
                        // a portfolio that vanished, and the loop version retried it every tick for
                        // exactly this reason. Not recorded, so the next attempt builds again.
                        Ok(wealth::DigestBuild::Nothing(why)) => {
                            Err(anyhow!("nothing to send yet: {why}"))
                        }
                        Err(e) => Err(e),
                    }
                })
                .await
                .map_err(HandlerError::Retry)?;

            let text = built
                .get("text")
                .and_then(|t| t.as_str())
                .ok_or_else(|| HandlerError::Retry(anyhow!("the built brief has no text")))?
                .to_string();
            let snapshot = built.get("snapshot").cloned().unwrap_or(JsonValue::Null);
            let message = Message::telegram_markup(text.clone());

            // Where it goes. The `day` group at `info`, or — while nothing is routed — every
            // configured channel, which is where the brief has always gone. Same transitional
            // fallback as `notify`, and for the same reason: a box that has not been to Settings
            // yet must not quietly stop receiving its morning brief.
            let store = ChannelStore::new(
                self.state.pool.clone(),
                self.state.secret_key.as_deref().cloned(),
            );
            let hour = i64::from(chrono::Timelike::hour(&chrono::Local::now()));
            let routed = store
                .destinations("day", Severity::Info, hour)
                .await
                .unwrap_or_default();

            let mut delivered = false;
            let mut failures: Vec<String> = Vec::new();

            if routed.is_empty() {
                let channels = Channels::from_env(&ProcessEnv);
                if !channels.can_send() {
                    return Err(HandlerError::Permanent(anyhow!(
                        "no channel is configured, so there is nowhere to send the brief"
                    )));
                }
                for sender in channels.each() {
                    match send_once(ctx, sender.name(), sender, &message).await {
                        Ok(()) => delivered = true,
                        Err(e) => failures.push(format!("{}: {e}", sender.name())),
                    }
                }
            } else {
                for channel_id in &routed {
                    match sender_for_channel(&store, channel_id).await {
                        Ok(sender) => {
                            match send_once(ctx, channel_id, sender.as_ref(), &message).await {
                                Ok(()) => {
                                    delivered = true;
                                    let _ =
                                        store.record_success(channel_id, wealth::now_secs()).await;
                                }
                                Err(e) => {
                                    let _ = store
                                        .record_failure(
                                            channel_id,
                                            &format!("{e}"),
                                            wealth::now_secs(),
                                        )
                                        .await;
                                    failures.push(format!("{channel_id}: {e}"));
                                }
                            }
                        }
                        Err(why) => failures.push(format!("{channel_id}: {why}")),
                    }
                }
            }

            // Advanced when **somebody** has it, which is exactly the old rule. Not "everybody": a
            // brief that reached the phone has done its job, and holding the baseline back because a
            // second channel is down would show tomorrow's reader two days of deltas as if they were
            // one.
            if delivered {
                ctx.once("advanced", || async {
                    wealth::advance_digest_snapshot(&self.state, &snapshot).await;
                    // The day is stamped here too, so the flag and the send cannot disagree — there
                    // is no window where one happened and not the other.
                    AlertStore::new(&self.state.pool)
                        .set_digest_day(&day, wealth::now_secs())
                        .await
                        .map(|_| json!({ "advanced": true }))
                        .map_err(|e| anyhow!("stamping the digest day: {e}"))
                })
                .await
                .map_err(HandlerError::Retry)?;
            }

            match (delivered, failures.is_empty()) {
                // Everyone took it.
                (true, true) => Ok(()),
                // Somebody took it and somebody did not: the brief is out, and the channels still
                // owed it keep their own retry. Returning `Ok` here would abandon them.
                (_, false) => Err(HandlerError::Retry(anyhow!("{}", failures.join("; ")))),
                // Nobody took it and nobody reported why, which should not happen.
                (false, true) => Err(HandlerError::Retry(anyhow!(
                    "the brief reached no channel and none said why"
                ))),
            }
        })
    }
}

/// One channel's send, recorded so a retry does not repeat it.
///
/// Keyed by the channel, which is what makes a partial delivery resumable: the channel that took the
/// brief is skipped on the next attempt, and only the one that failed is tried again.
async fn send_once(
    ctx: &JobCtx,
    key: &str,
    sender: &dyn lyra_alerts::telegram::MessageSender,
    message: &Message,
) -> anyhow::Result<()> {
    ctx.once(&format!("sent:{key}"), || async {
        match sender.send(message).await {
            Delivery::Sent => Ok(json!({ "delivered": true })),
            Delivery::NotConfigured => {
                Ok(json!({ "delivered": false, "reason": "not configured" }))
            }
            Delivery::Failed(e) => Err(anyhow!("{}", e.message())),
        }
    })
    .await
    .map(|_| ())
}

/// Build a sender for a stored channel, unsealing its credential.
async fn sender_for_channel(
    store: &ChannelStore,
    channel_id: &str,
) -> anyhow::Result<Box<dyn lyra_alerts::telegram::MessageSender>> {
    let channel = store
        .get(channel_id)
        .await?
        .ok_or_else(|| anyhow!("no such channel"))?;
    if !channel.enabled {
        anyhow::bail!("the channel is disabled");
    }
    let transport = lyra_alerts::channels::Transport::parse(&channel.transport)
        .ok_or_else(|| anyhow!("unknown transport {:?}", channel.transport))?;
    let secret = store.secret_of(channel_id).await?;
    crate::notify::sender_for(transport, secret.as_deref()).map_err(|why| anyhow!("{why}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Lane, NewJob, Queue, SqliteQueue, Status};
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, SqliteQueue::new(pool))
    }

    fn brief(day: &str) -> NewJob {
        job(day)
    }

    #[test]
    fn the_key_names_the_day_and_nothing_else() {
        // A key that carried the hour, or the minute, would let a second brief through — which is
        // the whole failure the key exists to prevent.
        assert_eq!(key_for("2026-09-21"), "digest.daily:2026-09-21");
        assert_ne!(key_for("2026-09-21"), key_for("2026-09-22"));
    }

    #[tokio::test]
    async fn an_hour_of_ticks_queues_exactly_one_brief() {
        // The tick runs every 30 seconds. Across the digest hour that is 120 enqueues, and the
        // partial unique index is what makes them one job — the index *is* the "have I already
        // done today" flag, rather than a variable this code has to keep in step.
        let (_dir, q) = fresh().await;
        let mut ids = std::collections::BTreeSet::new();
        for tick in 0..120 {
            let enqueued = q
                .enqueue(&brief("2026-09-21"), 1000 + tick * 30)
                .await
                .unwrap();
            ids.insert(enqueued.id);
        }
        assert_eq!(ids.len(), 1, "120 ticks must produce one job");
    }

    #[tokio::test]
    async fn tomorrow_is_a_different_brief() {
        let (_dir, q) = fresh().await;
        let today = q.enqueue(&brief("2026-09-21"), 1000).await.unwrap();
        let tomorrow = q.enqueue(&brief("2026-09-22"), 90_000).await.unwrap();
        assert!(today.created && tomorrow.created);
        assert_ne!(today.id, tomorrow.id);
    }

    #[tokio::test]
    async fn a_refused_brief_is_still_trying_after_the_hour_has_passed() {
        // The point of the whole change. The loop retried on every tick but only while the clock
        // was inside the digest hour; a job does not know what time it was created, so its backoff
        // carries straight past 09:00.
        let (_dir, q) = fresh().await;
        let queued = q.enqueue(&brief("2026-09-21"), 1_000).await.unwrap();

        let mut now = 1_100;
        let mut attempts = 0;
        loop {
            let Some(claimed) = q.claim("w", &[Lane::Batch], 60, now).await.unwrap() else {
                // Backed off past `now`. Jump to when it is next runnable.
                let job = q.get(&queued.id).await.unwrap().unwrap();
                if job.status != Status::Queued {
                    break;
                }
                now = job.run_at;
                continue;
            };
            attempts += 1;
            let status = q
                .fail(
                    "w",
                    &claimed.id,
                    "the channel refused the brief",
                    lyra_db::jobs::Failure::Retry,
                    now,
                )
                .await
                .unwrap();
            if status == Some(Status::Failed) {
                break;
            }
            now += 1;
        }

        assert_eq!(attempts, ATTEMPTS, "every attempt must be spent");
        assert!(
            now - 1_000 > 3_600,
            "the trying must outlast the digest hour the loop was confined to; spanned {}s",
            now - 1_000
        );
    }

    #[tokio::test]
    async fn a_brief_that_never_sent_can_be_asked_for_again() {
        // Because a dead job releases its key. Without that, a digest that exhausted its attempts
        // would be un-re-requestable until the pruner forgot it two weeks later.
        let (_dir, q) = fresh().await;
        let first = q
            .enqueue(&brief("2026-09-21").max_attempts(1), 1_000)
            .await
            .unwrap();
        let claimed = q
            .claim("w", &[Lane::Batch], 60, 1_100)
            .await
            .unwrap()
            .unwrap();
        q.fail(
            "w",
            &claimed.id,
            "refused",
            lyra_db::jobs::Failure::Retry,
            1_200,
        )
        .await
        .unwrap();
        assert_eq!(
            q.get(&first.id).await.unwrap().unwrap().status,
            Status::Failed
        );

        let again = q.enqueue(&brief("2026-09-21"), 5_000).await.unwrap();
        assert!(
            again.created,
            "a dead brief must not block asking for it again"
        );
    }

    #[tokio::test]
    async fn a_sent_brief_blocks_a_second_one_for_the_rest_of_the_day() {
        // The other half of the rule. Two briefs in one morning is the failure everyone notices.
        let (_dir, q) = fresh().await;
        let first = q.enqueue(&brief("2026-09-21"), 1_000).await.unwrap();
        let claimed = q
            .claim("w", &[Lane::Batch], 60, 1_100)
            .await
            .unwrap()
            .unwrap();
        q.complete("w", &claimed.id, &[], 1_200).await.unwrap();

        let again = q.enqueue(&brief("2026-09-21"), 20_000).await.unwrap();
        assert!(!again.created, "a delivered brief must not be sent twice");
        assert_eq!(again.id, first.id);
    }

    #[tokio::test]
    async fn a_payload_with_no_day_fails_permanently_rather_than_retrying() {
        // The payload is written at enqueue and never changes, so retrying cannot grow a `day`.
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state = crate::AppState::new(pool, "test-secret".into());
        let handler = DailyDigest::new(state.clone());

        let queue = SqliteQueue::new(state.pool.clone());
        let enqueued = queue
            .enqueue(&NewJob::new(KIND, Lane::Batch), 1_000)
            .await
            .unwrap();
        let claimed = queue
            .claim("w", &[Lane::Batch], 60, 1_100)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, enqueued.id);

        let ctx = crate::jobs::JobCtx::for_test(queue, claimed, "w".into(), 1_100);
        let error = handler.run(&ctx).await.expect_err("it must not succeed");
        assert!(
            matches!(error, HandlerError::Permanent(_)),
            "a malformed payload is the job being wrong, not the world: {error}"
        );
    }
}
