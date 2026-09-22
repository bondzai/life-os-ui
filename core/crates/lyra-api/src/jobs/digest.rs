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
use lyra_alerts::state::AlertStore;

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;
use crate::wealth::{self, DigestOutcome};

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
/// The backoff is 10s doubling to a 900s cap, so the cumulative span runs
/// 10, 30, 70, 150, 310, 630, 1270, 2170, 3070, 3970, 4870, **5770**. Twelve attempts is a little
/// over an hour and a half of trying: it comfortably outlasts the hour the loop was confined to,
/// and it still ends, so a permanently broken channel dead-letters instead of retrying forever.
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

            // Built here rather than held on the struct: `from_env` reads the environment, and a
            // token rotated while the box is up should take effect on the next brief.
            let channels = Channels::from_env(&ProcessEnv);
            if !channels.can_send() {
                return Err(HandlerError::Permanent(anyhow!(
                    "no channel is configured, so there is nowhere to send the brief"
                )));
            }

            // `deliver_digest` owns building *and* sending, and it is left that way on purpose: it
            // advances the delta snapshot only after a successful send, so a brief nobody received
            // does not consume the changes it would have shown. Splitting build from send would
            // put that rule on the wrong side of a retry.
            match wealth::deliver_digest(&self.state, &channels).await {
                Ok(DigestOutcome::Sent) => {
                    // The day is stamped by the handler, not the tick, so the flag and the send
                    // cannot disagree — there is no window where one happened and not the other.
                    AlertStore::new(&self.state.pool)
                        .set_digest_day(&day, wealth::now_secs())
                        .await
                        .map_err(|e| HandlerError::Retry(anyhow!("stamping the digest day: {e}")))?;
                    Ok(())
                }
                // Reachable and refused. The world, not the job.
                Ok(DigestOutcome::Refused) => Err(HandlerError::Retry(anyhow!("the channel refused the brief"))),
                // Retryable, and this is the interesting case. "Nothing to report" at 08:00 is
                // almost always an upstream that flaked, not a portfolio that vanished, and the
                // loop version retried it every tick for exactly this reason. Five attempts with
                // backoff is that same intent, no longer stopping at the top of the hour.
                Ok(DigestOutcome::Nothing(why)) => {
                    Err(HandlerError::Retry(anyhow!("nothing to send yet: {why}")))
                }
                Err(e) => Err(HandlerError::Retry(e)),
            }
        })
    }
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
            let enqueued = q.enqueue(&brief("2026-09-21"), 1000 + tick * 30).await.unwrap();
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
                .fail("w", &claimed.id, "the channel refused the brief", lyra_db::jobs::Failure::Retry, now)
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
        let claimed = q.claim("w", &[Lane::Batch], 60, 1_100).await.unwrap().unwrap();
        q.fail("w", &claimed.id, "refused", lyra_db::jobs::Failure::Retry, 1_200)
            .await
            .unwrap();
        assert_eq!(q.get(&first.id).await.unwrap().unwrap().status, Status::Failed);

        let again = q.enqueue(&brief("2026-09-21"), 5_000).await.unwrap();
        assert!(again.created, "a dead brief must not block asking for it again");
    }

    #[tokio::test]
    async fn a_sent_brief_blocks_a_second_one_for_the_rest_of_the_day() {
        // The other half of the rule. Two briefs in one morning is the failure everyone notices.
        let (_dir, q) = fresh().await;
        let first = q.enqueue(&brief("2026-09-21"), 1_000).await.unwrap();
        let claimed = q.claim("w", &[Lane::Batch], 60, 1_100).await.unwrap().unwrap();
        q.complete("w", &claimed.id, &[], 1_200).await.unwrap();

        let again = q.enqueue(&brief("2026-09-21"), 20_000).await.unwrap();
        assert!(!again.created, "a delivered brief must not be sent twice");
        assert_eq!(again.id, first.id);
    }

    #[tokio::test]
    async fn a_payload_with_no_day_fails_permanently_rather_than_retrying() {
        // The payload is written at enqueue and never changes, so retrying cannot grow a `day`.
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let state = crate::AppState::new(pool, "test-secret".into());
        let handler = DailyDigest::new(state.clone());

        let queue = SqliteQueue::new(state.pool.clone());
        let enqueued = queue
            .enqueue(&NewJob::new(KIND, Lane::Batch), 1_000)
            .await
            .unwrap();
        let claimed = queue.claim("w", &[Lane::Batch], 60, 1_100).await.unwrap().unwrap();
        assert_eq!(claimed.id, enqueued.id);

        let ctx = crate::jobs::JobCtx::for_test(queue, claimed, "w".into(), 1_100);
        let error = handler.run(&ctx).await.expect_err("it must not succeed");
        assert!(
            matches!(error, HandlerError::Permanent(_)),
            "a malformed payload is the job being wrong, not the world: {error}"
        );
    }
}
