//! `/api/entities` — a contract-identical port of `api/src/routes/entities.ts`.
//!
//! Behaviours worth stating because they are easy to get subtly wrong:
//!
//! * **Reads are broader than writes.** A list or fetch returns rows the caller owns *or* that are
//!   `shared` (`entities.ts:45`), but PATCH and DELETE require ownership (`:114`, `:143`).
//! * **A forbidden row is reported as 404, not 403** — the API never confirms that an id it will
//!   not show you exists.
//! * `tags` and `metadata` are TEXT columns holding JSON, parsed on the way out and defaulting to
//!   `[]` / `{}` when null or unparseable (`entities.ts:29-35`).

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::AssertSqlSafe;
use std::collections::BTreeMap;

use crate::AppState;
use crate::auth::AuthUser;

const SELECT: &str = "SELECT id, type, title, description, status, priority, tags, metadata, \
                      parentId, ownerId, visibility, dueDate, createdAt, updatedAt FROM entities";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct EntityRow {
    pub id: String,
    pub r#type: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub tags: Option<String>,
    pub metadata: Option<String>,
    #[sqlx(rename = "parentId")]
    pub parent_id: Option<String>,
    #[sqlx(rename = "ownerId")]
    pub owner_id: Option<String>,
    pub visibility: Option<String>,
    #[sqlx(rename = "dueDate")]
    pub due_date: Option<String>,
    #[sqlx(rename = "createdAt")]
    pub created_at: Option<String>,
    #[sqlx(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

impl EntityRow {
    /// The `parseJsonFields` equivalent: JSON text columns become real JSON in the response.
    fn to_json(&self) -> Value {
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

    fn is_visible_to(&self, user_id: &str) -> bool {
        self.owner_id.as_deref() == Some(user_id) || self.visibility.as_deref() == Some("shared")
    }

    fn is_owned_by(&self, user_id: &str) -> bool {
        self.owner_id.as_deref() == Some(user_id)
    }
}

fn parse_json_or(raw: Option<&str>, fallback: impl Fn() -> Value) -> Value {
    raw.and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(fallback)
}

#[derive(Debug, Deserialize)]
pub struct ListFilters {
    pub r#type: Option<String>,
    pub status: Option<String>,
    #[serde(rename = "parentId")]
    pub parent_id: Option<String>,
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "error": "Entity not found" })),
    )
        .into_response()
}

fn server_error(context: &str, e: sqlx::Error) -> Response {
    tracing::error!(error = %e, context, "database error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "Internal error" })),
    )
        .into_response()
}

/// `GET /api/entities`
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(filters): Query<ListFilters>,
) -> Response {
    let mut sql = format!("{SELECT} WHERE (ownerId = ? OR visibility = 'shared')");
    if filters.r#type.is_some() {
        sql.push_str(" AND type = ?");
    }
    if filters.status.is_some() {
        sql.push_str(" AND status = ?");
    }
    if filters.parent_id.is_some() {
        sql.push_str(" AND parentId = ?");
    }

    let mut query = sqlx::query_as::<_, EntityRow>(AssertSqlSafe(sql)).bind(&user.user_id);
    for value in [&filters.r#type, &filters.status, &filters.parent_id]
        .into_iter()
        .flatten()
    {
        query = query.bind(value);
    }

    match query.fetch_all(&state.pool).await {
        Ok(rows) => Json(rows.iter().map(EntityRow::to_json).collect::<Vec<_>>()).into_response(),
        Err(e) => server_error("listing entities", e),
    }
}

/// `GET /api/entities/{id}`
pub async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.is_visible_to(&user.user_id) => Json(row.to_json()).into_response(),
        Ok(_) => not_found(),
        Err(e) => server_error("fetching entity", e),
    }
}

/// `POST /api/entities`
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Response {
    let Some(Json(body)) = body else {
        return validation_failure(BTreeMap::from([(
            "body".into(),
            vec!["Expected object".into()],
        )]));
    };

    let input = match validate(&body, Mode::Create) {
        Ok(input) => input,
        Err(details) => return validation_failure(details),
    };

    let now = now_iso();
    let row = EntityRow {
        id: input.string("id").unwrap_or_default(),
        r#type: input.string("type"),
        title: input.string("title"),
        description: input.string("description"),
        status: Some(input.string("status").unwrap_or_else(|| "todo".into())),
        priority: Some(input.string("priority").unwrap_or_else(|| "medium".into())),
        tags: Some(input.json("tags").unwrap_or_else(|| json!([])).to_string()),
        metadata: Some(
            input
                .json("metadata")
                .unwrap_or_else(|| json!({}))
                .to_string(),
        ),
        parent_id: input.string("parentId"),
        owner_id: Some(user.user_id.clone()),
        visibility: Some(
            input
                .string("visibility")
                .unwrap_or_else(|| "private".into()),
        ),
        due_date: input.string("dueDate"),
        created_at: Some(input.string("createdAt").unwrap_or_else(|| now.clone())),
        updated_at: Some(input.string("updatedAt").unwrap_or(now)),
    };

    let result = sqlx::query(
        "INSERT INTO entities (id, type, title, description, status, priority, tags, metadata, \
         parentId, ownerId, visibility, dueDate, createdAt, updatedAt) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.r#type)
    .bind(&row.title)
    .bind(&row.description)
    .bind(&row.status)
    .bind(&row.priority)
    .bind(&row.tags)
    .bind(&row.metadata)
    .bind(&row.parent_id)
    .bind(&row.owner_id)
    .bind(&row.visibility)
    .bind(&row.due_date)
    .bind(&row.created_at)
    .bind(&row.updated_at)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(row.to_json())).into_response(),
        Err(e) => server_error("creating entity", e),
    }
}

/// `PATCH /api/entities/{id}` — ownership required, unlike the read routes.
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.is_owned_by(&user.user_id) => {}
        Ok(_) => return not_found(),
        Err(e) => return server_error("loading entity for update", e),
    }

    let Some(Json(body)) = body else {
        return validation_failure(BTreeMap::from([(
            "body".into(),
            vec!["Expected object".into()],
        )]));
    };
    let input = match validate(&body, Mode::Update) {
        Ok(input) => input,
        Err(details) => return validation_failure(details),
    };

    // Only fields actually present are touched; `updatedAt` always is.
    let mut assignments = vec!["updatedAt = ?".to_string()];
    let mut binds: Vec<Option<String>> = vec![Some(now_iso())];
    for field in [
        "type",
        "title",
        "description",
        "status",
        "priority",
        "parentId",
        "visibility",
        "dueDate",
    ] {
        if let Some(value) = input.present(field) {
            assignments.push(format!("{field} = ?"));
            binds.push(value.as_str().map(|s| s.to_string()));
        }
    }
    for field in ["tags", "metadata"] {
        if let Some(value) = input.present(field) {
            assignments.push(format!("{field} = ?"));
            binds.push(Some(value.to_string()));
        }
    }

    let sql = format!(
        "UPDATE entities SET {} WHERE id = ?",
        assignments.join(", ")
    );
    let mut query = sqlx::query(AssertSqlSafe(sql));
    for bind in &binds {
        query = query.bind(bind);
    }
    if let Err(e) = query.bind(&id).execute(&state.pool).await {
        return server_error("updating entity", e);
    }

    match fetch(&state, &id).await {
        Ok(Some(row)) => Json(row.to_json()).into_response(),
        Ok(None) => not_found(),
        Err(e) => server_error("reloading entity", e),
    }
}

/// `DELETE /api/entities/{id}`
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.is_owned_by(&user.user_id) => {}
        Ok(_) => return not_found(),
        Err(e) => return server_error("loading entity for delete", e),
    }

    match sqlx::query("DELETE FROM entities WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(e) => server_error("deleting entity", e),
    }
}

async fn fetch(state: &AppState, id: &str) -> Result<Option<EntityRow>, sqlx::Error> {
    sqlx::query_as::<_, EntityRow>(AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.pool)
        .await
}

/// JS `new Date().toISOString()` — millisecond precision, `Z` suffix. Stored timestamps are
/// compared as strings elsewhere, so the format has to match exactly.
pub fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

/* ─── Validation — the zod schemas at entities.ts:7-23 ─── */

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Create,
    Update,
}

struct Validated(Map<String, Value>);

impl Validated {
    fn present(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
    fn string(&self, key: &str) -> Option<String> {
        self.0
            .get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }
    fn json(&self, key: &str) -> Option<Value> {
        self.0.get(key).cloned()
    }
}

type Details = BTreeMap<String, Vec<String>>;

fn validation_failure(details: Details) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Validation failed", "details": details })),
    )
        .into_response()
}

fn validate(body: &Value, mode: Mode) -> Result<Validated, Details> {
    let mut details: Details = BTreeMap::new();
    let Some(object) = body.as_object() else {
        details.insert("body".into(), vec!["Expected object".into()]);
        return Err(details);
    };

    let mut out = Map::new();
    let required = mode == Mode::Create;

    // (field, max length) — `id` is excluded from updates, matching `.omit({ id: true })`.
    let strings: &[(&str, usize, bool)] = &[
        ("id", 100, mode == Mode::Create),
        ("type", 50, required),
        ("title", 500, required),
    ];
    for (field, max, is_required) in strings {
        if mode == Mode::Update && *field == "id" {
            continue;
        }
        match object.get(*field) {
            Some(Value::String(s)) if !s.is_empty() && s.chars().count() <= *max => {
                out.insert((*field).to_string(), json!(s));
            }
            Some(Value::String(s)) if s.is_empty() => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push("Required".into());
            }
            Some(Value::String(_)) => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push(format!("Must be at most {max} characters"));
            }
            Some(_) => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push("Expected string".into());
            }
            None if *is_required => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push("Required".into());
            }
            None => {}
        }
    }

    // Nullable strings: an explicit null is allowed and means "clear it".
    let nullable: &[(&str, usize)] = &[
        ("description", 5000),
        ("parentId", 100),
        ("dueDate", 50),
        ("createdAt", 100),
        ("updatedAt", 100),
    ];
    for (field, max) in nullable {
        match object.get(*field) {
            Some(Value::String(s)) if s.chars().count() <= *max => {
                out.insert((*field).to_string(), json!(s));
            }
            Some(Value::String(_)) => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push(format!("Must be at most {max} characters"));
            }
            Some(Value::Null) => {
                out.insert((*field).to_string(), Value::Null);
            }
            Some(_) => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push("Expected string".into());
            }
            None => {}
        }
    }

    let enums: &[(&str, &[&str])] = &[
        (
            "status",
            &["backlog", "todo", "in-progress", "done", "archived"],
        ),
        ("priority", &["urgent", "high", "medium", "low"]),
        ("visibility", &["private", "shared"]),
    ];
    for (field, allowed) in enums {
        match object.get(*field) {
            Some(Value::String(s)) if allowed.contains(&s.as_str()) => {
                out.insert((*field).to_string(), json!(s));
            }
            Some(_) => {
                details
                    .entry((*field).to_string())
                    .or_default()
                    .push(format!("Expected one of: {}", allowed.join(", ")));
            }
            None => {}
        }
    }

    match object.get("tags") {
        Some(Value::Array(items)) if items.len() <= 50 => {
            if items
                .iter()
                .all(|i| i.as_str().is_some_and(|s| s.chars().count() <= 100))
            {
                out.insert("tags".into(), json!(items));
            } else {
                details
                    .entry("tags".into())
                    .or_default()
                    .push("Each tag must be a string of at most 100 characters".into());
            }
        }
        Some(Value::Array(_)) => {
            details
                .entry("tags".into())
                .or_default()
                .push("At most 50 tags".into());
        }
        Some(_) => {
            details
                .entry("tags".into())
                .or_default()
                .push("Expected array".into());
        }
        None => {}
    }

    match object.get("metadata") {
        Some(Value::Object(map)) => {
            out.insert("metadata".into(), Value::Object(map.clone()));
        }
        Some(_) => {
            details
                .entry("metadata".into())
                .or_default()
                .push("Expected object".into());
        }
        None => {}
    }

    if details.is_empty() {
        Ok(Validated(out))
    } else {
        Err(details)
    }
}
