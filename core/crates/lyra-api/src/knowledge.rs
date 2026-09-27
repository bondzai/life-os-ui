//! `/api/knowledge` — port of `api/src/routes/knowledge.ts`.
//!
//! A markdown directory (`LYRA_KNOWLEDGE_PATH`) with YAML-ish frontmatter, version-controlled by
//! shelling out to `git`. Two safety properties from the original are preserved exactly:
//!
//! * **Path traversal is rejected.** A client-supplied path is resolved and must stay inside the
//!   knowledge root, so `../../etc/passwd` cannot be read or written (`knowledge.ts:106`).
//! * **Git is invoked without a shell**, arguments passed as a list, so user-controlled paths and
//!   commit messages cannot inject commands (`knowledge.ts:115`).

use axum::Json;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::AppState;
use crate::auth::AuthUser;

// `knowledge_root`, the frontmatter parser and the traversal guard now live in `lyra-context`,
// because `lyra-mcp` needs them too and `lyra-api` is a binary crate nothing can link. Re-exported
// rather than wrapped so the call sites below — and their tests — are unchanged, and so there is
// exactly one parser to be right about.
pub use lyra_context::{knowledge_root, parse_frontmatter, resolve_within, serialize_frontmatter};

#[derive(Debug, Clone, PartialEq)]
pub struct KnowledgeFile {
    pub path: String,
    pub name: String,
    pub frontmatter: Map<String, Value>,
    pub body: String,
    pub updated_at: String,
}

impl KnowledgeFile {
    fn to_json(&self) -> Value {
        json!({
            "path": self.path,
            "name": self.name,
            "frontmatter": self.frontmatter,
            "body": self.body,
            "updatedAt": self.updated_at,
        })
    }
}

/* ─── Frontmatter ─── */

/* ─── Filesystem ─── */

/// Recursively collects `.md` files, skipping dotfiles and the `templates` directory.
pub fn collect_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "templates" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            files.extend(collect_files(&path));
        } else if name.ends_with(".md") {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn read_file(root: &Path, path: &Path) -> std::io::Result<KnowledgeFile> {
    let content = std::fs::read_to_string(path)?;
    let (frontmatter, body) = parse_frontmatter(&content);
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    // `updated` from the frontmatter when it is a string; the file's mtime only otherwise, which
    // avoids a stat syscall per file when listing.
    let updated_at = match frontmatter.get("updated") {
        Some(Value::String(s)) => s.clone(),
        _ => {
            let modified = std::fs::metadata(path).and_then(|m| m.modified())?;
            chrono::DateTime::<chrono::Utc>::from(modified)
                .format("%Y-%m-%d")
                .to_string()
        }
    };

    Ok(KnowledgeFile {
        name: relative
            .strip_suffix(".md")
            .unwrap_or(&relative)
            .to_string(),
        path: relative,
        frontmatter,
        body,
        updated_at,
    })
}

/// `git add` + `git commit`, no shell. A failure means "nothing to commit" and is ignored, as in
/// the original.
fn git_commit(root: &Path, file: &Path, message: &str) {
    let _ = Command::new("git")
        .args(["add"])
        .arg(file)
        .current_dir(root)
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", message])
        .current_dir(root)
        .output();
}

fn today() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}

/* ─── Routes ─── */

/// `GET /api/knowledge`
pub async fn list(State(_state): State<AppState>, _user: AuthUser) -> Response {
    let root = knowledge_root();
    if !root.exists() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Knowledge path not found", "path": root.to_string_lossy() })),
        )
            .into_response();
    }
    let files: Vec<Value> = collect_files(&root)
        .iter()
        .filter_map(|p| read_file(&root, p).ok())
        .map(|f| f.to_json())
        .collect();
    Json(files).into_response()
}

/// `GET /api/knowledge/file/{*path}`
pub async fn get_file(
    State(_state): State<AppState>,
    _user: AuthUser,
    AxumPath(path): AxumPath<String>,
) -> Response {
    let root = knowledge_root();
    let Some(full) = resolve_within(&root, &path).filter(|p| p.exists()) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response();
    };
    match read_file(&root, &full) {
        Ok(file) => Json(file.to_json()).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "reading knowledge file");
            (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UpdateBody {
    #[serde(default)]
    pub frontmatter: Map<String, Value>,
    #[serde(default)]
    pub body: String,
}

/// `PUT /api/knowledge/file/{*path}`
pub async fn put_file(
    State(_state): State<AppState>,
    _user: AuthUser,
    AxumPath(path): AxumPath<String>,
    Json(mut payload): Json<UpdateBody>,
) -> Response {
    let root = knowledge_root();
    let Some(full) = resolve_within(&root, &path).filter(|p| p.exists()) else {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response();
    };

    payload
        .frontmatter
        .insert("updated".into(), Value::String(today()));
    let content = serialize_frontmatter(&payload.frontmatter, &payload.body);
    if let Err(e) = std::fs::write(&full, content) {
        tracing::error!(error = %e, "writing knowledge file");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Write failed" })),
        )
            .into_response();
    }
    git_commit(&root, &full, &format!("update: {path}"));

    match read_file(&root, &full) {
        Ok(file) => Json(file.to_json()).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct LogBody {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
}

/// `POST /api/knowledge/log`
pub async fn create_log(
    State(_state): State<AppState>,
    _user: AuthUser,
    Json(payload): Json<LogBody>,
) -> Response {
    if payload.title.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Title required" })),
        )
            .into_response();
    }

    let root = knowledge_root();
    let date = today();
    let slug = slugify(&payload.title);
    let full = root.join("log").join(format!("{date}-{slug}.md"));

    let mut frontmatter = Map::new();
    frontmatter.insert("type".into(), Value::String("log".into()));
    frontmatter.insert("tags".into(), json!([]));
    frontmatter.insert("date".into(), Value::String(date.clone()));
    frontmatter.insert("updated".into(), Value::String(date));

    let content = serialize_frontmatter(
        &frontmatter,
        &format!("# {}\n\n{}", payload.title, payload.body),
    );

    if let Some(parent) = full.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        tracing::error!(error = %e, "creating log directory");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Write failed" })),
        )
            .into_response();
    }
    if let Err(e) = std::fs::write(&full, content) {
        tracing::error!(error = %e, "writing log entry");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Write failed" })),
        )
            .into_response();
    }
    git_commit(&root, &full, &format!("log: {}", payload.title));

    match read_file(&root, &full) {
        Ok(file) => (StatusCode::CREATED, Json(file.to_json())).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response(),
    }
}

/// `title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'entry'`
pub fn slugify(title: &str) -> String {
    let lowered = title.to_lowercase();
    let mut slug = String::with_capacity(lowered.len());
    let mut pending_dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !slug.is_empty() {
                slug.push('-');
            }
            pending_dash = false;
            slug.push(ch);
        } else {
            pending_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "entry".to_string()
    } else {
        trimmed.to_string()
    }
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

/// `GET /api/knowledge/search?q=`
pub async fn search(
    State(_state): State<AppState>,
    _user: AuthUser,
    Query(params): Query<SearchQuery>,
) -> Response {
    let Some(query) = params.q.filter(|q| !q.is_empty()).map(|q| q.to_lowercase()) else {
        return Json(json!([])).into_response();
    };

    let root = knowledge_root();
    let results: Vec<Value> = collect_files(&root)
        .iter()
        .filter_map(|p| read_file(&root, p).ok())
        .filter(|f| {
            f.body.to_lowercase().contains(&query)
                || f.name.to_lowercase().contains(&query)
                || Value::Object(f.frontmatter.clone())
                    .to_string()
                    .to_lowercase()
                    .contains(&query)
        })
        .map(|f| f.to_json())
        .collect();
    Json(results).into_response()
}

/// `GET /api/knowledge/history` — recent commits, `[]` when the directory is not a git repo.
pub async fn history(State(_state): State<AppState>, _user: AuthUser) -> Response {
    let root = knowledge_root();
    let output = Command::new("git")
        .args(["log", "--oneline", "-20", "--format=%h|%s|%ai"])
        .current_dir(&root)
        .output();

    let commits = match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .trim()
            .lines()
            .filter(|l| !l.is_empty())
            .map(|line| {
                let mut parts = line.splitn(3, '|');
                json!({
                    "hash": parts.next().unwrap_or_default(),
                    "message": parts.next().unwrap_or_default(),
                    "date": parts.next().unwrap_or_default(),
                })
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    Json(commits).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // The four `parse_value` cases that used to live here moved to `lyra-context` with the
    // function itself — see `the_legacy_bare_list_form_still_parses_and_loses_commas` and
    // `a_plain_value_stays_a_trimmed_string` there. The frontmatter tests below stay, because they
    // exercise this module's use of it rather than the parser.

    #[test]
    fn splits_frontmatter_from_body() {
        let content = "---\ntype: log\ntags: [\"a\"]\n---\n\n# Title\n\nBody text\n";
        let (frontmatter, body) = parse_frontmatter(content);
        assert_eq!(frontmatter["type"], json!("log"));
        assert_eq!(frontmatter["tags"], json!(["a"]));
        assert_eq!(body, "# Title\n\nBody text");
    }

    #[test]
    fn a_file_without_frontmatter_is_all_body() {
        let (frontmatter, body) = parse_frontmatter("# Just markdown\n");
        assert!(frontmatter.is_empty());
        assert_eq!(body, "# Just markdown\n");
    }

    #[test]
    fn frontmatter_round_trips_through_serialize_and_parse() {
        let mut frontmatter = Map::new();
        frontmatter.insert("type".into(), json!("log"));
        frontmatter.insert("tags".into(), json!(["one, with comma", "two"]));

        let serialized = serialize_frontmatter(&frontmatter, "Body here");
        let (parsed, body) = parse_frontmatter(&serialized);
        assert_eq!(parsed["tags"], json!(["one, with comma", "two"]));
        assert_eq!(parsed["type"], json!("log"));
        assert_eq!(body, "Body here");
    }

    #[test]
    fn path_traversal_is_rejected() {
        let root = Path::new("/srv/knowledge");
        assert!(resolve_within(root, "../../etc/passwd").is_none());
        assert!(resolve_within(root, "../secrets.md").is_none());
        assert_eq!(
            resolve_within(root, "log/entry.md"),
            Some(PathBuf::from("/srv/knowledge/log/entry.md"))
        );
    }

    #[test]
    fn traversal_that_returns_inside_the_root_is_allowed() {
        // `a/../b.md` never leaves the directory, so it is legitimate.
        let root = Path::new("/srv/knowledge");
        assert_eq!(
            resolve_within(root, "a/../b.md"),
            Some(PathBuf::from("/srv/knowledge/b.md"))
        );
    }

    #[test]
    fn collect_skips_dotfiles_templates_and_non_markdown() {
        let dir = TempDir::new().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("log")).unwrap();
        std::fs::create_dir_all(root.join("templates")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("a.md"), "x").unwrap();
        std::fs::write(root.join("log/b.md"), "x").unwrap();
        std::fs::write(root.join("templates/skip.md"), "x").unwrap();
        std::fs::write(root.join(".git/hidden.md"), "x").unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        let files = collect_files(root);
        let names: Vec<String> = files
            .iter()
            .map(|p| p.strip_prefix(root).unwrap().to_string_lossy().into())
            .collect();
        assert_eq!(names, vec!["a.md".to_string(), "log/b.md".to_string()]);
    }

    #[test]
    fn read_file_prefers_frontmatter_updated_over_mtime() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "---\nupdated: 2020-01-02\n---\n\nBody\n").unwrap();

        let file = read_file(dir.path(), &path).unwrap();
        assert_eq!(file.updated_at, "2020-01-02");
        assert_eq!(file.name, "a", "the .md suffix should be dropped");
        assert_eq!(file.path, "a.md");
    }

    #[test]
    fn read_file_falls_back_to_mtime_when_frontmatter_has_no_date() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a.md");
        std::fs::write(&path, "---\ntype: note\n---\n\nBody\n").unwrap();

        let file = read_file(dir.path(), &path).unwrap();
        assert_eq!(file.updated_at.len(), 10, "should be a YYYY-MM-DD date");
    }

    #[test]
    fn slugify_matches_the_javascript_rules() {
        assert_eq!(slugify("Hello World"), "hello-world");
        assert_eq!(slugify("  Trim -- me!  "), "trim-me");
        assert_eq!(slugify("C++ & Rust"), "c-rust");
        assert_eq!(
            slugify("!!!"),
            "entry",
            "an empty slug falls back to 'entry'"
        );
    }
}
