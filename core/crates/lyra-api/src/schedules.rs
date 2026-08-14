//! `/api/schedules` — port of `api/src/routes/schedules.ts`.
//!
//! Two details the client depends on:
//!
//! * `isActive` is an INTEGER column but must be a **boolean** in JSON (`parseSchedule`,
//!   `schedules.ts:21`).
//! * Creating a schedule against an entity the caller cannot see returns `"Entity not found"`,
//!   while every other authorisation miss on this route returns `"Schedule not found"`
//!   (`schedules.ts:77` vs `:56`). Different strings; both 404.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::AssertSqlSafe;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::{
    Bind, Details, Field, bind_all, not_found, ok_true, server_error, take_string, user_entity_ids,
    validation_failure,
};

const SELECT: &str =
    "SELECT id, entityId, recurrence, nextDue, lastCompleted, isActive FROM schedules";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ScheduleRow {
    pub id: String,
    #[sqlx(rename = "entityId")]
    pub entity_id: Option<String>,
    pub recurrence: Option<String>,
    #[sqlx(rename = "nextDue")]
    pub next_due: Option<String>,
    #[sqlx(rename = "lastCompleted")]
    pub last_completed: Option<String>,
    #[sqlx(rename = "isActive")]
    pub is_active: Option<i64>,
}

impl ScheduleRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "entityId": self.entity_id,
            "recurrence": self.recurrence,
            "nextDue": self.next_due,
            "lastCompleted": self.last_completed,
            // `row.isActive === 1` — anything else, including NULL, is false.
            "isActive": self.is_active == Some(1),
        })
    }

    fn is_visible(&self, visible: &std::collections::BTreeSet<String>) -> bool {
        self.entity_id
            .as_deref()
            .is_some_and(|id| visible.contains(id))
    }
}

#[derive(Debug, Deserialize)]
pub struct ListFilters {
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
    #[serde(rename = "isActive")]
    pub is_active: Option<String>,
}

/// `GET /api/schedules`
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(filters): Query<ListFilters>,
) -> Response {
    let mut sql = SELECT.to_string();
    let mut clauses = Vec::new();
    let mut binds = Vec::new();
    if let Some(entity_id) = &filters.entity_id {
        clauses.push("entityId = ?");
        binds.push(Bind::Text(entity_id.clone()));
    }
    if let Some(is_active) = &filters.is_active {
        // `isActive === 'true' ? 1 : 0` — any other string means "inactive".
        clauses.push("isActive = ?");
        binds.push(Bind::Int(if is_active == "true" { 1 } else { 0 }));
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }

    let mut query = sqlx::query_as::<_, ScheduleRow>(AssertSqlSafe(sql));
    for bind in binds {
        query = match bind {
            Bind::Text(s) => query.bind(s),
            Bind::Int(i) => query.bind(i),
            _ => query,
        };
    }

    let rows = match query.fetch_all(&state.pool).await {
        Ok(rows) => rows,
        Err(e) => return server_error("listing schedules", e),
    };
    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };

    Json(
        rows.iter()
            .filter(|s| s.is_visible(&visible))
            .map(ScheduleRow::to_json)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

/// `GET /api/schedules/{id}`
pub async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match visible_row(&state, &user, &id).await {
        Ok(Some(row)) => Json(row.to_json()).into_response(),
        Ok(None) => not_found("Schedule not found"),
        Err(response) => response,
    }
}

/// `POST /api/schedules`
pub async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Response {
    let Some(Json(body)) = body else {
        return validation_failure(Details::from([(
            "body".into(),
            vec!["Expected object".into()],
        )]));
    };
    let Some(object) = body.as_object() else {
        return validation_failure(Details::from([(
            "body".into(),
            vec!["Expected object".into()],
        )]));
    };

    let mut details = Details::new();
    let id = take_string(
        object,
        &Field {
            name: "id",
            max: 100,
            required: true,
        },
        &mut details,
    );
    let entity_id = take_string(
        object,
        &Field {
            name: "entityId",
            max: 100,
            required: true,
        },
        &mut details,
    );
    let recurrence = take_string(
        object,
        &Field {
            name: "recurrence",
            max: 200,
            required: false,
        },
        &mut details,
    );
    let next_due = take_string(
        object,
        &Field {
            name: "nextDue",
            max: 50,
            required: false,
        },
        &mut details,
    );
    let last_completed = take_string(
        object,
        &Field {
            name: "lastCompleted",
            max: 50,
            required: false,
        },
        &mut details,
    );

    let is_active = match object.get("isActive") {
        Some(Value::Bool(b)) => *b,
        // `z.boolean().default(true)` — absent means active.
        None | Some(Value::Null) => true,
        Some(_) => {
            details
                .entry("isActive".into())
                .or_default()
                .push("Expected boolean".into());
            true
        }
    };
    if !details.is_empty() {
        return validation_failure(details);
    }

    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };
    let entity_id = entity_id.unwrap_or_default();
    if !visible.contains(&entity_id) {
        // Deliberately a different message from the other 404s on this route.
        return not_found("Entity not found");
    }

    let row = ScheduleRow {
        id: id.unwrap_or_default(),
        entity_id: Some(entity_id),
        recurrence,
        next_due,
        last_completed,
        is_active: Some(if is_active { 1 } else { 0 }),
    };

    let result = sqlx::query(
        "INSERT INTO schedules (id, entityId, recurrence, nextDue, lastCompleted, isActive) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.entity_id)
    .bind(&row.recurrence)
    .bind(&row.next_due)
    .bind(&row.last_completed)
    .bind(row.is_active)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(row.to_json())).into_response(),
        Err(e) => server_error("creating schedule", e),
    }
}

/// `PATCH /api/schedules/{id}`
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    match visible_row(&state, &user, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("Schedule not found"),
        Err(response) => return response,
    }

    let updates = body
        .and_then(|Json(b)| b.as_object().cloned())
        .unwrap_or_default();
    let mut assignments = Vec::new();
    let mut binds = Vec::new();
    for field in ["entityId", "recurrence", "nextDue", "lastCompleted"] {
        if let Some(value) = updates.get(field) {
            assignments.push(format!("{field} = ?"));
            binds.push(Bind::from_json(value));
        }
    }
    if let Some(value) = updates.get("isActive") {
        // `body.isActive ? 1 : 0` — JS truthiness, so 0 and "" are false.
        let truthy = match value {
            Value::Bool(b) => *b,
            Value::Null => false,
            Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
            Value::String(s) => !s.is_empty(),
            _ => true,
        };
        assignments.push("isActive = ?".to_string());
        binds.push(Bind::Int(truthy as i64));
    }

    if !assignments.is_empty() {
        let sql = format!(
            "UPDATE schedules SET {} WHERE id = ?",
            assignments.join(", ")
        );
        binds.push(Bind::Text(id.clone()));
        if let Err(e) = bind_all(sqlx::query(AssertSqlSafe(sql)), binds)
            .execute(&state.pool)
            .await
        {
            return server_error("updating schedule", e);
        }
    }

    match fetch(&state, &id).await {
        Ok(Some(row)) => Json(row.to_json()).into_response(),
        Ok(None) => not_found("Schedule not found"),
        Err(e) => server_error("reloading schedule", e),
    }
}

/// `DELETE /api/schedules/{id}`
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match visible_row(&state, &user, &id).await {
        Ok(Some(_)) => {}
        Ok(None) => return not_found("Schedule not found"),
        Err(response) => return response,
    }

    match sqlx::query("DELETE FROM schedules WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => ok_true(),
        Err(e) => server_error("deleting schedule", e),
    }
}

/// Loads a schedule only if its entity is visible to the caller. `Err` carries a ready response
/// for the database-failure case, keeping the handlers flat.
async fn visible_row(
    state: &AppState,
    user: &AuthUser,
    id: &str,
) -> Result<Option<ScheduleRow>, Response> {
    let row = match fetch(state, id).await {
        Ok(Some(row)) => row,
        Ok(None) => return Ok(None),
        Err(e) => return Err(server_error("fetching schedule", e)),
    };
    let visible = user_entity_ids(&state.pool, &user.user_id)
        .await
        .map_err(|e| server_error("loading visible entity ids", e))?;
    Ok(row.is_visible(&visible).then_some(row))
}

async fn fetch(state: &AppState, id: &str) -> Result<Option<ScheduleRow>, sqlx::Error> {
    sqlx::query_as::<_, ScheduleRow>(AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.pool)
        .await
}
