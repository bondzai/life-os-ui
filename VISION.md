# Lyra — Life OS

A private, self-hosted life management system for families, powered by proactive AI intelligence.

One interface to plan, track, and automate everything — goals, health, wealth, skills, home infrastructure — with a local AI assistant that monitors your data and surfaces insights before you ask.

---

## Table of Contents

1. [Overview](#overview)
2. [Principles](#principles)
3. [Users](#users)
4. [Architecture](#architecture)
5. [Core Engine](#core-engine)
6. [Modules](#modules)
7. [Lyra AI](#lyra-ai)
8. [Proactive Intelligence](#proactive-intelligence)
9. [Integrations](#integrations)
10. [Automation Engine](#automation-engine)
11. [Tech Stack](#tech-stack)
12. [Roadmap](#roadmap)
13. [Future Projections](#future-projections)

---

## Overview

Lyra (formerly Life-OS) is a long-term personal project — a unified web application that replaces scattered tools (Google Sheets for budgets, random apps for habits, browser tabs for server monitoring) with a single, clean dashboard.

It runs on a local home server, serves a household of two (expandable), and integrates with external services through a plugin-based connector system. The Lyra AI assistant — powered by a local LLM via Ollama — acts as a proactive co-pilot with full context of your data, surfacing insights and coaching without being asked.

**This is not a product. It is infrastructure for life.**

---

## Principles

| Principle | Meaning |
|---|---|
| **Own your data** | Everything runs locally. No third-party SaaS owns your life data. External services are optional connectors. |
| **DRY core, thin modules** | One entity system, one tracker, one automation engine. Modules are configuration over code. |
| **Two users, not two thousand** | Optimize for simplicity and personal utility, not scale. No need for complex multi-tenancy. |
| **AI as co-pilot** | AI reads your data, surfaces insights, and takes actions — but you stay in control. Local-first via Ollama. |
| **Proactive over reactive** | The system should tell you what needs attention before you ask. Pulse detectors, morning briefs, celebrations. |
| **Incremental growth** | Ship one module at a time. Each phase must be independently useful. |
| **Boring technology** | Pick stable, well-documented tools. Avoid hype-driven choices. |

---

## Users

| User | Role | Access |
|---|---|---|
| **JB** | Admin | Full access — all modules, server controls, system config |
| **Wife** | Member | Full access to life modules, optional access to server/infra |

Authentication is lightweight — PIN or local password. No OAuth complexity needed for a home network. Each user has their own dashboard, preferences, and private entities. Shared entities (family goals, household budget) are visible to both.

---

## Architecture

> **Historical.** The diagram below is the Hono + Drizzle design, which was built and then
> replaced. What runs is one Rust binary over SQLite — see
> [`docs/architecture.md`](./docs/architecture.md).

```
┌─────────────────────────────────────────────┐
│                  CLIENTS                    │
│         Browser / PWA / Mobile              │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              LYRA UI                        │
│                                             │
│  Layout ─── Pages ─── Modules ─── Widgets   │
│                   │                         │
│              Core Engine                    │
│   Entities / Trackers / Scheduler / Auth    │
│                   │                         │
│            Lyra AI Layer                    │
│   Sol Personality / Tools / Pulse / Brief   │
│                   │                         │
│           Connector Layer                   │
│   Ollama / Google / GitHub / HomeAssistant  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│            LOCAL API SERVER                  │
│       Hono — runs on home server            │
│                   │                         │
│              Database                       │
│         SQLite via Drizzle ORM              │
└─────────────────────────────────────────────┘
```

**Separation of concerns:**

- **UI** — Presentation, interaction, client state. Knows nothing about databases.
- **API Server** — Business logic, persistence, connector orchestration. Knows nothing about UI.
- **AI Layer** — Sol personality, MCP-style tools, Pulse detectors, context builders. Runs across all modules.
- **Connectors** — Isolated plugins that bridge external services to the core data model.

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
api/              # Hono backend with SQLite
```

---

## Core Engine

Everything in Lyra is built on four primitives. This is the foundation that makes the system DRY — every module reuses the same data structures, CRUD operations, and UI components.

### Entity

The universal record. Every item in the system — a goal, a task, a transaction, a habit, a device — is an Entity.

```
Entity
├── id              unique identifier
├── type            "goal" | "task" | "habit" | "transaction" | "project" | ...
├── title           display name
├── description     optional detail (markdown)
├── status          "active" | "completed" | "archived" | "paused"
├── priority        "low" | "medium" | "high" | "urgent"
├── tags            string[] — flexible categorization
├── metadata        key-value pairs — module-specific fields
├── parentId        optional — for hierarchy (goal → sub-goal)
├── ownerId         which user owns this
├── visibility      "private" | "shared"
├── dueDate         optional deadline
├── createdAt       timestamp
└── updatedAt       timestamp
```

The `metadata` field is intentionally flexible. A transaction entity stores `{ amount, currency, category }` in metadata. A workout stores `{ exercise, sets, reps, weight }`. A project stores `{ stack, velocity, repoUrl }`. This avoids a separate table per module while keeping the core schema stable.

### Tracker

A time-series data point attached to any entity. Used for anything measured over time.

```
Tracker
├── id
├── entityId        links to parent entity
├── value           numeric value
├── unit            "kg" | "hours" | "THB" | "%" | ...
├── note            optional context
├── timestamp       when this was recorded
└── ownerId
```

### Schedule

Defines recurrence for any entity — habits, bills, reviews, automations.

```
Schedule
├── id
├── entityId
├── recurrence      cron expression or simple pattern
├── nextDue         next occurrence timestamp
├── lastCompleted   last completed timestamp
└── isActive        boolean
```

### Relation

Links between entities across modules.

```
Relation
├── fromId          source entity
├── toId            target entity
└── type            "parent" | "blocks" | "relates" | "supports"
```

---

## Modules

> **Historical.** Eight modules are marked complete below and five of them — Health, Family,
> Places, Travel, Memories and the rest — were deleted at v2.5.0 (the Lean release) and have not
> returned. Wealth came back as the Rust-backed module; Projects came back as its own type in
> September. The live list is `src/core/config/modules.ts`; see
> [`docs/modules.md`](./docs/modules.md).

Each module is a thin layer on top of the core engine. 30+ entity types are currently supported.

### Plan *(complete)*

Manage objectives and daily work.

| Feature | Description | Status |
|---|---|---|
| Goals & OKRs | Hierarchical goals with progress tracking and deadline velocity | Done |
| Projects | Online/offline projects with tech stack, velocity, links | Done |
| Tasks | Stories with subtasks, kanban board, list/log views, recurrence | Done |
| Calendar | Unified calendar merging internal events + Google Calendar | Done |

### Capture *(complete)*

Free-form writing and daily reflection.

| Feature | Description | Status |
|---|---|---|
| Notes | Free-form notes with tags, search, pin/favorite | Done |
| Journal | Daily journal entries with mood tracking | Done |
| Decision Journal | Structured decisions with revisit prompts and outcome tracking | Done |

### Grow *(complete)*

Track learning and personal development.

| Feature | Description | Status |
|---|---|---|
| Skills | Mastery levels (novice → expert), rusty detection, practice logging | Done |
| Reading | Book list with status, notes, ratings, reading challenge | Done |
| Habits | Daily streaks, protocols (multi-step checklists), heatmaps | Done |

### Explore *(complete)*

Discover and plan places and trips.

| Feature | Description | Status |
|---|---|---|
| Places | Saved locations on interactive Leaflet map with map picker | Done |
| Travel | Trip planner with itinerary timeline and trip budget | Done |

### Health *(complete)*

Monitor physical and mental well-being.

| Feature | Description | Status |
|---|---|---|
| Body Metrics | Weight, body fat, measurements — charted over time | Done |
| Workouts | Exercise log with heatmap and volume tracking | Done |
| Sleep & Mood | Duration/quality log, mood, energy tracking, trend charts | Done |

### Wealth *(complete)*

Manage household finances.

| Feature | Description | Status |
|---|---|---|
| Budget | Monthly budgets by category with alerts at 80%+ | Done |
| Transactions | Manual log with recurring transactions | Done |
| Net Worth | Account balances, assets, trend chart | Done |
| Portfolio | Crypto, DeFi, stocks, funds — with wallets and ledger | Done |

### Home *(complete)*

Control and monitor home infrastructure.

| Feature | Description | Status |
|---|---|---|
| Devices | Server, desktop, laptop, phone, tablet, router, IoT | Done |
| Services | Status tracking (running/stopped/error) linked to devices | Done |

### Family *(complete)*

Shared space for household coordination.

| Feature | Description | Status |
|---|---|---|
| Chores | Rotating assignments with completion history | Done |
| Activity Feed | Timeline of shared entities | Done |
| Posts | Household feed with reactions, threads, media | Done |
| Shared Goals | Family objectives with progress bars | Done |

---

## Lyra AI

Lyra AI is the intelligence layer that runs across all modules. It is built around three pillars: the Sol personality, MCP-style tools, and proactive detectors.

### Sol — The AI Personality

Sol is an INTJ strategist personality that adapts to time of day and context. Sol is direct, analytical, and focused on helping you execute your strategy.

- **Time-of-day awareness** — morning briefs are energetic and forward-looking; evening reflections are calmer
- **Customizable traits** — adjust directness, verbosity, and coaching style
- **Context-aware** — Sol has access to your entities, trackers, goals, and recent activity

### MCP-Style Tool System

Five registered tools that Sol can invoke:

| Tool | Purpose |
|---|---|
| **suggest-focus** | Analyze priorities and suggest what to work on next |
| **break-down** | Decompose a goal or project into actionable subtasks |
| **analyze-risk** | Identify risks to goals, deadlines, or streaks |
| **coaching** | Provide strategic coaching on decisions or direction |
| **weekly-summary** | Generate a comprehensive weekly review |

### Lyra Page

Full command interface for interacting with Sol:
- **Chat** — conversational interface with full data context
- **Tool Arsenal** — browse and invoke all registered tools
- **Settings** — provider config, personality tuning, context preferences

### Provider-Agnostic

Works with any OpenAI-compatible API:
- **Ollama** (default) — fully local, llama3.2:3b, data never leaves your machine
- **OpenAI** — GPT-4o or similar
- **Claude** — via API
- **Custom** — any endpoint that speaks the OpenAI chat format

### Graceful Degradation

When the AI provider is offline or unavailable:
- Algorithmic fallbacks generate insights from rules and heuristics
- No broken states — the app remains fully functional
- Reconnects automatically when the provider comes back

---

## Proactive Intelligence

> **Historical.** Written before the Lean release; several of the surfaces described here were
> deleted with the Lyra page. The detectors and the morning brief survive in
> `src/core/ai/` — the source is the list; `docs/ai-layer.md` described a Phase-3 shape that no
> longer exists and was deleted. For the *other* MCP, see [`docs/mcp.md`](./docs/mcp.md).

The system that makes Lyra feel alive. Instead of waiting for you to ask, Lyra watches your data and speaks up when something matters.

### Lyra Pulse

Background detector cycle running every 10 minutes:
- Scans 8 signal detectors across all modules
- Surfaces insights as toast notifications
- Non-intrusive — only alerts on meaningful signals

### Signal Detectors

| Detector | What it watches |
|---|---|
| **Streak Risk** | Habits at risk of breaking their streak today |
| **Stale Projects** | Projects with no activity in 7+ days |
| **Budget Alert** | Categories approaching or exceeding budget |
| **Sleep Quality** | Below-average sleep patterns |
| **Energy Trend** | Declining energy levels |
| **Decision Review** | Decisions due for revisit |
| **Achievements** | Milestones reached (streak records, goal completions) |
| **Velocity** | Task/goal completion velocity changes |

### Morning Brief

Daily briefing that aggregates all 8 detectors into an actionable summary. Generated once per day, cached for the session.

### Deep Work Coach

Active during focus sessions (Pomodoro timer):
- Streak alerts when approaching personal records
- Progress updates on current task
- Next-task suggestions when current task completes

### Session Summary

Toast notification on pomodoro completion:
- Tasks completed during the session
- Time spent breakdown
- Suggested next action

### Real-time Celebrations

Instant recognition when you achieve something:
- Streak milestones (7, 30, 90, 365 days)
- Goal completions
- Project milestones

### Dynamic Dashboard

12 signal-driven widgets that appear based on what matters right now:
- **Rules mode** — automation-driven, deterministic widget selection
- **Lyra mode** — AI-driven, Sol decides what to surface

---

## Integrations

Connectors follow a standard interface. Adding a new integration means implementing one plugin.

### Active Connectors

| Connector | Direction | Status |
|---|---|---|
| **Google Calendar** | Pull (iCal) | Done |
| **Ollama** | Bidirectional | Done |

### Planned Connectors

| Connector | Direction | Purpose |
|---|---|---|
| **GitHub** | Pull | Track commits, PRs, contributions |
| **Home Assistant** | Bidirectional | IoT device control and sensor data |
| **Docker API** | Pull + Actions | Container status, restart, logs |
| **Notion** | Pull | Import notes and databases |
| **Bank API** | Pull | Auto-import transactions (future) |
| **Fitbit / Apple Health** | Pull | Auto-import health metrics (future) |

---

## Automation Engine

Event-driven rules that connect triggers to actions.

### Structure

```
Automation
├── name             human-readable label
├── trigger          event that starts the automation
├── conditions[]     optional filters (time, entity type, value thresholds)
├── actions[]        what to do when triggered
└── isActive         on/off toggle
```

### Rule Templates (5 built-in)

| Name | Trigger | Action |
|---|---|---|
| Streak alert | Habit not checked in by evening | Push reminder notification |
| Overspend warning | Category spend > budget | Alert + flag on dashboard |
| Stale project | No project activity in 7 days | Surface on dashboard |
| Goal deadline | Goal due soon, progress < 80% | Suggest action plan |
| Weekly review | Sunday evening | Generate review prompt |

### User-Created Automations

"When / Then" builder in the UI with conditional logic (AND-based conditions), event-driven triggers, dry-run preview, and execution history.

---

## Tech Stack

> **Historical.** The backend named below was built and then replaced: the API is now one
> Rust binary (axum + sqlx), and SQLite is reached through sqlx with forward-only SQL
> migrations rather than Drizzle. This document is kept as the original design intent —
> see [docs/architecture.md](./docs/architecture.md) for what actually runs.


| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript 5.9 | Type safety across UI and API, single language |
| UI Framework | React 19 | Stable, massive ecosystem, long-term support |
| Build Tool | Vite 7 | Fast dev server, minimal config, modern defaults |
| Styling | Tailwind CSS 4 | Utility-first, consistent design, fast iteration |
| Components | Radix / shadcn/ui | Accessible, customizable, you own the code |
| State | Zustand | Minimal boilerplate, scales well |
| API Client | TanStack React Query | Caching, sync, optimistic updates |
| API Server | Hono | Lightweight, TypeScript-native |
| Database | SQLite via Drizzle ORM | Zero-config, file-based, perfect for home server |
| AI | Ollama (local) | Provider-agnostic, OpenAI-compatible API |
| Charts | Recharts | Composable, React-native, good for time-series |
| Auth | JWT | Lightweight, sufficient for local network |
| PWA | vite-plugin-pwa | Installable, offline support |

---

## Roadmap

### Completed Phases

| Phase | Version | Status |
|---|---|---|
| 1 — Foundation | v0.1.0 | Done |
| 2 — Plan (Goals, Tasks, Calendar) | v0.2.0 | Done |
| 3 — AI Layer | v0.3.0 | Done |
| 4 — Grow (Skills, Habits, Reading) | v0.4.0 | Done |
| 4.5 — Capture, Social & Explore | v0.4.5 | Done |
| 5 — Wealth | v0.5.0 | Done |
| 6 — Health | v0.6.0 | Done |
| 7 — Home | v0.7.0 | Done |
| 8 — Family | v0.8.0 | Done |
| 9 — Automate | v0.9.0 | Done |
| 10 — Polish (PWA, Code Splitting) | v0.10.0 | Done |
| 10.5 — Memories | v0.10.5 | Done |
| 11 — Productivity (Today, Inbox, Review) | v0.11.0 | Done |
| 12 — Dashboard v2 & Polish | v0.12.0 | Done |
| 13 — Charts, Agenda, Pomodoro | v0.13.0 | Done |
| 14 — Larger Features | v0.14.0–0.15.0 | Done |
| Projects & Command Center | v0.65.0 | Done |
| Tomahawk — Strategic Arsenal | v0.66.0 | Done |
| Trident — Lyra AI | v1.0.0 | Done |
| Lyra Command Interface | v1.1.0 | Done |
| Dynamic Dashboard | v1.2.0 | Done |
| Proactive Lyra | v1.3.0 | Done |

### Next

- Multi-device sync and conflict resolution
- Mobile-optimized layouts and gestures
- Plugin system for custom modules
- Voice input via local Whisper
- Life analytics — cross-module correlations

---

## Future Projections

Features beyond the current roadmap — not planned, but designed to be possible.

### Near-Term Possibilities

> **Telegram shipped on 2026-08-22** and has been removed from this list. It sends alerts and
> answers eleven portfolio commands; quick-adding entities from it is Stage C of
> [`docs/assistant-roadmap.md`](./docs/assistant-roadmap.md). See
> [`docs/telegram.md`](./docs/telegram.md).

| Feature | Description |
|---|---|
| **Mobile App** | React Native or Capacitor wrapper for native mobile experience |
| **Voice Input** | "Hey Lyra" — voice commands via Web Speech API or local Whisper |
| **Recipe & Meal Planning** | Weekly meal plans linked to nutrition tracking and shopping lists |

### Mid-Term Possibilities

| Feature | Description |
|---|---|
| **Wearable Sync** | Auto-import from Fitbit, Garmin, Apple Watch — steps, heart rate, sleep |
| **Bank Sync** | Auto-import transactions via open banking APIs |
| **Document Vault** | Encrypted storage for important documents |
| **Learning Flashcards** | Spaced repetition system linked to skill/course modules |

### Long-Term Vision

| Feature | Description |
|---|---|
| **Agentic AI** | Sol can execute automations autonomously, not just suggest |
| **Life Analytics** | Cross-module correlations: "You're most productive on days you exercise and sleep 7+ hours" |
| **Family Dashboard TV Mode** | Ambient display for a wall-mounted screen |
| **Offline-First Sync** | Full offline functionality with conflict-free sync when back online |

---

## Project Boundaries

What Lyra is **not**:

- Not a social network — it is private, family-only
- Not a SaaS product — it is self-hosted, no subscription
- Not a replacement for specialized tools where they are better (IDE, email client, photo editor)
- Not trying to be perfect — it is a living system that improves over time

---

*This is a living document. Updated for v1.3.0 — Proactive Lyra.*
