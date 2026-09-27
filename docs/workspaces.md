# Workspaces

A workspace is one area of your life — this codebase, the wealth book, a business — with **context
you author**: how you want it worked on, and what is true about it. The point is that the same
context reaches the app, the Telegram bot, and any outside AI over MCP, instead of living in one
browser tab.

Think of it as a `CLAUDE.md` per area of life, except that a workspace can also be handed to a model
that has never seen your screen.

## The two halves

| | Where | Why there |
|---|---|---|
| **Identity** | an `entities` row, `type = 'workspace'`, `metadata.slug` | a title, a status, a place in the app. No new table — the same rule as every other type |
| **Context** | `$LYRA_KNOWLEDGE_PATH/workspaces/<slug>/*.md` | prose you edit for years wants diffs, history and any editor. A JSON blob in a row gives none of those |

Neither side is the sole authority. A row with no directory has no context to serve; a directory
with no row is still readable context. Losing a row must not lose your writing.

```
$LYRA_KNOWLEDGE_PATH/
  workspaces/
    lyra/
      LYRA.md            type: instructions   — how to work on this, in your words
      conventions.md     type: knowledge, order: 1
      architecture.md    type: knowledge
    wealth/
      LYRA.md
```

**`LYRA.md`, not `CLAUDE.md`.** The repo root already has a `CLAUDE.md` meaning "how to work on this
codebase". A second file with the same name and a different audience, in a tree read by the same
tools, is how somebody gets a confidently wrong answer a month from now.

The frontmatter parser is the knowledge module's, unchanged — arbitrary keys are tolerated and most
are ignored. Three have meaning here:

| Key | Effect |
|---|---|
| `type` | `instructions` on `LYRA.md`; `knowledge` on the rest. Documentation for the reader; the filename is what actually selects the instructions |
| `order` | sorts a document earlier. Undeclared documents follow, alphabetically |
| `updated` | reported as the document's date, in preference to the file's mtime |

Ordering falls back to **alphabetical, not mtime**: a context that reorders itself because a file
was touched makes two runs of the same question differ for a reason the reader cannot see.

## Assembly

`lyra-context::assemble(root, slug, budget)` returns:

```
Context {
    slug,
    instructions: Option<String>,   // LYRA.md's body
    knowledge: [Doc],               // order:, then alphabetical
    dropped: [{ path, bytes, why }],
    bytes,
}
```

**Instructions are never dropped.** They are authored, short by construction, and the one file whose
absence changes the answer rather than thinning it. A budget smaller than the instructions still
returns them whole.

**A document that does not fit is named, not omitted.** This is the same discipline as the wealth
envelope's `UNAVAILABLE`: a model told "`decisions.md` was cut" can ask for it, while one handed a
quietly shortened context answers from half the picture and sounds just as certain.

The budget is in **bytes, not tokens**, and deliberately. The model is chosen at request time and
can be any OpenAI-compatible endpoint, so there is no tokenizer here to be right with; a byte
budget is honest about being approximate. The default is 64 KiB, roughly 16k tokens of prose.

## Why it is a separate crate

`lyra-api` is a **binary-only** crate — no `lib.rs`, so nothing can link it, and `knowledge.rs` was
therefore unreachable from `lyra-mcp`. Serving the same context to the app, to Telegram and to an
outside MCP client needs exactly one assembler that all three can call, so it lives in
`core/crates/lyra-context/`. The frontmatter parser and the traversal guard moved there with it, and
`knowledge.rs` now re-exports them — one parser, not two that drift.

## The API

| | |
|---|---|
| `GET /api/workspaces` | every slug with a directory, and whether `LYRA.md` exists yet |
| `GET /api/workspaces/{slug}/context` | the assembled context |

Both authenticated, both read-only. Writing context is the knowledge module's existing `PUT` — two
write paths to one file would mean no reason to prefer either.

**404 and an empty context are different answers.** No directory is a 404: you mistyped. A directory
with no `LYRA.md` returns `instructions: null`: the workspace exists and you have not written it yet.
The first is a correction, the second is an invitation, and collapsing them would make the app unable
to say "start here".

A slug is validated as a path segment — lowercase alphanumerics, `-`, `_`, at most 64 characters —
rather than resolved and checked afterwards. `..`, `/` and absolute paths are refused before they are
joined to anything. A malformed slug answers exactly like a missing one, so a probe cannot learn
which kind of wrong it was.

## Before it works outside `cargo run`

`LYRA_KNOWLEDGE_PATH` must be set, and **it is not set today**. It is in `ops/service-env.list`, so
both installers forward it — but it has no value in `.env.local`, and unset it defaults to
`../lyra-knowledge` relative to the service's working directory, which for the installed service is
`~/Library/Application Support/Lyra`. That directory does not exist, so `/api/workspaces` answers
with an empty list and nothing anywhere says why.

```bash
printf '\nLYRA_KNOWLEDGE_PATH=%s\n' "$HOME/path/to/lyra-knowledge" >> .env.local
./ops/lyra-server.sh install        # or lyra-server-linux.sh setup on the box
```

This is the same shape of failure the allowlist test exists to prevent, one step further along: the
variable is forwarded correctly and simply has nothing to forward. `dev-knowledge/workspaces/lyra/`
in this repo is the fixture copy, and pointing `LYRA_KNOWLEDGE_PATH` at `dev-knowledge` is the
fastest way to see the endpoint return something real.

## What is not built yet

This is the foundation, not the feature. In order:

1. **MCP** — `prompts/get` carries the instructions, `resources/` carry the knowledge, so any client
   attaches to a workspace and gets its world. The server already implements `prompts/`
   (`long_term_review` is the pattern); `resources/` is unimplemented, and a test currently asserts
   the capability is absent. That test is the right tripwire to have to update on purpose.
   **Read-only, so nothing about `lyra-mcp`'s guarantees changes**: no new writer, and the capability
   ladder keeps having no rung for signing.
2. **Membership** — which tasks and notes belong to a workspace, via `metadata.workspaceId`, needing
   no migration. This is also where `isGoal` in `src/core/types/entity.ts` should stop treating a
   project as a goal; `context-builder.ts` currently derives both from the same predicate, so the
   chat prompt's "Projects" and "Goals" sections are the same set.
3. **The state layer** — open tasks, velocity, recent decisions, scoped to the workspace.
4. **Telegram free text** scoped to a workspace. This needs inference on the server; today every
   model call originates in the browser.
5. **Memory** — what the assistant learned, with provenance. Last on purpose: it is the only part
   that points a write at your box, and it is the one that would touch the read-only invariant.

There is deliberately **no frontend hook yet**. A hook nothing calls is dead code, and the first real
consumer of this endpoint is the MCP surface above rather than a page. The workspace page arrives
with membership, when there is something to show on it.
