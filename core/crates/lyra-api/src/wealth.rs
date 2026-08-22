//! `/api/wealth/*` — the port of `wallet-portfolio/server.py` (L139-379).
//!
//! Same JSON bodies as the Python, so the existing wealth front end reads these unchanged. Two
//! things do differ, both deliberately:
//!
//! * **Paths are prefixed `/api/wealth/`.** The Python owned the whole `/api` namespace; here it
//!   is a guest in Lyra's, and `/api/history` would collide.
//! * **Every route is JWT-protected** (`user: AuthUser`), where the Python served reads to anyone
//!   on the LAN and gated only `POST /api/analyses` behind `POW_WRITE_TOKEN`. That bearer token is
//!   *not* reimplemented: a second secret stacked behind the JWT would add no security, and
//!   dropping it means the write path has exactly one gate rather than two that can disagree.
//!
//! # Completeness
//!
//! Every route is wired, and as of 2026-08-18 so are `_merkl_rewards` and
//! `_vfat_stamp_lifecycle` — the two gaps this section used to warn about. One caveat remains,
//! inherited from `lyra-chain` rather than from this module:
//!
//! * **A partial read looks like a complete one.** The `FetchHealth` that comes back with a
//!   snapshot is logged, not serialised — see [`log_health`] — because the Python has no such
//!   field and adding one would fail every parity run. A response is safe to display and not safe
//!   to record without checking the log.
//!
//! # Credentials
//!
//! The KuCoin key/secret/passphrase and the Telegram bot token are server-side only. Nothing in
//! this module reads them, and no response shape here has a field that could carry one — the
//! KuCoin endpoint returns holdings and totals, never the credentials that fetched them. The
//! `no_response_leaks_credential_shaped_fields` test holds that line.

use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, LazyLock};

use lyra_alerts::config::{AlertConfig, ProcessEnv};
use lyra_alerts::digest::{DigestSnapshot, Money, header_date, render_digest};
use lyra_alerts::state::AlertStore;
use lyra_alerts::telegram::{MessageSender, TelegramSender};
use lyra_chain::adapters::vfat;
use lyra_chain::address::{MAX_WALLETS, parse_addresses};
use lyra_chain::aggregate::{AggregateConfig, FetchHealth, build_portfolios, build_wallet};
use lyra_chain::http_cache::{HttpCache, Mode};
use lyra_chain::kucoin::{self, KucoinClient};
use lyra_chain::sources::LiveSources;
use lyra_db::wealth as store;

use crate::AppState;
use crate::alert_loop;
use crate::auth::AuthUser;
use crate::collect;
use crate::common::error;

/// Write rate limit for the journal, 20 per 60s — the port of `journal._rate_ok`.
///
/// Process-wide rather than per-connection, and deliberately not durable: it exists to stop a
/// runaway agent looping on the write endpoint, a case where a restart is a perfectly good reset.
/// It lives here rather than in `AppState` only because this module cannot change that struct.
static JOURNAL_RATE: LazyLock<store::RateLimiter> = LazyLock::new(store::RateLimiter::default);

/// The upstream readers, built once for the process.
///
/// They must outlive a request: `Prices` holds the TTL caches that stop every page load
/// re-fetching the same DefiLlama quote, and `Market` holds the metric freshness table with its
/// 30-minute failure backoff. Rebuilding them per request would throw both away and turn a cache
/// hit into an upstream call — the caches are the whole point of those types.
///
/// A process-level `LazyLock` rather than a field on `AppState` because this module cannot change
/// that struct. If `AppState` ever grows a home for these, move them there: a static means tests
/// share one instance, which is why nothing here is test-visible state.
struct Upstreams {
    client: reqwest::Client,
    /// Separate client for the service board, bounded by [`PROBE_TIMEOUT`].
    ///
    /// `client` above is `Client::new()`, which has **no** timeout, and the portfolio fan-out
    /// wants it that way — it is bounded as a whole by `AGGREGATE`'s deadline rather than
    /// per-request. The status board is the opposite: `services.py` gives every probe its own
    /// 8-second ceiling (`_TIMEOUT`, services.py:22) and calls anything past it `down`. Sharing
    /// the untimed client made every probe unbounded, so a hung upstream that Python reports as
    /// `down` was reported here as `slow` after however long it eventually took. The parity gate
    /// caught it as a 8083ms/`down` vs 19723ms/`slow` split on `vfat farm-balances`.
    probe_client: reqwest::Client,
    cache: HttpCache,
    /// The live portfolio reader. It owns the [`Prices`], [`Market`] and vfat caches, which is
    /// why nothing here builds a second set of them — two `Prices` would mean two TTL windows
    /// over the same upstream and a cache hit rate that halves for no reason.
    sources: Arc<LiveSources>,
}

static UPSTREAMS: LazyLock<Upstreams> = LazyLock::new(|| {
    let client = reqwest::Client::new();
    // A builder failure here means no TLS backend, which nothing else in the process could
    // survive either; fall back to the untimed client rather than panicking at first request.
    let probe_client = reqwest::Client::builder()
        .timeout(PROBE_TIMEOUT)
        .build()
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "building the probe client; falling back to the untimed one");
            client.clone()
        });
    // `Mode::from_env` so a parity or offline run can replay fixtures instead of hitting the
    // network, exactly as the chain crate's own tests do.
    let cache = HttpCache::new(
        std::env::var("LYRA_HTTP_FIXTURES").unwrap_or_else(|_| "fixtures".into()),
        Mode::from_env(),
    );
    Upstreams {
        sources: Arc::new(LiveSources::new(
            client.clone(),
            cache.clone(),
            AGGREGATE.adapter_concurrency,
        )),
        client,
        probe_client,
        cache,
    }
});

/// Deadline and concurrency for the fan-out, read once from the environment.
///
/// Shared by `/portfolio` and `/wallet` so the two cannot drift onto different budgets, and
/// shared with [`LiveSources`] so `ADAPTER_CONCURRENCY` means one thing in the process.
static AGGREGATE: LazyLock<AggregateConfig> = LazyLock::new(AggregateConfig::from_env);

/// Log what a fan-out could not reach.
///
/// The health report is deliberately **not** in the response body: the Python has no such key,
/// and adding one would make every parity run report an extra field. So it goes to the log, which
/// is the only place an operator can otherwise learn that a total is short.
fn log_health(what: &str, health: &FetchHealth) {
    if health.deadline_hit {
        tracing::warn!(
            endpoint = what,
            "the request deadline expired; this response is a partial read"
        );
    }
    for failure in &health.failures {
        tracing::warn!(
            endpoint = what,
            chain = failure.task.chain,
            error = %failure.error,
            "chain read failed; its value is missing from the total"
        );
    }
    if health.rates_degraded {
        tracing::warn!(endpoint = what, "FX rates fell back to their defaults");
    }
}

/// Epoch seconds, for the `now` parameters the store takes.
pub(crate) fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/* ─── Shared helpers ─── */

// `unavailable()` lived here — a 503 with a `code: "not_implemented"` marker, so the front end
// could tell "not built yet" from "Blockscout is down". Every route is wired now, so it went with
// the last stub rather than sitting here as a tempting way to defer one.

/// A JSON request body, parsed the way Python's `_read_json` does: anything unreadable — empty,
/// truncated, not an object — becomes `{}` and flows on into per-field validation.
///
/// Taking the body as `String` rather than `Json<Value>` is what preserves that. `Json` rejects
/// malformed input with its own 400 and a different body, which would be a new failure shape the
/// front end has never seen.
fn read_json(body: &str) -> Value {
    serde_json::from_str(body).unwrap_or_else(|_| json!({}))
}

/// Python's truthiness for a query flag: `"1"` and `"true"` are on, everything else is off.
fn flag(raw: Option<&String>) -> bool {
    matches!(raw.map(String::as_str), Some("1") | Some("true"))
}

fn trimmed(raw: Option<&String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/* ─── Wire shapes ─── */

/// One net-worth point: `{"d": …, "v": …}` plus `tiers`/`debt` **only when set**.
///
/// The omission matters. `history._row_to_point` adds those keys conditionally, so a day with no
/// tier split has no `tiers` key at all rather than a null one, and the chart distinguishes the
/// two. Serialising `Option` as `null` would quietly change every point on the wire.
fn point_json(point: &store::Point) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("d".into(), json!(point.d));
    object.insert("v".into(), json!(point.v));
    if let Some(tiers) = &point.tiers {
        object.insert("tiers".into(), tiers.clone());
    }
    if let Some(debt) = point.debt {
        object.insert("debt".into(), json!(debt));
    }
    Value::Object(object)
}

/// One recorded snapshot. Unlike [`point_json`], every key is always present — `snapshots.series`
/// builds a fixed dict, so absent figures are `null`, not missing.
fn snapshot_json(point: &store::SnapshotPoint) -> Value {
    json!({
        "ts": point.ts,
        "v": point.v,
        "assets": point.assets,
        "debt": point.debt,
        "btc_usd": point.btc_usd,
        "btc_sats": point.btc_sats,
    })
}

/// One journal record, in `journal._row`'s shape.
///
/// `anchor` is null unless the row carries a snapshot hash, and inside it the hash is published
/// under the key `snapshot` (not `hash`) with `coverage` defaulting to `{}` — all three quirks are
/// the Python's, and the Journal panel reads them positionally.
fn analysis_json(analysis: &store::Analysis) -> Value {
    let anchor = analysis.anchor.as_ref().map(|anchor| {
        json!({
            "as_of": anchor.as_of,
            "snapshot": anchor.hash,
            "coverage": anchor.coverage.clone().unwrap_or_else(|| json!({})),
        })
    });

    json!({
        "id": analysis.id,
        "scope": analysis.scope,
        "version": analysis.version,
        "kind": analysis.kind,
        "title": analysis.title,
        "summary": analysis.summary,
        "body_md": analysis.body_md,
        "structured": analysis.structured,
        "author": analysis.author,
        "source": analysis.source,
        "created_at": analysis.created_at,
        "net_worth_usd": analysis.net_worth_usd,
        "superseded_by": analysis.superseded_by,
        "archived_at": analysis.archived_at,
        "anchor": anchor,
    })
}

/// Maps a failed write to a status code.
///
/// A validation failure is 422, as in the Python. A rate-limited write is **429**, which the
/// Python reported as 422 as well — it raised one exception type for both. `lyra-db` separates
/// them and documents the split, and a client that cannot tell "malformed" from "slow down"
/// retries the wrong one forever. The body shape is unchanged either way.
fn journal_failure(e: &anyhow::Error) -> Response {
    match e.downcast_ref::<store::JournalError>() {
        Some(store::JournalError::RateLimited) => error(
            StatusCode::TOO_MANY_REQUESTS,
            &store::JournalError::RateLimited.to_string(),
        ),
        Some(journal_error) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": journal_error.to_string() })),
        )
            .into_response(),
        None => {
            tracing::error!(error = %e, "journal write failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// Reads an analysis payload out of a request body.
fn analysis_input(body: &Value) -> store::AnalysisInput {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_default()
    };
    store::AnalysisInput {
        scope: text("scope"),
        kind: text("kind"),
        title: text("title"),
        summary: Some(text("summary")).filter(|s| !s.is_empty()),
        body_md: text("body_md"),
        structured: body.get("structured").cloned().filter(|v| !v.is_null()),
        author: Some(text("author")).filter(|s| !s.is_empty()),
    }
}

/* ─── Net-worth history (server.py L288, L361) ─── */

#[derive(Debug, Deserialize)]
pub struct GroupQuery {
    pub group: Option<String>,
}

/// `GET /api/wealth/history?group=` — the browser-owned net-worth series.
///
/// The echoed `group` is the caller's raw string, not the sanitised one used for storage. That is
/// what the Python echoes, and the client matches the response against the group it asked for.
pub async fn history(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<GroupQuery>,
) -> Response {
    // An absent group means "this box's own series", not the group literally named "". The
    // sweep writes under `SNAPSHOT_GROUP`, so that is what the client gets when it does not ask
    // for something else — the same reasoning as the address fallback above.
    let group = match params.group {
        Some(g) if !g.trim().is_empty() => g,
        _ => crate::alert_loop::snapshot_group(),
    };
    match store::load_history(&state.pool, &group).await {
        Ok(points) => Json(json!({
            "group": group,
            "points": points.iter().map(point_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "loading nw history");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `POST /api/wealth/history` — upsert points and get the merged series back.
///
/// One call both backfills a new device and syncs an existing one, because the response is the
/// whole merged series rather than an acknowledgement.
pub async fn save_history(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let body = read_json(&body);
    let group = body
        .get("group")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let points: Vec<store::Point> = body
        .get("points")
        .and_then(Value::as_array)
        .map(|raw| raw.iter().filter_map(store::clean_point).collect())
        .unwrap_or_default();

    match store::save_history(&state.pool, &group, &points).await {
        Ok(merged) => Json(json!({
            "group": group,
            "points": merged.iter().map(point_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "saving nw history");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/* ─── Server-recorded snapshots (server.py L295) ─── */

/// `GET /api/wealth/snapshots?group=server` — the keyless series the cron writes.
///
/// Defaults to the `server` group, not to the empty string that [`history`] defaults to: these are
/// written by the always-on process under a fixed name, so a caller that names no group wants that
/// one.
pub async fn snapshots(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<GroupQuery>,
) -> Response {
    let group = params.group.unwrap_or_else(|| "server".to_string());
    match store::snapshot_series(&state.pool, &group, store::DEFAULT_SERIES_LIMIT).await {
        Ok(points) => Json(json!({
            "group": group,
            "points": points.iter().map(snapshot_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "reading snapshots");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/* ─── The analysis journal (server.py L303-320, L367, L371) ─── */

#[derive(Debug, Deserialize)]
pub struct AnalysesQuery {
    pub scope: Option<String>,
    pub kind: Option<String>,
    pub source: Option<String>,
    /// `1`/`true` asks for the full version history rather than the latest per scope.
    pub history: Option<String>,
    pub archived: Option<String>,
    /// Parsed leniently: a non-numeric limit falls back to the default page, as Python's
    /// `except ValueError` does, rather than rejecting the request.
    pub limit: Option<String>,
}

/// `GET /api/wealth/analyses` — the latest analysis per scope, or a full history.
pub async fn analyses(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<AnalysesQuery>,
) -> Response {
    let want_history = flag(params.history.as_ref());
    let query = store::AnalysisQuery {
        scope: trimmed(params.scope.as_ref()),
        kind: trimmed(params.kind.as_ref()),
        source: trimmed(params.source.as_ref()),
        latest_only: !want_history,
        // Asking for history is itself an archival request, so it implies archived rows.
        include_archived: want_history || flag(params.archived.as_ref()),
        limit: params
            .limit
            .as_deref()
            .and_then(|raw| raw.trim().parse::<i64>().ok())
            .unwrap_or(store::DEFAULT_LIST_LIMIT),
    };

    match store::list_analyses(&state.pool, &query).await {
        Ok(rows) => Json(json!({
            "analyses": rows.iter().map(analysis_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "listing analyses");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `GET /api/wealth/analyses/{id}` — one full record.
pub async fn analysis(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match store::get_analysis(&state.pool, &id).await {
        Ok(Some(record)) => Json(analysis_json(&record)).into_response(),
        // "not found", lowercase, is the Python's exact body for this route.
        Ok(None) => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => {
            tracing::error!(error = %e, "reading analysis");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `POST /api/wealth/analyses` — append an LLM analysis, `source = "http"`.
///
/// **There is no `POW_WRITE_TOKEN` check here, and its absence is deliberate — not an oversight.**
/// `server.py` served reads to anyone on the LAN and required a shared bearer secret for this one
/// write. Under Lyra the whole module sits behind the JWT gate, so anyone who reaches this handler
/// has already authenticated as the owner. A second secret would gate against nobody while adding
/// a second thing to configure, rotate and leak.
///
/// **No snapshot anchor is stamped.** The Python anchors the record to a fresh server-side read of
/// the named wallets (`pow_mcp.sources.snapshot`). That needs a live `PortfolioSources`, which does
/// not exist yet (see the module docs); the Python also stores the record unanchored whenever that
/// read is absent or fails, so an anchorless row is a path the schema and the UI already handle.
/// When it becomes possible, build a `store::SnapshotAnchor` here and pass it instead of `None` —
/// never accept one from the request body, or a model could invent the very numbers it claims to
/// have reasoned about.
pub async fn create_analysis(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let body = read_json(&body);

    if !JOURNAL_RATE.check(None) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            &store::JournalError::RateLimited.to_string(),
        );
    }

    match store::save_analysis(
        &state.pool,
        &analysis_input(&body),
        "http",
        None,
        None,
        None,
    )
    .await
    {
        Ok(record) => (StatusCode::CREATED, Json(analysis_json(&record))).into_response(),
        Err(e) => journal_failure(&e),
    }
}

/// `POST /api/wealth/notes` — your own note into the same journal, always `source = "user"`.
///
/// Two defaults come from the Python: an absent author is `"me"`, and an absent scope gets a
/// generated `note:<slug>-<id>` so a standalone note becomes its own thread instead of being
/// rejected for a missing scope.
pub async fn create_note(State(state): State<AppState>, _user: AuthUser, body: String) -> Response {
    let body = read_json(&body);
    let mut input = analysis_input(&body);

    input.author = input
        .author
        .map(|a| a.trim().chars().take(200).collect::<String>())
        .filter(|a| !a.is_empty())
        .or_else(|| Some("me".to_string()));

    if input.scope.trim().is_empty() {
        input.scope = store::note_scope(&input.title);
    }

    if !JOURNAL_RATE.check(None) {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            &store::JournalError::RateLimited.to_string(),
        );
    }

    match store::save_analysis(&state.pool, &input, "user", None, None, None).await {
        Ok(record) => (StatusCode::CREATED, Json(analysis_json(&record))).into_response(),
        Err(e) => journal_failure(&e),
    }
}

/// `POST /api/wealth/notes/archive` — soft-archive or restore a thread.
///
/// Nothing is deleted; the latest row of the scope is stamped, which drops the whole thread out of
/// the default listing.
pub async fn archive_note(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let body = read_json(&body);
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    if scope.is_empty() {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": "scope required" })),
        )
            .into_response();
    }

    // Absent means archive: the button that sends no flag is the archive button.
    let archived = body
        .get("archived")
        .map(|value| value.as_bool().unwrap_or(true))
        .unwrap_or(true);

    match store::archive_scope(&state.pool, &scope, archived, None).await {
        Ok(updated) => Json(json!({ "scope": scope, "updated": updated })).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "archiving scope");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/* ─── Off-chain assets ─── */

/// Serialises an off-chain asset for the browser.
///
/// Absent optionals are **omitted** rather than sent as `null`, because `ManualAsset` in
/// `types.ts` declares them with `?` — `null` is not assignable to `string | undefined`, and the
/// alternative was widening every one of those fields and every reader of them.
fn manual_json(asset: &store::ManualAsset) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("id".into(), json!(asset.id));
    out.insert("name".into(), json!(asset.name));
    out.insert("tier".into(), json!(asset.tier));
    out.insert("created_at".into(), json!(asset.created_at));
    out.insert("updated_at".into(), json!(asset.updated_at));

    for (key, value) in [
        ("kind", &asset.kind),
        ("ccy", &asset.ccy),
        ("code", &asset.code),
        ("chain", &asset.chain),
        ("note", &asset.note),
        ("custody", &asset.custody),
    ] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    for (key, value) in [("value", asset.value), ("units", asset.units)] {
        if let Some(value) = value {
            out.insert(key.into(), json!(value));
        }
    }
    Value::Object(out)
}

/// Reads an off-chain asset out of a request body.
///
/// Numbers are accepted as numbers *or* as the strings an HTML `<input type="number">` produces —
/// the alternative is a form that silently drops the one field it exists to capture. An
/// unparseable string becomes `None`, which `clean_manual` treats as "no value", not as zero.
fn manual_input(body: &Value) -> store::ManualAssetInput {
    let text = |key: &str| {
        body.get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.trim().is_empty())
    };
    let number = |key: &str| match body.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };

    store::ManualAssetInput {
        name: text("name").unwrap_or_default(),
        kind: text("kind"),
        value: number("value"),
        ccy: text("ccy"),
        units: number("units"),
        code: text("code"),
        tier: text("tier").unwrap_or_default(),
        chain: text("chain"),
        note: text("note"),
        custody: text("custody"),
    }
}

/// Maps a rejected off-chain write to a status code: 422 for validation, 500 for anything else.
///
/// The same split as [`journal_failure`], minus the rate limit — this endpoint is driven by a
/// human filling in a form, not by an agent in a loop.
fn manual_failure(e: &anyhow::Error) -> Response {
    match e.downcast_ref::<store::ManualAssetError>() {
        Some(bad) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(json!({ "error": bad.to_string() })),
        )
            .into_response(),
        None => {
            tracing::error!(error = %e, "manual asset write failed");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `GET /api/wealth/manual-assets` — the off-chain book.
///
/// These used to live in the browser's `localStorage`, which meant one device, no backup, and gone
/// with a cleared cache. It also meant the server's own net-worth snapshot could never see them,
/// so `snapshots` and the legacy `nw_history` series were measuring two different things.
pub async fn manual_assets(State(state): State<AppState>, _user: AuthUser) -> Response {
    match store::list_manual_assets(&state.pool).await {
        Ok(assets) => Json(json!({
            "assets": assets.iter().map(manual_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "listing manual assets");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `POST /api/wealth/manual-assets` — add one, answering `201` with the stored row.
pub async fn create_manual_asset(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let input = manual_input(&read_json(&body));
    match store::create_manual_asset(&state.pool, &input, None).await {
        Ok(asset) => (StatusCode::CREATED, Json(manual_json(&asset))).into_response(),
        Err(e) => manual_failure(&e),
    }
}

/// `PUT /api/wealth/manual-assets/{id}` — replace one wholesale.
///
/// A replace rather than a patch: the editor sends the whole form, and under a patch "clear this
/// note" and "leave this note alone" would be the same request.
pub async fn update_manual_asset(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
    body: String,
) -> Response {
    let input = manual_input(&read_json(&body));
    match store::update_manual_asset(&state.pool, &id, &input, None).await {
        Ok(Some(asset)) => Json(manual_json(&asset)).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => manual_failure(&e),
    }
}

/// `DELETE /api/wealth/manual-assets/{id}` — remove one for good.
pub async fn delete_manual_asset(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match store::delete_manual_asset(&state.pool, &id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => {
            tracing::error!(error = %e, "deleting manual asset");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/* ─── Chain-backed reads — awaiting a `lyra-chain` dependency ─── */

#[derive(Debug, Deserialize)]
pub struct AddressQuery {
    pub address: Option<String>,
}

/// Parse the `address` query parameter, or produce the Python's 400.
///
/// `parse_addresses` rejects an empty string as well as a malformed one, which is why a missing
/// parameter needs no separate arm — the Python reaches the same place through `[""][0]`.
///
/// The error side is the message rather than a built `Response`: a `Response` is a large enough
/// `Err` variant that every caller would pay for it on the success path too.
/// The wallets this box belongs to, read once.
///
/// A `LazyLock` rather than a per-request read so the answer cannot change under a running
/// process, and so tests never depend on the shell they were launched from — [`addresses`] takes
/// the value as an argument and is exercised directly.
static DEFAULT_WALLETS: LazyLock<String> =
    LazyLock::new(|| std::env::var("ALERT_WALLETS").unwrap_or_default());

/// Resolve the `address` query parameter, falling back to the configured wallets.
///
/// The Python required an address on every call because its front end kept the wallet list in
/// the browser. Lyra's does not: this is a single-user box whose wallets are already configured
/// server-side as `ALERT_WALLETS`, so a page asking "what am I worth" should not have to be told
/// whose money to count. Without this the front end's `getPortfolio()` — which sends no
/// `?address=` — got a 400 and every wealth page rendered its error state.
///
/// An explicit address still wins, so the parity gate (which always passes one) is unaffected,
/// and a *malformed* address is still a 400. Only an absent one falls back.
fn addresses(
    raw: Option<String>,
    max_wallets: usize,
    configured: &str,
) -> Result<Vec<String>, String> {
    let raw = raw.unwrap_or_default();
    let raw = if raw.trim().is_empty() { configured } else { &raw };
    if raw.trim().is_empty() {
        return Err(
            "no address supplied and no wallets are configured — pass ?address= or set \
             ALERT_WALLETS"
                .into(),
        );
    }
    parse_addresses(raw, max_wallets)
}

/* ─── The wallet list ─── */

/// The addresses this box counts, from the database, falling back to the environment.
///
/// `ALERT_WALLETS` is the seed and the fallback, never the authority: an empty table means "use
/// the environment", so a box that has never opened the wallet screen keeps working exactly as it
/// did. Adding one address through the UI takes over completely — a half-and-half union would make
/// "remove this wallet" impossible for anything the env still names.
///
/// Returned as the raw space-joined string [`addresses`] parses, so the query-parameter path and
/// the fallback path go through the same validation.
pub(crate) async fn configured_wallets(pool: &sqlx::SqlitePool) -> String {
    match store::wallet_addresses(pool).await {
        Ok(list) if !list.is_empty() => list.join(" "),
        Ok(_) => DEFAULT_WALLETS.clone(),
        Err(e) => {
            // The env fallback is the safe answer here: reporting an empty book because a read
            // failed would look exactly like a book that is genuinely empty.
            tracing::error!(error = %e, "reading the wallet list; falling back to ALERT_WALLETS");
            DEFAULT_WALLETS.clone()
        }
    }
}

fn wallet_json(wallet: &store::Wallet) -> Value {
    json!({
        "id": wallet.id,
        "address": wallet.address,
        "label": wallet.label,
        "kind": wallet.kind,
        "created_at": wallet.created_at,
    })
}

/// `GET /api/wealth/wallets` — the configured address list.
///
/// `source` says where the list came from, because "you have no wallets" and "your wallets come
/// from the environment" look identical in the array alone and want different UI.
pub async fn wallets(State(state): State<AppState>, _user: AuthUser) -> Response {
    match store::list_wallets(&state.pool).await {
        Ok(rows) => {
            let from_env = rows.is_empty() && !DEFAULT_WALLETS.trim().is_empty();
            Json(json!({
                "wallets": rows.iter().map(wallet_json).collect::<Vec<_>>(),
                "source": if rows.is_empty() && from_env { "env" } else { "db" },
                // What the fan-out will actually read, whichever source won.
                "effective": parse_addresses(&configured_wallets(&state.pool).await, MAX_WALLETS)
                    .unwrap_or_default(),
            }))
            .into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "listing wallets");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// Classify an address the way the chain fan-out does, or `None` if it cannot read it.
fn wallet_kind(address: &str) -> Option<&'static str> {
    use lyra_chain::address::AddressKind;
    match lyra_chain::address::kind_of(address)? {
        AddressKind::Evm => Some("evm"),
        AddressKind::Bitcoin => Some("bitcoin"),
        AddressKind::Solana => Some("solana"),
    }
}

/// Move the environment's addresses into the table, once, just before it stops being consulted.
///
/// Without this, adding your first wallet would *silently drop* every address `ALERT_WALLETS`
/// named — you would add a cold Bitcoin wallet and lose the EVM one that holds the actual book.
/// The list takes over, so it has to take over carrying what was already there.
///
/// A no-op once anything is stored, and a best-effort import: an env entry the classifier cannot
/// read is skipped with a warning rather than blocking the wallet the user actually asked for.
async fn seed_wallets_from_env(pool: &sqlx::SqlitePool) {
    match store::list_wallets(pool).await {
        Ok(existing) if !existing.is_empty() => return,
        Ok(_) => {}
        Err(e) => {
            tracing::error!(error = %e, "checking whether wallets need seeding");
            return;
        }
    }

    for address in parse_addresses(&DEFAULT_WALLETS, MAX_WALLETS).unwrap_or_default() {
        let Some(kind) = wallet_kind(&address) else {
            tracing::warn!(%address, "skipping an ALERT_WALLETS entry that is not a readable address");
            continue;
        };
        if let Err(e) = store::create_wallet(pool, &address, Some("from ALERT_WALLETS"), kind, None).await {
            tracing::warn!(error = %e, %address, "could not seed a wallet from the environment");
        }
    }
}

/// `POST /api/wealth/wallets` — add an address.
///
/// The address is validated by `lyra-chain`'s own classifier, so exactly the set the fan-out can
/// actually read is the set that can be stored — a typo is refused here rather than becoming a
/// wallet that silently contributes nothing.
pub async fn create_wallet(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let body = read_json(&body);
    let address = body
        .get("address")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();

    let Some(kind) = wallet_kind(&address) else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "not an address this can read — expected 0x… (EVM), bc1…/1…/3… (Bitcoin) or a Solana address",
        );
    };

    // Validate before seeding: a rejected address must not be the thing that flips the list from
    // the environment to the database.
    seed_wallets_from_env(&state.pool).await;

    // The cap is the fan-out's, not a storage limit: past it the portfolio read would refuse the
    // whole list, so the wallet that breaks it is refused instead of the book.
    match store::list_wallets(&state.pool).await {
        Ok(existing) if existing.len() >= MAX_WALLETS => {
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                &format!("at most {MAX_WALLETS} wallets"),
            );
        }
        Ok(_) => {}
        Err(e) => {
            tracing::error!(error = %e, "counting wallets");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
        }
    }

    let label = body.get("label").and_then(Value::as_str);
    match store::create_wallet(&state.pool, &address, label, kind, None).await {
        Ok(wallet) => (StatusCode::CREATED, Json(wallet_json(&wallet))).into_response(),
        Err(e) => match e.downcast_ref::<store::WalletError>() {
            Some(store::WalletError::Duplicate) => error(StatusCode::CONFLICT, &e.to_string()),
            Some(bad) => error(StatusCode::UNPROCESSABLE_ENTITY, &bad.to_string()),
            None => {
                tracing::error!(error = %e, "adding wallet");
                error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
            }
        },
    }
}

/// `DELETE /api/wealth/wallets/{id}` — stop counting an address.
pub async fn delete_wallet(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<String>,
) -> Response {
    match store::delete_wallet(&state.pool, &id).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => {
            tracing::error!(error = %e, "deleting wallet");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// `GET /api/wealth/portfolio?address=` — every wallet, aggregated.
///
/// Accepts several addresses separated by commas or spaces, up to `MAX_WALLETS`.
///
/// The body is the `PortfolioSnapshot` alone, in `build_portfolios`' key order. The `FetchHealth`
/// riding with it is logged rather than serialised — see [`log_health`] — so a partial read looks
/// structurally identical to a complete one on the wire, exactly as it does from the Python. That
/// is fine for display and **not** fine to record: see `aggregate`'s module docs before writing
/// one of these into the history table.
pub async fn portfolio(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<AddressQuery>,
) -> Response {
    let configured = configured_wallets(&state.pool).await;
    let addresses = match addresses(params.address, MAX_WALLETS, &configured) {
        Ok(addresses) => addresses,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };

    let mut snapshot =
        build_portfolios(Arc::clone(&UPSTREAMS.sources), &addresses, &AGGREGATE).await;
    log_health("portfolio", &snapshot.health);
    join_perf(&state.pool, &mut snapshot.portfolio.wallets).await;
    Json(snapshot.portfolio).into_response()
}

/// `GET /api/wealth/wallet?address=` — one wallet, so the UI can render each as it arrives.
///
/// One address only (`max_wallets=1`): this is the lazy per-wallet endpoint the front end fans
/// out over, and accepting a list here would defeat the point of it.
pub async fn wallet(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<AddressQuery>,
) -> Response {
    let addresses = match addresses(params.address, 1, &DEFAULT_WALLETS) {
        Ok(addresses) => addresses,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };

    let mut outcome = build_wallet(Arc::clone(&UPSTREAMS.sources), &addresses[0], &AGGREGATE).await;
    log_health("wallet", &outcome.health);
    join_perf(&state.pool, std::slice::from_mut(&mut outcome.wallet)).await;
    Json(json!({
        "wallet": outcome.wallet,
        "rates": UPSTREAMS.sources.market().get_rates().await,
    }))
    .into_response()
}

/// Attach the cron's in-range accumulators to every position carrying a `perf_key`.
///
/// The read half of `_vfat_stamp_lifecycle` (portfolio.py:1304, 1321-1324). It runs *after* the
/// build rather than inside it because `lyra-chain` deliberately owns no database handle — which
/// also makes this one query for the whole portfolio where Python issues one per chain.
///
/// A failure logs and leaves `in_range_secs` absent. That is the honest outcome: the field means
/// "time this position has actually been in range", and a zero would read as "it never was".
async fn join_perf(pool: &sqlx::SqlitePool, wallets: &mut [lyra_chain::model::Wallet]) {
    let keys: Vec<String> = wallets
        .iter()
        .flat_map(|wallet| wallet.chains.iter())
        .flat_map(|bucket| bucket.defi.iter())
        .filter_map(|position| position.perf_key.clone())
        .collect();
    if keys.is_empty() {
        return;
    }

    let records = match store::perf_records(pool, &keys).await {
        Ok(records) => records,
        Err(e) => {
            tracing::warn!(error = %e, "reading pos_perf; in-range time omitted this build");
            return;
        }
    };
    // Two structurally identical types, one per crate, because neither `lyra-db` nor `lyra-chain`
    // depends on the other — and neither should, to keep SQL out of the chain reader.
    let perf = records
        .into_iter()
        .map(|(key, record)| {
            (
                key,
                vfat::PerfRecord {
                    in_range_secs: record.in_range_secs,
                    cycle_start: record.cycle_start,
                },
            )
        })
        .collect();

    for wallet in wallets {
        for bucket in &mut wallet.chains {
            vfat::apply_perf(&mut bucket.defi, &perf);
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct FundQuery {
    pub code: Option<String>,
}

/// `GET /api/wealth/fund?code=` — Thai mutual-fund NAV proxy.
///
/// Server-side so the WealthMagik client id stays out of the browser and the call dodges CORS.
/// An unknown code is `{"fund": null}` with a 200, as in the Python — not a 404, because "no NAV
/// published for this code" is an answer, not a missing resource.
pub async fn fund(_user: AuthUser, Query(params): Query<FundQuery>) -> Response {
    let code = params.code.unwrap_or_default();
    Json(json!({ "fund": UPSTREAMS.sources.market().thai_fund_nav(&code).await })).into_response()
}

/// `GET /api/wealth/sentiment` — fear/greed, rainbow, MVRV, SOPR, Puell.
///
/// The *rich* bundle, carrying `fetched_at`; the two-key block embedded in a portfolio response is
/// a different type. Every field is independently nullable: one dead upstream blanks its own panel
/// and nothing else.
pub async fn sentiment(_user: AuthUser) -> Response {
    Json(UPSTREAMS.sources.market().market_sentiment().await).into_response()
}

/// `GET /api/wealth/kucoin` — the exchange account, shaped like any other wallet.
///
/// `{"wallet": null}` when no credentials are configured, which is the Python's behaviour and not
/// an error: an unconfigured exchange is a normal state for this app.
///
/// The credentials never leave [`KucoinClient`] — they are used to sign request headers and are
/// not part of any type in the response. `Wallet` carries an address label, a total and per-chain
/// holdings; there is no field a key could travel in.
pub async fn kucoin(_user: AuthUser) -> Response {
    let wallet = match KucoinClient::from_env(&UPSTREAMS.client, &UPSTREAMS.cache) {
        Some(client) => client.balances().await,
        None => None,
    };
    Json(json!({ "wallet": wallet, "rates": UPSTREAMS.sources.market().get_rates().await }))
        .into_response()
}

#[derive(Debug, Deserialize)]
pub struct PriceHistoryQuery {
    pub coin: Option<String>,
    pub days: Option<String>,
}

/// `GET /api/wealth/price-history?coin=&days=365` — keyless daily closes for the Analysis Lab.
///
/// `days` falls back to 365 when absent or unparseable. The Python's `int(...)` would raise a 500
/// on `days=lots`; defaulting instead is the one place this route is deliberately more forgiving,
/// because the response shape is identical either way and a 500 here tells the client nothing.
pub async fn price_history(_user: AuthUser, Query(params): Query<PriceHistoryQuery>) -> Response {
    let coin = params.coin.unwrap_or_default();
    let days = params
        .days
        .as_deref()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|days| *days > 0)
        .unwrap_or(365);

    Json(json!({
        "coin": coin,
        "points": UPSTREAMS.sources.prices().price_history(&coin, days).await,
    }))
    .into_response()
}

/// `GET /api/wealth/yield-radar?address=` — higher-APR pools for tokens already held.
///
/// Each wallet is radared separately and capped at `RADAR_LIMIT`, then the merged list is ranked
/// again and truncated to [`RADAR_TOTAL`]. Ranking twice is the Python's shape, not an oversight:
/// the per-wallet cap stops one wallet's chains flooding the board, and the second pass is what
/// dedupes a pool two wallets both qualify for.
///
/// A wallet the vfat feed cannot be read for is skipped rather than failing the request — the
/// radar is a suggestion board, and one unreachable wallet should not blank it.
pub async fn yield_radar(_user: AuthUser, Query(params): Query<AddressQuery>) -> Response {
    let addresses = match addresses(params.address, MAX_WALLETS, &DEFAULT_WALLETS) {
        Ok(addresses) => addresses,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };

    let mut found = Vec::new();
    for address in &addresses {
        match vfat::vfat_yield_radar(UPSTREAMS.sources.vfat(), address, vfat::RADAR_LIMIT).await {
            Ok(opportunities) => found.extend(opportunities),
            Err(e) => tracing::warn!(
                error = format!("{e:#}"),
                "yield radar skipped a wallet whose vfat feed could not be read"
            ),
        }
    }

    Json(json!({ "radar": vfat::rank_radar(found, RADAR_TOTAL) })).into_response()
}

/// How many suggestions the board shows, across every wallet — `radar[:8]` in `server.py`.
const RADAR_TOTAL: usize = 8;

/* ─── Service health board — the port of `services.py` ─── */

/// Over this, a reachable upstream is reported `slow` rather than `up` — `SLOW_MS`.
const SLOW_MS: u128 = 3000;

/// Per-probe ceiling. The sweep runs them concurrently, so this is also the worst-case time for
/// the whole board.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// How long a completed sweep is served from cache — `_TTL`.
const SERVICES_TTL_SECS: i64 = 30;

/// How a probe is performed.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Probe {
    /// Plain GET; anything under HTTP 400 is up.
    Get(&'static str),
    /// `eth_blockNumber`, which must come back with a string `result` — a node that answers 200
    /// with an error body is down, not up, and only reading the body catches that.
    Rpc(&'static str),
    /// POST with a fixed JSON body (Hyperliquid's `{"type":"meta"}`).
    Post(&'static str, &'static str),
    /// `getMe` against the configured bot. Idle when alerts are not set up.
    Telegram,
}

struct ServiceSpec {
    name: &'static str,
    category: &'static str,
    /// What breaks in the UI when this is down — the whole point of the board.
    powers: &'static str,
    probe: Probe,
}

/// The upstreams to sweep, in display order.
///
/// RPC endpoints are read from `lyra_chain::chains` rather than hard-coded, so this board cannot
/// drift from the URLs the portfolio reader actually uses — a health check that probes a different
/// endpoint than the code it is vouching for is worse than none.
fn service_specs() -> Vec<ServiceSpec> {
    let mut specs = vec![
        ServiceSpec {
            name: "DefiLlama",
            category: "Prices",
            powers: "token prices & 24h change",
            probe: Probe::Get("https://coins.llama.fi/prices/current/coingecko:bitcoin"),
        },
        // Deliberately the farm-balances endpoint, not the API host: that is the flaky one, and
        // when it fails HyperEVM LPs silently fall back to the on-chain RPC path.
        ServiceSpec {
            name: "vfat farm-balances",
            category: "DeFi positions",
            powers: "HyperEVM LP positions (RPC fallback if down)",
            probe: Probe::Get(
                "https://api.vfat.io/v4/farm-balances\
                 ?addresses=0x0000000000000000000000000000000000000001",
            ),
        },
        ServiceSpec {
            name: "Frankfurter",
            category: "FX",
            powers: "USD→THB rate",
            probe: Probe::Get("https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB"),
        },
    ];

    // A chain whose entry carries no RPC cannot be probed; skipping beats inventing a URL.
    for (name, powers) in [
        ("ethereum", "ethereum balances & LPs"),
        ("hyperevm", "HyperEVM balances & LP fallback"),
    ] {
        if let Some(rpc) = lyra_chain::chains::by_name(name).and_then(|chain| chain.rpc) {
            specs.push(ServiceSpec {
                name: if name == "ethereum" {
                    "Ethereum RPC"
                } else {
                    "HyperEVM RPC"
                },
                category: "Chain",
                powers,
                probe: Probe::Rpc(rpc),
            });
        }
    }

    specs.extend([
        ServiceSpec {
            name: "Hyperliquid L1",
            category: "Exchange",
            powers: "Hyperliquid spot & perps",
            probe: Probe::Post("https://api.hyperliquid.xyz/info", r#"{"type":"meta"}"#),
        },
        ServiceSpec {
            name: "KuCoin",
            category: "Exchange",
            powers: "KuCoin balances, bots & Earn",
            probe: Probe::Get("https://api.kucoin.com/api/v1/timestamp"),
        },
        ServiceSpec {
            name: "hyperscan",
            category: "Explorer",
            powers: "on-chain verification & NFT discovery",
            probe: Probe::Get("https://www.hyperscan.com/api?module=block&action=eth_block_number"),
        },
        ServiceSpec {
            name: "Telegram",
            category: "Alerts",
            powers: "out-of-range push alerts",
            probe: Probe::Telegram,
        },
    ]);

    specs
}

/// The outcome of one probe, before it is classified.
struct ProbeResult {
    /// `None` means "idle" — not configured, so neither up nor down.
    ok: Option<bool>,
    ms: u128,
    /// `HTTP 200`, or an error kind. Never a URL: the Telegram probe's URL contains the bot token.
    detail: String,
}

/// `_classify`: idle → idle, failure → down, slow response → slow, otherwise up.
fn classify(ok: Option<bool>, ms: u128) -> &'static str {
    match ok {
        None => "idle",
        Some(false) => "down",
        Some(true) if ms >= SLOW_MS => "slow",
        Some(true) => "up",
    }
}

/// Python reports `type(e).__name__`. reqwest has no equivalent, so the failure modes that matter
/// operationally are named explicitly and everything else collapses to `RequestError` — the detail
/// line exists to tell "timed out" from "refused", not to be a stack trace.
fn error_detail(error: &anyhow::Error) -> String {
    match error.downcast_ref::<reqwest::Error>() {
        Some(e) if e.is_timeout() => "Timeout".into(),
        Some(e) if e.is_connect() => "ConnectionError".into(),
        Some(e) if e.is_decode() => "DecodeError".into(),
        Some(_) => "RequestError".into(),
        // A cache-layer failure (a missing fixture in replay mode, an unwritable cache dir).
        None => "Error".into(),
    }
}

/// Runs one probe, measuring wall-clock latency.
///
/// Every call except Telegram goes through [`HttpCache`], so a replay run answers the whole board
/// from fixtures without touching the network. Note that latency measured in replay mode is the
/// fixture read, not the upstream — a replayed board is for shape, never for timing.
async fn run_probe(probe: Probe) -> ProbeResult {
    let started = std::time::Instant::now();

    // Telegram is the exception, deliberately: its URL embeds the bot token
    // (`/bot<token>/getMe`), and HttpCache keys and records the URL it fetched. Routing this
    // through the cache would write the token into a fixture file on disk.
    if probe == Probe::Telegram {
        let (Ok(token), true) = (std::env::var("TELEGRAM_BOT_TOKEN"), telegram_ready()) else {
            return ProbeResult {
                ok: None,
                ms: 0,
                detail: "not configured".into(),
            };
        };
        let result = UPSTREAMS
            .client
            .get(format!("https://api.telegram.org/bot{token}/getMe"))
            .timeout(PROBE_TIMEOUT)
            .send()
            .await;
        let ms = started.elapsed().as_millis();
        return match result {
            Ok(response) => ProbeResult {
                ok: Some(response.status().as_u16() < 400),
                ms,
                detail: format!("HTTP {}", response.status().as_u16()),
            },
            Err(e) => ProbeResult {
                ok: Some(false),
                ms,
                detail: error_detail(&anyhow::Error::new(e)),
            },
        };
    }

    // `probe_client`, not `client`: every probe carries its own PROBE_TIMEOUT, matching the
    // per-request `timeout=_TIMEOUT` the Python passes on each of these calls.
    let recorded =
        match probe {
            Probe::Get(url) => UPSTREAMS.cache.get(&UPSTREAMS.probe_client, url).await,
            Probe::Rpc(url) => UPSTREAMS
                .cache
                .post_json(
                    &UPSTREAMS.probe_client,
                    url,
                    &json!({"jsonrpc": "2.0", "id": 1, "method": "eth_blockNumber", "params": []}),
                )
                .await,
            Probe::Post(url, body) => {
                let body = read_json(body);
                UPSTREAMS
                    .cache
                    .post_json(&UPSTREAMS.probe_client, url, &body)
                    .await
            }
            Probe::Telegram => unreachable!("handled above"),
        };

    let ms = started.elapsed().as_millis();
    match recorded {
        Ok(recorded) => {
            let http_ok = recorded.status < 400;
            // An RPC that answers 200 with `{"error": …}` is down. Only the body says so.
            let ok = match probe {
                Probe::Rpc(_) => {
                    http_ok
                        && serde_json::from_str::<Value>(&recorded.body)
                            .ok()
                            .and_then(|body| {
                                body.get("result").and_then(Value::as_str).map(String::from)
                            })
                            .is_some()
                }
                _ => http_ok,
            };
            ProbeResult {
                ok: Some(ok),
                ms,
                detail: format!("HTTP {}", recorded.status),
            }
        }
        Err(e) => ProbeResult {
            ok: Some(false),
            ms,
            detail: error_detail(&e),
        },
    }
}

/// `{up, slow, down, total}` over the non-idle services — an unconfigured upstream is not a
/// failure and must not drag the total down.
fn summarize(services: &[Value]) -> Value {
    let count = |wanted: &str| services.iter().filter(|s| s["status"] == wanted).count();
    let idle = count("idle");
    json!({
        "up": count("up"),
        "slow": count("slow"),
        "down": count("down"),
        "total": services.len() - idle,
    })
}

/// The last completed sweep, with the epoch second it finished.
static SERVICES_CACHE: std::sync::Mutex<Option<(i64, Value)>> = std::sync::Mutex::new(None);

/// Runs every probe concurrently and assembles the board.
async fn sweep_services() -> Value {
    let specs = service_specs();

    // Probes run concurrently and finish out of order, so each carries its index home: the board
    // is rendered as a list and must not reshuffle between refreshes.
    let mut set = tokio::task::JoinSet::new();
    for (index, spec) in specs.iter().enumerate() {
        let (name, category, powers, probe) = (spec.name, spec.category, spec.powers, spec.probe);
        set.spawn(async move {
            let result = run_probe(probe).await;
            (
                index,
                json!({
                    "name": name,
                    "category": category,
                    "powers": powers,
                    "status": classify(result.ok, result.ms),
                    "ms": result.ms,
                    "detail": result.detail,
                }),
            )
        });
    }

    let mut slots: Vec<Option<Value>> = vec![None; specs.len()];
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((index, value)) => slots[index] = Some(value),
            // A panicking probe must not take the board down; it is reported as down.
            Err(e) => tracing::error!(error = %e, "service probe panicked"),
        }
    }

    let services: Vec<Value> = specs
        .iter()
        .zip(slots)
        .map(|(spec, slot)| {
            slot.unwrap_or_else(|| {
                json!({
                    "name": spec.name,
                    "category": spec.category,
                    "powers": spec.powers,
                    "status": "down",
                    "ms": 0,
                    "detail": "probe failed",
                })
            })
        })
        .collect();

    let summary = summarize(&services);
    json!({
        "services": services,
        "summary": summary,
        "checked_at": now_secs(),
    })
}

#[derive(Debug, Deserialize)]
pub struct ServicesQuery {
    pub force: Option<String>,
}

/// `GET /api/wealth/services?force=1` — health board for every third-party upstream.
///
/// Cached for 30 seconds, because the panel polls and nine live probes per poll would be its own
/// small denial of service against the upstreams it is checking.
///
/// **A cached board is not silently presented as fresh.** `checked_at` is the epoch second the
/// sweep actually ran, not the second the request was served, so a client can always see the age
/// of what it is looking at — and `?force=1` bypasses the cache entirely. That distinction is the
/// whole safety property here: a stale "everything is up" that cannot be told from a live one is
/// worse than no status board at all.
pub async fn services(_user: AuthUser, Query(params): Query<ServicesQuery>) -> Response {
    if !flag(params.force.as_ref()) {
        // Copied out and the lock dropped before any await — a std Mutex must never be held
        // across one.
        let cached = SERVICES_CACHE
            .lock()
            .ok()
            .and_then(|guard| guard.clone())
            .filter(|(ts, _)| now_secs() - ts < SERVICES_TTL_SECS);
        if let Some((_, board)) = cached {
            return Json(board).into_response();
        }
    }

    let board = sweep_services().await;
    if let Ok(mut guard) = SERVICES_CACHE.lock() {
        *guard = Some((now_secs(), board.clone()));
    }
    Json(board).into_response()
}

/* ─── Alerts — awaiting a `lyra-alerts` dependency ─── */

/// Wallets the **alert sweep** watches: EVM only.
///
/// The `0x…` filter is the port of `notify._wallets` and is correct *here* — every alert this
/// loop raises is about an EVM position (LP range, lending health factor), so a Bitcoin address
/// would add nothing to watch.
///
/// It is **not** correct for anything that values the book. This function used to feed the
/// net-worth snapshot too, which silently dropped every non-EVM address before it was counted —
/// a `bc1…` wallet contributed to the portfolio page and not to the recorded series. Use
/// [`counted_wallets`] for anything that adds up money.
pub(crate) fn watched_wallets() -> Vec<String> {
    std::env::var("ALERT_WALLETS")
        .unwrap_or_default()
        .replace(',', " ")
        .split_whitespace()
        .filter(|a| a.starts_with("0x"))
        .map(str::to_string)
        .collect()
}

/// Every wallet whose value counts, of any chain — the stored list, else the environment.
///
/// The counterpart to [`watched_wallets`]: alerting is EVM-only by nature, valuation is not.
pub(crate) async fn counted_wallets(pool: &sqlx::SqlitePool) -> Vec<String> {
    parse_addresses(&configured_wallets(pool).await, MAX_WALLETS).unwrap_or_default()
}

/// Whether Telegram delivery is possible — `notify.can_send`.
///
/// Reads only whether the two variables are non-empty. Their values are never returned, logged or
/// compared against anything the caller supplied.
fn telegram_ready() -> bool {
    let set = |key: &str| {
        std::env::var(key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    };
    set("TELEGRAM_BOT_TOKEN") && set("TELEGRAM_CHAT_ID")
}

/// The knobs, resolved from saved overrides plus the environment.
///
/// Split out of [`alert_status`] because `AlertConfig` borrows a `&dyn EnvSource`, which carries no
/// `Send` bound. Holding one across an `.await` makes the whole future non-`Send`, and axum will
/// not accept a handler whose future is not `Send` — so every database await happens outside this
/// function and the borrow never spans one.
fn resolved_config(overrides: &lyra_alerts::config::Overrides) -> anyhow::Result<Value> {
    let env = ProcessEnv;
    let cfg = AlertConfig::new(overrides, &env);

    let wallets = watched_wallets();
    let can_send = telegram_ready();
    let digest_hour = cfg.digest_hour();

    Ok(json!({
        "configured": can_send && !wallets.is_empty(),
        "can_send": can_send,
        "wallets": wallets.len(),
        "interval": cfg.interval()?,
        "fee_threshold": cfg.fee_threshold(),
        "report_ccy": cfg.report_ccy(),
        "hf_alert": cfg.hf_threshold(),
        // `digest_enabled` mirrors notify.digest_enabled(): deliverable, an hour set, and
        // something to report — watched wallets or a connected exchange.
        "digest_enabled": can_send
            && digest_hour.is_some()
            && (!wallets.is_empty() || kucoin::configured()),
        "digest_hour": digest_hour,
    }))
}

/// Builds the `notify.status()` body.
async fn alert_status(
    pool: &sqlx::SqlitePool,
    meta: &alert_loop::SharedMeta,
) -> anyhow::Result<Value> {
    let store = AlertStore::new(pool);
    // Both awaits complete before any non-`Send` borrow exists — see [`resolved_config`].
    let overrides = store.load_config().await?;
    let digest_last = store.digest_day().await?;

    let mut status = resolved_config(&overrides)?;

    // The Python's four live-poller fields, read from the in-process sweep. They are inert
    // (`running: false`, the rest null) when the loop was never started — no wallets, no digest
    // hour, no KuCoin key — which is the honest answer rather than a fabricated timestamp.
    let live = alert_loop::snapshot(meta);
    let extra = json!({
        "digest_last": digest_last,
        "overrides": overrides.as_json(),
        "last_check": live.last_check,
        "watching": live.watching,
        "last_error": live.last_error,
        "running": live.running,
    });

    // Merge rather than rebuild, so the key set lives in exactly two places and neither can
    // silently drop one.
    if let (Some(status), Some(extra)) = (status.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            status.insert(key.clone(), value.clone());
        }
    }
    Ok(status)
}

/// `GET /api/wealth/alerts` — alert configuration and poller state.
pub async fn alerts(State(state): State<AppState>, _user: AuthUser) -> Response {
    match alert_status(&state.pool, &state.alert_meta).await {
        Ok(status) => Json(status).into_response(),
        Err(e) => {
            // A malformed `ALERT_INTERVAL` lands here, as it does in the Python, where `int()`
            // raises outside the try block. A schedule nobody chose is worse than a loud failure.
            tracing::error!(error = %e, "reading alert status");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// The Python's exact wording for an unconfigured bot, kept so the settings page's error text
/// does not change across the migration.
const TELEGRAM_UNSET: &str = "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set";

/// `GET /api/wealth/alerts/test` — send a test ping.
///
/// `400` when the bot is not configured, `{"ok": true}` on delivery and `{"ok": false}` with a
/// **502** when Telegram refused — the status distinguishes "you have not set this up" from "it
/// is set up and the upstream said no", which are different things to do about it.
pub async fn alerts_test(_user: AuthUser) -> Response {
    let sender = TelegramSender::from_env(&ProcessEnv);
    if !sender.can_send() {
        return error(StatusCode::BAD_REQUEST, TELEGRAM_UNSET);
    }

    let delivery = sender.send_test().await;
    let status = if delivery.is_sent() {
        StatusCode::OK
    } else {
        StatusCode::BAD_GATEWAY
    };
    (status, Json(json!({ "ok": delivery.as_bool() }))).into_response()
}

/// Where the previous brief's figures live, so the next one can show "since last" deltas.
///
/// The Python keeps these in a temp JSON file (`REPORT_SNAPSHOT_FILE`), which a container restart
/// silently empties — the deltas then measure from nothing and the brief quietly stops showing
/// them. `alert_state` is a table in the same database as everything else, so it survives.
const DIGEST_SNAPSHOT_KEY: &str = "digest_snapshot";

/// `DigestSnapshot` has no `serde` derives — it is a plain figures struct — so the two directions
/// are written out here. Three optional numbers; absent and null both mean "no previous value",
/// which is what suppresses a delta rather than rendering a spurious one.
fn digest_snapshot_json(snapshot: &DigestSnapshot) -> Value {
    json!({
        "total": snapshot.total,
        "claimable": snapshot.claimable,
        "btc_sats": snapshot.btc_sats,
    })
}

fn digest_snapshot_from(value: &Value) -> DigestSnapshot {
    let number = |key: &str| value.get(key).and_then(Value::as_f64);
    DigestSnapshot {
        total: number("total"),
        claimable: number("claimable"),
        btc_sats: number("btc_sats"),
    }
}

/// `GET /api/wealth/alerts/digest` — build and send the daily brief now.
///
/// The wallets come from `ALERT_WALLETS`, not from a query parameter: this is the scheduled
/// brief's own book, and letting a caller pass an address would send someone a report about a
/// wallet they do not watch.
///
/// On a successful send the snapshot rolls forward, so the next brief's deltas measure from this
/// moment. On a failed send it does **not** — `render_digest` is pure for exactly this reason, and
/// advancing on failure would consume a delta nobody ever saw.
pub async fn alerts_digest(State(state): State<AppState>, _user: AuthUser) -> Response {
    let sender = TelegramSender::from_env(&ProcessEnv);
    if !sender.can_send() {
        return error(StatusCode::BAD_REQUEST, TELEGRAM_UNSET);
    }
    if watched_wallets().is_empty() {
        return error(
            StatusCode::BAD_REQUEST,
            "ALERT_WALLETS is not set, so there is no book to report on",
        );
    }

    match deliver_digest(&state, &sender).await {
        Ok(DigestOutcome::Sent) => Json(json!({ "ok": true })).into_response(),
        Ok(DigestOutcome::Refused) => {
            (StatusCode::BAD_GATEWAY, Json(json!({ "ok": false }))).into_response()
        }
        // Worth distinguishing from a send failure: a partial read that came back with nothing
        // must not be reported as a delivered brief.
        Ok(DigestOutcome::Nothing(reason)) => {
            Json(json!({ "ok": false, "reason": reason })).into_response()
        }
        Err(e) => {
            tracing::error!(error = %e, "building the digest");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/// What one attempt at the daily brief came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DigestOutcome {
    Sent,
    /// Telegram was reachable and refused.
    Refused,
    /// There was nothing worth sending — not a failure.
    Nothing(&'static str),
}

/// Build and send the daily brief.
///
/// Shared by the on-demand endpoint and the scheduled sweep, so the two cannot drift: a brief you
/// preview by hand is the same brief the box sends at 08:00. The caller owns the *decision* to
/// send (an hour check, or a button); this owns everything after it.
pub(crate) async fn deliver_digest(
    state: &AppState,
    sender: &TelegramSender,
) -> anyhow::Result<DigestOutcome> {
    let addresses = watched_wallets();
    if addresses.is_empty() {
        return Ok(DigestOutcome::Nothing("no watched wallets"));
    }

    let snapshot = build_portfolios(Arc::clone(&UPSTREAMS.sources), &addresses, &AGGREGATE).await;
    log_health("alerts/digest", &snapshot.health);
    let input = collect::collect(&snapshot.portfolio);

    // The Python's `if s["total"] <= 0: return False`.
    if input.total <= 0.0 {
        return Ok(DigestOutcome::Nothing(
            "nothing to report — the portfolio read returned no value",
        ));
    }

    let store = AlertStore::new(&state.pool);
    let overrides = store.load_config().await?;
    let config = AlertConfig::new(&overrides, &ProcessEnv);

    // Everything is collected in USD; only the display converts. `Money::new` demotes to USD by
    // itself when the rate is missing, so a dead FX provider costs the currency, not the brief.
    let money = Money::new(&config.report_ccy(), snapshot.portfolio.rates.thb);

    let previous = store
        .get_json(DIGEST_SNAPSHOT_KEY)
        .await
        .unwrap_or_default()
        .as_ref()
        .map(digest_snapshot_from)
        .unwrap_or_default();

    let now = chrono::Local::now();
    let Some(text) = render_digest(
        &input,
        &previous,
        &money,
        &header_date(&now),
        config.fee_threshold(),
    ) else {
        return Ok(DigestOutcome::Nothing("the brief rendered empty"));
    };

    if !sender.send(&text).await.is_sent() {
        return Ok(DigestOutcome::Refused);
    }

    // Only now. A brief nobody received must not consume the deltas it would have shown.
    if let Err(e) = store
        .put_json(
            DIGEST_SNAPSHOT_KEY,
            &digest_snapshot_json(&DigestSnapshot::of(&input)),
            now_secs(),
        )
        .await
    {
        // The brief was delivered, so this succeeded. The cost is one repeated delta next time,
        // which is worth a log and not an error.
        tracing::error!(error = %e, "digest sent but its snapshot could not be saved");
    }
    Ok(DigestOutcome::Sent)
}

/// One watched wallet for the sweep.
///
/// `build_wallet` cannot fail — an unreachable chain shows up in [`FetchHealth`] rather than as an
/// error — so the sweep never loses a wallet outright. What it can lose is a *chain*, and the
/// count is returned so the caller can say so: a range alert derived from a wallet that is missing
/// a chain is still worth sending (the positions it did read are real), but the operator should
/// know the sweep was not complete.
pub(crate) async fn build_watched_wallet(
    pool: &sqlx::SqlitePool,
    address: &str,
) -> (lyra_chain::model::Wallet, usize) {
    let outcome = build_wallet(Arc::clone(&UPSTREAMS.sources), address, &AGGREGATE).await;
    log_health("alerts/sweep", &outcome.health);
    let missing = outcome.health.failures.len() + outcome.health.abandoned.len();

    // The join matters to the sweep, not just to the wire. Python performs it *inside*
    // `_vfat_stamp_lifecycle`, so `check_once` sees the stored `cycle_start` — and the sweep only
    // samples a position that has one. Without this, a position whose `sickle-nft-actions` call
    // happened to fail on this tick would drop out of sampling entirely and its accumulator would
    // silently stall, even though the cycle it belongs to is known.
    let mut wallet = outcome.wallet;
    join_perf(pool, std::slice::from_mut(&mut wallet)).await;
    (wallet, missing)
}

/// The digest figures for the snapshot recorder — `notify.py`'s `_collect()`.
///
/// **Refuses to return a partial read.** `FetchHealth::is_complete` is the gate its own docs ask
/// for: a snapshot is written to the net-worth series, and a partial total stored there is
/// indistinguishable from a real drawdown forever after — it would skew change-over-time, per-tier
/// P&L and every alert derived from them. A gap in the series is recoverable; a false point is
/// not. The Python has no such check because it cannot tell the two apart.
///
/// `None` also when the read came back empty, for the same reason.
pub(crate) async fn collect_figures(
    pool: &sqlx::SqlitePool,
) -> Option<(lyra_alerts::digest::DigestInput, lyra_chain::market::Rates)> {
    let addresses = counted_wallets(pool).await;
    let snapshot = build_portfolios(Arc::clone(&UPSTREAMS.sources), &addresses, &AGGREGATE).await;
    log_health("alerts/snapshot", &snapshot.health);

    if !snapshot.health.is_complete() {
        tracing::warn!(
            coverage = snapshot.health.coverage(),
            "skipping the net-worth snapshot: the read was partial and storing it would record a false drawdown"
        );
        return None;
    }

    let rates = snapshot.portfolio.rates.clone();
    let input = collect::collect(&snapshot.portfolio);
    (input.total > 0.0).then_some((input, rates))
}

/// `POST /api/wealth/alerts/config` — save the poller knobs, answering with the new status.
///
/// A key set to `null` is **removed**, reverting it to its env default — distinct from `0`, which
/// means "off". `Overrides::merge_patch` owns that distinction, so the patch goes through it
/// rather than through anything that treats null as absent.
///
/// The running poller re-reads `alert_state` each sweep, so a save takes effect on the next cycle
/// without a restart. That is why there is no equivalent of the Python's `notify.start()` re-arm
/// here: there is no in-process loop to re-arm.
pub async fn alerts_config(
    State(state): State<AppState>,
    _user: AuthUser,
    body: String,
) -> Response {
    let patch = read_json(&body);
    let store = AlertStore::new(&state.pool);

    let mut overrides = match store.load_config().await {
        Ok(overrides) => overrides,
        Err(e) => {
            tracing::error!(error = %e, "loading alert config");
            return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
        }
    };

    // A value that cannot be coerced (`interval: "abc"`) is the caller's mistake, so it is a 400
    // naming the field rather than a silently persisted nonsense schedule.
    if let Err(e) = overrides.merge_patch(&patch) {
        return error(StatusCode::BAD_REQUEST, &e.to_string());
    }

    if let Err(e) = store.save_config(&overrides, now_secs()).await {
        tracing::error!(error = %e, "saving alert config");
        return error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
    }

    match alert_status(&state.pool, &state.alert_meta).await {
        Ok(status) => Json(status).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "reading alert status after save");
            error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
        }
    }
}

/* ─── Answers for the Telegram command bot ─── */

/// Money, for a chat message. Plain text — no Markdown, because a position name is untrusted
/// on-chain data and one stray asterisk would corrupt the whole reply.
fn chat_usd(value: f64) -> String {
    if value.abs() >= 1000.0 {
        format!("${:.0}", value)
    } else {
        format!("${value:.2}")
    }
}

/// A position or token label, made safe to drop into a chat message.
///
/// On-chain names are attacker-controlled. Newlines would let one forge extra lines in the reply,
/// so they collapse, and the whole thing is capped.
fn chat_label(raw: &str) -> String {
    raw.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .chars()
        .take(48)
        .collect()
}

/// The sweep's own state, as `/status` reports it.
pub(crate) async fn bot_status_line(state: &AppState) -> String {
    match alert_status(&state.pool, &state.alert_meta).await {
        Ok(status) => {
            let running = status["running"].as_bool().unwrap_or(false);
            let watching = status["watching"].as_i64();
            let last = status["last_check"].as_f64();
            let mut out = String::from("Status\n");
            out.push_str(&format!(
                "sweep: {}\n",
                if running { "running" } else { "not running" }
            ));
            out.push_str(&format!(
                "interval: {}s\n",
                status["interval"].as_i64().unwrap_or(0)
            ));
            match watching {
                Some(n) => out.push_str(&format!("watching: {n} positions\n")),
                None => out.push_str("watching: nothing swept yet\n"),
            }
            if last.is_none() {
                out.push_str("last check: never\n");
            }
            if let Some(error) = status["last_error"].as_str() {
                out.push_str(&format!("last error: {}\n", chat_label(error)));
            }
            out
        }
        Err(e) => {
            tracing::error!(error = %e, "telegram /status");
            "Could not read the sweep state.".into()
        }
    }
}

/// `/market` — the same models Radar draws, as a list.
pub(crate) async fn bot_market_line() -> String {
    let sentiment = UPSTREAMS.sources.market().market_sentiment().await;
    let sentiment = serde_json::to_value(&sentiment).unwrap_or_default();
    if !sentiment.as_object().is_some_and(|o| !o.is_empty()) {
        return "The valuation & mood models did not answer — they are keyless reads of public \
                sources, so this is usually an upstream being down."
            .into();
    }
    let mut out = String::from("Market\n");
    let row = |out: &mut String, title: &str, value: String, label: Option<&str>| {
        out.push_str(&format!("{title}: {value}"));
        if let Some(label) = label {
            out.push_str(&format!(" · {}", chat_label(label)));
        }
        out.push('\n');
    };
    if let Some(fng) = sentiment.get("fear_greed") {
        row(
            &mut out,
            "fear & greed",
            fng["value"].to_string(),
            fng["classification"].as_str(),
        );
    }
    for (key, title) in [
        ("mvrv_zscore", "mvrv z-score"),
        ("sopr", "sopr"),
        ("puell", "puell"),
    ] {
        if let Some(model) = sentiment.get(key) {
            row(&mut out, title, model["value"].to_string(), model["label"].as_str());
        }
    }
    if let Some(rainbow) = sentiment.get("btc_rainbow") {
        row(
            &mut out,
            "btc rainbow",
            format!("{}x", rainbow["ratio"]),
            rainbow["label"].as_str(),
        );
    }
    out.push_str("\nnot advice");
    out
}

/// Every command that needs a live read of the book. `None` for an unknown command.
///
/// One portfolio read serves whichever was asked for: the read is the expensive part (a cold
/// multi-chain fan-out can take over a minute), so the commands differ only in what they say
/// about it.
pub(crate) async fn bot_book_line(state: &AppState, command: &str) -> Option<String> {
    if !matches!(
        command,
        "nw" | "networth" | "tiers" | "positions" | "pos" | "rewards" | "risk" | "sats" | "bots"
            | "digest"
    ) {
        return None;
    }

    let Some((figures, rates)) = collect_figures(&state.pool).await else {
        return Some(
            "The portfolio read came back empty or partial — nothing worth quoting. Try again in \
             a minute."
                .into(),
        );
    };
    let off_chain = store::manual_total_usd(&state.pool, rates.thb, rates.btc_usd)
        .await
        .unwrap_or((0.0, 0));

    Some(match command {
        "nw" | "networth" => {
            let net = figures.total + off_chain.0 - figures.debt;
            let mut out = format!("Net worth: {}\n", chat_usd(net));
            out.push_str(&format!("on chain: {}\n", chat_usd(figures.total)));
            if off_chain.1 > 0 {
                out.push_str(&format!(
                    "off chain: {} across {}\n",
                    chat_usd(off_chain.0),
                    off_chain.1
                ));
            }
            if figures.debt > 0.0 {
                out.push_str(&format!("debt: {}\n", chat_usd(figures.debt)));
            }
            out.push_str(&format!("24h: {}\n", chat_usd(figures.contrib)));
            out
        }
        "tiers" => {
            let t = &figures.tiers;
            let gross = t.store + t.business + t.trading;
            let pct = |v: f64| if gross > 0.0 { v / gross * 100.0 } else { 0.0 };
            format!(
                "Tiers\nstore: {} ({:.0}%)\nbusiness: {} ({:.0}%)\ntrading: {} ({:.0}%)\n",
                chat_usd(t.store),
                pct(t.store),
                chat_usd(t.business),
                pct(t.business),
                chat_usd(t.trading),
                pct(t.trading),
            )
        }
        "positions" | "pos" => {
            if figures.pools.is_empty() {
                return Some("No liquidity positions.".into());
            }
            let mut out = String::from("Positions\n");
            for pool in &figures.pools {
                let state = match pool.in_range {
                    Some(true) => "in range",
                    Some(false) => "OUT OF RANGE",
                    None => "no range",
                };
                out.push_str(&format!(
                    "{} · {} · {} · {}\n",
                    chat_label(&pool.name),
                    chat_label(&pool.protocol),
                    chat_usd(pool.usd),
                    state
                ));
            }
            out
        }
        "rewards" => format!(
            "Claimable: {}\nacross {} position(s)\n",
            chat_usd(figures.claimable),
            figures.pools.iter().filter(|p| p.fees > 0.0).count()
        ),
        "risk" => match figures.hf_min {
            Some(hf) => format!(
                "Borrow health\nlowest health factor: {hf:.2}\ndebt: {}\ncollateral: {}\n",
                chat_usd(figures.debt),
                chat_usd(figures.collateral)
            ),
            None => "No borrow positions — nothing to liquidate.".into(),
        },
        "sats" => match figures.btc_sats {
            Some(sats) => format!(
                "Bitcoin\n{sats:.0} sats\n{}\n",
                chat_usd(figures.btc_usd)
            ),
            None => format!("Bitcoin reserves: {}\n", chat_usd(figures.btc_usd)),
        },
        "bots" => {
            if !lyra_chain::kucoin::configured() {
                return Some("No exchange key configured, so there are no bots to report.".into());
            }
            format!("Bot equity is included in the book: {}", chat_usd(figures.total))
        }
        // The same brief the daily digest sends, on demand. `render_digest` returns `None` for
        // an empty book, which `collect_figures` has already ruled out — but saying so beats an
        // unwrap that would take the bot down on the one day the book is empty.
        _ => render_digest(
            &figures,
            &DigestSnapshot::default(),
            &Money::usd(),
            &header_date(&chrono::Utc::now()),
            None,
        )
        .unwrap_or_else(|| "Nothing to brief on — the book reads empty.".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::{delete, get, post, put};
    use http_body_util::BodyExt;
    use sqlx::SqlitePool;
    use tempfile::TempDir;
    use tower::ServiceExt;

    /// The mount this module expects, mirrored here so the tests exercise the real auth gate.
    /// Keep in step with whatever `main.rs` ends up mounting.
    fn router(state: AppState) -> Router {
        Router::new()
            .route("/api/wealth/portfolio", get(portfolio))
            .route("/api/wealth/wallet", get(wallet))
            .route("/api/wealth/fund", get(fund))
            .route("/api/wealth/sentiment", get(sentiment))
            .route("/api/wealth/yield-radar", get(yield_radar))
            .route("/api/wealth/kucoin", get(kucoin))
            .route("/api/wealth/price-history", get(price_history))
            .route("/api/wealth/history", get(history).post(save_history))
            .route("/api/wealth/snapshots", get(snapshots))
            .route("/api/wealth/analyses", get(analyses).post(create_analysis))
            .route("/api/wealth/analyses/{id}", get(analysis))
            .route(
                "/api/wealth/manual-assets",
                get(manual_assets).post(create_manual_asset),
            )
            .route(
                "/api/wealth/manual-assets/{id}",
                put(update_manual_asset).delete(delete_manual_asset),
            )
            .route("/api/wealth/wallets", get(wallets).post(create_wallet))
            .route("/api/wealth/wallets/{id}", delete(delete_wallet))
            .route("/api/wealth/notes", post(create_note))
            .route("/api/wealth/notes/archive", post(archive_note))
            .route("/api/wealth/services", get(services))
            .route("/api/wealth/alerts", get(alerts))
            .route("/api/wealth/alerts/test", get(alerts_test))
            .route("/api/wealth/alerts/digest", get(alerts_digest))
            .route("/api/wealth/alerts/config", post(alerts_config))
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                crate::auth::require_auth,
            ))
            .with_state(state)
    }

    async fn test_app() -> (TempDir, SqlitePool, Router, String) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        let state = AppState::new(pool.clone(), "test-secret".into());
        let token = crate::auth::issue_token("test-secret", "user-jb", "admin").unwrap();
        (dir, pool, router(state), token)
    }

    /// A well-formed EVM address, for the tests that need to get *past* `parse_addresses` to
    /// reach a limit check. Never used where the request would go on to fan out.
    const EVM_ADDRESS: &str = "0x1234567890abcdef1234567890abcdef12345678";

    /// Routes that answer from the database, the environment or a fixed body — everything a test
    /// can drive without reaching the network. Used by the credential sweep.
    const LOCAL_ROUTES: &[(&str, &str, &str)] = &[
        // These three do fan out to chains — but `0xabc` is not a valid address, so they answer
        // 400 from `parse_addresses` before any upstream is touched. That is what keeps them
        // local, so do not "fix" the address here: a real one would put every `cargo test` on
        // the network. Their live behaviour belongs to the parity harness.
        ("GET", "/api/wealth/portfolio?address=0xabc", ""),
        ("GET", "/api/wealth/wallet?address=0xabc", ""),
        ("GET", "/api/wealth/yield-radar?address=0xabc", ""),
        ("GET", "/api/wealth/history?group=main", ""),
        ("POST", "/api/wealth/history", r#"{"group":"main"}"#),
        ("GET", "/api/wealth/snapshots?group=server", ""),
        ("GET", "/api/wealth/analyses", ""),
        ("GET", "/api/wealth/analyses/does-not-exist", ""),
        (
            "POST",
            "/api/wealth/analyses",
            r#"{"scope":"strategy:main","kind":"general","title":"t","body_md":"b"}"#,
        ),
        ("GET", "/api/wealth/wallets", ""),
        (
            "POST",
            "/api/wealth/wallets",
            r#"{"address":"bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}"#,
        ),
        ("DELETE", "/api/wealth/wallets/does-not-exist", ""),
        ("GET", "/api/wealth/manual-assets", ""),
        (
            "POST",
            "/api/wealth/manual-assets",
            r#"{"name":"Cold BTC","tier":"store"}"#,
        ),
        (
            "PUT",
            "/api/wealth/manual-assets/does-not-exist",
            r#"{"name":"Cold BTC","tier":"store"}"#,
        ),
        ("DELETE", "/api/wealth/manual-assets/does-not-exist", ""),
        (
            "POST",
            "/api/wealth/notes",
            r#"{"kind":"general","title":"t","body_md":"b"}"#,
        ),
        (
            "POST",
            "/api/wealth/notes/archive",
            r#"{"scope":"strategy:main"}"#,
        ),
        ("GET", "/api/wealth/alerts", ""),
        ("POST", "/api/wealth/alerts/config", r#"{"interval":900}"#),
    ];

    /// Routes that call an upstream once authenticated. They appear in the auth sweep — where the
    /// gate rejects the request before the handler runs, so nothing is fetched — but not in the
    /// credential sweep, which would otherwise make every `cargo test` hit DefiLlama, WealthMagik
    /// and KuCoin. Their live behaviour is the parity harness's job (`lyra-parity`), which drives
    /// them against recorded fixtures.
    const NETWORK_ROUTES: &[(&str, &str, &str)] = &[
        ("GET", "/api/wealth/fund?code=K-GOLD-A(D)", ""),
        ("GET", "/api/wealth/sentiment", ""),
        ("GET", "/api/wealth/kucoin", ""),
        (
            "GET",
            "/api/wealth/price-history?coin=coingecko:bitcoin",
            "",
        ),
        // The health board probes nine upstreams; its pure parts are tested directly below.
        ("GET", "/api/wealth/services", ""),
        // These two read the *process* environment for their bot token, so on a machine that has
        // one configured they send a real Telegram message — and the digest fans out over every
        // watched wallet first. Neither may appear in a sweep that actually calls it.
        ("GET", "/api/wealth/alerts/test", ""),
        ("GET", "/api/wealth/alerts/digest", ""),
    ];

    fn request(method: &str, path: &str, token: Option<&str>, body: &str) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(path);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        if method == "POST" {
            builder = builder.header("content-type", "application/json");
        }
        builder.body(Body::from(body.to_string())).unwrap()
    }

    async fn call(
        router: &Router,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: &str,
    ) -> (StatusCode, Value) {
        let response = router
            .clone()
            .oneshot(request(method, path, token, body))
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn get_json(router: &Router, path: &str, token: &str) -> (StatusCode, Value) {
        call(router, "GET", path, Some(token), "").await
    }

    async fn post_json(
        router: &Router,
        path: &str,
        token: &str,
        body: &str,
    ) -> (StatusCode, Value) {
        call(router, "POST", path, Some(token), body).await
    }

    /* ─── Auth ─── */

    #[tokio::test]
    async fn every_route_is_401_without_a_token() {
        let (_dir, _pool, router, _token) = test_app().await;
        for (method, path, body) in LOCAL_ROUTES.iter().chain(NETWORK_ROUTES) {
            let (status, value) = call(&router, method, path, None, body).await;
            assert_eq!(
                status,
                StatusCode::UNAUTHORIZED,
                "{method} {path} should require auth"
            );
            assert_eq!(value, json!({"error": "Unauthorized"}), "{method} {path}");
        }
    }

    #[tokio::test]
    async fn a_token_signed_with_another_secret_is_rejected() {
        let (_dir, _pool, router, _token) = test_app().await;
        let forged = crate::auth::issue_token("not-the-secret", "user-jb", "admin").unwrap();
        let (status, _) = get_json(&router, "/api/wealth/history", &forged).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    /* ─── History ─── */

    #[tokio::test]
    async fn history_round_trips_and_echoes_the_requested_group() {
        let (_dir, _pool, router, token) = test_app().await;

        let (status, body) = post_json(
            &router,
            "/api/wealth/history",
            &token,
            r#"{"group":"Main Group","points":[{"d":1,"v":10.5},{"d":2,"v":11.0,"debt":2.0,
                "tiers":{"store":5.0,"trading":6.0}}]}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        // The raw group is echoed, even though it is stored under its sanitised form.
        assert_eq!(body["group"], "Main Group");
        assert_eq!(body["points"].as_array().unwrap().len(), 2);

        let (status, body) =
            get_json(&router, "/api/wealth/history?group=Main%20Group", &token).await;
        assert_eq!(status, StatusCode::OK);
        let points = body["points"].as_array().unwrap();
        assert_eq!(points[0], json!({"d": 1, "v": 10.5}));
        assert_eq!(points[1]["debt"], 2.0);
        assert_eq!(points[1]["tiers"]["store"], 5.0);
    }

    #[tokio::test]
    async fn a_point_without_tiers_or_debt_omits_those_keys_entirely() {
        let (_dir, _pool, router, token) = test_app().await;
        post_json(
            &router,
            "/api/wealth/history",
            &token,
            r#"{"group":"g","points":[{"d":1,"v":1.0}]}"#,
        )
        .await;

        let (_, body) = get_json(&router, "/api/wealth/history?group=g", &token).await;
        let point = body["points"][0].as_object().unwrap();
        assert!(!point.contains_key("tiers"), "null tiers must not be sent");
        assert!(!point.contains_key("debt"), "null debt must not be sent");
    }

    /// A *write* is not defaulted the way a read is: it must say where it goes. An unreadable
    /// body writes nothing, so the group it reports is cosmetic.
    #[tokio::test]
    async fn an_unreadable_history_body_is_treated_as_empty_rather_than_rejected() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) =
            post_json(&router, "/api/wealth/history", &token, "not json at all").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"group": "", "points": []}));
    }

    #[tokio::test]
    async fn a_read_with_no_group_means_this_boxs_own_series() {
        // These two used to disagree: `/snapshots` defaulted to the sweep's group while
        // `/history` defaulted to the group literally named "", which nothing ever writes. The
        // net-worth chart asks for neither by name, so it read the empty one and stayed blank
        // however much history the database held.
        let (_dir, _pool, router, token) = test_app().await;

        let (_, body) = get_json(&router, "/api/wealth/history", &token).await;
        assert_eq!(body["group"], "server");

        let (_, body) = get_json(&router, "/api/wealth/snapshots", &token).await;
        assert_eq!(body["group"], "server");
    }

    #[tokio::test]
    async fn an_explicit_group_still_wins_on_a_history_read() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, body) = get_json(&router, "/api/wealth/history?group=me", &token).await;
        assert_eq!(body["group"], "me");
    }

    /* ─── Snapshots ─── */

    #[tokio::test]
    async fn snapshots_returns_every_key_including_the_null_ones() {
        let (_dir, pool, router, token) = test_app().await;
        store::record_snapshot(
            &pool,
            "server",
            &store::SnapshotInput {
                net_worth: 1234.5,
                assets: Some(1500.0),
                ..Default::default()
            },
            0,
            None,
        )
        .await
        .unwrap();

        let (status, body) = get_json(&router, "/api/wealth/snapshots?group=server", &token).await;
        assert_eq!(status, StatusCode::OK);
        let point = body["points"][0].as_object().unwrap();
        assert_eq!(point["v"], 1234.5);
        assert_eq!(point["assets"], 1500.0);
        for key in ["ts", "v", "assets", "debt", "btc_usd", "btc_sats"] {
            assert!(point.contains_key(key), "snapshot must always carry {key}");
        }
        assert_eq!(point["debt"], Value::Null);
    }

    /* ─── Journal ─── */

    #[tokio::test]
    async fn creating_an_analysis_returns_201_and_the_full_record() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = post_json(
            &router,
            "/api/wealth/analyses",
            &token,
            r##"{"scope":"strategy:main","kind":"strategy_review","title":"Q3",
                "summary":"s","body_md":"# body","structured":{"a":1},"author":"claude"}"##,
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        for key in [
            "id",
            "scope",
            "version",
            "kind",
            "title",
            "summary",
            "body_md",
            "structured",
            "author",
            "source",
            "created_at",
            "net_worth_usd",
            "superseded_by",
            "archived_at",
            "anchor",
        ] {
            assert!(body.as_object().unwrap().contains_key(key), "missing {key}");
        }
        assert_eq!(body["source"], "http");
        assert_eq!(body["version"], 1);
        assert_eq!(body["structured"]["a"], 1);
        // Unanchored until the chain layer is reachable — null, not absent.
        assert_eq!(body["anchor"], Value::Null);
        assert_eq!(body["net_worth_usd"], Value::Null);
    }

    #[tokio::test]
    async fn a_bad_scope_is_422_with_the_journals_own_message() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = post_json(
            &router,
            "/api/wealth/analyses",
            &token,
            r#"{"scope":"nope","kind":"general","title":"t","body_md":"b"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(
            body["error"].as_str().unwrap().contains("scope must match"),
            "got {body}"
        );
    }

    #[tokio::test]
    async fn an_unknown_kind_is_rejected() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, _) = post_json(
            &router,
            "/api/wealth/analyses",
            &token,
            r#"{"scope":"strategy:main","kind":"freeform","title":"t","body_md":"b"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn listing_returns_the_latest_version_per_scope_and_history_returns_all() {
        let (_dir, _pool, router, token) = test_app().await;
        for body_md in ["first", "second"] {
            post_json(&router,
                "/api/wealth/analyses",
                &token,
                &format!(
                    r#"{{"scope":"strategy:main","kind":"general","title":"t","body_md":"{body_md}"}}"#
                ),
            )
            .await;
        }

        let (status, body) = get_json(&router, "/api/wealth/analyses", &token).await;
        assert_eq!(status, StatusCode::OK);
        let rows = body["analyses"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "latest-only by default");
        assert_eq!(rows[0]["version"], 2);

        let (_, body) = get_json(&router, "/api/wealth/analyses?history=1", &token).await;
        assert_eq!(body["analyses"].as_array().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn an_unparseable_limit_falls_back_to_the_default_page() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = get_json(&router, "/api/wealth/analyses?limit=lots", &token).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["analyses"].is_array());
    }

    #[tokio::test]
    async fn one_analysis_by_id_and_404_for_an_unknown_one() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, created) = post_json(
            &router,
            "/api/wealth/analyses",
            &token,
            r#"{"scope":"strategy:main","kind":"general","title":"t","body_md":"b"}"#,
        )
        .await;
        let id = created["id"].as_str().unwrap();

        let (status, body) = get_json(&router, &format!("/api/wealth/analyses/{id}"), &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["id"], id);

        let (status, body) = get_json(&router, "/api/wealth/analyses/nope", &token).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({"error": "not found"}));
    }

    /* ─── Notes ─── */

    #[tokio::test]
    async fn a_note_defaults_its_author_and_generates_a_scope() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = post_json(
            &router,
            "/api/wealth/notes",
            &token,
            r#"{"kind":"general","title":"Rebalance thoughts","body_md":"..."}"#,
        )
        .await;

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["source"], "user");
        assert_eq!(body["author"], "me");
        let scope = body["scope"].as_str().unwrap();
        assert!(scope.starts_with("note:rebalance-thoughts-"), "got {scope}");
    }

    #[tokio::test]
    async fn a_note_keeps_an_explicit_scope_and_author() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, body) = post_json(
            &router,
            "/api/wealth/notes",
            &token,
            r#"{"scope":"position:hyperevm:64176","kind":"position_note","title":"t",
                "body_md":"b","author":"jb"}"#,
        )
        .await;
        assert_eq!(body["scope"], "position:hyperevm:64176");
        assert_eq!(body["author"], "jb");
        assert_eq!(body["source"], "user");
    }

    #[tokio::test]
    async fn archiving_hides_a_thread_from_the_default_listing() {
        let (_dir, _pool, router, token) = test_app().await;
        post_json(
            &router,
            "/api/wealth/notes",
            &token,
            r#"{"scope":"note:x","kind":"general","title":"t","body_md":"b"}"#,
        )
        .await;

        let (status, body) = post_json(
            &router,
            "/api/wealth/notes/archive",
            &token,
            r#"{"scope":"note:x"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body, json!({"scope": "note:x", "updated": 1}));

        let (_, body) = get_json(&router, "/api/wealth/analyses", &token).await;
        assert!(body["analyses"].as_array().unwrap().is_empty());

        let (_, body) = get_json(&router, "/api/wealth/analyses?archived=1", &token).await;
        assert_eq!(body["analyses"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn archiving_without_a_scope_is_422() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = post_json(&router, "/api/wealth/notes/archive", &token, "{}").await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body, json!({"error": "scope required"}));
    }

    /* ─── The portfolio endpoints ─── */

    #[tokio::test]
    async fn a_malformed_address_is_400_before_any_upstream_is_touched() {
        // The Python's `parse_addresses` gate. It is also what keeps these routes out of the
        // network sweep, so it is worth pinning rather than assuming.
        let (_dir, _pool, router, token) = test_app().await;
        for path in [
            "/api/wealth/portfolio?address=0xabc",
            "/api/wealth/wallet?address=0xabc",
            "/api/wealth/yield-radar?address=0xabc",
        ] {
            let (status, body) = get_json(&router, path, &token).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
            assert_eq!(body, json!({"error": "invalid address"}), "{path}");
        }
    }

    #[test]
    fn a_missing_address_with_nothing_configured_is_an_error_not_an_empty_portfolio() {
        // An empty list would read as "you asked about no wallets, here is nothing", which is
        // not what the caller meant — and is indistinguishable from a genuinely empty book.
        let refused = addresses(None, MAX_WALLETS, "").unwrap_err();
        assert!(refused.contains("no address supplied"), "{refused}");
        assert!(addresses(Some(String::new()), MAX_WALLETS, "").is_err());
    }

    #[test]
    fn a_missing_address_falls_back_to_the_configured_wallets() {
        // What makes the front end work: `getPortfolio()` sends no address at all.
        let resolved = addresses(None, MAX_WALLETS, EVM_ADDRESS).unwrap();
        assert_eq!(resolved, vec![EVM_ADDRESS.to_string()]);
    }

    #[test]
    fn an_explicit_address_beats_the_configured_one() {
        let other = "0x0000000000000000000000000000000000000001";
        let resolved = addresses(Some(other.into()), MAX_WALLETS, EVM_ADDRESS).unwrap();
        assert_eq!(resolved, vec![other.to_string()]);
    }

    #[test]
    fn a_malformed_address_is_still_refused_even_with_wallets_configured() {
        // The fallback covers "you did not say"; it must not paper over "you said something
        // wrong", or a typo in a bookmark would silently report someone else's book.
        assert!(addresses(Some("not-an-address".into()), MAX_WALLETS, EVM_ADDRESS).is_err());
    }

    #[tokio::test]
    async fn the_wallet_route_takes_one_address_not_a_list() {
        // `max_wallets=1`: this is the lazy per-wallet endpoint the front end fans out over.
        let (_dir, _pool, router, token) = test_app().await;
        let pair = format!("{EVM_ADDRESS},{EVM_ADDRESS}");
        let (status, body) = get_json(
            &router,
            &format!("/api/wealth/wallet?address={pair}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error": "too many wallets (max 1)"}));
    }

    #[tokio::test]
    async fn more_than_max_wallets_is_400_on_the_portfolio_route() {
        let (_dir, _pool, router, token) = test_app().await;
        let many = [EVM_ADDRESS; 11].join(",");
        let (status, body) = get_json(
            &router,
            &format!("/api/wealth/portfolio?address={many}"),
            &token,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error": "too many wallets (max 10)"}));
    }

    /* ─── The daily brief ─── */

    #[tokio::test]
    async fn the_digest_refuses_before_it_reads_anything_when_telegram_is_unconfigured() {
        // The gate that keeps this route out of the local sweep: with no bot token it answers
        // 400 without fanning out over the watched wallets. If this ever stops being the first
        // check, `cargo test` starts hitting the network.
        if telegram_ready() {
            return; // this machine has a real bot configured; the assertion does not apply
        }
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = get_json(&router, "/api/wealth/alerts/digest", &token).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, json!({"error": TELEGRAM_UNSET}));
    }

    #[test]
    fn a_digest_snapshot_round_trips_through_the_state_table() {
        // These deltas are the whole point of storing it, and an absent figure must stay absent
        // rather than becoming a zero that renders as "no change since last time".
        let snapshot = DigestSnapshot {
            total: Some(1_234.5),
            claimable: Some(12.25),
            btc_sats: None,
        };
        let restored = digest_snapshot_from(&digest_snapshot_json(&snapshot));
        assert_eq!(restored, snapshot);
    }

    #[test]
    fn a_missing_snapshot_row_reads_as_no_previous_figures() {
        let restored = digest_snapshot_from(&json!({}));
        assert_eq!(restored, DigestSnapshot::default());
        assert_eq!(restored.total, None);
    }

    /* ─── Service health board ─── */

    #[test]
    fn classify_matches_the_pythons_thresholds() {
        assert_eq!(classify(None, 0), "idle");
        assert_eq!(classify(Some(false), 12), "down");
        assert_eq!(classify(Some(true), 12), "up");
        assert_eq!(classify(Some(true), SLOW_MS - 1), "up");
        // The boundary is inclusive: `ms >= SLOW_MS` is slow.
        assert_eq!(classify(Some(true), SLOW_MS), "slow");
        assert_eq!(classify(Some(true), SLOW_MS + 1), "slow");
    }

    #[test]
    fn the_summary_counts_only_the_configured_services() {
        let services = vec![
            json!({"status": "up"}),
            json!({"status": "up"}),
            json!({"status": "slow"}),
            json!({"status": "down"}),
            // Not configured: neither a success nor a failure, and out of the total.
            json!({"status": "idle"}),
        ];
        assert_eq!(
            summarize(&services),
            json!({"up": 2, "slow": 1, "down": 1, "total": 4})
        );
    }

    #[test]
    fn the_board_covers_every_upstream_and_names_what_each_powers() {
        let specs = service_specs();
        let names: Vec<&str> = specs.iter().map(|s| s.name).collect();

        for expected in [
            "DefiLlama",
            "vfat farm-balances",
            "Frankfurter",
            "Hyperliquid L1",
            "KuCoin",
            "hyperscan",
            "Telegram",
        ] {
            assert!(
                names.contains(&expected),
                "{expected} missing from {names:?}"
            );
        }
        // The RPC entries are derived from the chain registry, so they exist only if that registry
        // has URLs — assert the linkage rather than the literal names.
        for chain in ["ethereum", "hyperevm"] {
            if lyra_chain::chains::by_name(chain)
                .and_then(|c| c.rpc)
                .is_some()
            {
                assert!(
                    specs.iter().any(|s| s.category == "Chain"),
                    "{chain} has an RPC but no probe"
                );
            }
        }
        assert!(
            specs.iter().all(|s| !s.powers.is_empty()),
            "every entry must say what it powers — that is the point of the board"
        );
    }

    #[test]
    fn rpc_probes_point_at_the_same_urls_the_portfolio_reader_uses() {
        let specs = service_specs();
        for spec in &specs {
            if let Probe::Rpc(url) = spec.probe {
                let known = lyra_chain::chains::all()
                    .iter()
                    .filter_map(|chain| chain.rpc)
                    .any(|rpc| rpc == url);
                assert!(known, "{url} is not a URL any chain in the registry uses");
            }
        }
    }

    #[tokio::test]
    async fn an_unconfigured_telegram_probe_is_idle_rather_than_down() {
        // No network: the probe short-circuits before making a request when the bot is not
        // configured. If the developer's environment does have a bot token set, skip — the
        // alternative would be mutating process env from a test thread.
        if telegram_ready() {
            return;
        }
        let result = run_probe(Probe::Telegram).await;
        assert_eq!(result.ok, None);
        assert_eq!(result.ms, 0);
        assert_eq!(result.detail, "not configured");
        assert_eq!(classify(result.ok, result.ms), "idle");
    }

    #[test]
    fn no_probe_detail_can_carry_a_url() {
        // The Telegram URL embeds the bot token, so detail lines are HTTP codes and error kinds
        // only. This pins the shape of every string the sweep can put in `detail`.
        for detail in [
            error_detail(&anyhow::anyhow!("boom")),
            format!("HTTP {}", 503),
            "not configured".to_string(),
            "probe failed".to_string(),
        ] {
            assert!(
                !detail.contains("http://") && !detail.contains("https://"),
                "detail must never contain a URL: {detail}"
            );
        }
    }

    /* ─── Alerts ─── */

    #[tokio::test]
    async fn alert_status_reports_every_key_the_python_does() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = get_json(&router, "/api/wealth/alerts", &token).await;

        assert_eq!(status, StatusCode::OK);
        for key in [
            "configured",
            "can_send",
            "wallets",
            "interval",
            "fee_threshold",
            "report_ccy",
            "hf_alert",
            "digest_enabled",
            "digest_hour",
            "digest_last",
            "overrides",
            "last_check",
            "watching",
            "last_error",
            "running",
        ] {
            assert!(body.as_object().unwrap().contains_key(key), "missing {key}");
        }
        // The sweep is a separate job, so this process never claims to be running one.
        assert_eq!(body["running"], false);
        assert_eq!(body["overrides"], json!({}));
    }

    #[tokio::test]
    async fn saving_config_persists_the_knobs_and_returns_the_new_status() {
        let (_dir, _pool, router, token) = test_app().await;

        let (status, body) = post_json(
            &router,
            "/api/wealth/alerts/config",
            &token,
            r#"{"interval":1800,"digest_hour":7,"report_ccy":"usd"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["interval"], 1800);
        assert_eq!(body["digest_hour"], 7);
        assert_eq!(body["report_ccy"], "usd");
        assert_eq!(body["overrides"]["interval"], 1800);

        // Survives the request, i.e. it went to the database and not to a process-local map.
        let (_, body) = get_json(&router, "/api/wealth/alerts", &token).await;
        assert_eq!(body["interval"], 1800);
    }

    #[tokio::test]
    async fn a_null_config_value_reverts_that_knob_to_its_default() {
        let (_dir, _pool, router, token) = test_app().await;
        post_json(
            &router,
            "/api/wealth/alerts/config",
            &token,
            r#"{"interval":1800}"#,
        )
        .await;

        let (status, body) = post_json(
            &router,
            "/api/wealth/alerts/config",
            &token,
            r#"{"interval":null}"#,
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert!(
            body["overrides"].as_object().unwrap().is_empty(),
            "null must remove the override, not store one: {body}"
        );
        // Not asserted as literally 900: with the override gone the value comes from
        // ALERT_INTERVAL, which a machine that actually runs the poller may have set. What must
        // hold is that the saved 1800 is no longer in force and the floor still applies.
        assert_ne!(body["interval"], 1800);
        assert!(body["interval"].as_i64().unwrap() >= 60);
    }

    #[tokio::test]
    async fn an_interval_below_the_floor_is_raised_to_it() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, body) = post_json(
            &router,
            "/api/wealth/alerts/config",
            &token,
            r#"{"interval":5}"#,
        )
        .await;
        assert_eq!(body["interval"], 60, "60s floor protects upstream APIs");
    }

    #[tokio::test]
    async fn an_uncoercible_config_value_is_a_400_rather_than_a_stored_nonsense_schedule() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = post_json(
            &router,
            "/api/wealth/alerts/config",
            &token,
            r#"{"interval":"abc"}"#,
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body["error"].is_string());

        let (_, body) = get_json(&router, "/api/wealth/alerts", &token).await;
        assert_eq!(body["overrides"], json!({}), "nothing was persisted");
    }

    /* ─── Credentials ─── */

    /// No response may carry a credential-shaped field.
    ///
    /// The KuCoin key/secret/passphrase and the Telegram token are read server-side by the chain
    /// and alert layers and must never be echoed. This sweeps every route — including the write
    /// paths, whose bodies are built from stored rows and could in principle carry back whatever
    /// was posted — and fails on any key or value that looks like a secret.
    #[tokio::test]
    async fn no_response_leaks_credential_shaped_fields() {
        let (_dir, _pool, router, token) = test_app().await;
        const FORBIDDEN: [&str; 8] = [
            "api_key",
            "apikey",
            "secret",
            "passphrase",
            "bot_token",
            "private_key",
            "KUCOIN_",
            "TELEGRAM_",
        ];

        for (method, path, body) in LOCAL_ROUTES {
            let (_, value) = call(&router, method, path, Some(&token), body).await;
            let rendered = value.to_string().to_lowercase();
            for needle in FORBIDDEN {
                assert!(
                    !rendered.contains(&needle.to_lowercase()),
                    "{method} {path} response mentions {needle}: {value}"
                );
            }
        }
    }

    /* ─── Pure helpers ─── */

    #[test]
    fn flag_matches_pythons_truthiness() {
        assert!(flag(Some(&"1".to_string())));
        assert!(flag(Some(&"true".to_string())));
        assert!(!flag(Some(&"yes".to_string())));
        assert!(!flag(Some(&"0".to_string())));
        assert!(!flag(None));
    }

    #[test]
    fn read_json_turns_anything_unreadable_into_an_empty_object() {
        assert_eq!(read_json(""), json!({}));
        assert_eq!(read_json("{bad"), json!({}));
        assert_eq!(read_json(r#"{"a":1}"#), json!({"a": 1}));
    }

    /* ─── Off-chain assets ─── */

    async fn put_json(
        router: &Router,
        path: &str,
        token: &str,
        body: &str,
    ) -> (StatusCode, Value) {
        call(router, "PUT", path, Some(token), body).await
    }

    #[tokio::test]
    async fn an_off_chain_asset_round_trips_through_the_api() {
        let (_dir, _pool, router, token) = test_app().await;

        let (status, created) = post_json(
            &router,
            "/api/wealth/manual-assets",
            &token,
            r#"{"name":"Cold storage BTC","value":14000000,"ccy":"sats","tier":"store","custody":"cold","note":"Hardware wallet"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["name"], "Cold storage BTC");
        assert_eq!(created["ccy"], "sats");
        assert!(created["id"].as_str().is_some_and(|id| !id.is_empty()));

        let (status, listed) = get_json(&router, "/api/wealth/manual-assets", &token).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            listed["assets"].as_array().unwrap(),
            std::slice::from_ref(&created)
        );
    }

    /// `ManualAsset` in `types.ts` declares its optionals with `?`, so a `null` would not type-check
    /// on the reading side. This is the test that holds that contract.
    #[tokio::test]
    async fn absent_optional_fields_are_omitted_rather_than_null() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, created) = post_json(
            &router,
            "/api/wealth/manual-assets",
            &token,
            r#"{"name":"Bare","tier":"trading"}"#,
        )
        .await;

        let object = created.as_object().unwrap();
        for key in ["kind", "ccy", "code", "chain", "note", "custody", "value", "units"] {
            assert!(!object.contains_key(key), "{key} should be absent, not null");
        }
        assert!(object.contains_key("id"));
        assert_eq!(created["tier"], "trading");
    }

    /// An HTML number input hands back a string; dropping it would silently lose the one field
    /// the form exists to capture.
    #[tokio::test]
    async fn numbers_are_accepted_as_strings_too() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, created) = post_json(
            &router,
            "/api/wealth/manual-assets",
            &token,
            r#"{"name":"THB savings","value":"180000","units":" 1.5 ","ccy":"thb","tier":"business"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["value"], 180_000.0);
        assert_eq!(created["units"], 1.5);
    }

    /// Unparseable is "no value", not zero — a typo must not be recorded as a balance of nothing.
    #[tokio::test]
    async fn an_unparseable_number_is_absent_rather_than_zero() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, created) = post_json(
            &router,
            "/api/wealth/manual-assets",
            &token,
            r#"{"name":"Typo","value":"about 200","tier":"store"}"#,
        )
        .await;
        assert!(!created.as_object().unwrap().contains_key("value"));
    }

    #[tokio::test]
    async fn a_put_replaces_the_asset_and_a_delete_removes_it() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, created) = post_json(
            &router,
            "/api/wealth/manual-assets",
            &token,
            r#"{"name":"Kinesis gold","value":4200,"ccy":"usd","tier":"store","note":"vault 4471"}"#,
        )
        .await;
        let id = created["id"].as_str().unwrap().to_string();

        let (status, updated) = put_json(
            &router,
            &format!("/api/wealth/manual-assets/{id}"),
            &token,
            r#"{"name":"Kinesis gold","value":4800,"ccy":"usd","tier":"business"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(updated["id"], created["id"]);
        assert_eq!(updated["value"], 4800.0);
        assert_eq!(updated["tier"], "business");
        // The note was left out of the replacement, so it is gone — a patch could not say this.
        assert!(!updated.as_object().unwrap().contains_key("note"));

        let (status, _) = call(
            &router,
            "DELETE",
            &format!("/api/wealth/manual-assets/{id}"),
            Some(&token),
            "",
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (_, listed) = get_json(&router, "/api/wealth/manual-assets", &token).await;
        assert!(listed["assets"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn writing_or_deleting_an_unknown_id_is_a_404() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, body) = put_json(
            &router,
            "/api/wealth/manual-assets/nope",
            &token,
            r#"{"name":"x","tier":"store"}"#,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, json!({"error": "not found"}));

        let (status, _) = call(
            &router,
            "DELETE",
            "/api/wealth/manual-assets/nope",
            Some(&token),
            "",
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn a_rejected_asset_is_a_422_naming_the_field() {
        let (_dir, _pool, router, token) = test_app().await;

        for (body, wanted) in [
            (r#"{"tier":"store"}"#, "name is required"),
            (r#"{"name":"x","tier":"savings"}"#, "tier must be one of"),
            (r#"{"name":"x","tier":"store","ccy":"eur"}"#, "ccy must be one of"),
            (
                r#"{"name":"x","tier":"store","custody":"warm"}"#,
                "custody must be one of",
            ),
        ] {
            let (status, value) = post_json(&router, "/api/wealth/manual-assets", &token, body).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
            let message = value["error"].as_str().unwrap_or_default();
            assert!(message.starts_with(wanted), "{body} said {message:?}");
        }

        let (_, listed) = get_json(&router, "/api/wealth/manual-assets", &token).await;
        assert!(listed["assets"].as_array().unwrap().is_empty());
    }


    /* ─── The wallet list ─── */

    const A_BTC_ADDRESS: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";

    /// The whole point of the feature: a Bitcoin address can be added, which `ALERT_WALLETS`
    /// alone could never express to the sweep.
    #[tokio::test]
    async fn a_bitcoin_address_can_be_added_and_is_classified() {
        let (_dir, _pool, router, token) = test_app().await;

        let (status, created) = post_json(
            &router,
            "/api/wealth/wallets",
            &token,
            &format!(r#"{{"address":"{A_BTC_ADDRESS}","label":"cold"}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(created["kind"], "bitcoin");
        assert_eq!(created["label"], "cold");

        let (_, listed) = get_json(&router, "/api/wealth/wallets", &token).await;
        assert_eq!(listed["wallets"].as_array().unwrap().len(), 1);
        // Once anything is stored, the database is the authority.
        assert_eq!(listed["source"], "db");
        assert_eq!(listed["effective"][0], A_BTC_ADDRESS);
    }

    /// Adding your first wallet must not silently drop the addresses the environment named — you
    /// would add a cold Bitcoin wallet and lose the EVM one holding the actual book.
    #[tokio::test]
    async fn the_first_wallet_added_brings_the_environment_list_with_it() {
        // SAFETY: single-threaded test, and the value is read through `DEFAULT_WALLETS` below.
        let evm = "0x7Fce9c293dBD6d050455B986cb6850114Aad71a8";
        if DEFAULT_WALLETS.trim().is_empty() {
            // The static is resolved once per process from the ambient environment; when the test
            // runner has no ALERT_WALLETS there is nothing to seed and nothing to assert.
            return;
        }

        let (_dir, _pool, router, token) = test_app().await;
        let (status, _) = post_json(
            &router,
            "/api/wealth/wallets",
            &token,
            &format!(r#"{{"address":"{A_BTC_ADDRESS}","label":"cold"}}"#),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);

        let (_, listed) = get_json(&router, "/api/wealth/wallets", &token).await;
        let addresses: Vec<&str> = listed["wallets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["address"].as_str().unwrap())
            .collect();
        assert!(addresses.contains(&A_BTC_ADDRESS), "the new wallet: {addresses:?}");
        assert!(
            addresses.iter().any(|a| a.eq_ignore_ascii_case(evm)) || !DEFAULT_WALLETS.contains(evm),
            "the environment's wallets should have come across: {addresses:?}"
        );
    }

    /// A rejected address must not be the thing that flips the list from the environment to the
    /// database — that would strand the book on an empty table.
    #[tokio::test]
    async fn a_refused_address_does_not_flip_the_list_to_the_database() {
        let (_dir, _pool, router, token) = test_app().await;
        let (status, _) =
            post_json(&router, "/api/wealth/wallets", &token, r#"{"address":"nope"}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

        let (_, listed) = get_json(&router, "/api/wealth/wallets", &token).await;
        assert!(listed["wallets"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_address_the_fan_out_cannot_read_is_refused() {
        let (_dir, _pool, router, token) = test_app().await;
        for bad in [r#"{"address":"not-an-address"}"#, r#"{"address":""}"#, r#"{}"#] {
            let (status, body) = post_json(&router, "/api/wealth/wallets", &token, bad).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
            assert!(
                body["error"].as_str().unwrap_or_default().contains("address"),
                "{bad} said {body}"
            );
        }
    }

    #[tokio::test]
    async fn adding_the_same_address_twice_is_a_409() {
        let (_dir, _pool, router, token) = test_app().await;
        let body = format!(r#"{{"address":"{A_BTC_ADDRESS}"}}"#);
        let (first, _) = post_json(&router, "/api/wealth/wallets", &token, &body).await;
        assert_eq!(first, StatusCode::CREATED);

        let (second, value) = post_json(&router, "/api/wealth/wallets", &token, &body).await;
        assert_eq!(second, StatusCode::CONFLICT);
        assert!(value["error"].as_str().unwrap().contains("already"));
    }

    #[tokio::test]
    async fn a_wallet_can_be_removed_and_an_unknown_id_is_a_404() {
        let (_dir, _pool, router, token) = test_app().await;
        let (_, created) = post_json(
            &router,
            "/api/wealth/wallets",
            &token,
            &format!(r#"{{"address":"{A_BTC_ADDRESS}"}}"#),
        )
        .await;
        let id = created["id"].as_str().unwrap();

        let (status, _) = call(
            &router,
            "DELETE",
            &format!("/api/wealth/wallets/{id}"),
            Some(&token),
            "",
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let (again, _) = call(
            &router,
            "DELETE",
            &format!("/api/wealth/wallets/{id}"),
            Some(&token),
            "",
        )
        .await;
        assert_eq!(again, StatusCode::NOT_FOUND);

        let (_, listed) = get_json(&router, "/api/wealth/wallets", &token).await;
        assert!(listed["wallets"].as_array().unwrap().is_empty());
    }

}
