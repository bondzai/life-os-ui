//! `/api/workspaces` — the authored context for one area of your life.
//!
//! A workspace has two halves. Its **identity** is an `entities` row with `type = 'workspace'`,
//! which is how it gets a title, a status and a place in the app. Its **context** is a directory of
//! markdown in the knowledge tree, which is how it gets prose you can edit in any editor and
//! diff in git. This module serves the second half; `entities.rs` already serves the first.
//!
//! The assembly itself lives in `lyra-context` rather than here, because `lyra-api` is a
//! binary-only crate and `lyra-mcp` has to be able to serve the same context to an outside model.
//! One assembler, three callers.
//!
//! **Read-only, deliberately.** Context is authored — by you, in an editor or in the app's
//! knowledge page, which already has a `PUT`. Adding a second write path here would mean two ways
//! to change one file and no reason to prefer either.

use axum::Json;
use axum::extract::Path as AxumPath;
use axum::response::{IntoResponse, Response};
use lyra_context::{Budget, INSTRUCTIONS_FILE, assemble, knowledge_root, list, valid_slug};
use serde_json::json;

use crate::auth::AuthUser;

/// Every workspace that has a directory, and whether it has been written yet.
///
/// Reads the tree rather than the `entities` table on purpose: a row with no directory has no
/// context to serve, and a directory with no row is still readable context. The app joins the two
/// by slug; neither side is the sole authority, because losing a row must not lose your prose.
pub async fn index(_user: AuthUser) -> Response {
    let root = knowledge_root();
    let workspaces: Vec<_> = list(&root)
        .into_iter()
        .map(|slug| {
            let written = root
                .join("workspaces")
                .join(&slug)
                .join(INSTRUCTIONS_FILE)
                .is_file();
            json!({ "slug": slug, "written": written })
        })
        .collect();
    Json(json!({ "workspaces": workspaces })).into_response()
}

/// The assembled context for one workspace.
///
/// 404 means there is no such directory; an empty context with `instructions: null` means the
/// workspace exists and has not been written. Those are different answers — the first is a typo,
/// the second is an invitation — and collapsing them into one would make the app unable to say
/// "you have not written this yet".
pub async fn context(_user: AuthUser, AxumPath(slug): AxumPath<String>) -> Response {
    if !valid_slug(&slug) {
        // The same message for a malformed slug as for a missing one: a probe should not learn
        // which of its guesses was the wrong *kind* of wrong.
        return crate::common::not_found("no such workspace");
    }
    match assemble(&knowledge_root(), &slug, Budget::default()) {
        Some(ctx) => Json(ctx).into_response(),
        None => crate::common::not_found("no such workspace"),
    }
}

#[cfg(test)]
mod tests {
    use lyra_context::{Budget, assemble, valid_slug};
    use std::fs;
    use tempfile::TempDir;

    /// The handlers are two lines of glue over `lyra-context`, which has its own tests. What is
    /// worth pinning here is the decision those two lines encode: a traversal attempt and a
    /// missing workspace must be indistinguishable from outside.
    #[test]
    fn a_traversal_attempt_looks_exactly_like_a_missing_workspace() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("workspaces/lyra")).unwrap();
        fs::write(dir.path().join("workspaces/lyra/LYRA.md"), "be terse").unwrap();

        // Both refused, and the handler answers `not_found` for each, so the response cannot be
        // used to distinguish "you guessed a bad path" from "you guessed a name I do not have".
        assert!(!valid_slug("../../etc"));
        assert!(assemble(dir.path(), "../../etc", Budget::default()).is_none());
        assert!(assemble(dir.path(), "nosuchthing", Budget::default()).is_none());

        // And the real one still reads, so the guard is not simply refusing everything.
        let ctx = assemble(dir.path(), "lyra", Budget::default()).unwrap();
        assert_eq!(ctx.instructions.as_deref(), Some("be terse"));
    }
}
