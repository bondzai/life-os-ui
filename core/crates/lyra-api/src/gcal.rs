//! `/api/gcal` — port of `api/src/routes/gcal.ts`.
//!
//! Three groups of routes, with different authentication, exactly as `api/src/index.ts:43-47`
//! mounts them:
//!
//! * **JWT-protected**: `auth/url`, `auth/status`, `auth/disconnect`, and the `events` CRUD.
//! * **Unauthenticated by necessity**: `auth/callback` — Google redirects the browser here, with
//!   no Authorization header. CSRF is handled instead by a one-time `state` token.
//! * **Unauthenticated by design**: the `{calendarId}` proxies, which read *public* calendars
//!   through Google's own embed key.
//!
//! Note that this route group is the one that needs the `google_tokens` table, which is missing
//! from the live `life-os.db` — see `lyra-db`'s migration v1, which creates it.

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use crate::AppState;
use crate::auth::AuthUser;

const STATE_TTL: Duration = Duration::from_secs(10 * 60);
/// Google Calendar's own embed widget uses this public key; it works for any *public* calendar
/// with no user configuration. `GCAL_API_KEY` overrides it.
const EMBED_PUBLIC_KEY: &str = "AIzaSyBNlYH01_9Hc5S1J9vuFmu2nUqBZJNAXxs";
const GCAL_API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const GOOGLE_OAUTH_BASE: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const OAUTH_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events";
/// Refresh this long before actual expiry, so a token cannot lapse mid-request.
const EXPIRY_BUFFER: Duration = Duration::from_secs(60);

/// Google's colorId → hex palette.
pub fn event_color(color_id: &str) -> Option<&'static str> {
    Some(match color_id {
        "1" => "#7986cb",
        "2" => "#33b679",
        "3" => "#8e24aa",
        "4" => "#e67c73",
        "5" => "#f6bf26",
        "6" => "#f4511e",
        "7" => "#039be5",
        "8" => "#616161",
        "9" => "#3f51b5",
        "10" => "#0b8043",
        "11" => "#d50000",
        _ => return None,
    })
}

fn api_key() -> String {
    std::env::var("GCAL_API_KEY")
        .ok()
        .filter(|k| !k.is_empty())
        .unwrap_or_else(|| EMBED_PUBLIC_KEY.to_string())
}

fn frontend_url() -> String {
    std::env::var("FRONTEND_URL")
        .ok()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| "http://localhost:5173".to_string())
}

/* ─── OAuth state (CSRF) ─── */

/// Pending OAuth handshakes, keyed by the opaque `state` parameter.
///
/// In-memory like the original, so a restart mid-handshake invalidates it — acceptable for a
/// 10-minute window, and it avoids persisting a CSRF token.
#[derive(Debug, Default)]
pub struct OAuthStates {
    entries: Mutex<HashMap<String, (String, SystemTime)>>,
}

impl OAuthStates {
    /// Mints a single-use state token bound to `user_id`, sweeping expired entries as it goes.
    pub fn create(&self, user_id: &str) -> String {
        self.create_at(user_id, SystemTime::now())
    }

    fn create_at(&self, user_id: &str, now: SystemTime) -> String {
        let state: String = {
            // rand 0.10 renamed the old `RngCore` to `Rng`; `fill_bytes` lives there.
            use rand::Rng;
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        };
        let mut entries = self.entries.lock().expect("oauth state mutex poisoned");
        entries.retain(|_, (_, expires_at)| *expires_at >= now);
        entries.insert(state.clone(), (user_id.to_string(), now + STATE_TTL));
        state
    }

    /// Consumes a state token, returning the user it was minted for. Expired or unknown tokens
    /// yield `None`, and a token is never valid twice.
    pub fn validate(&self, state: &str) -> Option<String> {
        self.validate_at(state, SystemTime::now())
    }

    fn validate_at(&self, state: &str, now: SystemTime) -> Option<String> {
        let mut entries = self.entries.lock().expect("oauth state mutex poisoned");
        let (user_id, expires_at) = entries.remove(state)?;
        (expires_at >= now).then_some(user_id)
    }
}

/* ─── Token storage ─── */

#[derive(Debug, Clone, sqlx::FromRow)]
struct TokenRow {
    #[sqlx(rename = "accessToken")]
    access_token: Option<String>,
    #[sqlx(rename = "refreshToken")]
    refresh_token: Option<String>,
    #[sqlx(rename = "expiresAt")]
    expires_at: Option<String>,
    #[sqlx(rename = "calendarId")]
    calendar_id: Option<String>,
}

async fn load_token(state: &AppState, user_id: &str) -> Option<TokenRow> {
    sqlx::query_as::<_, TokenRow>(
        "SELECT accessToken, refreshToken, expiresAt, calendarId FROM google_tokens WHERE userId = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .ok()
    .flatten()
}

struct ActiveToken {
    access_token: String,
    calendar_id: Option<String>,
}

/// Returns a usable access token, refreshing it first when it is within [`EXPIRY_BUFFER`] of
/// expiry. `None` means "not connected" and maps to a 401 at every call site.
async fn valid_access_token(state: &AppState, user_id: &str) -> Option<ActiveToken> {
    let row = load_token(state, user_id).await?;
    let (access_token, refresh_token) = (row.access_token.clone()?, row.refresh_token.clone()?);

    let expires_at = row
        .expires_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0);
    let now_ms = chrono::Utc::now().timestamp_millis();

    if expires_at > now_ms + EXPIRY_BUFFER.as_millis() as i64 {
        return Some(ActiveToken {
            access_token,
            calendar_id: row.calendar_id,
        });
    }

    let client_id = std::env::var("GOOGLE_CLIENT_ID").ok()?;
    let client_secret = std::env::var("GOOGLE_CLIENT_SECRET").ok()?;

    let response = reqwest::Client::new()
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token.as_str()),
            ("grant_type", "refresh_token"),
        ])
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let data: Value = response.json().await.ok()?;
    let new_access = data.get("access_token")?.as_str()?.to_string();
    let expires_in = data.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(0);
    let new_expires = iso_millis(chrono::Utc::now() + chrono::Duration::seconds(expires_in));

    let _ = sqlx::query("UPDATE google_tokens SET accessToken = ?, expiresAt = ? WHERE userId = ?")
        .bind(&new_access)
        .bind(&new_expires)
        .bind(user_id)
        .execute(&state.pool)
        .await;

    Some(ActiveToken {
        access_token: new_access,
        calendar_id: row.calendar_id,
    })
}

/// `Date.prototype.toISOString()` — UTC, milliseconds, `Z`.
fn iso_millis(dt: chrono::DateTime<chrono::Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/* ─── OAuth routes ─── */

/// `GET /api/gcal/auth/url`
pub async fn auth_url(State(state): State<AppState>, user: AuthUser) -> Response {
    let (Ok(client_id), Ok(redirect_uri)) = (
        std::env::var("GOOGLE_CLIENT_ID"),
        std::env::var("GOOGLE_REDIRECT_URI"),
    ) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Google OAuth not configured" })),
        )
            .into_response();
    };

    let token = state.gcal_states.create(&user.user_id);
    let query = [
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", OAUTH_SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("state", token.as_str()),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={}", form_urlencode(v)))
    .collect::<Vec<_>>()
    .join("&");

    Json(json!({ "url": format!("{GOOGLE_OAUTH_BASE}?{query}") })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// `GET /api/gcal/auth/callback` — **not** JWT-protected; Google redirects a browser here.
///
/// Every failure path is the same redirect, so a caller cannot distinguish "bad state" from
/// "token exchange failed" — deliberate, and preserved from the original.
pub async fn auth_callback(
    State(state): State<AppState>,
    Query(params): Query<CallbackQuery>,
) -> Response {
    let front = frontend_url();
    let failure = redirect(&format!("{front}/calendar?google=error"));

    if params.error.is_some() {
        return failure;
    }
    let (Some(code), Some(state_token)) = (params.code, params.state) else {
        return failure;
    };
    let Some(user_id) = state.gcal_states.validate(&state_token) else {
        return failure;
    };
    let (Ok(client_id), Ok(client_secret), Ok(redirect_uri)) = (
        std::env::var("GOOGLE_CLIENT_ID"),
        std::env::var("GOOGLE_CLIENT_SECRET"),
        std::env::var("GOOGLE_REDIRECT_URI"),
    ) else {
        return failure;
    };

    let client = reqwest::Client::new();
    let Ok(response) = client
        .post(GOOGLE_TOKEN_URL)
        .form(&[
            ("code", code.as_str()),
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ])
        .send()
        .await
    else {
        return failure;
    };
    if !response.status().is_success() {
        return failure;
    }
    let Ok(data) = response.json::<Value>().await else {
        return failure;
    };
    let Some(access_token) = data.get("access_token").and_then(|v| v.as_str()) else {
        return failure;
    };
    let expires_in = data.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(0);
    let expires_at = iso_millis(chrono::Utc::now() + chrono::Duration::seconds(expires_in));
    let refresh_token = data.get("refresh_token").and_then(|v| v.as_str());

    // Best-effort: a missing primary calendar id is not fatal.
    let calendar_id = client
        .get(format!("{GCAL_API_BASE}/calendars/primary"))
        .bearer_auth(access_token)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()
        .filter(|r| r.status().is_success())
        .map(|r| async move { r.json::<Value>().await.ok() });
    let calendar_id = match calendar_id {
        Some(fut) => fut
            .await
            .and_then(|v| v.get("id").and_then(|i| i.as_str().map(String::from))),
        None => None,
    };

    let existing = load_token(&state, &user_id).await;
    let result = match &existing {
        Some(row) => {
            // Google only returns a refresh_token on first consent; keep the stored one otherwise.
            let refresh = refresh_token
                .map(String::from)
                .or_else(|| row.refresh_token.clone());
            sqlx::query(
                "UPDATE google_tokens SET accessToken = ?, refreshToken = ?, expiresAt = ?, \
                 calendarId = ? WHERE userId = ?",
            )
            .bind(access_token)
            .bind(&refresh)
            .bind(&expires_at)
            .bind(&calendar_id)
            .bind(&user_id)
            .execute(&state.pool)
            .await
        }
        None => sqlx::query(
            "INSERT INTO google_tokens (userId, accessToken, refreshToken, expiresAt, calendarId) \
                 VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&user_id)
        .bind(access_token)
        .bind(refresh_token)
        .bind(&expires_at)
        .bind(&calendar_id)
        .execute(&state.pool)
        .await,
    };

    if result.is_err() {
        return failure;
    }
    redirect(&format!("{front}/calendar?google=connected"))
}

/// A 302, matching Hono's `c.redirect` default. axum's `Redirect::to` is a 303, which browsers
/// treat the same for a GET but is not the status the original returned.
fn redirect(location: &str) -> Response {
    match location.parse() {
        Ok(value) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::LOCATION, value);
            (StatusCode::FOUND, headers).into_response()
        }
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

/// `GET /api/gcal/auth/status`
pub async fn auth_status(State(state): State<AppState>, user: AuthUser) -> Response {
    let row = load_token(&state, &user.user_id).await;
    // "Connected" means a refresh token exists — an access token alone cannot be renewed.
    let connected = row.as_ref().is_some_and(|r| r.refresh_token.is_some());
    let calendar_id = row.and_then(|r| r.calendar_id);
    Json(json!({ "connected": connected, "calendarId": calendar_id })).into_response()
}

/// `DELETE /api/gcal/auth/disconnect`
pub async fn auth_disconnect(State(state): State<AppState>, user: AuthUser) -> Response {
    let _ = sqlx::query("DELETE FROM google_tokens WHERE userId = ?")
        .bind(&user.user_id)
        .execute(&state.pool)
        .await;
    Json(json!({ "ok": true })).into_response()
}

/* ─── Event CRUD ─── */

fn not_connected() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Google Calendar not connected" })),
    )
        .into_response()
}

fn upstream_error(status: u16, body: &str) -> Response {
    let snippet: String = body.chars().take(200).collect();
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({ "error": format!("Google API {status}: {snippet}") })),
    )
        .into_response()
}

fn failed(message: &str) -> Response {
    (StatusCode::BAD_GATEWAY, Json(json!({ "error": message }))).into_response()
}

/// `POST /api/gcal/events`
pub async fn create_event(
    State(state): State<AppState>,
    user: AuthUser,
    body: Option<Json<Value>>,
) -> Response {
    let Some(token) = valid_access_token(&state, &user.user_id).await else {
        return not_connected();
    };
    let body = body.map(|Json(b)| b).unwrap_or_else(|| json!({}));
    let calendar_id = target_calendar(&body, &token);

    // Sent as-is including nulls, matching the original object literal.
    let mut event = Map::new();
    for field in ["summary", "description", "location", "start", "end"] {
        event.insert(
            field.into(),
            body.get(field).cloned().unwrap_or(Value::Null),
        );
    }
    if let Some(color) = body.get("colorId") {
        event.insert("colorId".into(), color.clone());
    }

    let url = format!(
        "{GCAL_API_BASE}/calendars/{}/events",
        urlencode_component(&calendar_id)
    );
    match send_json(
        &url,
        reqwest::Method::POST,
        &token.access_token,
        &Value::Object(event),
    )
    .await
    {
        Ok((status, text)) if status.is_success() => (
            StatusCode::CREATED,
            Json(serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)),
        )
            .into_response(),
        Ok((status, text)) => upstream_error(status.as_u16(), &text),
        Err(_) => failed("Failed to create event"),
    }
}

/// `PATCH /api/gcal/events/{eventId}` — only the fields present in the body are sent.
pub async fn update_event(
    State(state): State<AppState>,
    user: AuthUser,
    Path(event_id): Path<String>,
    body: Option<Json<Value>>,
) -> Response {
    let Some(token) = valid_access_token(&state, &user.user_id).await else {
        return not_connected();
    };
    let body = body.map(|Json(b)| b).unwrap_or_else(|| json!({}));
    let calendar_id = target_calendar(&body, &token);

    let mut event = Map::new();
    for field in [
        "summary",
        "description",
        "location",
        "start",
        "end",
        "colorId",
    ] {
        if let Some(value) = body.get(field) {
            event.insert(field.into(), value.clone());
        }
    }

    let url = format!(
        "{GCAL_API_BASE}/calendars/{}/events/{}",
        urlencode_component(&calendar_id),
        urlencode_component(&event_id)
    );
    match send_json(
        &url,
        reqwest::Method::PATCH,
        &token.access_token,
        &Value::Object(event),
    )
    .await
    {
        Ok((status, text)) if status.is_success() => {
            Json(serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)).into_response()
        }
        Ok((status, text)) => upstream_error(status.as_u16(), &text),
        Err(_) => failed("Failed to update event"),
    }
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    #[serde(rename = "calendarId")]
    pub calendar_id: Option<String>,
}

/// `DELETE /api/gcal/events/{eventId}`
pub async fn delete_event(
    State(state): State<AppState>,
    user: AuthUser,
    Path(event_id): Path<String>,
    Query(params): Query<DeleteQuery>,
) -> Response {
    let Some(token) = valid_access_token(&state, &user.user_id).await else {
        return not_connected();
    };
    let calendar_id = params
        .calendar_id
        .or_else(|| token.calendar_id.clone())
        .unwrap_or_else(|| "primary".into());

    let url = format!(
        "{GCAL_API_BASE}/calendars/{}/events/{}",
        urlencode_component(&calendar_id),
        urlencode_component(&event_id)
    );
    let result = reqwest::Client::new()
        .delete(&url)
        .bearer_auth(&token.access_token)
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    match result {
        // 410 Gone means it was already deleted — treated as success, not an error.
        Ok(response) if response.status().is_success() || response.status().as_u16() == 410 => {
            Json(json!({ "ok": true })).into_response()
        }
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            upstream_error(status, &text)
        }
        Err(_) => failed("Failed to delete event"),
    }
}

fn target_calendar(body: &Value, token: &ActiveToken) -> String {
    body.get("calendarId")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| token.calendar_id.clone())
        .unwrap_or_else(|| "primary".into())
}

async fn send_json(
    url: &str,
    method: reqwest::Method,
    access_token: &str,
    body: &Value,
) -> Result<(reqwest::StatusCode, String), reqwest::Error> {
    let response = reqwest::Client::new()
        .request(method, url)
        .bearer_auth(access_token)
        .json(body)
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    let status = response.status();
    Ok((status, response.text().await.unwrap_or_default()))
}

/* ─── Public proxies (no auth) ─── */

/// The window the calendar view fetches: from the 1st of two months ago to the last day of two
/// months ahead. Computed in **local** time like the original `new Date(y, m, d)` calls, then
/// rendered as UTC.
pub fn event_window(now: chrono::DateTime<chrono::Local>) -> (String, String) {
    use chrono::{Datelike, TimeZone};
    let shift = |months: i32| -> (i32, u32) {
        let zero_based = now.year() * 12 + now.month0() as i32 + months;
        (
            zero_based.div_euclid(12),
            zero_based.rem_euclid(12) as u32 + 1,
        )
    };

    let (min_year, min_month) = shift(-2);
    let time_min = chrono::Local
        .with_ymd_and_hms(min_year, min_month, 1, 0, 0, 0)
        .single()
        .map(|dt| dt.with_timezone(&chrono::Utc));

    // `new Date(y, m + 3, 0)` — day zero of month m+3 is the last day of month m+2.
    let (max_year, max_month) = shift(3);
    let time_max = chrono::Local
        .with_ymd_and_hms(max_year, max_month, 1, 0, 0, 0)
        .single()
        .map(|dt| dt - chrono::Duration::days(1))
        .map(|dt| dt.with_timezone(&chrono::Utc));

    (
        time_min.map(iso_millis).unwrap_or_default(),
        time_max.map(iso_millis).unwrap_or_default(),
    )
}

/// `GET /api/gcal/{calendarId}/events` — public calendars via the embed key.
pub async fn public_events(Path(calendar_id): Path<String>) -> Response {
    let (time_min, time_max) = event_window(chrono::Local::now());
    let key = api_key();
    let query = [
        ("key", key.as_str()),
        ("timeMin", time_min.as_str()),
        ("timeMax", time_max.as_str()),
        ("singleEvents", "true"),
        ("orderBy", "startTime"),
        ("maxResults", "2500"),
        ("sanitizeHtml", "true"),
        ("calendarId", calendar_id.as_str()),
    ]
    .iter()
    .map(|(k, v)| format!("{k}={}", form_urlencode(v)))
    .collect::<Vec<_>>()
    .join("&");

    let url = format!(
        "{GCAL_API_BASE}/calendars/{}/events?{query}",
        urlencode_component(&calendar_id)
    );
    let result = reqwest::Client::new()
        .get(&url)
        // Google's embed key is Referer-restricted.
        .header(header::REFERER, "https://calendar.google.com")
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    let response = match result {
        Ok(response) => response,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "items": [], "error": "Request failed" })),
            )
                .into_response();
        }
    };
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "items": [], "error": format!("Google API {status}: {snippet}") })),
        )
            .into_response();
    }

    let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
    let (items, calendar_color) = map_events(&data);
    Json(json!({ "items": items, "calendarColor": calendar_color })).into_response()
}

/// Projects Google's event payload onto the client's shape, resolving each event's colour from
/// its `colorId` and falling back to the calendar's own colour.
pub fn map_events(data: &Value) -> (Vec<Value>, Option<String>) {
    let calendar_color = data
        .get("backgroundColor")
        .and_then(|v| v.as_str())
        .map(String::from);

    let items = data
        .get("items")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let color_id = item.get("colorId").and_then(|v| v.as_str());
                    let color = color_id
                        .and_then(event_color)
                        .map(String::from)
                        .or_else(|| calendar_color.clone());
                    json!({
                        "id": item.get("id"),
                        "summary": item.get("summary"),
                        "description": item.get("description"),
                        "location": item.get("location"),
                        "start": item.get("start"),
                        "end": item.get("end"),
                        "colorId": color_id,
                        "color": color,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    (items, calendar_color)
}

/// `GET /api/gcal/{calendarId}/color`
pub async fn public_color(Path(calendar_id): Path<String>) -> Response {
    let url = format!(
        "{GCAL_API_BASE}/calendars/{}?key={}&fields=backgroundColor,colorId,summary",
        urlencode_component(&calendar_id),
        form_urlencode(&api_key())
    );
    let result = reqwest::Client::new()
        .get(&url)
        .header(header::REFERER, "https://calendar.google.com")
        .timeout(Duration::from_secs(8))
        .send()
        .await;

    match result {
        Ok(response) if response.status().is_success() => {
            let data = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
            let color = data
                .get("backgroundColor")
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| {
                    data.get("colorId")
                        .and_then(|v| v.as_str())
                        .and_then(event_color)
                        .map(String::from)
                });
            Json(json!({ "color": color })).into_response()
        }
        Ok(response) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "color": null, "error": format!("Google API {}", response.status().as_u16()) })),
        )
            .into_response(),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "color": null, "error": "Request failed" })),
        )
            .into_response(),
    }
}

/// `GET /api/gcal/{calendarId}/ical` — proxies the public `.ics` feed, avoiding browser CORS.
pub async fn public_ical(Path(calendar_id): Path<String>) -> Response {
    let url = format!(
        "https://calendar.google.com/calendar/ical/{}/public/basic.ics",
        urlencode_component(&calendar_id)
    );
    let result = reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(15))
        .send()
        .await;

    match result {
        Ok(response) if response.status().is_success() => {
            let text = response.text().await.unwrap_or_default();
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, "text/calendar".parse().unwrap());
            (StatusCode::OK, headers, text).into_response()
        }
        Ok(_) => (StatusCode::BAD_GATEWAY, "Failed to fetch calendar").into_response(),
        Err(_) => (StatusCode::BAD_GATEWAY, "Request failed").into_response(),
    }
}

/* ─── Encoding ─── */

/// `encodeURIComponent` — used for path segments, so `/` must be escaped.
fn urlencode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(*byte as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `URLSearchParams` — same escaping, but a space becomes `+`.
fn form_urlencode(input: &str) -> String {
    urlencode_component(input).replace("%20", "+")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn a_state_token_is_single_use() {
        let states = OAuthStates::default();
        let token = states.create("user-jb");
        assert_eq!(states.validate(&token).as_deref(), Some("user-jb"));
        assert_eq!(states.validate(&token), None, "replay must fail");
    }

    #[test]
    fn an_unknown_state_is_rejected() {
        let states = OAuthStates::default();
        assert_eq!(states.validate("never-issued"), None);
    }

    #[test]
    fn an_expired_state_is_rejected() {
        let states = OAuthStates::default();
        let start = SystemTime::now();
        let token = states.create_at("user-jb", start);
        let later = start + STATE_TTL + Duration::from_secs(1);
        assert_eq!(states.validate_at(&token, later), None);
    }

    #[test]
    fn state_tokens_are_64_hex_chars_and_distinct() {
        let states = OAuthStates::default();
        let a = states.create("user-jb");
        let b = states.create("user-jb");
        assert_eq!(a.len(), 64, "32 random bytes, hex encoded");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn creating_a_state_sweeps_expired_entries() {
        let states = OAuthStates::default();
        let start = SystemTime::now();
        let stale = states.create_at("user-jb", start);
        states.create_at("user-jb", start + STATE_TTL + Duration::from_secs(1));
        // The stale entry should be gone even before anyone tries to use it.
        assert_eq!(states.entries.lock().unwrap().len(), 1);
        assert_eq!(states.validate(&stale), None);
    }

    #[test]
    fn colour_ids_map_to_the_google_palette() {
        assert_eq!(event_color("1"), Some("#7986cb"));
        assert_eq!(event_color("11"), Some("#d50000"));
        assert_eq!(event_color("99"), None);
    }

    #[test]
    fn events_fall_back_to_the_calendar_colour() {
        let data = json!({
            "backgroundColor": "#123456",
            "items": [
                { "id": "a", "summary": "Coloured", "colorId": "2" },
                { "id": "b", "summary": "Plain" }
            ]
        });
        let (items, calendar_color) = map_events(&data);
        assert_eq!(calendar_color.as_deref(), Some("#123456"));
        assert_eq!(items[0]["color"], "#33b679", "colorId wins");
        assert_eq!(items[1]["color"], "#123456", "no colorId falls back");
        assert_eq!(items[1]["colorId"], Value::Null);
    }

    #[test]
    fn an_unknown_colour_id_falls_back_to_the_calendar_colour() {
        let data = json!({
            "backgroundColor": "#123456",
            "items": [{ "id": "a", "colorId": "42" }]
        });
        let (items, _) = map_events(&data);
        assert_eq!(items[0]["color"], "#123456");
        assert_eq!(items[0]["colorId"], "42", "the raw id is still reported");
    }

    #[test]
    fn a_response_without_items_yields_an_empty_list() {
        let (items, color) = map_events(&json!({}));
        assert!(items.is_empty());
        assert_eq!(color, None);
    }

    #[test]
    fn the_event_window_spans_two_months_back_to_two_months_ahead() {
        // June 2026 → window opens 1 April, closes 31 August.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 6, 15, 12, 0, 0)
            .unwrap();
        let (min, max) = event_window(now);
        assert!(
            min.starts_with("2026-04-01") || min.starts_with("2026-03-31"),
            "min was {min}"
        );
        assert!(
            max.starts_with("2026-08-31") || max.starts_with("2026-08-30"),
            "max was {max}"
        );
    }

    #[test]
    fn the_event_window_rolls_across_a_year_boundary() {
        // January 2026 → opens in November 2025, closes end of March 2026.
        let now = chrono::Local
            .with_ymd_and_hms(2026, 1, 10, 12, 0, 0)
            .unwrap();
        let (min, max) = event_window(now);
        assert!(
            min.starts_with("2025-11-01") || min.starts_with("2025-10-31"),
            "min was {min}"
        );
        assert!(
            max.starts_with("2026-03-31") || max.starts_with("2026-03-30"),
            "max was {max}"
        );
    }

    #[test]
    fn path_segments_escape_slashes_but_query_values_use_plus_for_spaces() {
        assert_eq!(urlencode_component("a/b"), "a%2Fb");
        assert_eq!(urlencode_component("x y"), "x%20y");
        assert_eq!(form_urlencode("x y"), "x+y");
        assert_eq!(form_urlencode("user@example.com"), "user%40example.com");
    }
}
