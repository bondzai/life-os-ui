//! `schedule.tick` — notice what recurs, and say so.
//!
//! `schedules` knows a habit is due today. Until now nothing on the server ever looked: the fact
//! reached you only if you opened the habits page or asked `/today`, which means a recurrence you
//! set up precisely because you forget things depended on you remembering to ask.
//!
//! # It reads and it sends. It does not write.
//!
//! In particular it never touches `nextDue`, and that is a rule the schema spells out at
//! `migrations.rs`: `nextDue` is rendered to you on the habits page, so a job writing to it would
//! make you watch your chores silently slide. Advancing a recurrence is something *you* do by
//! completing it; this only notices that you have not.
//!
//! # Off unless you ask for it
//!
//! A second unsolicited daily message is a product decision, not a technical one, so it is behind
//! `HABITS_NUDGE_HOUR` and does nothing at all when that is unset. The digest already earns its
//! place at 08:00; a nudge about chores has to be asked for before it can start arriving.

use anyhow::anyhow;
use lyra_db::jobs::{Lane, NewJob};
use lyra_db::life;

use super::{BoxFuture, Handler, HandlerError, HandlerResult, JobCtx};
use crate::AppState;

/// The job kind. Named in the `jobs` schema comment as an example, and now real.
pub const KIND: &str = "schedule.tick";

/// One nudge a day at most.
pub fn key_for(day: &str) -> String {
    format!("{KIND}:{day}")
}

/// Fewer attempts than the brief. A nudge that misses its morning is worth very little by the
/// afternoon — unlike the digest, which is the day's summary whenever it lands.
pub const ATTEMPTS: i64 = 4;

/// Today's nudge, as a job. Interactive rather than batch: it is short, and it should not wait
/// behind a portfolio read.
pub fn job(day: &str) -> NewJob {
    NewJob::new(KIND, Lane::Interactive)
        .payload(serde_json::json!({ "day": day }))
        .key(key_for(day))
        .max_attempts(ATTEMPTS)
}

/// How many due items the message names before it starts counting.
const SHOWN: usize = 8;

/// The hour to nudge at, or `None` — which is the default, and means never.
pub fn nudge_hour() -> Option<u32> {
    std::env::var("HABITS_NUDGE_HOUR")
        .ok()?
        .trim()
        .parse::<u32>()
        .ok()
        .filter(|hour| *hour < 24)
}

pub struct ScheduleTick {
    state: AppState,
}

impl ScheduleTick {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }
}

impl Handler for ScheduleTick {
    fn kind(&self) -> &'static str {
        KIND
    }

    fn run<'a>(&'a self, ctx: &'a JobCtx) -> BoxFuture<'a, HandlerResult> {
        Box::pin(async move {
            let day = ctx.require_str("day")?;

            let owner = crate::tgbot::owner_user(&self.state.pool)
                .await
                // Permanent: no amount of retrying conjures a user row, and the message says
                // which variable would.
                .map_err(|why| {
                    HandlerError::Permanent(anyhow!(
                        "{why}; set TELEGRAM_OWNER_USER_ID to say whose chores these are"
                    ))
                })?;

            let due = life::list_schedules(&self.state.pool, &owner, None, true, Some(day), 100)
                .await
                .map_err(HandlerError::Retry)?;

            let Some(text) = render(&due, day) else {
                // Nothing due is a fine outcome and not a message. A nudge that arrives every
                // morning to say "nothing" is a nudge you learn to ignore, and then the one that
                // matters is ignored with it.
                return Ok(());
            };

            // A follow-up rather than a send: it is written in the same commit as this job's
            // completion, so the queue cannot end up holding a tick that ran and a message that
            // was never queued. And the send retries on its own schedule — see [`super::deliver`].
            ctx.enqueue(super::deliver::job(text, super::deliver::Markup::Plain));
            Ok(())
        })
    }
}

/// The nudge, or `None` when there is nothing to say.
fn render(due: &[life::Schedule], day: &str) -> Option<String> {
    if due.is_empty() {
        return None;
    }

    let rows = crate::bot_text::bullets(due, SHOWN, |schedule| {
        format!("• {}", crate::bot_text::title(schedule.title.as_deref()))
    });
    Some(format!("Due today — {day}\n\n{rows}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule(title: Option<&str>) -> life::Schedule {
        life::Schedule {
            id: "s1".into(),
            entity_id: Some("e1".into()),
            recurrence: Some("daily".into()),
            next_due: Some("2026-09-21".into()),
            last_completed: None,
            is_active: Some(1),
            title: title.map(str::to_string),
            entity_type: Some("habit".into()),
        }
    }

    #[test]
    fn nothing_due_is_no_message_at_all() {
        // A nudge that arrives every morning to say "nothing" is one you learn to ignore — and
        // then the morning it matters, you ignore that too.
        assert!(render(&[], "2026-09-21").is_none());
    }

    #[test]
    fn a_due_habit_is_named() {
        let text = render(&[schedule(Some("Meditate 10min"))], "2026-09-21").unwrap();
        assert!(text.contains("Meditate 10min"), "got:\n{text}");
        assert!(text.contains("2026-09-21"));
    }

    #[test]
    fn a_long_list_counts_the_tail_rather_than_printing_it() {
        let many: Vec<_> = (0..12)
            .map(|n| schedule(Some(&format!("habit {n}"))))
            .collect();
        let text = render(&many, "2026-09-21").unwrap();
        assert!(text.contains("habit 0"));
        assert!(text.contains("…and 4 more"), "got:\n{text}");
        assert!(
            !text.contains("habit 11"),
            "the tail is counted, not listed"
        );
    }

    #[test]
    fn a_schedule_with_no_title_still_renders() {
        // The join can hand back a row whose entity has no title. Rendering "(untitled)" is worse
        // than a name and much better than a panic or a blank bullet.
        let text = render(&[schedule(None)], "2026-09-21").unwrap();
        assert!(text.contains("(untitled)"), "got:\n{text}");
    }

    #[test]
    fn the_nudge_is_off_unless_an_hour_is_configured() {
        // The default has to be silence: a second unsolicited daily message is a decision the
        // person using this makes, not one the code makes for them.
        unsafe { std::env::remove_var("HABITS_NUDGE_HOUR") };
        assert_eq!(nudge_hour(), None);

        unsafe { std::env::set_var("HABITS_NUDGE_HOUR", "7") };
        assert_eq!(nudge_hour(), Some(7));

        // A typo must read as "off", not as midnight.
        unsafe { std::env::set_var("HABITS_NUDGE_HOUR", "not-an-hour") };
        assert_eq!(nudge_hour(), None);

        unsafe { std::env::set_var("HABITS_NUDGE_HOUR", "24") };
        assert_eq!(nudge_hour(), None, "24 is not an hour");

        unsafe { std::env::remove_var("HABITS_NUDGE_HOUR") };
    }
}
