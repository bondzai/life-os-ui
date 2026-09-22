//! The queue, from a phone: `/jobs`, `/retry <id>`, `/cancel <id>`.
//!
//! The Agents page answers "what is the box doing" at a desk. These answer it from wherever you
//! were when the brief did not arrive — which is, by construction, not at your desk.
//!
//! # Ids you can actually type
//!
//! A job id is a UUID. Nobody types thirty-six characters on a phone keyboard, so `/jobs` shows
//! the first six and `/retry` accepts any unambiguous prefix. **Ambiguous is refused, never
//! guessed**: retrying the wrong job re-sends a message you did not mean to send, and "which of
//! these two did you mean" costs one more tap.

use lyra_db::jobs::{Job, Queue, Retried, SqliteQueue, Status, now_secs};

use crate::AppState;

/// Characters of id shown. Six hex digits is sixteen million values, so among the few dozen
/// recent jobs a collision is vanishingly rare — and a collision is refused, not guessed.
const SHORT: usize = 6;

/// How far back a prefix is looked for. Retrying a job from last month is a desk task.
const SEARCH: usize = 100;

pub const COMMANDS: &[(&str, &str)] = &[
    ("jobs", "What the queue is doing"),
    ("retry", "Run a failed job again — /retry <id>"),
    ("cancel", "Drop a queued job — /cancel <id>"),
];

pub fn handles(command: &str) -> bool {
    COMMANDS.iter().any(|(name, _)| *name == command)
}

fn short(id: &str) -> &str {
    &id[..id.len().min(SHORT)]
}

pub async fn reply(state: &AppState, command: &str, argument: Option<&str>) -> Option<String> {
    let queue = SqliteQueue::new(state.pool.clone());
    Some(match command {
        "jobs" => list(&queue).await,
        "retry" => retry(&queue, argument).await,
        "cancel" => cancel(&queue, argument).await,
        _ => return None,
    })
}

async fn list(queue: &SqliteQueue) -> String {
    let (Ok(age), Ok(recent)) = (queue.age(now_secs()).await, queue.recent(8).await) else {
        return "I could not read the queue.".into();
    };

    let mut out = format!(
        "Queue — {} waiting, {} running, {} failed\n",
        age.queued, age.running, age.failed
    );
    if let Some(wait) = age.oldest_queued_secs {
        out.push_str(&format!("oldest waiting {}s\n", wait));
    }
    if recent.is_empty() {
        out.push_str("\nNothing has run yet.");
        return out;
    }
    out.push('\n');
    for job in &recent {
        out.push_str(&format!("{}  {}  {}\n", short(&job.id), job.status.as_str(), job.kind));
    }
    // Said once, at the bottom, rather than as a column: the reason is what you act on, and only
    // failures have one.
    if let Some(dead) = recent.iter().find(|j| j.status == Status::Failed) {
        out.push_str(&format!(
            "\n{} failed: {}\n/retry {}",
            short(&dead.id),
            dead.last_error.as_deref().unwrap_or("no reason recorded"),
            short(&dead.id)
        ));
    }
    out.trim_end().to_string()
}

/// Resolve a typed prefix to one job, or explain why not.
async fn resolve(queue: &SqliteQueue, argument: Option<&str>, verb: &str) -> Result<Job, String> {
    let prefix = argument
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .ok_or_else(|| format!("Which one? /{verb} <id> — /jobs shows the ids."))?
        .to_lowercase();

    let recent = queue
        .recent(SEARCH)
        .await
        .map_err(|_| "I could not read the queue.".to_string())?;
    let mut matches = recent.into_iter().filter(|j| j.id.to_lowercase().starts_with(&prefix));

    match (matches.next(), matches.next()) {
        (Some(job), None) => Ok(job),
        (None, _) => Err(format!("No recent job starts with {prefix}.")),
        // Refused, never guessed: the wrong job re-sends a message you did not mean to send.
        (Some(a), Some(b)) => Err(format!(
            "{prefix} matches more than one job ({} and {}). Type a few more characters.",
            short(&a.id),
            short(&b.id)
        )),
    }
}

async fn retry(queue: &SqliteQueue, argument: Option<&str>) -> String {
    let job = match resolve(queue, argument, "retry").await {
        Ok(job) => job,
        Err(why) => return why,
    };
    match queue.retry(&job.id, now_secs()).await {
        Ok(Retried::Queued(new)) if new.created => {
            format!("Retrying {} as {}.", job.kind, short(&new.id))
        }
        // A second /retry of the same job — the connection hiccupped, or it was sent twice.
        Ok(Retried::Queued(new)) => format!("Already retrying — {}.", short(&new.id)),
        Ok(Retried::NotRetryable(status)) => format!(
            "{} is {}. Only failed or cancelled jobs can be retried.",
            short(&job.id),
            status.as_str()
        ),
        Ok(Retried::NotFound) => "That job has gone.".into(),
        Err(_) => "I could not retry it.".into(),
    }
}

async fn cancel(queue: &SqliteQueue, argument: Option<&str>) -> String {
    let job = match resolve(queue, argument, "cancel").await {
        Ok(job) => job,
        Err(why) => return why,
    };
    match queue.cancel(&job.id, now_secs()).await {
        Ok(true) => format!("Cancelled {} ({}).", short(&job.id), job.kind),
        Ok(false) => format!(
            "{} is {}. Only a job still waiting can be cancelled.",
            short(&job.id),
            job.status.as_str()
        ),
        Err(_) => "I could not cancel it.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Failure, Lane, NewJob};
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqliteQueue) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        (dir, SqliteQueue::new(pool))
    }

    async fn dead(q: &SqliteQueue, kind: &str) -> String {
        let job = q.enqueue(&NewJob::new(kind, Lane::Deliver).max_attempts(1), 1000).await.unwrap();
        let claimed = q.claim("w", &[Lane::Deliver], 60, 1100).await.unwrap().unwrap();
        q.fail("w", &claimed.id, "telegram is down", Failure::Retry, 1200).await.unwrap();
        job.id
    }

    #[tokio::test]
    async fn jobs_names_the_failure_and_the_command_that_fixes_it() {
        let (_dir, q) = fresh().await;
        let id = dead(&q, "deliver.telegram").await;
        let text = list(&q).await;
        assert!(text.contains("1 failed"), "{text}");
        assert!(text.contains("telegram is down"), "{text}");
        assert!(text.contains(&format!("/retry {}", short(&id))), "{text}");
    }

    #[tokio::test]
    async fn a_prefix_is_enough_to_retry() {
        let (_dir, q) = fresh().await;
        let id = dead(&q, "deliver.telegram").await;
        let reply = retry(&q, Some(short(&id))).await;
        assert!(reply.starts_with("Retrying deliver.telegram"), "{reply}");
        // Sent twice from a bad connection: one retry, and it says so.
        assert!(retry(&q, Some(short(&id))).await.starts_with("Already retrying"));
    }

    #[tokio::test]
    async fn an_ambiguous_prefix_is_refused_not_guessed() {
        // Ids are pinned rather than left random. The first version of this test looked for a
        // collision among real UUIDs and asserted nothing when it did not find one — a test that
        // can pass without checking anything is worse than no test.
        let (_dir, q) = fresh().await;
        let pool = q.pool().clone();
        for (kind, id) in [("a", "abc111"), ("b", "abc222")] {
            let old = dead(&q, kind).await;
            sqlx::query("UPDATE jobs SET id = ? WHERE id = ?")
                .bind(id)
                .bind(&old)
                .execute(&pool)
                .await
                .unwrap();
        }

        let reply = retry(&q, Some("abc")).await;
        assert!(reply.contains("matches more than one"), "{reply}");
        assert!(reply.contains("abc111") && reply.contains("abc222"), "and it names both: {reply}");

        // One more character and it is no longer a guess.
        assert!(retry(&q, Some("abc1")).await.starts_with("Retrying a"));

        // No argument at all asks rather than picking.
        assert!(retry(&q, None).await.contains("Which one?"));
    }

    #[tokio::test]
    async fn a_waiting_job_can_be_cancelled_and_a_dead_one_cannot() {
        let (_dir, q) = fresh().await;
        let waiting = q.enqueue(&NewJob::new("digest.daily", Lane::Batch), 1000).await.unwrap();
        assert!(cancel(&q, Some(short(&waiting.id))).await.starts_with("Cancelled"));

        let id = dead(&q, "deliver.telegram").await;
        let reply = cancel(&q, Some(short(&id))).await;
        assert!(reply.contains("failed"), "{reply}");
        assert!(reply.contains("Only a job still waiting"), "{reply}");
    }

    #[tokio::test]
    async fn an_unknown_prefix_says_so() {
        let (_dir, q) = fresh().await;
        assert!(retry(&q, Some("zzzzzz")).await.contains("No recent job starts with zzzzzz"));
    }

    #[tokio::test]
    async fn an_empty_queue_is_described_rather_than_blank() {
        let (_dir, q) = fresh().await;
        assert!(list(&q).await.contains("Nothing has run yet"));
    }
}
