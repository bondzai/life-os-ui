# API Server (Planned)

The Life-OS API server is a thin REST layer over SQLite. It exists so both the UI and OpenClaw can read and write the same data.

## Stack

- **Runtime**: Node.js / Bun
- **Framework**: Hono
- **Database**: SQLite
- **ORM**: Drizzle
- **Deployment**: Docker container on the mini PC

## Why a separate server

Currently, Life-OS UI stores everything in browser localStorage. This works for a single browser but breaks when:

- OpenClaw needs to read/write entities from chat messages
- You use multiple browsers or devices
- You want data to survive browser cache clears
- Cron jobs need to query data without a browser open

The API server is the shared truth.

## Database schema

Maps directly to the core engine primitives:

```sql
CREATE TABLE entities (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  priority    TEXT NOT NULL DEFAULT 'medium',
  tags        TEXT NOT NULL DEFAULT '[]',       -- JSON array
  metadata    TEXT NOT NULL DEFAULT '{}',       -- JSON object
  parent_id   TEXT REFERENCES entities(id),
  owner_id    TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private',
  due_date    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE trackers (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL REFERENCES entities(id),
  value      REAL NOT NULL,
  unit       TEXT NOT NULL,
  note       TEXT,
  timestamp  TEXT NOT NULL,
  owner_id   TEXT NOT NULL
);

CREATE TABLE schedules (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES entities(id),
  recurrence     TEXT NOT NULL,
  next_due       TEXT NOT NULL,
  last_completed TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE relations (
  id      TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id),
  to_id   TEXT NOT NULL REFERENCES entities(id),
  type    TEXT NOT NULL
);
```

## Endpoints

### Entities

```
GET    /api/entities              — List all (query: ?type=&status=&ownerId=)
POST   /api/entities              — Create one
GET    /api/entities/:id          — Get by ID
PUT    /api/entities/:id          — Update (partial)
DELETE /api/entities/:id          — Delete
```

### Trackers

```
GET    /api/trackers              — List all (query: ?entityId=&from=&to=)
POST   /api/trackers              — Create one
DELETE /api/trackers/:id          — Delete
```

### Schedules

```
GET    /api/schedules             — List all (query: ?entityId=&active=)
POST   /api/schedules             — Create one
PUT    /api/schedules/:id         — Update
DELETE /api/schedules/:id         — Delete
```

### Relations

```
GET    /api/relations             — List all (query: ?entityId=)
POST   /api/relations             — Create one
DELETE /api/relations/:id         — Delete
```

## Authentication

Simple bearer token. Two tokens — one per user — stored as environment variables:

```env
AUTH_TOKEN_JB=<random-string>
AUTH_TOKEN_SUNNY=<random-string>
```

Middleware extracts the token from `Authorization: Bearer <token>` and maps it to a user ID. No OAuth, no sessions — two users on a private network don't need more.

## Migration from localStorage

A one-time migration script reads `life-os:entities`, `life-os:trackers`, etc. from a localStorage JSON export and inserts them into SQLite:

```bash
# Export from browser console:
# JSON.stringify(localStorage)  →  save as local-data.json

# Run migration:
bun run migrate --input local-data.json
```

## UI integration

The UI swaps `LocalRepository` for `ApiRepository` — same `IRepository<T>` interface, `fetch()` calls instead of `localStorage`:

```typescript
class ApiRepository<T extends { id: string }> implements IRepository<T> {
  constructor(private resource: string, private baseUrl: string) {}

  async getAll(): Promise<T[]> {
    const res = await fetch(`${this.baseUrl}/api/${this.resource}`)
    return res.json()
  }

  async create(item: T): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/${this.resource}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    })
    return res.json()
  }

  // ... same pattern for getById, update, delete, query
}
```

Zero UI component changes. The repository pattern pays off here.
