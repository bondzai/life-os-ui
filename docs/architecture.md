# Architecture

## Overview

Life-OS is a self-hosted system running on a mini PC (home server). It consists of three main components that share a SQLite database:

```
┌──────────────────────────────────────────────────────┐
│                 MINI PC (Home Server)                 │
│                                                      │
│  ┌────────────┐  ┌────────────┐  ┌───────────────┐  │
│  │  OpenClaw  │  │  Life-OS   │  │  Life-OS UI   │  │
│  │  Gateway   │←→│  API       │←→│  (React SPA)  │  │
│  │  :18789    │  │  :3000     │  │  :5173        │  │
│  └─────┬──────┘  └─────┬──────┘  └───────────────┘  │
│        │               │                             │
│        │          ┌────┴─────┐                       │
│        │          │  SQLite  │                       │
│        │          └──────────┘                       │
└────────┼─────────────────────────────────────────────┘
         │
         ├── Telegram   (JB)
         ├── WhatsApp   (Sunny)
         ├── Signal     (Both)
         └── WebChat    (Fallback)
```

## Components

### Life-OS UI (this repo)

The visual frontend — React 19 SPA with dashboard, kanban boards, calendar, charts. Used when you want the full desktop experience.

- **Stack**: React 19, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **State**: Zustand (client), TanStack Query (server)
- **Data**: `ApiRepository` against the Life-OS API, or `LocalRepository` on browser storage for
  demo mode. Which one is live is a single session-wide decision (`lyra:data-mode`), so the app
  can never show demo entities next to real balances.

### Life-OS API

One Rust binary that owns the database. The UI and OpenClaw both talk to it.

- **Stack**: axum + sqlx over SQLite (WAL). No ORM — forward-only SQL migrations applied at
  startup.
- **Scope**: CRUD for entities, trackers, schedules and relations; git-backed knowledge notes;
  Google Calendar; and the whole wealth surface — multi-chain portfolio, LP and borrow positions,
  trading bots, market data, yield discovery, upstream freshness, the analysis journal and alert
  configuration.
- **Also in-process**: the chain fan-out and the alert sweep, so their upstream caches are shared
  with the request path rather than duplicated, and an alert can never disagree with the page it
  points at.
- **See**: [API Server docs](./api-server.md) and [the parity harness](./parity.md)

### OpenClaw Gateway

Always-on AI agent that connects to messaging platforms. The "eyes, mouth, and hands" of the system.

- **Role**: Natural language interface, autonomous actions, cron jobs, notifications
- **See**: [OpenClaw Integration docs](./openclaw-integration.md)

## Data flow

### From the UI (desktop/laptop)

```
User → Life-OS UI → Life-OS API → SQLite
                  → OpenClaw (for AI chat) → LLM → response
```

### From a chat app (phone, anywhere)

```
User → Telegram/WhatsApp → OpenClaw Gateway → Life-OS API → SQLite
                                            → LLM → response → Telegram/WhatsApp
```

### Automated (cron, triggers)

```
OpenClaw Cron → Life-OS API (query) → OpenClaw (format) → Telegram/WhatsApp
```

## Repository pattern

All data access goes through the `IRepository<T>` interface:

```typescript
interface IRepository<T extends { id: string }> {
  getAll(): Promise<T[]>
  getById(id: string): Promise<T | undefined>
  create(item: T): Promise<T>
  update(id: string, updates: Partial<T>): Promise<T>
  delete(id: string): Promise<void>
  query(predicate: (item: T) => boolean): Promise<T[]>
}
```

Currently implemented by `LocalRepository` (localStorage). Will be swapped to `ApiRepository` (HTTP fetch) when the API server is built. Zero UI changes needed.

## Authentication

- **UI**: PIN-based multi-user login, persisted via Zustand
- **API** (planned): Simple token auth (two users, no need for OAuth)
- **OpenClaw**: DM pairing — each messaging account is linked to a Life-OS user

## Deployment

Everything runs in Docker Compose on the mini PC. See [Deployment docs](./deployment.md).

## Notification System

Client-side only notification system using Zustand with `persist` middleware (key: `life-os:notifications`).

- `notify()` utility in `src/lib/notify.ts` fires both a sonner toast and persists to the notification store
- Bell icon in TopBar shows unread count badge and dropdown with latest 5 notifications
- Full history page at `/notifications` with mark-read and clear-all actions
- Extensible to server-sent events when API server is built

## Map Integration

Leaflet + react-leaflet with OpenStreetMap tiles for the Places and Travel modules.

- No API keys required — OpenStreetMap is free and open-source
- Markers with popups for places, polylines for trip routes
- Default map center: Bangkok (13.7563, 100.5018)
- Leaflet default marker icon fix applied for Vite bundler compatibility

## Scaling Considerations

### Current limits (localStorage era)
- ~5-10 MB storage cap per origin. Sufficient for seed data and light usage, but real daily tracking will exhaust this within months
- All queries are in-memory (fetch all → filter). No performance issues at current scale (~100 entities), but O(n) scan for every render

### API server migration path
- Repository interface (`IRepository<T>`) is the abstraction boundary. Swap `LocalRepository` for `ApiRepository` with zero UI changes
- Push entity type filtering, pagination, and date-range queries to the server
- Add indexed lookups by `type`, `ownerId`, `status`, and `dueDate` in the SQLite schema

### Bundle size
- Single-chunk build (~1.4 MB). Acceptable for a self-hosted LAN app, but add route-based code splitting (`React.lazy`) before exceeding ~2 MB
- Heavy deps: Recharts (~300 KB), Leaflet (~200 KB), dnd-kit (~100 KB). Lazy-load map and chart pages to keep initial load fast

### Multi-user concurrency
- Currently no conflict resolution — last write wins in localStorage. The API server should use optimistic concurrency (updatedAt check) for shared entities
- Two users, low contention — simple timestamp-based conflict detection is sufficient
