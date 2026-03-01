# OpenClaw Integration

OpenClaw runs on the mini PC as an always-on AI agent. It connects JB and Sunny to Life-OS through the chat apps they already use — no new app to install.

## Why OpenClaw

| Problem | OpenClaw solves it |
|---------|-------------------|
| Life-OS only works in a browser | OpenClaw adds Telegram, WhatsApp, Signal, Discord access |
| Need to open the app to add a task | "Add groceries" on WhatsApp → task created |
| No notifications | OpenClaw pushes reminders to chat apps |
| No automation | OpenClaw has cron, webhooks, shell access |
| AI provider management | OpenClaw handles model routing, failover, auth rotation |
| Voice input | OpenClaw talk mode with wake word |

## System topology

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
         ├── Telegram   (JB — primary)
         ├── WhatsApp   (Sunny — primary)
         ├── Signal     (Both — shared/family)
         └── WebChat    (Fallback on any browser)
```

## Integration layers

### Layer 1: OpenClaw as AI provider

The simplest integration. Point Life-OS UI's AI config at OpenClaw's gateway:

```
Provider: openclaw
Endpoint: http://localhost:18789/v1
Model: (managed by OpenClaw)
```

OpenClaw handles model selection (Claude, GPT, Ollama), failover, and rate limiting. Life-OS UI just sends OpenAI-compatible requests. This requires adding `'openclaw'` to the `AIProvider` type.

### Layer 2: Life-OS skill for OpenClaw

A custom OpenClaw skill that gives the agent CRUD access to Life-OS data.

#### Skill definition

Located at `~/.openclaw/workspace/skills/life-os/SKILL.md`:

```markdown
# life-os

You manage the user's Life-OS system — their tasks, goals, habits,
events, and other tracked data. Use the tools below to read and modify
their data. Always confirm destructive actions before executing.

The system has two users:
- JB (admin) — manages everything
- Sunny (member) — shared tasks, family items

## Tools

### list_entities
GET {{LIFEOS_API}}/api/entities?type={{type}}&status={{status}}
List entities. Optional filters: type (task, goal, habit, event, ...),
status (active, completed, archived, paused).

### get_entity
GET {{LIFEOS_API}}/api/entities/{{id}}
Get a single entity by ID.

### create_entity
POST {{LIFEOS_API}}/api/entities
Body: { type, title, description?, priority?, tags?, dueDate?, ownerId, visibility }
Create a new entity. Default status: active, default priority: medium.

### update_entity
PUT {{LIFEOS_API}}/api/entities/{{id}}
Body: { status?, title?, description?, priority?, dueDate?, tags? }
Update an entity. Use this to mark tasks complete, update progress, etc.

### delete_entity
DELETE {{LIFEOS_API}}/api/entities/{{id}}
Delete an entity. Always confirm with the user first.

### daily_brief
GET {{LIFEOS_API}}/api/entities?status=active
Fetch all active entities, then summarize: tasks due today, overdue items,
goal progress, habit streaks. Format as a short daily brief.
```

#### Environment variable

```
LIFEOS_API=http://localhost:3000
```

### Layer 3: Cron jobs and notifications

OpenClaw cron skills for automated workflows:

| Schedule | Action |
|----------|--------|
| `0 8 * * *` | Morning daily brief → send to JB (Telegram) + Sunny (WhatsApp) |
| `0 20 * * 0` | Weekly review → summarize the week, plan next week |
| `0 9 * * *` | Overdue check → if any tasks overdue > 2 days, nudge the owner |
| `0 21 * * *` | Habit reminder → check uncompleted habits, gentle nudge |
| `0 10 * * 1` | Meal planning → suggest and create meal tasks for the week |

### Layer 4: Real-time sync via WebSocket

Connect Life-OS UI to the OpenClaw Gateway WebSocket for live updates:

```
ws://localhost:18789
```

- **Inbound**: When OpenClaw creates/updates entities (from a chat message), the UI gets notified and refreshes
- **Outbound**: When the UI changes data, OpenClaw is aware for context in future conversations

This is optional — polling via TanStack Query's `refetchInterval` works for a simpler initial implementation.

## User experience

### JB's workflow

```
Morning:
  8:00 — Telegram notification: "Good morning JB. 3 tasks due today,
          1 overdue from Friday. Your 'Learn Rust' goal is at 40%."

During the day:
  JB on phone → Telegram: "add task: review PR for auth module, high priority"
  → OpenClaw: "Created task 'Review PR for auth module' [high] ✓"

  JB on laptop → opens Life-OS UI → sees the task on kanban board
  → drags to "in progress" → completes it

Evening:
  JB: "what did I get done today?"
  → OpenClaw: "You completed 5 tasks including the PR review.
     2 tasks carried over to tomorrow."
```

### Sunny's workflow

```
Morning:
  8:00 — WhatsApp notification: "Hi Sunny! Here's your day:
          Grocery shopping due today. Yoga habit not checked yet."

Anytime:
  Sunny on WhatsApp: "add milk and eggs to shopping list"
  → OpenClaw: "Added 'Buy milk and eggs' to your tasks ✓"

  Sunny: "what's for dinner this week?"
  → OpenClaw: (reads meal plan entities) "Monday: pasta, Tuesday: stir fry..."
```

## Implementation sequence

| Step | What | Depends on |
|------|------|-----------|
| 1 | Add `'openclaw'` to `AIProvider` type | Nothing |
| 2 | Build Life-OS API server | Nothing |
| 3 | Swap `LocalRepository` → `ApiRepository` in UI | Step 2 |
| 4 | Data migration (localStorage → SQLite) | Step 2 |
| 5 | Write OpenClaw `life-os` skill (SKILL.md) | Step 2 |
| 6 | Configure OpenClaw channels (Telegram, WhatsApp) | OpenClaw installed |
| 7 | Add cron skills (daily brief, reminders) | Steps 5 + 6 |
| 8 | WebSocket real-time sync (optional) | Steps 3 + 5 |
| 9 | Docker Compose for full stack | All above |

## Security considerations

- The API server runs on the local network only (no public exposure)
- OpenClaw's DM pairing ensures only JB and Sunny can interact
- API auth: simple bearer token (two known users, private network)
- OpenClaw Gateway binds to `127.0.0.1` by default
- Remote access (optional): Tailscale for encrypted tunnel, no port forwarding
