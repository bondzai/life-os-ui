//! Carrying an answer back to the system that asked.
//!
//! The last leg of the courier's round trip. You tapped, the row was written, and this is the part
//! that tells content-factory — with the queue's retries behind it, so a factory that is down when
//! you answer is a delay rather than a lost decision.
//!
//! Two properties matter and both come from machinery that already exists:
//!
//! - **One job per decision**, keyed `answer:<decision id>`. The answer endpoint enqueues one
//!   immediately and the sweep enqueues one for anything still owed; the idempotency key collapses
//!   them, so the belt and the braces are the same job.
//! - **Told twice is fine.** If the confirmation is lost after the origin accepted it, the retry
//!   sends the same answer for the same decision id. The origin is asked to be idempotent on that
//!   id, which is cheap for it and the only thing that makes this leg safe to retry at all.

use anyhow::anyhow;
use lyra_db::jobs::{Lane, NewJob};
use lyra_db::systems::{DecisionStore, SystemStore};
use serde_json::json;

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;

pub const KIND: &str = "system.answer";

/// The job that delivers one decision's answer.
///
/// Keyed by the decision rather than by the moment, because "deliver this answer" is one piece of
/// work no matter how many times something notices it is owed.
pub fn job(decision_id: &str) -> NewJob {
    NewJob::new(KIND, Lane::Deliver)
        .payload(json!({ "decision": decision_id }))
        .key(format!("answer:{decision_id}"))
}

pub struct DeliverAnswer {
    state: AppState,
}

impl DeliverAnswer {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for DeliverAnswer {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let id = ctx.require_str("decision")?.to_string();
            let decisions = DecisionStore::new(self.state.pool.clone());
            let systems = SystemStore::new(
                self.state.pool.clone(),
                self.state.secret_key.as_deref().cloned(),
            );

            let Some(decision) = decisions
                .get(&id)
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("reading the decision: {e}")))?
            else {
                // The system was deleted and took its decisions with it. Nothing to deliver and
                // nothing a retry can recover, so this is done rather than failed.
                tracing::info!(decision = %id, "the decision is gone; nothing to deliver");
                return Ok(());
            };

            let Some(answer) = decision.answer.clone() else {
                return Err(HandlerError::Permanent(anyhow!(
                    "decision {id} has no answer to deliver"
                )));
            };
            if decision.delivered_at.is_some() {
                return Ok(());
            }

            let Some(system) = systems
                .get(&decision.system_id)
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("reading the system: {e}")))?
            else {
                tracing::info!(decision = %id, "the system is gone; nothing to deliver");
                return Ok(());
            };

            let token = systems
                .token_of(&system.id)
                .await
                // A missing sealing key is a configuration problem that a retry cannot fix, but it
                // is also one a person fixes in a minute — so it retries rather than dead-letters,
                // and the answer is still owed when they do.
                .map_err(|e| HandlerError::Retry(anyhow!("{e}")))?;

            crate::systems::adapter_for(&system.base_url)
                .deliver(&system, token.as_deref(), &decision, &answer)
                .await
                .map_err(|why| HandlerError::Retry(anyhow!("{why}")))?;

            decisions
                .mark_delivered(&id, lyra_db::jobs::now_secs())
                .await
                .map_err(|e| HandlerError::Retry(anyhow!("marking it delivered: {e}")))?;

            tracing::info!(decision = %id, system = %system.name, answer, "answer delivered");
            Ok(())
        })
    }
}

/// Queue a delivery for every answer the origin has not confirmed.
///
/// The safety net under the enqueue that the answer endpoint already does: an answer given while
/// the database was refusing writes, or while the process was going down, is still owed and this is
/// what notices. Both produce the same key, so the common case costs one no-op insert.
pub async fn sweep(state: &AppState) -> usize {
    use lyra_db::jobs::{Queue, SqliteQueue};

    let decisions = DecisionStore::new(state.pool.clone());
    let owed = match decisions.owed(50).await {
        Ok(owed) if owed.is_empty() => return 0,
        Ok(owed) => owed,
        Err(e) => {
            tracing::error!(error = %e, "reading undelivered answers");
            return 0;
        }
    };

    let queue = SqliteQueue::new(state.pool.clone());
    let now = lyra_db::jobs::now_secs();
    let mut queued = 0;
    for decision in owed {
        match queue.enqueue(&job(&decision.id), now).await {
            Ok(enqueued) if enqueued.created => queued += 1,
            Ok(_) => {}
            Err(e) => tracing::error!(decision = %decision.id, error = %e, "queueing an answer"),
        }
    }
    queued
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::jobs::{Queue, SqliteQueue};
    use lyra_db::systems::{Kind, Option_, Raised, SystemInput};
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState, DecisionStore, String) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state =
            AppState::new(pool.clone(), "test-secret".into()).with_secret_key(Some(vec![4u8; 32]));
        let systems = SystemStore::new(pool.clone(), Some(vec![4u8; 32]));
        let sys = systems
            .create(
                &SystemInput {
                    name: "content-factory".into(),
                    kind: Kind::System,
                    // The stub accepts, which is what lets this exercise the whole leg.
                    base_url: "fixture:///dev/null".into(),
                    ..Default::default()
                },
                1000,
            )
            .await
            .unwrap();
        let decisions = DecisionStore::new(pool);
        decisions
            .raise(
                &[Raised {
                    system_id: sys.id,
                    external_id: "dec-7".into(),
                    question: "castles or alliances?".into(),
                    detail: None,
                    options: vec![Option_ {
                        value: "castles".into(),
                        label: "Castles".into(),
                    }],
                    evidence: None,
                    raised_at: 1000,
                    expires_at: None,
                }],
                1000,
            )
            .await
            .unwrap();
        let id = decisions.open().await.unwrap()[0].id.clone();
        (dir, state, decisions, id)
    }

    async fn run(state: &AppState, decision_id: &str) -> HandlerResult {
        let queue = SqliteQueue::new(state.pool.clone());
        let enqueued = queue.enqueue(&job(decision_id), 2000).await.unwrap();
        let stored = queue.get(&enqueued.id).await.unwrap().unwrap();
        let ctx = JobCtx::for_test(queue, stored, "w".into(), 2000);
        DeliverAnswer::new(state.clone()).run(&ctx).await
    }

    #[tokio::test]
    async fn an_owed_answer_is_delivered_and_stops_being_owed() {
        let (_dir, state, decisions, id) = app().await;
        decisions.answer(&id, "castles", 1100).await.unwrap();
        assert_eq!(decisions.owed(10).await.unwrap().len(), 1);

        assert!(run(&state, &id).await.is_ok());
        assert!(
            decisions.owed(10).await.unwrap().is_empty(),
            "the origin confirmed it"
        );
        assert!(
            decisions
                .get(&id)
                .await
                .unwrap()
                .unwrap()
                .delivered_at
                .is_some()
        );
    }

    /// The belt and the braces are the same job.
    #[tokio::test]
    async fn the_sweep_and_the_endpoint_produce_one_delivery() {
        let (_dir, state, decisions, id) = app().await;
        decisions.answer(&id, "castles", 1100).await.unwrap();
        let queue = SqliteQueue::new(state.pool.clone());

        // What the answer endpoint does, then what the tick does thirty seconds later.
        queue.enqueue(&job(&id), 1100).await.unwrap();
        assert_eq!(sweep(&state).await, 0, "the key collapses the second one");
        assert_eq!(
            queue
                .recent(20)
                .await
                .unwrap()
                .iter()
                .filter(|j| j.kind == KIND)
                .count(),
            1
        );
    }

    /// An unanswered decision has nothing to deliver, and no amount of retrying changes that.
    #[tokio::test]
    async fn a_decision_with_no_answer_is_a_permanent_failure() {
        let (_dir, state, _decisions, id) = app().await;
        match run(&state, &id).await {
            Err(HandlerError::Permanent(e)) => assert!(e.to_string().contains("no answer")),
            other => panic!("expected a permanent failure, got {other:?}"),
        }
    }

    /// A deleted system takes its decisions with it; the job in flight must not dead-letter for it.
    #[tokio::test]
    async fn a_delivery_for_a_decision_that_is_gone_is_done_not_failed() {
        let (_dir, state, decisions, id) = app().await;
        decisions.answer(&id, "castles", 1100).await.unwrap();
        let systems = SystemStore::new(state.pool.clone(), Some(vec![4u8; 32]));
        let sys = systems.list().await.unwrap()[0].id.clone();
        systems.delete(&sys).await.unwrap();

        let outcome = run(&state, &id).await;
        assert!(
            outcome.is_ok(),
            "a question with no asker is finished, not failed: {outcome:?}"
        );
    }
}
