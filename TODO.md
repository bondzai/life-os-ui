# TODO

See [`docs/improvements.md`](docs/improvements.md) for full feature catalog with 4 priority tiers.
See [`docs/minimalist-mind-life-os.md`](docs/minimalist-mind-life-os.md) for cognitive system philosophy.

---

## Phase 16: Minimalist Mind System

Based on the [Minimalist Mind](docs/minimalist-mind-life-os.md) cognitive architecture spec.

### Coverage Matrix

| Doc Section | Status | What's Built |
|---|---|---|
| Layer 1 — Capture | ✅ Done | Capture Bar (`/` to focus, `!` for task), Inbox Capture dialog (`Cmd+Shift+I`) |
| Layer 2 — Clarify | ❌ Missing | — |
| Layer 3 — Organize | ⚠️ Partial | Modules exist, but no PARA (Projects/Areas/Knowledge/Archive) view |
| Focus Engine (3 levels) | ✅ Done | Strategic Direction + Due (Tactical) + Today Focus 3-max (Immediate) |
| Cognitive Dashboard | ✅ Done | Today Focus, Strategic Direction, Active Projects, Knowledge Growth |
| Daily Protocol | ✅ Done | Morning & Evening guided flows with step tracking |
| Weekly Protocol | ⚠️ Partial | Weekly Review exists, not linked to protocol system |
| Anti-Noise System | ❌ Missing | — |
| Knowledge Engine | ❌ Missing | Notes exist but no structured knowledge entries |
| AI Augmentation | ⚠️ Partial | Chat sidebar + Cmd+K, no specialized agent roles |
| Minimal Interface | ✅ Done | Text-first, dark mode, keyboard capture |
| Clarity Metrics | ✅ Done | Focus Score, Noise count, Knowledge Growth |
| Cognitive Loop | ❌ Missing | — |
| Strategic Map | ❌ Missing | — |
| Knowledge Graph | ❌ Missing | — |
| Focus Engine (auto) | ❌ Missing | — |

---

### 16a. AI Clarify Layer (Layer 2)

AI processes raw inbox items into structured outputs.

- [ ] **Inbox triage assistant**: AI analyzes each inbox item and suggests: type (task / knowledge / reference / discard), priority, domain tags
- [ ] **One-click classify**: Accept AI suggestion to convert inbox item with pre-filled fields
- [ ] **Batch clarify**: Process all inbox items at once with AI suggestions in a review list
- [ ] **Smart routing**: Auto-suggest which module an item belongs to (e.g., "research zk identity" → Skills, tag: blockchain)

### 16b. Knowledge Engine (Section 7)

Structured knowledge system — the brain's external memory.

- [ ] **Knowledge entry type**: New entity structure with fields: `title`, `summary`, `insight`, `source`, `domain`
- [ ] **Knowledge domains**: Organize by domain (crypto, system-design, economics, ai, etc.) with domain filter
- [ ] **Knowledge card UI**: Cards showing title + insight preview, expandable to full summary
- [ ] **Knowledge capture shortcut**: Capture Bar prefix `?` or `/k` creates knowledge entry directly
- [ ] **Spaced repetition**: Surface old knowledge entries for review at increasing intervals (1d, 3d, 7d, 14d, 30d)
- [ ] **Knowledge search**: Full-text search within knowledge entries with domain filtering
- [ ] **Import from notes**: Convert existing notes into structured knowledge entries

### 16c. Knowledge Graph (Section 12)

Visual linking between ideas, projects, and goals.

- [ ] **Entity relations UI**: Link any entity to any other (knowledge ↔ goal, note ↔ project)
- [ ] **Graph visualization**: Interactive node graph showing connections between knowledge, goals, and projects
- [ ] **Related items sidebar**: When viewing any entity, show related/linked items
- [ ] **Auto-suggest links**: AI suggests connections based on content similarity and tags

### 16d. Strategic Map (Section 12)

Visual hierarchy of long-term strategy.

- [ ] **Goal tree visualization**: Tree/mind-map showing Strategic → Projects → Milestones → Tasks
- [ ] **Drag to reorganize**: Move goals between strategic pillars
- [ ] **Progress roll-up**: Visual progress flowing from leaves to root
- [ ] **Time horizon labels**: Tag goals as 1-year, 3-year, 5-year with visual grouping

### 16e. Anti-Noise System (Section 6)

Actively reduce cognitive noise.

- [ ] **Stale item detector**: Flag items not updated in 14+ days with "Archive?" prompt
- [ ] **Auto-archive suggestions**: Weekly batch of items to archive (shown during Weekly Review)
- [ ] **Noise dashboard**: Chart showing incoming vs archived ratio over time (target: <1.0)
- [ ] **Focus Mode**: Toggle that hides sidebar + all panels except Today Focus and current task
- [ ] **Notification budget**: Limit notifications to N per day, prioritize by importance
- [ ] **Feed quality filter**: Mark information sources as high/low signal, surface only high-signal items

### 16f. AI Agent Roles (Section 8)

AI as a thinking partner with specialized roles.

- [ ] **Research Agent**: Given a topic, gather context and summarize key findings
- [ ] **Architecture Agent**: Given a problem, propose system design with trade-offs
- [ ] **Reviewer Agent**: Critique a design or plan, find weaknesses
- [ ] **Strategy Agent**: Evaluate an idea's long-term value and alignment with strategic goals
- [ ] **Agent selector in chat**: Choose agent role before starting a conversation
- [ ] **Agent chain**: Pipe output from one agent to the next (research → architecture → review → strategy)

### 16g. Auto-Focus Engine (Section 12)

AI suggests what to work on.

- [ ] **Priority suggestion**: AI recommends today's 3 priorities based on: deadlines, strategic alignment, effort, energy level
- [ ] **Context-aware ordering**: Surface tasks that align with current project momentum
- [ ] **Time-block suggestion**: AI proposes a daily schedule based on task estimates and calendar
- [ ] **"What should I do next?"**: One-button AI recommendation when priorities are complete

### 16h. Cognitive Loop Tracker (Section 11)

Track the Learn → Build → Reflect → Improve cycle.

- [ ] **Loop entries**: Log which phase you're in for each project/skill
- [ ] **Loop visualization**: Circular diagram showing cycle progress per project
- [ ] **Reflection prompts**: Auto-prompt "What did you learn?" after completing a project milestone
- [ ] **Improvement log**: Track insights from reflections, link back to knowledge entries

### 16i. Enhanced Capture (Section 2 — Layer 1)

Make capture even faster and more versatile.

- [ ] **Voice capture**: Speech-to-text via Web Speech API → inbox item
- [ ] **Browser bookmarklet**: One-click capture of current page title + URL as reference
- [ ] **Screenshot capture**: Paste image from clipboard → memory or reference
- [ ] **Capture templates**: Pre-defined capture formats (/meeting, /idea, /bug, /insight)
- [ ] **Capture from anywhere**: PWA global shortcut that opens capture overlay even when app is backgrounded

### 16j. Keyboard-First UX (Section 9)

Full keyboard navigation for power users.

- [ ] **`J/K` navigation**: Move up/down through lists
- [ ] **`N` new item**: Create new item in current module
- [ ] **`E` edit**: Open selected item for editing
- [ ] **`X` complete**: Toggle completion on selected item
- [ ] **`G` then key**: Go-to shortcuts (`G H` = home, `G T` = tasks, `G G` = goals)
- [ ] **Command palette enhancement**: Show recent items, fuzzy search, context-aware actions
- [ ] **Vim-style markers**: Bookmark positions in lists for quick return

### 16k. Weekly Protocol Enhancement (Section 5)

Upgrade existing Weekly Review to match protocol system.

- [ ] **Integrated weekly protocol**: Link Weekly Review to protocol system with tracked completion
- [ ] **Project progress review step**: Review each active project's progress during weekly protocol
- [ ] **Strategic goal alignment check**: Confirm each project still aligns with strategic direction
- [ ] **Noise archival step**: Batch archive stale items during weekly review
- [ ] **Weekly metrics summary**: Focus Score trend, Knowledge Growth trend, Noise Ratio trend

### 16l. Daily Brief v2 (Section 8 — AI)

AI-generated morning intelligence briefing.

- [ ] **Morning brief**: AI summary of: today's priorities, upcoming deadlines, overdue items, knowledge to review
- [ ] **Brief notification**: Show brief as a dismissible card on Focus page each morning
- [ ] **Brief history**: Archive of past briefs for pattern review
- [ ] **Personalized insights**: "You complete 40% more tasks on Tuesdays" — behavioral patterns

---

## Phase 3.5 — Backend (Deferred)

### OpenClaw Integration
- [ ] Create OpenClaw AI provider skill in `src/core/ai/`
- [ ] Connect to OpenClaw agent hub on mini PC
- [ ] Enable agent-to-agent communication for automated tasks

### Cron Jobs / Scheduled Tasks
- [ ] Daily brief generation (morning summary)
- [ ] Habit streak reset at midnight if not checked in
- [ ] Weekly/monthly report generation

---

## Nice-to-Have (Backlog)

### Google Calendar CRUD Integration

Currently: read-only iCal feed sync (public calendars only).
Goal: full bidirectional sync — create, read, update, delete events from Life-OS.

**Backend (API server)**
- [ ] **Google OAuth2 flow**: `/auth/google` → consent screen → store refresh token per user
- [ ] **Token management**: Encrypt and store Google tokens in DB, auto-refresh on expiry
- [ ] **GCal API proxy endpoints**: `GET/POST/PUT/DELETE /api/gcal/events` — backend calls Google API, frontend stays simple
- [ ] **Calendar list endpoint**: `GET /api/gcal/calendars` — list user's Google calendars with colors
- [ ] **Webhook receiver**: `POST /api/gcal/webhook` — receive push notifications from Google when events change (real-time sync)

**Frontend**
- [ ] **Google sign-in button**: OAuth connect/disconnect in Settings page
- [ ] **Calendar selector**: Choose which Google calendars to sync (checkboxes with calendar colors)
- [ ] **Unified event list**: Merge Life-OS events + Google events in calendar views, visually distinguish by source badge
- [ ] **Create event → Google**: When creating an event in Life-OS, option to push to a selected Google Calendar
- [ ] **Edit Google events inline**: Edit title, time, description of Google events directly in Life-OS calendar
- [ ] **Delete Google events**: Delete from Life-OS removes from Google (with confirmation)
- [ ] **Drag to reschedule**: Drag Google events on calendar grid → update via API
- [ ] **Conflict detection**: Warn when creating an event that overlaps with an existing Google event
- [ ] **Sync status indicator**: Show last sync time, manual refresh button, sync error states

**Sync Logic**
- [ ] **Incremental sync**: Use Google's `syncToken` to fetch only changed events (not full re-fetch)
- [ ] **Bi-directional merge**: Life-OS event changes push to Google, Google changes pull to Life-OS
- [ ] **Offline queue**: Queue changes made offline, sync when connection restores
- [ ] **Duplicate prevention**: Match events by Google event ID to avoid duplicates on re-sync

**Implementation notes**:
- Google Calendar API v3, scopes: `calendar.readonly` → `calendar.events` for write
- OAuth flow must go through backend (client secret can't be exposed)
- Store `googleEventId` in entity metadata to link Life-OS events to Google events
- Use `etag` from Google for optimistic concurrency (prevent overwriting external changes)
- Rate limits: 1M queries/day free tier, batch requests for bulk operations

### Cross-Cutting
- [ ] Bulk actions: multi-select → bulk delete, archive, status change
- [ ] Keyboard shortcuts: `N` = new, `J/K` = navigate, `/` = search
- [ ] Activity timeline per entity: change history

### Tasks
- [ ] Time estimate field with tracking
- [ ] Recurring tasks (daily/weekly/monthly auto-create)
- [ ] "Blocked by" dependency indicator

### Home
- [ ] Service health monitoring (ping/heartbeat)
- [ ] Docker container status display
- [ ] Service dependency tree visualization

### Future Vision (post-API)
- [ ] Real-time multi-device sync via WebSocket
- [ ] Push notifications for due tasks/habits
- [ ] External integrations (GitHub → skills, Fitbit → health)
- [ ] Smart scheduling: AI optimal time suggestions
- [ ] Gamification: XP, levels, badges
- [ ] Mobile app (React Native or enhanced PWA)

---

## Completed Phases

- [x] Phase 1: Foundation
- [x] Phase 2: Plan (Goals, Tasks, Calendar)
- [x] Phase 3: AI Layer (Chat, Command Bar, Daily Brief)
- [x] Phase 4: Grow (Skills, Habits, Reading)
- [x] Phase 4.5: Capture & Explore (Notes, Posts, Notifications, Places, Travel)
- [x] Phase 5: Wealth (Transactions, Budgets, Accounts, Portfolio, Wallets, Crypto)
- [x] Phase 6: Health (Body Metrics, Workouts, Sleep & Mood)
- [x] Phase 7: Home (Devices, Services)
- [x] Phase 8: Family (Chores, Activity Feed)
- [x] Phase 9: Automate (Trigger/Action Engine, Templates)
- [x] Phase 10: Polish (PWA, Code Splitting, Mobile)
- [x] Phase 10.5: Memories (Photo Journal, Gallery, Timeline)
- [x] Phase 11: Productivity (Today Page, Inbox Capture, Weekly Review)
- [x] Phase 12: Quick Wins & Polish (Dashboard v2, Sidebar, Module Polish)
- [x] Phase 13: Medium Features (charts, agenda, pomodoro, review)
- [x] Phase 12+13 Cleanup: All remaining items (v0.14.0)
- [x] Phase 14: Larger Features (v0.15.0)
- [x] Phase 15: Bug fixes, task snooze, water intake (v0.16.0)
- [x] Phase 3.5: Backend API (Hono + SQLite + Drizzle), Docker Compose (v0.17.0)
- [x] Phase 15.5: Maps (Leaflet → MapLibre GL/mapcn), Mobile UX, Google Calendar redesign (v0.20.0–v0.21.0)
- [x] Phase 15.6: Focus redesign, Makefile, API URL resolver (v0.22.0)
- [x] Phase 16.0: Minimalist Mind Cognitive Dashboard — Capture Bar, Daily Protocol, Strategic Direction, Clarity Metrics (v0.23.0)
