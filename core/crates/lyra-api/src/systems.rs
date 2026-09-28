//! Lyra as chief of staff: talking to the other systems, and collecting what they need decided.
//!
//! # The client lives here, not in `lyra-mcp`
//!
//! `lyra-mcp`'s guarantee is that **no tool body can cause an effect** — there is no signing path
//! to reach, and two tests hold the capability ladder shut. A client that can call another
//! system's *tools* is an effect path by definition, so putting one in that crate would quietly
//! turn the read-only desk into a lever on the whole house while every existing test still passed.
//! It belongs in the binary that already has write paths, a queue and an audit trail. **Do not move
//! it.**
//!
//! # One trait, two speakers
//!
//! The contract that matters is what a system exposes — health, what is new, and taking an answer —
//! not the protocol it speaks. [`Adapter`] is that contract. [`HttpAdapter`] speaks the versioned
//! REST door; [`FixtureAdapter`] reads a file, so the whole loop can be exercised before
//! content-factory's API exists. An MCP adapter is a third implementation behind the same trait,
//! worth building when a second real system makes discovery pay for itself rather than now.
//!
//! # Lyra is a courier
//!
//! The origin system owns the decision and acts on the answer. Lyra carries the question to a phone
//! and the answer back, and the one thing it must not do is lose either. That is why the answer is
//! committed to `decisions` before any delivery is attempted — see `lyra_db::systems`.

use std::path::Path;
use std::time::Duration;

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lyra_db::systems::{
    Decision, DecisionStore, Option_, Raised, System, SystemInput, SystemPatch, SystemStore,
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::{error, not_found};
use crate::jobs::BoxFuture;

/// A system that does not answer in this long is treated as down for this tick.
///
/// Short on purpose. The poll runs inside the 30-second sweep, so N systems stalling costs 5N
/// seconds off the *next* sweep — fine at the two or three systems this is built for, and the thing
/// to revisit first if that number grows.
const TIMEOUT: Duration = Duration::from_secs(5);

/// The scopes Lyra operates under. One coarse pair while it is a courier.
///
/// Stored as a list from the start so tightening later is data rather than a migration. `act` is
/// deliberately **not** here: nothing in this file can do anything to another system except deliver
/// an answer you gave.
pub const SCOPES: [&str; 2] = ["read", "propose"];

/// What a poll found.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Polled {
    pub raised: Vec<Raised>,
    /// Where to resume. `None` leaves the stored cursor alone rather than rewinding it.
    pub cursor: Option<String>,
}

/// What Lyra needs from any system, whatever it speaks.
///
/// Errors are `String` rather than `anyhow::Error` because every one of them is shown to a person
/// on the systems screen: "connection refused" is the answer, and a wrapped chain is not.
pub trait Adapter: Send + Sync {
    fn health<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>>;

    fn poll<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Polled, String>>;

    fn deliver<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
        decision: &'a Decision,
        answer: &'a str,
    ) -> BoxFuture<'a, Result<(), String>>;
}

/// Pick the speaker for a system from its address.
///
/// A `fixture:` URL is a visible, first-class choice in the registry rather than a hidden
/// environment variable: you can see on the screen that this system is a stub, which matters when
/// the whole point of the stub is that it looks real.
pub fn adapter_for(base_url: &str) -> Box<dyn Adapter> {
    match base_url.strip_prefix("fixture:") {
        Some(path) => Box::new(FixtureAdapter {
            path: path.trim_start_matches("//").to_string(),
        }),
        None => Box::new(HttpAdapter),
    }
}

/* ─── the real one ─── */

pub struct HttpAdapter;

impl HttpAdapter {
    fn client() -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            // Refused for the same reason a Discord webhook refuses them: a bearer token travels on
            // this request, and a redirect decides after the fact which host receives it. The
            // address was checked when it was written down; a 302 is not that address.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| format!("building a client: {e}"))
    }

    fn authed(request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
        match token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }
}

/// The wire shape of `GET {base}/decisions?since=…`, which is the contract a system implements.
#[derive(Debug, Deserialize)]
struct DecisionsBody {
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    decisions: Vec<RaisedBody>,
}

/// One decision on the wire. Also the shape of a fixture file's entries — the same struct for both,
/// which is what makes the stub a rehearsal rather than a different program.
#[derive(Debug, Deserialize)]
struct RaisedBody {
    id: String,
    question: String,
    #[serde(default)]
    detail: Option<String>,
    #[serde(default)]
    options: Vec<Option_>,
    #[serde(default)]
    evidence: Option<String>,
    #[serde(default)]
    raised_at: Option<i64>,
    #[serde(default)]
    expires_at: Option<i64>,
}

impl RaisedBody {
    fn into_raised(self, system_id: &str, now: i64) -> Raised {
        Raised {
            system_id: system_id.to_string(),
            external_id: self.id,
            question: self.question,
            detail: self.detail,
            options: self.options,
            evidence: self.evidence,
            // A system that does not say when it asked is treated as asking now. Better than
            // dropping the row, and the only cost is an inbox ordered by when Lyra heard.
            raised_at: self.raised_at.unwrap_or(now),
            expires_at: self.expires_at,
        }
    }
}

fn read_decisions(body: &str, system_id: &str, now: i64) -> Result<Polled, String> {
    let parsed: DecisionsBody =
        serde_json::from_str(body).map_err(|e| format!("unreadable decisions: {e}"))?;
    Ok(Polled {
        raised: parsed
            .decisions
            .into_iter()
            .map(|one| one.into_raised(system_id, now))
            .collect(),
        cursor: parsed.cursor,
    })
}

impl Adapter for HttpAdapter {
    fn health<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let response = Self::authed(
                Self::client()?.get(format!("{}/healthz", sys.base_url)),
                token,
            )
            .send()
            .await
            .map_err(|e| trim(&e.to_string()))?;
            match response.status().is_success() {
                true => Ok(()),
                false => Err(format!("{} from /healthz", response.status())),
            }
        })
    }

    fn poll<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Polled, String>> {
        Box::pin(async move {
            let mut url = format!("{}/decisions", sys.base_url);
            if let Some(cursor) = &sys.cursor {
                url.push_str(&format!("?since={}", urlencode(cursor)));
            }
            let response = Self::authed(Self::client()?.get(url), token)
                .send()
                .await
                .map_err(|e| trim(&e.to_string()))?;
            if !response.status().is_success() {
                return Err(format!("{} from /decisions", response.status()));
            }
            let body = response.text().await.map_err(|e| trim(&e.to_string()))?;
            read_decisions(&body, &sys.id, lyra_db::jobs::now_secs())
        })
    }

    fn deliver<'a>(
        &'a self,
        sys: &'a System,
        token: Option<&'a str>,
        decision: &'a Decision,
        answer: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let url = format!(
                "{}/decisions/{}/answer",
                sys.base_url,
                urlencode(&decision.external_id)
            );
            let response = Self::authed(Self::client()?.post(url), token)
                // `decided_at` is the moment *you* tapped, not the moment this request went out,
                // so a delivery that took three retries still records when the call was made.
                .json(&json!({ "answer": answer, "decided_at": decision.answered_at }))
                .send()
                .await
                .map_err(|e| trim(&e.to_string()))?;
            match response.status().is_success() {
                true => Ok(()),
                false => Err(format!("{} delivering the answer", response.status())),
            }
        })
    }
}

/* ─── the stub ─── */

/// A system that lives in a JSON file, for building against a door that does not exist yet.
///
/// It reads the **same struct** the HTTP adapter parses, so a fixture that works is evidence the
/// wire shape is right — see `the_fixture_and_the_wire_are_one_shape`.
pub struct FixtureAdapter {
    path: String,
}

impl Adapter for FixtureAdapter {
    fn health<'a>(
        &'a self,
        _sys: &'a System,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            match Path::new(&self.path).exists() {
                true => Ok(()),
                false => Err(format!("no fixture at {}", self.path)),
            }
        })
    }

    fn poll<'a>(
        &'a self,
        sys: &'a System,
        _token: Option<&'a str>,
    ) -> BoxFuture<'a, Result<Polled, String>> {
        Box::pin(async move {
            let body = tokio::fs::read_to_string(&self.path)
                .await
                .map_err(|e| format!("reading {}: {e}", self.path))?;
            read_decisions(&body, &sys.id, lyra_db::jobs::now_secs())
        })
    }

    fn deliver<'a>(
        &'a self,
        _sys: &'a System,
        _token: Option<&'a str>,
        decision: &'a Decision,
        answer: &'a str,
    ) -> BoxFuture<'a, Result<(), String>> {
        // Accepts, and says so in the log. A stub that refused would make the delivery job look
        // broken; a stub that silently swallowed would make it look finished.
        Box::pin(async move {
            tracing::info!(
                decision = %decision.external_id,
                answer,
                "fixture system accepted an answer"
            );
            Ok(())
        })
    }
}

/* ─── the tick ─── */

/// Ask every enabled system what is new. Returns how many decisions were raised.
///
/// Errors are recorded on the row and never propagated: one unreachable system must not stop the
/// others being polled, and it must not take the sweep down with it.
pub async fn poll_all(state: &AppState) -> usize {
    let systems = SystemStore::new(state.pool.clone(), state.secret_key.as_deref().cloned());
    let decisions = DecisionStore::new(state.pool.clone());
    let now = lyra_db::jobs::now_secs();

    let enabled = match systems.enabled().await {
        Ok(enabled) => enabled,
        Err(e) => {
            tracing::error!(error = %e, "could not read the systems");
            return 0;
        }
    };

    let mut raised = 0;
    for sys in enabled {
        let token = match systems.token_of(&sys.id).await {
            Ok(token) => token,
            Err(e) => {
                // Almost always a missing LYRA_SECRET_KEY, whose message names the variable.
                record(&systems, &sys, Err(trim(&e.to_string())), now).await;
                continue;
            }
        };
        let adapter = adapter_for(&sys.base_url);
        match adapter.poll(&sys, token.as_deref()).await {
            Ok(polled) => {
                match decisions.raise(&polled.raised, now).await {
                    Ok(new) => {
                        if new > 0 {
                            tracing::info!(system = %sys.name, new, "decisions are waiting on you");
                        }
                        raised += new;
                        // The cursor moves only after the rows are committed. The other order loses
                        // a window on a crash: marked read, never written down.
                        record(&systems, &sys, Ok(polled.cursor), now).await;
                    }
                    Err(e) => record(&systems, &sys, Err(trim(&e.to_string())), now).await,
                }
            }
            Err(why) => record(&systems, &sys, Err(why), now).await,
        }
    }
    raised
}

async fn record(
    systems: &SystemStore,
    sys: &System,
    outcome: Result<Option<String>, String>,
    now: i64,
) {
    let written = match &outcome {
        Ok(cursor) => {
            systems
                .record_success(&sys.id, cursor.as_deref(), now)
                .await
        }
        Err(why) => {
            tracing::warn!(system = %sys.name, error = %why, "polling a system");
            systems.record_failure(&sys.id, why, now).await
        }
    };
    if let Err(e) = written {
        tracing::error!(system = %sys.id, error = %e, "recording a system's state");
    }
}

/* ─── HTTP ─── */

fn store(state: &AppState) -> SystemStore {
    SystemStore::new(state.pool.clone(), state.secret_key.as_deref().cloned())
}

pub async fn index(_user: AuthUser, State(state): State<AppState>) -> Response {
    match store(&state).list().await {
        Ok(systems) => Json(json!({ "systems": systems, "scopes": SCOPES })).into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("listing systems: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct NewSystem {
    pub name: String,
    pub base_url: String,
    pub token: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
}

pub async fn create(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<NewSystem>,
) -> Response {
    if body.name.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "a system needs a name");
    }
    if let Err(why) = check_url(&body.base_url) {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    if let Err(why) = check_scopes(&body.scopes) {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    match store(&state)
        .create(
            &SystemInput {
                name: body.name,
                base_url: body.base_url,
                token: body.token,
                scopes: body.scopes,
            },
            lyra_db::jobs::now_secs(),
        )
        .await
    {
        Ok(system) => (StatusCode::CREATED, Json(system)).into_response(),
        // The store refuses a token with no sealing key, naming the variable. That is the caller's
        // problem to fix, so it is a 400 rather than a 500.
        Err(e) => error(StatusCode::BAD_REQUEST, &format!("{e}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct SystemBody {
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub token: Option<String>,
    pub scopes: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

pub async fn update(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<SystemBody>,
) -> Response {
    if let Some(url) = &body.base_url
        && let Err(why) = check_url(url)
    {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    if let Some(scopes) = &body.scopes
        && let Err(why) = check_scopes(scopes)
    {
        return error(StatusCode::BAD_REQUEST, &why);
    }
    let patch = SystemPatch {
        name: body
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty()),
        base_url: body.base_url,
        token: body.token,
        scopes: body.scopes,
        enabled: body.enabled,
    };
    match store(&state)
        .update(&id, &patch, lyra_db::jobs::now_secs())
        .await
    {
        Ok(Some(system)) => Json(system).into_response(),
        Ok(None) => not_found("no such system"),
        Err(e) => error(StatusCode::BAD_REQUEST, &format!("{e}")),
    }
}

pub async fn delete(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    match store(&state).delete(&id).await {
        Ok(true) => crate::common::ok_true(),
        Ok(false) => not_found("no such system"),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("deleting a system: {e}"),
        ),
    }
}

/// Ask a system whether it is there, now, and record what it said.
///
/// The answer is written to the row as well as returned, so the dot on the screen means the same
/// thing whether you pressed the button or the sweep did it.
pub async fn probe(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let systems = store(&state);
    let Ok(Some(sys)) = systems.get(&id).await else {
        return not_found("no such system");
    };
    let token = match systems.token_of(&id).await {
        Ok(token) => token,
        Err(e) => return error(StatusCode::BAD_REQUEST, &trim(&e.to_string())),
    };
    let now = lyra_db::jobs::now_secs();

    match adapter_for(&sys.base_url)
        .health(&sys, token.as_deref())
        .await
    {
        Ok(()) => {
            // No cursor: a health check read nothing, and moving the cursor here would skip a
            // window of decisions that had not been collected.
            let _ = systems.record_success(&id, None, now).await;
            Json(json!({ "ok": true })).into_response()
        }
        Err(why) => {
            let _ = systems.record_failure(&id, &why, now).await;
            Json(json!({ "ok": false, "error": why })).into_response()
        }
    }
}

/// Only `http`, `https` and the `fixture:` stub. Anything else is a typo or a surprise, and a
/// bearer token goes to whatever this names.
fn check_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.starts_with("fixture:") {
        return match url.len() > "fixture:".len() {
            true => Ok(()),
            false => Err("a fixture URL needs a path: fixture:///path/to/file.json".into()),
        };
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!(
            "{url:?} is not an address Lyra can call — use http://, https://, or fixture:// \
             for a stub"
        ));
    }
    if url.len() < "http:// ".len() {
        return Err("that address has no host".into());
    }
    Ok(())
}

fn check_scopes(scopes: &[String]) -> Result<(), String> {
    for scope in scopes {
        if !SCOPES.contains(&scope.as_str()) {
            return Err(format!(
                "unknown scope {scope:?} — Lyra can hold: {}",
                SCOPES.join(", ")
            ));
        }
    }
    Ok(())
}

/// Percent-encode the handful of characters that matter in a path or query segment.
///
/// Hand-rolled because pulling a URL crate in for two call sites is not worth the dependency, and
/// `reqwest` does not encode a string you built yourself. An id with a `/` in it would otherwise
/// address a different endpoint entirely.
fn urlencode(raw: &str) -> String {
    raw.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            other => other
                .to_string()
                .as_bytes()
                .iter()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect()
}

/// One line, short enough for a row on a screen.
fn trim(error: &str) -> String {
    let line = error.lines().next().unwrap_or("").trim();
    if line.chars().count() <= 160 {
        return line.to_string();
    }
    let cut: String = line.chars().take(159).collect();
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use lyra_db::systems::DecisionStore;
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state = AppState::new(pool, "test-secret".into()).with_secret_key(Some(vec![9u8; 32]));
        (dir, state)
    }

    const WIRE: &str = r#"{
      "cursor": "evt-42",
      "decisions": [
        {
          "id": "dec-7",
          "question": "Medieval week 1: castles or alliances?",
          "detail": "next week's order",
          "options": [
            {"value": "castles", "label": "Castles"},
            {"value": "alliances", "label": "Alliances"}
          ],
          "evidence": "castles tested 9% better in the Ancient finale",
          "raised_at": 1759000000
        }
      ]
    }"#;

    /// The contract test I owe content-factory: **the fixture and the wire are the same shape.**
    /// If this passes, a stub that works is evidence the real door will parse.
    #[test]
    fn the_fixture_and_the_wire_are_one_shape() {
        let polled = read_decisions(WIRE, "sys-1", 2000).unwrap();
        assert_eq!(polled.cursor.as_deref(), Some("evt-42"));
        assert_eq!(polled.raised.len(), 1);
        let one = &polled.raised[0];
        assert_eq!(one.system_id, "sys-1");
        assert_eq!(one.external_id, "dec-7");
        assert_eq!(one.options.len(), 2);
        assert_eq!(one.options[0].value, "castles");
        assert_eq!(one.raised_at, 1759000000);
        assert_eq!(one.expires_at, None);

        // Everything but id, question and options is optional, because a system with nothing to
        // add should not have to send nulls to be understood.
        let sparse = read_decisions(
            r#"{"decisions":[{"id":"d1","question":"Ship it?","options":[]}]}"#,
            "sys-1",
            2000,
        )
        .unwrap();
        assert_eq!(sparse.raised[0].raised_at, 2000, "no time means now");
        assert_eq!(sparse.cursor, None, "no cursor leaves the stored one alone");
    }

    /// The whole loop against a file: poll, raise, and do not raise the same thing twice.
    #[tokio::test]
    async fn a_fixture_system_fills_the_inbox_once() {
        let (dir, state) = app().await;
        let fixture = dir.path().join("factory.json");
        std::fs::write(&fixture, WIRE).unwrap();

        let systems = store(&state);
        systems
            .create(
                &SystemInput {
                    name: "content-factory (stub)".into(),
                    base_url: format!("fixture://{}", fixture.display()),
                    token: None,
                    scopes: vec![],
                },
                1000,
            )
            .await
            .unwrap();

        assert_eq!(poll_all(&state).await, 1);
        let decisions = DecisionStore::new(state.pool.clone());
        let open = decisions.open().await.unwrap();
        assert_eq!(open.len(), 1);
        assert_eq!(open[0].question, "Medieval week 1: castles or alliances?");
        assert_eq!(
            open[0].evidence.as_deref(),
            Some("castles tested 9% better in the Ancient finale"),
            "the evidence travels with the question — a decision without it is a guess"
        );

        // The sweep runs every thirty seconds against the same file.
        assert_eq!(poll_all(&state).await, 0, "asked once, not every tick");
        assert_eq!(decisions.open().await.unwrap().len(), 1);

        // And the cursor was written down.
        let after = systems.list().await.unwrap();
        assert_eq!(after[0].cursor.as_deref(), Some("evt-42"));
        assert_eq!(after[0].last_error, None);
    }

    /// One unreachable system must not stop the others, and must say why on its own row.
    #[tokio::test]
    async fn a_system_that_is_down_is_recorded_and_the_others_are_still_polled() {
        let (dir, state) = app().await;
        let fixture = dir.path().join("good.json");
        std::fs::write(&fixture, WIRE).unwrap();
        let systems = store(&state);

        systems
            .create(
                &SystemInput {
                    name: "aaa-missing".into(),
                    base_url: "fixture:///nowhere/at/all.json".into(),
                    token: None,
                    scopes: vec![],
                },
                1000,
            )
            .await
            .unwrap();
        systems
            .create(
                &SystemInput {
                    name: "zzz-working".into(),
                    base_url: format!("fixture://{}", fixture.display()),
                    token: None,
                    scopes: vec![],
                },
                1000,
            )
            .await
            .unwrap();

        // Listed by name, so the broken one is polled first and would take the good one with it.
        assert_eq!(poll_all(&state).await, 1, "the working system still ran");

        let listed = systems.list().await.unwrap();
        let broken = listed.iter().find(|s| s.name == "aaa-missing").unwrap();
        assert!(
            broken
                .last_error
                .as_deref()
                .unwrap_or("")
                .contains("nowhere"),
            "the row must say what went wrong: {:?}",
            broken.last_error
        );
        assert!(broken.failing_since.is_some());
        let working = listed.iter().find(|s| s.name == "zzz-working").unwrap();
        assert_eq!(working.last_error, None);
    }

    /// A disabled system is not talked to at all.
    #[tokio::test]
    async fn a_disabled_system_is_not_polled() {
        let (dir, state) = app().await;
        let fixture = dir.path().join("factory.json");
        std::fs::write(&fixture, WIRE).unwrap();
        let systems = store(&state);
        let made = systems
            .create(
                &SystemInput {
                    name: "content-factory".into(),
                    base_url: format!("fixture://{}", fixture.display()),
                    token: None,
                    scopes: vec![],
                },
                1000,
            )
            .await
            .unwrap();
        systems
            .update(
                &made.id,
                &SystemPatch {
                    enabled: Some(false),
                    ..Default::default()
                },
                1000,
            )
            .await
            .unwrap();

        assert_eq!(poll_all(&state).await, 0);
        assert!(
            DecisionStore::new(state.pool.clone())
                .open()
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn an_address_lyra_cannot_call_is_refused_by_name() {
        assert!(check_url("http://factory:8080").is_ok());
        assert!(check_url("https://factory.ts.net").is_ok());
        assert!(check_url("fixture:///tmp/f.json").is_ok());
        // A bearer token goes to whatever this names, so a scheme nobody meant is a refusal.
        assert!(
            check_url("factory:8080")
                .unwrap_err()
                .contains("factory:8080")
        );
        assert!(
            check_url("file:///etc/passwd")
                .unwrap_err()
                .contains("http")
        );
        assert!(check_url("fixture:").unwrap_err().contains("needs a path"));
    }

    #[test]
    fn a_scope_lyra_does_not_hold_is_refused() {
        assert!(check_scopes(&["read".into(), "propose".into()]).is_ok());
        // The point of the list: `act` must not become storable by accident, because nothing in
        // this file implements it.
        let refused = check_scopes(&["act".into()]).unwrap_err();
        assert!(refused.contains("act") && refused.contains("propose"));
    }

    #[test]
    fn an_id_with_a_slash_cannot_address_a_different_endpoint() {
        assert_eq!(urlencode("dec-7"), "dec-7");
        assert_eq!(urlencode("../admin"), "..%2Fadmin");
        assert_eq!(urlencode("a b"), "a%20b");
        // Multi-byte characters encode per byte, not per char.
        assert_eq!(urlencode("é"), "%C3%A9");
    }
}
