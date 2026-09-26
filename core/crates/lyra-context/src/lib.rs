//! Workspace context: the instructions and knowledge you author for one area of your life.
//!
//! A workspace is an `entities` row with `type = 'workspace'`; **this crate owns none of that.** It
//! owns the prose — a directory per workspace inside the knowledge tree, holding one instruction
//! file and any number of knowledge documents:
//!
//! ```text
//! $LYRA_KNOWLEDGE_PATH/workspaces/<slug>/
//!     LYRA.md            type: instructions   — how to work on this, in your words
//!     architecture.md    type: knowledge
//!     decisions.md       type: knowledge, order: 1
//! ```
//!
//! ## Why a separate crate rather than a module of the API
//!
//! `lyra-api` is a **binary-only** crate — no `lib.rs`, so nothing can link it, and `knowledge.rs`
//! is therefore unreachable from `lyra-mcp`. Serving the same context to the app, to Telegram and
//! to an outside MCP client means exactly one assembler that all three can call, so it has to live
//! somewhere both binaries can depend on. That is the whole reason this crate exists.
//!
//! ## Why files rather than a column
//!
//! This context is authored and then edited for years. Files in a git repo give diffs, history and
//! any editor; a JSON blob in a row gives none of those. The database keeps the workspace's
//! identity, the tree keeps its prose.
//!
//! ## Why `LYRA.md` and not `CLAUDE.md`
//!
//! The repo root already has a `CLAUDE.md` meaning "how to work on this codebase". A second file
//! with the same name and a different audience, in a tree read by the same tools, is how somebody
//! gets a confidently wrong answer a month from now.

use serde::Serialize;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

/* ─── The tree ─── */

/// Where the knowledge tree lives. Matches `lyra-api`'s `knowledge_root` exactly — the two must
/// agree or the app and an MCP client would read different files for the same workspace.
pub fn knowledge_root() -> PathBuf {
    match std::env::var("LYRA_KNOWLEDGE_PATH") {
        Ok(path) if !path.is_empty() => PathBuf::from(path),
        _ => std::env::current_dir()
            .unwrap_or_default()
            .join("..")
            .join("lyra-knowledge"),
    }
}

/// The directory holding every workspace. One level, so a slug cannot nest.
pub fn workspaces_root(root: &Path) -> PathBuf {
    root.join("workspaces")
}

/// The file that carries a workspace's instructions.
pub const INSTRUCTIONS_FILE: &str = "LYRA.md";

/// A slug is a path segment, so it is checked rather than trusted.
///
/// Lowercase alphanumerics, `-` and `_`, non-empty, bounded. This rejects `..`, `/`, absolute
/// paths and anything with a null byte without needing to reason about path semantics — the
/// alternative is resolving a client string against the tree and hoping the guard is right.
pub fn valid_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 64
        && slug
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/* ─── Frontmatter ─── */

/// A bracketed value is a list. JSON is tried first so commas inside quoted items survive; the
/// bare `[a, b]` form is the legacy fallback, and `[]` yields an empty list rather than `[""]`.
pub fn parse_value(raw: &str) -> Value {
    let value = raw.trim();
    if value.starts_with('[') && value.ends_with(']') {
        if let Ok(parsed) = serde_json::from_str::<Value>(value)
            && parsed.is_array()
        {
            return parsed;
        }
        let inner = value[1..value.len() - 1].trim();
        if inner.is_empty() {
            return json!([]);
        }
        return Value::Array(
            inner
                .split(',')
                .map(|s| Value::String(s.trim().replace(['\'', '"'], "")))
                .collect(),
        );
    }
    Value::String(value.to_string())
}

/// Splits a `---` delimited header from the body. A file without a header is all body.
pub fn parse_frontmatter(content: &str) -> (Map<String, Value>, String) {
    let normalized = content.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return (Map::new(), content.to_string());
    };
    let Some(end) = rest.find("\n---") else {
        return (Map::new(), content.to_string());
    };

    let header = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n');

    let mut frontmatter = Map::new();
    for line in header.split('\n') {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            || value.trim().is_empty()
        {
            continue;
        }
        frontmatter.insert(key.to_string(), parse_value(value));
    }
    (frontmatter, body.trim().to_string())
}

/// Arrays are JSON-encoded so commas and quotes round-trip.
pub fn serialize_frontmatter(frontmatter: &Map<String, Value>, body: &str) -> String {
    let mut lines = vec!["---".to_string()];
    for (key, value) in frontmatter {
        let rendered = match value {
            Value::Array(_) => serde_json::to_string(value).unwrap_or_else(|_| "[]".into()),
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        lines.push(format!("{key}: {rendered}"));
    }
    lines.push("---".into());
    lines.push(String::new());
    lines.push(body.to_string());
    lines.push(String::new());
    lines.join("\n")
}

/// Resolves a client path against a root, refusing anything that escapes it.
pub fn resolve_within(root: &Path, relative: &str) -> Option<PathBuf> {
    let root = normalize(root);
    let candidate = normalize(&root.join(relative));
    (candidate == root || candidate.starts_with(&root)).then_some(candidate)
}

/// Lexical `..`/`.` resolution — deliberately not `canonicalize`, which requires the path to exist
/// and would therefore reject the traversal check for a file being created.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/* ─── Assembly ─── */

/// One authored document.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Doc {
    /// Relative to the workspace directory, so `decisions.md`, not an absolute path.
    pub path: String,
    pub frontmatter: Map<String, Value>,
    pub body: String,
    /// `updated` from the frontmatter, else the file's mtime as `YYYY-MM-DD`.
    pub updated: String,
}

/// A document that exists and was not included, and why.
///
/// Named rather than silently omitted, on the same discipline as the wealth envelope's
/// `UNAVAILABLE`: a model that knows a document was cut can ask for it, while one handed a quietly
/// shortened context answers confidently from half the picture.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Dropped {
    pub path: String,
    pub bytes: usize,
    pub why: &'static str,
}

/// Everything the workspace has to say, in the order it should be read.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Context {
    pub slug: String,
    /// `LYRA.md`'s body. `None` when the workspace has a directory but no instruction file, which
    /// is a real state — a workspace can be created before it is written.
    pub instructions: Option<String>,
    pub knowledge: Vec<Doc>,
    pub dropped: Vec<Dropped>,
    /// Bytes of instructions + included bodies. The caller decides what that costs in tokens; this
    /// crate refuses to guess at a tokenizer it cannot see.
    pub bytes: usize,
}

/// How much prose to hand over.
///
/// Bytes, not tokens, and deliberately so: the model is chosen at request time by the browser and
/// can be any OpenAI-compatible endpoint, so there is no tokenizer here to be right with. A byte
/// budget is honest about being approximate. Roughly four bytes per token is the usual rule.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub bytes: usize,
}

impl Default for Budget {
    /// 64 KiB — about 16k tokens of authored prose, which is a lot of writing about one workspace
    /// and still leaves room in a 32k window for the conversation and the data context.
    fn default() -> Self {
        Self { bytes: 64 * 1024 }
    }
}

/// The slugs that have a directory, sorted.
pub fn list(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(workspaces_root(root)) else {
        return out;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if valid_slug(&name) {
            out.push(name);
        }
    }
    out.sort();
    out
}

/// Read and assemble one workspace's context.
///
/// Returns `None` when the workspace has no directory — distinct from a directory with nothing in
/// it, which returns a `Context` with no instructions and no knowledge. "You have not written this
/// yet" and "there is no such workspace" are different answers and the caller should be able to
/// tell them apart.
pub fn assemble(root: &Path, slug: &str, budget: Budget) -> Option<Context> {
    if !valid_slug(slug) {
        return None;
    }
    let dir = workspaces_root(root).join(slug);
    if !dir.is_dir() {
        return None;
    }

    let mut instructions = None;
    let mut docs: Vec<Doc> = Vec::new();
    for path in collect_md(&dir) {
        let Some(doc) = read_doc(&dir, &path) else {
            continue;
        };
        if doc.path == INSTRUCTIONS_FILE {
            instructions = Some(doc.body);
        } else {
            docs.push(doc);
        }
    }

    // `order:` first for anything that declares one, then alphabetical. Alphabetical is the
    // fallback rather than mtime: a context that reorders itself because a file was touched makes
    // two runs of the same question differ for no reason the reader can see.
    docs.sort_by(|a, b| {
        order_of(a)
            .cmp(&order_of(b))
            .then_with(|| a.path.cmp(&b.path))
    });

    // Instructions are never dropped. They are authored, short by construction, and the one thing
    // whose absence changes the answer rather than thinning it.
    let mut bytes = instructions.as_ref().map_or(0, |s| s.len());
    let mut knowledge = Vec::new();
    let mut dropped = Vec::new();
    for doc in docs {
        let cost = doc.body.len();
        if bytes + cost > budget.bytes {
            dropped.push(Dropped {
                path: doc.path,
                bytes: cost,
                why: "over the context budget",
            });
            continue;
        }
        bytes += cost;
        knowledge.push(doc);
    }

    Some(Context {
        slug: slug.to_string(),
        instructions,
        knowledge,
        dropped,
        bytes,
    })
}

/// `order:` as a number, or `i64::MAX` so undeclared documents sort after declared ones.
fn order_of(doc: &Doc) -> i64 {
    match doc.frontmatter.get("order") {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(i64::MAX),
        // The frontmatter parser stores every scalar as a string, so a declared `order: 1` arrives
        // here as `"1"`. Parsing it is not leniency, it is reading what the parser produces.
        Some(Value::String(s)) => s.trim().parse().unwrap_or(i64::MAX),
        _ => i64::MAX,
    }
}

/// `.md` files directly inside a workspace directory, sorted. One level deep on purpose: nested
/// directories invite a hierarchy nobody maintains, and the ordering is `order:` anyway.
fn collect_md(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !name.ends_with(".md") {
            continue;
        }
        let path = entry.path();
        if path.is_file() {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn read_doc(dir: &Path, path: &Path) -> Option<Doc> {
    let content = std::fs::read_to_string(path).ok()?;
    let (frontmatter, body) = parse_frontmatter(&content);
    let relative = path
        .strip_prefix(dir)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();

    let updated = match frontmatter.get("updated") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => std::fs::metadata(path)
            .and_then(|m| m.modified())
            .map(|t| {
                chrono::DateTime::<chrono::Utc>::from(t)
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap_or_default(),
    };

    Some(Doc {
        path: relative,
        frontmatter,
        body,
        updated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn tree(files: &[(&str, &str)]) -> TempDir {
        let dir = TempDir::new().unwrap();
        for (path, content) in files {
            let full = dir.path().join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, content).unwrap();
        }
        dir
    }

    #[test]
    fn a_slug_cannot_climb_out_of_the_tree() {
        // The guard is on the slug's alphabet rather than on the resolved path. Anything that is
        // not a plain segment is refused before it is joined to anything.
        for bad in [
            "..",
            "../etc",
            "a/b",
            "/abs",
            "UPPER",
            "",
            "with space",
            "nul\0",
        ] {
            assert!(!valid_slug(bad), "{bad:?} must not be a slug");
        }
        for good in ["lyra", "wealth", "side-project", "shop_2"] {
            assert!(valid_slug(good), "{good:?} should be a slug");
        }
        let dir = tree(&[("workspaces/lyra/LYRA.md", "hi")]);
        assert!(assemble(dir.path(), "../..", Budget::default()).is_none());
    }

    #[test]
    fn a_missing_workspace_and_an_unwritten_one_are_different_answers() {
        // "You have not written this yet" must not read as "there is no such workspace": the first
        // is a prompt to write, the second is a typo.
        let dir = tree(&[("workspaces/empty/.keep", "")]);
        assert!(assemble(dir.path(), "ghost", Budget::default()).is_none());
        let ctx = assemble(dir.path(), "empty", Budget::default()).expect("the directory exists");
        assert!(ctx.instructions.is_none());
        assert!(ctx.knowledge.is_empty());
    }

    #[test]
    fn instructions_are_lifted_out_and_knowledge_is_ordered() {
        let dir = tree(&[
            (
                "workspaces/lyra/LYRA.md",
                "---\ntype: instructions\n---\nBe terse.",
            ),
            ("workspaces/lyra/zeta.md", "---\norder: 1\n---\nfirst"),
            ("workspaces/lyra/alpha.md", "no frontmatter at all"),
            (
                "workspaces/lyra/beta.md",
                "---\nupdated: 2026-01-02\n---\nsecond",
            ),
            ("workspaces/lyra/notes.txt", "ignored, not markdown"),
        ]);
        let ctx = assemble(dir.path(), "lyra", Budget::default()).unwrap();

        assert_eq!(ctx.instructions.as_deref(), Some("Be terse."));
        // `order: 1` wins; the rest fall back to alphabetical, not to mtime.
        let order: Vec<&str> = ctx.knowledge.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(order, ["zeta.md", "alpha.md", "beta.md"]);
        assert_eq!(ctx.knowledge[2].updated, "2026-01-02");
        assert!(ctx.dropped.is_empty());
    }

    #[test]
    fn a_document_over_the_budget_is_named_rather_than_vanishing() {
        // The whole point of `dropped`. A model told "decisions.md was cut" can ask for it; a
        // model handed a quietly shortened context answers from half the picture and sounds sure.
        let big = "x".repeat(400);
        let dir = tree(&[
            ("workspaces/lyra/LYRA.md", "keep me"),
            ("workspaces/lyra/a-small.md", "small"),
            ("workspaces/lyra/b-huge.md", &big),
        ]);
        let ctx = assemble(dir.path(), "lyra", Budget { bytes: 100 }).unwrap();

        assert_eq!(ctx.instructions.as_deref(), Some("keep me"));
        assert_eq!(ctx.knowledge.len(), 1);
        assert_eq!(ctx.knowledge[0].path, "a-small.md");
        assert_eq!(ctx.dropped.len(), 1);
        assert_eq!(ctx.dropped[0].path, "b-huge.md");
        assert_eq!(ctx.dropped[0].bytes, 400);
    }

    #[test]
    fn instructions_survive_a_budget_smaller_than_they_are() {
        // Dropping the instructions would change the answer rather than thin it, so the budget
        // does not apply to them. It is the one file whose absence is a different assistant.
        let dir = tree(&[("workspaces/lyra/LYRA.md", &"i".repeat(500))]);
        let ctx = assemble(dir.path(), "lyra", Budget { bytes: 10 }).unwrap();
        assert_eq!(ctx.instructions.as_ref().unwrap().len(), 500);
        assert_eq!(ctx.bytes, 500);
    }

    #[test]
    fn list_returns_only_directories_that_could_be_a_slug() {
        let dir = tree(&[
            ("workspaces/lyra/LYRA.md", ""),
            ("workspaces/wealth/LYRA.md", ""),
            ("workspaces/NotASlug/LYRA.md", ""),
            ("workspaces/loose.md", ""),
        ]);
        assert_eq!(list(dir.path()), ["lyra", "wealth"]);
    }

    #[test]
    fn frontmatter_round_trips_and_keeps_commas_inside_quoted_items() {
        // Valid JSON, so the JSON branch runs and the comma inside the first item survives. That
        // branch exists for exactly this: the legacy form below cannot express it.
        let (fm, body) =
            parse_frontmatter("---\ntype: core\ntags: [\"a, b\", \"c\"]\n---\nbody here");
        assert_eq!(fm.get("type").unwrap(), "core");
        assert_eq!(fm.get("tags").unwrap(), &json!(["a, b", "c"]));
        assert_eq!(body, "body here");

        // Round-tripping is what makes the JSON branch worth having: `serialize_frontmatter`
        // JSON-encodes arrays, so a read-modify-write of a file does not mangle the list.
        let (again, body2) = parse_frontmatter(&serialize_frontmatter(&fm, &body));
        assert_eq!(again, fm);
        assert_eq!(body2, body);
    }

    #[test]
    fn the_legacy_bare_list_form_still_parses_and_loses_commas() {
        // `[a, b]` is not JSON, so it splits on commas — which means a bare item containing a
        // comma cannot round-trip. Recorded rather than fixed: existing files use this form, and
        // the JSON form above is the way to write one that needs a comma.
        let (fm, _) = parse_frontmatter("---\ntags: [a, b, c]\n---\nbody");
        assert_eq!(fm.get("tags").unwrap(), &json!(["a", "b", "c"]));

        let (quoted, _) = parse_frontmatter("---\ntags: [\"a, b\", c]\n---\nbody");
        assert_eq!(
            quoted.get("tags").unwrap(),
            &json!(["a", "b", "c"]),
            "one bare item makes the whole line legacy, so the quoted comma is lost too"
        );

        let (empty, _) = parse_frontmatter("---\ntags: []\n---\nbody");
        assert_eq!(empty.get("tags").unwrap(), &json!([]), "not [\"\"]");
    }

    #[test]
    fn a_plain_value_stays_a_trimmed_string() {
        assert_eq!(parse_value("  hello  "), json!("hello"));
        assert_eq!(parse_value("2026-09-26"), json!("2026-09-26"));
        // Every scalar is a string, numbers included — which is why `order_of` above parses it
        // back rather than matching on `Value::Number`.
        assert_eq!(parse_value("1"), json!("1"));
    }
}
