# Lyra documentation

Grouped by whether a document describes something that **runs**, something that was **intended**,
or something that is **history**. The distinction matters here: several files in this directory
spent months describing a product that no longer existed, and the only reliable way to stop that
happening again is to say, on the index, which kind each one is.

**New here — including if you are an AI agent picking this up:** start with
[`CLAUDE.md`](../CLAUDE.md) in the repo root. It is the orientation the code cannot give you: the
invariants, the mistakes already made here, what the gate is, and what "done" means. This index tells
you where things are documented; that file tells you what will bite you.

## What runs now

| Document | Description |
|---|---|
| [Architecture](./architecture.md) | The real topology, the four ways into Lyra's data, and where inference happens |
| [API server](./api-server.md) | The Rust API — stack, route groups, auth, and the two hazards |
| [MCP](./mcp.md) | The research desk: seventeen tools, the read-only invariant, and the three things called "MCP" here |
| [Telegram](./telegram.md) | The command bot — the assistant's front door: money, life and queue commands |
| [Alerts](./alerts.md) | `lyra-alerts`: rules, digests, the Telegram and Discord channels, and their containment |
| [Core engine](./core-engine.md) | Entity, Tracker, Schedule and Relation — and why `schedules` is not the job queue |
| [Jobs](./jobs.md) | The queue: lanes, leases, idempotency, backoff, the dead letter, and how to add a kind |
| [Workspaces](./workspaces.md) | Context you author per area of life — where it lives, how it is assembled, and what it is for |
| [Modules](./modules.md) | The sidebar, the Projects type, and the DeFi page rewrite |
| [Parity harness](./parity.md) | Gating the Rust port against the Python oracle |
| [Deployment](./deployment.md) | Running it on the mini PC — the one binary, the systemd unit, the CI pipeline that feeds it, moving the database, backups |

## The plan

| Document | Description |
|---|---|
| [Assistant roadmap](./assistant-roadmap.md) | **Start here for what happens next.** Four parallel designs reconciled into one ordered plan, with the four decisions that gate it |

## Design intent — specs, not state

| Document | Description |
|---|---|
| [Minimalist mind](./minimalist-mind-life-os.md) | The philosophy the Lean release came from |
| [Strategic blueprint](./strategic-blueprint.md) | Where the system is meant to end up |

> Five documents were deleted on 2026-09-25: `roadmap.md` and `openclaw-integration.md` (both
> already bannered as historical; nothing in the OpenClaw one was ever built),
> `productivity-features.md` and `improvements.md` (their specs shipped — Today, Inbox and Review
> are pages, and the improvements list had no unchecked items left), and `ai-layer.md` (it
> documented a deleted widget and knew nothing of the 26 files now under `src/core/ai/`). The one
> paragraph worth keeping, on the three different things called MCP, moved to [MCP](./mcp.md).
> `git log` has all five.

## Quick links

- **Vision**: [`VISION.md`](../VISION.md) — the original design document, partly historical
- **Voice**: [`soul.md`](../soul.md) — how Lyra speaks
- **Changelog**: [`CHANGELOG.md`](../CHANGELOG.md), and `src/lib/changelog-data.ts` inside the app
- **Source**: [`src/`](../src/) React 19 + TypeScript + Vite, [`core/`](../core/) the Rust workspace
