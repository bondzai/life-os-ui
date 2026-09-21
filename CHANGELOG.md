# Changelog

All notable changes to Lyra are documented here.

> **Two changelogs, one of them maintained.** This file is for GitHub; `src/lib/changelog-data.ts`
> ships inside the app behind the changelog dialog and is what recorded the Lean removals. They had
> drifted a long way apart — this file stopped at 1.3.0 while the app ran to 2.5.0 — and the entries
> for 1.4.0 through 2.5.0 below are a catch-up summary of that file, not a second source of truth.
> Hand-maintaining both is what produced the drift; see the decision in
> [`docs/assistant-roadmap.md`](./docs/assistant-roadmap.md) about generating this file from the
> other.

> **The server era is versionless.** `package.json` has read `2.5.0` since April while the entire
> Rust backend, the wealth surface, the Telegram bot and the DeFi rewrite shipped underneath it.
> Those are recorded below by date rather than by version, which is honest about how they were
> released — continuously, to one box.

---

## Unreleased — the server era

### 2026-09-21 — The DeFi page, one screen at a time

#### Changed
- **`/wealth/defi` is one bar and one ledger.** Five equal-weight stat cards became one primary
  figure with four set inline — two levels of emphasis instead of none, at a third of the height,
  and no 3 + 2 wrap at `lg`. Out of range is a state rather than a quantity, so it filters itself:
  the number telling you to act is one click from acting.
- **Borrowed, worst health factor and ready-to-harvest moved into the bar.** Borrowed reads the
  whole book, not the filtered rows — liquidation does not care which chain you are looking at.
  Worst health factor, never an average, and coloured only below the same 1.5 threshold that gates
  the Telegram alert. Absent entirely on a wallet that does not borrow.
- **Loans joined the LP table.** The one row that can liquidate you was the one row you could not
  see. Range became Health, because an LP marker nearing its band edge and a health factor nearing
  1 are the same shape of warning. Value is the protocol-aware net, which on Aave is the debt alone
  — the collateral is already in the book as spot aTokens, and the cell spells that out.
- **The page draws on the first frame** and only the cells arrive late. A waiting figure draws a bar
  the size of its number rather than `$0.00` (a lie about someone's money) or `—` (this codebase's
  word for "we looked and could not read it").
- **Clickability is drawn, not implied.** The snowball, claimable-by-token and the borrowing panel
  open from the figures they belong to, each marked with the same expand glyph and accessible name.
- **The "In range" badge is gone.** It fired on the healthy majority and was the loudest thing in
  the row. `null` keeps a neutral badge — a range the server could not determine must never render
  as healthy — and "full range" keeps its own, because it is a different kind of position.
- **Sidebar grouped by rhythm**: Now / Plan / Money instead of Daily (2) and Plan (9). Inbox and
  Deep Work are listed; Knowledge moved to Settings and kept its route.
- **`g` + a letter jumps to any page**, shown on hover beside each sidebar item. `goKeyIndex` throws
  at import on a duplicate key.
- **One capture surface.** The `⌘⇧I` dialog, the `/`-stealing bar and the `⌘K` palette became one:
  the first character decides — bare text finds, a prefix creates, `/ask` asks.

#### Removed
- The notifications *page*. It was the list the bell already drops down, plus two buttons that now
  live in the dropdown.
- Six components nothing imported, and 533 lines nothing could reach.

#### Fixed
- Four copies of "how long ago" and three of "what is this day's key" collapsed into
  `src/lib/dates.ts`. One of the three was a real bug: the week view built its key with
  `toISOString()`, so east of Greenwich every column keyed one day behind the month view beside it.
- Wealth win/loss colours raised to AA contrast.

### 2026-09-20 — Projects are a type again

#### Added
- **Projects has its own type and page.** March merged Project into Goal; that was right for a goal
  tree and wrong for a body of work. No migration and no new table — the live database held zero
  project entities, so the merge was complete and this reverses it cleanly. The optional half
  (client, repo, stack) lives in `metadata`.
- **A task can say which project it belongs to.** The picker offers projects and goals, grouped,
  and drops archived entries. One `metadata.projectId` field serves both, because ids are unique
  across types — two fields would mean rewriting every existing row to guess what an old id meant.

#### Changed
- Project progress is derived from task counts, never stored. Which project is open lives in the
  URL, not in state.
- Deleting a project says what happens to its tasks: the API hard-deletes with no cascade, so they
  stay and lose their project. A dangling id reads as "Unknown (deleted)".

### 2026-09-19 — A second channel

#### Added
- **Discord delivery.** The webhook URL ends in a token, so it is the credential: no `Display`, a
  hand-written `Debug` that prints `[redacted]`, no public accessor, every error path scrubbed, and
  the **host checked on construction** — a "which host do we post to" setting is a
  credential-exfiltration switch. `http://` is refused too. Configured with `DISCORD_WEBHOOK_URL`.
- **`telegram_to_discord`**, because two markdowns that look alike are the trap worth a translator:
  Telegram reads `*bold*`, Discord reads `**bold**`, and passing one to the other emphasises every
  digest heading the wrong way — quietly.
- **`Channels` fans one alert out to every configured channel.** Delivered means delivered
  *somewhere*: an alert that reached your phone has done its job, and failing the sweep because
  Discord was down would turn redundancy into a new way to lose an alert. Nothing configured is
  still `NotConfigured`, never a failure.

#### Fixed
- **The transport decides how to escape, not the author.** Bot replies built from on-chain names
  went out with `parse_mode: Markdown`; one `*` in a pool name and Telegram rejected the whole
  request, so the reply was silently never delivered. `Message::plain` is now escaped by the sender
  and `Message::telegram_markup` passed through. Escaping strips rather than backslash-escapes,
  because removal cannot produce an unbalanced entity.

#### Known
- `/api/wealth/alerts` still reports `can_send` for Telegram alone, so a Discord-only box delivers
  alerts while the settings page says it cannot. That field is parity-gated; widening it would fail
  the diff. Documented at `telegram_ready` and in [`docs/alerts.md`](./docs/alerts.md).

### 2026-09-17 — Opportunities, and what pays an APR

#### Added
- **The Opportunities board** (`/wealth/opportunities`): vfat's whole universe — thousands of pools
  across 63 protocols — rather than only what beats what you already hold. Every control is a query
  parameter, because filtering in the browser would be slower and would throw away facets their API
  already computes.
- **APR basis on every row.** Two WETH/USDC rows quoted 86.9% and 72.0%; the higher one was entirely
  staking emissions and the lower one entirely swap fees, and nothing said so. Each row now names
  what pays it and flags a window resting on less data than it claims.
- **`vfat-status`** reads `/v4/aggregation-delay` and reports how far behind vfat's own view of each
  chain is. This is the failure `LAST_GOOD_MAX_AGE_SECS` was written to survive without being able
  to name: farm-balances answers 200 with data that is quietly hours old.

Both new routes sit **outside the parity gate** deliberately — they answer questions the Python was
never asked, and `portfolio` and `yield-radar` cannot grow fields without failing the diff.

### 2026-09-06 — What a position has actually made

#### Added
- **LP position performance** via vfat's `position-performance`, undocumented until they published
  their OpenAPI. One request per wallet for the whole portfolio, singleflighted behind the same
  per-key lock `farm_balances` uses.
- **`marks.tsx`** — shape encodes kind, so a column of identical grey dots stops being a column
  carrying no information.
- **Chain display names in `identity.ts`.** `chainLabel` title-cased the API's slug, so every table
  said "Bnb", "Hyperevm" and "Kucoin" — names nobody uses, which read as a data bug.

#### Changed
- Claimable-by-token became a ranked list filled to each token's share of the *total*, so "one token
  is most of this, the rest is dust" lands before a number is read.
- Token amounts stopped rendering in scientific notation.

### 2026-08-21 → 2026-08-23 — Telegram answers back

#### Added
- **The Telegram command bot** (`tgbot.rs`). `lyra-alerts` pushed alerts out; this pulls commands
  in. Eleven wealth commands, long-polled rather than webhooked because the box sits behind a home
  router with nothing forwarded. Only the pinned `TELEGRAM_CHAT_ID` is answered — a stranger's
  message is counted and dropped, never answered and never echoed. See
  [`docs/telegram.md`](./docs/telegram.md).
- **Off-chain assets** get a server-side home, so the net-worth snapshot counts them.
- **The book reads in USD, THB or sats.**
- **Wallets are managed in the app**, and non-EVM ones stop being dropped.
- **Lyra runs as a local service from one binary**, with the stack verified through nginx.

#### Fixed
- **The bot token was in the logs.** `reqwest::Error` renders the URL it failed on, and that URL
  carries the token, so every transient blip wrote the secret to `server.log` in plain text. Both
  call sites now log `e.without_url()`. **Rotate the token if a log from before 2026-08-23 ever left
  this machine.**
- **A malformed poll URL failed exactly like an outage.** Nine literal spaces from a
  `\`-continuation meant every poll failed for a day while messages queued unread, and the log said
  `error sending request` — which is what a network problem says too. `updates_url` builds it on one
  line now, with a test.
- HyperEVM spot is read over RPC, since its indexer is gone.

### 2026-03 → 2026-08 — The Rust port

#### Changed
- **The TypeScript backend is gone and the Rust stack is the only one.** One `axum` + `sqlx` binary
  over SQLite in WAL, forward-only migrations applied at startup, and the chain fan-out and alert
  sweep in-process so their upstream caches are shared with the request path — an alert can never
  disagree with the page it points at.
- **The Python oracle was deleted**, keeping its data and a way back, once the parity harness had
  gated portfolio, yield-radar, alerts and services at 0.5%.

#### Added
- `lyra-mcp`, the MCP research desk: ten wealth tools over a keyless portfolio, read-only by
  construction. See [`docs/mcp.md`](./docs/mcp.md).
- Git-backed knowledge notes, the whole wealth surface on live data, and the deployment stack.

---

## [2.5.0] — 2026-04-02 — Lean

#### Removed
- **Sidebar cut from 17 items to 8.** Removed pages: Lyra, Timeline/Gantt, Events, Note Map, Goal
  Map, Skills, Sessions, Learning, Travel, Family, Health, Wealth, Projects. Chat stayed available
  through the sidebar; `⌘K` still navigated everywhere remaining.
- Precache fell from 3418 KB to 1857 KB.

*Wealth and Projects have both since returned — Wealth as the Rust-backed module, Projects as its
own type in September.*

## [2.4.9] — 2026-03-31 — Lyra Protocol

#### Added
- Settings page, configurable keybindings with OS-conflict detection, briefing window (`⌘⇧B`),
  Deep Work shortcut (`⌘⇧D`), accordion subtasks, "move under…", promote-to-task, pretty-JSON note
  rendering, inline note editing.
- The first 59 unit tests across entity helpers, task helpers, capture protocol, keybindings and
  focus stats.

## [2.3.0] — 2026-03-31 — Lyra Protocol

#### Added
- **Weekly planning**: three weekly outcomes, day-bucket allocation, an intel briefing over carried
  tasks, deadlines, velocity gaps and calendar load. Daily Protocol auto-populates today's
  priorities from it.
- Distraction tally, auto-pause on tab switch, session micro-goal, focus streak badge.

#### Changed
- **Entity simplification**: Project merged into Goal, Chore into Task — three mental models:
  outcome, action, system. *(The Project half was reversed in September; see 2026-09-20.)*
- Habits unified as protocols — every habit needs steps, and a streak increments only when all of
  them are done.

## [2.2.0] — 2026-03-22 — Lyra Foresight

#### Added
- Threat Radar, the Connection Engine, the Scenario Simulator, and a Foresight dashboard tab.

## [2.1.0] — 2026-03-22 — Lyra Memory

#### Added
- Persistent memory across conversations: silent post-chat extraction, injection at the start of
  each conversation, five categories, and a memory UI.

## [2.0.0] — 2026-03-22 — Aegis: Strategic Intelligence

#### Added
- Strategic Board, the Knowledge Profile hook over every note and decision, the Strategic Moves
  tool, the Scoreboard, and web search through a DuckDuckGo proxy on the API.

## [1.5.0] — 2026-03-22 — Smart Capture

#### Added
- Natural-language capture parsed into type, title, priority, due date, project and subtasks, with
  the prefix fast path (`!` `?` `*` `@` `#`) bypassing AI entirely and a graceful offline fallback.

## [1.4.0] — 2026-03-22 — AI Co-Pilot

#### Added
- Smart priority suggestion, the session planner, the deep-work assistant, post-session reflection,
  and the session-patterns hook.

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
