# Working on Lyra

Read this before touching anything. It is the orientation an agent needs that the code cannot tell
you: what the invariants are, which mistakes have already been made here, and what "done" means.

Lyra is one person's life OS — tasks, habits, notes, calendar, and a wealth module that reads real
wallets and a real exchange. It runs on a mini PC in that person's house and messages them on
Telegram. **There is no staging environment and no second user.** A bug here does not fail a test
suite; it sends a wrong number about someone's money to their phone, or stops their morning brief.
Work accordingly.

## The shape of it

```
core/                 Rust workspace — the whole backend
  crates/lyra-api     the server: HTTP, WebSocket, Telegram bot, job queue. One binary.
  crates/lyra-db      SQLite: schema, migrations, entities, jobs, wealth
  crates/lyra-chain   on-chain reads (EVM + Bitcoin), adapters per protocol
  crates/lyra-alerts  alert rules and delivery (Telegram, Discord)
  crates/lyra-mcp     a separate stdio MCP server — read-only by construction
  crates/lyra-analytics, crates/lyra-parity
src/                  React 19 + TypeScript + Vite
  core/               hooks, repositories, types, config — the shared layer
  pages/              one directory or file per module
  stores/             zustand; `persist` writes to localStorage under `lyra:*`
ops/                  the two service installers and the release puller
docs/                 see docs/README.md — it is a curated index, keep it that way
```

`lyra-api` serves the API **and** the built front end (`LYRA_UI_DIR`), so in production there is one
process, one origin and no CORS. That is why there is no nginx anywhere.

## Getting it running

```bash
make dev          # UI + API together
make dev-api      # just the Rust API, :3001
make check        # what CI runs — do this before you claim anything works
```

Node is pinned in `.nvmrc` (24) and lives under `~/.nvm/versions/node/v24.*/bin`. Rust is pinned in
`core/rust-toolchain.toml`.

**Run cargo from `core/`, not the repo root.** rustup resolves `rust-toolchain.toml` by walking up
from the working directory, *not* from `--manifest-path`. From the root you silently get a different
compiler and a different clippy than the gate uses. This already caused two red CI runs.

## What "done" means

Nothing is done until this is green. Numbers are the current baseline; if yours are lower, you broke
something.

| Check | Command | Baseline |
|---|---|---|
| Rust tests | `cd core && cargo test --workspace` | **1365 pass** |
| Clippy | `cd core && cargo clippy --workspace --all-targets -- -D warnings` | clean |
| Rust format | `cd core && cargo fmt --all --check` | clean |
| Types | `npm run typecheck` | clean |
| Frontend tests | `npm test` | **335 pass, 11 skipped** |
| Lint | `npm run lint` | **58 errors — pre-existing, not a gate** |

`npm run lint` is red and has been for a long time. It runs in CI reporting-only. Do not "fix" it as
a side quest, and do not add to it.

Two gates cannot run here and are not your fault if they do not:

- **Parity** (`make parity`) diffs the Rust port against a Python oracle in a sibling repo that must
  be running on `:8000`. Tolerance is 0.5%. **Adding a field to a gated response fails the diff** —
  that is intended. See `docs/parity.md`.
- **The visual sweep** (`make visual`) drives a real Chrome.

## Invariants — breaking these is how this project gets hurt

**Migrations are append-only.** `core/crates/lyra-db/src/migrations.rs` runs forward-only against
`PRAGMA user_version`. Never edit an existing migration; add one. An older binary **refuses to open a
newer database**, which is why the deploy script health-checks and rolls back rather than leaving a
half-started service.

**SQLite runs in WAL mode.** `lyra.db` on its own is missing whatever is still in `lyra.db-wal`.
Never `cp` a live database and never back up the `.db` alone — use `VACUUM INTO`, which writes one
consistent file with no sidecars. The `data/` *directory* must be writable, not just the file, or the
first write fails with "attempt to write a readonly database".

**`lyra-mcp` is read-only by construction, not by convention.** Three separate things hold it there,
and it is worth knowing which is which before you touch any of them:

- `Startup::from_env` **refuses to boot** if signing material (`PRIVATE_KEY`, `MNEMONIC`,
  `SEED_PHRASE`, …) is in the environment (`server.rs`, `StartupRefused::SigningMaterial`). It
  reports variable *names* only — a diagnostic printing the value would leak the key it is
  complaining about.
- It refuses any transport but stdio.
- No tool body has a signing path and `ALL_CAPABILITIES` has no rung for one. That is enforced by
  **tests** — `the_capability_ladder_has_no_rung_for_signing` and
  `no_tool_accepts_anything_resembling_a_signing_input` in `tools.rs` — not by the compiler. Treat
  those two as load-bearing and do not relax them to make something convenient.

`docs/mcp.md` explains what each guarantee actually buys.

**One writer.** The Telegram bot long-polls `getUpdates`, so two running instances fight over updates
and drop them, and both send the daily digest. There is no safe overlap between the laptop service
and the mini PC.

**The env allowlist is `ops/service-env.list`.** A variable the server reads that is not in that file
works under `cargo run` and is silently absent in production. This has happened. A test
(`the_install_script_forwards_every_setting_the_server_reads`) reads the list and fails naming the
variable and its source file — if it fires, add the key, do not delete the test.

**`VITE_*` variables are build-time.** Vite inlines them. Setting them at runtime does nothing; a
bundle built without `VITE_API_URL=/api` sends every request to a port with nothing on it, and every
page renders its error state against a perfectly healthy server.

**Entities are one table.** `entities` holds every type — task, note, goal, asset — with
type-specific fields in a `metadata` JSON blob. Do not add a table for a new entity type.

## Conventions that are not optional

**Comments say why, not what.** This codebase's comments are unusually dense and that is deliberate:
most of them record a decision or a bug that was actually made, so the next person does not remake
it. Match that. A comment restating the code is noise; a comment explaining why the obvious approach
was wrong is the most valuable thing in the file.

**Tests state a rule in their name.** `an_idle_desk_still_says_what_it_last_did`, not `test_agent_2`.
When you fix a bug, the test name should be the rule the bug broke.

**Before trusting a guard, make it fail.** A test that cannot fail is worse than no test, because it
is believed. Delete a key, invert a condition, confirm the failure names the problem, put it back.

**Say what you did not verify.** If a check was skipped or a claim is inferred rather than tested,
write that down. Confident wrongness costs more here than an admitted gap.

## Deploying

Push to `master`. That is the whole procedure: `release.yml` gates the commit, builds the x86_64
tarball, and publishes a release; the mini PC polls every five minutes and installs it.

The box **pulls** rather than GitHub pushing, because this repository is **public** and a self-hosted
runner on a public repo executes code from anyone's pull request — on a machine inside a home network
with the database on it. Do not add a self-hosted runner. Do not put secrets in CI: nothing needs
them to build.

`docs/deployment.md` is the full procedure, including moving the database and the WSL specifics.

## Where to read next

| If you are working on | Read |
|---|---|
| anything, first | `docs/README.md` — the index |
| the backend's shape | `docs/architecture.md`, `docs/api-server.md` |
| the job queue | `docs/jobs.md` |
| workspaces and authored context | `docs/workspaces.md` |
| alerts and delivery | `docs/alerts.md` |
| the Telegram surface | `docs/telegram.md` |
| the MCP server | `docs/mcp.md` |
| entities, schema | `docs/core-engine.md` |
| the frontend's modules | `docs/modules.md` |
| wealth numbers | `docs/parity.md` — read this before changing any wealth response |
| shipping | `docs/deployment.md` |
| what happens next | `docs/assistant-roadmap.md`, `TODO.md` |

`VISION.md` and the two design-intent documents in `docs/` are older than the code and describe
intent, not state. They are useful for *why*; never cite them for *what is*.

## Things that look broken and are not

- **`docker-compose.yml` and `Dockerfile.ui` still exist** but are not the deployment path. Three of
  the four services existed to do what `LYRA_UI_DIR` now does inside the binary.
- **`core/Dockerfile` does not contain the front end.** A container built from it serves the API
  only.
- **The first alert sweep after a fresh `alert_state` is silent.** It baselines without sending. The
  second one is not silent, and it messages a real phone.
- **A blank wealth page with a healthy server** is a missing environment variable, not a crash. That
  is by design — see `docs/deployment.md` §7.1.
- **`dev-knowledge/*.md` are fixtures**, not documentation. The knowledge module reads them through
  `LYRA_KNOWLEDGE_PATH` and needs their frontmatter.
