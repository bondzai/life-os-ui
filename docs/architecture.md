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
- **Data**: Currently localStorage via `LocalRepository` — will migrate to `ApiRepository` calling Life-OS API

### Life-OS API (planned)

Thin REST server that owns the database. Both the UI and OpenClaw talk to it.

- **Stack**: Hono + SQLite + Drizzle ORM
- **Endpoints**: CRUD for entities, trackers, schedules, relations
- **See**: [API Server docs](./api-server.md)

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
