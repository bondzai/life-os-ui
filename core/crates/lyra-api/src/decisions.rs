//! The inbox: what other systems are waiting on you for, and taking your answer.
//!
//! Separate from [`crate::systems`] because the two have different readers. That file is about
//! plumbing — addresses, tokens, whether the factory is up. This one is about the only question a
//! person actually has: **what needs me, and what happens when I say.**
//!
//! # The rule this file exists to hold
//!
//! An answer is **committed here before anything is sent**. A tap that reached Lyra and then
//! vanished because the origin was unreachable is the failure that would make the whole idea
//! untrustworthy — worse than never asking. So `answer` writes the row and returns; delivery is a
//! separate, retrying step (L4), and `delivered_at` is what says it landed.

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lyra_alerts::message::Button;
use lyra_db::jobs::now_secs;
use lyra_db::systems::{Decision, DecisionStore};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::{error, not_found};

/// How many decisions the inbox returns. Generous: this is a page someone reads, and an inbox that
/// silently stops at ten is an inbox that loses things.
const LIMIT: usize = 100;

pub async fn index(_user: AuthUser, State(state): State<AppState>) -> Response {
    let store = DecisionStore::new(state.pool.clone());
    let now = now_secs();
    match store.recent(LIMIT).await {
        Ok(decisions) => {
            let described: Vec<_> = decisions
                .iter()
                .map(|decision| {
                    let mut value = serde_json::to_value(decision).unwrap_or(json!({}));
                    // Computed server-side against one clock. A browser deciding for itself
                    // whether a deadline has passed disagrees with the box that has to act on it.
                    value["expired"] = json!(decision.expired(now));
                    value
                })
                .collect();
            let waiting = decisions.iter().filter(|d| d.answered_at.is_none()).count();
            Json(json!({ "decisions": described, "waiting": waiting })).into_response()
        }
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("listing decisions: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct Answer {
    pub answer: String,
}

pub async fn answer(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Answer>,
) -> Response {
    let store = DecisionStore::new(state.pool.clone());
    let Ok(Some(decision)) = store.get(&id).await else {
        return not_found("no such decision");
    };
    if let Err(why) = offered(&decision, &body.answer) {
        return error(StatusCode::BAD_REQUEST, &why);
    }

    match store.answer(&id, &body.answer, now_secs()).await {
        // Whatever comes back is the *stored* answer, which on a second tap is the first one. The
        // response says what Lyra will actually deliver rather than what this request asked for.
        Ok(Some(answered)) => {
            // Queued, not sent. The row is already written, so this is the fast path and the
            // tick's sweep is the safety net — both produce the same key, so they are one job.
            // A failure here is logged and not surfaced: the answer is committed, the sweep will
            // pick it up, and telling someone their tap failed when it did not is worse.
            use lyra_db::jobs::{Queue, SqliteQueue};
            if let Err(e) = SqliteQueue::new(state.pool.clone())
                .enqueue(&crate::jobs::answer::job(&id), now_secs())
                .await
            {
                tracing::error!(decision = %id, error = %e, "queueing the answer for delivery");
            }
            Json(answered).into_response()
        }
        Ok(None) => not_found("no such decision"),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("answering: {e}"),
        ),
    }
}

/// An answer has to be one the origin offered.
///
/// Free text is refused rather than passed along: the origin published a set of values it knows how
/// to act on, and inventing a new one produces a decision it cannot honour — which fails later,
/// somewhere else, long after the tap that caused it.
fn offered(decision: &Decision, answer: &str) -> Result<(), String> {
    if decision.options.iter().any(|o| o.value == answer) {
        return Ok(());
    }
    let offered: Vec<&str> = decision.options.iter().map(|o| o.value.as_str()).collect();
    Err(format!(
        "{answer:?} is not one of the answers this decision offers: {}",
        offered.join(", ")
    ))
}

/* ─── reaching you ─── */

/// The prefix on a Telegram button's `callback_data`.
///
/// Short because the whole field is capped at **64 bytes** and a decision id already spends 36 of
/// them. That cap is also why the button carries an option *index* rather than the answer's text:
/// an answer like "hold until the Q3 numbers land" would not fit, and Telegram rejects the send
/// rather than truncating.
pub const TAP: &str = "d:";

/// Build the taps for one decision.
pub fn buttons(decision: &Decision) -> Vec<Button> {
    decision
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| Button {
            label: option.label.clone(),
            data: format!("{TAP}{}:{index}", decision.id),
        })
        .collect()
}

/// Read a tap back. `None` for anything that is not one of ours.
pub fn parse_tap(data: &str) -> Option<(String, usize)> {
    let rest = data.strip_prefix(TAP)?;
    // `rsplit_once`, not `split_once`: the index is the last field and a decision id is opaque, so
    // splitting from the left would break the day an id contains a colon.
    let (id, index) = rest.rsplit_once(':')?;
    Some((id.to_string(), index.parse().ok()?))
}

/// What the message says.
///
/// The evidence is in the text rather than only in the app, because the whole point of a tap is
/// answering without opening anything — and answering without the reason is a coin flip.
pub fn announcement(decision: &Decision) -> String {
    let mut out = decision.question.clone();
    if let Some(detail) = &decision.detail {
        out.push_str(&format!("\n{detail}"));
    }
    if let Some(evidence) = &decision.evidence {
        out.push_str(&format!("\n\n{evidence}"));
    }
    // Spelled out as well as attached, so a channel that cannot render buttons — which is every
    // channel but Telegram — still says what the choices are.
    if !decision.options.is_empty() {
        let labels: Vec<&str> = decision.options.iter().map(|o| o.label.as_str()).collect();
        out.push_str(&format!("\n\n{}?", labels.join(" or ")));
    }
    out
}

/// Send one raised decision to whatever the `day` group is routed to.
///
/// Keyed by the decision, so the announcement is queued exactly once however many times something
/// notices it — the same mechanism the daily brief uses. Severity is `info`: a question is not an
/// emergency, and `critical` is the only level that pierces quiet hours.
pub async fn announce(state: &AppState, decision: &Decision) -> usize {
    use lyra_db::channels::Severity;
    use lyra_db::jobs::{Queue, SqliteQueue};

    let queue = SqliteQueue::new(state.pool.clone());
    let now = now_secs();
    let key = format!("decision:{}", decision.id);
    let jobs = crate::notify::deliveries_with(
        state,
        "day",
        Severity::Info,
        Some(&key),
        &announcement(decision),
        crate::jobs::deliver::Markup::Plain,
        &buttons(decision),
    )
    .await;

    let mut queued = 0;
    for job in jobs {
        match queue.enqueue(&job, now).await {
            Ok(enqueued) if enqueued.created => queued += 1,
            Ok(_) => {}
            Err(e) => tracing::error!(decision = %decision.id, error = %e, "announcing a decision"),
        }
    }
    queued
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::systems::{Option_, Raised, SystemInput, SystemStore};
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState, DecisionStore, String) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state =
            AppState::new(pool.clone(), "test-secret".into()).with_secret_key(Some(vec![3u8; 32]));
        let systems = SystemStore::new(pool.clone(), Some(vec![3u8; 32]));
        let sys = systems
            .create(
                &SystemInput {
                    name: "content-factory".into(),
                    base_url: "fixture:///tmp/x.json".into(),
                    token: None,
                    scopes: vec![],
                },
                1000,
            )
            .await
            .unwrap();
        let decisions = DecisionStore::new(pool);
        decisions
            .raise(
                &[Raised {
                    system_id: sys.id.clone(),
                    external_id: "dec-7".into(),
                    question: "castles or alliances?".into(),
                    detail: None,
                    options: vec![
                        Option_ {
                            value: "castles".into(),
                            label: "Castles".into(),
                        },
                        Option_ {
                            value: "alliances".into(),
                            label: "Alliances".into(),
                        },
                    ],
                    evidence: Some("castles tested 9% better".into()),
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

    #[tokio::test]
    async fn a_tap_carries_an_index_because_sixty_four_bytes_is_the_whole_budget() {
        let (_dir, _state, decisions, id) = app().await;
        let decision = decisions.get(&id).await.unwrap().unwrap();
        let taps = buttons(&decision);

        assert_eq!(taps.len(), 2);
        assert_eq!(taps[0].label, "Castles");
        for tap in &taps {
            assert!(
                tap.data.len() <= 64,
                "Telegram rejects callback_data over 64 bytes: {} is {}",
                tap.data,
                tap.data.len()
            );
        }
        assert_eq!(parse_tap(&taps[0].data), Some((id.clone(), 0)));
        assert_eq!(parse_tap(&taps[1].data), Some((id, 1)));
    }

    #[test]
    fn a_tap_that_is_not_ours_is_not_mistaken_for_one() {
        assert_eq!(parse_tap("something:else"), None);
        assert_eq!(parse_tap("d:no-index"), None);
        assert_eq!(parse_tap("d:dec-1:notanumber"), None);
        // An id containing a colon still parses, because the index is taken from the right.
        assert_eq!(
            parse_tap("d:dec:with:colons:2"),
            Some(("dec:with:colons".to_string(), 2))
        );
    }

    #[tokio::test]
    async fn the_message_spells_out_the_options_as_well_as_attaching_them() {
        let (_dir, _state, decisions, id) = app().await;
        let decision = decisions.get(&id).await.unwrap().unwrap();
        let text = announcement(&decision);

        assert!(text.contains("castles or alliances?"), "{text}");
        // The evidence travels with the question — answering without it is a coin flip.
        assert!(text.contains("castles tested 9% better"), "{text}");
        // In words too, because every channel but Telegram ignores the buttons entirely.
        assert!(text.contains("Castles or Alliances?"), "{text}");
    }

    #[tokio::test]
    async fn an_answer_the_origin_never_offered_is_refused_by_name() {
        let (_dir, _state, decisions, id) = app().await;
        let decision = decisions.get(&id).await.unwrap().unwrap();

        let refused = offered(&decision, "burn it down").unwrap_err();
        assert!(refused.contains("burn it down"), "{refused}");
        assert!(
            refused.contains("castles") && refused.contains("alliances"),
            "the refusal names what it would take: {refused}"
        );
        assert!(offered(&decision, "castles").is_ok());
    }

    /// The courier's promise: the tap is written down before anything is sent anywhere.
    #[tokio::test]
    async fn the_answer_is_committed_before_it_is_owed() {
        let (_dir, _state, decisions, id) = app().await;
        decisions.answer(&id, "castles", 1100).await.unwrap();

        let after = decisions.get(&id).await.unwrap().unwrap();
        assert_eq!(after.answer.as_deref(), Some("castles"));
        assert_eq!(
            after.delivered_at, None,
            "committed here, not yet confirmed there"
        );
        assert_eq!(decisions.owed(10).await.unwrap().len(), 1);
    }
}
