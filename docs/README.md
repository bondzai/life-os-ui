# Life-OS Documentation

Technical documentation for Life-OS — a private, self-hosted life management system for JB and Sunny.

## Contents

| Document | Description |
|----------|-------------|
| [Architecture](./architecture.md) | System architecture, data flow, and deployment topology |
| [Core Engine](./core-engine.md) | Entity, Tracker, Schedule, Relation primitives |
| [AI Layer](./ai-layer.md) | Swappable AI providers, chat, command bar, daily brief |
| [OpenClaw Integration](./openclaw-integration.md) | OpenClaw as always-on agent hub on mini PC |
| [API Server](./api-server.md) | Planned REST API (Hono + SQLite + Drizzle) |
| [Modules](./modules.md) | Module registry and per-module details |
| [Deployment](./deployment.md) | Docker Compose setup for the home server |
| [Roadmap](./roadmap.md) | Phase-by-phase implementation plan |
| [Productivity Features](./productivity-features.md) | Today page, Inbox capture, Weekly Review wizard |

## Quick links

- **Vision**: [`VISION.md`](../VISION.md) — the original design document
- **Source**: [`src/`](../src/) — React 19 + TypeScript + Vite
- **Repo**: `git@github.com:bondzai/life-os-ui.git`
