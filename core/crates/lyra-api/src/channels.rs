//! `/api/channels` and `/api/routes` — where notifications can go, and which groups go there.
//!
//! **No response from this module contains a credential.** A channel is returned with a preview
//! only, and the one test most worth having here says so. The write path is the inverse: a
//! credential can be sent in and never read back, which is what makes "leave it unchanged"
//! expressible as its absence.
//!
//! Validation happens here, at write time, rather than at send time. `lyra_alerts::channels::
//! Transport::check` owns the rules — it asks `Webhook::new`, which already refused every host but
//! `discord.com` long before any of this was configurable. Making the URL editable is not the same
//! as making it unconstrained, and the refusal names the rule so a mistyped paste says what is
//! wrong with it.

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lyra_alerts::channels::Transport;
use lyra_db::channels::{ChannelInput, ChannelStore, Route, Severity};
use lyra_db::jobs::now_secs;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::{error, not_found};

fn store(state: &AppState) -> ChannelStore {
    ChannelStore::new(state.pool.clone(), state.secret_key.as_deref().cloned())
}

/// Every channel, with a preview in place of its credential.
pub async fn index(_user: AuthUser, State(state): State<AppState>) -> Response {
    match store(&state).list().await {
        Ok(channels) => Json(json!({
            "channels": channels,
            // The transports a channel can be, so the form does not hard-code a list that drifts
            // from the one the sender registry actually supports.
            "transports": Transport::ALL.map(|t| json!({
                "id": t.as_str(),
                "stores_credential": t.stores_its_own_credential(),
            })),
        }))
        .into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("listing channels: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct NewChannel {
    pub name: String,
    pub transport: String,
    /// The credential, in the clear, once. Absent for a transport that keeps it in the environment.
    pub url: Option<String>,
}

pub async fn create(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<NewChannel>,
) -> Response {
    let name = body.name.trim();
    if name.is_empty() {
        return error(StatusCode::BAD_REQUEST, "a channel needs a name");
    }
    let Some(transport) = Transport::parse(body.transport.trim()) else {
        return error(
            StatusCode::BAD_REQUEST,
            &format!("unknown transport {:?}", body.transport),
        );
    };

    let url = body.url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    if transport.stores_its_own_credential() {
        let Some(url) = url else {
            return error(
                StatusCode::BAD_REQUEST,
                "this transport needs a webhook URL",
            );
        };
        if let Err(why) = transport.check(url) {
            return error(StatusCode::BAD_REQUEST, &why);
        }
    } else if url.is_some() {
        // Refused rather than ignored. Silently dropping a credential someone pasted would leave
        // them believing it was stored.
        return error(
            StatusCode::BAD_REQUEST,
            "this transport takes its credential from the environment — remove the URL",
        );
    }

    match store(&state)
        .create(
            &ChannelInput {
                name: name.to_string(),
                transport: transport.as_str().to_string(),
                secret: url.map(str::to_string),
            },
            now_secs(),
        )
        .await
    {
        Ok(channel) => (StatusCode::CREATED, Json(channel)).into_response(),
        // The store refuses to store a credential with no sealing key, and names the variable. That
        // is a configuration problem the caller can act on, so it is a 400 rather than a 500.
        Err(e) => error(StatusCode::BAD_REQUEST, &format!("{e}")),
    }
}

#[derive(Debug, Deserialize)]
pub struct ChannelPatch {
    pub name: Option<String>,
    /// A new credential. **Absent means unchanged** — the UI was never given the old one, so it
    /// cannot send it back, and absence is the only way to say "leave it".
    pub url: Option<String>,
    pub enabled: Option<bool>,
}

pub async fn update(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ChannelPatch>,
) -> Response {
    let store = store(&state);
    let Ok(Some(existing)) = store.get(&id).await else {
        return not_found("no such channel");
    };

    let url = body.url.as_deref().map(str::trim).filter(|u| !u.is_empty());
    if let Some(url) = url {
        let Some(transport) = Transport::parse(&existing.transport) else {
            return error(
                StatusCode::CONFLICT,
                &format!(
                    "this channel's transport {:?} is not one this build knows",
                    existing.transport
                ),
            );
        };
        if let Err(why) = transport.check(url) {
            return error(StatusCode::BAD_REQUEST, &why);
        }
    }

    match store
        .update(
            &id,
            body.name
                .as_deref()
                .map(str::trim)
                .filter(|n| !n.is_empty()),
            url,
            body.enabled,
            now_secs(),
        )
        .await
    {
        Ok(Some(channel)) => Json(channel).into_response(),
        Ok(None) => not_found("no such channel"),
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
        Ok(false) => not_found("no such channel"),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("deleting a channel: {e}"),
        ),
    }
}

/// Send the "is this thing on?" ping through one channel, and report what happened.
///
/// Its own endpoint rather than a side effect of saving, so a channel that has been sitting there
/// for months can be checked without editing it. The UI still saves and tests in one action,
/// because a saved-but-broken webhook is the failure the screen exists to prevent.
pub async fn test(
    _user: AuthUser,
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    let store = store(&state);
    let Ok(Some(channel)) = store.get(&id).await else {
        return not_found("no such channel");
    };

    let secret = match store.secret_of(&id).await {
        Ok(secret) => secret,
        // Reading it needs the sealing key. Missing key is a configuration problem, and the message
        // from the store already names the variable.
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("{e}")),
    };

    let Some(transport) = Transport::parse(&channel.transport) else {
        return error(
            StatusCode::CONFLICT,
            &format!("unknown transport {:?}", channel.transport),
        );
    };

    let sender = match crate::notify::sender_for(transport, secret.as_deref()) {
        Ok(sender) => sender,
        Err(why) => return error(StatusCode::BAD_REQUEST, &why),
    };

    let now = now_secs();
    let outcome = lyra_alerts::channels::Channels::new(vec![sender])
        .send_test()
        .await;

    // The result is recorded, not just returned: a test is the most likely moment for someone to
    // discover a channel is broken, and the row is where the UI reads "failing since".
    match outcome {
        lyra_alerts::telegram::Delivery::Sent => {
            let _ = store.record_success(&id, now).await;
            Json(json!({ "ok": true })).into_response()
        }
        lyra_alerts::telegram::Delivery::NotConfigured => error(
            StatusCode::BAD_REQUEST,
            "this channel has nothing to send with",
        ),
        lyra_alerts::telegram::Delivery::Failed(e) => {
            let _ = store.record_failure(&id, e.message(), now).await;
            error(StatusCode::BAD_GATEWAY, e.message())
        }
    }
}

/* ─── routes ─── */

pub async fn routes_index(_user: AuthUser, State(state): State<AppState>) -> Response {
    match store(&state).routes().await {
        Ok(routes) => Json(json!({
            "routes": routes,
            "groups": crate::notify::GROUPS,
            "severities": ["info", "warning", "critical"],
        }))
        .into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("listing routes: {e}"),
        ),
    }
}

#[derive(Debug, Deserialize)]
pub struct RouteInput {
    pub group: String,
    pub channel_id: String,
    #[serde(default)]
    pub min_severity: Option<String>,
    #[serde(default)]
    pub quiet_from: Option<i64>,
    #[serde(default)]
    pub quiet_to: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct RoutesBody {
    pub routes: Vec<RouteInput>,
}

/// Replace the whole matrix.
///
/// The UI edits a grid and saves a grid. A per-row API would let a save half-apply and leave a
/// group delivering to a channel that had just been unticked — the worst kind of failure here,
/// because nothing looks wrong until something arrives where it should not.
pub async fn routes_replace(
    _user: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<RoutesBody>,
) -> Response {
    let store = store(&state);
    let known: Vec<String> = match store.list().await {
        Ok(channels) => channels.into_iter().map(|c| c.id).collect(),
        Err(e) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("reading channels: {e}"),
            );
        }
    };

    let mut routes = Vec::with_capacity(body.routes.len());
    for input in &body.routes {
        if !crate::notify::GROUPS.contains(&input.group.as_str()) {
            return error(
                StatusCode::BAD_REQUEST,
                &format!("unknown group {:?}", input.group),
            );
        }
        // Checked here as well as by the foreign key, so the answer is a named 400 rather than a
        // constraint violation the caller has to interpret.
        if !known.contains(&input.channel_id) {
            return error(
                StatusCode::BAD_REQUEST,
                &format!("no such channel {:?}", input.channel_id),
            );
        }
        if let Some(hour) = [input.quiet_from, input.quiet_to]
            .into_iter()
            .flatten()
            .find(|h| !(0..24).contains(h))
        {
            return error(
                StatusCode::BAD_REQUEST,
                &format!("quiet hours are 0-23, not {hour}"),
            );
        }
        routes.push(Route {
            id: String::new(),
            group: input.group.clone(),
            channel_id: input.channel_id.clone(),
            min_severity: input
                .min_severity
                .as_deref()
                .map_or(Severity::Info, Severity::parse),
            quiet_from: input.quiet_from,
            quiet_to: input.quiet_to,
        });
    }

    match store.set_routes(&routes).await {
        Ok(()) => crate::common::ok_true(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("saving routes: {e}"),
        ),
    }
}
