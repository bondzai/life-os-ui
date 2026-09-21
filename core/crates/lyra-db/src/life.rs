//! `lyra-db::life` — the life-OS store, sibling to [`crate::wealth`].
//!
//! Until now every reader of `entities` / `trackers` / `relations` / `schedules` was an axum
//! handler in `lyra-api`, so the only way to ask the database a question about a task was to make
//! an HTTP request to yourself. The MCP desk cannot do that — it is a child process on stdio with
//! no token and no port — and neither can a job handler. This module is the shared floor those
//! callers stand on.
//!
//! Three rules it exists to keep in **one** place:
//!
//! 1. **Visibility.** An entity is readable when you own it or it is `shared`
//!    ([`VISIBLE_ENTITY`]). A tracker is readable **only** by its owner — `shared` grants nothing
//!    there, so a shared habit's measurements stay private to whoever logged them. A relation is
//!    readable when *either* endpoint is. Those three rules were previously written out separately
//!    in three route files; a fourth copy in the MCP crate is how they start to disagree.
//! 2. **Ownership is resolved once, loudly.** [`resolve_owner`] refuses ambiguity rather than
//!    guessing, because a mis-scoped owner fails *invisibly*: every list query filters on
//!    `ownerId`, so a wrong id returns an empty list that is indistinguishable from an empty
//!    life.
//! 3. **Lists are keyset-paginated, never `OFFSET`.** An assistant pages through a list while the
//!    user is adding to it, and `OFFSET` silently skips or repeats rows when the set shifts under
//!    it. A cursor anchored to the last row it actually saw cannot.
//!
//! This module **only reads.** Writes arrive with `apply()` (roadmap C1), which is where the
//! ownership check and the audit row will live so that no caller can route around them. Keeping
//! the read half separate now means the write half lands next to a store that already has tests.

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sqlx::sqlite::SqliteRow;
use sqlx::{AssertSqlSafe, Row, SqlitePool};

/// The owned-or-shared predicate, as a SQL fragment with one `?` for the owner id.
///
/// Exported so a caller that has to build its own statement still spells the rule the same way.
pub const VISIBLE_ENTITY: &str = "(ownerId = ? OR visibility = 'shared')";

/// The same rule against a joined alias, e.g. `visible_entity("e")`.
///
/// It is a function rather than something a caller assembles from [`VISIBLE_ENTITY`] because the
/// two things that go wrong doing it by hand both fail *open*. Drop the outer parentheses and the
/// `OR` binds looser than every `AND` after it, so the query quietly returns the rows it was meant
/// to filter; qualify only the first column and the second one resolves against whichever joined
/// table happens to have it. Neither shows up as an error — only as too many rows.
pub fn visible_entity(alias: &str) -> String {
    format!("({alias}.ownerId = ? OR {alias}.visibility = 'shared')")
}

const ENTITY_COLUMNS: &str = "id, type, title, description, status, priority, tags, metadata, \
                              parentId, ownerId, visibility, dueDate, createdAt, updatedAt";

/// The most rows any single call will return, however large a limit it asks for.
///
/// This is a frame budget, not a database concern: the MCP desk serializes a list into one
/// JSON-RPC frame that a model then pays for by the token. A caller that genuinely wants more
/// pages through with a cursor, which also gives it a chance to stop early.
pub const MAX_LIMIT: usize = 100;

/// What a caller gets when it does not say.
pub const DEFAULT_LIMIT: usize = 20;

fn clamp_limit(limit: usize) -> usize {
    if limit == 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    }
}

/// A due date is stored as whatever the writer had — a bare `2026-09-21` from the capture grammar
/// or a full `2026-09-21T00:00:00.000Z` from the web app, because `entities.dueDate` is TEXT and
/// nothing ever normalized it.
///
/// Comparing those two forms as whole strings puts every dated task in the wrong order the moment
/// both shapes exist in the table. Comparing the first ten characters compares the *day*, which is
/// the only part of a due date this store has ever meant.
const DUE_DAY: &str = "substr(dueDate, 1, 10)";

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/// One row of `entities` — a task, project, goal, habit, note, event or chore.
///
/// There is deliberately no `kind` enum. `entities.type` is an open TEXT column that the web app
/// has already put at least seven values in, and a closed enum here would turn "someone added a
/// new type in the UI" into a deserialization failure in the assistant.
#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    pub id: String,
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    /// JSON text. Kept as text on the row so a malformed value cannot fail a whole list query.
    pub tags: Option<String>,
    /// JSON text. `metadata.projectId` is how a task says which project or goal it belongs to.
    pub metadata: Option<String>,
    pub parent_id: Option<String>,
    pub owner_id: Option<String>,
    pub visibility: Option<String>,
    pub due_date: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Map one row, the way the rest of this crate does it.
///
/// Every column but `id` falls back rather than failing. These tables were written by a Drizzle
/// schema that made almost everything nullable, and a list that refuses to return because one
/// ancient row has a null `type` is worse than a list with a null in it.
fn entity_from(row: &SqliteRow) -> Entity {
    Entity {
        id: row.try_get("id").unwrap_or_default(),
        r#type: row.try_get("type").unwrap_or(None),
        title: row.try_get("title").unwrap_or(None),
        description: row.try_get("description").unwrap_or(None),
        status: row.try_get("status").unwrap_or(None),
        priority: row.try_get("priority").unwrap_or(None),
        tags: row.try_get("tags").unwrap_or(None),
        metadata: row.try_get("metadata").unwrap_or(None),
        parent_id: row.try_get("parentId").unwrap_or(None),
        owner_id: row.try_get("ownerId").unwrap_or(None),
        visibility: row.try_get("visibility").unwrap_or(None),
        due_date: row.try_get("dueDate").unwrap_or(None),
        created_at: row.try_get("createdAt").unwrap_or(None),
        updated_at: row.try_get("updatedAt").unwrap_or(None),
    }
}

fn tracker_from(row: &SqliteRow) -> Tracker {
    Tracker {
        id: row.try_get("id").unwrap_or_default(),
        entity_id: row.try_get("entityId").unwrap_or(None),
        value: row.try_get("value").unwrap_or(None),
        unit: row.try_get("unit").unwrap_or(None),
        note: row.try_get("note").unwrap_or(None),
        timestamp: row.try_get("timestamp").unwrap_or(None),
        owner_id: row.try_get("ownerId").unwrap_or(None),
    }
}

fn relation_from(row: &SqliteRow) -> Relation {
    Relation {
        id: row.try_get("id").unwrap_or_default(),
        from_id: row.try_get("fromId").unwrap_or(None),
        to_id: row.try_get("toId").unwrap_or(None),
        r#type: row.try_get("type").unwrap_or(None),
    }
}

fn schedule_from(row: &SqliteRow) -> Schedule {
    Schedule {
        id: row.try_get("id").unwrap_or_default(),
        entity_id: row.try_get("entityId").unwrap_or(None),
        recurrence: row.try_get("recurrence").unwrap_or(None),
        next_due: row.try_get("nextDue").unwrap_or(None),
        last_completed: row.try_get("lastCompleted").unwrap_or(None),
        is_active: row.try_get("isActive").unwrap_or(None),
        title: row.try_get("title").unwrap_or(None),
        entity_type: row.try_get("entityType").unwrap_or(None),
    }
}

fn parse_json_or(raw: Option<&str>, fallback: fn() -> Value) -> Value {
    raw.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(fallback)
}

impl Entity {
    /// The full projection, field-for-field with `GET /api/entities/{id}`.
    ///
    /// Keeping the two identical is not politeness: the assistant and the web app describe the
    /// same row to the same person, and a field that is `projectId` in one and `project_id` in the
    /// other is a question the user has to answer for themselves every time.
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": self.r#type,
            "title": self.title,
            "description": self.description,
            "status": self.status,
            "priority": self.priority,
            "tags": parse_json_or(self.tags.as_deref(), || json!([])),
            "metadata": parse_json_or(self.metadata.as_deref(), || json!({})),
            "parentId": self.parent_id,
            "ownerId": self.owner_id,
            "visibility": self.visibility,
            "dueDate": self.due_date,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }

    /// The list projection: what a row needs to be recognised and drilled into, and nothing else.
    ///
    /// `description` is the field that makes a list expensive — it is capped at 5000 characters
    /// per row, so twenty of them can be a hundred kilobytes of frame for a question that was
    /// "what is due today". A caller that wants the body asks for the one row.
    pub fn to_brief(&self) -> Value {
        json!({
            "id": self.id,
            "type": self.r#type,
            "title": self.title,
            "status": self.status,
            "priority": self.priority,
            "dueDate": self.due_date,
            "projectId": self.project_id(),
            "tags": parse_json_or(self.tags.as_deref(), || json!([])),
        })
    }

    /// `metadata.projectId`, the link from a task to the project or goal it belongs to.
    ///
    /// Ids are unique across types, so the one field serves both — see `docs/core-engine.md`.
    pub fn project_id(&self) -> Option<String> {
        parse_json_or(self.metadata.as_deref(), || json!({}))
            .get("projectId")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// The day part of the due date, or `None` when the row has no due date at all.
    pub fn due_day(&self) -> Option<&str> {
        self.due_date
            .as_deref()
            .map(|d| if d.len() >= 10 { &d[..10] } else { d })
    }
}

/// One row of `trackers` — a measurement against an entity.
#[derive(Debug, Clone, PartialEq)]
pub struct Tracker {
    pub id: String,
    pub entity_id: Option<String>,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub note: Option<String>,
    pub timestamp: Option<String>,
    pub owner_id: Option<String>,
}

impl Tracker {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "entityId": self.entity_id,
            "value": self.value,
            "unit": self.unit,
            "note": self.note,
            "timestamp": self.timestamp,
        })
    }
}

/// One row of `relations` — a typed edge between two entities.
#[derive(Debug, Clone, PartialEq)]
pub struct Relation {
    pub id: String,
    pub from_id: Option<String>,
    pub to_id: Option<String>,
    pub r#type: Option<String>,
}

impl Relation {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "fromId": self.from_id,
            "toId": self.to_id,
            "type": self.r#type,
        })
    }
}

/// One row of `schedules` — an entity's **recurrence**.
///
/// This is not a job queue and never becomes one; `jobs` is the queue. `nextDue` here is rendered
/// to the user on the habits page, which is precisely why a failed background job must not write a
/// backoff into it. See `docs/core-engine.md`.
#[derive(Debug, Clone, PartialEq)]
pub struct Schedule {
    pub id: String,
    pub entity_id: Option<String>,
    pub recurrence: Option<String>,
    pub next_due: Option<String>,
    pub last_completed: Option<String>,
    pub is_active: Option<i64>,
    /// Joined from `entities`, because a recurrence with no title is unreadable on a phone.
    pub title: Option<String>,
    pub entity_type: Option<String>,
}

impl Schedule {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "entityId": self.entity_id,
            "title": self.title,
            "entityType": self.entity_type,
            "recurrence": self.recurrence,
            "nextDue": self.next_due,
            "lastCompleted": self.last_completed,
            "isActive": self.is_active.unwrap_or(0) != 0,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------------------------

/// How a list is ordered — and therefore what a cursor into it means.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum EntityOrder {
    /// Newest change first (`updatedAt DESC, id DESC`). The default, because "what did I touch
    /// last" is the question with no other answer.
    #[default]
    Recent,
    /// Soonest due first (`dueDate ASC, id ASC`).
    ///
    /// **This order lists only entities that have a due date.** Sorting undated rows into a due
    /// list means either inventing a date for them or carrying a NULL group whose cursor has no
    /// stable key; both are worse than saying so. Undated work is what `Recent` is for.
    Due,
}

impl EntityOrder {
    fn tag(self) -> &'static str {
        match self {
            EntityOrder::Recent => "recent",
            EntityOrder::Due => "due",
        }
    }
}

/// Where a page stopped — the sort key and id of the last row actually returned.
///
/// Serialized as `<order>|<key>|<id>` and handed back to the caller opaquely. The order tag is
/// carried so that feeding a `recent` cursor into a `due` query is refused rather than silently
/// producing a page from nowhere: the two keys are both strings, so nothing else would catch it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cursor {
    pub order: EntityOrder,
    pub key: String,
    pub id: String,
}

impl Cursor {
    pub fn encode(&self) -> String {
        format!("{}|{}|{}", self.order.tag(), self.key, self.id)
    }

    /// Parse a cursor and check it belongs to the order it is being used in.
    pub fn decode(raw: &str, expected: EntityOrder) -> Result<Self> {
        let mut parts = raw.splitn(3, '|');
        let (Some(tag), Some(key), Some(id)) = (parts.next(), parts.next(), parts.next()) else {
            anyhow::bail!("cursor {raw:?} is not a cursor this list issued");
        };
        if tag != expected.tag() {
            anyhow::bail!(
                "cursor {raw:?} was issued for order {tag:?} but is being used in {:?} — \
                 page with the order you started in",
                expected.tag()
            );
        }
        Ok(Self {
            order: expected,
            key: key.to_string(),
            id: id.to_string(),
        })
    }
}

/// One page of entities, plus the cursor that continues it.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub rows: Vec<Entity>,
    /// `None` when this page exhausted the list — the caller is done, with no extra round trip.
    pub next: Option<Cursor>,
}

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

/// Which entities to list. Every field is a narrowing filter; all of them are `AND`ed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EntityQuery {
    /// `entities.type` — `task`, `project`, `goal`, `habit`, `note`, `event`, `chore`, …
    pub kind: Option<String>,
    /// Any of these statuses. Empty means "no status filter", subject to `include_archived`.
    pub statuses: Vec<String>,
    pub parent_id: Option<String>,
    /// `metadata.projectId` — the project or goal a task belongs to.
    pub project_id: Option<String>,
    /// A substring of the title or description, case-insensitively.
    pub text: Option<String>,
    /// Inclusive lower bound on the due *day*, `YYYY-MM-DD`.
    pub due_from: Option<String>,
    /// Inclusive upper bound on the due *day*, `YYYY-MM-DD`.
    pub due_to: Option<String>,
    /// Archived rows are excluded unless asked for, or unless `statuses` names them explicitly.
    /// An assistant that surfaces archived work has undone the point of archiving it.
    pub include_archived: bool,
    pub order: EntityOrder,
    pub limit: usize,
    pub cursor: Option<String>,
}

/// List the entities this owner can see.
pub async fn list_entities(pool: &SqlitePool, owner: &str, query: &EntityQuery) -> Result<Page> {
    let limit = clamp_limit(query.limit);

    let mut sql = format!("SELECT {ENTITY_COLUMNS} FROM entities WHERE {VISIBLE_ENTITY}");
    let mut binds: Vec<String> = vec![owner.to_string()];

    if let Some(kind) = &query.kind {
        sql.push_str(" AND type = ?");
        binds.push(kind.clone());
    }
    if !query.statuses.is_empty() {
        let holes = vec!["?"; query.statuses.len()].join(", ");
        sql.push_str(&format!(" AND status IN ({holes})"));
        binds.extend(query.statuses.iter().cloned());
    } else if !query.include_archived {
        sql.push_str(" AND (status IS NULL OR status != 'archived')");
    }
    if let Some(parent) = &query.parent_id {
        sql.push_str(" AND parentId = ?");
        binds.push(parent.clone());
    }
    if let Some(project) = &query.project_id {
        // `metadata` is TEXT holding JSON; `json_extract` is how the one field inside it is
        // queried without a LIKE that would also match a project id embedded in a note body.
        sql.push_str(" AND json_extract(metadata, '$.projectId') = ?");
        binds.push(project.clone());
    }
    if let Some(text) = &query.text {
        sql.push_str(" AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
        let pattern = format!("%{}%", escape_like(text));
        binds.push(pattern.clone());
        binds.push(pattern);
    }
    if let Some(from) = &query.due_from {
        sql.push_str(&format!(" AND {DUE_DAY} >= ?"));
        binds.push(from.clone());
    }
    if let Some(to) = &query.due_to {
        sql.push_str(&format!(" AND {DUE_DAY} <= ?"));
        binds.push(to.clone());
    }

    let cursor = match &query.cursor {
        Some(raw) => Some(Cursor::decode(raw, query.order)?),
        None => None,
    };

    match query.order {
        EntityOrder::Recent => {
            if let Some(c) = &cursor {
                // Strictly after the last row seen, in the list's own order. The id breaks the tie
                // when two rows share a timestamp, which `updatedAt` at millisecond precision
                // makes likelier than it sounds — a bulk edit stamps them all the same.
                sql.push_str(" AND (updatedAt < ? OR (updatedAt = ? AND id < ?))");
                binds.push(c.key.clone());
                binds.push(c.key.clone());
                binds.push(c.id.clone());
            }
            sql.push_str(" ORDER BY updatedAt DESC, id DESC");
        }
        EntityOrder::Due => {
            sql.push_str(" AND dueDate IS NOT NULL AND dueDate != ''");
            if let Some(c) = &cursor {
                sql.push_str(&format!(
                    " AND ({DUE_DAY} > ? OR ({DUE_DAY} = ? AND id > ?))"
                ));
                binds.push(c.key.clone());
                binds.push(c.key.clone());
                binds.push(c.id.clone());
            }
            sql.push_str(&format!(" ORDER BY {DUE_DAY} ASC, id ASC"));
        }
    }

    // One more than asked for, so "is there another page" is answered by the same query rather
    // than by a COUNT that would race with whatever is writing.
    sql.push_str(&format!(" LIMIT {}", limit + 1));

    let mut statement = sqlx::query(AssertSqlSafe(sql));
    for bind in binds {
        statement = statement.bind(bind);
    }
    let mut rows: Vec<Entity> = statement
        .fetch_all(pool)
        .await
        .context("listing entities")?
        .iter()
        .map(entity_from)
        .collect();

    let next = if rows.len() > limit {
        rows.truncate(limit);
        rows.last().map(|row| Cursor {
            order: query.order,
            key: match query.order {
                EntityOrder::Recent => row.updated_at.clone().unwrap_or_default(),
                EntityOrder::Due => row.due_day().unwrap_or_default().to_string(),
            },
            id: row.id.clone(),
        })
    } else {
        None
    };

    Ok(Page { rows, next })
}

/// `%` and `_` are wildcards in `LIKE`; a user searching for `50%` means the characters.
fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Fetch one entity, or `None` when it does not exist **or** is not visible to this owner.
///
/// The two cases are deliberately merged, exactly as `GET /api/entities/{id}` merges them into a
/// 404: an id the caller may not see must not be confirmed to exist.
pub async fn get_entity(pool: &SqlitePool, owner: &str, id: &str) -> Result<Option<Entity>> {
    Ok(sqlx::query(AssertSqlSafe(format!(
        "SELECT {ENTITY_COLUMNS} FROM entities WHERE id = ? AND {VISIBLE_ENTITY}"
    )))
    .bind(id)
    .bind(owner)
    .fetch_optional(pool)
    .await
    .context("fetching an entity")?
    .as_ref()
    .map(entity_from))
}

/// The ids this owner can see, for the callers that need the set whole.
pub async fn visible_entity_ids(
    pool: &SqlitePool,
    owner: &str,
) -> Result<std::collections::BTreeSet<String>> {
    let ids: Vec<String> = sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT id FROM entities WHERE {VISIBLE_ENTITY}"
    )))
    .bind(owner)
    .fetch_all(pool)
    .await
    .context("listing visible entity ids")?;
    Ok(ids.into_iter().collect())
}

/// Relations touching a visible entity.
///
/// `entity` narrows to edges incident on one id; without it, every edge with a visible endpoint is
/// returned. The visibility filter runs as a join rather than in Rust because the caller here is
/// the desk, which has no reason to hold the whole id set the way the HTTP route does.
pub async fn list_relations(
    pool: &SqlitePool,
    owner: &str,
    entity: Option<&str>,
    limit: usize,
) -> Result<Vec<Relation>> {
    let limit = clamp_limit(limit);
    // One EXISTS per endpoint, because a relation is visible when *either* end is. `side` is one
    // of the two literals below, never caller input.
    let incident = |side: &str| {
        format!(
            "EXISTS (SELECT 1 FROM entities e WHERE e.id = r.{side} AND {})",
            visible_entity("e")
        )
    };
    let (from_side, to_side) = (incident("fromId"), incident("toId"));

    let mut sql = format!(
        "SELECT r.id, r.fromId, r.toId, r.type FROM relations r \
         WHERE (({from_side}) OR ({to_side}))"
    );
    let binds = vec![owner.to_string(), owner.to_string()];
    if entity.is_some() {
        sql.push_str(" AND (r.fromId = ? OR r.toId = ?)");
    }
    sql.push_str(&format!(" ORDER BY r.id LIMIT {limit}"));

    let mut statement = sqlx::query(AssertSqlSafe(sql));
    for bind in &binds {
        statement = statement.bind(bind);
    }
    if let Some(id) = entity {
        statement = statement.bind(id).bind(id);
    }
    Ok(statement
        .fetch_all(pool)
        .await
        .context("listing relations")?
        .iter()
        .map(relation_from)
        .collect())
}

/// Measurements against one entity, oldest first.
///
/// **Owner only** — `shared` grants nothing here, matching `/api/trackers`. A shared habit's
/// numbers belong to whoever logged them.
pub async fn list_trackers(
    pool: &SqlitePool,
    owner: &str,
    entity_id: Option<&str>,
    start: Option<&str>,
    end: Option<&str>,
    limit: usize,
) -> Result<Vec<Tracker>> {
    let limit = clamp_limit(limit);
    let mut sql = "SELECT id, entityId, value, unit, note, timestamp, ownerId FROM trackers \
                   WHERE ownerId = ?"
        .to_string();
    let mut binds = vec![owner.to_string()];
    if let Some(id) = entity_id {
        sql.push_str(" AND entityId = ?");
        binds.push(id.to_string());
    }
    if let Some(start) = start {
        sql.push_str(" AND timestamp >= ?");
        binds.push(start.to_string());
    }
    if let Some(end) = end {
        sql.push_str(" AND timestamp <= ?");
        binds.push(end.to_string());
    }
    // Ascending, because a series is read forwards — the caller that wants "the last N" passes a
    // start bound rather than reversing and re-reversing.
    sql.push_str(&format!(" ORDER BY timestamp ASC, id ASC LIMIT {limit}"));

    let mut statement = sqlx::query(AssertSqlSafe(sql));
    for bind in binds {
        statement = statement.bind(bind);
    }
    Ok(statement
        .fetch_all(pool)
        .await
        .context("listing trackers")?
        .iter()
        .map(tracker_from)
        .collect())
}

/// Recurrences whose entity this owner can see.
pub async fn list_schedules(
    pool: &SqlitePool,
    owner: &str,
    entity: Option<&str>,
    active_only: bool,
    due_on_or_before: Option<&str>,
    limit: usize,
) -> Result<Vec<Schedule>> {
    let limit = clamp_limit(limit);
    let mut sql = format!(
        "SELECT s.id, s.entityId, s.recurrence, s.nextDue, s.lastCompleted, s.isActive, \
                e.title AS title, e.type AS entityType \
         FROM schedules s JOIN entities e ON e.id = s.entityId \
         WHERE {}",
        visible_entity("e")
    );
    let mut binds = vec![owner.to_string()];
    if let Some(id) = entity {
        sql.push_str(" AND s.entityId = ?");
        binds.push(id.to_string());
    }
    if active_only {
        sql.push_str(" AND s.isActive = 1");
    }
    if let Some(day) = due_on_or_before {
        sql.push_str(" AND s.nextDue IS NOT NULL AND substr(s.nextDue, 1, 10) <= ?");
        binds.push(day.to_string());
    }
    sql.push_str(&format!(
        " ORDER BY (s.nextDue IS NULL), s.nextDue ASC, s.id ASC LIMIT {limit}"
    ));

    let mut statement = sqlx::query(AssertSqlSafe(sql));
    for bind in binds {
        statement = statement.bind(bind);
    }
    Ok(statement
        .fetch_all(pool)
        .await
        .context("listing schedules")?
        .iter()
        .map(schedule_from)
        .collect())
}

/// Everything the question "what should I be doing" needs, in one round trip.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Agenda {
    /// The day this agenda was computed for, `YYYY-MM-DD`.
    pub day: String,
    /// Due before today and not finished. Listed first because it is the only part that is a
    /// problem rather than a plan.
    pub overdue: Vec<Entity>,
    pub due_today: Vec<Entity>,
    /// Started and not finished, whatever its due date — the work already in flight.
    pub in_progress: Vec<Entity>,
    /// Recurrences whose `nextDue` has arrived.
    pub habits_due: Vec<Schedule>,
    /// The next seven days, so "and then?" does not cost another call.
    pub upcoming: Vec<Entity>,
}

/// Statuses that mean the work is off the list. Anything else is still open, including the
/// null status an older row may carry.
const CLOSED: [&str; 2] = ["done", "archived"];

fn open_statuses_excluded() -> String {
    let holes = CLOSED
        .iter()
        .map(|s| format!("'{s}'"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("(status IS NULL OR status NOT IN ({holes}))")
}

/// Build the agenda for one day.
///
/// `day` is passed in rather than read from the process clock on purpose. `digest::day_key` is
/// process-local today, and if the box runs UTC while the user does not, "today" on the phone and
/// "today" in the brief disagree for part of every day. A caller that knows the user's timezone
/// should say so; one that does not gets to make that omission visible.
pub async fn agenda(pool: &SqlitePool, owner: &str, day: &str, limit: usize) -> Result<Agenda> {
    let limit = clamp_limit(limit);
    let open = open_statuses_excluded();

    let select_open = |extra: &str| {
        format!("SELECT {ENTITY_COLUMNS} FROM entities WHERE {VISIBLE_ENTITY} AND {open} {extra}")
    };

    let overdue = sqlx::query(AssertSqlSafe(select_open(&format!(
        "AND dueDate IS NOT NULL AND dueDate != '' AND {DUE_DAY} < ? \
         ORDER BY {DUE_DAY} ASC, id ASC LIMIT {limit}"
    ))))
    .bind(owner)
    .bind(day)
    .fetch_all(pool)
    .await
    .context("agenda: overdue")?
    .iter()
    .map(entity_from)
    .collect();

    let due_today = sqlx::query(AssertSqlSafe(select_open(&format!(
        "AND {DUE_DAY} = ? ORDER BY priority, id LIMIT {limit}"
    ))))
    .bind(owner)
    .bind(day)
    .fetch_all(pool)
    .await
    .context("agenda: due today")?
    .iter()
    .map(entity_from)
    .collect();

    let in_progress = sqlx::query(AssertSqlSafe(format!(
        "SELECT {ENTITY_COLUMNS} FROM entities WHERE {VISIBLE_ENTITY} \
         AND status = 'in-progress' ORDER BY updatedAt DESC, id DESC LIMIT {limit}"
    )))
    .bind(owner)
    .fetch_all(pool)
    .await
    .context("agenda: in progress")?
    .iter()
    .map(entity_from)
    .collect();

    // Seven days, because that is the horizon a person can actually act on from a phone; further
    // out is a planning question and has its own list.
    let horizon = add_days(day, 7);
    let upcoming = sqlx::query(AssertSqlSafe(select_open(&format!(
        "AND dueDate IS NOT NULL AND dueDate != '' AND {DUE_DAY} > ? AND {DUE_DAY} <= ? \
         ORDER BY {DUE_DAY} ASC, id ASC LIMIT {limit}"
    ))))
    .bind(owner)
    .bind(day)
    .bind(&horizon)
    .fetch_all(pool)
    .await
    .context("agenda: upcoming")?
    .iter()
    .map(entity_from)
    .collect();

    let habits_due = list_schedules(pool, owner, None, true, Some(day), limit).await?;

    Ok(Agenda {
        day: day.to_string(),
        overdue,
        due_today,
        in_progress,
        habits_due,
        upcoming,
    })
}

/// Add days to a `YYYY-MM-DD` day string.
///
/// Hand-rolled rather than pulled from `chrono` because this crate has no date dependency and
/// adding one for seven days of civil arithmetic is not a trade worth making. A malformed input
/// is returned unchanged, which turns the upcoming window into an empty one rather than into an
/// error — the agenda's other five sections are still worth returning.
fn add_days(day: &str, days: i64) -> String {
    let parts: Vec<i64> = day
        .split('-')
        .filter_map(|p| p.parse::<i64>().ok())
        .collect();
    let [y, m, d] = parts[..] else {
        return day.to_string();
    };
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return day.to_string();
    }
    let (y, m, d) = from_days(to_days(y, m, d) + days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days since 1970-01-01 (Howard Hinnant's civil-from-days, the standard shift-the-year-to-March
/// trick that makes the leap-day case fall out of the arithmetic instead of needing a branch).
fn to_days(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

// ---------------------------------------------------------------------------------------------
// Whose life is this?
// ---------------------------------------------------------------------------------------------

/// Why an owner could not be settled on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerUnresolved {
    /// A specific id was configured and there is no such user.
    NoSuchUser(String),
    /// No id was configured and the table is empty.
    NoUsers,
    /// No id was configured and there is more than one candidate.
    Ambiguous(Vec<String>),
}

impl std::fmt::Display for OwnerUnresolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OwnerUnresolved::NoSuchUser(id) => write!(
                f,
                "no user {id:?} exists in this database. Every life-OS row is filtered by \
                 ownerId, so running under an id nobody owns would answer every question with an \
                 empty list — which reads as an empty life, not as a misconfiguration."
            ),
            OwnerUnresolved::NoUsers => write!(
                f,
                "the users table is empty, so there is no life to read. Sign in to the web app \
                 once to create your user, or set LYRA_MCP_OWNER."
            ),
            OwnerUnresolved::Ambiguous(ids) => write!(
                f,
                "this database has {} users ({}) and nothing says which one you are. \
                 Set LYRA_MCP_OWNER to the id you mean.",
                ids.len(),
                ids.join(", ")
            ),
        }
    }
}

impl std::error::Error for OwnerUnresolved {}

/// Settle on whose entities this process reads, or refuse.
///
/// `configured` is `LYRA_MCP_OWNER` (or the equivalent for another caller); an empty value counts
/// as unset, the way a half-filled `.env` presents itself.
///
/// The refusal is the point. A single-user box resolves without configuration, which is what makes
/// it usable out of the box; anything else is named rather than guessed at, because guessing wrong
/// here does not fail — it succeeds, quietly, against the wrong life.
pub async fn resolve_owner(
    pool: &SqlitePool,
    configured: Option<&str>,
) -> Result<String, OwnerUnresolved> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM users ORDER BY id")
        .fetch_all(pool)
        .await
        .unwrap_or_default();

    if let Some(wanted) = configured.map(str::trim).filter(|w| !w.is_empty()) {
        return if ids.iter().any(|id| id == wanted) {
            Ok(wanted.to_string())
        } else {
            Err(OwnerUnresolved::NoSuchUser(wanted.to_string()))
        };
    }

    match ids.len() {
        0 => Err(OwnerUnresolved::NoUsers),
        1 => Ok(ids[0].clone()),
        _ => Err(OwnerUnresolved::Ambiguous(ids)),
    }
}

// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_and_migrate;
    use tempfile::TempDir;

    async fn fresh() -> (TempDir, SqlitePool) {
        let dir = TempDir::new().unwrap();
        let pool = open_and_migrate(&dir.path().join("lyra.db")).await.unwrap();
        (dir, pool)
    }

    /// A row builder with the shape the web app writes, so the tests exercise real data rather
    /// than the subset this module happens to read.
    #[allow(clippy::too_many_arguments)]
    async fn entity(
        pool: &SqlitePool,
        id: &str,
        kind: &str,
        title: &str,
        status: &str,
        owner: &str,
        visibility: &str,
        due: Option<&str>,
        updated: &str,
        metadata: &str,
    ) {
        sqlx::query(
            "INSERT INTO entities (id, type, title, description, status, priority, tags, \
             metadata, parentId, ownerId, visibility, dueDate, createdAt, updatedAt) \
             VALUES (?, ?, ?, '', ?, 'medium', '[]', ?, NULL, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(kind)
        .bind(title)
        .bind(status)
        .bind(metadata)
        .bind(owner)
        .bind(visibility)
        .bind(due)
        .bind(updated)
        .bind(updated)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn user(pool: &SqlitePool, id: &str) {
        sqlx::query("INSERT INTO users (id, name, role) VALUES (?, ?, 'owner')")
            .bind(id)
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
    }

    fn titles(page: &Page) -> Vec<String> {
        page.rows
            .iter()
            .map(|r| r.title.clone().unwrap_or_default())
            .collect()
    }

    #[tokio::test]
    async fn a_list_shows_what_you_own_and_what_is_shared_and_nothing_else() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "a", "task", "mine", "todo", "me", "private", None, "3", "{}",
        )
        .await;
        entity(
            &pool, "b", "task", "theirs", "todo", "you", "private", None, "2", "{}",
        )
        .await;
        entity(
            &pool, "c", "task", "shared", "todo", "you", "shared", None, "1", "{}",
        )
        .await;

        let page = list_entities(&pool, "me", &EntityQuery::default())
            .await
            .unwrap();
        assert_eq!(titles(&page), ["mine", "shared"]);
    }

    #[tokio::test]
    async fn a_row_you_cannot_see_is_reported_as_absent_not_as_forbidden() {
        // The distinction matters: confirming that an id exists is itself information, and the
        // HTTP route deliberately answers 404 rather than 403 for the same reason.
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "b", "task", "theirs", "todo", "you", "private", None, "1", "{}",
        )
        .await;
        assert!(get_entity(&pool, "me", "b").await.unwrap().is_none());
        assert!(get_entity(&pool, "me", "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn archived_work_stays_out_of_the_way_unless_asked_for() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "a", "task", "open", "todo", "me", "private", None, "2", "{}",
        )
        .await;
        entity(
            &pool, "b", "task", "filed", "archived", "me", "private", None, "1", "{}",
        )
        .await;

        let default = list_entities(&pool, "me", &EntityQuery::default())
            .await
            .unwrap();
        assert_eq!(titles(&default), ["open"]);

        let asked = list_entities(
            &pool,
            "me",
            &EntityQuery {
                include_archived: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(titles(&asked), ["open", "filed"]);

        // Naming the status explicitly beats the default, otherwise "show me my archive" is
        // impossible to express.
        let named = list_entities(
            &pool,
            "me",
            &EntityQuery {
                statuses: vec!["archived".into()],
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(titles(&named), ["filed"]);
    }

    #[tokio::test]
    async fn a_task_is_found_by_the_project_it_belongs_to() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "p", "project", "Accounts", "todo", "me", "private", None, "3", "{}",
        )
        .await;
        entity(
            &pool,
            "t1",
            "task",
            "call the accountant",
            "todo",
            "me",
            "private",
            None,
            "2",
            r#"{"projectId":"p"}"#,
        )
        .await;
        entity(
            &pool,
            "t2",
            "task",
            "unrelated",
            "todo",
            "me",
            "private",
            None,
            "1",
            "{}",
        )
        .await;

        let page = list_entities(
            &pool,
            "me",
            &EntityQuery {
                project_id: Some("p".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(titles(&page), ["call the accountant"]);
        assert_eq!(page.rows[0].project_id().as_deref(), Some("p"));
    }

    #[tokio::test]
    async fn paging_by_cursor_sees_every_row_exactly_once() {
        let (_dir, pool) = fresh().await;
        for i in 0..7 {
            let updated = format!("2026-09-2{i}T00:00:00.000Z");
            entity(
                &pool,
                &format!("e{i}"),
                "task",
                &format!("t{i}"),
                "todo",
                "me",
                "private",
                None,
                &updated,
                "{}",
            )
            .await;
        }

        let mut seen = Vec::new();
        let mut cursor = None;
        loop {
            let page = list_entities(
                &pool,
                "me",
                &EntityQuery {
                    limit: 3,
                    cursor: cursor.clone(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            seen.extend(titles(&page));
            match page.next {
                Some(next) => cursor = Some(next.encode()),
                None => break,
            }
        }
        assert_eq!(seen, ["t6", "t5", "t4", "t3", "t2", "t1", "t0"]);
    }

    #[tokio::test]
    async fn the_last_page_says_so_rather_than_costing_another_round_trip() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "a", "task", "one", "todo", "me", "private", None, "1", "{}",
        )
        .await;
        let page = list_entities(
            &pool,
            "me",
            &EntityQuery {
                limit: 1,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(page.rows.len(), 1);
        assert!(page.next.is_none(), "one row and a limit of one is the end");
    }

    #[tokio::test]
    async fn a_cursor_from_one_order_is_refused_in_another() {
        // Both keys are strings, so nothing but the tag can catch this — and a page silently
        // computed from the wrong key is worse than an error, because it looks like data.
        let (_dir, pool) = fresh().await;
        entity(
            &pool,
            "a",
            "task",
            "one",
            "todo",
            "me",
            "private",
            Some("2026-01-01"),
            "1",
            "{}",
        )
        .await;
        let recent = Cursor {
            order: EntityOrder::Recent,
            key: "1".into(),
            id: "a".into(),
        };
        let err = list_entities(
            &pool,
            "me",
            &EntityQuery {
                order: EntityOrder::Due,
                cursor: Some(recent.encode()),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("recent"), "{err}");
    }

    #[tokio::test]
    async fn due_order_compares_days_not_strings() {
        // The table holds both shapes because nothing ever normalized `dueDate`. Whole-string
        // ordering would put the bare date after the timestamped one for the same day.
        let (_dir, pool) = fresh().await;
        entity(
            &pool,
            "a",
            "task",
            "later",
            "todo",
            "me",
            "private",
            Some("2026-09-22"),
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "b",
            "task",
            "sooner",
            "todo",
            "me",
            "private",
            Some("2026-09-21T09:00:00.000Z"),
            "2",
            "{}",
        )
        .await;
        entity(
            &pool, "c", "task", "undated", "todo", "me", "private", None, "3", "{}",
        )
        .await;

        let page = list_entities(
            &pool,
            "me",
            &EntityQuery {
                order: EntityOrder::Due,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            titles(&page),
            ["sooner", "later"],
            "due order carries only dated rows, soonest first"
        );
    }

    #[tokio::test]
    async fn a_search_for_a_percent_sign_means_the_character() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool,
            "a",
            "note",
            "up 50% this month",
            "todo",
            "me",
            "private",
            None,
            "2",
            "{}",
        )
        .await;
        entity(
            &pool,
            "b",
            "note",
            "nothing to see",
            "todo",
            "me",
            "private",
            None,
            "1",
            "{}",
        )
        .await;

        let page = list_entities(
            &pool,
            "me",
            &EntityQuery {
                text: Some("50%".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(titles(&page), ["up 50% this month"]);
    }

    #[tokio::test]
    async fn trackers_are_owner_only_even_when_the_entity_is_shared() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "h", "habit", "pushups", "todo", "you", "shared", None, "1", "{}",
        )
        .await;
        for (id, owner, value) in [("t1", "you", 10.0), ("t2", "me", 20.0)] {
            sqlx::query(
                "INSERT INTO trackers (id, entityId, value, unit, note, timestamp, ownerId) \
                 VALUES (?, 'h', ?, 'reps', '', '2026-09-21T00:00:00.000Z', ?)",
            )
            .bind(id)
            .bind(value)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        }

        let mine = list_trackers(&pool, "me", Some("h"), None, None, 10)
            .await
            .unwrap();
        assert_eq!(mine.len(), 1, "a shared habit does not share its numbers");
        assert_eq!(mine[0].value, Some(20.0));
    }

    #[tokio::test]
    async fn a_relation_is_visible_when_either_end_is() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "mine", "task", "mine", "todo", "me", "private", None, "1", "{}",
        )
        .await;
        entity(
            &pool, "theirs", "task", "theirs", "todo", "you", "private", None, "1", "{}",
        )
        .await;
        entity(
            &pool, "other", "task", "other", "todo", "you", "private", None, "1", "{}",
        )
        .await;
        for (id, from, to) in [("r1", "mine", "theirs"), ("r2", "theirs", "other")] {
            sqlx::query(
                "INSERT INTO relations (id, fromId, toId, type) VALUES (?, ?, ?, 'blocks')",
            )
            .bind(id)
            .bind(from)
            .bind(to)
            .execute(&pool)
            .await
            .unwrap();
        }

        let rows = list_relations(&pool, "me", None, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "r2 touches nothing I can see");
        assert_eq!(rows[0].id, "r1");

        let narrowed = list_relations(&pool, "me", Some("theirs"), 10)
            .await
            .unwrap();
        assert_eq!(narrowed.len(), 1, "narrowing does not widen visibility");
        assert_eq!(narrowed[0].id, "r1");
    }

    #[test]
    fn the_aliased_visibility_rule_is_the_unaliased_one_with_a_prefix() {
        // Two spellings of one security rule drift, so they are checked against each other here
        // rather than by whoever reads the next joined query.
        assert_eq!(
            visible_entity("e"),
            VISIBLE_ENTITY
                .replace("ownerId", "e.ownerId")
                .replace("visibility", "e.visibility")
        );
    }

    #[tokio::test]
    async fn one_shared_row_anywhere_does_not_unlock_every_relation() {
        // The parenthesis regression, as a test: with the outer parentheses dropped from the
        // visibility predicate, `... AND e.ownerId = ? OR e.visibility = 'shared'` is true for
        // every row as soon as a single shared entity exists anywhere in the table.
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "open", "note", "shared", "todo", "you", "shared", None, "1", "{}",
        )
        .await;
        entity(
            &pool, "a", "task", "theirs", "todo", "you", "private", None, "1", "{}",
        )
        .await;
        entity(
            &pool,
            "b",
            "task",
            "also theirs",
            "todo",
            "you",
            "private",
            None,
            "1",
            "{}",
        )
        .await;
        sqlx::query("INSERT INTO relations (id, fromId, toId, type) VALUES ('r', 'a', 'b', 'x')")
            .execute(&pool)
            .await
            .unwrap();

        let rows = list_relations(&pool, "me", None, 10).await.unwrap();
        assert!(
            rows.is_empty(),
            "neither end of r is visible to me: {rows:?}"
        );
    }

    #[tokio::test]
    async fn the_agenda_separates_a_problem_from_a_plan() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool,
            "a",
            "task",
            "late",
            "todo",
            "me",
            "private",
            Some("2026-09-19"),
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "b",
            "task",
            "today",
            "todo",
            "me",
            "private",
            Some("2026-09-21"),
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "c",
            "task",
            "soon",
            "todo",
            "me",
            "private",
            Some("2026-09-24"),
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "d",
            "task",
            "far",
            "todo",
            "me",
            "private",
            Some("2026-10-30"),
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "e",
            "task",
            "doing",
            "in-progress",
            "me",
            "private",
            None,
            "1",
            "{}",
        )
        .await;
        entity(
            &pool,
            "f",
            "task",
            "was late",
            "done",
            "me",
            "private",
            Some("2026-09-01"),
            "1",
            "{}",
        )
        .await;

        let out = agenda(&pool, "me", "2026-09-21", 20).await.unwrap();
        let names = |rows: &[Entity]| {
            rows.iter()
                .map(|r| r.title.clone().unwrap_or_default())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(&out.overdue),
            ["late"],
            "a finished task is not overdue"
        );
        assert_eq!(names(&out.due_today), ["today"]);
        assert_eq!(names(&out.in_progress), ["doing"]);
        assert_eq!(names(&out.upcoming), ["soon"], "seven days, not everything");
    }

    #[tokio::test]
    async fn a_habit_shows_up_the_day_it_comes_due() {
        let (_dir, pool) = fresh().await;
        entity(
            &pool, "h", "habit", "pushups", "todo", "me", "private", None, "1", "{}",
        )
        .await;
        entity(
            &pool, "g", "habit", "later", "todo", "me", "private", None, "1", "{}",
        )
        .await;
        entity(
            &pool, "x", "habit", "paused", "todo", "me", "private", None, "1", "{}",
        )
        .await;
        for (id, entity_id, next, active) in [
            ("s1", "h", "2026-09-21", 1),
            ("s2", "g", "2026-09-25", 1),
            ("s3", "x", "2026-09-20", 0),
        ] {
            sqlx::query(
                "INSERT INTO schedules (id, entityId, recurrence, nextDue, lastCompleted, \
                 isActive) VALUES (?, ?, 'daily', ?, NULL, ?)",
            )
            .bind(id)
            .bind(entity_id)
            .bind(next)
            .bind(active)
            .execute(&pool)
            .await
            .unwrap();
        }

        let out = agenda(&pool, "me", "2026-09-21", 20).await.unwrap();
        let due: Vec<&str> = out
            .habits_due
            .iter()
            .map(|s| s.title.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(due, ["pushups"], "not the future one, not the paused one");
        assert_eq!(out.habits_due[0].entity_type.as_deref(), Some("habit"));
    }

    #[tokio::test]
    async fn the_seven_day_horizon_crosses_a_month_boundary() {
        assert_eq!(add_days("2026-09-28", 7), "2026-10-05");
        assert_eq!(add_days("2026-02-25", 7), "2026-03-04");
        // 2028 is a leap year; getting this wrong shifts the window by a day once every four.
        assert_eq!(add_days("2028-02-25", 7), "2028-03-03");
        assert_eq!(add_days("2026-12-29", 7), "2027-01-05");
        assert_eq!(add_days("not-a-date", 7), "not-a-date");
    }

    #[tokio::test]
    async fn one_user_needs_no_configuration_and_two_users_need_it() {
        let (_dir, pool) = fresh().await;
        assert_eq!(
            resolve_owner(&pool, None).await.unwrap_err(),
            OwnerUnresolved::NoUsers
        );

        user(&pool, "alice").await;
        assert_eq!(resolve_owner(&pool, None).await.unwrap(), "alice");

        user(&pool, "bob").await;
        let err = resolve_owner(&pool, None).await.unwrap_err();
        assert_eq!(
            err,
            OwnerUnresolved::Ambiguous(vec!["alice".into(), "bob".into()])
        );

        assert_eq!(resolve_owner(&pool, Some("bob")).await.unwrap(), "bob");
        // An empty value is how a half-filled .env presents itself, so it counts as unset.
        assert!(resolve_owner(&pool, Some("  ")).await.is_err());
        assert_eq!(
            resolve_owner(&pool, Some("carol")).await.unwrap_err(),
            OwnerUnresolved::NoSuchUser("carol".into())
        );
    }

    #[tokio::test]
    async fn a_list_cannot_be_talked_into_returning_the_whole_table() {
        let (_dir, pool) = fresh().await;
        for i in 0..5 {
            entity(
                &pool,
                &format!("e{i}"),
                "task",
                "t",
                "todo",
                "me",
                "private",
                None,
                "1",
                "{}",
            )
            .await;
        }
        let page = list_entities(
            &pool,
            "me",
            &EntityQuery {
                limit: 100_000,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(page.rows.len() <= MAX_LIMIT);
    }

    #[test]
    fn the_brief_projection_leaves_the_expensive_field_behind() {
        let row = Entity {
            id: "a".into(),
            r#type: Some("task".into()),
            title: Some("t".into()),
            description: Some("x".repeat(5000)),
            status: Some("todo".into()),
            priority: Some("high".into()),
            tags: Some(r#"["home"]"#.into()),
            metadata: Some(r#"{"projectId":"p"}"#.into()),
            parent_id: None,
            owner_id: Some("me".into()),
            visibility: Some("private".into()),
            due_date: Some("2026-09-21".into()),
            created_at: None,
            updated_at: None,
        };
        let brief = row.to_brief();
        assert!(brief.get("description").is_none());
        assert_eq!(brief["projectId"], "p");
        assert_eq!(brief["tags"], json!(["home"]));
        // The full projection still carries everything the HTTP route returns.
        assert_eq!(row.to_json()["description"].as_str().unwrap().len(), 5000);
    }

    #[test]
    fn a_malformed_json_column_does_not_take_the_row_with_it() {
        // These are TEXT columns; anything could be in them, and one bad row must not fail a list.
        let row = Entity {
            id: "a".into(),
            r#type: None,
            title: None,
            description: None,
            status: None,
            priority: None,
            tags: Some("not json".into()),
            metadata: Some("{oops".into()),
            parent_id: None,
            owner_id: None,
            visibility: None,
            due_date: None,
            created_at: None,
            updated_at: None,
        };
        assert_eq!(row.to_json()["tags"], json!([]));
        assert_eq!(row.to_json()["metadata"], json!({}));
        assert_eq!(row.project_id(), None);
    }
}
