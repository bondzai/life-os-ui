# TODO

See [`docs/improvements.md`](docs/improvements.md) for full feature catalog with 4 priority tiers.

---

## Phase 12: Quick Wins & Polish

### 12a. Cross-Cutting UX
- [ ] Data export: download all entities as JSON file (backup button in sidebar footer)
- [ ] Data import: upload JSON to restore from backup
- [ ] Undo delete: toast with "Undo" button (soft delete → restore within 5s)
- [ ] Duplicate item: clone any entity with one click (button on cards)
- [ ] Sidebar collapsible groups: collapse/expand with remembered preference
- [ ] Sidebar badges: show due/overdue count next to Tasks and Chores modules

### 12b. Dashboard v2
- [ ] Health summary card: latest weight, today's mood, 7d workout count
- [ ] Wealth snapshot card: net worth, monthly P&L
- [ ] Habit completion rate card: "85% this week" with mini bar
- [ ] "Weekly Review due" card: show when review hasn't been done this week
- [ ] Motivational message when all tasks are complete

### 12c. Goal Improvements
- [ ] Progress slider on card: quick-adjust without opening dialog
- [ ] Color-code cards by progress range (red/yellow/green)
- [ ] Auto-progress from sub-goals: compute parent % as average of children

### 12d. Task Improvements
- [ ] Priority color on Kanban cards (red/orange/yellow/gray)
- [ ] Quick snooze: reschedule by 1 day or 1 week from card menu
- [ ] Subtask support: nested checklist items within a task (metadata array)

### 12e. Habit Improvements
- [ ] Habit heatmap: 90-day grid showing check-in patterns (CSS grid + color scale)
- [ ] Monthly completion rate badge on cards
- [ ] Streak milestone badges: 7d, 30d, 90d visual indicators

### 12f. Notes Improvements
- [ ] Pin/favorite toggle: pinned notes always show at top
- [ ] Markdown rendering: render body with bold, links, code blocks
- [ ] Tag filter dropdown on Notes tab

### 12g. Memories Improvements
- [ ] EXIF date extraction: auto-fill date from photo metadata
- [ ] "On This Day" dashboard widget: memories from same date in past years
- [ ] Photo albums: group memories into named collections

---

## Phase 13: Medium Features

### 13a. Calendar Enhancements
- [ ] Week view: 7-day grid with hourly time blocks
- [ ] Agenda view: vertical timeline of next 7-14 days
- [ ] Entity type filter: toggle tasks/events/habits visibility on calendar

### 13b. Wealth Charts & Alerts
- [ ] Net worth trend chart: monthly Recharts line graph
- [ ] Income vs Expense chart: monthly comparison (past 6 months)
- [ ] Budget alerts: warning badge when category spending > 80%
- [ ] Recurring transactions: auto-create scheduled expenses/income

### 13c. Health Charts
- [ ] Weight trend chart: line graph progression over time
- [ ] Workout heatmap: calendar grid showing workout days
- [ ] Sleep-mood correlation: side-by-side charts
- [ ] Water intake: daily counter widget

### 13d. Family Enhancements
- [ ] Chore rotation: auto-swap assignee on completion
- [ ] Chore completion history: track who did what and when
- [ ] Household goals tab: shared family goals

### 13e. Posts Enhancements
- [ ] Emoji reactions on posts (heart, thumbs up, laugh)
- [ ] Reply/thread: comment on posts
- [ ] Media attachments: images on posts (reuse memory compression)

### 13f. Places & Travel
- [ ] Click map to set location (instead of manual lat/lng)
- [ ] "Open in Maps" button (Google Maps deep link)
- [ ] Trip itinerary timeline: day-by-day view with time slots
- [ ] Trip budget: planned vs actual spending

### 13g. Today Page Enhancements
- [ ] Pomodoro timer: 25/5 min focus timer attached to a task
- [ ] Time-of-day sections: Morning, Afternoon, Evening groups
- [ ] Daily affirmation/motivational quote

### 13h. Review Enhancements
- [ ] Week-over-week comparison: metrics vs previous week
- [ ] Accomplishment highlights: top 3 with larger cards
- [ ] Next-week priorities: auto-suggest from upcoming due dates

---

## Phase 14: Larger Features

### 14a. Advanced Cross-Cutting
- [ ] Full-text search across all entities (titles, descriptions, metadata)
- [ ] Saved filters/views per module
- [ ] Comment system on any entity
- [ ] Inline editing on cards (edit fields without dialog)

### 14b. Skills & Reading
- [ ] Skill practice log: quick "Log practice" button → tracker entry
- [ ] Reading progress: pages read / total pages with progress bar
- [ ] Reading challenge: annual goal with tracker ("Read 24 books in 2026")

### 14c. Automate v2
- [ ] Execution history log: timestamped past runs with results
- [ ] Conditional logic: if/then rules for trigger conditions
- [ ] Event-driven triggers: fire on status change or tracker threshold
- [ ] Dry-run mode: preview automation effect before executing

---

## Phase 3.5 — Backend (Deferred)

### API Server
- [ ] Set up API server project (Hono or Fastify + SQLite/Drizzle)
- [ ] Define REST endpoints for entities, trackers, relations, schedules
- [ ] Add authentication middleware (PIN-based or token)

### localStorage to API Migration
- [ ] Replace `LocalRepository` with `ApiRepository` implementation
- [ ] Update `useRepository` hook to use API client (TanStack Query already in place)
- [ ] Migrate seed data to server-side database seeding

### OpenClaw Integration
- [ ] Create OpenClaw AI provider skill in `src/core/ai/`
- [ ] Connect to OpenClaw agent hub on mini PC
- [ ] Enable agent-to-agent communication for automated tasks

### Cron Jobs / Scheduled Tasks
- [ ] Daily brief generation (morning summary)
- [ ] Habit streak reset at midnight if not checked in
- [ ] Weekly/monthly report generation

### Docker Compose
- [ ] Create `docker-compose.yml` for Life-OS stack (UI + API + OpenClaw)
- [ ] Add Dockerfile for UI (Vite build + static serve)
- [ ] Add Dockerfile for API server
- [ ] Configure networking between services

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
