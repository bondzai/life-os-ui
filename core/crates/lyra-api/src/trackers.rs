//! `/api/trackers` — port of `api/src/routes/trackers.ts`.
//!
//! Unlike entities, trackers are scoped to the owner alone — `shared` grants nothing here
//! (`trackers.ts:28`), so a shared entity's measurements stay private to whoever logged them.

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
    Bind, Details, Field, bind_all, not_found, ok_true, server_error, take_string,
    validation_failure,
};

const SELECT: &str = "SELECT id, entityId, value, unit, note, timestamp, ownerId FROM trackers";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TrackerRow {
    pub id: String,
    #[sqlx(rename = "entityId")]
    pub entity_id: Option<String>,
    pub value: Option<f64>,
    pub unit: Option<String>,
    pub note: Option<String>,
    pub timestamp: Option<String>,
    #[sqlx(rename = "ownerId")]
    pub owner_id: Option<String>,
}

impl TrackerRow {
    fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "entityId": self.entity_id,
            "value": self.value,
            "unit": self.unit,
            "note": self.note,
            "timestamp": self.timestamp,
            "ownerId": self.owner_id,
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct ListFilters {
    #[serde(rename = "entityId")]
    pub entity_id: Option<String>,
    pub start: Option<String>,
    pub end: Option<String>,
}

/// `GET /api/trackers` — `start`/`end` bound the ISO `timestamp` string inclusively.
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(filters): Query<ListFilters>,
) -> Response {
    let mut sql = format!("{SELECT} WHERE ownerId = ?");
    let mut binds = vec![Bind::Text(user.user_id.clone())];
    if let Some(entity_id) = &filters.entity_id {
        sql.push_str(" AND entityId = ?");
        binds.push(Bind::Text(entity_id.clone()));
    }
    if let Some(start) = &filters.start {
        sql.push_str(" AND timestamp >= ?");
        binds.push(Bind::Text(start.clone()));
    }
    if let Some(end) = &filters.end {
        sql.push_str(" AND timestamp <= ?");
        binds.push(Bind::Text(end.clone()));
    }

    let mut query = sqlx::query_as::<_, TrackerRow>(AssertSqlSafe(sql));
    for bind in binds {
        query = match bind {
            Bind::Text(s) => query.bind(s),
            _ => query,
        };
    }

    match query.fetch_all(&state.pool).await {
        Ok(rows) => Json(rows.iter().map(TrackerRow::to_json).collect::<Vec<_>>()).into_response(),
        Err(e) => server_error("listing trackers", e),
    }
}

/// `GET /api/trackers/{id}`
pub async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.owner_id.as_deref() == Some(user.user_id.as_str()) => {
            Json(row.to_json()).into_response()
        }
        Ok(_) => not_found("Tracker not found"),
        Err(e) => server_error("fetching tracker", e),
    }
}

/// `POST /api/trackers`
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
    let unit = take_string(
        object,
        &Field {
            name: "unit",
            max: 50,
            required: false,
        },
        &mut details,
    );
    let note = take_string(
        object,
        &Field {
            name: "note",
            max: 2000,
            required: false,
        },
        &mut details,
    );
    let timestamp = take_string(
        object,
        &Field {
            name: "timestamp",
            max: 50,
            required: false,
        },
        &mut details,
    );

    // `z.number()` — required, and a numeric string is not a number.
    let value = match object.get("value") {
        Some(Value::Number(n)) => n.as_f64(),
        Some(_) => {
            details
                .entry("value".into())
                .or_default()
                .push("Expected number".into());
            None
        }
        None => {
            details
                .entry("value".into())
                .or_default()
                .push("Required".into());
            None
        }
    };

    if !details.is_empty() {
        return validation_failure(details);
    }

    let timestamp = timestamp.unwrap_or_else(crate::entities::now_iso);
    let row = TrackerRow {
        id: id.unwrap_or_default(),
        entity_id,
        value,
        unit,
        note,
        timestamp: Some(timestamp),
        owner_id: Some(user.user_id.clone()),
    };

    let result = sqlx::query(
        "INSERT INTO trackers (id, entityId, value, unit, note, timestamp, ownerId) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.entity_id)
    .bind(row.value)
    .bind(&row.unit)
    .bind(&row.note)
    .bind(&row.timestamp)
    .bind(&row.owner_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(row.to_json())).into_response(),
        Err(e) => server_error("creating tracker", e),
    }
}

/// `PATCH /api/trackers/{id}`
///
/// Faithfully unvalidated: `trackers.ts:86` copies whatever the body holds for the five known
/// keys straight through, with no schema check. Ported as-is rather than tightened, because a
/// stricter Rust version would reject payloads the current client may be sending.
pub async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.owner_id.as_deref() == Some(user.user_id.as_str()) => {}
        Ok(_) => return not_found("Tracker not found"),
        Err(e) => return server_error("loading tracker for update", e),
    }

    let updates = body
        .and_then(|Json(b)| b.as_object().cloned())
        .unwrap_or_default();
    let mut assignments = Vec::new();
    let mut binds = Vec::new();
    for field in ["entityId", "value", "unit", "note", "timestamp"] {
        if let Some(value) = updates.get(field) {
            assignments.push(format!("{field} = ?"));
            binds.push(Bind::from_json(value));
        }
    }

    if !assignments.is_empty() {
        let sql = format!(
            "UPDATE trackers SET {} WHERE id = ?",
            assignments.join(", ")
        );
        binds.push(Bind::Text(id.clone()));
        if let Err(e) = bind_all(sqlx::query(AssertSqlSafe(sql)), binds)
            .execute(&state.pool)
            .await
        {
            return server_error("updating tracker", e);
        }
    }

    match fetch(&state, &id).await {
        Ok(Some(row)) => Json(row.to_json()).into_response(),
        Ok(None) => not_found("Tracker not found"),
        Err(e) => server_error("reloading tracker", e),
    }
}

/// `DELETE /api/trackers/{id}`
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match fetch(&state, &id).await {
        Ok(Some(row)) if row.owner_id.as_deref() == Some(user.user_id.as_str()) => {}
        Ok(_) => return not_found("Tracker not found"),
        Err(e) => return server_error("loading tracker for delete", e),
    }

    match sqlx::query("DELETE FROM trackers WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => ok_true(),
        Err(e) => server_error("deleting tracker", e),
    }
}

async fn fetch(state: &AppState, id: &str) -> Result<Option<TrackerRow>, sqlx::Error> {
    sqlx::query_as::<_, TrackerRow>(AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.pool)
        .await
}
