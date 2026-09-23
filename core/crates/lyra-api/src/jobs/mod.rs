//! The worker runtime — the half of the queue that actually does the work.
//!
//! [`lyra_db::jobs`] owns the table, the claim and the lease. This owns the loop: claim a job,
//! find the handler for its kind, run it with the lease held, and record what happened. The split
//! is deliberate — the store is pure SQL a test can drive with a pinned clock, and everything with
//! a timer in it lives here.
//!
//! # Lanes, and why there are four workers
//!
//! Two `Interactive`, one `Batch`, one `Deliver`. The counts are not a throughput estimate; they
//! are an isolation guarantee. A ten-minute import must not be able to sit in front of the answer
//! someone is waiting for on their phone, and a Telegram outage retrying for minutes must not
//! occupy the worker that answers commands. Separate lanes with separate workers is the cheapest
//! way to make "one slow job" cost one lane instead of the assistant.
//!
//! # The rule every handler must obey
//!
//! **Never hold a database transaction across a network call.** SQLite has one writer; a handler
//! that opens a transaction and then waits on an HTTP request blocks every writer on the box for
//! the duration — including the `/api/entities` POSTs the web app makes, which exhaust their 5s
//! busy timeout and return 500s. The symptom looks like "the app broke" and the cause is in a
//! worker three files away. Do the slow thing first, then write.
//!
//! # Workers hold connections briefly, on purpose
//!
//! The pool is eight connections and the HTTP server needs them. A worker takes one for the claim,
//! gives it back, and takes one again for each heartbeat and the completion — so four workers cost
//! four connections in bursts rather than four for as long as their handlers run.

pub mod deliver;
pub mod digest;
pub mod schedule;
pub mod snapshot;

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use lyra_db::jobs::{DEFAULT_LEASE_SECS, Failure, Job, Lane, NewJob, Queue, SqliteQueue, now_secs};
use sqlx::types::JsonValue;

use crate::AppState;

/// How long a lease is renewed for, and how often.
///
/// The heartbeat is a third of the lease so two consecutive misses — a stalled thread, a laptop
/// asleep — still leave room for a third to arrive before the reaper decides the worker is gone.
/// A third of the lease, so two beats may be missed before the reaper acts.
///
/// Derived from the worker's own `lease_secs` rather than from the default, because
/// [`Worker::lease`] shortens the lease and a heartbeat pinned to the default would then tick
/// *after* the lease it was meant to renew had already expired — the reaper reclaims a job whose
/// worker is still happily running it, and the completion is refused.
fn heartbeat_secs(lease_secs: i64) -> u64 {
    ((lease_secs.max(1) as u64) / 3).max(1)
}

/// How long an idle worker waits before asking again, and the ceiling it backs off to.
///
/// It starts short so a job enqueued by a Telegram command is picked up while the person is still
/// looking at their phone, and grows so an idle box is not four workers taking the write lock
/// every quarter second all night. The floor of this range is the queue's latency; when that
/// matters more than the idle cost, the fix is a `tokio::sync::Notify` poked by the enqueue path,
/// not a shorter sleep.
const IDLE_MIN: Duration = Duration::from_millis(250);
const IDLE_MAX: Duration = Duration::from_secs(5);

/// How often the reaper looks for expired leases. This is the recovery latency after a crash.
const REAP_EVERY: Duration = Duration::from_secs(30);

/// How long a finished job stays readable before it is pruned. Two weeks is long enough to answer
/// "what happened on Tuesday" and short enough that the table stays small forever.
const RETAIN_SECS: i64 = 14 * 24 * 60 * 60;

/// A boxed future, the same shape `lyra_alerts::telegram::MessageSender` uses.
///
/// A `dyn` trait cannot have `async fn` methods, and a registry of handlers keyed by kind has to be
/// `dyn`. This is the standard way round it without taking an `async-trait` dependency for one
/// trait.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Why a handler stopped, and therefore whether the job runs again.
#[derive(Debug)]
pub enum HandlerError {
    /// The world was wrong. Back off and try again.
    Retry(anyhow::Error),
    /// The job was wrong — a payload that can never parse, an argument that can never validate.
    /// Retrying it four more times only writes the same line in the log four more times.
    Permanent(anyhow::Error),
}

impl std::fmt::Display for HandlerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandlerError::Retry(e) | HandlerError::Permanent(e) => write!(f, "{e:#}"),
        }
    }
}

/// `?` inside a handler means retry. That is the safe default: an unclassified error is much more
/// often a network blip than a permanently malformed job, and the cost of guessing wrong is a
/// delay rather than lost work.
impl From<anyhow::Error> for HandlerError {
    fn from(error: anyhow::Error) -> Self {
        HandlerError::Retry(error)
    }
}

pub type HandlerResult = std::result::Result<(), HandlerError>;

/// One kind of work.
pub trait Handler: Send + Sync {
    /// The `kind` string this handles, e.g. `deliver.telegram`. It is written into every job row,
    /// so it is a wire contract: renaming one strands the jobs already queued under the old name.
    fn kind(&self) -> &'static str;

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult>;
}

/// What a handler can do besides its own work.
pub struct JobCtx {
    queue: SqliteQueue,
    job: Job,
    #[cfg_attr(not(test), allow(dead_code))]
    worker: String,
    now: i64,
    /// Jobs this one produced. Held until the handler returns so they can be written in the *same
    /// commit* as the completion — the one thing this queue can do that a separate broker cannot.
    /// Enqueueing them as the handler goes would mean a crash could leave the follow-up queued
    /// with its parent still to run.
    follow_ups: Mutex<Vec<NewJob>>,
}

// Some of this is the seam rather than today's need: `enqueue` is what the Telegram write verbs
// will hand their reply to, and `heartbeat` is what a handler that outlives a lease has to call.
// Both are exercised by the tests below, so the allow applies only to the build that has no tests
// in it — genuinely dead code still shows up there.
#[cfg_attr(not(test), allow(dead_code))]
impl JobCtx {
    /// Build a context by hand, for a test that exercises one handler without a worker.
    #[cfg(test)]
    pub fn for_test(queue: SqliteQueue, job: Job, worker: String, now: i64) -> Self {
        Self {
            queue,
            job,
            worker,
            now,
            follow_ups: Mutex::new(Vec::new()),
        }
    }

    /// A required text field of the payload.
    ///
    /// Missing is **permanent**: the payload is written at enqueue and never changes, so no amount
    /// of retrying grows the field. Named after the job's own kind so the log says which enqueue
    /// site forgot it.
    pub fn require_str(&self, key: &str) -> Result<&str, HandlerError> {
        self.payload()
            .get(key)
            .and_then(JsonValue::as_str)
            .ok_or_else(|| self.missing(key))
    }

    /// A required integer field of the payload. Permanent when missing, for the same reason.
    pub fn require_i64(&self, key: &str) -> Result<i64, HandlerError> {
        self.payload()
            .get(key)
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| self.missing(key))
    }

    fn missing(&self, key: &str) -> HandlerError {
        HandlerError::Permanent(anyhow::anyhow!("{} needs a `{key}`", self.job.kind))
    }

    pub fn job(&self) -> &Job {
        &self.job
    }

    pub fn payload(&self) -> &JsonValue {
        &self.job.payload
    }

    /// Enqueue a job that runs after this one lands.
    pub fn enqueue(&self, job: NewJob) {
        let job = job.child_of(&self.job.id);
        if let Ok(mut queued) = self.follow_ups.lock() {
            queued.push(job);
        }
    }

    /// Do something at most once across every attempt at this job.
    ///
    /// A job is delivered **at least** once, so a handler that sends a message, moves money or
    /// posts to someone else's API needs this: after a reclaim the step is skipped and the first
    /// run's answer is returned instead. It narrows the double-do window to the gap between the
    /// step returning and the record landing — it cannot close it, and a step that must never
    /// repeat needs an idempotency key at the far end as well.
    pub async fn once<F, Fut>(&self, key: &str, step: F) -> Result<JsonValue>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<JsonValue>>,
    {
        if let Some(done) = self.queue.recall(&self.job.id, key).await? {
            tracing::debug!(job = %self.job.id, key, "skipping a step this job already did");
            return Ok(done);
        }
        let value = step().await?;
        self.queue
            .remember(&self.job.id, key, &value, self.now)
            .await
    }

    /// Push the lease out. `false` means it was lost and the handler should return promptly —
    /// anything it writes after this point is writing over someone else's work.
    pub async fn heartbeat(&self) -> bool {
        self.queue
            .heartbeat(&self.worker, &self.job.id, DEFAULT_LEASE_SECS, now_secs())
            .await
            .unwrap_or(false)
    }

    fn take_follow_ups(&self) -> Vec<NewJob> {
        self.follow_ups
            .lock()
            .map(|mut queued| std::mem::take(&mut *queued))
            .unwrap_or_default()
    }
}

/// Every kind this process knows how to run.
#[derive(Default)]
pub struct Handlers(HashMap<&'static str, Arc<dyn Handler>>);

impl Handlers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registering two handlers for one kind is a programming error caught at startup rather than
    /// by whichever one happened to be inserted last.
    pub fn with(mut self, handler: Arc<dyn Handler>) -> Self {
        let kind = handler.kind();
        assert!(
            self.0.insert(kind, handler).is_none(),
            "two handlers registered for {kind}"
        );
        self
    }

    pub fn get(&self, kind: &str) -> Option<Arc<dyn Handler>> {
        self.0.get(kind).cloned()
    }

    pub fn kinds(&self) -> Vec<&'static str> {
        let mut kinds: Vec<_> = self.0.keys().copied().collect();
        kinds.sort_unstable();
        kinds
    }
}

/// Every handler this binary knows.
///
/// Takes the state because a handler that reads the book needs the pool. `deliver.telegram` does
/// not, and is left constructed from the environment so a rotated token takes effect without a
/// restart of anything but the send.
pub fn handlers(state: AppState) -> Handlers {
    Handlers::new()
        .with(Arc::new(deliver::DeliverTelegram::from_env()))
        .with(Arc::new(digest::DailyDigest::new(state.clone())))
        .with(Arc::new(snapshot::NetWorthSnapshot::new(state.clone())))
        .with(Arc::new(schedule::ScheduleTick::new(state)))
}

/// Where a worker reads the time from.
///
/// Injected rather than read, for the same reason the alert store injects it: the reaper and the
/// lease are only testable against a clock a test can move. Production passes [`now_secs`].
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// One claim loop.
pub struct Worker {
    queue: SqliteQueue,
    handlers: Arc<Handlers>,
    name: String,
    lanes: Vec<Lane>,
    lease_secs: i64,
    clock: Clock,
    /// Where this worker announces itself. `None` in tests, which is why every call goes through
    /// [`Worker::tell`] rather than unwrapping here.
    fleet: Option<crate::agents::Fleet>,
    /// Where a failed job is also recorded for the settings page. `None` in tests.
    meta: Option<crate::alert_loop::SharedMeta>,
    /// What the fleet view calls this worker. Defaults to its lane's persona with one seat.
    persona: (String, String),
}

impl Worker {
    pub fn new(
        queue: SqliteQueue,
        handlers: Arc<Handlers>,
        name: impl Into<String>,
        lanes: Vec<Lane>,
    ) -> Self {
        // Read before `lanes` moves into the struct. One seat, since a worker built by hand is
        // alone until `spawn` says otherwise.
        let persona = persona(*lanes.first().unwrap_or(&Lane::Interactive), 0, 1);
        Self {
            queue,
            handlers,
            name: name.into(),
            lanes,
            lease_secs: DEFAULT_LEASE_SECS,
            clock: Arc::new(now_secs),
            fleet: None,
            meta: None,
            persona,
        }
    }

    /// Report to the fleet view, so the Agents page can see this worker.
    /// Record failures where `/api/wealth/alerts` — and so the settings page and `/status` — reads
    /// them.
    ///
    /// Here, once, rather than in each handler. The first version had the digest and snapshot
    /// handlers each remember to write here, and alert delivery — the one that mattered most, and
    /// had always reported its failures — was the handler that forgot: moving alerts onto the queue
    /// quietly made the settings page blind to exactly the failures the move set out to catch. A
    /// rule every handler must remember is a rule the next handler forgets.
    pub fn reporting_to(mut self, meta: crate::alert_loop::SharedMeta) -> Self {
        self.meta = Some(meta);
        self
    }

    /// Name this worker for the fleet view: who is at this desk, and what it is for.
    pub fn introduced_as(mut self, name: String, role: String) -> Self {
        self.persona = (name, role);
        self
    }

    pub fn watched_by(mut self, fleet: crate::agents::Fleet) -> Self {
        self.fleet = Some(fleet);
        self
    }

    /// Announce something, if anyone is listening.
    ///
    /// Observability must not be able to change what the queue does, so this deliberately has no
    /// failure path: a fleet that is absent, poisoned or full loses a frame and the job runs on.
    fn tell(&self, report: crate::agents::Report) {
        if let Some(fleet) = &self.fleet {
            fleet.report(report);
        }
    }

    /// Shorten the lease. For tests: production wants [`DEFAULT_LEASE_SECS`], and a lease short
    /// enough to be testable is one the reaper would steal out from under a real handler.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn lease(mut self, seconds: i64) -> Self {
        self.lease_secs = seconds;
        self
    }

    /// Move the worker's clock. The lease, the backoff and the reaper are all times, and none of
    /// them is testable against a clock that only goes forwards at one second per second.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// Claim and run at most one job. `false` means the queue had nothing for this worker.
    ///
    /// This is the whole of a worker's behaviour, kept separate from the loop around it so a test
    /// can drive exactly one iteration.
    pub async fn tick(&self) -> bool {
        let now = (self.clock)();
        let claimed = match self
            .queue
            .claim(&self.name, &self.lanes, self.lease_secs, now)
            .await
        {
            Ok(Some(job)) => job,
            Ok(None) => return false,
            Err(error) => {
                // A claim that cannot even reach the database is not a job failure — there is no
                // job to fail — so it is logged and the loop tries again.
                tracing::warn!(worker = %self.name, error = %error, "could not claim a job");
                return false;
            }
        };

        let id = claimed.id.clone();
        let kind = claimed.kind.clone();
        let attempt = claimed.attempts;

        let Some(handler) = self.handlers.get(&kind) else {
            // Permanent: no amount of waiting conjures a handler into this binary. Failing it now
            // means the row says so, instead of five identical lines an hour apart.
            let _ = self
                .queue
                .fail(
                    &self.name,
                    &id,
                    &format!("no handler registered for {kind}"),
                    Failure::Permanent,
                    (self.clock)(),
                )
                .await;
            tracing::warn!(worker = %self.name, %kind, job = %id, "no handler for this kind");
            return true;
        };

        let ctx = JobCtx {
            queue: self.queue.clone(),
            job: claimed,
            worker: self.name.clone(),
            now,
            follow_ups: Mutex::new(Vec::new()),
        };

        self.tell(crate::agents::Report::Claimed {
            id: self.name.clone(),
            job: crate::agents::CurrentJob {
                id: id.clone(),
                kind: kind.clone(),
                attempt,
                started_at: now,
            },
        });
        tracing::info!(worker = %self.name, %kind, job = %id, attempt, "running a job");
        let outcome = self.run_with_lease(&handler, &ctx, &id).await;
        self.tell(crate::agents::Report::Finished {
            id: self.name.clone(),
            ok: matches!(outcome, Outcome::Done),
            at: (self.clock)(),
        });
        match outcome {
            Outcome::Done => {
                let follow_ups = ctx.take_follow_ups();
                match self
                    .queue
                    .complete(&self.name, &id, &follow_ups, (self.clock)())
                    .await
                {
                    // The lease went while the handler ran. Someone else has the job, and saying
                    // so is the only useful thing left — the work has already been redone or is
                    // about to be.
                    Ok(false) => tracing::warn!(
                        worker = %self.name, %kind, job = %id,
                        "finished a job this worker no longer held; discarding the result"
                    ),
                    Ok(true) => tracing::info!(
                        worker = %self.name, %kind, job = %id,
                        follow_ups = follow_ups.len(), "job done"
                    ),
                    Err(error) => tracing::error!(
                        worker = %self.name, %kind, job = %id, error = %error,
                        "could not record a completed job; the reaper will run it again"
                    ),
                }
            }
            Outcome::Failed(error) => {
                let permanent = matches!(error, HandlerError::Permanent(_));
                let failure = if permanent {
                    Failure::Permanent
                } else {
                    Failure::Retry
                };
                let reason = error.to_string();
                tracing::warn!(
                    worker = %self.name, %kind, job = %id, attempt, permanent,
                    error = %reason, "job failed"
                );
                if let Some(meta) = &self.meta {
                    crate::alert_loop::record_error(meta, format!("{kind}: {reason}"));
                }
                if let Err(error) = self
                    .queue
                    .fail(&self.name, &id, &reason, failure, (self.clock)())
                    .await
                {
                    tracing::error!(job = %id, error = %error, "could not record a failed job");
                }
            }
            Outcome::LeaseLost => {
                // Deliberately silent about the job: it belongs to someone else now, and writing
                // anything to the row from here is the bug the `worker = ?` guard exists to stop.
                tracing::warn!(
                    worker = %self.name, %kind, job = %id,
                    "lost the lease mid-job; abandoning it to whoever reclaimed it"
                );
            }
        }
        true
    }

    /// Run the handler, renewing the lease under it, and stop early if the lease is lost.
    ///
    /// The heartbeat shares this task rather than running in its own: a heartbeat that outlives a
    /// panicking handler would hold a lease for a job nobody is running, which is precisely the
    /// state the reaper exists to end.
    async fn run_with_lease(&self, handler: &Arc<dyn Handler>, ctx: &JobCtx, id: &str) -> Outcome {
        let mut beat = tokio::time::interval(Duration::from_secs(heartbeat_secs(self.lease_secs)));
        beat.tick().await; // `interval` fires immediately; the lease is fresh from the claim.

        let running = handler.run(ctx);
        tokio::pin!(running);

        loop {
            tokio::select! {
                outcome = &mut running => return match outcome {
                    Ok(()) => Outcome::Done,
                    Err(error) => Outcome::Failed(error),
                },
                _ = beat.tick() => {
                    let held = self
                        .queue
                        .heartbeat(&self.name, id, self.lease_secs, (self.clock)())
                        .await;
                    match held {
                        Ok(true) => {}
                        Ok(false) => return Outcome::LeaseLost,
                        // A database blip is not proof the lease was lost. Carrying on is the
                        // better guess: at worst the reaper takes the job and the completion is
                        // refused, which costs one duplicate run rather than one abandoned job.
                        Err(error) => tracing::warn!(job = %id, error = %error, "heartbeat failed"),
                    }
                }
            }
        }
    }

    /// Claim, run, repeat. Never returns.
    pub async fn run_forever(self) {
        // Announced here rather than in `spawn` so a supervised restart re-announces: the page
        // should show a worker that came back, not one that silently stopped reporting.
        self.tell(crate::agents::Report::Started {
            id: self.name.clone(),
            name: self.persona.0.clone(),
            role: self.persona.1.clone(),
            lane: self
                .lanes
                .first()
                .map(|l| l.as_str().to_string())
                .unwrap_or_else(|| "any".into()),
            at: (self.clock)(),
        });
        let mut idle = IDLE_MIN;
        loop {
            if self.tick().await {
                idle = IDLE_MIN;
            } else {
                tokio::time::sleep(idle).await;
                idle = (idle * 2).min(IDLE_MAX);
            }
        }
    }
}

enum Outcome {
    Done,
    Failed(HandlerError),
    LeaseLost,
}

/// Reclaim expired leases, and eventually forget old jobs. Never returns.
///
/// This is the single point of recovery from a hard kill, and the path that is never exercised in
/// normal operation — which is exactly why it has its own tests in [`lyra_db::jobs`].
pub async fn reaper(queue: SqliteQueue) {
    let mut ticks: u64 = 0;
    loop {
        tokio::time::sleep(REAP_EVERY).await;
        let now = now_secs();
        match queue.reap(now).await {
            Ok(reaped) if reaped.requeued > 0 || reaped.dead_lettered > 0 => tracing::warn!(
                requeued = reaped.requeued,
                dead_lettered = reaped.dead_lettered,
                "reclaimed jobs from workers that stopped reporting"
            ),
            Ok(_) => {}
            Err(error) => tracing::warn!(error = %error, "the reaper could not run"),
        }

        // Hourly, off the back of the tick that is already awake.
        ticks += 1;
        if ticks.is_multiple_of(120)
            && let Err(error) = queue.prune(now - RETAIN_SECS).await
        {
            tracing::warn!(error = %error, "could not prune finished jobs");
        }
    }
}

/// Start the workers and the reaper.
///
/// Started from `main` rather than `app()`, like the other two loops, so the router the tests
/// build stays inert. `LYRA_JOBS=off` stops it — there for the case where a box is misbehaving and
/// the question is whether the queue is the reason.
pub fn spawn(state: AppState) {
    if std::env::var("LYRA_JOBS").is_ok_and(|v| matches!(v.trim(), "off" | "0" | "false")) {
        tracing::info!("job workers disabled by LYRA_JOBS");
        return;
    }

    let queue = SqliteQueue::new(state.pool.clone());
    let handlers = Arc::new(handlers(state.clone()));
    tracing::info!(kinds = ?handlers.kinds(), "job workers starting");

    // Two interactive, one batch, one deliver. See the module docs: this is isolation, not
    // throughput.
    for (lane, count) in [(Lane::Interactive, 2), (Lane::Batch, 1), (Lane::Deliver, 1)] {
        for n in 0..count {
            let name = worker_name(lane, n);
            let (agent_name, agent_role) = persona(lane, n, count);
            let queue = queue.clone();
            let handlers = Arc::clone(&handlers);
            let fleet = state.fleet.clone();
            let meta = Arc::clone(&state.alert_meta);
            supervise(name, move |name| {
                Worker::new(queue.clone(), Arc::clone(&handlers), name, vec![lane])
                    .introduced_as(agent_name.clone(), agent_role.clone())
                    .watched_by(fleet.clone())
                    .reporting_to(Arc::clone(&meta))
                    .run_forever()
            });
        }
    }

    tokio::spawn(reaper(queue));
}

/// A worker name that is unique across processes, not just within one.
///
/// It was `deliver-0`, which is unique among the four workers this process starts and says nothing
/// at all about *which* process. Every claim, heartbeat and completion is guarded by
/// `WHERE worker = ?`, and that guard is the whole of the lease: it is what stops a worker whose
/// job was reclaimed from finishing it anyway. Two `lyra-api` processes on one SQLite file both
/// have a `deliver-0`, so the guard compares equal across them and the protection is gone —
/// process A's stale `complete()` lands on the job process B is holding.
///
/// Two processes on one database is not hypothetical: it is the shape the `Queue` trait was
/// introduced for, and it is what happens for a few seconds during any restart that overlaps.
///
/// The pid is the process part. It can be reused after a reboot, but not while a lease is live,
/// which is the only window in which the comparison means anything.
fn worker_name(lane: Lane, n: usize) -> String {
    format!("{}-{n}@{}", lane.as_str(), std::process::id())
}

/// Who a worker is, for the people looking at it rather than for the queue.
///
/// Derived from the lane, because today that is the only thing that distinguishes one worker from
/// another — they are identical loops reading different queues. It is a *table*, not a formatting
/// rule, so that when agents start differing by what they can actually do, each one declares its
/// own name and role here instead of being described by the queue it happens to read.
///
/// The ordinal is only shown when a lane has more than one seat: "Runner 1" and "Runner 2" are
/// worth telling apart, "Relay 1" alone is not.
pub fn persona(lane: Lane, n: usize, seats: usize) -> (String, String) {
    let (name, role) = match lane {
        Lane::Interactive => ("Runner", "Answers commands and anything you are waiting on"),
        Lane::Batch => (
            "Analyst",
            "Reads the book: the daily brief and the net-worth series",
        ),
        Lane::Deliver => ("Relay", "Sends what the others write, and keeps trying"),
    };
    let name = if seats > 1 {
        format!("{name} {}", n + 1)
    } else {
        name.to_string()
    };
    (name, role.to_string())
}

/// How long to wait before restarting a worker that panicked.
///
/// Long enough that a handler panicking on every job cannot spin, short enough that a one-off
/// costs a few seconds of that lane rather than the rest of the day.
const RESTART_DELAY: Duration = Duration::from_secs(5);

/// Keep a worker running across panics.
///
/// `tokio::spawn(worker.run_forever())` dropped the `JoinHandle`, so a panic anywhere in a handler
/// ended that task silently and permanently: `run_forever` never returns, nothing was awaiting it,
/// and nothing restarted it. One `unwrap` on one malformed provider payload and the deliver lane
/// was dark for the life of the process — jobs claimed, leases expiring, the reaper dutifully
/// requeueing them for a worker that no longer existed.
///
/// Supervision rather than `catch_unwind` because a panic mid-job should abandon that job, not
/// resume inside it. The job is not lost: its lease expires and the reaper requeues it, which is
/// the path that already exists for a hard kill. A panicking handler is just a very small crash.
fn supervise<F, Fut>(name: String, build: F)
where
    F: Fn(String) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            let handle = tokio::spawn(build(name.clone()));
            match handle.await {
                // `run_forever` never returns, so this only happens on shutdown.
                Ok(()) => return,
                Err(error) if error.is_cancelled() => return,
                Err(error) => {
                    tracing::error!(
                        worker = %name,
                        %error,
                        "a job handler panicked; restarting the worker"
                    );
                    tokio::time::sleep(RESTART_DELAY).await;
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Status, backoff_secs};
    use serde_json::json;
    use sqlx::SqlitePool;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use tokio::sync::oneshot;

    /// An `AppState` on a throwaway database, for the handlers that read through one.
    async fn test_state() -> crate::AppState {
        let dir = TempDir::new().unwrap();
        // Leaked on purpose: the pool must outlive the temp dir for the length of the test, and a
        // test process that leaks one directory is cheaper than threading a guard through.
        let path = Box::leak(Box::new(dir)).path().join("lyra.db");
        crate::AppState::new(
            lyra_db::open_and_migrate(&path).await.unwrap(),
            "test-secret".into(),
        )
    }

    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool: SqlitePool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, SqliteQueue::new(pool))
    }

    fn at(fixed: i64) -> Clock {
        Arc::new(move || fixed)
    }

    /// Blocks forever the first time it is run and succeeds every time after, with a recorded
    /// effect either side of the block.
    struct Blocker {
        runs: Arc<AtomicUsize>,
        effects: Arc<AtomicUsize>,
        started: Mutex<Option<oneshot::Sender<()>>>,
    }

    impl Handler for Blocker {
        fn kind(&self) -> &'static str {
            "test.block"
        }

        fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
            Box::pin(async move {
                let run = self.runs.fetch_add(1, Ordering::SeqCst);
                let effects = Arc::clone(&self.effects);
                ctx.once("side-effect", || async move {
                    effects.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({ "ran_on_attempt": run + 1 }))
                })
                .await?;

                if run == 0 {
                    // The worker is about to be killed here, holding the lease, with the effect
                    // already recorded and nothing reported.
                    if let Some(tell) = self.started.lock().unwrap().take() {
                        let _ = tell.send(());
                    }
                    std::future::pending::<()>().await;
                }
                Ok(())
            })
        }
    }

    struct Always(&'static str, HandlerError);

    /// A handler that only ever fails, to exercise both failure classes.
    impl Handler for Always {
        fn kind(&self) -> &'static str {
            self.0
        }

        fn run<'a>(&'a self, _ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
            Box::pin(async move {
                Err(match &self.1 {
                    HandlerError::Retry(e) => HandlerError::Retry(anyhow::anyhow!("{e}")),
                    HandlerError::Permanent(e) => HandlerError::Permanent(anyhow::anyhow!("{e}")),
                })
            })
        }
    }

    /// The test the whole lease design exists for: a worker is killed with a job in its hands, and
    /// the job must come back to **exactly one** other worker — while the dead one, were it to
    /// wake, could not finish it.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_worker_killed_mid_job_loses_it_to_exactly_one_other() {
        let (_dir, queue) = fresh().await;
        let runs = Arc::new(AtomicUsize::new(0));
        let effects = Arc::new(AtomicUsize::new(0));
        let (started, has_started) = oneshot::channel();
        let handlers = Arc::new(Handlers::new().with(Arc::new(Blocker {
            runs: Arc::clone(&runs),
            effects: Arc::clone(&effects),
            started: Mutex::new(Some(started)),
        })));

        const T0: i64 = 1_700_000_000;
        let id = queue
            .enqueue(&NewJob::new("test.block", Lane::Interactive), T0)
            .await
            .unwrap()
            .id;

        // Worker A takes a two-second lease and is killed inside the handler. No heartbeat, no
        // failure, no completion — the process simply stops existing.
        let a = Worker::new(
            queue.clone(),
            Arc::clone(&handlers),
            "worker-a",
            vec![Lane::Interactive],
        )
        .lease(2)
        .clock(at(T0));
        let killed = tokio::spawn(async move { a.tick().await });
        has_started.await.expect("the handler should have begun");
        killed.abort();
        assert!(killed.await.unwrap_err().is_cancelled());

        assert_eq!(runs.load(Ordering::SeqCst), 1);
        let held = queue.get(&id).await.unwrap().unwrap();
        assert_eq!(held.status, Status::Running, "still leased to a corpse");
        assert_eq!(held.worker.as_deref(), Some("worker-a"));

        // The reaper finds it once the lease lapses — once, and only once.
        assert_eq!(queue.reap(T0 + 1).await.unwrap().requeued, 0, "not yet");
        assert_eq!(queue.reap(T0 + 3).await.unwrap().requeued, 1);
        assert_eq!(
            queue.reap(T0 + 4).await.unwrap().requeued,
            0,
            "and not twice"
        );

        // Worker B picks it up and finishes it.
        let b = Worker::new(
            queue.clone(),
            Arc::clone(&handlers),
            "worker-b",
            vec![Lane::Interactive],
        )
        .clock(at(T0 + 60));
        assert!(b.tick().await, "the reclaimed job should be claimable");

        let done = queue.get(&id).await.unwrap().unwrap();
        assert_eq!(done.status, Status::Done);
        assert_eq!(done.attempts, 2, "one attempt each, and no more");
        assert_eq!(runs.load(Ordering::SeqCst), 2, "the work resumed");
        assert_eq!(
            effects.load(Ordering::SeqCst),
            1,
            "but its effect happened once: `once` replayed the first run's answer"
        );

        // And the corpse cannot take it back. This is the guard that makes "exactly one" hold
        // even when a paused process wakes up believing it still owns the job.
        assert!(!queue.complete("worker-a", &id, &[], T0 + 70).await.unwrap());
        assert!(!queue.heartbeat("worker-a", &id, 60, T0 + 70).await.unwrap());
        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);

        // Nothing is left for a third worker.
        let c = Worker::new(queue.clone(), handlers, "worker-c", vec![Lane::Interactive])
            .clock(at(T0 + 120));
        assert!(!c.tick().await);
    }

    #[tokio::test]
    async fn a_job_with_no_handler_is_set_aside_rather_than_retried() {
        let (_dir, queue) = fresh().await;
        let id = queue
            .enqueue(&NewJob::new("nobody.handles.this", Lane::Batch), 1000)
            .await
            .unwrap()
            .id;

        let worker = Worker::new(
            queue.clone(),
            Arc::new(Handlers::new()),
            "batch-0",
            vec![Lane::Batch],
        )
        .clock(at(1000));
        assert!(worker.tick().await);

        let job = queue.get(&id).await.unwrap().unwrap();
        assert_eq!(job.status, Status::Failed);
        assert_eq!(job.attempts, 1, "the other four attempts were not wasted");
        assert!(job.last_error.unwrap().contains("nobody.handles.this"));
    }

    #[tokio::test]
    async fn a_retryable_failure_comes_back_and_a_permanent_one_does_not() {
        let (_dir, queue) = fresh().await;
        let handlers = Arc::new(
            Handlers::new()
                .with(Arc::new(Always(
                    "test.flaky",
                    HandlerError::Retry(anyhow::anyhow!("the network went away")),
                )))
                .with(Arc::new(Always(
                    "test.broken",
                    HandlerError::Permanent(anyhow::anyhow!("payload.text is missing")),
                ))),
        );
        let worker = Worker::new(
            queue.clone(),
            handlers,
            "interactive-0",
            vec![Lane::Interactive],
        )
        .clock(at(1000));

        let flaky = queue
            .enqueue(&NewJob::new("test.flaky", Lane::Interactive), 1000)
            .await
            .unwrap()
            .id;
        let broken = queue
            .enqueue(&NewJob::new("test.broken", Lane::Interactive), 1000)
            .await
            .unwrap()
            .id;

        assert!(worker.tick().await);
        assert!(worker.tick().await);

        let flaky = queue.get(&flaky).await.unwrap().unwrap();
        assert_eq!(flaky.status, Status::Queued);
        assert_eq!(flaky.run_at, 1000 + backoff_secs(1));
        assert!(flaky.last_error.unwrap().contains("the network went away"));

        let broken = queue.get(&broken).await.unwrap().unwrap();
        assert_eq!(broken.status, Status::Failed);
        assert_eq!(broken.attempts, 1);
    }

    /// The property that makes "finish the task and tell them about it" survive a crash: either
    /// both rows are there or neither is.
    #[tokio::test]
    async fn a_handlers_follow_up_lands_in_the_same_commit_as_the_completion() {
        struct Spawner;
        impl Handler for Spawner {
            fn kind(&self) -> &'static str {
                "test.spawner"
            }
            fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
                Box::pin(async move {
                    ctx.enqueue(
                        NewJob::new("deliver.telegram", Lane::Deliver)
                            .payload(json!({ "text": "done" })),
                    );
                    Ok(())
                })
            }
        }

        let (_dir, queue) = fresh().await;
        let parent = queue
            .enqueue(&NewJob::new("test.spawner", Lane::Interactive), 1000)
            .await
            .unwrap()
            .id;
        let worker = Worker::new(
            queue.clone(),
            Arc::new(Handlers::new().with(Arc::new(Spawner))),
            "interactive-0",
            vec![Lane::Interactive],
        )
        .clock(at(1000));
        assert!(worker.tick().await);

        assert_eq!(
            queue.get(&parent).await.unwrap().unwrap().status,
            Status::Done
        );
        let child = queue
            .claim("deliver-0", &[Lane::Deliver], 60, 1000)
            .await
            .unwrap()
            .expect("the follow-up should be queued");
        assert_eq!(child.kind, "deliver.telegram");
        assert_eq!(child.parent_id.as_deref(), Some(parent.as_str()));
    }

    /// Long work must be able to hold its own lease, or the reaper will hand the job to a second
    /// worker while the first is still doing it.
    #[tokio::test]
    async fn a_handler_can_read_its_job_and_renew_its_own_lease() {
        struct Slow(Arc<Mutex<Vec<String>>>);
        impl Handler for Slow {
            fn kind(&self) -> &'static str {
                "test.slow"
            }
            fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
                Box::pin(async move {
                    self.0.lock().unwrap().push(ctx.job().id.clone());
                    assert!(ctx.heartbeat().await, "the lease is this worker's to renew");
                    assert_eq!(ctx.job().attempts, 1);
                    Ok(())
                })
            }
        }

        let (_dir, queue) = fresh().await;
        let seen = Arc::new(Mutex::new(Vec::new()));
        let id = queue
            .enqueue(&NewJob::new("test.slow", Lane::Batch), 1000)
            .await
            .unwrap()
            .id;
        let worker = Worker::new(
            queue.clone(),
            Arc::new(Handlers::new().with(Arc::new(Slow(Arc::clone(&seen))))),
            "batch-0",
            vec![Lane::Batch],
        )
        .clock(at(1000));

        assert!(worker.tick().await);
        assert_eq!(*seen.lock().unwrap(), vec![id.clone()]);
        assert_eq!(queue.get(&id).await.unwrap().unwrap().status, Status::Done);
    }

    #[tokio::test]
    async fn every_kinds_failure_reaches_the_settings_page() {
        // Asserted at the worker, not per handler, because per-handler is exactly how this broke:
        // two handlers remembered to report and alert delivery — the kind that had always reported
        // its failures — did not. Using `deliver.telegram` here is the point.
        struct Refuses;
        impl Handler for Refuses {
            fn kind(&self) -> &'static str {
                "deliver.telegram"
            }
            fn run<'a>(&'a self, _ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
                Box::pin(async { Err(HandlerError::Retry(anyhow::anyhow!("connection reset"))) })
            }
        }

        let (_dir, queue) = fresh().await;
        queue
            .enqueue(&NewJob::new("deliver.telegram", Lane::Deliver), 1000)
            .await
            .unwrap();
        let meta = crate::alert_loop::SharedMeta::default();
        let worker = Worker::new(
            queue,
            Arc::new(Handlers::new().with(Arc::new(Refuses))),
            "deliver-0",
            vec![Lane::Deliver],
        )
        .clock(at(1000))
        .reporting_to(Arc::clone(&meta));

        assert!(worker.tick().await);
        let recorded = meta.lock().unwrap().last_error.clone();
        assert_eq!(recorded.as_deref(), Some("deliver.telegram: connection reset"));
    }

    #[tokio::test]
    async fn an_idle_worker_claims_nothing_and_says_so() {
        let (_dir, queue) = fresh().await;
        let worker = Worker::new(
            queue,
            Arc::new(handlers(test_state().await)),
            "deliver-0",
            vec![Lane::Deliver],
        );
        assert!(!worker.tick().await);
    }

    #[tokio::test]
    async fn the_registry_names_every_kind_this_binary_can_run() {
        // A guard against the commonest way a queue goes quiet: a handler written, a job enqueued
        // under its kind, and the registration forgotten. The job is then claimed, fails with
        // "no handler", and dead-letters — quietly.
        let mut kinds = handlers(test_state().await).kinds();
        kinds.sort();
        assert_eq!(
            kinds,
            vec![
                "deliver.telegram",
                "digest.daily",
                "schedule.tick",
                "snapshot.networth"
            ]
        );
    }

    #[test]
    #[should_panic(expected = "two handlers registered")]
    fn registering_one_kind_twice_is_caught_at_startup() {
        Handlers::new()
            .with(Arc::new(Always(
                "dup",
                HandlerError::Retry(anyhow::anyhow!("x")),
            )))
            .with(Arc::new(Always(
                "dup",
                HandlerError::Retry(anyhow::anyhow!("x")),
            )));
    }

    #[test]
    fn one_seat_per_lane_goes_unnumbered() {
        // "Analyst 1" with no Analyst 2 anywhere is a number that answers a question nobody asked.
        let (name, role) = persona(Lane::Batch, 0, 1);
        assert_eq!(name, "Analyst");
        assert!(
            !role.is_empty(),
            "an empty desk still has to say what it is for"
        );

        let (first, _) = persona(Lane::Interactive, 0, 2);
        let (second, _) = persona(Lane::Interactive, 1, 2);
        assert_eq!(first, "Runner 1");
        assert_eq!(second, "Runner 2");
    }
}
