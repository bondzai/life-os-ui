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

### Phase 4: Grow
Skills, habits, and reading tracking.
- Habits page with daily check-in, streaks, frequency badges
- Skills page with proficiency levels (beginner → expert) and related resources
- Reading page for books and courses with status and rating tracking

### Phase 4.5: Capture, Social & Explore
Notes, posts, notifications, places, and travel.
- Notes page with free-form notes + daily journal with mood tracking
- Posts page — household activity feed with inline compose
- Notification system: sonner toasts, bell icon with dropdown, history page
- Places page with Leaflet map and OpenStreetMap tiles
- Travel page — trip planner linking places with map routes

### Phase 5: Wealth
Budget, transactions, net worth tracking, and portfolio management.
- Transaction table with type/category filters and CRUD
- Budget cards with progress bars (spent computed from transactions)
- Account cards with balances and cash total
- Spending chart (Recharts bar chart) by category
- Summary strip: Net Worth, Cash, Portfolio, Monthly P&L
- Portfolio tab with asset tracking (crypto, defi, stocks, funds, gold, property)
- Asset cards with gain/loss display, allocation donut chart
- Custom dialogs with zod validation for each entity type
- Wallets tab: CEX accounts + cold/hot/hardware wallets with chain and address tracking
- Crypto transaction ledger: buy/sell/swap/transfer records linked to wallets
- Chain and protocol filters on the portfolio tab
- Assets linked to wallets via walletId

### Phase 6: Health
Body metrics, workouts, sleep, and mood tracking.
- Body metrics table: weight, body fat, waist, chest, arms, BMI — with metric type filter
- Workout cards: strength, cardio, flexibility, HIIT, sports — duration, calories, exercises
- Sleep & mood cards: sleep hours + quality, mood (great → terrible), energy level (1-10)
- Summary strip: latest weight, 7-day workout count, 7-day avg sleep, today's mood
- Custom zod-validated dialogs for each entry type
- New `sleep-mood` entity type for combined daily wellness entries

### Phase 7: Home
Device inventory and service monitoring for the home server environment.
- Device cards: server, desktop, laptop, phone, tablet, router, IoT — with IP, MAC, OS, location
- Service cards: docker, web, database, API, monitoring, media — with status tracking (running/stopped/error)
- Services linked to devices via deviceId
- Summary strip: device count, service count, running count, error count
- Custom zod-validated dialogs for each entity type

### Phase 8: Family
Shared chore management and household activity feed.
- Chore cards with category, frequency, assignee, and due date tracking
- Category badges: cleaning, cooking, laundry, shopping, maintenance, pets
- Category and assignee filter dropdowns
- Activity tab: chronological feed of all shared entities across all modules
- Summary strip: total chores, due/overdue, my chores, shared tasks
- Custom zod-validated chore dialog

### Phase 9: Automate
Client-side trigger/action automation engine.
- Trigger types: schedule (daily/weekly/monthly) and manual
- Action types: create-entity, notify, update-entities
- Automation cards with run count, last run, next due, manual run button
- 5 preset templates: Weekly Review, Monthly Budget Check, Daily Habit Reminder, Weekly Meal Plan, Weekly Grocery List
- One-click template activation
- Engine evaluates due automations on page load (once per day per session)
- Custom dialog with conditional action config fields

### Phase 10: Polish
PWA, code splitting, mobile optimization, and performance.
- PWA manifest + service worker (vite-plugin-pwa) with autoUpdate and offline caching
- Workbox runtime caching for iCal feeds (NetworkFirst strategy)
- App icons (192 + 512 SVG), apple-mobile-web-app meta tags
- Code splitting: React.lazy for all 17 page routes — each page is a separate chunk
- Manual vendor chunks: react, ui, data, charts, maps, dnd — split from ~1.5 MB monolith to ~300 KB initial + lazy chunks
- Mobile-responsive layout padding (p-3 on mobile, p-6 on desktop)
- Spinner fallback component for lazy-loaded routes

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

### Phase 8b: Family Enhancements

Additional family features (post-MVP).

- Shared calendar view overlaying both users' events
- Chore auto-rotation (swap assignee on completion)
- Family dashboard with combined stats

### Phase 9b: Automate Enhancements

Advanced automation features (post-MVP).

- Event-driven triggers (entity status change, tracker threshold)
- Webhook endpoints for external integrations
- OpenClaw cron skills integration
- Conditional logic and chained actions

---

## Improvements & Scaling

Known areas to improve as the project grows. Not urgent — tackle incrementally when touching related code.

### Performance
- ~~**Code splitting**~~: Done in Phase 10 — React.lazy for 17 routes + manual vendor chunks
- **Virtualization**: Long lists (transactions, crypto txs) should use `@tanstack/react-virtual` once they exceed ~100 rows
- **Memoization**: Wealth page has many `useMemo` chains — consider extracting into custom hooks to reduce component complexity
- **Query granularity**: `useEntities(type)` fetches *all* entities then filters in-memory. Once the API server exists, push type filters to the query layer

### Data & Storage
- **localStorage limits**: Currently ~5-10 MB cap depending on browser. Seed data is small but real usage will hit this. API server (Phase 3.5) is the fix
- **Seed data reset**: `seedIfEmpty()` only seeds if the key is missing — no migration path for schema changes. Adding a version key would help
- **Tracker volume**: High-frequency trackers (daily habits, body metrics, mood) will accumulate fast. Archive or aggregate old entries once the API exists

### Architecture
- **Wealth page size**: `wealth.tsx` is the largest single component (~500 lines). Consider extracting tab content into subcomponents if it grows further
- **Dialog pattern divergence**: Wealth module uses custom zod-based dialogs while other modules use the generic `EntityDialog`. Both patterns work — keep custom dialogs for modules with complex metadata, use `EntityDialog` for simple ones
- **Entity type proliferation**: 22 entity types sharing one table. Fine for localStorage, but the API schema should support indexed queries by type

### DX & Quality
- **No tests yet**: Unit tests for helpers (formatTHB, getAssetValue, etc.) and component tests for critical flows (CRUD, filters) would catch regressions
- **No Storybook**: UI components are only testable in-app. Not urgent for a two-user app
- **Lint/format**: Ensure ESLint + Prettier are configured and enforced (currently in place via Vite defaults)

### Feature Gaps in Existing Modules
- **Dashboard**: Could show health summary, wealth snapshot, and recent crypto txs once those modules are live
- **Calendar**: Only shows entity `dueDate` — could integrate habit check-ins and body metric entries as timeline dots
- **Goals**: No auto-progress from linked tasks/habits. Manual progress slider works but auto-compute would be better
- **Wealth**: No recurring transaction support, no multi-currency conversion, no real-time price feeds (all fine for manual tracking)
