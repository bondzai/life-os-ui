# Core Engine

The core engine provides four primitives that every module builds on. This keeps the system DRY — a goal, a task, a habit, and a transaction are all entities with different `type` values.

## Primitives

### Entity

The universal data object. Everything in Life-OS is an entity.

```typescript
interface Entity {
  id: string
  type: EntityType        // 'goal' | 'task' | 'habit' | 'skill' | ...
  title: string
  description?: string
  status: EntityStatus    // 'active' | 'completed' | 'archived' | 'paused'
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

**Supported types**: `goal`, `task`, `habit`, `skill`, `transaction`, `budget`, `account`, `workout`, `body-metric`, `book`, `course`, `event`, `device`, `service`, `chore`

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

Each primitive has a repository class extending `LocalRepository<T>`:

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
| `useSchedules(entityId?)` | All schedules, optionally filtered by entity |
| `useRelations(entityId?)` | All relations involving an entity |

Each returns `{ items, isLoading, create, update, remove }`.

## Module configuration

Modules are declared in `src/core/config/modules.ts`. Each module maps to entity types, a route, and a sidebar icon. Adding a new module is configuration — no new primitives needed.
