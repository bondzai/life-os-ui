# Lyra documentation

Grouped by whether a document describes something that **runs**, something that was **intended**,
or something that is **history**. The distinction matters here: several files in this directory
spent months describing a product that no longer existed, and the only reliable way to stop that
happening again is to say, on the index, which kind each one is.

## What runs now

| Document | Description |
|---|---|
| [Architecture](./architecture.md) | The real topology, the four ways into Lyra's data, and where inference happens |
| [API server](./api-server.md) | The Rust API — stack, route groups, auth, and the two hazards |
| [MCP](./mcp.md) | The research desk: ten wealth tools, the read-only invariant, and what "MCP" means in this repo |
| [Telegram](./telegram.md) | The command bot — the assistant's front door, and what it cannot do yet |
| [Alerts](./alerts.md) | `lyra-alerts`: rules, digests, the Telegram and Discord channels, and their containment |
| [Core engine](./core-engine.md) | Entity, Tracker, Schedule and Relation — and why `schedules` is not a job queue |
| [Modules](./modules.md) | The sidebar, the Projects type, and the DeFi page rewrite |
| [Parity harness](./parity.md) | Gating the Rust port against the Python oracle |
| [Deployment](./deployment.md) | Running the stack on the mini PC — first run, migration, backups, troubleshooting |

## The plan

| Document | Description |
|---|---|
| [Assistant roadmap](./assistant-roadmap.md) | **Start here for what happens next.** Four parallel designs reconciled into one ordered plan, with the four decisions that gate it |

## Design intent — specs, not state

| Document | Description |
|---|---|
| [Minimalist mind](./minimalist-mind-life-os.md) | The philosophy the Lean release came from |
| [Strategic blueprint](./strategic-blueprint.md) | Where the system is meant to end up |
| [Productivity features](./productivity-features.md) | Today page, Inbox capture, Weekly Review — written against the 17-module app |
| [Improvements](./improvements.md) | Prioritised nice-to-haves — written against the 17-module app |
| [AI layer](./ai-layer.md) | The **browser** AI tool registry. Not an MCP server; see [MCP](./mcp.md) |

## History — kept for the record, not for reference

| Document | Description |
|---|---|
| [OpenClaw integration](./openclaw-integration.md) | A gateway that was never built. Its one surviving idea lives in [Telegram](./telegram.md) |
| [Roadmap](./roadmap.md) | Superseded. Its "completed" half duplicates the changelog; its "planned" half was built differently or abandoned |

## Quick links

- **Vision**: [`VISION.md`](../VISION.md) — the original design document, partly historical
- **Voice**: [`soul.md`](../soul.md) — how Lyra speaks
- **Changelog**: [`CHANGELOG.md`](../CHANGELOG.md), and `src/lib/changelog-data.ts` inside the app
- **Source**: [`src/`](../src/) React 19 + TypeScript + Vite, [`core/`](../core/) the Rust workspace
