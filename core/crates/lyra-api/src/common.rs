//! Response shapes and binding helpers shared by the ported routes.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub type Details = BTreeMap<String, Vec<String>>;

pub fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

pub fn not_found(message: &str) -> Response {
    error(StatusCode::NOT_FOUND, message)
}

pub fn server_error(context: &str, e: sqlx::Error) -> Response {
    tracing::error!(error = %e, context, "database error");
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

pub fn validation_failure(details: Details) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "error": "Validation failed", "details": details })),
    )
        .into_response()
}

pub fn ok_true() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// The ids a user may reference: entities they own **plus** anything shared.
///
/// Port of `getUserEntityIds` (`api/src/db/helpers.ts`). Relations and schedules both hang their
/// authorisation off this, so "shared" propagates to them — a shared entity's schedule is visible
/// to everyone, which is the existing behaviour and is preserved deliberately.
pub async fn user_entity_ids(
    pool: &SqlitePool,
    user_id: &str,
) -> Result<BTreeSet<String>, sqlx::Error> {
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM entities WHERE ownerId = ? OR visibility = 'shared'")
            .bind(user_id)
            .fetch_all(pool)
            .await?;
    Ok(ids.into_iter().collect())
}

/// A JSON value ready to be bound to a statement. `sqlx` needs a concrete type per bind, so the
/// dynamic PATCH bodies these routes accept are funnelled through this.
#[derive(Debug, Clone, PartialEq)]
pub enum Bind {
    Text(String),
    Real(f64),
    Int(i64),
    Null,
}

impl Bind {
    pub fn from_json(value: &Value) -> Self {
        match value {
            Value::String(s) => Bind::Text(s.clone()),
            Value::Number(n) if n.is_i64() || n.is_u64() => {
                Bind::Int(n.as_i64().unwrap_or_default())
            }
            Value::Number(n) => Bind::Real(n.as_f64().unwrap_or_default()),
            Value::Bool(b) => Bind::Int(*b as i64),
            Value::Null => Bind::Null,
            // Objects and arrays reach the DB as their JSON text, matching what the
            // TypeScript did by handing the raw value to the driver.
            other => Bind::Text(other.to_string()),
        }
    }
}

/// Applies a list of [`Bind`]s to a query in order.
pub fn bind_all<'q>(
    mut query: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments>,
    binds: Vec<Bind>,
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    for bind in binds {
        query = match bind {
            Bind::Text(s) => query.bind(s),
            Bind::Real(f) => query.bind(f),
            Bind::Int(i) => query.bind(i),
            Bind::Null => query.bind(Option::<String>::None),
        };
    }
    query
}

/* ─── Small validation primitives, mirroring the zod schemas ─── */

pub struct Field<'a> {
    pub name: &'a str,
    pub max: usize,
    pub required: bool,
}

/// Validates a required-or-optional bounded string, recording any problem in `details`.
pub fn take_string(
    object: &serde_json::Map<String, Value>,
    field: &Field,
    details: &mut Details,
) -> Option<String> {
    match object.get(field.name) {
        Some(Value::String(s)) if s.is_empty() => {
            details
                .entry(field.name.to_string())
                .or_default()
                .push("Required".into());
            None
        }
        Some(Value::String(s)) if s.chars().count() > field.max => {
            details
                .entry(field.name.to_string())
                .or_default()
                .push(format!("Must be at most {} characters", field.max));
            None
        }
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Null) if !field.required => None,
        Some(_) => {
            details
                .entry(field.name.to_string())
                .or_default()
                .push("Expected string".into());
            None
        }
        None => {
            if field.required {
                details
                    .entry(field.name.to_string())
                    .or_default()
                    .push("Required".into());
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bind_distinguishes_integers_from_reals() {
        assert_eq!(Bind::from_json(&json!(3)), Bind::Int(3));
        assert_eq!(Bind::from_json(&json!(3.5)), Bind::Real(3.5));
        assert_eq!(Bind::from_json(&json!(null)), Bind::Null);
        assert_eq!(Bind::from_json(&json!(true)), Bind::Int(1));
        assert_eq!(Bind::from_json(&json!("x")), Bind::Text("x".into()));
    }

    #[test]
    fn take_string_reports_missing_required_fields() {
        let object = json!({}).as_object().unwrap().clone();
        let mut details = Details::new();
        let field = Field {
            name: "id",
            max: 100,
            required: true,
        };
        assert_eq!(take_string(&object, &field, &mut details), None);
        assert_eq!(details["id"], vec!["Required".to_string()]);
    }

    #[test]
    fn take_string_enforces_the_maximum_length() {
        let object = json!({ "id": "x".repeat(101) })
            .as_object()
            .unwrap()
            .clone();
        let mut details = Details::new();
        let field = Field {
            name: "id",
            max: 100,
            required: true,
        };
        assert_eq!(take_string(&object, &field, &mut details), None);
        assert!(details["id"][0].contains("at most 100"));
    }

    #[test]
    fn take_string_accepts_a_valid_value_without_complaint() {
        let object = json!({ "id": "abc" }).as_object().unwrap().clone();
        let mut details = Details::new();
        let field = Field {
            name: "id",
            max: 100,
            required: true,
        };
        assert_eq!(
            take_string(&object, &field, &mut details),
            Some("abc".into())
        );
        assert!(details.is_empty());
    }
}
