//! The durable job queue — one table, one claim statement, and a lease.
//!
//! Everything background in this binary used to be a poll loop with the work item held in a local
//! variable: `alert_loop` sweeps, `tgbot` answers, and whatever either of them was half-way
//! through when the process died is gone. That is survivable while the work is a read. It stops
//! being survivable the moment a piece of work *writes* — a captured note, a sent message, a
//! completed task — because then "did it happen?" has no answer anywhere.
//!
//! This module makes a piece of work a row. The schema is owned by [`crate::migrations`] (v5→v6);
//! nothing here creates or alters a table.
//!
//! # The claim is one statement, on purpose
//!
//! The sharpest SQLite fact in this design: **`busy_timeout` does not save a deferred transaction
//! that starts as a reader and then tries to upgrade.** A `BEGIN` that runs a `SELECT` first takes
//! a read lock; when the following `UPDATE` asks to upgrade and another connection already holds
//! the write lock, SQLite returns `SQLITE_BUSY` *immediately* rather than waiting — because
//! waiting could only deadlock, both sides holding a read lock and wanting a write. So the obvious
//! `SELECT` a job, then `UPDATE` it inside `BEGIN` is **less** reliable under contention than no
//! transaction at all.
//!
//! [`SqliteQueue::claim`] is therefore a single `UPDATE … WHERE id = (SELECT … LIMIT 1)
//! RETURNING …` in autocommit. It takes the write lock from its first instruction, so the busy
//! timeout applies the whole way through, and the subquery is re-evaluated under that lock — two
//! workers racing cannot both see the same row as queued. Where a claim must be atomic with
//! something else (see [`SqliteQueue::complete`]), the rule is `BEGIN IMMEDIATE`, never bare
//! `BEGIN`, for exactly the same reason.
//!
//! # A lease, not a flag
//!
//! A job is claimed *until a time*. The holder renews while it works; a lease that stops being
//! renewed is reclaimable by [`SqliteQueue::reap`]. This is the only mechanism that tells a hard
//! kill apart from slow work, and it is the only path by which an interrupted job ever runs again.
//! Every terminal write is guarded by `worker = ?`, so a process that was reaped and then comes
//! back to life — a paused VM, a long GC, a laptop lid — cannot complete a job that now belongs to
//! someone else. Its `complete()` returns `false` and it is expected to drop the work.
//!
//! # Delivery is at least once
//!
//! That is what a lease buys, and it is not negotiable: a worker can always die in the window
//! between doing a thing and recording that it did. [`SqliteQueue::remember`] and `job_effects`
//! narrow that window to the width of one `INSERT`; they do not close it. A handler whose effect
//! is genuinely unrepeatable needs an idempotency key at the *far* end, not a better queue.

use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::types::JsonValue;
use sqlx::{AssertSqlSafe, Row, SqliteConnection, SqlitePool};

use crate::wealth::new_id;

/// How many times a job is attempted before it is set aside as failed.
///
/// Five, with the backoff below, spans **150 seconds** — four waits of 10, 20, 40 and 80. Long
/// enough to ride out a Telegram blip, and deliberately short: anything that needs to outlast a
/// router reboot sets its own budget, which is what `digest::ATTEMPTS` does and why it exists.
///
/// (This said "about twenty minutes" for a while, which is not a number this backoff can produce at
/// five attempts. Worth being exact: a handler author reading it as twenty minutes would pick this
/// default for work that needs twenty minutes, and get two and a half.)
pub const DEFAULT_MAX_ATTEMPTS: i64 = 5;

/// How long a claim is good for before the reaper may take it back.
///
/// Comfortably longer than any handler should run without a heartbeat, and short enough that a
/// hard kill costs less than a minute of latency.
pub const DEFAULT_LEASE_SECS: i64 = 60;

/// First retry delay. Doubles per attempt up to [`BACKOFF_CAP_SECS`].
const BACKOFF_BASE_SECS: i64 = 10;

/// The ceiling on the retry delay.
const BACKOFF_CAP_SECS: i64 = 900;

/// How long a reaped job waits before it may be claimed again.
///
/// Deliberately small: a lease expires because a worker *died*, which is usually the process
/// restarting, not the job being wrong — and the point of the queue is that the work resumes. The
/// delay exists only so a job that kills its worker every time cannot spin the machine; it is
/// bounded anyway, because every claim burns an attempt and `max_attempts` ends it.
const REAP_DELAY_SECS: i64 = 5;

/// Every column of `jobs`, in the order [`row_to_job`] reads them.
const COLUMNS: &str = "id, kind, lane, payload, status, priority, run_at, attempts, max_attempts, \
                       idempotency_key, worker, leased_until, last_error, parent_id, created_at, \
                       updated_at, finished_at";

/// Which pool of workers a job belongs to.
///
/// Lanes exist to stop one kind of work starving another: a ten-minute batch job must not be able
/// to sit in front of the reply someone is waiting for on their phone. They are *not* priorities —
/// `priority` orders work within a lane — they are separate queues with separate workers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    /// Someone is waiting. Short work only.
    Interactive,
    /// Nobody is waiting. Sweeps, digests, imports.
    Batch,
    /// Outbound messages. Separated from `Interactive` because a Telegram outage retries for
    /// minutes, and it must not occupy a worker that answers commands.
    Deliver,
}

impl Lane {
    pub const fn as_str(self) -> &'static str {
        match self {
            Lane::Interactive => "interactive",
            Lane::Batch => "batch",
            Lane::Deliver => "deliver",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "interactive" => Some(Lane::Interactive),
            "batch" => Some(Lane::Batch),
            "deliver" => Some(Lane::Deliver),
            _ => None,
        }
    }
}

/// Where a job is in its life.
///
/// `Done`, `Failed` and `Cancelled` are terminal: nothing moves out of them, and `finished_at` is
/// set exactly once on the way in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Queued,
    Running,
    Done,
    /// Out of attempts, or rejected by its handler as unrunnable. The row stays, so it can be
    /// read, understood and retried by hand.
    Failed,
    Cancelled,
}

impl Status {
    pub const fn as_str(self) -> &'static str {
        match self {
            Status::Queued => "queued",
            Status::Running => "running",
            Status::Done => "done",
            Status::Failed => "failed",
            Status::Cancelled => "cancelled",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "queued" => Some(Status::Queued),
            "running" => Some(Status::Running),
            "done" => Some(Status::Done),
            "failed" => Some(Status::Failed),
            "cancelled" => Some(Status::Cancelled),
            _ => None,
        }
    }

    pub const fn is_terminal(self) -> bool {
        matches!(self, Status::Done | Status::Failed | Status::Cancelled)
    }
}

/// A job that has not been written yet.
#[derive(Debug, Clone)]
pub struct NewJob {
    pub kind: String,
    pub lane: Lane,
    pub payload: JsonValue,
    pub priority: i64,
    /// Epoch seconds. `None` means "as soon as a worker is free".
    pub run_at: Option<i64>,
    pub max_attempts: i64,
    /// The dedup key. Two enqueues with the same key produce one job — which is how
    /// `digest.daily:2026-09-21` can be enqueued by a tick that runs every thirty seconds and
    /// still send one brief. The unique index *is* the "did I already do this today" flag.
    pub idempotency_key: Option<String>,
    /// The job that enqueued this one, for tracing a chain back to what started it.
    pub parent_id: Option<String>,
}

impl NewJob {
    pub fn new(kind: impl Into<String>, lane: Lane) -> Self {
        Self {
            kind: kind.into(),
            lane,
            payload: JsonValue::Null,
            priority: 0,
            run_at: None,
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            idempotency_key: None,
            parent_id: None,
        }
    }

    pub fn payload(mut self, payload: JsonValue) -> Self {
        self.payload = payload;
        self
    }

    pub fn priority(mut self, priority: i64) -> Self {
        self.priority = priority;
        self
    }

    /// Not before `run_at` (epoch seconds).
    pub fn at(mut self, run_at: i64) -> Self {
        self.run_at = Some(run_at);
        self
    }

    pub fn max_attempts(mut self, max_attempts: i64) -> Self {
        self.max_attempts = max_attempts.max(1);
        self
    }

    pub fn key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }

    pub fn child_of(mut self, parent_id: impl Into<String>) -> Self {
        self.parent_id = Some(parent_id.into());
        self
    }
}

/// A job as it is stored.
#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub lane: Lane,
    pub payload: JsonValue,
    pub status: Status,
    pub priority: i64,
    pub run_at: i64,
    /// Incremented by the **claim**, not by the handler — so a worker that dies without reporting
    /// anything still burns an attempt, and a job that kills its worker every time terminates.
    pub attempts: i64,
    pub max_attempts: i64,
    pub idempotency_key: Option<String>,
    pub worker: Option<String>,
    pub leased_until: Option<i64>,
    pub last_error: Option<String>,
    pub parent_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

/// The result of an enqueue.
///
/// `created == false` means an identical key was already queued and this call did nothing. That is
/// a success, not a conflict: it is the whole point of the key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enqueued {
    pub id: String,
    pub created: bool,
}

/// Why a handler gave up, which decides whether the job runs again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// The world was wrong: a network blip, a locked row, a service down. Back off and retry.
    Retry,
    /// The job was wrong: no handler, an unparseable payload, an argument that can never validate.
    /// Retrying cannot change the outcome, so it is set aside immediately with its attempts
    /// unspent — the log says why instead of five identical lines saying it again.
    Permanent,
}

/// What a retry did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Retried {
    /// A new job, carrying the old one's work.
    Queued(Enqueued),
    /// Nothing to retry: the job is still queued, running, or finished well.
    NotRetryable(Status),
    NotFound,
}

/// What one reaper tick recovered.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Reaped {
    /// Leases that expired and went back on the queue.
    pub requeued: u64,
    /// Leases that expired with no attempts left. These are the hard ones: a job that takes its
    /// worker down with it never reports a failure, so this counter is the only place it appears.
    pub dead_lettered: u64,
}

/// The three numbers that later decide whether SQLite is still the right answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct QueueAge {
    pub queued: i64,
    pub running: i64,
    pub failed: i64,
    /// How long the oldest *runnable* job has been waiting, in seconds. A job scheduled for
    /// tomorrow is not a backlog, so a future `run_at` is not counted — this number answers "are
    /// the workers keeping up", and nothing else.
    pub oldest_queued_secs: Option<i64>,
}

/// How long to wait before attempt `attempts + 1`.
///
/// Exponential from [`BACKOFF_BASE_SECS`], capped. No jitter: jitter exists to break up a thundering
/// herd of independent clients, and this queue has one process and four workers. Adding randomness
/// here would only make the tests harder to write.
pub fn backoff_secs(attempts: i64) -> i64 {
    let step = attempts.clamp(1, 16) - 1;
    BACKOFF_BASE_SECS
        .saturating_mul(1i64 << step)
        .min(BACKOFF_CAP_SECS)
}

/// Epoch seconds now. Every method takes `now` explicitly so tests can pin the clock — the reaper
/// in particular is untestable against a real one.
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The operations a worker needs, whatever is on the other side of them.
///
/// A trait rather than a concrete type because of where this goes next: the moment a worker must
/// live in another process — a model worker that can OOM, or a second machine — the same calls are
/// served over HTTP against the same SQL. Writing the worker against the trait now means that
/// change touches one impl instead of every loop.
pub trait Queue {
    fn enqueue(&self, job: &NewJob, now: i64) -> impl Future<Output = Result<Enqueued>> + Send;

    /// Take the oldest runnable job in one of `lanes`, or `None` if there is nothing to do.
    fn claim(
        &self,
        worker: &str,
        lanes: &[Lane],
        lease_secs: i64,
        now: i64,
    ) -> impl Future<Output = Result<Option<Job>>> + Send;

    /// Extend the lease. `false` means the lease was lost — the job now belongs to someone else
    /// and this worker must stop touching it.
    fn heartbeat(
        &self,
        worker: &str,
        id: &str,
        lease_secs: i64,
        now: i64,
    ) -> impl Future<Output = Result<bool>> + Send;

    /// Finish a job and enqueue whatever it produced, in **one commit**.
    ///
    /// `false` means the lease was lost before the work was recorded, in which case nothing is
    /// written and no follow-up is enqueued.
    fn complete(
        &self,
        worker: &str,
        id: &str,
        follow_ups: &[NewJob],
        now: i64,
    ) -> impl Future<Output = Result<bool>> + Send;

    /// Record a failure. `None` means the lease was lost and the failure was discarded; otherwise
    /// the status the job landed in.
    fn fail(
        &self,
        worker: &str,
        id: &str,
        error: &str,
        failure: Failure,
        now: i64,
    ) -> impl Future<Output = Result<Option<Status>>> + Send;

    /// Reclaim every expired lease.
    fn reap(&self, now: i64) -> impl Future<Output = Result<Reaped>> + Send;

    /// Delete terminal jobs that finished before `cutoff`, and their effects.
    fn prune(&self, cutoff: i64) -> impl Future<Output = Result<u64>> + Send;

    fn age(&self, now: i64) -> impl Future<Output = Result<QueueAge>> + Send;

    /// The most recently touched jobs, newest first.
    ///
    /// For a human looking at a queue, which is a different question from anything a worker asks:
    /// ordered by `updated_at` rather than by `run_at` or priority, because "what just happened"
    /// is what you open a queue page to find out.
    fn recent(&self, limit: usize) -> impl Future<Output = Result<Vec<Job>>> + Send;

    fn get(&self, id: &str) -> impl Future<Output = Result<Option<Job>>> + Send;

    /// Take a queued job off the queue. A running job is left alone: cancelling it would mean
    /// lying to whoever holds the lease, and they will finish or lose it soon enough.
    fn cancel(&self, id: &str, now: i64) -> impl Future<Output = Result<bool>> + Send;

    /// Ask for a finished-badly job's work again. See [`SqliteQueue::retry`] for why this is a
    /// new row and not a resurrected one.
    fn retry(&self, id: &str, now: i64) -> impl Future<Output = Result<Retried>> + Send;

    /// What `key` produced the first time, or `None` if it has not run.
    fn recall(
        &self,
        job_id: &str,
        key: &str,
    ) -> impl Future<Output = Result<Option<JsonValue>>> + Send;

    /// Record what `key` produced, and return what is stored — which is the *first* writer's
    /// value, not necessarily this one's. Two workers overlapping on one job is exactly the window
    /// a lease cannot close, and in that window both must agree on the answer.
    fn remember(
        &self,
        job_id: &str,
        key: &str,
        value: &JsonValue,
        now: i64,
    ) -> impl Future<Output = Result<JsonValue>> + Send;
}

/// The queue, in the one SQLite file everything else lives in.
///
/// That co-location is the reason this is not Redis: "mark the task done and enqueue the reply" is
/// one commit here, and a transactional outbox with a page of machinery anywhere else.
#[derive(Debug, Clone)]
pub struct SqliteQueue {
    pool: SqlitePool,
}

impl SqliteQueue {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

impl Queue for SqliteQueue {
    async fn enqueue(&self, job: &NewJob, now: i64) -> Result<Enqueued> {
        let mut conn = self
            .pool
            .acquire()
            .await
            .context("enqueue: no connection")?;
        insert(&mut conn, job, now).await
    }

    async fn claim(
        &self,
        worker: &str,
        lanes: &[Lane],
        lease_secs: i64,
        now: i64,
    ) -> Result<Option<Job>> {
        if lanes.is_empty() {
            return Ok(None);
        }

        // `AssertSqlSafe` is sound here: `lanes` is a list of a closed enum's `as_str`, so the
        // only thing interpolated is one of three literals written in this file.
        let list = lanes
            .iter()
            .map(|lane| format!("'{}'", lane.as_str()))
            .collect::<Vec<_>>()
            .join(", ");

        // THE CLAIM. One statement, autocommit — see the module docs for why a transaction here
        // would be worse. `status = 'queued'` is spelled out rather than bound so the partial
        // index applies; the subquery is re-evaluated under the write lock this UPDATE already
        // holds, which is what makes two workers racing resolve to one winner and one `None`.
        let sql = format!(
            "UPDATE jobs
                SET status       = 'running',
                    worker       = ?,
                    leased_until = ?,
                    attempts     = attempts + 1,
                    updated_at   = ?
              WHERE id = (SELECT id FROM jobs
                           WHERE status = 'queued'
                             AND run_at <= ?
                             AND lane IN ({list})
                           ORDER BY priority DESC, run_at, created_at, id
                           LIMIT 1)
          RETURNING {COLUMNS}"
        );

        let row = sqlx::query(AssertSqlSafe(sql))
            .bind(worker)
            .bind(now + lease_secs.max(1))
            .bind(now)
            .bind(now)
            .fetch_optional(&self.pool)
            .await
            .context("claiming a job")?;

        row.map(row_to_job).transpose()
    }

    async fn heartbeat(&self, worker: &str, id: &str, lease_secs: i64, now: i64) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE jobs SET leased_until = ?, updated_at = ?
              WHERE id = ? AND worker = ? AND status = 'running'",
        )
        .bind(now + lease_secs.max(1))
        .bind(now)
        .bind(id)
        .bind(worker)
        .execute(&self.pool)
        .await
        .context("heartbeating a job")?;

        Ok(result.rows_affected() == 1)
    }

    async fn complete(
        &self,
        worker: &str,
        id: &str,
        follow_ups: &[NewJob],
        now: i64,
    ) -> Result<bool> {
        // `BEGIN IMMEDIATE`, never bare `BEGIN`: this transaction writes from its first statement,
        // and a deferred one would start as a reader and be refused the upgrade without waiting.
        let mut tx = self
            .pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .context("opening the completion transaction")?;

        let result = sqlx::query(
            "UPDATE jobs SET status = 'done', worker = NULL, leased_until = NULL,
                             finished_at = ?, updated_at = ?
              WHERE id = ? AND worker = ? AND status = 'running'",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .bind(worker)
        .execute(&mut *tx)
        .await
        .context("completing a job")?;

        if result.rows_affected() != 1 {
            // Someone else owns this job now — almost always because the reaper took it while
            // this worker was paused. Rolling back is what keeps the follow-ups from being
            // enqueued twice when the new holder finishes the same work.
            return Ok(false);
        }

        for follow_up in follow_ups {
            insert(&mut tx, follow_up, now)
                .await
                .with_context(|| format!("enqueueing the follow-up {}", follow_up.kind))?;
        }

        tx.commit().await.context("committing the completion")?;
        Ok(true)
    }

    async fn fail(
        &self,
        worker: &str,
        id: &str,
        error: &str,
        failure: Failure,
        now: i64,
    ) -> Result<Option<Status>> {
        // Read first so the backoff is computed from the row's own attempt count rather than from
        // whatever the caller remembers. Safe without a transaction: only the lease holder may
        // write this row, and the UPDATE below re-checks that it still is.
        let Some(job) = self.get(id).await? else {
            return Ok(None);
        };

        let exhausted = matches!(failure, Failure::Permanent) || job.attempts >= job.max_attempts;
        let (status, run_at, finished_at) = if exhausted {
            (Status::Failed, job.run_at, Some(now))
        } else {
            (Status::Queued, now + backoff_secs(job.attempts), None)
        };

        // The key is released on the way into `failed`, and only there.
        //
        // An idempotency key answers "has this work already been done?", and a job that exhausted
        // its attempts has emphatically not done it. Holding the key anyway meant the retry — a
        // scheduler re-tick, a button, the user simply asking again — hit `ON CONFLICT DO NOTHING`
        // and got back `created: false` and the id of the corpse. The work vanished, and the
        // caller was told everything was fine, for the fourteen days until the pruner forgot it.
        //
        // `done` deliberately keeps its key: that is the case the key exists for, and a
        // date-scoped `digest:2026-09-21` should stay claimed once the digest has gone out.
        let result = sqlx::query(
            "UPDATE jobs SET status = ?, run_at = ?, finished_at = ?, last_error = ?,
                             worker = NULL, leased_until = NULL, updated_at = ?,
                             idempotency_key = CASE WHEN ? = 'failed' THEN NULL ELSE idempotency_key END
              WHERE id = ? AND worker = ? AND status = 'running'",
        )
        .bind(status.as_str())
        .bind(run_at)
        .bind(finished_at)
        .bind(truncate(error))
        .bind(now)
        .bind(status.as_str())
        .bind(id)
        .bind(worker)
        .execute(&self.pool)
        .await
        .context("failing a job")?;

        Ok((result.rows_affected() == 1).then_some(status))
    }

    async fn reap(&self, now: i64) -> Result<Reaped> {
        // Order matters. The exhausted ones are set aside first, so the requeue below — which has
        // no attempts predicate of its own — cannot pick them back up.
        //
        // Two autocommit statements rather than one transaction: each is idempotent, and a crash
        // between them leaves work the next tick does. A transaction would buy an atomicity
        // nothing here can observe.
        let dead = sqlx::query(
            "UPDATE jobs SET status = 'failed', worker = NULL, leased_until = NULL,
                             finished_at = ?, updated_at = ?, idempotency_key = NULL,
                             last_error = 'lease expired with no attempts left: the worker did not survive this job'
              WHERE status = 'running' AND leased_until < ? AND attempts >= max_attempts",
        )
        .bind(now)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("dead-lettering expired leases")?;

        let requeued = sqlx::query(
            "UPDATE jobs SET status = 'queued', worker = NULL, leased_until = NULL,
                             run_at = ?, updated_at = ?,
                             last_error = 'lease expired: reclaimed from a worker that stopped reporting'
              WHERE status = 'running' AND leased_until < ?",
        )
        .bind(now + REAP_DELAY_SECS)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("requeueing expired leases")?;

        Ok(Reaped {
            requeued: requeued.rows_affected(),
            dead_lettered: dead.rows_affected(),
        })
    }

    async fn prune(&self, cutoff: i64) -> Result<u64> {
        let result = sqlx::query(
            "DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < ?
               AND status IN ('done', 'failed', 'cancelled')",
        )
        .bind(cutoff)
        .execute(&self.pool)
        .await
        .context("pruning finished jobs")?;

        Ok(result.rows_affected())
    }

    async fn recent(&self, limit: usize) -> Result<Vec<Job>> {
        // Clamped, because this is reachable from an HTTP query parameter and an unbounded LIMIT
        // read by a page that refreshes is a way to make your own box slow.
        let limit = limit.clamp(1, 200);
        let rows = sqlx::query(AssertSqlSafe(format!(
            "SELECT {COLUMNS} FROM jobs ORDER BY updated_at DESC, id DESC LIMIT {limit}"
        )))
        .fetch_all(&self.pool)
        .await
        .context("listing recent jobs")?;
        rows.into_iter().map(row_to_job).collect()
    }

    async fn age(&self, now: i64) -> Result<QueueAge> {
        let row = sqlx::query(
            "SELECT
               SUM(status = 'queued')                                    AS queued,
               SUM(status = 'running')                                   AS running,
               SUM(status = 'failed')                                    AS failed,
               MIN(CASE WHEN status = 'queued' AND run_at <= ? THEN run_at END) AS oldest
             FROM jobs",
        )
        .bind(now)
        .fetch_one(&self.pool)
        .await
        .context("reading the queue age")?;

        Ok(QueueAge {
            queued: row
                .try_get::<Option<i64>, _>("queued")
                .ok()
                .flatten()
                .unwrap_or(0),
            running: row
                .try_get::<Option<i64>, _>("running")
                .ok()
                .flatten()
                .unwrap_or(0),
            failed: row
                .try_get::<Option<i64>, _>("failed")
                .ok()
                .flatten()
                .unwrap_or(0),
            oldest_queued_secs: row
                .try_get::<Option<i64>, _>("oldest")
                .ok()
                .flatten()
                .map(|oldest| (now - oldest).max(0)),
        })
    }

    async fn get(&self, id: &str) -> Result<Option<Job>> {
        let sql = format!("SELECT {COLUMNS} FROM jobs WHERE id = ?");
        let row = sqlx::query(AssertSqlSafe(sql))
            .bind(id)
            .fetch_optional(&self.pool)
            .await
            .context("reading a job")?;
        row.map(row_to_job).transpose()
    }

    async fn cancel(&self, id: &str, now: i64) -> Result<bool> {
        let result = sqlx::query(
            "UPDATE jobs SET status = 'cancelled', finished_at = ?, updated_at = ?,
                             idempotency_key = NULL
              WHERE id = ? AND status = 'queued'",
        )
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("cancelling a job")?;

        Ok(result.rows_affected() == 1)
    }

    /// Retry by **copying**, not by resetting the failed row.
    ///
    /// Resetting would be the obvious build and it destroys the one thing a dead job is kept for:
    /// its `last_error`, its attempt count, the fact that it happened at all. A retry that
    /// overwrote the row would make "why did this fail on Tuesday" unanswerable by Wednesday.
    ///
    /// Note that `prune` gives `done`, `failed` and `cancelled` the **same** cutoff — a dead row is
    /// evidence for exactly as long as a successful one, not longer. Keeping failures around longer
    /// would be reasonable; it is simply not what the code does today.
    ///
    /// So the copy carries the work — kind, lane, payload, priority, attempt budget — and points
    /// back at the original through `parent_id`. It is keyed `retry:<original id>`, so a button
    /// pressed twice, or a `/retry` sent twice from a phone on a bad connection, is one retry.
    ///
    /// **It does not inherit the original's idempotency key**, because there is none left to
    /// inherit: a failed job releases its key on the way into `failed`. The one consequence worth
    /// knowing is the digest — retrying a dead brief *during* the digest hour can race the tick's
    /// own enqueue and send it twice. Outside that hour it cannot.
    async fn retry(&self, id: &str, now: i64) -> Result<Retried> {
        let Some(job) = self.get(id).await? else {
            return Ok(Retried::NotFound);
        };
        if !matches!(job.status, Status::Failed | Status::Cancelled) {
            return Ok(Retried::NotRetryable(job.status));
        }

        let copy = NewJob::new(job.kind.clone(), job.lane)
            .payload(job.payload.clone())
            .priority(job.priority)
            .max_attempts(job.max_attempts)
            .key(format!("retry:{}", job.id))
            .child_of(job.id.clone());
        Ok(Retried::Queued(self.enqueue(&copy, now).await?))
    }

    async fn recall(&self, job_id: &str, key: &str) -> Result<Option<JsonValue>> {
        let row = sqlx::query("SELECT value_json FROM job_effects WHERE job_id = ? AND key = ?")
            .bind(job_id)
            .bind(key)
            .fetch_optional(&self.pool)
            .await
            .context("reading a job effect")?;

        let Some(row) = row else { return Ok(None) };
        let raw: Option<String> = row.try_get("value_json").unwrap_or(None);
        Ok(Some(
            raw.and_then(|raw| raw.parse::<JsonValue>().ok())
                .unwrap_or(JsonValue::Null),
        ))
    }

    async fn remember(
        &self,
        job_id: &str,
        key: &str,
        value: &JsonValue,
        now: i64,
    ) -> Result<JsonValue> {
        // `DO NOTHING` rather than an upsert: the first answer is the true one. A retry that
        // reaches here has, by definition, redone something that was already done, and the record
        // of what the original run produced is worth more than this run's version of it.
        sqlx::query(
            "INSERT INTO job_effects (job_id, key, value_json, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(job_id, key) DO NOTHING",
        )
        .bind(job_id)
        .bind(key)
        .bind(value.to_string())
        .bind(now)
        .execute(&self.pool)
        .await
        .context("recording a job effect")?;

        Ok(self.recall(job_id, key).await?.unwrap_or(JsonValue::Null))
    }
}

/// Insert one job, honouring its idempotency key, on any connection — including one inside a
/// transaction, which is what makes "finish this job and enqueue the next" a single commit.
async fn insert(conn: &mut SqliteConnection, job: &NewJob, now: i64) -> Result<Enqueued> {
    let id = new_id();
    // `ON CONFLICT(idempotency_key) DO NOTHING` **does not parse** against the partial unique
    // index: the conflict target has to repeat the index's predicate verbatim, or SQLite cannot
    // tell which index is meant and reports "ON CONFLICT clause does not match any PRIMARY KEY or
    // UNIQUE constraint". Review does not catch this; only running it does.
    let inserted: Option<String> = sqlx::query_scalar(
        "INSERT INTO jobs (id, kind, lane, payload, status, priority, run_at, attempts,
                           max_attempts, idempotency_key, parent_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'queued', ?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id",
    )
    .bind(&id)
    .bind(&job.kind)
    .bind(job.lane.as_str())
    .bind(job.payload.to_string())
    .bind(job.priority)
    .bind(job.run_at.unwrap_or(now))
    .bind(job.max_attempts.max(1))
    .bind(job.idempotency_key.as_deref())
    .bind(job.parent_id.as_deref())
    .bind(now)
    .bind(now)
    .fetch_optional(&mut *conn)
    .await
    .with_context(|| format!("enqueueing {}", job.kind))?;

    if let Some(id) = inserted {
        return Ok(Enqueued { id, created: true });
    }

    // The key was already taken. Hand back the job that holds it, so the caller can watch the one
    // that is really going to run rather than a job id that does not exist.
    let existing: Option<String> =
        sqlx::query_scalar("SELECT id FROM jobs WHERE idempotency_key = ?")
            .bind(job.idempotency_key.as_deref())
            .fetch_optional(&mut *conn)
            .await
            .context("reading the job that already holds this key")?;

    match existing {
        Some(id) => Ok(Enqueued { id, created: false }),
        // The holder was pruned between the two statements. Vanishingly rare, and reporting it as
        // an error beats inventing an id that is not there.
        None => anyhow::bail!(
            "enqueueing {}: the idempotency key was taken and then released",
            job.kind
        ),
    }
}

fn row_to_job(row: sqlx::sqlite::SqliteRow) -> Result<Job> {
    let id: String = row.try_get("id").context("a job row without an id")?;
    let lane: String = row.try_get("lane").unwrap_or_default();
    let status: String = row.try_get("status").unwrap_or_default();
    let payload: String = row.try_get("payload").unwrap_or_default();

    Ok(Job {
        // A lane or status that does not parse can only come from a newer binary having written
        // this row. Refusing the row is better than guessing: a job silently reclassified as
        // `Batch` would run on the wrong worker for reasons nobody could trace.
        lane: Lane::parse(&lane)
            .with_context(|| format!("job {id} has an unknown lane {lane:?}"))?,
        status: Status::parse(&status)
            .with_context(|| format!("job {id} has an unknown status {status:?}"))?,
        // The payload is the handler's problem: a blob that no longer parses reads as `null` and
        // the handler rejects it by name, which says far more than "a job failed to load".
        payload: payload.parse::<JsonValue>().unwrap_or(JsonValue::Null),
        id,
        kind: row.try_get("kind").unwrap_or_default(),
        priority: row.try_get("priority").unwrap_or(0),
        run_at: row.try_get("run_at").unwrap_or(0),
        attempts: row.try_get("attempts").unwrap_or(0),
        max_attempts: row.try_get("max_attempts").unwrap_or(DEFAULT_MAX_ATTEMPTS),
        idempotency_key: row.try_get("idempotency_key").unwrap_or(None),
        worker: row.try_get("worker").unwrap_or(None),
        leased_until: row.try_get("leased_until").unwrap_or(None),
        last_error: row.try_get("last_error").unwrap_or(None),
        parent_id: row.try_get("parent_id").unwrap_or(None),
        created_at: row.try_get("created_at").unwrap_or(0),
        updated_at: row.try_get("updated_at").unwrap_or(0),
        finished_at: row.try_get("finished_at").unwrap_or(None),
    })
}

/// Error text is for reading, not for storage. A handler that hands back a megabyte of provider
/// HTML should not put a megabyte in every row of `/jobs`.
fn truncate(error: &str) -> String {
    const MAX: usize = 500;
    if error.len() <= MAX {
        return error.to_string();
    }
    let mut end = MAX;
    while end > 0 && !error.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &error[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::types::JsonValue as J;
    use std::collections::HashSet;
    use std::sync::Arc;
    use tempfile::TempDir;

    /// A real file, not `:memory:`. WAL, the busy timeout and the write lock are the whole subject
    /// of these tests, and an in-memory database has none of them the same way.
    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, SqliteQueue::new(pool))
    }

    fn job(kind: &str) -> NewJob {
        NewJob::new(kind, Lane::Interactive)
    }

    #[tokio::test]
    async fn a_claimed_job_is_leased_to_one_worker_and_no_one_else_sees_it() {
        let (_dir, q) = fresh().await;
        q.enqueue(&job("test.one"), 1000).await.unwrap();

        let claimed = q
            .claim("worker-a", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .expect("the queued job should be claimable");
        assert_eq!(claimed.status, Status::Running);
        assert_eq!(claimed.worker.as_deref(), Some("worker-a"));
        assert_eq!(claimed.leased_until, Some(1060));
        assert_eq!(
            claimed.attempts, 1,
            "the claim burns the attempt, not the handler"
        );

        assert!(
            q.claim("worker-b", &[Lane::Interactive], 60, 1000)
                .await
                .unwrap()
                .is_none(),
            "a leased job must not be claimable twice"
        );
    }

    #[tokio::test]
    async fn a_job_is_not_claimable_before_its_run_at() {
        let (_dir, q) = fresh().await;
        q.enqueue(&job("test.later").at(2000), 1000).await.unwrap();

        assert!(
            q.claim("w", &[Lane::Interactive], 60, 1999)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            q.claim("w", &[Lane::Interactive], 60, 2000)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn a_worker_only_claims_the_lanes_it_was_given() {
        let (_dir, q) = fresh().await;
        q.enqueue(&NewJob::new("test.batch", Lane::Batch), 1000)
            .await
            .unwrap();

        assert!(
            q.claim("w", &[Lane::Interactive, Lane::Deliver], 60, 1000)
                .await
                .unwrap()
                .is_none()
        );
        let claimed = q
            .claim("w", &[Lane::Batch], 60, 1000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.lane, Lane::Batch);
    }

    #[tokio::test]
    async fn priority_orders_work_inside_a_lane_and_age_breaks_the_tie() {
        let (_dir, q) = fresh().await;
        q.enqueue(&job("test.old"), 1000).await.unwrap();
        q.enqueue(&job("test.new"), 1001).await.unwrap();
        q.enqueue(&job("test.urgent").priority(10), 1002)
            .await
            .unwrap();

        let order: Vec<String> = {
            let mut seen = Vec::new();
            for _ in 0..3 {
                seen.push(
                    q.claim("w", &[Lane::Interactive], 60, 1100)
                        .await
                        .unwrap()
                        .unwrap()
                        .kind,
                );
            }
            seen
        };
        assert_eq!(order, vec!["test.urgent", "test.old", "test.new"]);
    }

    /// The landmine: `ON CONFLICT(idempotency_key) DO NOTHING` is a parse error against a *partial*
    /// unique index unless the conflict target repeats the index's `WHERE`. Nothing but running it
    /// catches this.
    #[tokio::test]
    async fn recent_is_ordered_by_what_just_happened() {
        // `recent` answers a human's question, not a worker's: not what runs next, but what just
        // ran. So it is ordered by `updated_at`, which is the field every transition touches.
        let (_dir, q) = fresh().await;
        let first = q.enqueue(&job("one"), 1000).await.unwrap();
        let second = q.enqueue(&job("two"), 1001).await.unwrap();

        // Touch the older one, which should bring it to the front.
        let claimed = q
            .claim("w", &[Lane::Interactive], 60, 2000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, first.id, "priority order claims the first one");

        let recent = q.recent(10).await.unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].id, first.id, "the one that just moved leads");
        assert_eq!(recent[1].id, second.id);
    }

    #[tokio::test]
    async fn recent_clamps_a_limit_it_is_handed() {
        // Reachable from an HTTP query parameter, and an unbounded LIMIT on a page that refreshes
        // is a way to make your own box slow.
        let (_dir, q) = fresh().await;
        for n in 0..5 {
            q.enqueue(&job(&format!("k{n}")), 1000 + n).await.unwrap();
        }
        assert_eq!(
            q.recent(0).await.unwrap().len(),
            1,
            "zero is clamped up to one"
        );
        assert_eq!(
            q.recent(usize::MAX).await.unwrap().len(),
            5,
            "and huge is capped, not refused"
        );
    }

    #[tokio::test]
    async fn a_dead_job_releases_its_key_so_the_work_can_be_asked_for_again() {
        // The failure this closes is silent, which is what makes it expensive: the retry was
        // accepted, reported `created: false`, and did nothing, for the fourteen days until the
        // pruner forgot the corpse.
        let (_dir, q) = fresh().await;
        let first = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), 1000)
            .await
            .unwrap();
        assert!(first.created);

        // Burn every attempt.
        let mut now = 1100;
        loop {
            let claimed = q.claim("w", &[Lane::Interactive], 60, now).await.unwrap();
            let Some(claimed) = claimed else { break };
            let status = q
                .fail("w", &claimed.id, "telegram is down", Failure::Retry, now)
                .await
                .unwrap();
            now += 10_000;
            if status == Some(Status::Failed) {
                break;
            }
        }

        let dead = q.get(&first.id).await.unwrap().unwrap();
        assert_eq!(dead.status, Status::Failed, "the job must be dead-lettered");

        let retry = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), now)
            .await
            .unwrap();
        assert!(
            retry.created,
            "a job that failed has not done the work, so asking again must create a real job"
        );
        assert_ne!(
            retry.id, first.id,
            "and it must be a new job, not the id of the corpse"
        );
    }

    #[tokio::test]
    async fn a_reaped_dead_job_releases_its_key_too() {
        // The other road into `failed`: nobody called `fail`, the worker simply never came back.
        let (_dir, q) = fresh().await;
        let first = q
            .enqueue(
                &job("deliver.telegram")
                    .key("brief:2026-09-21")
                    .max_attempts(1),
                1000,
            )
            .await
            .unwrap();

        // One attempt allowed, so a single claim and an expired lease is the whole story: the
        // reaper finds a running job with nothing left to spend, and dead-letters it. Claiming in
        // a loop would not work — `claim` does not pick up a job that is still `running`, which is
        // the reaper's whole job.
        q.claim("w", &[Lane::Interactive], 60, 1100).await.unwrap();
        let now = 1100 + 10_000;
        q.reap(now).await.unwrap();

        assert_eq!(
            q.get(&first.id).await.unwrap().unwrap().status,
            Status::Failed
        );
        assert!(
            q.enqueue(&job("deliver.telegram").key("brief:2026-09-21"), now)
                .await
                .unwrap()
                .created,
            "the reaper's dead-letter must release the key as well as `fail` does"
        );
    }

    #[tokio::test]
    async fn a_finished_job_keeps_its_key() {
        // The other half of the rule, so the fix above cannot quietly become "keys never hold".
        // This is the case the key exists for: the digest went out, do not send it twice.
        let (_dir, q) = fresh().await;
        let first = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), 1000)
            .await
            .unwrap();
        let claimed = q
            .claim("w", &[Lane::Interactive], 60, 1100)
            .await
            .unwrap()
            .unwrap();
        q.complete("w", &claimed.id, &[], 1200).await.unwrap();

        let again = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), 1300)
            .await
            .unwrap();
        assert!(!again.created, "a completed job must still hold its key");
        assert_eq!(again.id, first.id);
    }

    #[tokio::test]
    async fn an_idempotency_key_collapses_repeat_enqueues_into_one_job() {
        let (_dir, q) = fresh().await;
        let first = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), 1000)
            .await
            .unwrap();
        let second = q
            .enqueue(&job("digest.daily").key("digest.daily:2026-09-21"), 1030)
            .await
            .unwrap();

        assert!(first.created);
        assert!(!second.created, "the second enqueue must not create a job");
        assert_eq!(
            first.id, second.id,
            "and it must point at the one that will run"
        );

        q.claim("w", &[Lane::Interactive], 60, 1100)
            .await
            .unwrap()
            .unwrap();
        assert!(
            q.claim("w", &[Lane::Interactive], 60, 1100)
                .await
                .unwrap()
                .is_none(),
            "one row, so one claim"
        );
    }

    #[tokio::test]
    async fn jobs_without_a_key_are_never_deduplicated_against_each_other() {
        // A NULL key is "do not dedup me". Without the partial index this would be the bug where
        // at most one un-keyed job can exist at a time.
        let (_dir, q) = fresh().await;
        for _ in 0..3 {
            assert!(q.enqueue(&job("capture.note"), 1000).await.unwrap().created);
        }
        let age = q.age(1000).await.unwrap();
        assert_eq!(age.queued, 3);
    }

    #[tokio::test]
    async fn completing_a_job_commits_its_follow_ups_with_it() {
        let (_dir, q) = fresh().await;
        let parent = q.enqueue(&job("ask.llm"), 1000).await.unwrap().id;
        q.claim("w", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .unwrap();

        let reply = NewJob::new("deliver.telegram", Lane::Deliver).child_of(&parent);
        assert!(q.complete("w", &parent, &[reply], 1010).await.unwrap());

        let done = q.get(&parent).await.unwrap().unwrap();
        assert_eq!(done.status, Status::Done);
        assert_eq!(done.finished_at, Some(1010));
        assert_eq!(done.worker, None, "a finished job holds no lease");

        let follow_up = q
            .claim("w", &[Lane::Deliver], 60, 1010)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(follow_up.kind, "deliver.telegram");
        assert_eq!(follow_up.parent_id.as_deref(), Some(parent.as_str()));
    }

    #[tokio::test]
    async fn a_failure_backs_off_and_the_last_one_is_set_aside() {
        let (_dir, q) = fresh().await;
        let id = q
            .enqueue(&job("test.flaky").max_attempts(2), 1000)
            .await
            .unwrap()
            .id;

        q.claim("w", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            q.fail("w", &id, "connection reset", Failure::Retry, 1005)
                .await
                .unwrap(),
            Some(Status::Queued)
        );
        let backed_off = q.get(&id).await.unwrap().unwrap();
        assert_eq!(backed_off.run_at, 1005 + backoff_secs(1));
        assert_eq!(backed_off.last_error.as_deref(), Some("connection reset"));
        assert!(
            backed_off.leased_until.is_none(),
            "a failed job holds no lease"
        );

        q.claim("w", &[Lane::Interactive], 60, 2000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            q.fail("w", &id, "connection reset", Failure::Retry, 2005)
                .await
                .unwrap(),
            Some(Status::Failed),
            "the last attempt is the one that stops"
        );
        assert!(
            q.claim("w", &[Lane::Interactive], 60, 9999)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn a_permanent_failure_does_not_spend_its_remaining_attempts() {
        let (_dir, q) = fresh().await;
        let id = q
            .enqueue(&job("test.unknown").max_attempts(5), 1000)
            .await
            .unwrap()
            .id;
        q.claim("w", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(
            q.fail("w", &id, "no handler registered", Failure::Permanent, 1001)
                .await
                .unwrap(),
            Some(Status::Failed)
        );
        let dead = q.get(&id).await.unwrap().unwrap();
        assert_eq!(
            dead.attempts, 1,
            "four attempts left, and none of them could help"
        );
        assert_eq!(dead.finished_at, Some(1001));
    }

    /// The path that is never exercised in normal operation, and the only recovery from a hard
    /// kill: a worker takes a job, dies without a word, and the job must come back to exactly one
    /// other worker — while the dead one's late completion is refused.
    #[tokio::test]
    async fn a_dead_workers_job_is_reclaimed_exactly_once_and_its_late_completion_is_refused() {
        let (_dir, q) = fresh().await;
        let id = q.enqueue(&job("capture.note"), 1000).await.unwrap().id;

        // Worker A claims a 30-second lease, and is killed. It never heartbeats and never reports.
        let claimed = q
            .claim("worker-a", &[Lane::Interactive], 30, 1000)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(claimed.id, id);

        // Before the lease expires the job is nobody else's.
        assert_eq!(q.reap(1029).await.unwrap(), Reaped::default());
        assert!(
            q.claim("worker-b", &[Lane::Interactive], 30, 1029)
                .await
                .unwrap()
                .is_none()
        );

        // After it expires, exactly one reap reclaims it — and a second reap finds nothing, which
        // is what "exactly once" means for a tick that runs every thirty seconds forever.
        assert_eq!(
            q.reap(1031).await.unwrap(),
            Reaped {
                requeued: 1,
                dead_lettered: 0
            }
        );
        assert_eq!(q.reap(1032).await.unwrap(), Reaped::default());

        let requeued = q.get(&id).await.unwrap().unwrap();
        assert_eq!(requeued.status, Status::Queued);
        assert_eq!(requeued.worker, None);
        assert_eq!(
            requeued.attempts, 1,
            "the dead worker's attempt is still spent"
        );

        // Worker B takes it. Only B.
        let b = q
            .claim("worker-b", &[Lane::Interactive], 30, 1040)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(b.id, id);
        assert_eq!(b.attempts, 2);
        assert!(
            q.claim("worker-c", &[Lane::Interactive], 30, 1040)
                .await
                .unwrap()
                .is_none()
        );

        // Worker A comes back from the dead — a paused VM, a stalled network call returning at
        // last — and tries to finish the job it no longer holds. Every terminal write is guarded
        // by `worker = ?`, so it is refused without touching the row.
        assert!(!q.complete("worker-a", &id, &[], 1041).await.unwrap());
        assert!(!q.heartbeat("worker-a", &id, 30, 1041).await.unwrap());
        assert_eq!(
            q.fail("worker-a", &id, "late failure", Failure::Retry, 1041)
                .await
                .unwrap(),
            None
        );
        let still_bs = q.get(&id).await.unwrap().unwrap();
        assert_eq!(still_bs.status, Status::Running);
        assert_eq!(still_bs.worker.as_deref(), Some("worker-b"));

        // And B finishes it. One job, two claims, one completion.
        assert!(q.complete("worker-b", &id, &[], 1050).await.unwrap());
        assert_eq!(q.get(&id).await.unwrap().unwrap().status, Status::Done);
    }

    #[tokio::test]
    async fn a_heartbeat_holds_the_lease_off_the_reaper() {
        let (_dir, q) = fresh().await;
        let id = q.enqueue(&job("test.slow"), 1000).await.unwrap().id;
        q.claim("w", &[Lane::Interactive], 30, 1000)
            .await
            .unwrap()
            .unwrap();

        assert!(q.heartbeat("w", &id, 30, 1020).await.unwrap());
        assert_eq!(q.reap(1031).await.unwrap(), Reaped::default(), "still held");
        assert_eq!(q.reap(1051).await.unwrap().requeued, 1, "and then not");
    }

    /// A job that takes its worker down with it never reports a failure, so the reaper is the only
    /// thing that can ever end it. Without this branch it would be reclaimed forever.
    #[tokio::test]
    async fn a_job_that_kills_every_worker_is_eventually_set_aside_by_the_reaper() {
        let (_dir, q) = fresh().await;
        let id = q
            .enqueue(&job("test.poison").max_attempts(2), 1000)
            .await
            .unwrap()
            .id;

        let mut now = 1000;
        for _ in 0..2 {
            q.claim("w", &[Lane::Interactive], 30, now)
                .await
                .unwrap()
                .unwrap();
            now += 31;
            q.reap(now).await.unwrap();
            now += REAP_DELAY_SECS;
        }
        let dead = q.get(&id).await.unwrap().unwrap();
        assert_eq!(dead.status, Status::Failed);
        assert_eq!(dead.attempts, 2);
        assert!(
            dead.last_error
                .as_deref()
                .unwrap()
                .contains("no attempts left")
        );
    }

    /// The claim under real contention. If the single-statement claim were wrong, this is where it
    /// would show: a job claimed twice, or a job silently lost.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_workers_each_get_a_different_job_and_none_is_lost() {
        let (_dir, q) = fresh().await;
        let q = Arc::new(q);
        const JOBS: usize = 60;
        const WORKERS: usize = 6;

        for n in 0..JOBS {
            q.enqueue(&job("test.race").payload(J::from(n as i64)), 1000)
                .await
                .unwrap();
        }

        let mut tasks = Vec::new();
        for w in 0..WORKERS {
            let q = Arc::clone(&q);
            tasks.push(tokio::spawn(async move {
                let name = format!("worker-{w}");
                let mut mine = Vec::new();
                while let Some(job) = q
                    .claim(&name, &[Lane::Interactive], 60, 1000)
                    .await
                    .unwrap()
                {
                    assert_eq!(job.worker.as_deref(), Some(name.as_str()));
                    assert_eq!(job.attempts, 1);
                    mine.push(job.id);
                }
                mine
            }));
        }

        let mut claimed = Vec::new();
        for task in tasks {
            claimed.extend(task.await.unwrap());
        }

        let unique: HashSet<&String> = claimed.iter().collect();
        assert_eq!(claimed.len(), JOBS, "every job must be claimed");
        assert_eq!(unique.len(), JOBS, "and none of them twice");
    }

    #[tokio::test]
    async fn an_effect_is_recorded_once_and_the_first_answer_wins() {
        let (_dir, q) = fresh().await;
        let id = q.enqueue(&job("deliver.telegram"), 1000).await.unwrap().id;

        let first = q
            .remember(&id, "sent", &J::from("message-1"), 1000)
            .await
            .unwrap();
        assert_eq!(first, J::from("message-1"));
        // The retry redid the work and got a different answer. The record does not change.
        let second = q
            .remember(&id, "sent", &J::from("message-2"), 1010)
            .await
            .unwrap();
        assert_eq!(second, J::from("message-1"));
        assert_eq!(
            q.recall(&id, "sent").await.unwrap(),
            Some(J::from("message-1"))
        );
        assert_eq!(q.recall(&id, "never-ran").await.unwrap(), None);
    }

    #[tokio::test]
    async fn pruning_takes_the_effects_with_the_job() {
        let (_dir, q) = fresh().await;
        let old = q.enqueue(&job("test.old"), 1000).await.unwrap().id;
        q.claim("w", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .unwrap();
        q.remember(&old, "sent", &J::Bool(true), 1000)
            .await
            .unwrap();
        q.complete("w", &old, &[], 1001).await.unwrap();

        let live = q.enqueue(&job("test.live"), 5000).await.unwrap().id;

        assert_eq!(q.prune(4000).await.unwrap(), 1);
        assert!(q.get(&old).await.unwrap().is_none());
        assert_eq!(
            q.recall(&old, "sent").await.unwrap(),
            None,
            "the CASCADE should have run"
        );
        assert!(
            q.get(&live).await.unwrap().is_some(),
            "a queued job is not history"
        );
    }

    #[tokio::test]
    async fn a_retry_is_a_new_job_and_the_dead_one_is_kept_as_evidence() {
        let (_dir, q) = fresh().await;
        let dead = q
            .enqueue(&job("deliver.telegram").max_attempts(1), 1000)
            .await
            .unwrap();
        let claimed = q
            .claim("w", &[Lane::Interactive], 60, 1100)
            .await
            .unwrap()
            .unwrap();
        q.fail("w", &claimed.id, "telegram is down", Failure::Retry, 1200)
            .await
            .unwrap();

        let Retried::Queued(copy) = q.retry(&dead.id, 2000).await.unwrap() else {
            panic!("a failed job must be retryable");
        };
        assert_ne!(copy.id, dead.id, "a copy, not a resurrection");

        // The evidence survives the retry — the whole reason it is a copy.
        let original = q.get(&dead.id).await.unwrap().unwrap();
        assert_eq!(original.status, Status::Failed);
        assert_eq!(original.last_error.as_deref(), Some("telegram is down"));

        let fresh_job = q.get(&copy.id).await.unwrap().unwrap();
        assert_eq!(fresh_job.status, Status::Queued);
        assert_eq!(fresh_job.kind, "deliver.telegram");
        assert_eq!(fresh_job.attempts, 0, "a retry starts with a full budget");
        assert_eq!(fresh_job.parent_id.as_deref(), Some(dead.id.as_str()));
    }

    #[tokio::test]
    async fn retrying_twice_is_one_retry() {
        // A button double-clicked, or `/retry` sent twice from a phone on a bad connection.
        let (_dir, q) = fresh().await;
        let dead = q.enqueue(&job("x").max_attempts(1), 1000).await.unwrap();
        let claimed = q
            .claim("w", &[Lane::Interactive], 60, 1100)
            .await
            .unwrap()
            .unwrap();
        q.fail("w", &claimed.id, "boom", Failure::Retry, 1200)
            .await
            .unwrap();

        let Retried::Queued(a) = q.retry(&dead.id, 2000).await.unwrap() else {
            panic!()
        };
        let Retried::Queued(b) = q.retry(&dead.id, 2001).await.unwrap() else {
            panic!()
        };
        assert_eq!(a.id, b.id);
        assert!(a.created && !b.created);
    }

    #[tokio::test]
    async fn only_work_that_went_badly_can_be_retried() {
        let (_dir, q) = fresh().await;
        let queued = q.enqueue(&job("x"), 1000).await.unwrap();
        assert_eq!(
            q.retry(&queued.id, 1100).await.unwrap(),
            Retried::NotRetryable(Status::Queued),
            "retrying a job that has not run yet would run it twice"
        );
        assert_eq!(
            q.retry("no-such-job", 1100).await.unwrap(),
            Retried::NotFound
        );
    }

    #[tokio::test]
    async fn a_cancelled_job_can_be_asked_for_again() {
        let (_dir, q) = fresh().await;
        let queued = q.enqueue(&job("x"), 1000).await.unwrap();
        assert!(q.cancel(&queued.id, 1100).await.unwrap());
        assert!(matches!(
            q.retry(&queued.id, 1200).await.unwrap(),
            Retried::Queued(_)
        ));
    }

    #[tokio::test]
    async fn cancelling_takes_a_queued_job_off_but_leaves_a_running_one_alone() {
        let (_dir, q) = fresh().await;
        let id = q.enqueue(&job("test.cancel"), 1000).await.unwrap().id;
        assert!(q.cancel(&id, 1001).await.unwrap());
        assert_eq!(q.get(&id).await.unwrap().unwrap().status, Status::Cancelled);
        assert!(
            q.claim("w", &[Lane::Interactive], 60, 1002)
                .await
                .unwrap()
                .is_none()
        );

        let running = q.enqueue(&job("test.running"), 1000).await.unwrap().id;
        q.claim("w", &[Lane::Interactive], 60, 1000)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !q.cancel(&running, 1001).await.unwrap(),
            "its holder is mid-flight"
        );
    }

    #[tokio::test]
    async fn the_age_report_counts_only_work_that_is_actually_waiting() {
        let (_dir, q) = fresh().await;
        // Enqueued and claimed first, so the claim below takes this one and not the backlog.
        q.enqueue(&job("test.running"), 800).await.unwrap();
        q.claim("w", &[Lane::Interactive], 60, 800)
            .await
            .unwrap()
            .unwrap();
        q.enqueue(&job("test.waiting"), 900).await.unwrap();
        q.enqueue(&job("test.tomorrow").at(9000), 900)
            .await
            .unwrap();

        let age = q.age(1000).await.unwrap();
        assert_eq!(age.running, 1);
        assert_eq!(age.queued, 2, "the future job is queued");
        assert_eq!(
            age.oldest_queued_secs,
            Some(100),
            "but it is not a backlog, so only the runnable one is aged"
        );
    }

    #[test]
    fn the_backoff_climbs_and_then_stops() {
        assert_eq!(backoff_secs(1), 10);
        assert_eq!(backoff_secs(2), 20);
        assert_eq!(backoff_secs(5), 160);
        assert_eq!(backoff_secs(100), BACKOFF_CAP_SECS, "and never overflows");
    }

    #[test]
    fn long_errors_are_cut_on_a_character_boundary() {
        let wide = "é".repeat(1000);
        let cut = truncate(&wide);
        assert!(cut.len() <= 503);
        assert!(cut.ends_with('…'));
    }
}
