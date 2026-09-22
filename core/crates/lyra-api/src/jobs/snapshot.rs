//! `snapshot.networth` — one point on the net-worth series, as a job.
//!
//! The sample itself was never broken: `maybe_snapshot` checks the interval before it reads
//! anything, and a failure is logged. What it has no answer for is a *failure*. The read is minutes
//! of upstream calls across several chains and an exchange, and when one of those is having a bad
//! afternoon the point is simply missing — the next attempt is a whole interval away, so a
//! thirty-second outage costs four hours of series.
//!
//! As a job it retries. Not for long — see [`ATTEMPTS`] — because a missed sample is one gap in a
//! chart rather than a message nobody received, and the work behind it is expensive enough that
//! retrying hard is its own problem.
//!
//! # Why the key is a bucket and not a timestamp
//!
//! The tick keeps its interval check, which reads `last_snapshot_ts` — and that only moves when a
//! sample is *recorded*. So between enqueueing a job and that job finishing, every tick still
//! believes a sample is due and enqueues again. Keyed by the bucket (`now / interval`), all of
//! those are one job. The interval check preserves the *spacing* between samples; the key removes
//! the duplicates inside one window. Neither does the other's work.


use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;
use crate::alert_loop;

/// The job kind. A wire contract: renaming it strands whatever is already queued.
pub const KIND: &str = "snapshot.networth";

/// How many attempts a sample gets.
///
/// Fewer than the brief's twelve, deliberately. The digest is one message a day that somebody is
/// waiting for, so it is worth an hour and a half of trying. A sample is one point in a series
/// several hours long: missing it leaves a gap a reader will not notice, and each attempt is a full
/// portfolio read across several chains. Six attempts spans about ten minutes — long enough to ride
/// out the blip that costs a point today, short enough that a bad afternoon upstream does not turn
/// into an hour of hammering it.
pub const ATTEMPTS: i64 = 6;

// The two budgets encode different judgements — a brief is a message somebody is waiting for, a
// sample is one point in a chart — and must not drift into each other. Checked at compile time,
// so the build fails rather than a test run.
const _: () = assert!(
    ATTEMPTS < crate::jobs::digest::ATTEMPTS,
    "a net-worth sample must not try harder than the daily brief"
);

/// Keyed by the interval bucket, so every tick inside one window means the same job.
pub fn key_for(bucket: i64) -> String {
    format!("{KIND}:{bucket}")
}

/// One sample for the window `now` falls in, as a job. The one way to build it.
pub fn job(group: &str, interval: i64, now: i64) -> lyra_db::jobs::NewJob {
    lyra_db::jobs::NewJob::new(KIND, lyra_db::jobs::Lane::Batch)
        .payload(serde_json::json!({ "group": group, "interval": interval }))
        .key(key_for(now / interval.max(1)))
        .max_attempts(ATTEMPTS)
}

pub struct NetWorthSnapshot {
    state: AppState,
}

impl NetWorthSnapshot {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for NetWorthSnapshot {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let group = ctx.require_str("group")?;
            // The interval is stored on the point, so a reader can tell a four-hourly series from
            // an hourly one. Carried in the payload rather than re-read from config: the sample
            // belongs to the window that asked for it, even if the setting changed since.
            let interval = ctx.require_i64("interval")?;

            // A failure is recorded for the settings page by the worker, for every kind — see
            // `Worker::reporting_to`. Handlers only say what went wrong.
            alert_loop::take_snapshot(&self.state, group, interval)
                .await
                .map_err(HandlerError::Retry)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Lane, NewJob, Queue, SqliteQueue};
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, SqliteQueue::new(pool))
    }

    fn sample(bucket: i64) -> NewJob {
        NewJob::new(KIND, Lane::Batch)
            .payload(serde_json::json!({ "group": "server", "interval": 14_400 }))
            .key(key_for(bucket))
            .max_attempts(ATTEMPTS)
    }

    #[test]
    fn the_bucket_is_the_window_not_the_moment() {
        // Two ticks 30s apart inside a four-hour window must land in the same bucket, or the key
        // dedupes nothing and the series grows a point per tick.
        let interval = 14_400;
        assert_eq!(1_000_000 / interval, 1_000_030 / interval);
        assert_ne!(key_for(1_000_000 / interval), key_for(1_014_401 / interval));
    }

    #[tokio::test]
    async fn every_tick_inside_one_window_is_the_same_job() {
        // The case the key exists for: `last_snapshot_ts` does not move until the job *records* a
        // point, so until then every tick believes a sample is due.
        let (_dir, q) = fresh().await;
        let mut ids = std::collections::BTreeSet::new();
        for tick in 0..40 {
            ids.insert(q.enqueue(&sample(7), 1000 + tick * 30).await.unwrap().id);
        }
        assert_eq!(ids.len(), 1, "40 ticks inside one window must be one sample");
    }

    #[tokio::test]
    async fn the_next_window_is_a_new_sample() {
        let (_dir, q) = fresh().await;
        let first = q.enqueue(&sample(7), 1000).await.unwrap();
        let next = q.enqueue(&sample(8), 20_000).await.unwrap();
        assert!(first.created && next.created);
        assert_ne!(first.id, next.id);
    }

    #[tokio::test]
    async fn a_payload_missing_its_group_fails_permanently() {
        // Retrying cannot grow a field: the payload is written at enqueue and never changes.
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        let state = crate::AppState::new(pool, "test-secret".into());
        let queue = SqliteQueue::new(state.pool.clone());

        queue
            .enqueue(&NewJob::new(KIND, Lane::Batch), 1000)
            .await
            .unwrap();
        let claimed = queue.claim("w", &[Lane::Batch], 60, 1100).await.unwrap().unwrap();
        let ctx = JobCtx::for_test(queue, claimed, "w".into(), 1100);

        let error = NetWorthSnapshot::new(state)
            .run(&ctx)
            .await
            .expect_err("a sample with no group cannot be taken");
        assert!(matches!(error, HandlerError::Permanent(_)), "got {error}");
    }
}
