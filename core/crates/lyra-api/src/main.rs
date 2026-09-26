//! `lyra-api` — the single Rust backend.
//!
//! Replaces Lyra's Hono API (`api/src/index.ts`) and, in later phases, wallet-portfolio's
//! `server.py`. Routes are ported **contract-identical**: same paths, same JSON, same status codes,
//! so the existing React client runs against this binary with no front-end change. Any change the
//! front end needs means the port was wrong.

mod agents;
mod alert_loop;
mod auth;
mod bot_jobs;
mod bot_life;
mod bot_text;
mod collect;
mod common;
mod entities;
mod gcal;
mod grammar;
mod jobs;
mod knowledge;
mod relations;
mod schedules;
mod search;
mod tgbot;
mod trackers;
mod wealth;
mod workspaces;

use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, patch, post, put};
use axum::{Json, Router};
use serde_json::json;
use sqlx::SqlitePool;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::common::error;

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub jwt_secret: Arc<String>,
    pub rate_limiter: Arc<auth::RateLimiter>,
    /// Pending Google OAuth handshakes. In-memory, like the Map in gcal.ts.
    pub gcal_states: Arc<gcal::OAuthStates>,
    /// Live state of the background sweep, so `/api/wealth/alerts` can report it. Shared with
    /// [`alert_loop`]; inert (`running: false`) when the loop was never started.
    pub alert_meta: alert_loop::SharedMeta,
    /// Live state of the agent fleet, and the channel the Agents page listens on.
    pub fleet: agents::Fleet,
    /// One-shot tickets for the fleet socket. See [`agents::Tickets`] for why the JWT is not
    /// simply passed in the query string.
    pub tickets: agents::Tickets,
}

impl AppState {
    pub fn new(pool: SqlitePool, jwt_secret: String) -> Self {
        Self {
            pool,
            jwt_secret: Arc::new(jwt_secret),
            rate_limiter: Arc::new(auth::RateLimiter::default()),
            gcal_states: Arc::new(gcal::OAuthStates::default()),
            alert_meta: alert_loop::SharedMeta::default(),
            fleet: agents::Fleet::new(),
            tickets: agents::Tickets::default(),
        }
    }
}

/// Defaults match `api/src/index.ts:19`.
fn allowed_origins() -> Vec<String> {
    match std::env::var("CORS_ORIGINS") {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split(',')
            .map(|o| o.trim().to_string())
            .filter(|o| !o.is_empty())
            .collect(),
        _ => vec![
            "http://localhost:5173".into(),
            "http://localhost:8080".into(),
        ],
    }
}

pub fn app(state: AppState, origins: Vec<String>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin: &HeaderValue, _| {
            origin
                .to_str()
                .map(|o| origins.iter().any(|allowed| allowed == o))
                .unwrap_or(false)
        }))
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);

    // Everything behind the JWT gate. auth.ts applies `jwtMiddleware()` per prefix
    // (`api/src/index.ts:36-47`); grouping them here is the same thing with less repetition.
    let protected = Router::new()
        .route("/api/agents", get(agents::list))
        .route("/api/jobs", get(agents::jobs))
        .route("/api/jobs/{id}", get(agents::job_one))
        .route("/api/jobs/{id}/retry", post(agents::job_retry))
        .route("/api/jobs/{id}/cancel", post(agents::job_cancel))
        .route("/api/agents/ticket", post(agents::ticket))
        .route("/api/entities", get(entities::list).post(entities::create))
        .route(
            "/api/entities/{id}",
            get(entities::get_one)
                .patch(entities::update)
                .delete(entities::delete),
        )
        .route("/api/trackers", get(trackers::list).post(trackers::create))
        .route(
            "/api/trackers/{id}",
            get(trackers::get_one)
                .patch(trackers::update)
                .delete(trackers::delete),
        )
        .route(
            "/api/schedules",
            get(schedules::list).post(schedules::create),
        )
        .route(
            "/api/schedules/{id}",
            get(schedules::get_one)
                .patch(schedules::update)
                .delete(schedules::delete),
        )
        .route(
            "/api/relations",
            get(relations::list).post(relations::create),
        )
        .route(
            "/api/relations/{id}",
            get(relations::get_one).delete(relations::delete),
        )
        // The workspace's authored context. Registered before the knowledge routes it reads
        // from, so the narrower path is the one a reader meets first.
        .route("/api/workspaces", get(workspaces::index))
        .route("/api/workspaces/{slug}/context", get(workspaces::context))
        .route("/api/knowledge", get(knowledge::list))
        .route("/api/knowledge/search", get(knowledge::search))
        .route("/api/knowledge/history", get(knowledge::history))
        .route("/api/knowledge/log", post(knowledge::create_log))
        .route(
            "/api/knowledge/file/{*path}",
            get(knowledge::get_file).put(knowledge::put_file),
        )
        // gcal's protected subset — index.ts:43-47 names these five explicitly.
        .route("/api/gcal/auth/url", get(gcal::auth_url))
        .route("/api/gcal/auth/status", get(gcal::auth_status))
        .route("/api/gcal/auth/disconnect", delete(gcal::auth_disconnect))
        .route("/api/gcal/events", post(gcal::create_event))
        .route(
            "/api/gcal/events/{eventId}",
            patch(gcal::update_event).delete(gcal::delete_event),
        )
        // Wealth — the ported server.py surface, remounted under /api/wealth/*. Mirrors the
        // `router()` in wealth.rs's own tests; keep the two in step.
        .route("/api/wealth/portfolio", get(wealth::portfolio))
        .route("/api/wealth/wallet", get(wealth::wallet))
        .route("/api/wealth/fund", get(wealth::fund))
        .route("/api/wealth/sentiment", get(wealth::sentiment))
        .route("/api/wealth/yield-radar", get(wealth::yield_radar))
        // Neither of these is in `parity.toml`, and neither may be: they answer questions the
        // Python was never asked. See the note on `wealth::vfat_status`.
        .route("/api/wealth/opportunities", get(wealth::opportunities))
        .route("/api/wealth/vfat-status", get(wealth::vfat_status))
        .route("/api/wealth/kucoin", get(wealth::kucoin))
        .route("/api/wealth/price-history", get(wealth::price_history))
        .route(
            "/api/wealth/history",
            get(wealth::history).post(wealth::save_history),
        )
        .route("/api/wealth/snapshots", get(wealth::snapshots))
        .route(
            "/api/wealth/analyses",
            get(wealth::analyses).post(wealth::create_analysis),
        )
        .route("/api/wealth/analyses/{id}", get(wealth::analysis))
        .route(
            "/api/wealth/manual-assets",
            get(wealth::manual_assets).post(wealth::create_manual_asset),
        )
        .route(
            "/api/wealth/manual-assets/{id}",
            put(wealth::update_manual_asset).delete(wealth::delete_manual_asset),
        )
        .route(
            "/api/wealth/wallets",
            get(wealth::wallets).post(wealth::create_wallet),
        )
        .route("/api/wealth/wallets/{id}", delete(wealth::delete_wallet))
        .route("/api/wealth/notes", post(wealth::create_note))
        .route("/api/wealth/notes/archive", post(wealth::archive_note))
        .route("/api/wealth/services", get(wealth::services))
        .route("/api/wealth/alerts", get(wealth::alerts))
        .route("/api/wealth/alerts/test", get(wealth::alerts_test))
        .route("/api/wealth/alerts/digest", get(wealth::alerts_digest))
        .route("/api/wealth/alerts/config", post(wealth::alerts_config))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login", post(auth::login))
        // Outside the JWT gate on purpose, and not unauthenticated: a browser cannot put an
        // `Authorization` header on a WebSocket upgrade, so the credential is the one-shot ticket
        // in the query string, minted by the authenticated POST above. See [`agents::Tickets`].
        .route("/api/agents/stream", get(agents::stream))
        .route("/api/search", get(search::search))
        // Google redirects a browser here with no Authorization header; CSRF is covered by the
        // one-time `state` token instead.
        .route("/api/gcal/auth/callback", get(gcal::auth_callback))
        // Public-calendar proxies via the embed key.
        .route("/api/gcal/{calendarId}/events", get(gcal::public_events))
        .route("/api/gcal/{calendarId}/color", get(gcal::public_color))
        .route("/api/gcal/{calendarId}/ical", get(gcal::public_ical))
        .merge(protected)
        .layer(cors)
        .with_state(state);

    // Serve the built front end from the same process, when it is there.
    //
    // Optional on purpose. In development the UI is Vite's dev server on another port and this is
    // unset; for a self-hosted box `LYRA_UI_DIR=dist` makes one binary the whole application —
    // no node at runtime, no second service to keep alive, and, because the app is then served
    // from the API's own origin, no CORS configuration to get wrong.
    //
    // Unknown paths fall back to `index.html` rather than 404ing: the router is client-side, so
    // a reload on `/wealth/holdings` asks the server for a file that was never meant to exist.
    //
    // Everything under `/api/` is carved out first. A fallback catches every unmatched path,
    // `/api/typo` included, and answering that with a 200 and a page of HTML turns a mistyped
    // request into "the JSON parser failed" three layers away from the cause.
    let Ok(ui) = std::env::var("LYRA_UI_DIR") else {
        return router;
    };
    let index = std::path::Path::new(&ui).join("index.html");
    if !index.is_file() {
        tracing::warn!(dir = %ui, "LYRA_UI_DIR has no index.html; serving the API only");
        return router;
    }
    tracing::info!(dir = %ui, "serving the front end");
    router
        .route(
            "/api/{*rest}",
            any(|| async { error(StatusCode::NOT_FOUND, "not found") }),
        )
        .fallback_service(ServeDir::new(&ui).fallback(ServeFile::new(index)))
}

async fn health(State(state): State<AppState>) -> Response {
    // Touch the database so the check fails when storage is unreachable, rather than reporting
    // "ok" from a process that cannot serve a single request.
    match sqlx::query_scalar::<_, i64>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(_) => Json(json!({ "status": "ok" })).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "health check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "status": "error" })),
            )
                .into_response()
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    // Same fatal-on-missing behaviour as auth.ts:8 — refusing to boot beats signing tokens with
    // a default secret.
    let Ok(jwt_secret) = std::env::var("JWT_SECRET") else {
        eprintln!("FATAL: JWT_SECRET environment variable is required");
        std::process::exit(1);
    };
    if jwt_secret.trim().is_empty() {
        eprintln!("FATAL: JWT_SECRET must not be empty");
        std::process::exit(1);
    }

    let database = std::env::var("LYRA_DB").unwrap_or_else(|_| "data/lyra.db".into());
    let pool = lyra_db::open_and_migrate(&PathBuf::from(&database))
        .await
        .with_context(|| format!("opening {database}"))?;

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3001);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .with_context(|| format!("binding port {port}"))?;

    tracing::info!(port, database, "Lyra API listening");

    let state = AppState::new(pool.clone(), jwt_secret);

    // The always-on sweep — range alerts, the daily brief, and the net-worth series — started
    // here and not in `app()` so that the router the tests build stays inert. It no-ops when
    // nothing is configured for it to do.
    alert_loop::spawn(state.clone());

    // The other half of Telegram: `alert_loop` pushes, this pulls commands in. Idle unless a bot
    // token and chat id are both configured.
    tgbot::spawn(state.clone());

    // The job workers and the lease reaper. Nothing enqueues yet, so today they idle — but the
    // reaper is the only recovery from a worker killed mid-job, and a queue whose recovery path
    // starts the same week as its first real work is a queue nobody has ever seen recover.
    jobs::spawn(state.clone());

    axum::serve(listener, app(state, allowed_origins()))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serving")?;

    pool.close().await;
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("shutting down");
}

#[cfg(test)]
mod tests {
    /// The SPA fallback must not swallow `/api/`.
    ///
    /// A fallback catches every unmatched path, `/api/typo` included, and answering that with a
    /// page of HTML turns a mistyped request into "the JSON parser failed" three layers from the
    /// cause. This is the carve-out that keeps an API 404 an API 404.
    #[test]
    fn the_api_prefix_is_carved_out_of_the_static_fallback() {
        let source = include_str!("main.rs");
        let tail = source
            .split("let Ok(ui) = std::env::var(\"LYRA_UI_DIR\")")
            .nth(1)
            .expect("the static-fallback block should exist");
        let api_guard = tail
            .find("\"/api/{*rest}\"")
            .expect("the /api guard should exist");
        let fallback = tail
            .find("fallback_service")
            .expect("the fallback should exist");
        assert!(
            api_guard < fallback,
            "the /api catch-all must be registered before the static fallback"
        );
    }
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tempfile::TempDir;
    use tower::ServiceExt;

    async fn test_app(pins: &[(&str, &str)]) -> (TempDir, SqlitePool, Router) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        for (id, pin) in pins {
            sqlx::query("INSERT INTO users (id, name, role, pin) VALUES (?, ?, ?, ?)")
                .bind(id)
                .bind("Test User")
                .bind("admin")
                .bind(pin)
                .execute(&pool)
                .await
                .unwrap();
        }
        let state = AppState::new(pool.clone(), "test-secret".into());
        let router = app(state, vec!["http://localhost:5173".into()]);
        (dir, pool, router)
    }

    async fn login(router: Router, pin: &str) -> (StatusCode, serde_json::Value) {
        post_login(router, &json!({ "pin": pin }).to_string()).await
    }

    async fn post_login(router: Router, body: &str) -> (StatusCode, serde_json::Value) {
        let response = router
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (status, value)
    }

    #[tokio::test]
    async fn health_reports_ok() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            json!({"status": "ok"})
        );
    }

    #[tokio::test]
    async fn login_with_a_bcrypt_pin_returns_a_token_and_user() {
        let hashed = bcrypt::hash("1234", 4).unwrap();
        let (_dir, _pool, router) = test_app(&[("user-jb", &hashed)]).await;

        let (status, body) = login(router, "1234").await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["token"].is_string());
        assert_eq!(body["user"]["id"], "user-jb");
        assert_eq!(body["user"]["role"], "admin");
        // The client reads user.avatarUrl; the key must exist even when null.
        assert!(body["user"].get("avatarUrl").is_some());
    }

    #[tokio::test]
    async fn login_with_a_plaintext_pin_succeeds_and_upgrades_the_row() {
        // Exactly the state of the live life-os.db.
        let (_dir, pool, router) = test_app(&[("user-jb", "1234")]).await;

        let (status, body) = login(router, "1234").await;
        assert_eq!(status, StatusCode::OK, "plaintext login must work: {body}");

        let stored: String = sqlx::query_scalar("SELECT pin FROM users WHERE id = 'user-jb'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(
            stored.starts_with("$2"),
            "PIN should now be hashed, got {stored:?}"
        );
        assert!(
            bcrypt::verify("1234", &stored).unwrap(),
            "the hash must verify the same PIN"
        );
    }

    #[tokio::test]
    async fn an_upgraded_pin_still_logs_in_afterwards() {
        let (dir, pool, router) = test_app(&[("user-jb", "1234")]).await;
        assert_eq!(login(router, "1234").await.0, StatusCode::OK);

        // Second login goes down the bcrypt path against the freshly written hash.
        let state = AppState::new(pool.clone(), "test-secret".into());
        let router = app(state, vec![]);
        assert_eq!(login(router, "1234").await.0, StatusCode::OK);
        drop(dir);
    }

    #[tokio::test]
    async fn a_wrong_pin_is_rejected() {
        let (_dir, _pool, router) = test_app(&[("user-jb", "1234")]).await;
        let (status, body) = login(router, "9999").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid PIN");
    }

    #[tokio::test]
    async fn a_missing_pin_is_a_400() {
        let (_dir, _pool, router) = test_app(&[("user-jb", "1234")]).await;
        let (status, body) = post_login(router, "{}").await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "PIN is required");
    }

    #[tokio::test]
    async fn the_sixth_attempt_is_rate_limited() {
        let (_dir, _pool, router) = test_app(&[("user-jb", "1234")]).await;
        for _ in 0..5 {
            let (status, _) = login(router.clone(), "9999").await;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
        }
        let (status, body) = login(router, "9999").await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(body["error"], "Too many login attempts. Try again later.");
    }

    #[tokio::test]
    async fn the_issued_token_verifies_against_the_configured_secret() {
        let (_dir, _pool, router) = test_app(&[("user-jb", "1234")]).await;
        let (_, body) = login(router, "1234").await;
        let token = body["token"].as_str().unwrap();
        let claims = auth::decode_token("test-secret", token).unwrap();
        assert_eq!(claims.user_id, "user-jb");
    }

    /* ─── entities ─── */

    async fn seed_entity(pool: &SqlitePool, id: &str, owner: &str, visibility: &str) {
        sqlx::query(
            "INSERT INTO entities (id, type, title, status, priority, tags, metadata, ownerId, visibility, createdAt, updatedAt) \
             VALUES (?, 'task', ?, 'todo', 'medium', '[\"a\"]', '{\"k\":1}', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
        )
        .bind(id)
        .bind(format!("Title {id}"))
        .bind(owner)
        .bind(visibility)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn authed(
        router: Router,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(b) => builder
                .header("content-type", "application/json")
                .body(Body::from(b.to_string()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = router.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        )
    }

    fn token_for(user: &str) -> String {
        auth::issue_token("test-secret", user, "admin").unwrap()
    }

    #[test]
    fn the_install_script_forwards_every_setting_the_server_reads() {
        // The installed service gets its environment from the allowlist in ops/service-env.list,
        // and that list fell behind the code: DISCORD_WEBHOOK_URL, TELEGRAM_OWNER_USER_ID and the
        // Google OAuth keys all worked under `cargo run` and were silently absent in production.
        // A comment asking people to remember is not a mechanism. This is.
        //
        // It reads the list rather than the installer that consumes it: there are two installers
        // now (launchd and systemd), and a test that parses one script's `for` loop both misses
        // the other and breaks when someone reformats a line of shell.
        let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
        let list = std::fs::read_to_string(format!("{root}/../ops/service-env.list"))
            .expect("ops/service-env.list is the allowlist; it must exist");
        let forwarded: std::collections::BTreeSet<&str> = list
            .lines()
            .map(|line| line.split('#').next().unwrap_or("").trim())
            .filter(|line| !line.is_empty())
            .collect();

        // Read by the server, deliberately not forwarded, and why.
        let excluded = [
            "PORT",               // set by the plist from the install layout
            "LYRA_DB",            // likewise
            "LYRA_UI_DIR",        // likewise
            "LYRA_HTTP_CACHE",    // test fixtures: must never reach production
            "LYRA_HTTP_FIXTURES", // likewise
        ];

        let read = regex::Regex::new(
            r#"(?:env::var|env_or_empty|\.get)\("([A-Z][A-Z0-9]*_[A-Z0-9_]+)"\)"#,
        )
        .unwrap();
        let mut missing = std::collections::BTreeSet::new();
        for krate in [
            "lyra-api",
            "lyra-alerts",
            "lyra-chain",
            "lyra-db",
            "lyra-analytics",
        ] {
            let mut dirs = vec![std::path::PathBuf::from(format!(
                "{root}/crates/{krate}/src"
            ))];
            while let Some(dir) = dirs.pop() {
                for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        dirs.push(path);
                    } else if path.extension().is_some_and(|e| e == "rs") {
                        let source = std::fs::read_to_string(&path).unwrap();
                        for caps in read.captures_iter(&source) {
                            let key = caps.get(1).unwrap().as_str();
                            if !forwarded.contains(key) && !excluded.contains(&key) {
                                missing.insert(format!("{key} ({})", path.display()));
                            }
                        }
                    }
                }
            }
        }
        assert!(
            missing.is_empty(),
            "read by the server but not in ops/service-env.list — add them to that file, \
             or to `excluded` here with a reason:\n  {}",
            missing.into_iter().collect::<Vec<_>>().join("\n  ")
        );
    }

    /// Every relative link in every Markdown file points at something that exists.
    ///
    /// This sits in a Rust test for the same reason the allowlist guard above does: it is the only
    /// place in the repo that runs on every commit and can read the whole tree. (`vitest` only
    /// globs `src/**`, so it cannot see `docs/`.)
    ///
    /// Why bother: five documents were deleted in one go, and the thing that makes that safe is
    /// knowing immediately which sentences elsewhere just became lies. It also caught
    /// `core/Dockerfile` pointing at `docs/deployment-rust.md`, a file that never existed at all —
    /// a reader following that link concludes the docs are untrustworthy, and they are right.
    #[test]
    fn every_link_in_the_docs_goes_somewhere() {
        let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../../.."))
            .canonicalize()
            .unwrap();
        // `[text](target)`, minus any `#anchor`. Anchors are not checked: a heading can be renamed
        // without the link being wrong in the way that matters, and checking them would make this
        // fail for reasons nobody would act on.
        let link = regex::Regex::new(r"\[[^\]]*\]\(([^)#]+?)(?:#[^)]*)?\)").unwrap();

        let mut broken: Vec<String> = Vec::new();
        let mut dirs = vec![root.clone()];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if path.is_dir() {
                    // `dev-knowledge` is fixture content for the knowledge module, not
                    // documentation, and its links are part of the fixture.
                    if !matches!(
                        name.as_str(),
                        "node_modules" | ".git" | "target" | "dist" | ".venv" | "dev-knowledge"
                    ) {
                        dirs.push(path);
                    }
                    continue;
                }
                if path.extension().is_some_and(|e| e == "md") {
                    let source = std::fs::read_to_string(&path).unwrap_or_default();
                    for caps in link.captures_iter(&source) {
                        let target = caps.get(1).unwrap().as_str().trim();
                        if target.starts_with("http://")
                            || target.starts_with("https://")
                            || target.starts_with("mailto:")
                        {
                            continue;
                        }
                        if !dir.join(target).exists() {
                            broken.push(format!(
                                "{} -> {target}",
                                path.strip_prefix(&root).unwrap_or(&path).display()
                            ));
                        }
                    }
                }
            }
        }
        broken.sort();
        assert!(
            broken.is_empty(),
            "Markdown links pointing at nothing — fix the link or restore the target:\n  {}",
            broken.join("\n  ")
        );
    }

    #[tokio::test]
    async fn job_controls_sit_behind_the_token() {
        // They change what the box does next. Anyone who can reach the port must not be able to
        // cancel your brief or re-fire an alert.
        let (_dir, _pool, router) = test_app(&[]).await;
        for (method, uri) in [
            ("GET", "/api/jobs/x"),
            ("POST", "/api/jobs/x/retry"),
            ("POST", "/api/jobs/x/cancel"),
        ] {
            let (status, _) = authed(router.clone(), method, uri, None, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn a_failed_job_can_be_retried_through_the_api_and_the_old_row_survives() {
        use lyra_db::jobs::{Failure, Lane, NewJob, Queue, SqliteQueue};
        let (_dir, pool, router) = test_app(&[]).await;
        let token = token_for("user-jb");

        let queue = SqliteQueue::new(pool);
        let dead = queue
            .enqueue(
                &NewJob::new("deliver.telegram", Lane::Deliver).max_attempts(1),
                1000,
            )
            .await
            .unwrap();
        let claimed = queue
            .claim("w", &[Lane::Deliver], 60, 1100)
            .await
            .unwrap()
            .unwrap();
        queue
            .fail("w", &claimed.id, "connection reset", Failure::Retry, 1200)
            .await
            .unwrap();

        let (status, body) = authed(
            router.clone(),
            "POST",
            &format!("/api/jobs/{}/retry", dead.id),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["created"], true);
        let new_id = body["id"].as_str().unwrap().to_string();
        assert_ne!(new_id, dead.id);

        // The new one points back at what it replaces.
        let (_, fresh) = authed(
            router.clone(),
            "GET",
            &format!("/api/jobs/{new_id}"),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(fresh["status"], "queued");
        assert_eq!(fresh["parent_id"], dead.id.as_str());

        // And the dead one still says why it died.
        let (_, old) = authed(
            router,
            "GET",
            &format!("/api/jobs/{}", dead.id),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(old["status"], "failed");
        assert_eq!(old["last_error"], "connection reset");
    }

    #[tokio::test]
    async fn the_wrong_state_is_a_conflict_that_says_which_state() {
        use lyra_db::jobs::{Lane, NewJob, Queue, SqliteQueue};
        let (_dir, pool, router) = test_app(&[]).await;
        let token = token_for("user-jb");
        let queued = SqliteQueue::new(pool)
            .enqueue(&NewJob::new("x", Lane::Batch), 1000)
            .await
            .unwrap();

        // Retrying a job that has not run yet would run it twice.
        let (status, body) = authed(
            router.clone(),
            "POST",
            &format!("/api/jobs/{}/retry", queued.id),
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body["error"].as_str().unwrap().contains("queued"), "{body}");

        // Cancelling it works, once.
        let cancel = format!("/api/jobs/{}/cancel", queued.id);
        let (first, _) = authed(router.clone(), "POST", &cancel, Some(&token), None).await;
        let (second, body) = authed(router.clone(), "POST", &cancel, Some(&token), None).await;
        assert_eq!(first, StatusCode::OK);
        assert_eq!(second, StatusCode::CONFLICT, "{body}");
        assert!(body["error"].as_str().unwrap().contains("cancelled"));

        let (missing, _) = authed(router, "POST", "/api/jobs/nope/retry", Some(&token), None).await;
        assert_eq!(missing, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn entities_require_a_token() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, body) = authed(router.clone(), "GET", "/api/entities", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Unauthorized");

        let (status, body) = authed(router, "GET", "/api/entities", Some("garbage"), None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Invalid or expired token");
    }

    #[tokio::test]
    async fn list_returns_owned_and_shared_but_not_other_peoples_private() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "mine", "user-jb", "private").await;
        seed_entity(&pool, "theirs-shared", "user-sunny", "shared").await;
        seed_entity(&pool, "theirs-private", "user-sunny", "private").await;

        let (status, body) = authed(
            router,
            "GET",
            "/api/entities",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let ids: Vec<&str> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect();
        assert!(ids.contains(&"mine"));
        assert!(ids.contains(&"theirs-shared"));
        assert!(
            !ids.contains(&"theirs-private"),
            "leaked a private row: {ids:?}"
        );
    }

    #[tokio::test]
    async fn list_json_columns_come_back_parsed_not_as_strings() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "mine", "user-jb", "private").await;

        let (_, body) = authed(
            router,
            "GET",
            "/api/entities",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        let entity = &body.as_array().unwrap()[0];
        assert_eq!(
            entity["tags"],
            json!(["a"]),
            "tags must be an array, not a string"
        );
        assert_eq!(entity["metadata"], json!({"k": 1}));
    }

    #[tokio::test]
    async fn list_filters_by_type_and_status() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "a", "user-jb", "private").await;
        sqlx::query("UPDATE entities SET type = 'goal' WHERE id = 'a'")
            .execute(&pool)
            .await
            .unwrap();
        seed_entity(&pool, "b", "user-jb", "private").await;

        let token = token_for("user-jb");
        let (_, body) = authed(
            router.clone(),
            "GET",
            "/api/entities?type=goal",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(body.as_array().unwrap().len(), 1);
        let (_, body) = authed(
            router,
            "GET",
            "/api/entities?status=done",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn fetching_someone_elses_private_entity_is_404_not_403() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "theirs", "user-sunny", "private").await;

        let (status, body) = authed(
            router,
            "GET",
            "/api/entities/theirs",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Entity not found");
    }

    #[tokio::test]
    async fn create_applies_defaults_and_the_caller_as_owner() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let payload = json!({"id": "new-1", "type": "task", "title": "Write it down"}).to_string();

        let (status, body) = authed(
            router,
            "POST",
            "/api/entities",
            Some(&token_for("user-jb")),
            Some(&payload),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["status"], "todo");
        assert_eq!(body["priority"], "medium");
        assert_eq!(body["visibility"], "private");
        assert_eq!(body["tags"], json!([]));
        assert_eq!(body["metadata"], json!({}));
        assert_eq!(body["ownerId"], "user-jb");
        assert!(body["createdAt"].as_str().unwrap().ends_with('Z'));
    }

    #[tokio::test]
    async fn create_rejects_a_bad_payload_with_field_details() {
        let (_dir, _pool, router) = test_app(&[]).await;
        // Missing title, and an invalid status.
        let payload = json!({"id": "x", "type": "task", "status": "nonsense"}).to_string();

        let (status, body) = authed(
            router,
            "POST",
            "/api/entities",
            Some(&token_for("user-jb")),
            Some(&payload),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Validation failed");
        assert!(body["details"]["title"].is_array(), "{body}");
        assert!(body["details"]["status"].is_array(), "{body}");
    }

    #[tokio::test]
    async fn patch_updates_only_the_supplied_fields_and_bumps_updated_at() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "mine", "user-jb", "private").await;

        let (status, body) = authed(
            router,
            "PATCH",
            "/api/entities/mine",
            Some(&token_for("user-jb")),
            Some(&json!({"status": "done"}).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "done");
        assert_eq!(body["title"], "Title mine", "untouched fields must survive");
        assert_ne!(
            body["updatedAt"], "2026-01-01T00:00:00.000Z",
            "updatedAt should advance"
        );
        assert_eq!(
            body["createdAt"], "2026-01-01T00:00:00.000Z",
            "createdAt must not move"
        );
    }

    #[tokio::test]
    async fn patch_and_delete_need_ownership_even_when_shared() {
        // A shared row is readable by everyone but writable only by its owner.
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "theirs", "user-sunny", "shared").await;
        let token = token_for("user-jb");

        let (status, _) = authed(
            router.clone(),
            "GET",
            "/api/entities/theirs",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "shared rows stay readable");

        let (status, _) = authed(
            router.clone(),
            "PATCH",
            "/api/entities/theirs",
            Some(&token),
            Some(&json!({"status": "done"}).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let (status, _) =
            authed(router, "DELETE", "/api/entities/theirs", Some(&token), None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn delete_removes_an_owned_entity() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "mine", "user-jb", "private").await;

        let (status, body) = authed(
            router,
            "DELETE",
            "/api/entities/mine",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": true}));

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM entities")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }

    /* ─── trackers, schedules, relations ─── */

    #[tokio::test]
    async fn trackers_are_owner_only_even_for_a_shared_entity() {
        // Unlike entities, `shared` grants nothing on trackers.
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "shared-goal", "user-sunny", "shared").await;
        sqlx::query("INSERT INTO trackers (id, entityId, value, timestamp, ownerId) VALUES ('t1','shared-goal', 42.0, '2026-01-01T00:00:00.000Z','user-sunny')")
            .execute(&pool).await.unwrap();

        let (status, body) = authed(
            router.clone(),
            "GET",
            "/api/trackers",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body.as_array().unwrap().len(),
            0,
            "another user's tracker must not list"
        );

        let (status, body) = authed(
            router,
            "GET",
            "/api/trackers/t1",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Tracker not found");
    }

    #[tokio::test]
    async fn tracker_create_requires_a_numeric_value() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let token = token_for("user-jb");

        // A numeric *string* is not a number under z.number().
        let bad = json!({"id": "t1", "entityId": "e1", "value": "42"}).to_string();
        let (status, body) = authed(
            router.clone(),
            "POST",
            "/api/trackers",
            Some(&token),
            Some(&bad),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["details"]["value"].is_array(), "{body}");

        let good = json!({"id": "t1", "entityId": "e1", "value": 42.5}).to_string();
        let (status, body) =
            authed(router, "POST", "/api/trackers", Some(&token), Some(&good)).await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["value"], 42.5);
        assert_eq!(body["ownerId"], "user-jb");
    }

    #[tokio::test]
    async fn tracker_list_filters_by_timestamp_range() {
        let (_dir, pool, router) = test_app(&[]).await;
        for (id, ts) in [
            ("t1", "2026-01-01"),
            ("t2", "2026-06-01"),
            ("t3", "2026-12-01"),
        ] {
            sqlx::query("INSERT INTO trackers (id, entityId, value, timestamp, ownerId) VALUES (?, 'e1', 1.0, ?, 'user-jb')")
                .bind(id).bind(ts).execute(&pool).await.unwrap();
        }
        let (_, body) = authed(
            router,
            "GET",
            "/api/trackers?start=2026-03-01&end=2026-09-01",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        let ids: Vec<&str> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["t2"]);
    }

    #[tokio::test]
    async fn schedule_is_active_is_a_boolean_not_an_integer() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "e1", "user-jb", "private").await;
        sqlx::query("INSERT INTO schedules (id, entityId, isActive) VALUES ('s1','e1',1)")
            .execute(&pool)
            .await
            .unwrap();

        let (status, body) = authed(
            router,
            "GET",
            "/api/schedules/s1",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["isActive"],
            json!(true),
            "must serialise as a JSON boolean"
        );
    }

    #[tokio::test]
    async fn creating_a_schedule_for_an_invisible_entity_says_entity_not_found() {
        // This route returns a *different* message here than for its own missing rows.
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "theirs", "user-sunny", "private").await;

        let payload = json!({"id": "s1", "entityId": "theirs"}).to_string();
        let (status, body) = authed(
            router.clone(),
            "POST",
            "/api/schedules",
            Some(&token_for("user-jb")),
            Some(&payload),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Entity not found");

        let (_, body) = authed(
            router,
            "GET",
            "/api/schedules/nope",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(body["error"], "Schedule not found");
    }

    #[tokio::test]
    async fn schedule_defaults_to_active_when_is_active_is_omitted() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "e1", "user-jb", "private").await;

        let payload = json!({"id": "s1", "entityId": "e1"}).to_string();
        let (status, body) = authed(
            router,
            "POST",
            "/api/schedules",
            Some(&token_for("user-jb")),
            Some(&payload),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        assert_eq!(body["isActive"], json!(true));
    }

    #[tokio::test]
    async fn a_relation_is_visible_when_either_endpoint_is() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "mine", "user-jb", "private").await;
        seed_entity(&pool, "theirs", "user-sunny", "private").await;
        // One endpoint mine, one not — visible. Both theirs — not.
        sqlx::query(
            "INSERT INTO relations (id, fromId, toId, type) VALUES ('r1','theirs','mine','blocks')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO relations (id, fromId, toId, type) VALUES ('r2','theirs','theirs','blocks')")
            .execute(&pool).await.unwrap();

        let (_, body) = authed(
            router,
            "GET",
            "/api/relations",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        let ids: Vec<&str> = body
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["r1"]);
    }

    #[tokio::test]
    async fn creating_a_relation_between_two_invisible_entities_is_404() {
        let (_dir, pool, router) = test_app(&[]).await;
        seed_entity(&pool, "theirs", "user-sunny", "private").await;

        let payload =
            json!({"id": "r1", "fromId": "theirs", "toId": "theirs", "type": "blocks"}).to_string();
        let (status, body) = authed(
            router,
            "POST",
            "/api/relations",
            Some(&token_for("user-jb")),
            Some(&payload),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"], "Relation not found");
    }

    #[tokio::test]
    async fn search_is_reachable_without_a_token() {
        // Matches index.ts, which mounts searchRoutes outside the JWT gate. A missing `q` is a
        // 400 — proving the handler ran rather than being rejected by auth.
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, body) = authed(router, "GET", "/api/search", None, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Missing query parameter \"q\"");
    }

    #[tokio::test]
    async fn knowledge_requires_a_token() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, _) = authed(router, "GET", "/api/knowledge", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /* ─── gcal: the three-way auth split ─── */

    #[tokio::test]
    async fn gcal_auth_status_requires_a_token() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, _) = authed(router, "GET", "/api/gcal/auth/status", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn gcal_status_reports_disconnected_on_a_fresh_database() {
        // The live life-os.db has no google_tokens table at all; the Rust schema creates it, so
        // this must answer cleanly rather than erroring on a missing table.
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, body) = authed(
            router,
            "GET",
            "/api/gcal/auth/status",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"connected": false, "calendarId": null}));
    }

    #[tokio::test]
    async fn gcal_status_needs_a_refresh_token_to_count_as_connected() {
        let (_dir, pool, router) = test_app(&[]).await;
        // An access token without a refresh token cannot be renewed — not "connected".
        sqlx::query("INSERT INTO google_tokens (userId, accessToken, calendarId) VALUES ('user-jb','at','cal-1')")
            .execute(&pool).await.unwrap();
        let (_, body) = authed(
            router,
            "GET",
            "/api/gcal/auth/status",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(body["connected"], json!(false));
        assert_eq!(
            body["calendarId"], "cal-1",
            "the calendar id is still reported"
        );
    }

    #[tokio::test]
    async fn gcal_disconnect_removes_the_stored_tokens() {
        let (_dir, pool, router) = test_app(&[]).await;
        sqlx::query("INSERT INTO google_tokens (userId, accessToken, refreshToken) VALUES ('user-jb','at','rt')")
            .execute(&pool).await.unwrap();

        let (status, body) = authed(
            router,
            "DELETE",
            "/api/gcal/auth/disconnect",
            Some(&token_for("user-jb")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"ok": true}));

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM google_tokens")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn creating_an_event_without_a_connection_is_401() {
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, body) = authed(
            router,
            "POST",
            "/api/gcal/events",
            Some(&token_for("user-jb")),
            Some(&json!({"summary": "Test"}).to_string()),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["error"], "Google Calendar not connected");
    }

    #[tokio::test]
    async fn the_oauth_callback_is_reachable_without_a_token_and_redirects_on_a_bad_state() {
        // Google redirects a browser here with no Authorization header. An unknown state must
        // redirect to the error page rather than 401 — proving it is mounted outside the gate.
        let (_dir, _pool, router) = test_app(&[]).await;
        let response = router
            .oneshot(
                Request::builder()
                    .uri("/api/gcal/auth/callback?code=abc&state=forged")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(
            response.status(),
            StatusCode::FOUND,
            "Hono redirects with 302"
        );
        let location = response.headers()["location"].to_str().unwrap();
        assert!(location.ends_with("/calendar?google=error"), "{location}");
    }

    #[tokio::test]
    async fn a_used_state_token_cannot_be_replayed_through_the_callback() {
        let (_dir, _pool, router) = test_app(&[]).await;
        // Mint a state directly, then spend it twice: the second attempt must fail closed.
        let state = AppState::new(
            lyra_db::open_and_migrate(&TempDir::new().unwrap().path().join("x.db"))
                .await
                .unwrap(),
            "test-secret".into(),
        );
        let token = state.gcal_states.create("user-jb");
        assert_eq!(
            state.gcal_states.validate(&token).as_deref(),
            Some("user-jb")
        );
        assert_eq!(state.gcal_states.validate(&token), None);

        // And a state this server never issued is likewise rejected.
        let response = router
            .oneshot(
                Request::builder()
                    .uri(format!("/api/gcal/auth/callback?code=abc&state={token}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert!(
            response.headers()["location"]
                .to_str()
                .unwrap()
                .ends_with("google=error"),
            "a foreign state must not authenticate"
        );
    }

    #[tokio::test]
    async fn static_gcal_routes_win_over_the_calendar_id_wildcard() {
        // `/api/gcal/auth/status` and `/api/gcal/{calendarId}/color` are both two segments deep.
        // If the wildcard shadowed the static route, this would be a public 502 instead of a 401.
        let (_dir, _pool, router) = test_app(&[]).await;
        let (status, _) = authed(router, "GET", "/api/gcal/auth/status", None, None).await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "auth/status must not match the wildcard"
        );
    }
}
