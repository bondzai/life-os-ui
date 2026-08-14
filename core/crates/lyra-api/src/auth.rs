//! PIN login and JWT verification — a contract-identical port of `api/src/middleware/auth.ts`.
//!
//! Same paths, same JSON bodies, same status codes, same 7-day expiry and 5-attempt rate limit, so
//! the React client needs no change.
//!
//! **One deliberate behavioural difference.** The live `life-os.db` stores PINs in *plaintext*
//! (`user-jb` = `1234`), while `auth.ts:46` verifies with `bcrypt.compareSync` — so login is broken
//! on that database today. [`verify_pin`] therefore accepts a plaintext match when the stored value
//! is not a bcrypt hash, and the login handler immediately re-stores it hashed. Once both users
//! have logged in once, [`PinKind::Plaintext`] and its branch can be deleted.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use subtle::ConstantTimeEq;

use crate::AppState;

/// Matches `RATE_LIMIT_MAX` in auth.ts — the 6th attempt in a window is rejected.
const RATE_LIMIT_MAX: u32 = 5;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(15 * 60);
const TOKEN_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// bcrypt's work factor. 10 is what `seed.ts` uses; keep them in step.
const BCRYPT_COST: u32 = 10;

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    #[serde(default)]
    pub pin: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    /// camelCase to match the token `auth.ts` issues; existing tokens must keep working.
    #[serde(rename = "userId")]
    pub user_id: String,
    pub role: String,
    pub exp: usize,
}

#[derive(Debug, Default)]
pub struct RateLimiter {
    attempts: Mutex<HashMap<String, Attempt>>,
}

#[derive(Debug, Clone, Copy)]
struct Attempt {
    count: u32,
    reset_at: SystemTime,
}

impl RateLimiter {
    /// `true` if the attempt is allowed. Mirrors auth.ts: the counter advances on *every*
    /// attempt, successful ones included.
    pub fn check(&self, ip: &str) -> bool {
        self.check_at(ip, SystemTime::now())
    }

    fn check_at(&self, ip: &str, now: SystemTime) -> bool {
        let mut attempts = self.attempts.lock().expect("rate limiter mutex poisoned");
        match attempts.get_mut(ip) {
            Some(entry) if now <= entry.reset_at => {
                entry.count += 1;
                entry.count <= RATE_LIMIT_MAX
            }
            _ => {
                attempts.insert(
                    ip.to_string(),
                    Attempt {
                        count: 1,
                        reset_at: now + RATE_LIMIT_WINDOW,
                    },
                );
                true
            }
        }
    }
}

/// How a stored PIN is encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinKind {
    Bcrypt,
    /// Legacy rows written before hashing was applied. Upgraded on first successful login.
    Plaintext,
}

pub fn pin_kind(stored: &str) -> PinKind {
    // The three bcrypt prefixes in the wild. Anything else cannot be a bcrypt digest.
    if stored.starts_with("$2a$") || stored.starts_with("$2b$") || stored.starts_with("$2y$") {
        PinKind::Bcrypt
    } else {
        PinKind::Plaintext
    }
}

/// Verifies `supplied` against `stored`, returning the encoding that matched.
///
/// The plaintext comparison is constant-time: a home network is still a network, and a timing
/// oracle on a 4-digit PIN is worth avoiding for the cost of one crate.
pub fn verify_pin(stored: &str, supplied: &str) -> Option<PinKind> {
    match pin_kind(stored) {
        PinKind::Bcrypt => match bcrypt::verify(supplied, stored) {
            Ok(true) => Some(PinKind::Bcrypt),
            // A malformed hash is a non-match, never a crash.
            Ok(false) | Err(_) => None,
        },
        PinKind::Plaintext => {
            let matched: bool = stored.as_bytes().ct_eq(supplied.as_bytes()).into();
            matched.then_some(PinKind::Plaintext)
        }
    }
}

/// `x-forwarded-for`, then `x-real-ip`, then `"unknown"` — the same precedence as auth.ts.
fn client_ip(headers: &HeaderMap) -> String {
    for header in ["x-forwarded-for", "x-real-ip"] {
        if let Some(value) = headers.get(header).and_then(|v| v.to_str().ok())
            && !value.is_empty()
        {
            return value.to_string();
        }
    }
    "unknown".to_string()
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// `POST /api/auth/login`
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Option<Json<LoginRequest>>,
) -> Response {
    let ip = client_ip(&headers);
    if !state.rate_limiter.check(&ip) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many login attempts. Try again later.",
        );
    }

    let pin = match body.as_ref().and_then(|b| b.pin.as_deref()) {
        Some(pin) if !pin.is_empty() => pin,
        _ => return error(StatusCode::BAD_REQUEST, "PIN is required"),
    };

    let users: Vec<UserRow> =
        match sqlx::query_as("SELECT id, name, role, pin, avatarUrl FROM users")
            .fetch_all(&state.pool)
            .await
        {
            Ok(rows) => rows,
            Err(e) => {
                tracing::error!(error = %e, "loading users for login");
                return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
            }
        };

    // Every user is checked even after a match, so response time does not reveal which row hit.
    let mut found: Option<(UserRow, PinKind)> = None;
    for user in users {
        let Some(stored) = user.pin.as_deref() else {
            continue;
        };
        if let Some(kind) = verify_pin(stored, pin)
            && found.is_none()
        {
            found = Some((user, kind));
        }
    }

    let Some((user, kind)) = found else {
        return error(StatusCode::UNAUTHORIZED, "Invalid PIN");
    };

    if kind == PinKind::Plaintext {
        match bcrypt::hash(pin, BCRYPT_COST) {
            Ok(hashed) => {
                if let Err(e) = sqlx::query("UPDATE users SET pin = ? WHERE id = ?")
                    .bind(&hashed)
                    .bind(&user.id)
                    .execute(&state.pool)
                    .await
                {
                    // Not fatal: the user is authenticated, the upgrade can retry next login.
                    tracing::error!(error = %e, user = %user.id, "failed to upgrade plaintext PIN");
                } else {
                    tracing::info!(user = %user.id, "upgraded plaintext PIN to bcrypt");
                }
            }
            Err(e) => tracing::error!(error = %e, "hashing PIN for upgrade"),
        }
    }

    let token = match issue_token(
        &state.jwt_secret,
        &user.id,
        user.role.as_deref().unwrap_or(""),
    ) {
        Ok(token) => token,
        Err(e) => {
            tracing::error!(error = %e, "signing token");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
        }
    };

    Json(json!({
        "token": token,
        "user": {
            "id": user.id,
            "name": user.name,
            "role": user.role,
            "avatarUrl": user.avatar_url,
        }
    }))
    .into_response()
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub pin: Option<String>,
    #[sqlx(rename = "avatarUrl")]
    pub avatar_url: Option<String>,
}

pub fn issue_token(secret: &str, user_id: &str, role: &str) -> anyhow::Result<String> {
    let exp = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .saturating_add(TOKEN_TTL)
        .as_secs() as usize;
    let claims = Claims {
        user_id: user_id.to_string(),
        role: role.to_string(),
        exp,
    };
    Ok(jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(secret.as_bytes()),
    )?)
}

pub fn decode_token(secret: &str, token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    jsonwebtoken::decode::<Claims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    )
    .map(|data| data.claims)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_bcrypt_and_plaintext_storage() {
        let hashed = bcrypt::hash("1234", 4).unwrap();
        assert_eq!(pin_kind(&hashed), PinKind::Bcrypt);
        // The shape actually found in life-os.db.
        assert_eq!(pin_kind("1234"), PinKind::Plaintext);
        assert_eq!(pin_kind(""), PinKind::Plaintext);
    }

    #[test]
    fn verifies_a_bcrypt_pin() {
        let hashed = bcrypt::hash("1234", 4).unwrap();
        assert_eq!(verify_pin(&hashed, "1234"), Some(PinKind::Bcrypt));
        assert_eq!(verify_pin(&hashed, "9999"), None);
    }

    #[test]
    fn verifies_a_plaintext_pin_and_reports_it_as_such() {
        assert_eq!(verify_pin("1234", "1234"), Some(PinKind::Plaintext));
        assert_eq!(verify_pin("1234", "9999"), None);
    }

    #[test]
    fn a_malformed_hash_is_a_non_match_not_a_panic() {
        // Truncated bcrypt: has the prefix, cannot be parsed.
        assert_eq!(verify_pin("$2b$10$tooshort", "1234"), None);
    }

    #[test]
    fn a_plaintext_pin_is_not_matched_by_its_own_hash() {
        let hashed = bcrypt::hash("1234", 4).unwrap();
        assert_eq!(verify_pin("1234", &hashed), None);
    }

    #[test]
    fn rate_limiter_allows_five_then_blocks() {
        let limiter = RateLimiter::default();
        for attempt in 1..=RATE_LIMIT_MAX {
            assert!(
                limiter.check("1.2.3.4"),
                "attempt {attempt} should be allowed"
            );
        }
        assert!(
            !limiter.check("1.2.3.4"),
            "the 6th attempt should be blocked"
        );
    }

    #[test]
    fn rate_limiter_is_per_ip() {
        let limiter = RateLimiter::default();
        for _ in 0..=RATE_LIMIT_MAX {
            limiter.check("1.2.3.4");
        }
        assert!(
            limiter.check("5.6.7.8"),
            "a different client must not inherit the block"
        );
    }

    #[test]
    fn rate_limiter_window_expires() {
        let limiter = RateLimiter::default();
        let start = SystemTime::now();
        for _ in 0..=RATE_LIMIT_MAX {
            limiter.check_at("1.2.3.4", start);
        }
        assert!(!limiter.check_at("1.2.3.4", start));
        let later = start + RATE_LIMIT_WINDOW + Duration::from_secs(1);
        assert!(
            limiter.check_at("1.2.3.4", later),
            "a fresh window should reset the count"
        );
    }

    #[test]
    fn client_ip_prefers_forwarded_for_then_real_ip() {
        let mut headers = HeaderMap::new();
        assert_eq!(client_ip(&headers), "unknown");
        headers.insert("x-real-ip", "5.6.7.8".parse().unwrap());
        assert_eq!(client_ip(&headers), "5.6.7.8");
        headers.insert("x-forwarded-for", "1.2.3.4".parse().unwrap());
        assert_eq!(client_ip(&headers), "1.2.3.4");
    }

    #[test]
    fn tokens_round_trip_and_carry_the_camel_case_claim() {
        let token = issue_token("secret", "user-jb", "admin").unwrap();
        let claims = decode_token("secret", &token).unwrap();
        assert_eq!(claims.user_id, "user-jb");
        assert_eq!(claims.role, "admin");

        // The wire format must stay `userId`, matching the token auth.ts issues.
        let payload = token.split('.').nth(1).unwrap();
        use base64::Engine;
        let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        assert!(
            value.get("userId").is_some(),
            "claim must be userId, got {value}"
        );
    }

    #[test]
    fn a_token_signed_with_another_secret_is_rejected() {
        let token = issue_token("secret", "user-jb", "admin").unwrap();
        assert!(decode_token("different-secret", &token).is_err());
    }
}

/// The authenticated caller, attached to the request by [`require_auth`].
#[derive(Clone, Debug)]
pub struct AuthUser {
    pub user_id: String,
    /// Carried because the JWT has it and `auth.ts:78` sets it. No route reads it — not here and
    /// not in the TypeScript, where every `Env` type declares `userRole` and none uses it.
    #[allow(dead_code)]
    pub role: String,
}

/// JWT gate — the port of `jwtMiddleware()` in auth.ts, including its two distinct messages:
/// a missing or malformed header is `Unauthorized`, a header that fails verification is
/// `Invalid or expired token`.
pub async fn require_auth(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let header = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let Some(token) = header.and_then(|h| h.strip_prefix("Bearer ")) else {
        return error(StatusCode::UNAUTHORIZED, "Unauthorized");
    };

    match decode_token(&state.jwt_secret, token) {
        Ok(claims) => {
            request.extensions_mut().insert(AuthUser {
                user_id: claims.user_id,
                role: claims.role,
            });
            next.run(request).await
        }
        Err(_) => error(StatusCode::UNAUTHORIZED, "Invalid or expired token"),
    }
}

/// Lets handlers take `user: AuthUser` directly. The middleware has already run by then, so a
/// missing extension means the route was mounted without the gate — fail closed rather than
/// serving an unauthenticated request.
impl<S: Send + Sync> axum::extract::FromRequestParts<S> for AuthUser {
    type Rejection = Response;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &S,
    ) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthUser>()
            .cloned()
            .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "Unauthorized"))
    }
}
