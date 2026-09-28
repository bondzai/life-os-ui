//! One index over everything you have written, and full-text search across it.
//!
//! **This table owns nothing.** Every row is derived from an `entities` note or a markdown file
//! under `LYRA_KNOWLEDGE_PATH`, and the whole thing can be dropped and rebuilt from those. That is
//! the property to protect: a bug here costs a re-index, never a note. It is also what lets both
//! stores stay exactly as they are — the files git-versioned and editable in any editor, the rows
//! queryable and related — instead of one being made subordinate to the other.
//!
//! Search is SQLite's own FTS5. No extension to load, no model to run, no embedding pass, and
//! nothing to re-index when you change your mind about a model. BM25 answers "where did I write
//! about kucoin fees", which is most of what anyone asks their own notes.
//!
//! # The query is not passed through
//!
//! FTS5 `MATCH` takes a query *language*, not a string: `AND`, `NEAR`, `*`, `^`, `"` and `(` all
//! mean something. Handing it what somebody typed means a stray bracket returns a SQL error
//! instead of results, and `NOT` silently inverts what they meant. [`to_match`] turns typed words
//! into quoted terms, so the only thing the search engine ever sees is a list of literals.

use anyhow::{Context, Result};
use serde::Serialize;
use sqlx::{Row, SqlitePool};

/// Where a note came from, and therefore who owns it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// An `entities` row with `type = 'note'`.
    Entity,
    /// A markdown file under `LYRA_KNOWLEDGE_PATH`.
    File,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Entity => "entity",
            Source::File => "file",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "entity" => Source::Entity,
            _ => Source::File,
        }
    }
}

/// What an ingester hands over. Not what is stored — the store adds its own bookkeeping.
#[derive(Debug, Clone, PartialEq)]
pub struct Indexed {
    pub source: Source,
    /// The entity id, or the path relative to the knowledge root.
    pub reference: String,
    pub title: String,
    pub body: String,
    /// The source's own modification time, which is what decides whether to re-index.
    pub updated_at: i64,
}

/// One search result.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Hit {
    pub id: String,
    pub source: Source,
    pub reference: String,
    pub title: String,
    /// The matching part, with the matched words marked. Built by FTS5, not by string slicing.
    pub snippet: String,
    pub updated_at: i64,
    /// BM25. **Lower is better** — SQLite returns it negated, and sorting it the wrong way is the
    /// classic way to ship a search box that puts the worst result first.
    pub score: f64,
}

/// What one sweep changed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Swept {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
}

pub struct NoteStore {
    pool: SqlitePool,
}

impl NoteStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Replace everything from one source with what the ingester just found.
    ///
    /// Scoped to a single source so the two ingesters cannot delete each other's rows — a file
    /// sweep that ran while the entity sweep was mid-flight would otherwise wipe every note.
    ///
    /// Only rows whose `updated_at` moved are rewritten. That is not only speed: an unchanged row
    /// left alone keeps its FTS entry untouched, so the common sweep does no index work at all.
    pub async fn sweep(&self, source: Source, found: &[Indexed], now: i64) -> Result<Swept> {
        let mut swept = Swept::default();
        let mut tx = self.pool.begin().await.context("indexing notes")?;

        for note in found {
            debug_assert_eq!(
                note.source, source,
                "an ingester handed over a foreign source"
            );
            let existing: Option<i64> =
                sqlx::query_scalar("SELECT updated_at FROM notes WHERE source = ? AND ref = ?")
                    .bind(source.as_str())
                    .bind(&note.reference)
                    .fetch_optional(&mut *tx)
                    .await
                    .context("reading an indexed note")?;

            match existing {
                Some(at) if at == note.updated_at => continue,
                Some(_) => {
                    sqlx::query(
                        "UPDATE notes SET title = ?, body = ?, updated_at = ?, indexed_at = ?
                          WHERE source = ? AND ref = ?",
                    )
                    .bind(&note.title)
                    .bind(&note.body)
                    .bind(note.updated_at)
                    .bind(now)
                    .bind(source.as_str())
                    .bind(&note.reference)
                    .execute(&mut *tx)
                    .await
                    .context("re-indexing a note")?;
                    swept.updated += 1;
                }
                None => {
                    sqlx::query(
                        "INSERT INTO notes (id, source, ref, title, body, updated_at, indexed_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)",
                    )
                    .bind(format!("n-{}", crate::channels::random_id()))
                    .bind(source.as_str())
                    .bind(&note.reference)
                    .bind(&note.title)
                    .bind(&note.body)
                    .bind(note.updated_at)
                    .bind(now)
                    .execute(&mut *tx)
                    .await
                    .context("indexing a note")?;
                    swept.added += 1;
                }
            }
        }

        // Anything from this source the ingester did not mention is gone. Deleted in the same
        // transaction as the writes, so a crash mid-sweep leaves the index as it was rather than
        // as a half-applied version of two different moments.
        let present: Vec<&str> = found.iter().map(|n| n.reference.as_str()).collect();
        let stale: Vec<String> = sqlx::query_scalar("SELECT ref FROM notes WHERE source = ?")
            .bind(source.as_str())
            .fetch_all(&mut *tx)
            .await
            .context("listing indexed notes")?;
        for reference in stale.iter().filter(|r| !present.contains(&r.as_str())) {
            sqlx::query("DELETE FROM notes WHERE source = ? AND ref = ?")
                .bind(source.as_str())
                .bind(reference)
                .execute(&mut *tx)
                .await
                .context("forgetting a deleted note")?;
            swept.removed += 1;
        }

        tx.commit().await.context("committing the index sweep")?;
        Ok(swept)
    }

    /// Search everything, best first.
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let Some(match_query) = to_match(query) else {
            // Nothing searchable in what they typed — punctuation, or whitespace. An empty result
            // rather than an error: they are probably still typing.
            return Ok(Vec::new());
        };
        let limit = limit.clamp(1, 100) as i64;

        let rows = sqlx::query(
            "SELECT notes.id, notes.source, notes.ref, notes.title, notes.updated_at,
                    snippet(notes_fts, 1, '<mark>', '</mark>', '…', 24) AS snippet,
                    bm25(notes_fts) AS score
               FROM notes_fts
               JOIN notes ON notes.rowid = notes_fts.rowid
              WHERE notes_fts MATCH ?
              ORDER BY score
              LIMIT ?",
        )
        .bind(&match_query)
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("searching notes")?;

        Ok(rows
            .iter()
            .map(|row| Hit {
                id: row.get("id"),
                source: Source::parse(&row.try_get::<String, _>("source").unwrap_or_default()),
                reference: row.get("ref"),
                title: row.get("title"),
                snippet: row.try_get("snippet").unwrap_or_default(),
                updated_at: row.try_get("updated_at").unwrap_or(0),
                score: row.try_get("score").unwrap_or(0.0),
            })
            .collect())
    }

    pub async fn count(&self) -> Result<i64> {
        sqlx::query_scalar("SELECT COUNT(*) FROM notes")
            .fetch_one(&self.pool)
            .await
            .context("counting indexed notes")
    }
}

/// Turn what someone typed into an FTS5 query that can only mean what they typed.
///
/// Every token becomes a quoted literal, so `AND`, `NOT`, `NEAR`, `*`, `^`, `(` and `-` lose their
/// operator meaning. Quotes inside a token are doubled, which is FTS5's own escape — without it a
/// single `"` ends the string early and the rest of the query becomes syntax.
///
/// The **last** token gets a prefix `*`, so results appear while you are still typing the word.
/// Returns `None` when nothing searchable survives.
pub fn to_match(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        // Keep only what a tokenizer would index anyway. A token of pure punctuation quoted into
        // the query matches nothing and costs a scan.
        .filter(|term| term.chars().any(char::is_alphanumeric))
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();

    match terms.split_last() {
        None => None,
        Some((last, rest)) => {
            let mut out = rest.join(" ");
            if !out.is_empty() {
                out.push(' ');
            }
            // `"term"*` is the prefix form. Applied only to the last word: prefixing every term
            // makes "the cat" match "theatre catalogue", which reads as the search being broken.
            out.push_str(last);
            out.push('*');
            Some(out)
        }
    }
}

/* ─── links ─── */

/// One `[[wikilink]]` found in a body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    /// What the brackets said, normalised for matching: trimmed, `|alias` and `#heading` removed.
    pub target: String,
    /// The note it resolves to, or `None` for something not written yet.
    pub to_note: Option<String>,
}

/// A note pointing at this one.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Backlink {
    pub id: String,
    pub source: Source,
    pub reference: String,
    pub title: String,
}

/// Something linked to but never written, and how many notes want it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Unwritten {
    pub target: String,
    pub wanted_by: i64,
}

/// Pull the `[[wikilinks]]` out of a body.
///
/// Handles Obsidian's forms: `[[Note]]`, `[[Note|shown as this]]`, `[[Note#heading]]` and the
/// `![[embed]]` prefix. The target is everything before a `|` or `#`, trimmed.
///
/// **Fenced code is skipped.** A `[[` inside a code sample is not a link, and indexing it creates
/// an edge to a note nobody meant — which then shows up as an unwritten note you never intended to
/// write. Inline backticks are not handled: a single-backtick span containing a whole wikilink is
/// rare enough that the extra parser state is not worth it, and the cost of being wrong is one
/// spurious edge rather than a broken note.
pub fn links_in(body: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut fenced = false;

    for line in body.lines() {
        let trimmed = line.trim_start();
        // ``` or ~~~, and any info string after it.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }

        let bytes: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i + 1 < bytes.len() {
            if bytes[i] == '['
                && bytes[i + 1] == '['
                && let Some(end) = find_close(&bytes, i + 2)
            {
                let inner: String = bytes[i + 2..end].iter().collect();
                if let Some(target) = normalise(&inner) {
                    found.push(target);
                }
                i = end + 2;
                continue;
            }
            i += 1;
        }
    }

    // De-duplicated, because `(from_note, target)` is the primary key and one note mentioning
    // another three times is still one edge.
    found.sort();
    found.dedup();
    found
}

fn find_close(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == ']' && chars[i + 1] == ']' {
            return Some(i);
        }
        // An unclosed `[[` that runs into the next one is a typo, not a link across two targets.
        if chars[i] == '[' && chars[i + 1] == '[' {
            return None;
        }
        i += 1;
    }
    None
}

/// `Note|alias` and `Note#heading` both point at `Note`.
fn normalise(inner: &str) -> Option<String> {
    let target = inner
        .split(['|', '#'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    (!target.is_empty()).then_some(target)
}

impl NoteStore {
    /// Rebuild every derived link, resolving each target against the index.
    ///
    /// Run after a sweep rather than inside it, because a link can point at a note the sweep has
    /// not reached yet — resolving as you go would leave the first half of an alphabet unable to
    /// see the second.
    ///
    /// Resolution is **by title**, case-insensitively, and for files also by filename stem. That
    /// is what makes this work whichever editor you use: a title is the one thing both stores
    /// have, so `[[KuCoin fees]]` finds the note wherever it lives.
    pub async fn relink(&self) -> Result<usize> {
        let rows = sqlx::query("SELECT id, source, ref, title, body FROM notes")
            .fetch_all(&self.pool)
            .await
            .context("reading notes to link")?;

        // One lowercase lookup built once, rather than a query per link. At a few thousand notes
        // this is a few hundred kilobytes and turns an O(links x notes) job into O(links).
        let mut by_name: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        for row in &rows {
            let id: String = row.get("id");
            let title: String = row.get("title");
            if !title.trim().is_empty() {
                by_name
                    .entry(title.trim().to_lowercase())
                    .or_insert(id.clone());
            }
            // `wealth/exchanges.md` is also reachable as `exchanges`, which is how anyone
            // actually writes the link.
            if Source::parse(&row.try_get::<String, _>("source").unwrap_or_default())
                == Source::File
            {
                let reference: String = row.get("ref");
                if let Some(stem) = reference
                    .rsplit('/')
                    .next()
                    .and_then(|f| f.strip_suffix(".md"))
                {
                    by_name.entry(stem.trim().to_lowercase()).or_insert(id);
                }
            }
        }

        let mut tx = self.pool.begin().await.context("relinking")?;
        // Derived wholesale, so rebuilt wholesale. This is exactly why these edges are not in
        // `relations`: doing this to that table would delete what you drew by hand.
        sqlx::query("DELETE FROM note_links")
            .execute(&mut *tx)
            .await
            .context("clearing derived links")?;

        let mut written = 0;
        for row in &rows {
            let from: String = row.get("id");
            let body: String = row.get("body");
            for target in links_in(&body) {
                let to = by_name.get(&target.to_lowercase());
                // A note linking to itself is a typo or a heading reference, never an edge worth
                // drawing — and it would put every note in its own backlinks.
                if to == Some(&from) {
                    continue;
                }
                sqlx::query(
                    "INSERT INTO note_links (from_note, target, to_note) VALUES (?, ?, ?)
                     ON CONFLICT(from_note, target) DO NOTHING",
                )
                .bind(&from)
                .bind(&target)
                .bind(to)
                .execute(&mut *tx)
                .await
                .context("writing a derived link")?;
                written += 1;
            }
        }

        tx.commit().await.context("committing derived links")?;
        Ok(written)
    }

    /// The index's id for a note, given where it came from.
    ///
    /// Callers hold an entity id or a file path; every link call wants the index id. Without this
    /// they pass what they have, get an empty list rather than an error, and ship a backlinks
    /// panel that is simply always empty.
    pub async fn id_of(&self, source: Source, reference: &str) -> Result<Option<String>> {
        sqlx::query_scalar("SELECT id FROM notes WHERE source = ? AND ref = ?")
            .bind(source.as_str())
            .bind(reference)
            .fetch_optional(&self.pool)
            .await
            .context("looking up an indexed note")
    }

    /// What this note points at. `id` is the **index** id — see [`Self::id_of`].
    pub async fn links_from(&self, id: &str) -> Result<Vec<Link>> {
        let rows = sqlx::query(
            "SELECT target, to_note FROM note_links WHERE from_note = ? ORDER BY target",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .context("reading a note's links")?;
        Ok(rows
            .iter()
            .map(|row| Link {
                target: row.get("target"),
                to_note: row.try_get("to_note").unwrap_or(None),
            })
            .collect())
    }

    /// What points at this note. The indexed direction.
    pub async fn backlinks(&self, id: &str) -> Result<Vec<Backlink>> {
        let rows = sqlx::query(
            "SELECT notes.id, notes.source, notes.ref, notes.title
               FROM note_links
               JOIN notes ON notes.id = note_links.from_note
              WHERE note_links.to_note = ?
              ORDER BY notes.title COLLATE NOCASE",
        )
        .bind(id)
        .fetch_all(&self.pool)
        .await
        .context("reading backlinks")?;
        Ok(rows
            .iter()
            .map(|row| Backlink {
                id: row.get("id"),
                source: Source::parse(&row.try_get::<String, _>("source").unwrap_or_default()),
                reference: row.get("ref"),
                title: row.get("title"),
            })
            .collect())
    }

    /// Linked to, never written — the notes you meant to write, most-wanted first.
    pub async fn unwritten(&self, limit: usize) -> Result<Vec<Unwritten>> {
        let limit = limit.clamp(1, 200) as i64;
        let rows = sqlx::query(
            "SELECT target, COUNT(*) AS wanted_by
               FROM note_links
              WHERE to_note IS NULL
              GROUP BY target COLLATE NOCASE
              ORDER BY wanted_by DESC, target COLLATE NOCASE
              LIMIT ?",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .context("reading unwritten notes")?;
        Ok(rows
            .iter()
            .map(|row| Unwritten {
                target: row.get("target"),
                wanted_by: row.try_get("wanted_by").unwrap_or(0),
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn store() -> (TempDir, NoteStore) {
        let dir = TempDir::new().unwrap();
        let pool = crate::open_and_migrate(&dir.path().join("lyra.db"))
            .await
            .unwrap();
        (dir, NoteStore::new(pool))
    }

    fn note(source: Source, reference: &str, title: &str, body: &str, at: i64) -> Indexed {
        Indexed {
            source,
            reference: reference.into(),
            title: title.into(),
            body: body.into(),
            updated_at: at,
        }
    }

    #[tokio::test]
    async fn both_stores_are_searchable_from_one_query() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(
                    Source::Entity,
                    "ent-1",
                    "KuCoin fees",
                    "the taker fee is 0.1% and the maker fee is lower",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();
        notes
            .sweep(
                Source::File,
                &[note(
                    Source::File,
                    "wealth/exchanges.md",
                    "Exchanges",
                    "kucoin withdrawal fees are charged per asset",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();

        let hits = notes.search("kucoin fees", 10).await.unwrap();
        assert_eq!(hits.len(), 2, "one query reaches both stores");
        // The row remembers where to go back to.
        let sources: Vec<Source> = hits.iter().map(|h| h.source).collect();
        assert!(sources.contains(&Source::Entity) && sources.contains(&Source::File));
        assert!(
            hits.iter().any(|h| h.snippet.contains("<mark>")),
            "the matched words are marked: {:?}",
            hits[0].snippet
        );
    }

    /// Lower is better. Sorting BM25 the wrong way is how a search box ships with the worst
    /// result first, and it looks like the ranking is random rather than reversed.
    #[tokio::test]
    async fn the_best_match_comes_first() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[
                    note(
                        Source::Entity,
                        "a",
                        "Passing mention",
                        "we also pay fees",
                        1000,
                    ),
                    note(
                        Source::Entity,
                        "b",
                        "Fees",
                        "fees, fees and more fees: taker fees, maker fees, withdrawal fees",
                        1000,
                    ),
                ],
                1000,
            )
            .await
            .unwrap();

        let hits = notes.search("fees", 10).await.unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].reference, "b", "the dense one wins");
        assert!(
            hits[0].score <= hits[1].score,
            "bm25 is negated: lower is better"
        );
    }

    /// The sweep is incremental, and it is scoped to its own source.
    #[tokio::test]
    async fn re_indexing_touches_only_what_changed_and_never_the_other_store() {
        let (_dir, notes) = store().await;
        let file = note(Source::File, "a.md", "A", "alpha", 1000);
        notes
            .sweep(Source::File, std::slice::from_ref(&file), 1000)
            .await
            .unwrap();
        notes
            .sweep(
                Source::Entity,
                &[note(Source::Entity, "e1", "E", "entity note", 1000)],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(notes.count().await.unwrap(), 2);

        // Same mtime: nothing to do.
        let again = notes
            .sweep(Source::File, std::slice::from_ref(&file), 2000)
            .await
            .unwrap();
        assert_eq!(
            again,
            Swept::default(),
            "an unchanged file is not re-indexed"
        );

        // Changed body and mtime: one update, and the entity row is untouched.
        let edited = note(Source::File, "a.md", "A", "alpha and omega", 1100);
        let after = notes.sweep(Source::File, &[edited], 2000).await.unwrap();
        assert_eq!(after.updated, 1);
        assert_eq!(after.added + after.removed, 0);
        assert_eq!(notes.count().await.unwrap(), 2, "the entity note survived");
        assert_eq!(
            notes.search("omega", 5).await.unwrap().len(),
            1,
            "fts saw the edit"
        );

        // A file that has gone leaves the index, and still nothing happens to the other store.
        let gone = notes.sweep(Source::File, &[], 3000).await.unwrap();
        assert_eq!(gone.removed, 1);
        assert_eq!(notes.count().await.unwrap(), 1);
        assert_eq!(notes.search("entity", 5).await.unwrap().len(), 1);
    }

    /* ─── links ─── */

    #[test]
    fn every_form_of_wikilink_resolves_to_the_same_target() {
        assert_eq!(links_in("see [[KuCoin fees]] today"), vec!["KuCoin fees"]);
        // An alias and a heading both point at the note, not at the alias or the heading.
        assert_eq!(links_in("[[KuCoin fees|the fees]]"), vec!["KuCoin fees"]);
        assert_eq!(links_in("[[KuCoin fees#taker]]"), vec!["KuCoin fees"]);
        assert_eq!(
            links_in("![[KuCoin fees]]"),
            vec!["KuCoin fees"],
            "an embed is a link"
        );
        assert_eq!(links_in("[[ spaced ]]"), vec!["spaced"], "trimmed");
        // Three mentions is one edge — `(from_note, target)` is the primary key.
        assert_eq!(links_in("[[a]] [[a]] [[a]]"), vec!["a"]);
    }

    /// A `[[` in a code sample is not a link. Indexing it invents an edge nobody meant, which
    /// then shows up as a note you are told you meant to write.
    #[test]
    fn brackets_inside_fenced_code_are_not_links() {
        let body = "real [[Alpha]]\n```rust\nlet x = arr[[0]];\n// [[Beta]]\n```\nalso [[Gamma]]";
        assert_eq!(links_in(body), vec!["Alpha", "Gamma"]);

        // Tildes fence too, and an info string after the ticks still opens one.
        let tilde = "~~~\n[[Hidden]]\n~~~\n[[Shown]]";
        assert_eq!(links_in(tilde), vec!["Shown"]);
        let info = "```python\n[[Hidden]]\n```\n[[Shown]]";
        assert_eq!(links_in(info), vec!["Shown"]);
    }

    #[test]
    fn a_broken_bracket_is_not_a_link_across_two_targets() {
        // Unclosed: the scan must not run on and swallow the next link's opening.
        assert_eq!(links_in("[[unclosed and [[Alpha]]"), vec!["Alpha"]);
        assert_eq!(links_in("[[]]"), Vec::<String>::new(), "empty is nothing");
        assert_eq!(links_in("[single]"), Vec::<String>::new());
    }

    #[tokio::test]
    async fn a_link_resolves_by_title_across_both_stores() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(
                    Source::Entity,
                    "e1",
                    "Daily log",
                    "see [[KuCoin fees]] and [[exchanges]]",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();
        notes
            .sweep(
                Source::File,
                &[
                    note(
                        Source::File,
                        "money/kucoin-fees.md",
                        "KuCoin fees",
                        "0.1%",
                        1000,
                    ),
                    note(
                        Source::File,
                        "money/exchanges.md",
                        "Where I trade",
                        "kucoin, binance",
                        1000,
                    ),
                ],
                1000,
            )
            .await
            .unwrap();
        notes.relink().await.unwrap();

        let log = notes.id_of(Source::Entity, "e1").await.unwrap().unwrap();
        let from = notes.links_from(&log).await.unwrap();
        assert_eq!(from.len(), 2);
        // By title...
        assert!(
            from.iter()
                .any(|l| l.target == "KuCoin fees" && l.to_note.is_some())
        );
        // ...and for a file, by its filename stem too, which is how anyone writes the link.
        assert!(
            from.iter()
                .any(|l| l.target == "exchanges" && l.to_note.is_some())
        );

        // And the edge is readable from the other end, which is the whole point.
        let target = notes.search("0.1%", 5).await.unwrap();
        let back = notes.backlinks(&target[0].id).await.unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title, "Daily log");
    }

    #[tokio::test]
    async fn a_link_to_something_unwritten_is_kept_and_counted() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[
                    note(
                        Source::Entity,
                        "a",
                        "A",
                        "[[Tax plan]] and [[Only once]]",
                        1000,
                    ),
                    note(Source::Entity, "b", "B", "also [[tax plan]]", 1000),
                ],
                1000,
            )
            .await
            .unwrap();
        notes.relink().await.unwrap();

        let wanted = notes.unwritten(10).await.unwrap();
        // Two notes want it, and the count is case-insensitive — "Tax plan" and "tax plan" are
        // the same missing note, not two.
        assert_eq!(wanted[0].wanted_by, 2, "{wanted:?}");
        assert_eq!(wanted[0].target.to_lowercase(), "tax plan");
        assert_eq!(wanted[1].wanted_by, 1);
    }

    /// Derived means rebuilt, and a note that goes takes its edges with it.
    #[tokio::test]
    async fn relinking_reflects_the_index_rather_than_accumulating() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(Source::Entity, "a", "A", "[[B]]", 1000)],
                1000,
            )
            .await
            .unwrap();
        notes.relink().await.unwrap();
        let a = notes.id_of(Source::Entity, "a").await.unwrap().unwrap();
        assert_eq!(notes.links_from(&a).await.unwrap().len(), 1);

        // The link is edited out. A second relink must drop the edge, not leave it behind.
        notes
            .sweep(
                Source::Entity,
                &[note(Source::Entity, "a", "A", "no links now", 1100)],
                1100,
            )
            .await
            .unwrap();
        notes.relink().await.unwrap();
        assert!(notes.links_from(&a).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_note_is_never_its_own_backlink() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(
                    Source::Entity,
                    "a",
                    "Alpha",
                    "see [[Alpha]] above",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();
        notes.relink().await.unwrap();
        let a = notes.id_of(Source::Entity, "a").await.unwrap().unwrap();
        // Otherwise every note with a heading reference lists itself, and the panel is noise.
        assert!(notes.backlinks(&a).await.unwrap().is_empty());
    }

    /// FTS5 `MATCH` is a query language. Handing it raw input is a syntax error waiting for a
    /// bracket, and an inverted search waiting for the word "not".
    #[test]
    fn what_someone_types_is_never_an_operator() {
        assert_eq!(
            to_match("kucoin fees").as_deref(),
            Some(r#""kucoin" "fees"*"#)
        );
        // Operators are literals.
        assert_eq!(to_match("a AND b").as_deref(), Some(r#""a" "AND" "b"*"#));
        assert_eq!(to_match("NOT done").as_deref(), Some(r#""NOT" "done"*"#));
        // A quote is doubled, not left to end the string early.
        assert_eq!(
            to_match(r#"say "hi""#).as_deref(),
            Some(r#""say" """hi"""*"#)
        );
        // A lone bracket would be a syntax error; it has no alphanumerics, so it is dropped.
        assert_eq!(to_match("fees (").as_deref(), Some(r#""fees"*"#));
        assert_eq!(to_match("   ").as_deref(), None);
        assert_eq!(to_match("!!!").as_deref(), None);
    }

    #[tokio::test]
    async fn a_query_of_punctuation_is_empty_rather_than_an_error() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(Source::Entity, "a", "A", "alpha", 1000)],
                1000,
            )
            .await
            .unwrap();
        // Each of these is a syntax error if passed to MATCH unescaped.
        for hostile in ["(", "\"", "*", "NEAR(", "a OR", "-"] {
            assert!(
                notes.search(hostile, 5).await.is_ok(),
                "{hostile:?} must not reach MATCH as syntax"
            );
        }
    }

    #[tokio::test]
    async fn results_appear_before_the_last_word_is_finished() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(
                    Source::Entity,
                    "a",
                    "Liquidation",
                    "health factor",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();
        assert_eq!(
            notes.search("healt", 5).await.unwrap().len(),
            1,
            "prefix on the last word"
        );
        // But only the last, or "the cat" would match "theatre catalogue".
        assert!(
            notes.search("healt factor", 5).await.unwrap().is_empty(),
            "an earlier word is matched whole"
        );
    }

    /// The tokenizer is `porter`, and that is a choice worth pinning rather than discovering.
    ///
    /// It means a search for one form of a word finds the others — which is what anyone wants of
    /// their own prose — and also that "liquid" finds "liquidation", because both stem to the same
    /// root. Surprising once, right the rest of the time.
    #[tokio::test]
    async fn a_word_finds_its_other_forms() {
        let (_dir, notes) = store().await;
        notes
            .sweep(
                Source::Entity,
                &[note(
                    Source::Entity,
                    "a",
                    "Liquidation",
                    "the fees were rising",
                    1000,
                )],
                1000,
            )
            .await
            .unwrap();

        assert_eq!(
            notes.search("fee", 5).await.unwrap().len(),
            1,
            "fee finds fees"
        );
        assert_eq!(
            notes.search("rise", 5).await.unwrap().len(),
            1,
            "rise finds rising"
        );
        assert_eq!(
            notes.search("liquid", 5).await.unwrap().len(),
            1,
            "and liquid finds liquidation, which is the same rule seen from the other side"
        );
    }
}
