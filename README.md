# Lyra

A self-hosted life operating system with AI-powered strategic intelligence.

> Navigate your life by the stars.

## What is Lyra?

Lyra is a self-hosted life operating system: a React SPA and a Rust backend on a mini PC behind a
home router, holding goals, projects, tasks, habits, notes and a multi-chain crypto portfolio in
one entity model. It alerts you on Telegram and Discord, answers questions about your money and your
day from your phone, runs its background work on a durable job queue, and exposes both halves to an
AI client over MCP.

**Where it is going:** [`docs/assistant-roadmap.md`](./docs/assistant-roadmap.md) — commanding the
whole thing from Telegram. The queue underneath it has landed; see [`docs/jobs.md`](./docs/jobs.md).

## Features

### The app
- **One entity model** — 29 types in one table; type-specific fields live in a `metadata` blob, so
  a new module needs no migration
- **Now / Plan / Money** — thirteen sidebar entries grouped by rhythm, each with a `g`-key jump
- **Tasks** — stories with subtasks, kanban and list views, recurrence
- **Projects** — a body of work with a repo, a client and a stack; tasks link through
  `metadata.projectId`, and progress is derived from them rather than stored
- **Goals** — hierarchical, with deadline velocity
- **Habits** — protocols rather than checkboxes; a streak increments only when every step is done
- **Deep Work** — pomodoro, distraction tally, session reflection, focus-minute trackers
- **Notes and Inbox** — one capture surface; the first character decides whether you are finding,
  creating or asking
- **Review** — a weekly wizard that closes the plan → execute → review loop
- **Agents** — the four job workers drawn as desks in an office, with the queue beside them, so "what
  is the box doing, and has any of it been failing" is something you look at rather than grep for

### Wealth
- **Multi-chain portfolio** read keylessly — no private key touches this machine
- **DeFi** — the LP and lending book on one screen: one primary figure, one ledger, detail behind a
  click. Loans share the table with LPs, because the row that can liquidate you should not be the
  row you cannot see
- **Opportunities** — vfat's whole pool universe, filtered server-side, with each APR naming what
  pays it
- **BTC, bots, journal, alerts** — the stack, the KuCoin bots, saved analyses, and the thresholds

### Reaching it from outside
- **Telegram** — eighteen commands: eleven portfolio reads, four that read your day, and three for the
  queue, of which `/retry` and `/cancel` are the only two that write anything. Long-polled so nothing
  is forwarded to this box, and only the pinned chat is ever answered ([docs](./docs/telegram.md))
- **Discord** — the second alert channel; any channel succeeding counts as delivered
  ([docs](./docs/alerts.md))
- **MCP** — `lyra-mcp`, a stdio research desk with seventeen tools: ten wealth and seven life. It
  cannot sign — there is no rung for it on the capability ladder — and `save_analysis` is the only
  tool that writes ([docs](./docs/mcp.md))

### Lyra AI — in the browser
- **Provider-agnostic** — Ollama locally, or any OpenAI-compatible endpoint
- **Twelve tools** in `src/core/ai/tools/` — capture parsing, break-down, risk analysis, priority
  suggestion, session planning, coaching, weekly summary, web search, and four wealth tools
- **Proactive signals** — background detectors feeding a morning brief
- **Graceful degradation** — AI offline means an algorithmic fallback, never a broken state
- **Not an MCP server.** This registry runs in the page and is unreachable from anything outside
  the tab, which is why nothing on a phone can use it

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, Radix/shadcn UI
- **State**: Zustand, TanStack React Query
- **Backend**: Rust (axum + sqlx), SQLite in WAL mode, JWT auth — one binary that also reads the chains, runs the alert sweep, and hosts the four job workers
- **AI**: Ollama (local), OpenAI-compatible API, provider-agnostic
- **Charts**: Recharts
- **PWA**: Offline support via vite-plugin-pwa

## Quick Start

```bash
npm install
npm run dev:safe    # Vite + TypeScript watch

# Enable AI (optional)
brew install ollama
brew services start ollama
ollama pull llama3.2:3b
```

## Release history

See [`CHANGELOG.md`](./CHANGELOG.md), or the changelog dialog inside the app
(`src/lib/changelog-data.ts`). The app version has read 2.5.0 since April while the Rust backend,
the wealth surface, the Telegram bot and the DeFi rewrite shipped underneath it — those are
recorded by date rather than by version.

## Architecture

```
src/
  core/           # Entity types, repositories, hooks, AI system
    ai/           # AI client, tools registry, context builders, Sol personality
    hooks/        # useEntities, useTrackers, useRelations, useAIChat
  pages/          # Feature pages (lazy-loaded)
  hooks/          # App hooks: useAI, useMorningBrief, useLyraPulse, useCelebrations
  components/     # Shared UI: AIAction, ViewToggle, view-toggle
  stores/         # Zustand stores: auth, focus, chat, ai, ui
  layout/         # AppLayout, sidebar, top bar
core/             # Rust workspace — the backend
  crates/lyra-api/       # axum HTTP server (the binary you run)
  crates/lyra-db/        # SQLite + forward-only migrations
  crates/lyra-chain/     # multi-chain portfolio reader
  crates/lyra-analytics/ # tier / exposure / strategy maths
  crates/lyra-alerts/    # background sweep, digest, Telegram
  crates/lyra-mcp/       # MCP research desk (separate stdio binary)
  crates/lyra-parity/    # diffs the port against the Python oracle
```

## Documentation

**Picking this up — including as an AI agent? Read [`CLAUDE.md`](./CLAUDE.md) first.** It is the
orientation the code cannot give you: the invariants, the mistakes already made here, what the gate
is, and what "done" means.

Then [`docs/README.md`](./docs/README.md), which groups every document by whether it describes
something that runs, something intended, or history.

## License

Private — personal use.
