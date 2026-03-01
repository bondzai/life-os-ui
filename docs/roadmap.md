# Roadmap

Phase-by-phase implementation plan. Each phase is independently useful — you don't need to complete all phases to have a working system.

## Completed

### Phase 1: Foundation

Scaffold, core engine, layout, auth, and stub pages.

- React 19 + Vite + TypeScript + Tailwind + shadcn/ui
- Entity/Tracker/Schedule/Relation type system
- Repository pattern with localStorage backend
- TanStack Query hooks for data access
- Sidebar navigation with module registry
- PIN-based multi-user auth (JB + Sunny)
- Protected routes

### Phase 2: Plan

Goals, tasks, calendar, and dashboard widgets.

- Dashboard with 4 widgets (tasks, goals, habits, quick add)
- Tasks page with list view + kanban board + drag-and-drop (dnd-kit)
- Goals page with sub-goal hierarchy and progress tracking
- Calendar page with month grid + iCal Google Calendar integration
- Entity dialog for create/edit with Zod validation

### Phase 3: AI Layer

Swappable AI providers, chat sidebar, command bar, daily brief.

- AI provider system (OpenAI, Claude, Ollama, custom)
- AI client with streaming (SSE) + non-streaming fallback
- Context builder: gathers entities → system prompt
- Chat sidebar (Sheet) with conversation persistence
- Command bar (Cmd+K) with entity search + inline AI queries
- Daily brief dashboard widget with session-cached AI summary
- Prompt templates (daily brief, task breakdown, weekly review)

## Planned

### Phase 3.5: OpenClaw Bridge

Connect Life-OS to OpenClaw on the mini PC. This is the pivotal phase that turns Life-OS from a web app into a multi-channel life management system.

- Build Life-OS API server (Hono + SQLite + Drizzle)
- Swap `LocalRepository` → `ApiRepository` in the UI
- Data migration script (localStorage → SQLite)
- Write OpenClaw `life-os` skill (SKILL.md with CRUD tools)
- Configure OpenClaw channels (Telegram for JB, WhatsApp for Sunny)
- Add cron skills (daily brief, overdue nudges, habit reminders)
- Docker Compose for full stack deployment

### Phase 4: Grow

Skills, habits, reading, and learning tracking.

- Habits page with daily check-in grid, streaks, and weekly heatmap
- Skills page with skill tree and progress tracking
- Reading list (books, courses) with status and notes
- GitHub connector for commit/contribution tracking

### Phase 5: Wealth

Budget, transactions, and net worth tracking.

- Transaction entry and categorization
- Budget management with spending progress bars
- Account balances and net worth chart
- Monthly summary with category breakdown

### Phase 6: Health

Body metrics, workouts, sleep, and mood.

- Body metrics tracking (weight, measurements) with trend charts
- Workout log with exercise types and volume
- Sleep and mood daily entries
- Health dashboard with correlation insights

### Phase 7: Home

Docker, Home Assistant, and service monitoring.

- Docker container status and management (via API)
- Home Assistant integration (OpenClaw skill likely)
- Service uptime monitoring
- Device inventory

### Phase 8: Family

Shared entities and activity feed.

- Shared task lists and chore rotation
- Activity feed showing both users' actions
- Shared calendar view
- Family dashboard

### Phase 9: Automate

Trigger/action engine.

- Much of this may be covered by OpenClaw cron and skills
- Custom trigger definitions (entity status change → action)
- Webhook endpoints for external integrations
- Template automations (meal planning, weekly reset, etc.)

### Phase 10: Polish

PWA, mobile optimization, performance.

- PWA manifest + service worker for offline support
- Mobile-responsive layouts for all pages
- Code splitting and lazy loading
- Performance profiling and optimization
- Accessibility audit
