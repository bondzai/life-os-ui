# Core Engine

The core engine provides four primitives that every module builds on. This keeps the system DRY — a goal, a task, a habit, and a transaction are all entities with different `type` values.

> **`src/core/types/entity.ts` is the authoritative type list**, and `core/crates/lyra-db/src/migrations.rs` is the authoritative schema. Amended 2026-09-21: the status values and the type list below had drifted, and two things that a reader now needs — how a task links to a project, and why `schedules` is not a job queue — were missing entirely.

## Primitives

### Entity

The universal data object. Everything in Life-OS is an entity.

```typescript
interface Entity {
  id: string
  type: EntityType        // 'goal' | 'task' | 'habit' | 'skill' | ...
  title: string
  description?: string
  status: EntityStatus    // 'backlog' | 'todo' | 'in-progress' | 'done' | 'archived'
  priority: EntityPriority // 'low' | 'medium' | 'high' | 'urgent'
  tags: string[]
  metadata: Record<string, unknown>  // type-specific data (progress, amount, etc.)
  parentId?: string       // for sub-entities (sub-goals, sub-tasks)
  ownerId: string         // JB or Sunny
  visibility: 'private' | 'shared'
  dueDate?: string        // ISO date
  createdAt: string
  updatedAt: string
}
```

**29 supported types**, from `goal` and `task` through `wallet` and `crypto-tx`. They live in one
`EntityType` union in `src/core/types/entity.ts`; several belong to pages that no longer exist and
are kept because the rows do.

**One table for every type.** `entities` holds all of them, and type-specific fields live in the
`metadata` JSON blob. That is why adding a module needs no migration, and why a single MCP
`entity_create(type, …)` tool can replace seven per-type ones.

### `metadata.projectId` — how work links to what it is for

A task belongs to a project **or** a goal through `metadata.projectId`. One field, not two, and the
reason is that **ids are unique across types**: a stored id is unambiguous without also recording
which kind of thing it points at. The Projects page matches it against projects, `use-velocity`
matches whatever it was asked about, and a task pointing at a goal simply never matches a project.

Two fields would have meant rewriting every existing row to guess which of the two an old id meant.
The cost of one is that a task belongs to one thing rather than to a project *and* a goal at once.

The same convention is read by `detect-stale-projects`, `detect-velocity`, the morning brief and the
AI context builders, which is why setting that one field makes the velocity panel work with no new
code. **Nothing validates it.** The API accepts any string, so a dangling id is possible and reads
as "Unknown (deleted)" rather than as unassigned — a deliberate distinction, since delete does not
cascade. A model writing this field needs the check a human gets from a dropdown; see
[the roadmap](./assistant-roadmap.md).

### Tracker

Time-series data point linked to an entity. Used for habit check-ins, body metrics, financial transactions.

```typescript
interface Tracker {
  id: string
  entityId: string
  value: number
  unit: string
  note?: string
  timestamp: string
  ownerId: string
}
```

### Schedule

Recurrence definition for an entity. Powers habit reminders, recurring tasks, calendar events.

```typescript
interface Schedule {
  id: string
  entityId: string
  recurrence: string      // cron expression or rrule
  nextDue: string
  lastCompleted?: string
  isActive: boolean
}
```

#### `schedules` is recurrence, not a job queue

It looks like one, and the next person looking for a queue will find it and be wrong.

`schedules` answers *"when is this habit next due"*, and its `nextDue` is the recurrence's own
state. It carries no payload, no attempt count, no lease, no worker and no terminal state. If a
failed job rewrote `nextDue` as a backoff, the user would watch their chores silently slide — the
two concepts share the word "due" and nothing else.

Its readers are the `schedule_list` MCP tool and the `schedule.tick` job. **Nothing in `src/` reads
`schedules` at all** — `scheduleRepository` is exported and never called, and the SPA does task
recurrence on a task's own `dueDate` (`src/pages/tasks/task-helpers.ts`). This document and the
schema comment both used to say the habits page rendered `nextDue`; it does not, so do not go
looking for that reader.

The job queue landed as a separate `jobs` table, and the bridge is one-directional: the
`schedule.tick` job reads `schedules WHERE isActive = 1 AND nextDue <= today` and *enqueues* a
`deliver.telegram` job naming what is due. It never writes `nextDue` — advancing a recurrence is
something you do by completing it — so `schedules` never learns the queue exists. See
[`docs/jobs.md`](./jobs.md).

### Relation

Typed link between two entities. Enables dependency graphs, parent-child trees, cross-module connections.

```typescript
interface Relation {
  id: string
  fromId: string
  toId: string
  type: 'parent' | 'blocks' | 'relates' | 'supports'
}
```

## Repositories

Each primitive has a repository class. In demo mode it extends `LocalRepository<T>` over browser
storage; against a live server it is `ApiRepository`, and which one is live is a single session-wide
decision (`lyra:data-mode`) so the app can never show demo entities next to real balances.

| Repository | Extra methods |
|-----------|---------------|
| `EntityRepository` | `getByType()`, `getByOwner()`, `getChildren()` |
| `TrackerRepository` | `getByEntityId()`, `getByDateRange()` |
| `ScheduleRepository` | `getByEntityId()`, `getActive()` |
| `RelationRepository` | `getByFromId()`, `getByToId()` |

## Hooks

React hooks wrap repositories with TanStack Query for caching and mutations:

| Hook | Usage |
|------|-------|
| `useEntities(type?)` | All entities, optionally filtered by type |
| `useTrackers(entityId?)` | All trackers, optionally filtered by entity |
| `useRelations(entityId?)` | All relations involving an entity |

Each returns `{ items, isLoading, create, update, remove }`, which is `useRepository`'s shape.

**There is no `useSchedules`.** Three of the four primitives have a hook and schedules do not.
`scheduleRepository` is constructed and exported in `src/core/repositories/index.ts`, and nothing in
the SPA calls it. `/api/schedules` is served, but the readers of the table today are the
`schedule_list` MCP tool and the `schedule.tick` job; the SPA's own recurrence lives on the entity's
`dueDate` and is advanced by `src/pages/tasks/task-helpers.ts`. If a page ever needs the table,
`useRepository` is what the hook would be built from.

## Module configuration

Modules are declared in `src/core/config/modules.ts`. Each module maps to entity types, a route, and a sidebar icon. Adding a new module is configuration — no new primitives needed.
