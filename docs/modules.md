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
| Skills | `/skills` | `skill`, `course`, `book` | Grow | Stub |
| Habits | `/habits` | `habit` | Grow | Stub |
| Health | `/health` | `body-metric`, `workout` | Health | Stub |
| Wealth | `/wealth` | `transaction`, `budget`, `account` | Wealth | Stub |
| Home | `/home` | `device`, `service` | Home | Stub |
| Family | `/family` | `chore` | Family | Stub |

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

## Stub modules

Skills, Habits, Health, Wealth, Home, and Family have placeholder pages. Each will be implemented in its roadmap phase using the same entity + hook + dialog pattern.

## Adding a new module

1. Define entity type(s) in `src/core/types/entity.ts`
2. Add module config to `src/core/config/modules.ts`
3. Create page component in `src/pages/`
4. Add route in `src/app.tsx`
5. Use `useEntities(type)` — the hook and repository already work

No new database tables, no new API endpoints, no new stores. The core engine handles it.
