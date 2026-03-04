# Productivity Features

Three features designed to reduce decision fatigue, minimize friction, and build consistent review habits.

---

## 1. Focus Mode — "Today" Page

### Problem
17 modules means 17 places to check. Users waste mental energy deciding *where* to look instead of *doing* the work.

### Solution
A single `/today` page that aggregates everything relevant to *right now*:

| Section | Source | Display |
|---------|--------|---------|
| Top 3 Priorities | User picks each morning (stored in localStorage) | Prominent cards with checkboxes |
| Due Tasks | `task` entities where `dueDate <= today` | Compact checklist |
| Due Chores | `chore` entities where `dueDate <= today` | Compact checklist with assignee |
| Habit Check-ins | `habit` entities (active) | Toggle buttons with streak count |
| Today's Events | `event` entities where `dueDate === today` | Time + title list |
| Quick Journal | Inline textarea | Saves as `note` with `isJournal: true` |

### UI Layout
- No tabs, no filters — one scrollable page
- "Pick your 3 priorities" prompt at top (only if not set today)
- Minimal cards, high density, no decorative elements
- Progress indicator: "4 of 7 done today"

### Data
- New localStorage key `life-os:today-priorities` — `{ date: string, ids: string[] }`
- No new entity types — reads existing tasks, chores, habits, events, notes
- Priorities reset daily (auto-clear if date !== today)

### Module Config
- Route: `/today`
- Icon: `Sun` (lucide)
- Group: `Overview` (positioned after Dashboard)

---

## 2. Inbox — Quick Capture

### Problem
Capturing a thought requires: navigate to Notes → click New → fill title → save. Too many steps. Ideas get lost.

### Solution
A floating capture button + modal that saves raw text with zero friction.

### How It Works
1. Floating action button (bottom-right corner) visible on all pages
2. Click → modal with single textarea + Enter to save
3. Saves as a `note` entity with `metadata.isInbox: true` and auto-generated title (first 50 chars or "Inbox item")
4. Inbox items appear in a dedicated section on the Today page and Notes page
5. User triages later: convert to task, add to a goal, tag it, or archive

### UI
- **Capture button**: Fixed `bottom-6 right-6`, circular, `Plus` icon, `z-40`
- **Capture modal**: Minimal — textarea + "Save" button, closes on save
- **Keyboard shortcut**: `Cmd+Shift+I` (or configurable)
- **Inbox section on Today page**: Collapsible list of untriaged items with "Convert to Task" and "Archive" actions

### Data
- Uses existing `note` entity type
- `metadata.isInbox: true` distinguishes inbox items from regular notes
- No new entity types or stores

### Triage Actions
- **Convert to Task**: Creates a `task` entity from the inbox note, archives the note
- **Archive**: Sets `status: 'archived'`
- **Edit**: Opens full note editor

---

## 3. Weekly Review Wizard

### Problem
The existing "Weekly Review" automation just creates a task reminder. It doesn't guide the user through an actual review process.

### Solution
A multi-step wizard at `/review` that walks through 5 review stages with real data.

### Stages

| Step | Title | What It Shows | User Action |
|------|-------|---------------|-------------|
| 1 | Accomplishments | Completed tasks & goals this week | Read + celebrate |
| 2 | Stale Items | Tasks/goals not touched in 14+ days | Archive, reschedule, or keep |
| 3 | Habit Streaks | Active habits with streak + this week's check-ins | Reflect on consistency |
| 4 | Spending Check | This week's transactions total vs budget | Awareness (read-only) |
| 5 | Reflection | Free-text journal prompt: "What went well? What to improve?" | Saves as journal note |

### UI
- Step indicator at top (1/5, 2/5, etc.)
- Back / Next navigation
- Each step is a focused card with relevant data
- Final step saves a journal entry and marks review as done
- "Review completed" state stored in localStorage with date (prevents re-triggering same week)

### Data
- Reads existing entities: tasks, goals, habits, trackers, transactions, notes
- Saves reflection as `note` entity with `metadata.isJournal: true, metadata.isReview: true`
- localStorage key `life-os:last-review` — ISO date string
- No new entity types

### Module Config
- Route: `/review`
- Icon: `ClipboardCheck` (lucide)
- Group: `Overview`
- Not shown in sidebar by default — triggered from Dashboard or Today page via "Start Weekly Review" button

---

## Design Principles

These features share common principles:

1. **No new entity types** — reuse existing primitives (task, note, habit, event, chore)
2. **Zero config** — works out of the box, no setup required
3. **Minimal UI** — every element earns its place, no decorative clutter
4. **Daily + weekly rhythm** — Today page for daily focus, Weekly Review for reflection
5. **Capture → Triage → Execute** — Inbox captures freely, Today focuses, Review cleans up
