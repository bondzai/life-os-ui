---
type: instructions
updated: 2026-09-26
---

# Working on Lyra

This workspace is the Lyra codebase itself — the life OS, its Rust backend and its React front end.

Read `CLAUDE.md` at the repo root before changing anything. It holds the invariants, and the
mistakes already made here, which is the part that is expensive to rediscover.

## What I want from you here

Plain words over jargon. When something is non-obvious, say why it is that way rather than what it
does — the code already says what it does.

Verify a number before you state it. Several documents in this repo were wrong for months about
counts that a `grep` would have settled, and each one was believed because it was written
confidently.

Before trusting a guard, make it fail. A test that cannot fail is worse than no test.

Tell me what you did not check. An admitted gap costs me a minute; a confident wrong answer costs
me an afternoon.

## What is expensive to get wrong

The wealth module reads real wallets and a real exchange. There is no staging environment and no
second user, so a bug here sends a wrong number about my money to my phone. Treat `docs/parity.md`
as binding before changing any wealth response.

Migrations are append-only. An older binary cannot open a newer database.
