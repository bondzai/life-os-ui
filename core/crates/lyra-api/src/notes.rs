//! Keeping the note index fed, and searching it.
//!
//! Two ingesters, one definition of what a note is. Neither store is subordinate: the entity rows
//! stay queryable and related, the markdown files stay git-versioned and editable in any editor —
//! including by Obsidian pointed at the same folder. The index is derived from both and owns
//! nothing, so getting it wrong costs a re-index rather than a note.
//!
//! # Why this replaces `knowledge::search`
//!
//! That endpoint reads **every file off the disk on every keystroke**, lowercases each whole body,
//! and asks `contains`. It has no ranking, no snippets, and it cannot see an `entities` note at
//! all. This does one indexed query instead, over both stores, ranked by BM25. The old route stays
//! for now because the knowledge page calls it; it should go once that page moves across.
//!
//! # The sweep's cost
//!
//! The file half reads and parses every markdown file, so it runs on its own slow clock rather
//! than on the tick — a few hundred files is milliseconds, but it is disk work and it buys nothing
//! at 30-second resolution. The entity half is one query. Neither re-indexes a row whose source
//! has not changed, so the steady state writes nothing at all.

use std::time::Duration;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use lyra_db::notes::{Indexed, NoteStore, Source, Swept};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::auth::AuthUser;
use crate::common::error;

/// How often the index catches up with the two stores.
///
/// Two minutes, for the same reason the health dots use it: a note you saved ten seconds ago being
/// findable in two minutes is fine, and walking the knowledge directory every thirty seconds is
/// disk work that buys nothing.
const SWEEP_EVERY: Duration = Duration::from_secs(120);

/// Bodies longer than this are indexed truncated.
///
/// A note is prose; anything past a quarter of a megabyte is a pasted log or a data dump, and
/// indexing it in full costs the FTS table far more than the one hit it would ever produce.
const MAX_BODY: usize = 256 * 1024;

/// Bring the index up to date with both stores. Returns what changed.
pub async fn sweep(state: &AppState) -> Swept {
    let store = NoteStore::new(state.pool.clone());
    let now = lyra_db::jobs::now_secs();
    let mut total = Swept::default();

    for (source, found) in [
        (Source::Entity, from_entities(state).await),
        (Source::File, from_files().await),
    ] {
        match store.sweep(source, &found, now).await {
            Ok(swept) => {
                total.added += swept.added;
                total.updated += swept.updated;
                total.removed += swept.removed;
            }
            // One store failing must not stop the other being indexed, and must not take the
            // caller down: this runs on the sweep's tick beside the money alerts.
            Err(e) => tracing::error!(source = source.as_str(), error = %e, "indexing notes"),
        }
    }

    // After both stores, never inside one: a link can point at a note the other ingester has not
    // reached yet, and resolving as you go leaves half an alphabet unable to see the other half.
    // Only when something moved — relinking rebuilds every edge, so doing it on an idle sweep is
    // the one expensive thing in an otherwise free loop.
    if total != Swept::default() {
        match store.relink().await {
            Ok(links) => tracing::debug!(links, "derived links rebuilt"),
            Err(e) => tracing::error!(error = %e, "rebuilding derived links"),
        }
    }

    if total != Swept::default() {
        tracing::info!(
            added = total.added,
            updated = total.updated,
            removed = total.removed,
            "note index updated"
        );
    }
    total
}

/// Start the indexer on its own clock, beside the alert loop.
///
/// A separate task rather than a step in `alert_loop`, because the file half is disk work on a
/// slower cadence and threading a second timer through that loop would make both harder to read.
pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        loop {
            sweep(&state).await;
            tokio::time::sleep(SWEEP_EVERY).await;
        }
    });
}

/// Notes held as entity rows.
async fn from_entities(state: &AppState) -> Vec<Indexed> {
    let rows = sqlx::query_as::<_, (String, Option<String>, Option<String>, Option<String>)>(
        "SELECT id, title, description, updatedAt FROM entities WHERE type = 'note'",
    )
    .fetch_all(&state.pool)
    .await;

    match rows {
        Ok(rows) => rows
            .into_iter()
            .map(|(id, title, description, updated)| Indexed {
                source: Source::Entity,
                reference: id,
                title: title.unwrap_or_default(),
                body: clamp(&description.unwrap_or_default()),
                // `updatedAt` is an ISO string in this table. Parsed to epoch seconds so the
                // comparison against the file half's mtime is the same kind of number; an
                // unparseable value re-indexes every sweep, which is wasteful but never wrong.
                updated_at: updated
                    .and_then(|at| chrono::DateTime::parse_from_rfc3339(&at).ok())
                    .map(|at| at.timestamp())
                    .unwrap_or(0),
            })
            .collect(),
        Err(e) => {
            tracing::error!(error = %e, "reading entity notes to index");
            Vec::new()
        }
    }
}

/// Notes held as markdown files under `LYRA_KNOWLEDGE_PATH`.
async fn from_files() -> Vec<Indexed> {
    let root = lyra_context::knowledge_root();
    let paths = crate::knowledge::collect_files(&root);

    let mut found = Vec::with_capacity(paths.len());
    for path in paths {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(relative) = path.strip_prefix(&root) else {
            continue;
        };
        let (frontmatter, body) = lyra_context::parse_frontmatter(&content);

        // The mtime, not the frontmatter's `updated`: the frontmatter is written by hand and is
        // routinely stale, and an index that trusts it silently stops seeing edits.
        let updated_at = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        found.push(Indexed {
            source: Source::File,
            reference: relative.to_string_lossy().to_string(),
            title: frontmatter
                .get("title")
                .and_then(|t| t.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                }),
            body: clamp(&body),
            updated_at,
        });
    }
    found
}

/// Cut a body on a character boundary. A byte slice would panic on the first note containing an
/// emoji or an accented name, which is not a hypothetical in a wallet journal.
fn clamp(body: &str) -> String {
    if body.len() <= MAX_BODY {
        return body.to_string();
    }
    body.chars().take(MAX_BODY / 4).collect()
}

/* ─── HTTP ─── */

#[derive(Debug, Deserialize)]
pub struct Ask {
    pub q: Option<String>,
    pub limit: Option<usize>,
}

/// `GET /api/notes/search?q=` — everything you have written, ranked.
pub async fn search(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(ask): Query<Ask>,
) -> Response {
    let query = ask.q.unwrap_or_default();
    if query.trim().is_empty() {
        // Not an error. An empty box is the normal state of a search box.
        return Json(json!({ "hits": [], "query": "" })).into_response();
    }

    match NoteStore::new(state.pool.clone())
        .search(&query, ask.limit.unwrap_or(20))
        .await
    {
        Ok(hits) => Json(json!({ "hits": hits, "query": query })).into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("searching notes: {e}"),
        ),
    }
}

/// `GET /api/notes/{id}/links` — what it points at, and what points back.
pub async fn links(
    _user: AuthUser,
    State(state): State<AppState>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    let store = NoteStore::new(state.pool.clone());
    match (store.links_from(&id).await, store.backlinks(&id).await) {
        (Ok(out), Ok(back)) => Json(json!({ "links": out, "backlinks": back })).into_response(),
        (Err(e), _) | (_, Err(e)) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("reading links: {e}"),
        ),
    }
}

/// `GET /api/notes/unwritten` — linked to, never written. The notes you meant to write.
pub async fn unwritten(_user: AuthUser, State(state): State<AppState>) -> Response {
    match NoteStore::new(state.pool.clone()).unwritten(50).await {
        Ok(wanted) => Json(json!({ "unwritten": wanted })).into_response(),
        Err(e) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("reading unwritten notes: {e}"),
        ),
    }
}

/// `POST /api/notes/reindex` — catch up now rather than waiting for the clock.
pub async fn reindex(_user: AuthUser, State(state): State<AppState>) -> Response {
    let swept = sweep(&state).await;
    match NoteStore::new(state.pool.clone()).count().await {
        Ok(indexed) => Json(json!({
            "indexed": indexed,
            "added": swept.added,
            "updated": swept.updated,
            "removed": swept.removed,
        }))
        .into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("counting: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn app() -> (TempDir, AppState) {
        let dir = TempDir::new().unwrap();
        let pool = lyra_db::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, AppState::new(pool, "test-secret".into()))
    }

    async fn add_note(state: &AppState, id: &str, title: &str, body: &str, updated: &str) {
        sqlx::query(
            "INSERT INTO entities (id, type, title, description, updatedAt) \
             VALUES (?, 'note', ?, ?, ?)",
        )
        .bind(id)
        .bind(title)
        .bind(body)
        .bind(updated)
        .execute(&state.pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn an_entity_note_becomes_searchable() {
        let (_dir, state) = app().await;
        add_note(
            &state,
            "ent-1",
            "KuCoin fees",
            "the taker fee is 0.1%",
            "2026-09-01T10:00:00Z",
        )
        .await;

        let swept = sweep(&state).await;
        assert_eq!(swept.added, 1);

        let hits = NoteStore::new(state.pool.clone())
            .search("taker", 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(
            hits[0].reference, "ent-1",
            "the index points back at the row"
        );
        assert_eq!(hits[0].source, Source::Entity);
    }

    /// Only notes. A task called "buy milk" turning up in a note search is the fastest way to
    /// make the search box useless.
    #[tokio::test]
    async fn other_entity_types_are_not_indexed() {
        let (_dir, state) = app().await;
        add_note(&state, "n", "A note", "findable", "2026-09-01T10:00:00Z").await;
        sqlx::query(
            "INSERT INTO entities (id, type, title, description, updatedAt) \
             VALUES ('t', 'task', 'A task', 'findable', '2026-09-01T10:00:00Z')",
        )
        .execute(&state.pool)
        .await
        .unwrap();

        sweep(&state).await;
        let hits = NoteStore::new(state.pool.clone())
            .search("findable", 10)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].reference, "n");
    }

    /// The steady state does no work. A sweep every two minutes forever must not rewrite rows.
    #[tokio::test]
    async fn a_sweep_that_finds_nothing_new_writes_nothing() {
        let (_dir, state) = app().await;
        add_note(&state, "ent-1", "A", "alpha", "2026-09-01T10:00:00Z").await;
        assert_eq!(sweep(&state).await.added, 1);
        assert_eq!(sweep(&state).await, Swept::default(), "idempotent");
        assert_eq!(sweep(&state).await, Swept::default());
    }

    /// A deleted note stops being findable. An index that keeps answering with rows the store no
    /// longer has is worse than no index.
    #[tokio::test]
    async fn deleting_a_note_removes_it_from_the_index() {
        let (_dir, state) = app().await;
        add_note(&state, "ent-1", "A", "alpha", "2026-09-01T10:00:00Z").await;
        sweep(&state).await;
        assert_eq!(
            NoteStore::new(state.pool.clone())
                .search("alpha", 5)
                .await
                .unwrap()
                .len(),
            1
        );

        sqlx::query("DELETE FROM entities WHERE id = 'ent-1'")
            .execute(&state.pool)
            .await
            .unwrap();
        assert_eq!(sweep(&state).await.removed, 1);
        assert!(
            NoteStore::new(state.pool.clone())
                .search("alpha", 5)
                .await
                .unwrap()
                .is_empty()
        );
    }

    /// The sweep and the relink are one operation from the caller's side: index, then resolve.
    #[tokio::test]
    async fn a_swept_note_has_its_links_resolved() {
        let (_dir, state) = app().await;
        add_note(
            &state,
            "log",
            "Daily log",
            "see [[Fees]]",
            "2026-09-01T10:00:00Z",
        )
        .await;
        add_note(&state, "fees", "Fees", "0.1% taker", "2026-09-01T10:00:00Z").await;

        sweep(&state).await;

        let store = NoteStore::new(state.pool.clone());
        let fees = store.id_of(Source::Entity, "fees").await.unwrap().unwrap();
        let back = store.backlinks(&fees).await.unwrap();
        assert_eq!(back.len(), 1, "the link was resolved as part of the sweep");
        assert_eq!(back[0].title, "Daily log");
    }

    /// Writing the missing note makes the edge resolve, with no other change.
    #[tokio::test]
    async fn an_unwritten_note_stops_being_unwritten_when_you_write_it() {
        let (_dir, state) = app().await;
        add_note(
            &state,
            "log",
            "Daily log",
            "see [[Tax plan]]",
            "2026-09-01T10:00:00Z",
        )
        .await;
        sweep(&state).await;

        let store = NoteStore::new(state.pool.clone());
        let wanted = store.unwritten(10).await.unwrap();
        assert_eq!(wanted.len(), 1);
        assert_eq!(wanted[0].target, "Tax plan");

        add_note(&state, "tax", "Tax plan", "later", "2026-09-01T11:00:00Z").await;
        sweep(&state).await;

        assert!(
            store.unwritten(10).await.unwrap().is_empty(),
            "the link resolved once the note existed"
        );
        let tax = store.id_of(Source::Entity, "tax").await.unwrap().unwrap();
        assert_eq!(store.backlinks(&tax).await.unwrap().len(), 1);
    }

    #[test]
    fn a_pasted_log_is_cut_on_a_character_boundary() {
        // A byte cut would panic here on the first multi-byte character it landed in.
        let huge = "é".repeat(MAX_BODY);
        let cut = clamp(&huge);
        assert!(cut.len() <= MAX_BODY);
        assert!(!cut.is_empty());
        assert_eq!(clamp("short"), "short");
    }
}
