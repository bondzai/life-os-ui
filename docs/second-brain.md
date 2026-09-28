# The second brain

One index over everything you have written, and full-text search across it. **Settings is not
involved** — it indexes itself. The search box lives at the top of the Notes page.

Tables are `notes` and `notes_fts` (migration v12). The indexer is a task beside the alert loop.

## The index owns nothing

Every row is derived from an `entities` note or a markdown file under `LYRA_KNOWLEDGE_PATH`, and
the whole table can be dropped and rebuilt from those. That is the property to protect: a bug here
costs a re-index, never a note.

It is also why both stores feed it rather than one being absorbed into the other. Neither can be
made subordinate without losing something real:

| | keeps | would lose if absorbed |
|---|---|---|
| `entities` notes | queryable, relatable, in the one database | — |
| markdown files | git history, editable in **any** editor including Obsidian | that history |

So: two ingesters, one definition of what a note is. You can point Obsidian at the same folder and
Lyra indexes the vault rather than replacing it.

## FTS5, not embeddings

SQLite ships FTS5. No extension to load, no model to run, no embedding pass, and nothing to
re-index when you change your mind about a model. BM25 answers "where did I write about kucoin
fees", which is most of what anyone asks their own notes.

Embeddings answer a different question — "what else is about this idea in different words" — and
they are worth adding *after* this, not instead of it. Starting with them is the exciting order and
the wrong one: it costs a model, a job pipeline and an Ollama dependency before you can search for
a word.

**External-content FTS5** (`content='notes'`), not a standalone index: a standalone one stores its
own copy of every body, and on a box whose entire database is a single file that is a doubling
nobody asked for. The cost is that SQLite does **not** maintain it for you — the three triggers in
the migration are load-bearing, and without them the table returns stale rows forever, silently.

**The tokenizer is `porter`.** A search for one form of a word finds the others: `fee` finds
`fees`, `rise` finds `rising`. The same rule seen from the other side is that `liquid` finds
`liquidation` — surprising once, right the rest of the time.

## What you type is never an operator

FTS5 `MATCH` takes a query *language*: `AND`, `NOT`, `NEAR`, `*`, `^`, `"` and `(` all mean
something. Passing the box's contents straight through means a stray bracket returns a SQL error
instead of results, and typing the word "not" silently inverts the search.

`notes::to_match` turns typed words into quoted literals, doubling any internal quote — FTS5's own
escape. Only the **last** term gets a prefix `*`, so results appear while you are still typing;
prefixing every term would make "the cat" match "theatre catalogue", which reads as the search
being broken.

## The sweep

Every two minutes, on its own task rather than the alert tick — the file half reads and parses
every markdown file, and that is disk work that buys nothing at 30-second resolution.

- **Scoped per source.** A file sweep cannot delete entity rows and vice versa. Without that, a
  sweep that ran while the other was mid-flight would wipe half the index.
- **Incremental.** A row whose source `updated_at` has not moved is left entirely alone, so the
  steady state writes nothing and touches no FTS entry.
- **Transactional.** Writes and deletions commit together, so a crash mid-sweep leaves the index as
  it was rather than as half of two different moments.
- **mtime, not frontmatter.** A file's `updated:` field is written by hand and is routinely stale;
  an index that trusts it stops seeing edits.
- Bodies over 256KB are indexed truncated. Past that it is a pasted log, not prose.

`POST /api/notes/reindex` catches up now; the Reindex button on the Notes page calls it.

## The snippet is markup, and is not rendered as markup

`snippet()` returns the matching passage with `<mark>` around the hits. The front end splits on the
marker and builds text nodes rather than using `dangerouslySetInnerHTML`. "It is only my own
writing" is exactly the reasoning that lets a pasted code sample become script in a personal tool.

## What this replaces, and what it does not

`GET /api/knowledge/search` reads **every file off the disk on every keystroke**, lowercases each
whole body and asks `contains`. No ranking, no snippets, and it cannot see an `entities` note at
all. The new route does one indexed query over both stores. The old one stays until the knowledge
page moves across; it should go then.

`GET /api/search` is unrelated and stays: despite the name it proxies DuckDuckGo.

## Links, and the notes you meant to write

`[[wikilinks]]` are parsed out of every body during the sweep and resolved into edges. Obsidian's
forms all work: `[[Note]]`, `[[Note|shown as this]]`, `[[Note#heading]]` and `![[embed]]`.

**Resolution is by title**, case-insensitively, and for a file by its filename stem as well — so
`[[exchanges]]` finds `money/exchanges.md`. A title is the one thing both stores have, which is
what makes this work whichever editor you use.

**Not in `relations`.** That table holds edges between *entities*, by entity id; these are edges
between *indexed notes*, by index id. Mixing the two id spaces would make `relations::list` join
against rows that are not there. It also keeps the separation that matters: `relations` is what you
drew by hand and must survive a re-index, `note_links` is derived and is rebuilt wholesale with the
index it came from.

**A link to a note that does not exist is kept, not dropped.** Those are the notes you meant to
write — `GET /api/notes/unwritten` lists them, most-wanted first, counted case-insensitively so
`[[Tax plan]]` and `[[tax plan]]` are one missing note rather than two. Write it and the edge
resolves on the next sweep with nothing else to do.

Three details that are each a bug if got wrong:

- **Fenced code is skipped.** A `[[` in a code sample is not a link; indexing it invents an edge
  and then tells you about a note you never meant to write. Inline backticks are *not* handled —
  a single-backtick span holding a whole wikilink is rare, and the cost is one spurious edge.
- **A note is never its own backlink.** Otherwise every note with a heading reference lists itself
  and the panel is noise.
- **Relinking runs after both ingesters**, never inside one: a link can point at a note the other
  has not reached yet, and resolving as you go leaves half an alphabet unable to see the rest. It
  runs only when a sweep actually changed something, because it rebuilds every edge.

`NoteStore::id_of` converts an entity id or a file path into the index id the link calls want.
Without it a caller passes what it has, gets an empty list rather than an error, and ships a
backlinks panel that is simply always empty.

## Not built

- **Any UI for links.** The edges, the backlinks and the unwritten list are all reachable over
  HTTP and none of them is on a screen yet. That is the next slice.
- **A graph view.** When it happens it should draw the neighbourhood of the note you are reading,
  depth one or two. A global graph is a dead tab by a few thousand nodes.
- **Embeddings and "related notes".** A BLOB of f32 and a brute-force cosine: about 4ms at ten
  thousand notes, which is why this needs no vector database and no ANN index. Local Ollama, one
  queue job per note keyed by note and model version so a re-embed is resumable.
- **Hybrid ranking.** Fusing BM25 and cosine is only worth it once both exist and you can see them
  disagree.
