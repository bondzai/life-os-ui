//! `/api/relations` — port of `api/src/routes/relations.ts`.
//!
//! A relation is visible when **either** endpoint is an entity the caller can see (owned or
//! shared) — `relations.ts:37`. Filtering happens in Rust rather than SQL for the same reason it
//! does in the original: the visible-id set is needed whole anyway.

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
    Details, Field, not_found, ok_true, server_error, take_string, user_entity_ids,
    validation_failure,
};

const SELECT: &str = "SELECT id, fromId, toId, type FROM relations";

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RelationRow {
    pub id: String,
    #[sqlx(rename = "fromId")]
    pub from_id: Option<String>,
    #[sqlx(rename = "toId")]
    pub to_id: Option<String>,
    pub r#type: Option<String>,
}

impl RelationRow {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "fromId": self.from_id, "toId": self.to_id, "type": self.r#type })
    }

    fn touches(&self, visible: &std::collections::BTreeSet<String>) -> bool {
        let hit = |id: &Option<String>| id.as_deref().is_some_and(|i| visible.contains(i));
        hit(&self.from_id) || hit(&self.to_id)
    }
}

#[derive(Debug, Deserialize)]
pub struct ListFilters {
    #[serde(rename = "fromId")]
    pub from_id: Option<String>,
    #[serde(rename = "toId")]
    pub to_id: Option<String>,
}

/// `GET /api/relations`
pub async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(filters): Query<ListFilters>,
) -> Response {
    let mut sql = SELECT.to_string();
    let mut clauses = Vec::new();
    if filters.from_id.is_some() {
        clauses.push("fromId = ?");
    }
    if filters.to_id.is_some() {
        clauses.push("toId = ?");
    }
    if !clauses.is_empty() {
        sql.push_str(" WHERE ");
        sql.push_str(&clauses.join(" AND "));
    }

    let mut query = sqlx::query_as::<_, RelationRow>(AssertSqlSafe(sql));
    for value in [&filters.from_id, &filters.to_id].into_iter().flatten() {
        query = query.bind(value);
    }

    let rows = match query.fetch_all(&state.pool).await {
        Ok(rows) => rows,
        Err(e) => return server_error("listing relations", e),
    };
    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };

    Json(
        rows.iter()
            .filter(|r| r.touches(&visible))
            .map(RelationRow::to_json)
            .collect::<Vec<_>>(),
    )
    .into_response()
}

/// `GET /api/relations/{id}`
pub async fn get_one(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    let row = match fetch(&state, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Relation not found"),
        Err(e) => return server_error("fetching relation", e),
    };
    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };

    if row.touches(&visible) {
        Json(row.to_json()).into_response()
    } else {
        not_found("Relation not found")
    }
}

/// `POST /api/relations`
///
/// Note the status code: an endpoint the caller cannot see yields **404 "Relation not found"**,
/// not 403 and not a validation error (`relations.ts:68`).
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
    let from_id = take_string(
        object,
        &Field {
            name: "fromId",
            max: 100,
            required: true,
        },
        &mut details,
    );
    let to_id = take_string(
        object,
        &Field {
            name: "toId",
            max: 100,
            required: true,
        },
        &mut details,
    );
    let kind = take_string(
        object,
        &Field {
            name: "type",
            max: 50,
            required: true,
        },
        &mut details,
    );
    if !details.is_empty() {
        return validation_failure(details);
    }

    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };
    let row = RelationRow {
        id: id.unwrap_or_default(),
        from_id,
        to_id,
        r#type: kind,
    };
    if !row.touches(&visible) {
        return not_found("Relation not found");
    }

    let result = sqlx::query("INSERT INTO relations (id, fromId, toId, type) VALUES (?, ?, ?, ?)")
        .bind(&row.id)
        .bind(&row.from_id)
        .bind(&row.to_id)
        .bind(&row.r#type)
        .execute(&state.pool)
        .await;

    match result {
        Ok(_) => (StatusCode::CREATED, Json(row.to_json())).into_response(),
        Err(e) => server_error("creating relation", e),
    }
}

/// `DELETE /api/relations/{id}`
pub async fn delete(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    let row = match fetch(&state, &id).await {
        Ok(Some(row)) => row,
        Ok(None) => return not_found("Relation not found"),
        Err(e) => return server_error("loading relation for delete", e),
    };
    let visible = match user_entity_ids(&state.pool, &user.user_id).await {
        Ok(ids) => ids,
        Err(e) => return server_error("loading visible entity ids", e),
    };
    if !row.touches(&visible) {
        return not_found("Relation not found");
    }

    match sqlx::query("DELETE FROM relations WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
    {
        Ok(_) => ok_true(),
        Err(e) => server_error("deleting relation", e),
    }
}

async fn fetch(state: &AppState, id: &str) -> Result<Option<RelationRow>, sqlx::Error> {
    sqlx::query_as::<_, RelationRow>(AssertSqlSafe(format!("{SELECT} WHERE id = ?")))
        .bind(id)
        .fetch_optional(&state.pool)
        .await
}
