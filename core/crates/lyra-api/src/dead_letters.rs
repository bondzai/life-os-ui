//! Telling you when the queue gave up on something.
//!
//! The queue has always kept a dead job as evidence — that is the point of not resetting it — but
//! nothing ever said so out loud. A snapshot that stopped recording, a brief that never rendered, a
//! webhook deleted in Discord: each one dead-lettered correctly and silently, and the only way to
//! find out was to open the Jobs page on a hunch. This is the `system` group's first producer, and
//! it exists so that "the box stopped doing something" arrives rather than waiting to be noticed.
//!
//! # Two things it must not do
//!
//! **It must not loop.** The report is itself a delivery job. If a dead `notify.deliver` were
//! reported, the report would travel the path that just failed, die the same way, and be reported
//! again — one failure becoming an unbounded chain of them. [`SILENT`] is the guard, and channel
//! health is not lost by it: a failing channel already carries its own `last_error` and
//! `failing_since` on the channel row, which is where Settings shows it.
//!
//! **It must not flood.** One sweep sends one message however many jobs died, grouped by kind. A
//! router outage that kills thirty jobs is one thing that happened, not thirty.
//!
//! # Why `job_effects` and not a watermark
//!
//! "Which ones have I already mentioned" is per job, not per point in time. A reaper dead-letters a
//! batch of expired leases in one statement, all carrying the same second, and a `reported_through`
//! timestamp would skip whichever of them landed on the wrong side of it. An effect per job cannot
//! be off by one, needs no migration, and `prune` takes the marks away with the jobs they mark.

use lyra_db::channels::Severity;
use lyra_db::jobs::{Job, Queue, SqliteQueue, now_secs};

use crate::AppState;
use crate::jobs::deliver::Markup;

/// The effect key that means "this dead letter has been reported".
const REPORTED: &str = "system_reported";

/// How many dead letters one report covers. Beyond this the message says so.
const BATCH: usize = 20;

/// How many kinds are named individually before the message summarises the rest.
const KINDS_SHOWN: usize = 6;

/// Kinds whose deaths are never reported, because a report would travel the path that just failed.
///
/// Marked reported without a message rather than skipped by the query, so they cannot pile up and
/// crowd real failures out of the batch.
///
/// **Adding a delivery kind means adding it here.** The compiler cannot tell which kinds send
/// messages; `every_silent_kind_is_one_this_binary_runs` only catches a rename.
pub(crate) const SILENT: [&str; 3] = ["notify.deliver", "notify.message", "deliver.telegram"];

/// Report whatever the queue has given up on since last time. Returns how many jobs were covered.
pub async fn report(state: &AppState) -> usize {
    let queue = SqliteQueue::new(state.pool.clone());
    let dead = match queue.failed_without(REPORTED, BATCH).await {
        Ok(dead) if dead.is_empty() => return 0,
        Ok(dead) => dead,
        Err(e) => {
            tracing::error!(error = %e, "reading unreported dead letters");
            return 0;
        }
    };

    let (worth_saying, silent): (Vec<&Job>, Vec<&Job>) = dead
        .iter()
        .partition(|job| !SILENT.contains(&job.kind.as_str()));

    if worth_saying.is_empty() {
        // Nothing to send, but these still get marked: leaving them unmarked would mean re-reading
        // the same rows on every tick forever, and eventually a batch of nothing but delivery
        // failures hiding a real one behind the limit.
        mark(&queue, &silent).await;
        return 0;
    }

    let text = describe(&worth_saying, dead.len() == BATCH);
    // Keyed by the newest job in the batch, so a crash between sending and marking re-queues *this*
    // report and the queue collapses it rather than sending a second copy. If more jobs have died by
    // then the key moves and the old ones are named twice — a duplicate "something failed" is much
    // better than a silent one, which is the whole reason this file exists.
    let key = format!("dead:{}", dead.last().map(|j| j.id.as_str()).unwrap_or(""));

    let queued = crate::notify::notify(
        state,
        "system",
        // Never critical: critical pierces quiet hours, and a job that failed at 3am is not worth
        // waking someone for. It will still be there at breakfast, kept as evidence.
        Severity::Warning,
        Some(&key),
        &text,
        Markup::Plain,
    )
    .await;

    if queued == 0 {
        // Not "nothing is routed here" — routing that resolves to nothing falls back to every
        // configured channel, so zero means the *enqueue* failed and the database refused. Left
        // unmarked on purpose: the next tick owes the same report rather than having lost it.
        tracing::warn!(
            jobs = worth_saying.len(),
            "dead letters to report, but nothing could be queued"
        );
        return 0;
    }

    tracing::info!(
        jobs = worth_saying.len(),
        channels = queued,
        "reported dead-lettered jobs"
    );
    mark(&queue, &dead.iter().collect::<Vec<_>>()).await;
    worth_saying.len()
}

/// Mark each job reported. A failure here is logged, not propagated: the message is already queued,
/// and the cost of not marking is a duplicate report rather than a lost one.
async fn mark(queue: &SqliteQueue, jobs: &[&Job]) {
    let now = now_secs();
    for job in jobs {
        if let Err(e) = queue
            .remember(&job.id, REPORTED, &serde_json::json!(now), now)
            .await
        {
            tracing::error!(job = %job.id, error = %e, "marking a dead letter reported");
        }
    }
}

/// The message. Grouped by kind, because "wealth.snapshot failed 4 times" is one fact and four
/// lines saying it is noise.
fn describe(jobs: &[&Job], capped: bool) -> String {
    // Insertion-ordered, so the message reads in the order things broke rather than alphabetically.
    let mut kinds: Vec<(&str, usize, Option<&str>)> = Vec::new();
    for job in jobs {
        match kinds.iter_mut().find(|(kind, _, _)| *kind == job.kind) {
            Some(entry) => {
                entry.1 += 1;
                // The newest error for the kind: the batch is oldest-first, so later wins.
                if job.last_error.is_some() {
                    entry.2 = job.last_error.as_deref();
                }
            }
            None => kinds.push((&job.kind, 1, job.last_error.as_deref())),
        }
    }

    let mut out = match jobs.len() {
        1 => "1 job was set aside after failing.".to_string(),
        n => format!("{n} jobs were set aside after failing."),
    };
    if capped {
        out.push_str(&format!(" Only the oldest {BATCH} are counted here."));
    }
    out.push('\n');

    for (kind, count, error) in kinds.iter().take(KINDS_SHOWN) {
        out.push_str(&format!("\n{kind}"));
        if *count > 1 {
            out.push_str(&format!(" ×{count}"));
        }
        if let Some(error) = error {
            out.push_str(&format!(" — {}", trim(error)));
        }
    }
    if kinds.len() > KINDS_SHOWN {
        out.push_str(&format!("\n…and {} more kinds", kinds.len() - KINDS_SHOWN));
    }

    out.push_str("\n\nThey are kept as evidence — retry or discard them on the Jobs page.");
    out
}

/// One line of an error, short enough to read on a phone.
///
/// Cut on a character boundary: `last_error` holds whatever a handler said, and a wallet address or
/// an exchange's error body can carry multi-byte characters that a byte slice would split.
fn trim(error: &str) -> String {
    let line = error.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 90 {
        return line.to_string();
    }
    let cut: String = line.chars().take(89).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Failure, Lane, NewJob};
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state = AppState::new(pool.clone(), "test-secret".into());
        (dir, state, SqliteQueue::new(pool))
    }

    /// Kill a job of this kind and leave it dead.
    async fn kill(queue: &SqliteQueue, kind: &str, error: &str) -> String {
        let id = queue
            .enqueue(&NewJob::new(kind, Lane::Batch).max_attempts(1), 1000)
            .await
            .unwrap()
            .id;
        let claimed = queue
            .claim("w", &[Lane::Batch], 60, 1000)
            .await
            .unwrap()
            .unwrap();
        queue
            .fail("w", &claimed.id, error, Failure::Retry, 1001)
            .await
            .unwrap();
        id
    }

    /// The rule the whole file turns on: a dead delivery job is never reported, because the report
    /// would go out through the thing that just failed and die the same way.
    #[tokio::test]
    async fn a_dead_delivery_job_is_never_reported_but_is_not_looked_at_twice() {
        let (_dir, state, queue) = app().await;
        let delivery = kill(&queue, "notify.deliver", "discord: 401").await;

        assert_eq!(report(&state).await, 0, "nothing worth saying");
        assert!(
            queue
                .recent(10)
                .await
                .unwrap()
                .iter()
                .all(|j| j.kind != "notify.message"),
            "a report must not have been produced for a delivery failure"
        );
        // Marked anyway, so it cannot fill the batch on every tick from now on.
        assert!(
            queue.recall(&delivery, REPORTED).await.unwrap().is_some(),
            "a silent kind is still marked, or it is re-read forever"
        );
    }

    /// A box with no channels configured yet still gets told, through the transitional fallback —
    /// and gets told **once**.
    #[tokio::test]
    async fn a_failure_is_reported_once_even_before_any_channel_exists() {
        let (_dir, state, queue) = app().await;
        let dead = kill(&queue, "wealth.snapshot", "kucoin: 401 Unauthorized").await;

        assert_eq!(report(&state).await, 1);
        let queued = queue.recent(10).await.unwrap();
        let report_job = queued
            .iter()
            .find(|j| j.kind == crate::jobs::deliver::KIND)
            .expect("the report goes out on the fallback path while routing is empty");
        let text = report_job.payload["text"].as_str().unwrap_or_default();
        assert!(text.contains("wealth.snapshot"), "{text}");
        assert!(text.contains("kucoin: 401 Unauthorized"), "{text}");
        assert!(
            queue.recall(&dead, REPORTED).await.unwrap().is_some(),
            "a sent report marks its jobs"
        );

        // The tick runs every thirty seconds. Without the mark this would send the same report
        // again, and again, for the fourteen days the dead row is kept as evidence.
        assert_eq!(report(&state).await, 0);
        assert_eq!(
            queue
                .recent(20)
                .await
                .unwrap()
                .iter()
                .filter(|j| j.kind == crate::jobs::deliver::KIND)
                .count(),
            1,
            "one failure, one message"
        );
    }

    #[test]
    fn one_kind_that_failed_four_times_is_one_line() {
        let jobs: Vec<Job> = ["a", "b", "c", "d"]
            .iter()
            .map(|id| dead_job(id, "wealth.snapshot", Some("kucoin: 401")))
            .collect();
        let text = describe(&jobs.iter().collect::<Vec<_>>(), false);

        assert!(text.starts_with("4 jobs were set aside"), "{text}");
        assert_eq!(text.matches("wealth.snapshot").count(), 1, "{text}");
        assert!(text.contains("wealth.snapshot ×4 — kucoin: 401"), "{text}");
    }

    #[test]
    fn a_single_failure_is_not_described_as_several() {
        let one = dead_job("a", "digest.daily", None);
        let text = describe(&[&one], false);
        assert!(text.starts_with("1 job was set aside"), "{text}");
        // No error to show, so no dangling dash.
        assert!(text.contains("\ndigest.daily\n"), "{text}");
    }

    #[test]
    fn a_full_batch_says_it_is_only_part_of_the_story() {
        let jobs: Vec<Job> = (0..BATCH)
            .map(|n| dead_job(&n.to_string(), "snapshot.networth", Some("timed out")))
            .collect();
        let text = describe(&jobs.iter().collect::<Vec<_>>(), true);
        assert!(text.contains("Only the oldest 20 are counted"), "{text}");
    }

    #[test]
    fn a_long_error_is_cut_on_a_character_boundary() {
        // A multi-byte character straddling the cut is how this panics if it slices bytes.
        let long = format!("kucoin: {}", "é".repeat(200));
        let cut = trim(&long);
        assert!(cut.chars().count() <= 90, "{cut}");
        assert!(cut.ends_with('…'));
        // Only the first line: a stack trace in a Telegram message is unreadable.
        assert_eq!(trim("first line\nsecond line"), "first line");
    }

    fn dead_job(id: &str, kind: &str, error: Option<&str>) -> Job {
        Job {
            id: id.to_string(),
            kind: kind.to_string(),
            lane: Lane::Batch,
            payload: serde_json::json!({}),
            status: lyra_db::jobs::Status::Failed,
            priority: 0,
            run_at: 1000,
            attempts: 1,
            max_attempts: 1,
            idempotency_key: None,
            worker: None,
            leased_until: None,
            last_error: error.map(|e| e.to_string()),
            parent_id: None,
            created_at: 1000,
            updated_at: 1001,
            finished_at: Some(1001),
        }
    }
}
