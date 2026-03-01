# Life-OS

A private, self-hosted life management system for families.

One interface to plan, track, and automate everything — goals, health, wealth, skills, home infrastructure — powered by AI and running on your own hardware.

---

## Table of Contents

1. [Overview](#overview)
2. [Principles](#principles)
3. [Users](#users)
4. [Architecture](#architecture)
5. [Core Engine](#core-engine)
6. [Modules](#modules)
7. [Integrations](#integrations)
8. [AI Layer](#ai-layer)
9. [Automation Engine](#automation-engine)
10. [Tech Stack](#tech-stack)
11. [Roadmap](#roadmap)
12. [Future Projections](#future-projections)

---

## Overview

Life-OS is a long-term personal project — a unified web application that replaces scattered tools (Google Sheets for budgets, random apps for habits, browser tabs for server monitoring) with a single, clean dashboard.

It runs on a local home server, serves a household of two (expandable), and integrates with external services through a plugin-based connector system. AI acts as a personal assistant with full context of your data.

**This is not a product. It is infrastructure for life.**

---

## Principles

| Principle | Meaning |
|---|---|
| **Own your data** | Everything runs locally. No third-party SaaS owns your life data. External services are optional connectors. |
| **DRY core, thin modules** | One entity system, one tracker, one automation engine. Modules are configuration over code. |
| **Two users, not two thousand** | Optimize for simplicity and personal utility, not scale. No need for complex multi-tenancy. |
| **AI as co-pilot** | AI reads your data, surfaces insights, and takes actions — but you stay in control. |
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

```
┌─────────────────────────────────────────────┐
│                  CLIENTS                    │
│         Browser / PWA / Mobile              │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│              LIFE-OS UI                     │
│                                             │
│  Layout ─── Pages ─── Modules ─── Widgets   │
│                   │                         │
│              Core Engine                    │
│   Entities / Trackers / Scheduler / Auth    │
│                   │                         │
│           Connector Layer                   │
│   Google / GitHub / HomeAssistant / AI      │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│            LOCAL API SERVER                  │
│       REST or tRPC — runs on home server    │
│                   │                         │
│              Database                       │
│         SQLite / PostgreSQL                 │
└─────────────────────────────────────────────┘
```

**Separation of concerns:**

- **UI** — Presentation, interaction, client state. Knows nothing about databases.
- **API Server** — Business logic, persistence, connector orchestration. Knows nothing about UI.
- **Connectors** — Isolated plugins that bridge external services to the core data model.

The UI and API server are developed as separate projects. The UI starts with local/mock data and connects to the real API server when it is ready.

---

## Core Engine

Everything in Life-OS is built on four primitives. This is the foundation that makes the system DRY — every module reuses the same data structures, CRUD operations, and UI components.

### Entity

The universal record. Every item in the system — a goal, a task, a transaction, a habit, a device — is an Entity.

```
Entity
├── id              unique identifier
├── type            "goal" | "task" | "habit" | "transaction" | ...
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

The `metadata` field is intentionally flexible. A transaction entity stores `{ amount, currency, category }` in metadata. A workout stores `{ exercise, sets, reps, weight }`. This avoids a separate table per module while keeping the core schema stable.

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

Examples: body weight over time, daily spending, hours practiced on a skill, mood score, server CPU usage.

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

Examples: a goal is supported by three habits, a project blocks another project, a skill relates to a course.

---

## Modules

Each module is a thin layer on top of the core engine. It defines:
- Which entity types it manages
- Module-specific UI views (dashboard widgets, detail pages)
- Module-specific metadata fields
- Module-specific computed values (streak count, net worth, etc.)

### Plan

Manage objectives and daily work.

| Feature | Description |
|---|---|
| Goals & OKRs | Hierarchical goals with measurable key results and progress tracking |
| Projects | Multi-step initiatives with milestones, linked to goals |
| Tasks | Daily/weekly todos — list view, kanban board, priority sorting |
| Calendar | Unified calendar merging internal events + Google Calendar |

### Grow

Track learning and personal development.

| Feature | Description |
|---|---|
| Skills | Skill inventory with proficiency levels (beginner → expert), practice logging |
| Reading | Book list with status (want / reading / done), notes, ratings |
| Courses | Online courses and certifications with progress tracking |
| Habits | Daily/weekly habit checkins with streak counting and visualizations |

### Health

Monitor physical and mental well-being.

| Feature | Description |
|---|---|
| Body Metrics | Weight, body fat, measurements — charted over time |
| Workouts | Exercise log with routines, volume tracking, personal records |
| Nutrition | Meal logging, calorie and macro tracking (manual or simple presets) |
| Sleep | Duration and quality logging, trend analysis |
| Mental | Mood tracking, stress levels, linked to journal entries |

### Wealth

Manage household finances.

| Feature | Description |
|---|---|
| Budget | Monthly income vs. expense budgets by category |
| Transactions | Manual transaction log (bank sync is a future connector) |
| Net Worth | Track accounts, assets, liabilities — one dashboard |
| Bills | Recurring payment tracking with due date alerts |
| Financial Goals | Savings targets, debt payoff plans with progress |

### Home

Control and monitor home infrastructure.

| Feature | Description |
|---|---|
| Server Dashboard | Docker container status, restart controls, resource usage |
| Services | Uptime monitoring for self-hosted apps (Plex, Nextcloud, etc.) |
| IoT | Device control via Home Assistant — lights, AC, sensors, cameras |
| Network | Connected devices, bandwidth, DNS (Pi-hole) stats |
| Storage | NAS disk usage, backup status, download queue |

### Family

Shared space for household coordination.

| Feature | Description |
|---|---|
| Shared Goals | Family objectives both users contribute to |
| Events | Shared calendar — birthdays, trips, appointments |
| Activity Feed | Timeline of completed tasks, achievements, milestones |
| Chores | Rotating household task assignments |

---

## Integrations

Connectors follow a standard interface. Adding a new integration means implementing one plugin — the core handles scheduling, error handling, and UI discovery.

```
Connector Interface
├── id, name, icon
├── auth config          how to authenticate (OAuth, API key, local)
├── sync()               pull external data → entities
├── push()               push entities → external service
├── health()             connection status check
├── widgets[]            optional dashboard widgets
└── actions[]            optional command bar actions
```

### Planned Connectors

| Connector | Direction | Purpose |
|---|---|---|
| **Google Calendar** | Bidirectional | Sync events and deadlines |
| **Google Tasks** | Bidirectional | Sync todos |
| **GitHub** | Pull | Track commits, PRs, contributions → skill/project progress |
| **Home Assistant** | Bidirectional | IoT device control and sensor data |
| **Docker API** | Pull + Actions | Container status, restart, logs |
| **AI Provider** | Push context, pull responses | Chat, insights, briefs (see AI Layer) |
| **Notion** | Pull | Import notes and databases |
| **Email (IMAP)** | Pull | Surface action items and reminders |
| **Bank API** | Pull | Auto-import transactions (future, region-dependent) |
| **Fitbit / Apple Health** | Pull | Auto-import health metrics (future) |

---

## AI Layer

AI is not a separate module — it is a layer that runs across all modules. Any AI provider that supports the OpenAI-compatible chat API works: OpenAI, Claude (via API), Ollama (fully local), or others.

### Features

**Chat Panel**
A persistent sidebar available on every page. The AI has access to your entities, trackers, and recent activity. Ask it anything about your own data.

- "What did I spend the most on last month?"
- "How is my reading goal progressing?"
- "Summarize my week."

**Command Bar** (`Cmd+K`)
Natural language input that routes to the correct module action.

- "Add a goal to run 5K by June" → creates a goal entity
- "Log 72kg" → adds a body weight tracker entry
- "Turn off bedroom lights" → sends command to Home Assistant
- "Show my budget" → navigates to wealth module

**Daily Brief**
Auto-generated each morning. Summarizes: today's calendar, top priorities, streak status, anomalies (overspending, missed habits), and suggested focus.

**Weekly Review**
AI drafts a weekly reflection: what was accomplished, what slipped, trends in health/wealth/habits, and suggested adjustments.

**Insights**
Passive analysis that surfaces observations:
- "Your sleep quality drops on days you skip exercise."
- "You've been under budget for 3 months — consider increasing your investment allocation."
- "Your TypeScript skill has been inactive for 30 days."

### AI Provider Config

```
AI Config
├── provider         "openai" | "claude" | "ollama" | "custom"
├── endpoint         API URL (default or custom)
├── model            model identifier
├── apiKey           stored locally, never transmitted elsewhere
└── contextWindow    max tokens for context building
```

Switching providers requires changing one config. All AI features continue to work because they use the same prompt templates and context-building logic.

---

## Automation Engine

Event-driven rules that connect triggers to actions. This is what makes Life-OS feel alive — things happen automatically.

### Structure

```
Automation
├── name             human-readable label
├── trigger          event that starts the automation
├── conditions[]     optional filters (time, entity type, value thresholds)
├── actions[]        what to do when triggered
└── isActive         on/off toggle
```

### Example Automations

| Name | Trigger | Action |
|---|---|---|
| Bill reminder | Bill due in 3 days | Send notification + add calendar event |
| Streak alert | Habit not checked in today by 9pm | Push reminder notification |
| Overspend warning | Monthly category spend > budget | Alert + AI spending breakdown |
| Server down | Container health check fails | Notification + attempt auto-restart |
| Morning brief | Cron: 7:00 AM daily | Generate AI daily brief |
| Weekly review | Cron: Sunday 8:00 PM | Generate AI weekly review draft |
| Goal deadline | Goal due date in 7 days, progress < 80% | AI suggests action plan |
| Achievement | Goal/habit milestone reached | Post to family activity feed |

### User-Created Automations

A simple "When → Then" builder in the UI. No code required. Select trigger type, set conditions, pick actions from a list.

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Language | TypeScript | Type safety across UI and API, single language |
| UI Framework | React 19 | Stable, massive ecosystem, long-term support |
| Build Tool | Vite | Fast dev server, minimal config, modern defaults |
| Routing | React Router | Battle-tested, supports nested layouts |
| State | Zustand | Minimal boilerplate, scales well, easy to test |
| Styling | Tailwind CSS | Utility-first, consistent design, fast iteration |
| Components | shadcn/ui | Accessible, customizable, not a dependency — you own the code |
| Forms | React Hook Form + Zod | Schema-driven validation, DRY form logic |
| Charts | Recharts | Composable, React-native, good for time-series |
| API Client | TanStack Query | Caching, sync, optimistic updates |
| API Server | Node.js (Hono or Fastify) | Lightweight, TypeScript-native (separate project) |
| Database | SQLite (via Drizzle ORM) | Zero-config, file-based, perfect for home server |
| AI | OpenAI-compatible API | Swappable — works with OpenAI, Claude API, Ollama |
| Auth | Simple JWT | Lightweight, sufficient for local network |
| Deployment | Docker Compose | Single command to run on home server |

---

## Roadmap

Each phase delivers a working, independently useful increment.

### Phase 1 — Foundation

Scaffold the project, core engine, layout shell, and authentication.

- Project setup (Vite + React + TypeScript + Tailwind + shadcn/ui)
- Layout: sidebar navigation, top bar, responsive shell
- Auth: login screen, user context, route protection
- Core: Entity types, generic CRUD hooks, generic list/detail components
- Dashboard: empty shell with widget slots
- Mock data layer (swap for real API later)

**Outcome:** App runs, users can log in, navigate, and see an empty dashboard.

### Phase 2 — Plan

Goals, tasks, and calendar — the daily driver features.

- Goals: create, edit, track progress, hierarchy (goal → sub-goals)
- Tasks: list view, kanban board, priority, due dates, completion
- Calendar: monthly/weekly/daily views, internal events
- Google Calendar connector (read-only sync first, then bidirectional)
- Dashboard widgets: today's tasks, upcoming events, goal progress

**Outcome:** Replace Google Tasks / Todoist. Daily planning happens in Life-OS.

### Phase 3 — AI

Chat, command bar, and daily briefs.

- AI provider config and swappable provider system
- Chat sidebar: context-aware conversation with your data
- Command bar (`Cmd+K`): natural language → entity creation / navigation
- Daily brief: auto-generated morning summary
- Prompt templates and context builder

**Outcome:** AI becomes the primary way to interact with Life-OS.

### Phase 4 — Grow

Skills, habits, and learning.

- Skills: inventory, proficiency levels, practice logging, charts
- Habits: daily checkin, streak tracking, calendar heatmap
- Reading: book list, status, notes
- GitHub connector: pull contributions into skill tracking
- Dashboard widgets: streak counter, skill progress

**Outcome:** Track personal development in one place.

### Phase 5 — Wealth

Household budget and financial tracking.

- Transactions: manual log, categorization, search/filter
- Budget: monthly budgets by category, progress bars
- Net worth: account balances, assets, liabilities, trend chart
- Bills: recurring payment tracker, due date alerts
- Dashboard widgets: monthly spend, budget health, net worth

**Outcome:** Replace spreadsheet-based budgeting.

### Phase 6 — Health

Body, exercise, sleep, and mental health.

- Body metrics: weight and measurement logging, trend charts
- Workouts: exercise log, routine templates, personal records
- Sleep: duration/quality log, trend chart
- Mood: daily mood logging, correlation with other metrics
- Dashboard widgets: weight trend, workout streak, sleep average

**Outcome:** Unified health tracking without third-party apps.

### Phase 7 — Home

Server and smart home control.

- Docker connector: container list, status, restart, logs viewer
- Service monitor: uptime checks, response time, status page
- Home Assistant connector: device list, toggle controls, sensor readings
- Network: device list, bandwidth (if router API available)
- Dashboard widgets: server status, active devices

**Outcome:** Manage home infrastructure from Life-OS instead of SSH + browser tabs.

### Phase 8 — Family

Multi-user features and shared space.

- Shared entities: visibility toggle (private/shared)
- Family dashboard: combined activity feed, shared goals
- Events: shared family calendar
- Chore rotation: assignment and tracking
- User preferences: per-user dashboard layout, theme

**Outcome:** Both users actively use Life-OS as a household tool.

### Phase 9 — Automate

Automation engine and notifications.

- Trigger/action system with rule storage
- Built-in triggers: schedule (cron), entity events, threshold alerts
- Built-in actions: notification, entity creation, AI generation, connector calls
- UI rule builder: "When X → Do Y" visual editor
- Push notifications (PWA or Telegram bot)

**Outcome:** Life-OS works proactively, not just reactively.

### Phase 10 — Polish

Production readiness for daily family use.

- PWA: installable on phone, offline support
- Responsive design: mobile-optimized layouts
- Performance: lazy loading, code splitting, query optimization
- Onboarding: first-run setup wizard
- Data export: JSON/CSV backup, migration tools
- Documentation: self-hosted user guide

**Outcome:** Stable, polished, daily-driver quality.

---

## Future Projections

Features beyond the initial roadmap — not planned, but designed to be possible.

### Near-Term Possibilities

| Feature | Description |
|---|---|
| **Mobile App** | React Native or Capacitor wrapper for native mobile experience |
| **Voice Input** | "Hey Life-OS" — voice commands via Web Speech API or local Whisper |
| **Telegram Bot** | Quick-add entities, receive notifications, check status from Telegram |
| **Shared with Extended Family** | Invite parents/siblings with limited access roles |
| **Recipe & Meal Planning** | Weekly meal plans linked to nutrition tracking and shopping lists |
| **Travel Planning** | Trip entities with checklists, budgets, itineraries, document storage |

### Mid-Term Possibilities

| Feature | Description |
|---|---|
| **Wearable Sync** | Auto-import from Fitbit, Garmin, Apple Watch — steps, heart rate, sleep |
| **Bank Sync** | Auto-import transactions via open banking APIs (region-dependent) |
| **Document Vault** | Encrypted storage for important documents (IDs, contracts, warranties) |
| **Vehicle Maintenance** | Service log, mileage tracking, insurance/tax reminders |
| **Learning Flashcards** | Spaced repetition system linked to skill/course modules |
| **Habit Scoring** | Composite daily score based on completed habits, mood, and sleep |

### Long-Term Vision

| Feature | Description |
|---|---|
| **Local AI Agent** | Fully local LLM (Ollama) that can execute automations, not just suggest |
| **Life Analytics** | Cross-module correlations: "You're most productive on days you exercise and sleep 7+ hours" |
| **Family Dashboard TV Mode** | Ambient display for a wall-mounted screen — calendar, weather, chores, quotes |
| **Plugin Marketplace** | Share custom modules/connectors with other Life-OS users (if open-sourced) |
| **Multi-Household** | Separate Life-OS instances that can share selected data between households |
| **Offline-First Sync** | Full offline functionality with conflict-free sync when back online |

---

## Project Boundaries

What Life-OS is **not**:

- Not a social network — it is private, family-only
- Not a SaaS product — it is self-hosted, no subscription
- Not a replacement for specialized tools where they are better (IDE, email client, photo editor)
- Not trying to be perfect — it is a living system that improves over time

---

## File Structure (Planned)

```
life-os-ui/
├── public/
├── src/
│   ├── core/
│   │   ├── components/       # EntityList, EntityCard, EntityForm, DataTable,
│   │   │                     # Chart, Modal, EmptyState, StatusBadge
│   │   ├── hooks/            # useEntities, useTrackers, useSchedules,
│   │   │                     # useAuth, useConnector, useCommandBar
│   │   ├── stores/           # authStore, entityStore, uiStore
│   │   ├── types/            # Entity, Tracker, Schedule, Relation,
│   │   │                     # User, Connector, Automation
│   │   ├── utils/            # date, format, validation, cn
│   │   └── config/           # module registry, connector registry
│   │
│   ├── modules/
│   │   ├── goals/
│   │   ├── tasks/
│   │   ├── calendar/
│   │   ├── skills/
│   │   ├── habits/
│   │   ├── health/
│   │   ├── wealth/
│   │   ├── home/
│   │   ├── family/
│   │   ├── ai/
│   │   └── automations/
│   │
│   ├── connectors/
│   │   ├── google-calendar/
│   │   ├── github/
│   │   ├── home-assistant/
│   │   ├── docker/
│   │   └── ai-provider/
│   │
│   ├── layout/               # Shell, Sidebar, TopBar, MobileNav
│   ├── pages/                # Route-level page components
│   └── app.tsx
│
├── VISION.md                 # This document
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
└── docker-compose.yml        # For deployment on home server
```

---

*This is a living document. Update it as decisions are made and priorities shift.*
