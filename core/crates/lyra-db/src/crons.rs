//! Scheduled work you can configure, rather than restart to change.
//!
//! Lyra already has a cron runner — it is just written out four times. `alert_loop` ticks every
//! thirty seconds and asks `maybe_digest`, `maybe_nudge`, `maybe_snapshot` and `sweep` whether they
//! are due; each decides from an environment variable, builds a key naming the occurrence, and calls
//! `enqueue_once`. The robustness is already there and proven. What is missing is that the
//! *schedule* is a constant, so changing when your brief arrives means editing a file and
//! reinstalling.
//!
//! This is the same four moves with the schedule as a row.
//!
//! ## The clock is passed in, not read
//!
//! [`Schedule::due`] takes a [`Now`] rather than reaching for the system clock, so every case below
//! — a missed morning, an hour that repeats, a schedule saved at 23:59 — is a test with plain
//! numbers instead of a test that waits. It also keeps `chrono` out of this crate: the caller
//! already has a local clock and knows more about it than storage should.
//!
//! `lyra-alerts`' own `digest_due(enabled, hour, now_hour, today, last_sent)` is the same shape, for
//! the same reason.
//!
//! ## Exactly-once is the key, not a flag
//!
//! Every firing names its occurrence — `2026-09-27T07:30` — and the job is enqueued under
//! `<action>:<cron id>:<occurrence>`. The partial unique index on `idempotency_key` then makes every
//! tick inside the window produce the same single job, which is precisely how the daily brief
//! already works. `last_occurrence` on the row is for showing you when it last ran; it is not what
//! makes the firing unique.

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

/// The clock facts a schedule needs, in local time.
///
/// Local because these are wall-clock ideas: "07:30" means the number on the clock in the room, and
/// "Monday" means the day it is where you are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Now {
    /// Unix seconds. Only [`Schedule::Every`] uses it.
    pub epoch: i64,
    /// Local date, `YYYY-MM-DD`. Part of the occurrence name.
    pub date: String,
    /// Local minutes since midnight, 0–1439.
    pub minute_of_day: i64,
    /// Local weekday, 0 = Monday.
    pub weekday: u8,
}

/// When something should happen.
///
/// Structured rather than a cron string. A mis-typed `30 7 * * 1-5` fails by your brief silently
/// never arriving, which is the one failure this feature cannot have; and a structured value renders
/// itself in the UI without a parser. A `Cron(String)` variant can join this later for the cases
/// these three cannot express — it is an addition, not a rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Schedule {
    /// Every day at a local time.
    Daily { at_minute: i64 },
    /// On the given local weekdays (0 = Monday) at a local time.
    Weekly { days: Vec<u8>, at_minute: i64 },
    /// Every N seconds, on a fixed grid from the epoch.
    Every { seconds: i64 },
}

/// What a tick should do about one cron.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Due {
    /// Fire, under this occurrence name.
    Fire {
        occurrence: String,
    },
    /// The occurrence passed while nothing was running, and it is now too late to be useful.
    ///
    /// Recorded rather than dropped. A notification that does not arrive is this feature's worst
    /// failure, and one that silently *never* arrives is worse than one that arrives late — so a
    /// skip is a number on the row and a line in the log, not nothing.
    Missed {
        occurrence: String,
        late_by_minutes: i64,
    },
    NotYet,
}

impl Schedule {
    /// Reject a schedule that cannot ever fire, so the refusal happens at the form rather than as
    /// silence a week later.
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Daily { at_minute } => {
                if !(0..1440).contains(at_minute) {
                    bail!("a time of day is 0-1439 minutes past midnight, not {at_minute}");
                }
            }
            Self::Weekly { days, at_minute } => {
                if !(0..1440).contains(at_minute) {
                    bail!("a time of day is 0-1439 minutes past midnight, not {at_minute}");
                }
                if days.is_empty() {
                    bail!("a weekly schedule with no days never fires");
                }
                if let Some(bad) = days.iter().find(|d| **d > 6) {
                    bail!("a weekday is 0-6, Monday to Sunday, not {bad}");
                }
            }
            Self::Every { seconds } => {
                // A floor, because a schedule that fires faster than the tick would fire once per
                // tick and read as "every 30 seconds" whatever it said.
                if *seconds < 60 {
                    bail!("the shortest interval is 60 seconds, not {seconds}");
                }
            }
        }
        Ok(())
    }

    /// Whether this cron should fire now, and under what name.
    ///
    /// `last_occurrence` is the last name this cron fired under, which is what stops a schedule
    /// firing repeatedly through its own minute. `catch_up_minutes` is how late a firing may be and
    /// still be worth doing: a digest at 11:00 is still useful, a "start your day" nudge is not, so
    /// it is per-cron rather than a constant.
    pub fn due(&self, now: &Now, last_occurrence: Option<&str>, catch_up_minutes: i64) -> Due {
        match self {
            Self::Daily { at_minute } => {
                self.at_time(now, *at_minute, last_occurrence, catch_up_minutes)
            }
            Self::Weekly { days, at_minute } => {
                if !days.contains(&now.weekday) {
                    return Due::NotYet;
                }
                self.at_time(now, *at_minute, last_occurrence, catch_up_minutes)
            }
            Self::Every { seconds } => {
                let seconds = (*seconds).max(1);
                // A grid rather than "last fired plus N": a box that was off for an hour resumes on
                // the same boundaries instead of drifting by however long it was down.
                let bucket = now.epoch / seconds;
                let occurrence = format!("every:{bucket}");
                if last_occurrence == Some(occurrence.as_str()) {
                    Due::NotYet
                } else {
                    // No catch-up concept: an interval's whole meaning is "again by now", and the
                    // current bucket is always the current one.
                    Due::Fire { occurrence }
                }
            }
        }
    }

    fn at_time(
        &self,
        now: &Now,
        at_minute: i64,
        last_occurrence: Option<&str>,
        catch_up_minutes: i64,
    ) -> Due {
        if now.minute_of_day < at_minute {
            return Due::NotYet;
        }
        // Named by the local date and the *scheduled* time, not the time it actually ran. That is
        // what makes a retry at 09:15 the same occurrence as the 07:30 it is retrying, and what
        // makes an hour that repeats — a clock going back — fire once rather than twice.
        let occurrence = format!("{}T{:02}:{:02}", now.date, at_minute / 60, at_minute % 60);
        if last_occurrence == Some(occurrence.as_str()) {
            return Due::NotYet;
        }
        let late_by_minutes = now.minute_of_day - at_minute;
        if late_by_minutes > catch_up_minutes {
            Due::Missed {
                occurrence,
                late_by_minutes,
            }
        } else {
            Due::Fire { occurrence }
        }
    }

    /// How this reads to a person, for the UI and the log.
    pub fn describe(&self) -> String {
        const DAY: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
        match self {
            Self::Daily { at_minute } => {
                format!("every day at {:02}:{:02}", at_minute / 60, at_minute % 60)
            }
            Self::Weekly { days, at_minute } => {
                let named: Vec<&str> = days
                    .iter()
                    .filter_map(|d| DAY.get(*d as usize).copied())
                    .collect();
                format!(
                    "{} at {:02}:{:02}",
                    named.join(", "),
                    at_minute / 60,
                    at_minute % 60
                )
            }
            Self::Every { seconds } => match seconds {
                s if s % 3600 == 0 => format!("every {} hours", s / 3600),
                s if s % 60 == 0 => format!("every {} minutes", s / 60),
                s => format!("every {s} seconds"),
            },
        }
    }
}

/// One scheduled thing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Cron {
    pub id: String,
    pub name: String,
    pub schedule: Schedule,
    /// The job kind this queues. Validated against the handler registry on write, or a typo becomes
    /// jobs that dead-letter forever.
    pub action: String,
    /// Handed to the job as its payload.
    pub payload: serde_json::Value,
    pub enabled: bool,
    /// How late a firing may be and still happen.
    pub catch_up_minutes: i64,
    pub last_occurrence: Option<String>,
    pub last_fired_at: Option<i64>,
    pub missed: i64,
    pub last_missed_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct CronInput {
    pub name: String,
    pub schedule: Schedule,
    pub action: String,
    pub payload: serde_json::Value,
    pub catch_up_minutes: i64,
}

/// A change to a cron. Absent means unchanged, which is also the HTTP body's shape.
#[derive(Debug, Clone, Default)]
pub struct CronPatch {
    pub name: Option<String>,
    pub schedule: Option<Schedule>,
    pub payload: Option<serde_json::Value>,
    pub enabled: Option<bool>,
    pub catch_up_minutes: Option<i64>,
}

pub struct CronStore {
    pool: SqlitePool,
}

impl CronStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> Result<Vec<Cron>> {
        let rows = sqlx::query(
            "SELECT id, name, schedule, action, payload, enabled, catch_up_minutes,
                    last_occurrence, last_fired_at, missed, last_missed_at
               FROM crons ORDER BY name",
        )
        .fetch_all(&self.pool)
        .await
        .context("listing crons")?;
        Ok(rows.iter().filter_map(row_to_cron).collect())
    }

    /// Only the ones a tick should consider.
    pub async fn enabled(&self) -> Result<Vec<Cron>> {
        Ok(self
            .list()
            .await?
            .into_iter()
            .filter(|c| c.enabled)
            .collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<Cron>> {
        let row = sqlx::query(
            "SELECT id, name, schedule, action, payload, enabled, catch_up_minutes,
                    last_occurrence, last_fired_at, missed, last_missed_at
               FROM crons WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .context("reading a cron")?;
        Ok(row.as_ref().and_then(row_to_cron))
    }

    pub async fn create(&self, input: &CronInput, now: i64) -> Result<Cron> {
        input.schedule.validate()?;
        let id = format!("cron-{}", crate::channels::random_id());
        sqlx::query(
            "INSERT INTO crons (id, name, schedule, action, payload, enabled, catch_up_minutes,
                                missed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)",
        )
        .bind(&id)
        .bind(&input.name)
        .bind(serde_json::to_string(&input.schedule)?)
        .bind(&input.action)
        .bind(serde_json::to_string(&input.payload)?)
        .bind(input.catch_up_minutes)
        .bind(now)
        .bind(now)
        .execute(&self.pool)
        .await
        .context("creating a cron")?;
        self.get(&id)
            .await?
            .context("the cron vanished when written")
    }

    /// Apply a patch. Every field is optional, and absent means unchanged.
    ///
    /// Each field is its own statement with literal SQL. Building one `SET` clause from a list would
    /// be shorter and this crate refuses it — `sqlx` rejects a formatted query string outright, which
    /// is a guard worth keeping even where the fragment is a local constant, because the next person
    /// to reach for that shortcut may not have a local constant.
    pub async fn update(&self, id: &str, patch: &CronPatch, now: i64) -> Result<Option<Cron>> {
        if self.get(id).await?.is_none() {
            return Ok(None);
        }
        if let Some(schedule) = &patch.schedule {
            schedule.validate()?;
            // The occurrence name is derived from the schedule, so changing the schedule invalidates
            // it: keeping the old one could suppress the very first firing of the new time, which
            // reads as "I changed it and nothing happened".
            sqlx::query(
                "UPDATE crons SET schedule = ?, last_occurrence = NULL, updated_at = ?
                  WHERE id = ?",
            )
            .bind(serde_json::to_string(schedule)?)
            .bind(now)
            .bind(id)
            .execute(&self.pool)
            .await
            .context("changing a schedule")?;
        }
        if let Some(name) = &patch.name {
            sqlx::query("UPDATE crons SET name = ?, updated_at = ? WHERE id = ?")
                .bind(name)
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("renaming a cron")?;
        }
        if let Some(payload) = &patch.payload {
            sqlx::query("UPDATE crons SET payload = ?, updated_at = ? WHERE id = ?")
                .bind(serde_json::to_string(payload)?)
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("changing a payload")?;
        }
        if let Some(enabled) = patch.enabled {
            sqlx::query("UPDATE crons SET enabled = ?, updated_at = ? WHERE id = ?")
                .bind(i64::from(enabled))
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("enabling a cron")?;
        }
        if let Some(minutes) = patch.catch_up_minutes {
            sqlx::query("UPDATE crons SET catch_up_minutes = ?, updated_at = ? WHERE id = ?")
                .bind(minutes)
                .bind(now)
                .bind(id)
                .execute(&self.pool)
                .await
                .context("changing a catch-up window")?;
        }
        self.get(id).await
    }

    pub async fn delete(&self, id: &str) -> Result<bool> {
        let done = sqlx::query("DELETE FROM crons WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await
            .context("deleting a cron")?;
        Ok(done.rows_affected() > 0)
    }

    /// Record that this cron fired under `occurrence`.
    pub async fn mark_fired(&self, id: &str, occurrence: &str, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE crons SET last_occurrence = ?, last_fired_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(occurrence)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("marking a cron fired")?;
        Ok(())
    }

    /// Record that an occurrence went by unfired.
    ///
    /// `last_occurrence` is set too, so the same missed slot is counted once rather than on every
    /// tick for the rest of the day.
    pub async fn mark_missed(&self, id: &str, occurrence: &str, now: i64) -> Result<()> {
        sqlx::query(
            "UPDATE crons SET last_occurrence = ?, missed = missed + 1, last_missed_at = ?,
                              updated_at = ?
              WHERE id = ?",
        )
        .bind(occurrence)
        .bind(now)
        .bind(now)
        .bind(id)
        .execute(&self.pool)
        .await
        .context("marking a cron missed")?;
        Ok(())
    }
}

fn row_to_cron(row: &sqlx::sqlite::SqliteRow) -> Option<Cron> {
    Some(Cron {
        id: row.get("id"),
        name: row.get("name"),
        // A row whose schedule cannot be parsed is dropped rather than defaulted: a default would
        // fire something at a time nobody chose.
        schedule: serde_json::from_str(&row.get::<String, _>("schedule")).ok()?,
        action: row.get("action"),
        payload: serde_json::from_str(&row.get::<String, _>("payload"))
            .unwrap_or(serde_json::Value::Null),
        enabled: row.get::<i64, _>("enabled") != 0,
        catch_up_minutes: row.get("catch_up_minutes"),
        last_occurrence: row.get("last_occurrence"),
        last_fired_at: row.get("last_fired_at"),
        missed: row.get("missed"),
        last_missed_at: row.get("last_missed_at"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn at(date: &str, hour: i64, minute: i64, weekday: u8) -> Now {
        Now {
            epoch: 1_800_000_000,
            date: date.into(),
            minute_of_day: hour * 60 + minute,
            weekday,
        }
    }

    const DAILY_0730: Schedule = Schedule::Daily {
        at_minute: 7 * 60 + 30,
    };

    #[test]
    fn a_daily_schedule_fires_once_in_its_minute_and_not_again() {
        let now = at("2026-09-27", 7, 30, 6);
        let Due::Fire { occurrence } = DAILY_0730.due(&now, None, 60) else {
            panic!("07:30 should fire at 07:30")
        };
        assert_eq!(occurrence, "2026-09-27T07:30");

        // Same occurrence already fired: every later tick that day is quiet. This is what stops a
        // 30-second tick sending the brief 120 times.
        assert_eq!(
            DAILY_0730.due(&at("2026-09-27", 7, 45, 6), Some(&occurrence), 60),
            Due::NotYet
        );
        // Tomorrow is a different occurrence.
        assert!(matches!(
            DAILY_0730.due(&at("2026-09-28", 7, 30, 0), Some(&occurrence), 60),
            Due::Fire { .. }
        ));
    }

    #[test]
    fn before_its_time_nothing_happens() {
        assert_eq!(
            DAILY_0730.due(&at("2026-09-27", 7, 29, 6), None, 60),
            Due::NotYet
        );
        assert_eq!(
            DAILY_0730.due(&at("2026-09-27", 0, 0, 6), None, 60),
            Due::NotYet
        );
    }

    #[test]
    fn a_slot_that_went_by_while_the_box_was_off_is_recorded_as_missed() {
        // The box came up at 11:00. 07:30 is four hours gone, and a "start your day" nudge at 11:00
        // is noise — but it must be *counted*, because silently never arriving is the failure this
        // feature exists to remove.
        let Due::Missed {
            occurrence,
            late_by_minutes,
        } = DAILY_0730.due(&at("2026-09-27", 11, 0, 6), None, 60)
        else {
            panic!("four hours late is past a one-hour catch-up")
        };
        assert_eq!(occurrence, "2026-09-27T07:30");
        assert_eq!(late_by_minutes, 210);

        // Inside the window it still fires — a brief at 08:20 is worth having.
        assert!(matches!(
            DAILY_0730.due(&at("2026-09-27", 8, 20, 6), None, 60),
            Due::Fire { .. }
        ));
        // And a cron that says "whenever you get to it" has a wide window.
        assert!(matches!(
            DAILY_0730.due(&at("2026-09-27", 11, 0, 6), None, 24 * 60),
            Due::Fire { .. }
        ));
    }

    #[test]
    fn an_hour_that_happens_twice_fires_once() {
        // Clocks go back and 01:30 local happens twice. The occurrence is named by the *scheduled*
        // time and the date, not by the wall clock at the moment of firing, so the second pass
        // matches the name already recorded and stays quiet. Bangkok has no DST, so this is
        // insurance against moving rather than a bug being fixed — which is exactly when it is cheap
        // to get right.
        let schedule = Schedule::Daily { at_minute: 90 };
        let first = at("2026-10-25", 1, 30, 6);
        let Due::Fire { occurrence } = schedule.due(&first, None, 60) else {
            panic!("should fire")
        };
        // The repeat of the same local hour.
        assert_eq!(schedule.due(&first, Some(&occurrence), 60), Due::NotYet);
    }

    #[test]
    fn a_weekly_schedule_only_fires_on_its_days() {
        let weekdays = Schedule::Weekly {
            days: vec![0, 1, 2, 3, 4],
            at_minute: 9 * 60,
        };
        assert!(matches!(
            weekdays.due(&at("2026-09-28", 9, 0, 0), None, 60),
            Due::Fire { .. }
        ));
        // Saturday.
        assert_eq!(
            weekdays.due(&at("2026-10-03", 9, 0, 5), None, 60),
            Due::NotYet
        );
    }

    #[test]
    fn an_interval_rides_a_grid_rather_than_drifting() {
        let every_hour = Schedule::Every { seconds: 3600 };
        let mut now = at("2026-09-27", 12, 0, 6);
        now.epoch = 3600 * 100;
        let Due::Fire { occurrence } = every_hour.due(&now, None, 0) else {
            panic!("should fire")
        };
        assert_eq!(occurrence, "every:100");
        // Still inside the same hour: quiet.
        now.epoch = 3600 * 100 + 1800;
        assert_eq!(every_hour.due(&now, Some(&occurrence), 0), Due::NotYet);
        // Next hour, next bucket — and a box that was off for three hours resumes on the boundary
        // rather than three hours after it came back.
        now.epoch = 3600 * 104;
        assert_eq!(
            every_hour.due(&now, Some(&occurrence), 0),
            Due::Fire {
                occurrence: "every:104".into()
            }
        );
    }

    #[test]
    fn a_schedule_that_could_never_fire_is_refused_at_the_form() {
        assert!(Schedule::Daily { at_minute: 1440 }.validate().is_err());
        assert!(Schedule::Daily { at_minute: -1 }.validate().is_err());
        assert!(
            Schedule::Weekly {
                days: vec![],
                at_minute: 60
            }
            .validate()
            .is_err(),
            "a weekly schedule with no days never fires"
        );
        assert!(
            Schedule::Weekly {
                days: vec![7],
                at_minute: 60
            }
            .validate()
            .is_err()
        );
        assert!(
            Schedule::Every { seconds: 30 }.validate().is_err(),
            "faster than the tick reads as 'every tick' whatever it says"
        );
        assert!(DAILY_0730.validate().is_ok());
        assert!(Schedule::Every { seconds: 60 }.validate().is_ok());
    }

    #[test]
    fn a_schedule_says_what_it_means_in_words() {
        assert_eq!(DAILY_0730.describe(), "every day at 07:30");
        assert_eq!(
            Schedule::Weekly {
                days: vec![0, 4],
                at_minute: 540
            }
            .describe(),
            "Mon, Fri at 09:00"
        );
        assert_eq!(
            Schedule::Every { seconds: 3600 }.describe(),
            "every 1 hours"
        );
        assert_eq!(
            Schedule::Every { seconds: 900 }.describe(),
            "every 15 minutes"
        );
    }

    async fn store() -> (TempDir, CronStore) {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, CronStore::new(pool))
    }

    fn input(name: &str) -> CronInput {
        CronInput {
            name: name.into(),
            schedule: DAILY_0730,
            action: "notify.message".into(),
            payload: serde_json::json!({ "text": "stand up" }),
            catch_up_minutes: 60,
        }
    }

    #[tokio::test]
    async fn a_cron_round_trips_and_records_what_it_did() {
        let (_dir, store) = store().await;
        let made = store.create(&input("stand up"), 1000).await.unwrap();
        assert_eq!(made.schedule, DAILY_0730);
        assert_eq!(made.missed, 0);
        assert!(made.enabled);

        store
            .mark_fired(&made.id, "2026-09-27T07:30", 2000)
            .await
            .unwrap();
        let fired = store.get(&made.id).await.unwrap().unwrap();
        assert_eq!(fired.last_occurrence.as_deref(), Some("2026-09-27T07:30"));
        assert_eq!(fired.last_fired_at, Some(2000));

        store
            .mark_missed(&made.id, "2026-09-28T07:30", 3000)
            .await
            .unwrap();
        let missed = store.get(&made.id).await.unwrap().unwrap();
        assert_eq!(missed.missed, 1);
        assert_eq!(missed.last_missed_at, Some(3000));
        assert_eq!(
            missed.last_occurrence.as_deref(),
            Some("2026-09-28T07:30"),
            "a missed slot is counted once, not on every tick for the rest of the day"
        );
    }

    #[tokio::test]
    async fn changing_the_schedule_forgets_the_last_occurrence() {
        // The occurrence name is derived from the schedule. Keeping the old one could suppress the
        // very first firing of the new time, which reads as "I changed it and nothing happened".
        let (_dir, store) = store().await;
        let made = store.create(&input("brief"), 1000).await.unwrap();
        store
            .mark_fired(&made.id, "2026-09-27T07:30", 2000)
            .await
            .unwrap();

        let moved = store
            .update(
                &made.id,
                &CronPatch {
                    schedule: Some(Schedule::Daily { at_minute: 8 * 60 }),
                    ..Default::default()
                },
                3000,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(moved.schedule, Schedule::Daily { at_minute: 480 });
        assert!(moved.last_occurrence.is_none());
    }

    #[tokio::test]
    async fn only_enabled_crons_reach_a_tick() {
        let (_dir, store) = store().await;
        let on = store.create(&input("on"), 1000).await.unwrap();
        let off = store.create(&input("off"), 1000).await.unwrap();
        store
            .update(
                &off.id,
                &CronPatch {
                    enabled: Some(false),
                    ..Default::default()
                },
                1000,
            )
            .await
            .unwrap();

        let enabled = store.enabled().await.unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, on.id);
        // Disabled, not deleted: the row keeps its schedule so turning it back on does not mean
        // rebuilding it.
        assert_eq!(store.list().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_impossible_schedule_is_refused_on_write() {
        let (_dir, store) = store().await;
        let mut bad = input("never");
        bad.schedule = Schedule::Every { seconds: 5 };
        let refused = store.create(&bad, 1000).await.unwrap_err().to_string();
        assert!(refused.contains("60 seconds"), "{refused}");
        assert!(store.list().await.unwrap().is_empty());
    }
}
