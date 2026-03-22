# Changelog

All notable changes to Lyra (Life-OS UI) are documented here.

---

## [1.3.0] — 2026-03-22

### Proactive Lyra

#### Added
- **Lyra Pulse** — background 10-minute detector cycle with toast notifications for proactive insights
- **Deep Work Coach** — streak alerts, progress tracking, and next-task suggestions during focus sessions
- **Session Summary** — toast notification on pomodoro completion with task progress recap
- **Real-time Celebrations** — instant toasts on achievements (streaks, goals, milestones)
- **Proactive intelligence pipeline** — Pulse detectors feed insights without user prompting

---

## [1.2.0] — 2026-03-20

### Dynamic Dashboard

#### Added
- **Dynamic Dashboard** — 12 signal-driven widgets that surface what matters right now
- **Rules/Lyra mode toggle** — switch between automation-driven and AI-driven dashboard layouts
- **Signal-driven widgets** — widgets appear/disappear based on real-time data signals (streak risk, budget alerts, stale projects, etc.)

---

## [1.1.0] — 2026-03-18

### Lyra Command Interface

#### Added
- **MCP-style tool system** — 5 registered tools: suggest-focus, break-down, analyze-risk, coaching, weekly-summary
- **Sol personality** — INTJ strategist persona with time-of-day awareness, customizable traits
- **Lyra page** — full command interface with chat, tool arsenal, and settings panel
- **Tool arsenal UI** — browse, invoke, and view results from all registered AI tools
- **Graceful degradation** — AI offline triggers algorithmic fallback, no broken states

---

## [1.0.0] — 2026-03-16

### Codename: Trident — Lyra AI

#### Added
- **Ollama integration** — local LLM (llama3.2) for fully private AI, data never leaves the machine
- **Signal detectors** — 8 background detectors: streak risk, stale projects, budget, sleep, energy, decisions, achievements, velocity
- **Morning Brief** — daily briefing aggregating all 8 signal detectors into actionable summary
- **Provider-agnostic AI client** — works with Ollama, OpenAI, Claude, or any OpenAI-compatible endpoint
- **AI context builders** — automatic context assembly from entities, trackers, and relations

---

## [0.66.0] — 2026-03-14

### Codename: Tomahawk — Strategic Arsenal

#### Added
- **System Audit** — weekly review step 6 with health checks across all modules
- **Automation Rules** — 5 rule templates with toggle switches for proactive task management
- **Skills mastery system** — novice/beginner/intermediate/advanced/expert levels with rusty detection
- **Energy tracking** — daily energy level logging with trend analysis
- **Decision journal** — structured decision entries with revisit prompts and outcome tracking
- **Velocity tracking** — task/goal completion velocity with trend indicators
- **Focus Score** — daily priority completion percentage

---

## [0.65.0] — 2026-03-12

### Projects & Command Center

#### Added
- **Projects page** — online & offline project tracking with tech stack, velocity, links, and status
- **Command Center** — centralized command palette enhancements for power-user navigation
- **Task-project linking** — associate tasks with projects, view project task boards
- **List/grid view toggle** — switchable layouts on projects and other entity pages
- **Deep Work timer** — Pomodoro modes (classic 25m / deep 50m / sprint 15m), Emperor Time

---

## [0.15.0] — 2026-03-04

### Phase 14 — Larger Features

#### Added
- **Full-Text Search**: Scored search across titles, descriptions, tags, and metadata via Cmd+K
- **Inline Editing**: Click-to-edit component for quick field updates
- **Comment System**: Threaded comments on goals and skills (reuses Entity with parentId)
- **Saved Filters**: Persistent filter presets on Tasks, Goals, and Reading pages
- **Skill Practice Log**: Log practice sessions with duration and notes, track totals
- **Reading Progress**: Page tracking with progress bar on book cards
- **Reading Challenge**: Annual reading goal with completion tracking
- **Automation History**: Timestamped execution log with filter and clear
- **Conditional Logic**: AND-based conditions on automations (status, type, tag, tracker count)
- **Event-Driven Triggers**: Automations fire on task status change or habit check-in
- **Dry-Run Mode**: Preview automation effects without executing (Eye button)

---

## [0.14.0] — 2026-03-04

### Phase 12+13 Cleanup — All Remaining Items

#### Added
- **Undo Delete**: Toast with "Undo" button on delete across all entity pages
- **Duplicate Item**: Clone any entity with one click via copy button on cards
- **Markdown Rendering**: Notes render bold, italic, code, links, and lists
- **Subtask Support**: Nested checklists within tasks with progress indicator
- **Goal Progress Slider**: Quick-adjust progress without opening dialog
- **Dashboard Motivational Message**: Trophy card when all tasks are complete
- **Daily Affirmation**: Rotating motivational quotes on Today page
- **Monthly Habit Completion Rate**: Percentage badge on habit cards
- **Workout Heatmap**: 90-day activity grid in Health workouts tab
- **Calendar Week View**: 7-day column grid with entity lists per day
- **Calendar Entity Type Filter**: Toggle task/goal/event/habit visibility
- **Net Worth Trend Chart**: Monthly line chart from localStorage snapshots
- **Recurring Transactions**: Auto-generate scheduled expenses/income
- **EXIF Date Extraction**: Auto-fill memory date from photo metadata
- **On This Day Widget**: Dashboard widget showing memories from same date in past years
- **Photo Albums**: Group memories into named collections with filter
- **Chore Rotation**: Auto-swap assignee on completion
- **Chore Completion History**: Track who completed chores and when
- **Household Goals Tab**: Shared family goals with progress bars
- **Post Emoji Reactions**: 5 preset emoji reactions on posts
- **Post Reply/Thread**: Comment threads with collapsible replies
- **Post Media Attachments**: Image upload with compression on posts
- **Map Picker**: Click-to-pin Leaflet dialog for setting place coordinates
- **Open in Maps**: Google Maps deep link on place cards
- **Trip Itinerary Timeline**: Day-by-day place list grouped by date
- **Trip Budget**: Planned vs actual spending with progress bar
- **Today Time-of-Day Sections**: Morning/Afternoon/Evening event grouping
- **Review Accomplishment Highlights**: Top 3 items as featured cards

#### New Files
- `src/core/hooks/use-undo-delete.ts`
- `src/core/utils/duplicate-entity.ts`
- `src/core/components/markdown.tsx`
- `src/pages/tasks/subtask-list.tsx`
- `src/pages/today/daily-affirmation.tsx`
- `src/pages/health/workout-heatmap.tsx`
- `src/pages/calendar/week-view.tsx`
- `src/pages/wealth/net-worth-chart.tsx`
- `src/pages/memories/on-this-day-widget.tsx`
- `src/pages/places/map-picker-dialog.tsx`
- `src/pages/travel/trip-itinerary.tsx`

---

## [0.13.0] — 2026-03-04

### Phase 13: Medium Features — Charts, Agenda, Pomodoro, Review Enhancements

#### Added
- **Calendar Agenda View**: 14-day vertical timeline alongside month view. Shows tasks, events, habits, and iCal feeds grouped by date with type-colored dots. Toggle between Month and Agenda tabs.
- **Wealth: Income vs Expense Chart**: Grouped bar chart comparing monthly income (green) and expenses (red) over the past 6 months. Rendered with Recharts on the Transactions tab.
- **Wealth: Budget Alerts**: Warning badge with alert icon on budget cards when spending reaches 80%+ of budget. Shows percentage or "Over" when exceeded.
- **Health: Weight Trend Chart**: Line chart tracking weight entries over time with kg formatting, date tooltips, and auto-scaled Y-axis. Appears above the Body Metrics table (requires 2+ data points).
- **Health: Sleep Trend Chart**: Line chart of sleep hours over the last 30 days with an 8-hour reference line. Appears above the Sleep & Mood cards (requires 2+ data points).
- **Today: Pomodoro Timer**: Compact 25-minute work / 5-minute break timer widget. Play/pause/reset controls, mode indicator (Focus/Break/Ready), Web Audio API beep notification on cycle completion. No external audio files needed.
- **Review: Week-over-Week Comparison**: Accomplishments step now shows "+N vs last week" or "-N vs last week" badge comparing completed items between current and previous week.
- **Review: Next-Week Priority Suggestions**: Reflection step auto-suggests up to 5 upcoming items (tasks/goals due within 7 days), sorted by priority, with due dates shown.

#### Changed
- `calendar.tsx` — Added Month/Agenda tab switcher; month navigation hidden in agenda mode
- `wealth.tsx` — CashflowChart section added to Transactions tab
- `wealth/budget-card.tsx` — Budget alert badge with AlertTriangle icon at 80%+ spending
- `health.tsx` — WeightChart added to Body Metrics tab, SleepChart added to Sleep & Mood tab
- `today.tsx` — PomodoroTimer widget added between progress bar and priorities
- `review.tsx` — Passes `allEntities` to StepAccomplishments and StepReflection
- `review/step-accomplishments.tsx` — Week-over-week delta badge
- `review/step-reflection.tsx` — Suggested priorities section with upcoming due items

#### New Files
- `src/pages/calendar/agenda-view.tsx`
- `src/pages/wealth/cashflow-chart.tsx`
- `src/pages/health/weight-chart.tsx`
- `src/pages/health/sleep-chart.tsx`
- `src/pages/today/pomodoro-timer.tsx`

---

## [0.12.0] — 2026-03-03

### Phase 12: Quick Wins & Polish — Dashboard v2, Sidebar, Module Improvements

#### Added
- **Dashboard v2**: Health summary card (weight, mood, workouts), wealth snapshot card (net worth, P&L), habit completion rate card, weekly review due card
- **Sidebar improvements**: Collapsible groups with remembered preference, due/overdue count badges on Tasks and Chores
- **Data export/import**: Download all entities as JSON backup, upload to restore
- **Goal improvements**: Color-coded cards by progress (red/yellow/green), auto-progress from sub-goals
- **Task improvements**: Priority color on Kanban cards (red/orange/yellow/gray)
- **Habit improvements**: 90-day heatmap grid, streak milestone badges (7d, 30d, 90d)
- **Notes improvements**: Pin/favorite toggle, tag filter dropdown

---

## [0.11.0] — 2026-03-02

### Phase 11: Productivity — Today Page, Inbox Capture, Weekly Review

#### Added
- **Today page**: Single-screen daily dashboard with progress bar, priority picker, due tasks/chores checklist, habit strip with check-ins, event list, inbox items, and quick journal
- **Inbox capture**: Floating action button + `Cmd+Shift+I` shortcut for zero-friction note capture. Items appear on Today page for triage (convert to task or archive)
- **Weekly Review wizard**: 5-step guided flow — accomplishments, stale items, habits, spending, reflection. Saves reflection as journal note. Completion tracked in localStorage

---

## [0.10.5] — 2026-03-01

### Phase 10.5: Memories — Photo Journal

#### Added
- **Memories module**: Gallery + Timeline views with image upload and client-side compression (Canvas API)
- Lightbox overlay for full-resolution viewing
- Mood tracking (joyful, peaceful, nostalgic, excited, grateful, bittersweet)
- Storage budget indicator for localStorage (~3.5MB / ~15 photos)
- New `memory` entity type with base64-encoded images in metadata

---

## [0.10.0] — 2026-02-28

### Phase 10: Polish — PWA, Code Splitting, Mobile

#### Added
- PWA manifest + service worker (vite-plugin-pwa) with autoUpdate and offline caching
- Workbox runtime caching for iCal feeds (NetworkFirst strategy)
- App icons (192 + 512 SVG), apple-mobile-web-app meta tags
- Code splitting: React.lazy for 17 page routes
- Manual vendor chunks: react, ui, data, charts, maps, dnd
- Mobile-responsive layout padding
- Spinner fallback for lazy-loaded routes

---

## [0.9.0] — 2026-02-27

### Phase 9: Automate — Trigger/Action Engine

#### Added
- Trigger types: schedule (daily/weekly/monthly) and manual
- Action types: create-entity, notify, update-entities
- Automation cards with run count, last run, next due, manual run button
- 5 preset templates (Weekly Review, Monthly Budget Check, Daily Habit Reminder, Weekly Meal Plan, Weekly Grocery List)
- One-click template activation
- Engine evaluates due automations on page load

---

## [0.8.0] — 2026-02-26

### Phase 8: Family — Chores & Activity Feed

#### Added
- Chore cards with category, frequency, assignee, due date
- Category badges (cleaning, cooking, laundry, shopping, maintenance, pets)
- Category and assignee filter dropdowns
- Activity tab: chronological feed of shared entities
- Summary strip: total chores, due/overdue, my chores, shared tasks

---

## [0.7.0] — 2026-02-25

### Phase 7: Home — Devices & Services

#### Added
- Device cards: server, desktop, laptop, phone, tablet, router, IoT
- Service cards with status tracking (running/stopped/error)
- Services linked to devices via deviceId
- Summary strip: device count, service count, running count, error count

---

## [0.6.0] — 2026-02-24

### Phase 6: Health — Body, Workouts, Sleep & Mood

#### Added
- Body metrics table: weight, body fat, waist, chest, arms, BMI
- Workout cards: strength, cardio, flexibility, HIIT, sports
- Sleep & mood cards: sleep hours + quality, mood, energy level
- Summary strip: latest weight, 7d workouts, 7d avg sleep, today's mood
- New `sleep-mood` entity type

---

## [0.5.0] — 2026-02-23

### Phase 5: Wealth — Budget, Transactions, Portfolio

#### Added
- Transaction table with type/category filters and CRUD
- Budget cards with progress bars
- Account cards with balances
- Spending chart (Recharts bar) by category
- Summary strip: Net Worth, Cash, Portfolio, Monthly P&L
- Portfolio tab with asset tracking (crypto, defi, stocks, funds, gold, property)
- Asset cards with gain/loss, allocation donut chart
- Wallets tab: CEX, cold, hot, hardware wallets
- Crypto transaction ledger: buy/sell/swap/transfer linked to wallets

---

## [0.4.5] — 2026-02-22

### Phase 4.5: Capture, Social & Explore

#### Added
- Notes page with free-form notes + daily journal with mood
- Posts page — household activity feed with inline compose
- Notification system: sonner toasts, bell dropdown, history
- Places page with Leaflet map and OpenStreetMap tiles
- Travel page — trip planner linking places with map routes

---

## [0.4.0] — 2026-02-21

### Phase 4: Grow — Skills, Habits, Reading

#### Added
- Habits page with daily check-in, streaks, frequency badges
- Skills page with proficiency levels and related resources
- Reading page for books and courses with status and rating

---

## [0.3.0] — 2026-02-20

### Phase 3: AI Layer

#### Added
- AI provider system (OpenAI, Claude, Ollama, custom)
- AI client with streaming (SSE) + non-streaming fallback
- Context builder: gathers entities for system prompt
- Chat sidebar (Sheet) with conversation persistence
- Command bar (Cmd+K) with entity search + inline AI queries
- Daily brief dashboard widget with session-cached summary
- Prompt templates (daily brief, task breakdown, weekly review)

---

## [0.2.0] — 2026-02-19

### Phase 2: Plan — Goals, Tasks, Calendar

#### Added
- Dashboard with 4 widgets (tasks, goals, habits, quick add)
- Tasks page with list view + kanban board + drag-and-drop (dnd-kit)
- Goals page with sub-goal hierarchy and progress tracking
- Calendar page with month grid + iCal Google Calendar integration
- Entity dialog for create/edit with Zod validation

---

## [0.1.0] — 2026-02-18

### Phase 1: Foundation

#### Added
- React 19 + Vite + TypeScript + Tailwind + shadcn/ui scaffold
- Entity/Tracker/Schedule/Relation type system
- Repository pattern with localStorage backend
- TanStack Query hooks for data access
- Sidebar navigation with module registry
- PIN-based multi-user auth (JB + Sunny)
- Protected routes
