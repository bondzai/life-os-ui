# TODO

## Phase 11: Productivity Features

See [`docs/productivity-features.md`](docs/productivity-features.md) for full design docs.

### 11a. Focus Mode — Today Page ✓
- [x] Add module config (`/today`, `Sun` icon, `Overview` group)
- [x] Add lazy route in `app.tsx`
- [x] Create `src/pages/today/today-helpers.ts` — priority storage helpers (read/write/reset daily)
- [x] Create `src/pages/today/priority-picker.tsx` — "Pick your 3 priorities" prompt (shows active tasks/goals, saves to localStorage)
- [x] Create `src/pages/today/today-checklist.tsx` — combined due tasks + chores checklist with inline complete
- [x] Create `src/pages/today/habit-strip.tsx` — active habits with toggle check-in and streak count
- [x] Create `src/pages/today/quick-journal.tsx` — inline textarea that saves as journal note
- [x] Create `src/pages/today.tsx` — main page: progress bar, priorities, checklist, habits, events, journal, inbox
- [x] Update sidebar order (Today after Dashboard)
- [x] Update `docs/modules.md` and `docs/roadmap.md`

### 11b. Inbox — Quick Capture ✓
- [x] Create `src/components/inbox-capture.tsx` — floating button (bottom-right) + modal with textarea
- [x] Add keyboard shortcut `Cmd+Shift+I` to open capture modal
- [x] Mount `<InboxCapture />` in `app-layout.tsx` (visible on all pages)
- [x] Save captured items as `note` entities with `metadata.isInbox: true`
- [x] Add inbox section to Today page — list of untriaged items
- [x] Add "Convert to Task" action (creates task, archives note)
- [x] Add "Archive" action on inbox items
- [x] Add inbox count badge on capture button
- [x] Update `docs/modules.md` and `docs/roadmap.md`

### 11c. Weekly Review Wizard ✓
- [x] Add module config (`/review`, `ClipboardCheck` icon, `Overview` group)
- [x] Add lazy route in `app.tsx`
- [x] Create `src/pages/review/review-helpers.ts` — last review date storage, week boundary utils
- [x] Create `src/pages/review/step-accomplishments.tsx` — completed tasks/goals this week
- [x] Create `src/pages/review/step-stale.tsx` — items not touched in 14+ days, with archive/reschedule actions
- [x] Create `src/pages/review/step-habits.tsx` — habit streaks + weekly check-in summary
- [x] Create `src/pages/review/step-spending.tsx` — this week's transaction total vs budget
- [x] Create `src/pages/review/step-reflection.tsx` — journal textarea, saves as review note
- [x] Create `src/pages/review.tsx` — multi-step wizard with step indicator and back/next
- [x] Add "Start Weekly Review" button to Today page (links to /review)
- [x] Store review completion in localStorage (`life-os:last-review`)
- [x] Update `docs/modules.md` and `docs/roadmap.md`

---

## Phase 3.5 — Deferred Tasks

These items were deferred from Phase 3 (AI layer) and should be addressed before or during Phase 4+.

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
