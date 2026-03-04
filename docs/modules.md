# Modules

Modules are thin layers over the core engine. Each module maps entity types to a UI page with specialized views. Adding a module is mostly configuration — the entity system, repository, and hooks handle the data.

## Module registry

Defined in `src/core/config/modules.ts`:

| Module | Route | Entity types | Group | Status |
|--------|-------|-------------|-------|--------|
| Dashboard | `/` | (all) | Overview | Done |
| Goals | `/goals` | `goal` | Plan | Done |
| Tasks | `/tasks` | `task` | Plan | Done |
| Calendar | `/calendar` | `event` | Plan | Done |
| Skills | `/skills` | `skill`, `course`, `book` | Grow | Done |
| Habits | `/habits` | `habit` | Grow | Done |
| Health | `/health` | `body-metric`, `workout`, `sleep-mood` | Health | Done |
| Wealth | `/wealth` | `transaction`, `budget`, `account`, `asset`, `wallet`, `crypto-tx` | Wealth | Done |
| Home | `/home` | `device`, `service` | Home | Done |
| Family | `/family` | `chore` | Family | Done |
| Automate | `/automate` | `automation` | Automate | Done |
| Today | `/today` | (aggregate) | Overview | Done |
| Review | `/review` | (aggregate) | Overview | Done |
| Notes | `/notes` | `note` | Capture | Done |
| Memories | `/memories` | `memory` | Capture | Done |
| Posts | `/posts` | `post` | Family | Done |
| Notifications | `/notifications` | (none) | Overview | Done |
| Places | `/places` | `place` | Explore | Done |
| Travel | `/travel` | `trip` | Explore | Done |

## Implemented modules

### Dashboard

Four widgets + daily brief:
- **Daily Brief** — AI-powered stats and summary (Phase 3)
- **Today's Tasks** — due today or overdue, with checkboxes
- **Goal Progress** — top 5 active goals with progress bars
- **Habits** — active habits with today's check-in indicator
- **Quick Add** — buttons to create task/goal/event inline

### Goals

- Grid view of top-level goals (cards with progress)
- Detail view showing sub-goals and computed progress
- Status filtering (active/completed/paused/archived)
- CRUD via entity dialog

### Tasks

- **List view** with status/priority filters and sort (date, priority, title)
- **Kanban view** with columns: Active, In Progress, Completed, Archived
- Drag-and-drop between columns (dnd-kit)
- CRUD via entity dialog

### Calendar

- Month grid with entity due dates
- iCal feed integration (Google Calendar via `.ics` URL)
- Inline event creation (click a day)
- Feed management dialog for adding/removing iCal sources

### Notes
- Tabs: Notes tab + Journal tab
- Notes tab: card grid with status filter, search, CRUD
- Journal tab: date-grouped entries with mood tracking
- Uses entity type `note` with `metadata.isJournal` to differentiate

### Posts
- Activity feed for household status updates
- Inline compose box with visibility selector (private/shared)
- Reverse-chronological card feed with author avatars
- Edit/delete for own posts only

### Notifications
- Client-side notification system using Zustand store
- `notify()` utility fires sonner toast + persists to store
- Bell icon in TopBar with unread badge and dropdown
- Full history page at `/notifications` with mark-read and clear-all

### Places
- Two-column layout: sidebar list + interactive Leaflet map
- OpenStreetMap tiles (no API key required)
- Markers with popups, search, category filtering
- CRUD via entity dialog

### Travel
- Trip planner linking places via Relations
- Two-column: trip list + map with connected markers
- Polyline connecting trip places on map
- Add/remove places from trips

### Wealth
- Six tabs: Transactions, Budgets, Accounts, Portfolio, Wallets, Crypto Txs
- Summary strip: Net Worth, Cash, Portfolio, Monthly P&L
- Transaction table with type/category filters and inline actions
- Budget cards with progress bars (computed spent from transactions)
- Spending chart (Recharts horizontal bar) by category
- Account cards with balance display and cash total
- Portfolio tab with asset cards, class/chain/protocol filters, allocation donut chart, and unrealized gain/loss
- Asset types: crypto, defi, stock, fund, gold, property — quantity-based or value-based
- Wallets tab: track CEX accounts and cold/hot/hardware wallets with addresses and chains
- Crypto Txs tab: buy/sell/swap/transfer ledger with action/symbol filters, linked to wallets
- Assets can be linked to wallets (walletId) for crypto/defi classes
- Custom dialogs for each entity type (react-hook-form + zod)

### Health
- Three tabs: Body Metrics, Workouts, Sleep & Mood
- Summary strip: Weight (latest), Workouts (7d count), Avg Sleep (7d), Today's Mood
- Body metrics table with metric type filter (weight, body fat, waist, chest, arms, BMI)
- Workout cards with type badges, duration, calories, exercises
- Sleep & mood cards with sleep hours, quality badge, mood badge, energy level
- Custom dialogs for each entry type (react-hook-form + zod)

### Home
- Two tabs: Devices, Services
- Summary strip: Device count, Service count, Running (green), Errors (red)
- Device cards with type badges (server, desktop, laptop, phone, tablet, router, IoT), IP, MAC, OS, location
- Service cards with type + status badges, URL/port, linked device name, Docker image
- Service types: docker, web, database, api, monitoring, media
- Service statuses: running (green), stopped (gray), error (red), unknown (yellow)
- Custom dialogs for each entity type (react-hook-form + zod)

### Family
- Two tabs: Chores, Activity
- Summary strip: Total chores, Due/Overdue (red), My Chores, Shared Tasks
- Chore cards with category badges (cleaning, cooking, laundry, shopping, maintenance, pets), frequency, assignee, due date
- Category and assignee filter dropdowns
- Activity tab: chronological feed of all shared entities across all modules (most recent 50)
- Activity entries show author avatar, entity type badge, relative time, title, status
- Custom chore dialog (react-hook-form + zod)

### Today (Focus Mode)
- Single-page daily focus view — no tabs, no filters
- "Pick 3 priorities" prompt (active tasks/goals, resets daily)
- Due tasks checklist with overdue indicators
- Due chores checklist
- Today's events list
- Habit strip with toggle check-in and streak counts
- Inbox section: untriaged quick-capture items with "Convert to Task" and "Archive" actions
- Quick journal: inline textarea that saves as journal note
- Overall progress bar (tasks + habits done / total)
- Link to Weekly Review

### Weekly Review Wizard
- 5-step guided review at `/review`
- Step 1 — Accomplishments: completed tasks/goals this week
- Step 2 — Stale Items: active items not updated in 14+ days, with archive action
- Step 3 — Habits: weekly check-in counts and streaks with progress bars
- Step 4 — Spending: this week's income/expenses vs monthly budget
- Step 5 — Reflection: free-text journal that saves as review note
- Step indicator with clickable navigation
- Review completion stored in localStorage (once per week)

### Inbox (Quick Capture)
- Floating action button (bottom-right) visible on all pages
- `Cmd+Shift+I` keyboard shortcut
- Minimal capture modal: textarea + Enter to save
- Saves as `note` entity with `metadata.isInbox: true`
- Inbox count badge on floating button
- Triage on Today page: convert to task or archive

### Memories
- Photo journal / memory board with image upload and compression
- Gallery tab: responsive card grid with thumbnail images (aspect 4:3)
- Timeline tab: chronological feed grouped by month/year
- Lightbox: full-image overlay with caption and metadata
- Image compression via Canvas API (max 200KB full, ~30KB thumbnail)
- Mood tracking: joyful, peaceful, nostalgic, excited, grateful, bittersweet
- Summary strip: Total Memories, This Month, Top Mood, Storage Used
- Mood filter + date sort (newest/oldest)
- Storage budget indicator (~3.5MB for ~15 photos in localStorage)
- Custom memory dialog with image upload zone (react-hook-form + zod)

### Automate
- Two tabs: Automations, Templates
- Summary strip: Automation count, Active (green), Scheduled, Total Runs
- Trigger types: schedule (daily/weekly/monthly) and manual (run on demand)
- Action types: Create Entity, Send Notification, Update Entities
- Automation cards with trigger/action info, run count, last run, next due, and manual run button
- Templates tab: 5 preset automations (Weekly Review, Monthly Budget Check, Daily Habit Reminder, Weekly Meal Plan, Weekly Grocery List)
- One-click template activation (prevents duplicates)
- Automation engine runs due scheduled automations on page load (once per day per session)
- Custom automation dialog with conditional action config fields (react-hook-form + zod)

All modules are now implemented. No stub pages remain.

1. Define entity type(s) in `src/core/types/entity.ts`
2. Add module config to `src/core/config/modules.ts`
3. Create page component in `src/pages/`
4. Add route in `src/app.tsx`
5. Use `useEntities(type)` — the hook and repository already work

No new database tables, no new API endpoints, no new stores. The core engine handles it.
