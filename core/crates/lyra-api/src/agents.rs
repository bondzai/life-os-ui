//! The agent fleet, live.
//!
//! An "agent" here is anything that does work on your behalf without being asked twice: today that
//! is the queue's lane workers, and the seam is deliberately wider than that — a scheduled
//! analysis, an MCP desk, or a model loop is the same thing wearing a different hat.
//!
//! # Events, not polling
//!
//! The obvious build is a timer that reads the `jobs` table and sends the whole fleet down the
//! socket every second. It is also the one that stops working: the payload grows with the fleet,
//! every client pays for every other client's agents, and the latency floor is the poll interval
//! no matter how fast the work actually is.
//!
//! So a worker **publishes** what it did, once, to a [`tokio::sync::broadcast`] channel, and every
//! connected socket gets it. Cost is one clone per listener per event rather than one table scan
//! per listener per tick, and an agent that does nothing costs nothing.
//!
//! # A socket that falls behind is resynced, not dropped
//!
//! `broadcast` is bounded, and a slow client will eventually lag past the buffer. The easy
//! handling — close the socket — turns a hiccup into a reconnect storm. Instead a lagged receiver
//! is sent a fresh [`Frame::Snapshot`] and carries on: the client's picture is correct again, and
//! nothing had to be replayed. That is also why the protocol has a snapshot frame at all rather
//! than only deltas.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::AppState;
use crate::auth::AuthUser;

/// How many events a slow listener may fall behind before it is resynced instead.
///
/// Small on purpose. The recovery path is a snapshot, which is cheap and correct, so a big buffer
/// would only delay the moment a struggling client is put back on its feet.
const BACKLOG: usize = 256;

/// How often the server sends a ping when nothing is happening.
///
/// A silent TCP connection through a sleeping laptop's NAT looks identical to a healthy one until
/// you try to write. This is what makes a dead socket *observably* dead, on both ends, within a
/// bounded time — the client has the same watchdog pointed the other way.
const PING_EVERY: Duration = Duration::from_secs(20);

/// What an agent is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    /// Alive, nothing claimed.
    Idle,
    /// Holding a job.
    Working,
}

/// One agent, as the UI needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    /// Stable across restarts in shape, unique within a process run. See `jobs::worker_name`.
    pub id: String,
    /// The lane it serves — the closest thing an agent has to a job title.
    pub lane: String,
    pub status: AgentStatus,
    /// The job it is holding, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job: Option<CurrentJob>,
    /// Unix seconds of the last thing it told us. The client renders staleness from this rather
    /// than from its own arrival time, so a delayed frame does not read as a healthy agent.
    pub last_seen: i64,
    pub done: u32,
    pub failed: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CurrentJob {
    pub id: String,
    pub kind: String,
    pub attempt: i64,
    pub started_at: i64,
}

/// What goes down the wire.
///
/// Tagged rather than positional so a client written against today's three variants ignores a
/// fourth instead of misreading it — the whole point of shipping a protocol you intend to extend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    /// The whole fleet. Sent on connect, and again to any listener that fell behind.
    Snapshot { agents: Vec<Agent>, at: i64 },
    /// One agent changed.
    Agent { agent: Agent },
    /// An agent went away — process shutdown, or a worker that will not be back.
    Gone { id: String },
}

/// What a worker reports. Kept separate from [`Frame`] so the wire format can change without
/// touching the worker loop.
#[derive(Debug, Clone)]
pub enum Report {
    Started { id: String, lane: String, at: i64 },
    Claimed { id: String, job: CurrentJob },
    Finished { id: String, ok: bool, at: i64 },
    Stopped { id: String },
}

/// The fleet's current state plus the channel that announces changes to it.
///
/// State is held in memory rather than read back from `jobs`, because the question "what is this
/// worker doing" is about the worker, and the table only knows about rows. A worker that is alive
/// and idle has no row at all.
#[derive(Clone)]
pub struct Fleet {
    agents: Arc<Mutex<BTreeMap<String, Agent>>>,
    tx: broadcast::Sender<Frame>,
}

impl Default for Fleet {
    fn default() -> Self {
        Self::new()
    }
}

impl Fleet {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(Mutex::new(BTreeMap::new())),
            tx: broadcast::channel(BACKLOG).0,
        }
    }

    /// Everything, for a new listener or a resync.
    pub fn snapshot(&self) -> Vec<Agent> {
        self.agents
            .lock()
            .map(|a| a.values().cloned().collect())
            .unwrap_or_default()
    }

    fn subscribe(&self) -> broadcast::Receiver<Frame> {
        self.tx.subscribe()
    }

    /// Fold a worker's report into the fleet and announce the result.
    ///
    /// A send with no listeners is not an error — nobody has the page open, which is the normal
    /// case — so the result is deliberately dropped.
    pub fn report(&self, report: Report) {
        let frame = {
            let Ok(mut agents) = self.agents.lock() else {
                // A poisoned lock means some other thread panicked holding it. The fleet view is
                // an observability surface; losing one frame is the right cost for never taking
                // the worker down with it.
                return;
            };
            match report {
                Report::Started { id, lane, at } => {
                    let agent = agents.entry(id.clone()).or_insert_with(|| Agent {
                        id,
                        lane,
                        status: AgentStatus::Idle,
                        job: None,
                        last_seen: at,
                        done: 0,
                        failed: 0,
                    });
                    // A restart after a panic keeps the tallies: they are the evidence that it
                    // has been restarting, which is exactly what you would want to notice.
                    agent.status = AgentStatus::Idle;
                    agent.job = None;
                    agent.last_seen = at;
                    Frame::Agent {
                        agent: agent.clone(),
                    }
                }
                Report::Claimed { id, job } => {
                    let Some(agent) = agents.get_mut(&id) else {
                        return;
                    };
                    agent.last_seen = job.started_at;
                    agent.status = AgentStatus::Working;
                    agent.job = Some(job);
                    Frame::Agent {
                        agent: agent.clone(),
                    }
                }
                Report::Finished { id, ok, at } => {
                    let Some(agent) = agents.get_mut(&id) else {
                        return;
                    };
                    agent.status = AgentStatus::Idle;
                    agent.job = None;
                    agent.last_seen = at;
                    if ok {
                        agent.done = agent.done.saturating_add(1);
                    } else {
                        agent.failed = agent.failed.saturating_add(1);
                    }
                    Frame::Agent {
                        agent: agent.clone(),
                    }
                }
                Report::Stopped { id } => {
                    agents.remove(&id);
                    Frame::Gone { id }
                }
            }
        };
        let _ = self.tx.send(frame);
    }
}

/// `GET /api/agents` — the fleet without a socket.
///
/// Not a legacy path. It is what the page falls back to when a socket cannot be held open, and
/// what makes the feature degrade to "a second late" rather than to "blank".
pub async fn list(State(state): State<AppState>, _user: AuthUser) -> Response {
    axum::Json(serde_json::json!({ "agents": state.fleet.snapshot() })).into_response()
}

/// `GET /api/jobs` — the queue as a person needs to see it.
///
/// Counts plus the most recently touched rows, in one call. Deliberately **not** streamed over the
/// fleet socket: agent state is a handful of in-memory records that change on an event, and a
/// queue depth is a `COUNT` over a table. Pushing the second one down every socket on every event
/// would turn one query into one query per listener per job, which is the shape that stops working
/// first.
pub async fn jobs(State(state): State<AppState>, _user: AuthUser) -> Response {
    use lyra_db::jobs::{Queue, SqliteQueue, now_secs};

    let queue = SqliteQueue::new(state.pool.clone());
    let now = now_secs();

    // Both reads are independent and neither is a transaction: a count taken a millisecond before
    // the list is exactly as true as one taken after it, and a page that refreshes does not need
    // the two to agree to the row.
    let age = queue.age(now).await;
    let recent = queue.recent(25).await;

    match (age, recent) {
        (Ok(age), Ok(recent)) => axum::Json(serde_json::json!({
            "counts": {
                "queued": age.queued,
                "running": age.running,
                "failed": age.failed,
            },
            // The oldest runnable wait, which is the one number that answers "are the workers
            // keeping up". A job scheduled for tomorrow is not a backlog and is not counted.
            "oldest_queued_secs": age.oldest_queued_secs,
            "recent": recent.iter().map(job_json).collect::<Vec<_>>(),
        }))
        .into_response(),
        _ => crate::common::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "could not read the queue",
        ),
    }
}

/// One job as the page sees it. Shared by the list and the detail so they cannot drift apart.
///
/// The payload is deliberately **not** here. It is the handler's arguments, and for a
/// `deliver.telegram` that is the full text of a message about your money — fine to hold in your
/// own database, not something every refresh of a list should carry across the wire.
fn job_json(job: &lyra_db::jobs::Job) -> serde_json::Value {
    serde_json::json!({
        "id": job.id,
        "kind": job.kind,
        "lane": job.lane.as_str(),
        "status": job.status.as_str(),
        "attempts": job.attempts,
        "max_attempts": job.max_attempts,
        "run_at": job.run_at,
        "updated_at": job.updated_at,
        "parent_id": job.parent_id,
        // The reason a job is dead is the whole value of keeping the row.
        "last_error": job.last_error,
    })
}

/// `GET /api/jobs/{id}` — one job.
pub async fn job_one(
    State(state): State<AppState>,
    _user: AuthUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    use lyra_db::jobs::{Queue, SqliteQueue};
    match SqliteQueue::new(state.pool.clone()).get(&id).await {
        Ok(Some(job)) => axum::Json(job_json(&job)).into_response(),
        Ok(None) => crate::common::not_found("no such job"),
        Err(_) => crate::common::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "could not read the job",
        ),
    }
}

/// `POST /api/jobs/{id}/retry` — ask for a failed or cancelled job's work again.
///
/// Answers with the *new* job, because that is the one worth watching; the old one is kept
/// unchanged as the record of what went wrong. See `SqliteQueue::retry`.
pub async fn job_retry(
    State(state): State<AppState>,
    _user: AuthUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    use lyra_db::jobs::{Queue, Retried, SqliteQueue, now_secs};
    match SqliteQueue::new(state.pool.clone()).retry(&id, now_secs()).await {
        Ok(Retried::Queued(enqueued)) => axum::Json(serde_json::json!({
            "id": enqueued.id,
            // False when this retry was already asked for — a double click, not a second job.
            "created": enqueued.created,
        }))
        .into_response(),
        // 409, not 400: the request was fine, the job is in the wrong state for it. The message
        // says which state, so the page can say something more useful than "error".
        Ok(Retried::NotRetryable(status)) => crate::common::error(
            axum::http::StatusCode::CONFLICT,
            &format!("only failed or cancelled jobs can be retried; this one is {}", status.as_str()),
        ),
        Ok(Retried::NotFound) => crate::common::not_found("no such job"),
        Err(_) => crate::common::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "could not retry the job",
        ),
    }
}

/// `POST /api/jobs/{id}/cancel` — take a job off the queue before it runs.
///
/// Queued jobs only. A running job is left to finish: pulling the rug mid-handler would leave a
/// half-sent message or a half-written row, which is worse than letting it complete.
pub async fn job_cancel(
    State(state): State<AppState>,
    _user: AuthUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    use lyra_db::jobs::{Queue, SqliteQueue, now_secs};
    let queue = SqliteQueue::new(state.pool.clone());
    match queue.cancel(&id, now_secs()).await {
        Ok(true) => crate::common::ok_true(),
        Ok(false) => match queue.get(&id).await {
            Ok(Some(job)) => crate::common::error(
                axum::http::StatusCode::CONFLICT,
                &format!("only queued jobs can be cancelled; this one is {}", job.status.as_str()),
            ),
            _ => crate::common::not_found("no such job"),
        },
        Err(_) => crate::common::error(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "could not cancel the job",
        ),
    }
}

#[derive(Deserialize)]
pub struct StreamQuery {
    /// A one-shot ticket from `POST /api/agents/ticket`.
    ///
    /// The JWT is not accepted here and must not be: a browser cannot set headers on a WebSocket,
    /// so the only way to pass one is the query string — where it lands in access logs, in
    /// `Referer`, and in any proxy in between. A ticket is single-use and expires in seconds, so
    /// the same leak costs nothing.
    ticket: String,
}

/// `POST /api/agents/ticket` — mint a short-lived ticket for the socket handshake.
pub async fn ticket(State(state): State<AppState>, user: AuthUser) -> Response {
    axum::Json(serde_json::json!({ "ticket": state.tickets.mint(&user.user_id) })).into_response()
}

/// `GET /api/agents/stream` — the fleet, live.
pub async fn stream(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<StreamQuery>,
) -> Response {
    if state.tickets.redeem(&query.ticket).is_none() {
        return crate::common::error(
            axum::http::StatusCode::UNAUTHORIZED,
            "that ticket is not valid; ask for another",
        );
    }
    ws.on_upgrade(move |socket| pump(socket, state.fleet.clone()))
}

/// Hold one socket open: snapshot, then deltas, then pings in the gaps.
async fn pump(mut socket: WebSocket, fleet: Fleet) {
    let mut rx = fleet.subscribe();

    // Subscribe BEFORE snapshotting. The other order has a hole in it: an event fired between the
    // snapshot and the subscribe reaches neither, and the client believes a stale agent forever.
    // This order can duplicate an event instead, which is harmless — every frame is idempotent.
    if send_snapshot(&mut socket, &fleet).await.is_err()
    {
        return;
    }

    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await; // the first one fires immediately

    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(frame) => {
                    if send(&mut socket, &frame).await.is_err() {
                        return;
                    }
                }
                // Fell behind. Resync rather than disconnect — see the module docs.
                Err(broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::debug!(missed, "a fleet listener lagged; resyncing it");
                    if send_snapshot(&mut socket, &fleet).await.is_err()
                    {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            _ = ping.tick() => {
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return;
                }
            }
            // Reading is what notices a client that went away, and what keeps pongs from
            // accumulating in the receive buffer.
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}
                _ => return,
            },
        }
    }
}

/// The whole fleet, as sent on connect and to a listener that fell behind.
async fn send_snapshot(socket: &mut WebSocket, fleet: &Fleet) -> Result<(), axum::Error> {
    let frame = Frame::Snapshot {
        agents: fleet.snapshot(),
        at: lyra_db::jobs::now_secs(),
    };
    send(socket, &frame).await
}

async fn send(socket: &mut WebSocket, frame: &Frame) -> Result<(), axum::Error> {
    let text = serde_json::to_string(frame).unwrap_or_else(|_| "{}".into());
    socket.send(Message::Text(text.into())).await
}

/// One-shot tickets for the socket handshake.
///
/// A browser cannot put an `Authorization` header on a WebSocket, so the credential has to travel
/// in the URL. Rather than put the JWT there — where it is logged by every proxy it passes and
/// lives as long as the session does — the page trades its JWT for a ticket over an ordinary
/// authenticated POST, and spends the ticket immediately.
///
/// Single-use and short-lived, so a ticket recovered from a log is worth nothing by the time
/// anyone reads it. In memory, because it is worth nothing after a restart either.
#[derive(Clone, Default)]
pub struct Tickets {
    issued: Arc<Mutex<BTreeMap<String, (String, i64)>>>,
}

/// Long enough to survive a slow page, short enough that a leaked ticket is already dead.
const TICKET_TTL_SECS: i64 = 30;

impl Tickets {
    pub fn mint(&self, user_id: &str) -> String {
        // The same shape `gcal::OAuthStates` uses for its OAuth state, and for the same reason:
        // this value's only job is to be unguessable for thirty seconds.
        let ticket: String = {
            // rand 0.10 renamed the old `RngCore` to `Rng`; `fill_bytes` lives there.
            use rand::Rng;
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        };
        let now = lyra_db::jobs::now_secs();
        if let Ok(mut issued) = self.issued.lock() {
            // Swept here rather than on a timer: the map is only ever touched on these two paths,
            // so there is nothing a timer would catch that this does not.
            issued.retain(|_, (_, expires)| *expires > now);
            issued.insert(ticket.clone(), (user_id.to_string(), now + TICKET_TTL_SECS));
        }
        ticket
    }

    /// Spend a ticket. `None` if it never existed, was already spent, or expired — three failures
    /// that are deliberately indistinguishable to the caller.
    pub fn redeem(&self, ticket: &str) -> Option<String> {
        let now = lyra_db::jobs::now_secs();
        let mut issued = self.issued.lock().ok()?;
        let (user, expires) = issued.remove(ticket)?;
        (expires > now).then_some(user)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_is_good_exactly_once() {
        let tickets = Tickets::default();
        let t = tickets.mint("user-jb");
        assert_eq!(tickets.redeem(&t).as_deref(), Some("user-jb"));
        assert!(
            tickets.redeem(&t).is_none(),
            "a spent ticket must not open a second socket"
        );
    }

    #[test]
    fn an_unknown_ticket_opens_nothing() {
        assert!(Tickets::default().redeem("made-up").is_none());
    }

    #[test]
    fn the_fleet_tracks_a_worker_through_a_job() {
        let fleet = Fleet::new();
        fleet.report(Report::Started {
            id: "deliver-0@1".into(),
            lane: "deliver".into(),
            at: 100,
        });
        assert_eq!(fleet.snapshot().len(), 1);
        assert_eq!(fleet.snapshot()[0].status, AgentStatus::Idle);

        fleet.report(Report::Claimed {
            id: "deliver-0@1".into(),
            job: CurrentJob {
                id: "j1".into(),
                kind: "deliver.telegram".into(),
                attempt: 1,
                started_at: 110,
            },
        });
        let working = &fleet.snapshot()[0];
        assert_eq!(working.status, AgentStatus::Working);
        assert_eq!(working.job.as_ref().unwrap().kind, "deliver.telegram");

        fleet.report(Report::Finished {
            id: "deliver-0@1".into(),
            ok: true,
            at: 120,
        });
        let idle = &fleet.snapshot()[0];
        assert_eq!(idle.status, AgentStatus::Idle);
        assert!(idle.job.is_none(), "a finished job must not linger");
        assert_eq!(idle.done, 1);
        assert_eq!(idle.failed, 0);
    }

    #[test]
    fn a_report_about_an_unknown_agent_is_ignored_rather_than_inventing_one() {
        // Ordering on a restart can deliver a Finished before the Started that replaced it. An
        // agent conjured from a half-report would have no lane and a status nothing set.
        let fleet = Fleet::new();
        fleet.report(Report::Finished {
            id: "ghost".into(),
            ok: true,
            at: 100,
        });
        assert!(fleet.snapshot().is_empty());
    }

    #[test]
    fn a_restart_keeps_the_tally_that_shows_it_has_been_restarting() {
        let fleet = Fleet::new();
        let started = |at| Report::Started {
            id: "batch-0@1".into(),
            lane: "batch".into(),
            at,
        };
        fleet.report(started(100));
        fleet.report(Report::Finished {
            id: "batch-0@1".into(),
            ok: false,
            at: 110,
        });
        fleet.report(started(120));

        let agent = &fleet.snapshot()[0];
        assert_eq!(agent.failed, 1, "the failure count is the evidence");
        assert_eq!(agent.status, AgentStatus::Idle);
    }
}
