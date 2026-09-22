//! What Lyra can tell you about your *life*, over Telegram.
//!
//! `wealth` answers the money questions; this answers the rest — what is due, what is next, what
//! is sitting in the inbox. Read-only, deliberately and for now: writing from a phone is real, but
//! it wants confirmation, an undo and an audit row, and none of those exist yet. A bot that can
//! only tell you things is useful on day one and cannot ruin your week.
//!
//! # Written for a phone, not a terminal
//!
//! Every reply here is sized to be read without scrolling: a handful of lines, the count when
//! there are more, and never a wall. A message you have to scroll on a lock screen is one you deal
//! with later, at which point the bot has bought you nothing.
//!
//! Plain text, not Markdown. It goes out through [`Message::plain`], which escapes — a task called
//! `*urgent*` or one with an underscore in a filename would otherwise either break the formatting
//! or silently vanish into it.

use lyra_db::life::{self, Entity, EntityOrder, EntityQuery};
use sqlx::SqlitePool;

use crate::AppState;
use crate::bot_text;

/// How many rows one reply lists before it starts counting instead.
///
/// Six fits a lock screen. Past that the useful thing is the number, not the seventh line.
const SHOWN: usize = 6;

/// The commands this module answers, in the order `/help` lists them.
pub const COMMANDS: &[(&str, &str)] = &[
    ("today", "Overdue, due today, in flight"),
    ("next", "The few things to do next"),
    ("inbox", "What you captured and have not filed"),
    ("week", "Due in the next seven days"),
];

pub fn handles(command: &str) -> bool {
    COMMANDS.iter().any(|(name, _)| *name == command)
}

/// Answer one command, or `None` if it is not ours.
pub async fn reply(state: &AppState, command: &str, owner: &str, day: &str) -> Option<String> {
    Some(match command {
        "today" => today(&state.pool, owner, day).await,
        "next" => next(&state.pool, owner).await,
        "inbox" => inbox(&state.pool, owner).await,
        "week" => week(&state.pool, owner, day).await,
        _ => return None,
    })
}

/// What a task is, and the one qualifier that changes what you do about it.
fn label(entity: &Entity) -> String {
    let title = bot_text::title(entity.title.as_deref());
    match entity.priority.as_deref() {
        Some(p @ ("urgent" | "high")) => format!("{title}  ({p})"),
        _ => title,
    }
}

fn line(entity: &Entity) -> String {
    format!("• {}", label(entity))
}

/// A section, or nothing at all when it is empty.
///
/// An empty section printed as a heading with nothing under it is the most common way a status
/// message becomes unreadable: five headings, one of which matters.
fn section(heading: &str, rows: &[Entity]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    format!("{heading}\n{}\n\n", bot_text::bullets(rows, SHOWN, line))
}

async fn today(pool: &SqlitePool, owner: &str, day: &str) -> String {
    let Ok(agenda) = life::agenda(pool, owner, day, 50).await else {
        return "I could not read the agenda.".into();
    };

    let mut out = format!("Today — {day}\n\n");
    out.push_str(&section("Overdue", &agenda.overdue));
    out.push_str(&section("Due today", &agenda.due_today));
    out.push_str(&section("In flight", &agenda.in_progress));

    if !agenda.habits_due.is_empty() {
        out.push_str(&format!("Habits due: {}\n\n", agenda.habits_due.len()));
    }

    // Said rather than left as an empty message. "Nothing due" is an answer; a blank reply is a
    // bug you then go and check the server for.
    if agenda.overdue.is_empty() && agenda.due_today.is_empty() && agenda.in_progress.is_empty() {
        out.push_str("Nothing due today.\n\n");
    }

    if !agenda.upcoming.is_empty() {
        out.push_str(&format!("Next 7 days: {} item(s) — /week\n", agenda.upcoming.len()));
    }
    out.trim_end().to_string()
}

/// Ranking for `/next`, since the store has no priority order.
///
/// `EntityOrder` is `Recent` or `Due` and deliberately nothing else — a due order that carried
/// undated rows would need a NULL group with no stable cursor key. So the sort happens here, over
/// one page, which is honest about what it is: a ranking of the recent, not of everything.
fn rank(entity: &Entity) -> u8 {
    match entity.priority.as_deref() {
        Some("urgent") => 0,
        Some("high") => 1,
        Some("medium") => 2,
        _ => 3,
    }
}

async fn next(pool: &SqlitePool, owner: &str) -> String {
    let query = EntityQuery {
        kind: Some("task".into()),
        statuses: vec!["todo".into(), "in-progress".into()],
        order: EntityOrder::Recent,
        // Wider than SHOWN so the ranking below has something to rank. Still one page: `/next` is
        // "what should I pick up", not an inventory.
        limit: 50,
        ..Default::default()
    };
    match life::list_entities(pool, owner, &query).await {
        Ok(page) if page.rows.is_empty() => "Nothing open. Enjoy it.".into(),
        Ok(page) => {
            let mut rows = page.rows;
            // Stable, so equal priorities keep the store's recency order rather than shuffling
            // between two identical calls.
            rows.sort_by_key(rank);
            // Truncated before rendering, not counted: the page is only the recent fifty, so
            // "…and 44 more" would be a number about the query rather than about your work.
            rows.truncate(SHOWN);
            format!("Next\n\n{}", bot_text::bullets(&rows, SHOWN, line))
        }
        Err(_) => "I could not read your tasks.".into(),
    }
}

async fn inbox(pool: &SqlitePool, owner: &str) -> String {
    // Captured-but-unfiled is `metadata.isInbox`, which is what every capture path sets — the
    // web app's ⌘K and the Telegram capture that will land here later.
    //
    // Filtered in the query. It used to fetch the fifty newest to-dos and keep the inbox ones in
    // Rust, which could only ever see inbox items that happened to be among those fifty — so with
    // enough filed work on top, a full inbox answered "Inbox is empty."
    let query = EntityQuery {
        statuses: vec!["todo".into()],
        inbox_only: true,
        order: EntityOrder::Recent,
        limit: 50,
        ..Default::default()
    };
    match life::list_entities(pool, owner, &query).await {
        Ok(page) if page.rows.is_empty() => "Inbox is empty.".into(),
        Ok(page) => format!(
            "Inbox — {}\n\n{}",
            page.rows.len(),
            bot_text::bullets(&page.rows, SHOWN, line)
        ),
        Err(_) => "I could not read your inbox.".into(),
    }
}

async fn week(pool: &SqlitePool, owner: &str, day: &str) -> String {
    let Ok(agenda) = life::agenda(pool, owner, day, 50).await else {
        return "I could not read the week.".into();
    };
    if agenda.upcoming.is_empty() {
        return "Nothing due in the next seven days.".into();
    }
    let rows = bot_text::bullets(&agenda.upcoming, SHOWN * 2, |entity| {
        format!("{}  {}", entity.due_day().unwrap_or(""), label(entity))
    });
    format!("Next 7 days\n\n{rows}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::open_and_migrate;
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        sqlx::query("INSERT INTO users (id, name, role) VALUES ('me', 'Me', 'user')")
            .execute(&pool)
            .await
            .unwrap();
        (dir, pool)
    }

    #[allow(clippy::too_many_arguments)]
    async fn task(
        pool: &SqlitePool,
        id: &str,
        title: &str,
        status: &str,
        priority: &str,
        due: Option<&str>,
        metadata: &str,
    ) {
        sqlx::query(
            "INSERT INTO entities (id, type, title, status, priority, ownerId, visibility, \
             dueDate, createdAt, updatedAt, metadata) \
             VALUES (?, 'task', ?, ?, ?, 'me', 'private', ?, '2026-09-01', '2026-09-01', ?)",
        )
        .bind(id)
        .bind(title)
        .bind(status)
        .bind(priority)
        .bind(due)
        .bind(metadata)
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_empty_day_says_so_rather_than_replying_with_nothing() {
        // A blank reply is indistinguishable from a broken bot, and you go and check the server.
        let (_dir, pool) = fresh().await;
        let reply = today(&pool, "me", "2026-09-21").await;
        assert!(reply.contains("Nothing due today"), "got: {reply}");
    }

    #[tokio::test]
    async fn today_leads_with_overdue_because_it_is_the_only_part_that_is_a_problem() {
        let (_dir, pool) = fresh().await;
        task(&pool, "t1", "file the accounts", "todo", "high", Some("2026-09-01"), "{}").await;
        task(&pool, "t2", "water the plants", "todo", "low", Some("2026-09-21"), "{}").await;

        let reply = today(&pool, "me", "2026-09-21").await;
        let overdue = reply.find("Overdue").expect("an overdue section");
        let due = reply.find("Due today").expect("a due-today section");
        assert!(overdue < due, "overdue must come first:\n{reply}");
        assert!(reply.contains("file the accounts"));
        assert!(reply.contains("water the plants"));
    }

    #[tokio::test]
    async fn an_empty_section_is_omitted_rather_than_printed_as_a_bare_heading() {
        let (_dir, pool) = fresh().await;
        task(&pool, "t1", "only this", "todo", "medium", Some("2026-09-21"), "{}").await;

        let reply = today(&pool, "me", "2026-09-21").await;
        // Five headings, one of which matters, is how a status message becomes unreadable.
        assert!(!reply.contains("Overdue"), "got:\n{reply}");
        assert!(reply.contains("Due today"));
    }

    #[tokio::test]
    async fn next_ranks_by_priority_even_though_the_store_cannot() {
        let (_dir, pool) = fresh().await;
        task(&pool, "t1", "someday thing", "todo", "low", None, "{}").await;
        task(&pool, "t2", "the fire", "todo", "urgent", None, "{}").await;
        task(&pool, "t3", "middling", "todo", "medium", None, "{}").await;

        let reply = next(&pool, "me").await;
        let fire = reply.find("the fire").expect("the urgent one");
        let someday = reply.find("someday thing").expect("the low one");
        assert!(fire < someday, "urgent must lead:\n{reply}");
    }

    #[tokio::test]
    async fn next_says_something_when_there_is_nothing() {
        let (_dir, pool) = fresh().await;
        assert!(next(&pool, "me").await.contains("Nothing open"));
    }

    #[tokio::test]
    async fn done_work_stays_off_the_list() {
        let (_dir, pool) = fresh().await;
        task(&pool, "t1", "already finished", "done", "urgent", Some("2026-09-21"), "{}").await;
        let reply = today(&pool, "me", "2026-09-21").await;
        assert!(!reply.contains("already finished"), "got:\n{reply}");
    }

    #[tokio::test]
    async fn the_inbox_is_only_what_was_captured_and_not_filed() {
        let (_dir, pool) = fresh().await;
        task(&pool, "t1", "captured thought", "todo", "medium", None, r#"{"isInbox":true}"#).await;
        task(&pool, "t2", "a filed task", "todo", "medium", None, "{}").await;

        let reply = inbox(&pool, "me").await;
        assert!(reply.contains("captured thought"), "got:\n{reply}");
        assert!(
            !reply.contains("a filed task"),
            "an inbox that shows filed work has undone the point of filing:\n{reply}"
        );
    }

    #[tokio::test]
    async fn an_old_inbox_item_is_found_under_a_pile_of_newer_filed_work() {
        // The bug the SQL filter closes. The inbox used to be the fifty newest to-dos with the
        // non-inbox ones dropped in Rust, so sixty filed tasks on top of one captured thought made
        // a non-empty inbox answer "Inbox is empty."
        let (_dir, pool) = fresh().await;
        for n in 0..60 {
            task(&pool, &format!("filed-{n}"), "filed work", "todo", "medium", None, "{}").await;
        }
        sqlx::query(
            "INSERT INTO entities (id, type, title, status, ownerId, visibility, createdAt, \
             updatedAt, metadata) VALUES ('old', 'note', 'the captured thought', 'todo', 'me', \
             'private', '2026-01-01', '2026-01-01', '{\"isInbox\":true}')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let reply = inbox(&pool, "me").await;
        assert!(reply.contains("the captured thought"), "got:\n{reply}");
        assert!(!reply.contains("filed work"), "and only inbox items: {reply}");
    }

    #[tokio::test]
    async fn another_persons_task_is_never_answered() {
        let (_dir, pool) = fresh().await;
        sqlx::query(
            "INSERT INTO entities (id, type, title, status, ownerId, visibility, dueDate, \
             createdAt, updatedAt) VALUES ('x', 'task', 'their secret', 'todo', 'someone-else', \
             'private', '2026-09-21', '2026-09-01', '2026-09-01')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let reply = today(&pool, "me", "2026-09-21").await;
        assert!(!reply.contains("their secret"), "got:\n{reply}");
    }

    #[test]
    fn a_long_title_is_cut_on_characters_not_bytes() {
        // A title of emoji is four bytes a character; cutting on bytes could split a codepoint.
        let entity = Entity {
            id: "t".into(),
            r#type: Some("task".into()),
            title: Some("🙂".repeat(80)),
            description: None,
            status: None,
            priority: None,
            tags: None,
            metadata: None,
            parent_id: None,
            owner_id: None,
            visibility: None,
            due_date: None,
            created_at: None,
            updated_at: None,
        };
        let rendered = line(&entity);
        assert!(rendered.ends_with('…'));
        assert_eq!(rendered.chars().filter(|c| *c == '🙂').count(), 59);
    }

    #[test]
    fn every_advertised_command_is_actually_handled() {
        // The help text and the dispatcher drifting apart is how a bot ends up advertising a
        // command that answers "I don't know that".
        for (name, _) in COMMANDS {
            assert!(handles(name), "/{name} is advertised but not handled");
        }
    }
}
