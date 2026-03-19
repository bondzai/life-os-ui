export { version as APP_VERSION } from '../../package.json'

interface ChangelogSection {
  title: string
  items: string[]
}

interface ChangelogRelease {
  version: string
  date: string
  phase: string
  sections: ChangelogSection[]
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '0.50.0',
    date: '2026-03-19',
    phase: 'Recurring Tasks, Stale Detector & Strategic Blueprint',
    sections: [
      {
        title: 'Added',
        items: [
          '**Recurring tasks**: Set daily/weekly/biweekly/monthly recurrence — next occurrence auto-created on completion',
          '**Stale item detector**: Focus page shows items untouched 14+ days with snooze/archive actions',
          '**Strategic blueprint**: INTJ invisible empire framework doc + Phase 17 roadmap in TODO',
        ],
      },
    ],
  },
  {
    version: '0.49.0',
    date: '2026-03-19',
    phase: 'Sidebar Reorganization',
    sections: [
      {
        title: 'Improved',
        items: [
          '**Strategic sidebar groups**: Reorganized from Core/Track/Life to Command/Operate/Track/Life — maps to INTJ workflow: strategy → execution → measurement → growth',
        ],
      },
    ],
  },
  {
    version: '0.48.0',
    date: '2026-03-19',
    phase: 'Focus Cockpit & Arrow Balance',
    sections: [
      {
        title: 'Improved',
        items: [
          '**Review under Focus**: Weekly Review moved into Focus sub-menu — plan, execute, reflect in one cockpit',
          '**Chevron balance**: Arrow moved inline with menu label for cleaner visual alignment',
        ],
      },
    ],
  },
  {
    version: '0.47.0',
    date: '2026-03-19',
    phase: 'Sidebar Redesign & Navigation',
    sections: [
      {
        title: 'Added',
        items: [
          '**Emperor Time sub-menu**: Sessions moved under Focus as "Emperor Time" child item',
          '**Collapsible sub-menus**: Module items with children show chevron toggle with persistent state',
          '**Group header chevrons**: Rotating arrow affordance on all collapsible sidebar groups',
        ],
      },
    ],
  },
  {
    version: '0.46.0',
    date: '2026-03-19',
    phase: 'Calendar Redesign & Emperor Time Editing',
    sections: [
      {
        title: 'Added',
        items: [
          '**Google Calendar month grid**: Full-grid month view with inline colored event bars on all screen sizes',
          '**iCal feed toggle chips**: Quick enable/disable feeds from the calendar toolbar',
          '**Inline editing in Emperor Time**: Edit task and subtask titles via pencil icon during focus sessions',
          '**Auto-sync feed colors**: Feed color updates from Google Calendar API on each fetch',
        ],
      },
      {
        title: 'Fixed',
        items: [
          '**iCal color override**: Events now respect feed configured color instead of always rendering blue',
          '**Calendar default filter**: Only show events and iCal feeds by default (not tasks/goals/habits)',
        ],
      },
    ],
  },
  {
    version: '0.45.0',
    date: '2026-03-18',
    phase: 'Backend, Migrations & Setup',
    sections: [
      {
        title: 'Added',
        items: [
          '**Turso/libsql backend**: Migrated API from better-sqlite3 to @libsql/client for cloud DB support',
          '**Drizzle migrations**: Auto-apply schema migrations on deploy via `db:migrate`',
          '**Versioned data backups**: Export/import now handles schema diffs — old backups auto-migrate on import',
          '**Render deployment**: Blueprint for one-click deploy (static frontend + Node API)',
          '**Setup docs**: Comprehensive SETUP.md with local, Render, and Docker instructions',
        ],
      },
      {
        title: 'Fixed',
        items: [
          '**Resume Focus badge**: Only shows after clicking Start Focus, not on Emperor Time entry',
          '**Duplicate checkbox**: Removed extra selection checkbox from task list view',
          '**Unused props cleanup**: Removed dead selectedTasks props from ListTaskWrapper',
        ],
      },
    ],
  },
  {
    version: '0.44.0',
    date: '2026-03-18',
    phase: 'Focus Sessions, Jira-style Status & 3-State Subtasks',
    sections: [
      {
        title: 'Added',
        items: [
          '**Session ID tracking**: Each Emperor Time session gets a unique ID, grouping pomodoros visually',
          '**Session history in Emperor Time**: View, edit, and delete logged pomodoros inline during focus',
          '**Sessions CRUD page**: Dedicated `/sessions` route with full session management and analytics',
          '**Enriched session logs**: Logs now include preset, workMinutes, pomodoroIndex, and workspace',
          '**3-state subtasks**: Subtasks cycle `todo → in-progress → done` instead of simple checkbox',
          '**Auto-derive parent status**: Parent task updates to `in-progress` or `done` based on subtask states',
          '**Persistent focus timer**: Timer state survives page navigation — leave and resume without losing progress',
          '**Resume Focus badge**: Pulsing amber sidebar badge reminds you of a paused focus session',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**EntityStatus migration**: Replaced `active/completed/paused` with Jira-style `todo/in-progress/done` across entire codebase',
          '**Kanban columns**: Now labeled TO DO / IN PROGRESS / DONE matching new status values',
          '**Focus page exit**: Leaving Emperor Time pauses the timer instead of ending the session',
          '**Focus log grouping**: Dashboard focus log groups pomodoros by session ID with expandable emperor time blocks',
        ],
      },
    ],
  },
  {
    version: '0.43.0',
    date: '2026-03-18',
    phase: 'Rebrand to Lyra',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Brand**: Rebranded from Life-OS to **Lyra** — constellation-themed, clean & modern',
          '**Logo**: New "Ly" monogram with star accent on dark background',
          '**Storage**: All localStorage keys migrated from `life-os:` to `lyra:` prefix',
          '**Task keys**: Changed from `LO-XXX` to `LY-XXX` format',
          '**Package names**: `lyra` (frontend) and `lyra-api` (backend)',
          '**Database**: Renamed to `lyra.db`',
          '**Deploy**: Updated Render service name, CORS origins, and startup script',
        ],
      },
    ],
  },
  {
    version: '0.42.0',
    date: '2026-03-18',
    phase: 'Backlog, Workspace & Subtask Polish',
    sections: [
      {
        title: 'Added',
        items: [
          '**Backlog status**: New `backlog` status for parking tasks before sprint planning',
          '**Backlog view**: Dedicated tab with table layout, story points summary, and bulk "Move to To Do"',
          '**Workspace switcher**: Jira-style top-level project navigation with task counts',
          '**Story points**: Fibonacci estimation (1–13) on tasks, shown on cards and backlog table',
          '**Due date shortcuts**: Quick-set buttons (Today, Tomorrow, Next week, None) in detail panel',
          '**Workspace editor**: Change workspace from detail panel via dropdown (was read-only)',
          '**Workspace badges**: Colored badges (blue/green) on task cards',
        ],
      },
      {
        title: 'Improved',
        items: [
          '**Subtask UX**: Jira-style bordered rows with inline title editing, reorder arrows, status badges, edit/delete icons',
          '**Focus page fix**: Deep work and Today priority pickers now include in-progress tasks and filter by workspace',
          '**Workspace source fix**: Detail panel reads workspace from `metadata.workspace` instead of tags',
          '**Kanban board**: 3 columns (TO DO / IN PROGRESS / DONE) — backlog is a separate view like Jira sprint board',
          '**Filter bar**: Workspace removed from filters (now top-level nav); clear preserves workspace selection',
        ],
      },
    ],
  },
  {
    version: '0.41.0',
    date: '2026-03-18',
    phase: 'Jira-Style Tasks Redesign',
    sections: [
      {
        title: 'Added',
        items: [
          '**Compact task cards**: Type icons, task keys (LY-001), priority arrows, and progress bars on every card',
          '**Detail panel**: Right slide-in panel with inline editing and status workflow',
          '**Inline filter bar**: Search, workspace, priority, and type filters in a single bar',
          '**Kanban board redesign**: TO DO / IN PROGRESS / DONE columns with quick-add',
          '**Parent task assignment**: Set any task as a subtask of another',
          '**Empty story creation**: Add subtasks later like Jira',
          '**Subtask-driven status**: Parent auto-syncs with subtask completion',
          '**Workspace isolation**: Task relationships scoped to workspace',
        ],
      },
    ],
  },
  {
    version: '0.40.0',
    date: '2026-03-16',
    phase: 'Security & Performance Fixes',
    sections: [
      {
        title: 'Security',
        items: [
          '**OAuth CSRF fix**: Replaced plaintext userId in OAuth state with crypto-random token + server-side validation with 10-min TTL',
          '**Relations ownership**: GET/DELETE routes now filter by user\'s entity ownership — no cross-user data access',
          '**Schedules ownership**: All routes now verify the linked entity belongs to the authenticated user',
          '**Tracker ownership**: GET /:id now checks ownerId before returning data',
        ],
      },
      {
        title: 'Performance',
        items: [
          '**Deep Work timer fix**: Stabilized interval with useRef callback pattern — no more drift from dependency cascades',
          '**AudioContext reuse**: Single AudioContext instance for chime instead of creating new one each time',
          '**Focus stats single-pass**: Replaced 7+ passes through trackers with single pass + indexed maps (O(n) → O(n))',
        ],
      },
    ],
  },
  {
    version: '0.39.0',
    date: '2026-03-15',
    phase: 'Deep Work Log & Analytics',
    sections: [
      {
        title: 'Added',
        items: [
          '**Deep Work log**: Accordion in Quick Summary showing today\'s sessions, weekly bar chart, top focused tasks, and focus streak',
          '**Weekly comparison**: This week\'s focus time vs last week with +/- diff',
          '**Top Focus tasks**: Ranked list of which stories got the most focus time with progress bars',
          '**Focus streak**: Consecutive days with at least one deep work session',
          '**Focus stats library**: Pure calculation functions reusable by Dashboard and AI context',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`focus-stats.ts` — Pure functions: `calcFocusStats()` and `formatMinutes()` for deep work analytics',
        ],
      },
    ],
  },
  {
    version: '0.38.0',
    date: '2026-03-15',
    phase: 'Deep Work Mode with Pomodoro Timer',
    sections: [
      {
        title: 'Added',
        items: [
          '**Deep Work mode**: Full-screen distraction-free focus view — hides sidebar, topbar, everything',
          '**Pomodoro timer**: Large countdown display with work/break cycles, progress bar, and audio chime on completion',
          '**3 presets**: Classic (25/5 min), Deep (50/10 min), Sprint (90/20 min) — switch from bottom bar',
          '**Task picker**: If no task selected, shows a picker to choose what to focus on',
          '**Subtask checklist**: Active story\'s subtasks shown with current step highlighted — check off steps during focus',
          '**Auto-session logging**: Completed work sessions automatically logged as trackers (`focus-min` unit)',
          '**Session counter**: Shows "Session 2/4" with daily focus total in minutes',
          '**Focus button on stories**: Each story card on Focus page has a "Focus" button to enter deep work',
          '**Esc to exit**: Press Escape or click X to leave deep work mode',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`focus-store.ts` — Zustand store for deep work state, timer settings, and presets',
          '`deep-work.tsx` — Full-screen focus page with Pomodoro timer, task display, and session logging',
        ],
      },
    ],
  },
  {
    version: '0.37.0',
    date: '2026-03-15',
    phase: 'Demo Mode — Portfolio-Ready Mock Data',
    sections: [
      {
        title: 'Added',
        items: [
          '**Demo mode**: New data mode that fills the app with realistic mock data — tasks, stories, goals, habits, protocols, events, health metrics, workouts, sleep data, finances, books, and more',
          '**Auto-login for demo**: Demo mode creates a "Demo User" and auto-authenticates — no login needed for portfolio visitors',
          '**3-way data toggle**: Settings now shows Local / API / Demo with visual cards — switch between modes instantly',
          '**Clean mode switching**: Switching away from Demo clears mock data, switching to Demo regenerates fresh data',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`mock-data.ts` — Generates 80+ realistic entities across all modules with trackers, health profile, and auth state',
        ],
      },
    ],
  },
  {
    version: '0.36.0',
    date: '2026-03-15',
    phase: 'Settings & Data Mode Toggle',
    sections: [
      {
        title: 'Added',
        items: [
          '**Settings dialog**: Gear icon in sidebar footer opens settings panel',
          '**Data mode toggle**: Switch between Local (browser localStorage) and API (server + database) mode at runtime — no rebuild needed',
          '**App info**: Settings shows version, current data mode, and platform info',
          '**Realtime clock**: Focus page header shows live clock with timezone',
          '**Standup workspace filter**: Filter standup report by All/Work/Personal',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`settings-dialog.tsx` — Settings dialog with data mode toggle and app info',
        ],
      },
    ],
  },
  {
    version: '0.35.0',
    date: '2026-03-15',
    phase: 'Smart Focus — Type-Aware Rendering',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Focus items show type icons**: Goals (🎯 green), Tasks (☑ blue), Stories (📋 purple) — each with distinct visual treatment',
          '**Goals are clickable**: Click a goal in Focus to navigate to Goals page and adjust progress — shows inline progress bar + percentage',
          '**Tasks have checkboxes**: Simple tasks show a checkbox to toggle complete directly',
          '**Stories are collapsible**: Click story header to expand/collapse subtask checklist — collapsed view shows progress bar only',
          '**FocusStory component**: Extracted into dedicated component with expand/collapse toggle, inline subtask add, and progress bar',
        ],
      },
    ],
  },
  {
    version: '0.34.0',
    date: '2026-03-15',
    phase: 'Task → Story Merge (Select + Drag & Drop)',
    sections: [
      {
        title: 'Added',
        items: [
          '**Multi-select tasks**: Checkbox on each task card in list view — select multiple tasks for batch actions',
          '**Floating action bar**: Appears when tasks are selected — "Create Story" (merges into new story) or "Add to Story" (dropdown of existing stories)',
          '**Drag & drop merge**: Drag a task card onto a story card in list view to add it as a subtask — story card highlights on hover',
          '**Auto-archive on merge**: Original tasks are archived when merged into a story as subtasks',
          '**StoryDialog defaultSubtasks**: Pre-fills steps from selected tasks when creating story from merge',
        ],
      },
    ],
  },
  {
    version: '0.33.0',
    date: '2026-03-15',
    phase: 'Stories — Create in Tasks, Focus in Focus',
    sections: [
      {
        title: 'Added',
        items: [
          '**Story creation in Tasks**: New "Story" option in Tasks page dropdown — create tasks with ordered subtasks, priority, due date, and workspace (like Jira/ClickUp stories)',
          '**Story dialog**: Full dialog with title, priority, due date, workspace picker, and dynamic step list with add/remove/reorder',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus page is pick-only**: Removed story creation from Focus — create stories in Tasks, pick them in Focus. Clean separation of planning vs execution',
          '**PriorityPicker simplified**: Shows existing tasks/stories with subtask indicator (📋 icon), no creation form',
          '**Tasks "New" button**: Dropdown with Task and Story options',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`story-dialog.tsx` — Story creation dialog with subtask step editor, priority, workspace, and due date',
        ],
      },
    ],
  },
  {
    version: '0.32.0',
    date: '2026-03-15',
    phase: 'Story-Based Focus',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Story-based Today Focus**: Pick 1-3 stories (tasks with subtasks) instead of flat priority items — each story shows an interactive subtask checklist with progress bar',
          '**Inline subtask add**: Add steps to stories directly from the Focus page without opening the task editor',
          '**Auto-complete stories**: When all subtasks are checked, the story automatically marks as completed',
          '**Focus Score**: Now calculated from subtask completion across all stories (more granular than task-level completion)',
          '**Simple tasks still work**: Tasks without subtasks render as compact checkable lines (backwards compatible)',
          '**Workspace badges on stories**: Small 🏢/🏠 emoji shows which workspace each story belongs to',
          '**Unified task section**: Merged Work/Personal into one "Tasks" section with workspace badges — no more duplicate sections',
          '**Tasks list view**: Time-grouped layout (Today/Upcoming/Backlog) replaces flat filtered list',
        ],
      },
    ],
  },
  {
    version: '0.31.0',
    date: '2026-03-15',
    phase: 'Focus ↔ Tasks Integration',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Focus page**: Tasks now grouped by workspace — Work and Personal sections with separate inline quick-add inputs',
          '**Focus quick-add**: Type a task name and hit Enter to create it instantly with today\'s due date and the correct workspace',
          '**Focus done section**: Completed tasks collapse into a dimmed "Done Today" section at the bottom',
          '**Tasks list view**: Flat list replaced with time-grouped sections — Today, Upcoming (Tomorrow / This Week / Later), Backlog (no due date)',
          '**Tasks list view**: Removed status/priority/sort filters — task grouping by time replaces manual filtering',
          '**Tasks done section**: Completed tasks in collapsible dimmed section at bottom of list view',
        ],
      },
    ],
  },
  {
    version: '0.30.0',
    date: '2026-03-15',
    phase: 'Task Redesign — Workspaces, Clean Done, Log & Standup',
    sections: [
      {
        title: 'Added',
        items: [
          '**Workspace Tabs**: Switch between All, Work, and Personal tasks — workspace stored in `metadata.workspace`, filters apply to all views',
          '**Clean Done Section**: Completed tasks collapse into a "Done Today" section with dimmed styling — keeps active tasks focused and clutter-free',
          '**Log View**: New 3rd view tab alongside List and Board — shows weekly completion count with trend, 14-day daily completion bar chart, and completed tasks grouped by date',
          '**Standup Report**: One-click standup generator with smart weekend logic (Monday shows Friday\'s work) — sections for Done, Today\'s Plan, and Blocked — copy to clipboard as formatted text',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**View switcher**: Renamed "Kanban" to "Board", added "Log" as third view option',
          '**Task creation**: Automatically assigns workspace based on current tab selection',
          '**List view**: Active tasks shown first, completed tasks in collapsible section below',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`standup-report.tsx` — Slide-out standup report sheet with smart last-workday detection and clipboard copy',
        ],
      },
    ],
  },
  {
    version: '0.29.0',
    date: '2026-03-15',
    phase: 'Habit Protocols & Dashboard',
    sections: [
      {
        title: 'Added',
        items: [
          '**Habit Protocols**: Group actions into checklists (e.g. Morning Protocol, Before Bed Protocol) — each step is a checkbox, streak increments only when all steps complete',
          '**Protocol Templates**: 6 preset templates (Morning, Before Bed, Deep Work, Workout, Nutrition, Weekly Review) shown when creating — pick one to pre-fill or start from scratch',
          '**Protocol Dialog**: Create/edit protocols with dynamic step list — add, remove, reorder, rename steps inline',
          '**Focus Page Protocols**: Active protocols render as compact inline checklists on the Focus page, above habit pills — check off steps directly from your daily view',
          '**Dashboard Page** (`/dashboard`): New analytics page with Life Score, weekly trends, protocol streaks, combined heatmap, and AI context summary',
          '**Life Score**: Composite 0-100 metric weighted across tasks (25%), habits (30%), goals (20%), sleep (15%), activity (10%) with circular progress indicator',
          '**Weekly Trends**: 6-card grid comparing this week vs last — Tasks Done, Habit Rate, Protocol Rate, Avg Sleep, Active Minutes, Goal Progress with trend arrows',
          '**Protocol Streaks**: Horizontal progress bars showing consecutive days per protocol (max 30)',
          '**Combined Heatmap**: 90-day aggregated activity grid across all habits and protocols with 4-level intensity scale',
          '**AI Context Summary**: Natural language preview of all metrics — designed as future input for AI-powered insights',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`protocol-dialog.tsx` — Protocol creation/edit dialog with step editor and template picker',
          '`protocol-card.tsx` — Interactive checklist card with progress bar and streak display',
          '`dashboard.tsx` — Analytics dashboard with Life Score, trends, streaks, heatmap, AI summary',
        ],
      },
    ],
  },
  {
    version: '0.28.0',
    date: '2026-03-15',
    phase: 'Health Metrics — BMI, BMR, TDEE & Bulk/Cut',
    sections: [
      {
        title: 'Added',
        items: [
          '**Health Profile**: Configure height, date of birth, gender, and activity level — stored locally for metric calculations',
          '**BMI Calculator**: Auto-calculated from latest weight + height, with category badge (underweight/normal/overweight/obese)',
          '**BMR Calculator**: Basal Metabolic Rate via Mifflin-St Jeor equation',
          '**TDEE Calculator**: Total Daily Energy Expenditure with 5 activity levels (sedentary to very active)',
          '**Bulk/Cut Targets**: TDEE card shows calorie targets for cut (-500), lean bulk (+250), maintain, and bulk (+500)',
          '**Goal Mode Suggestion**: Smart recommendation (Cut/Maintain/Lean Bulk/Bulk) based on body fat % or BMI — with reasoning text',
          '**Daily Protein Target**: Calculated per goal mode (2.0g/kg for cut, 1.8g/kg maintain, 1.6g/kg bulk)',
          '**Ideal Weight Range**: Based on BMI 18.5–24.9 reversed to kg',
          '**Weight Trend**: 7-day moving average with direction indicator (up/down/stable)',
          '**Weekly Active Minutes**: Progress bar toward WHO 150min/week target with calories burned',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`health-calc.ts` — Pure calculation functions for BMI, BMR, TDEE, bulk/cut targets, protein, weight trend, weekly activity',
          '`health-metrics-card.tsx` — Dashboard component with 4-card grid, suggestion card, activity bar, and profile settings dialog',
        ],
      },
    ],
  },
  {
    version: '0.27.0',
    date: '2026-03-15',
    phase: 'Streamline — Focused Module Structure',
    sections: [
      {
        title: 'Changed',
        items: [
          '**18 → 12 modules**: Removed 6 low-usage modules and merged 2 overlapping ones for a cleaner, more focused app',
          '**New sidebar groups**: Core (Focus, Tasks, Notes, Calendar) → Track (Goals, Habits, Health, Wealth) → Life (Learning, Travel, Family, Review)',
          '**Learning page**: Merged Skills + Reading into a single tabbed page (Books, Courses, Skills) with unified CRUD',
          '**Travel page**: Renamed from Places — now includes places, live location, and trip entity types',
          '**No more collapsed "More" group**: All modules visible and meaningful — nothing hidden by default',
        ],
      },
      {
        title: 'Removed',
        items: [
          '**Posts** — removed from sidebar and routes',
          '**Memories** — removed from sidebar and routes',
          '**Home** (devices/services) — removed from sidebar and routes',
          '**Automate** — removed from sidebar and routes',
          '**Notifications page** — removed (toast system still active)',
          '**Skills** (separate page) — merged into Learning',
          '**Reading** (separate page) — merged into Learning',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`learning.tsx` — Unified learning page with Books/Courses/Skills tabs, reading challenge, practice log, skill levels',
        ],
      },
    ],
  },
  {
    version: '0.26.0',
    date: '2026-03-15',
    phase: 'Unified Places & Location',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Merged Places + Live Location**: Combined two separate pages into a single unified Places page — no more duplicate map modules',
          '**Unified map view**: Place markers (colored dots) and live location markers (pulsing JB/S circles) rendered on the same map simultaneously',
          '**Visibility toggles**: Eye/EyeOff controls in a legend panel to show/hide Places vs Live Locations independently',
          '**Share My Location**: Button moved inline onto the Places map (bottom-center overlay)',
          '**Sidebar navigation**: Removed separate "Location" entry — Places now handles both entity types',
        ],
      },
      {
        title: 'Removed',
        items: [
          '`/location` route removed from app router',
          'Location module entry removed from sidebar navigation',
        ],
      },
    ],
  },
  {
    version: '0.25.0',
    date: '2026-03-15',
    phase: 'Google Calendar Integration & Calendar Redesign',
    sections: [
      {
        title: 'Added',
        items: [
          '**Google Calendar OAuth**: Connect your Google account to create, edit, and delete events directly from Lyra',
          '**Google Calendar CRUD**: Full create/update/delete via OAuth 2.0 with automatic token refresh',
          '**Per-event colors**: Events fetched from Google Calendar API v3 with actual per-event colors (no API key needed — uses Google\'s public embed key)',
          '**Calendar color auto-detect**: Calendar background color fetched in parallel, used as fallback for events without individual colorId',
          '**Google Calendar event sheet**: Slide-up bottom sheet for creating events with inline title, datetime pickers, location, and description',
          '**Event detail edit/delete**: Edit and delete Google Calendar events from the event detail bottom sheet',
          '**Smart "New" button**: Dropdown menu when Google connected — choose between Google Calendar or local event creation',
          '**Toast notifications**: Sonner toasts on event create/update/delete instead of page reload',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Calendar redesign**: Google Calendar-inspired month view with mini-calendar grid, event dots, collapsible expand, and event list below',
          '**Week view redesign**: Hourly time grid with positioned event blocks, red current-time indicator, all-day events row',
          '**Schedule view redesign**: 30-day continuous timeline with sticky date headers and colored event cards',
          '**Calendar toolbar**: Single-row compact header — nav arrows, title, Today pill, view switcher, + New button, settings all inline',
          '**No more FAB overlap**: Replaced floating action button with inline header button — no positioning conflicts',
          '**No page reload on CRUD**: Events refresh via `queryClient.invalidateQueries` for seamless UX',
          '**Base64 calendar ID decoding**: `extractCalendarId()` properly decodes base64 `src` params from Google Calendar embed/share URLs',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`use-gcal-auth.ts` — Google Calendar OAuth hook with connect/disconnect/CRUD methods',
          '`month-view.tsx` — Compact mini-month grid with event dots and today highlight',
          '`event-list.tsx` — Scrollable event list for selected date with colored cards',
          '`event-detail-sheet.tsx` — Bottom sheet with event details, edit/delete for Google events',
          '`gcal-event-dialog.tsx` — Slide-up creation sheet with borderless inputs',
        ],
      },
    ],
  },
  {
    version: '0.24.0',
    date: '2026-03-15',
    phase: 'Security Hardening & Performance',
    sections: [
      {
        title: 'Security',
        items: [
          '**CORS lockdown**: Restricted from wildcard `*` to env-configured allowed origins',
          '**JWT secret required**: App refuses to start without `JWT_SECRET` env var (no more hardcoded fallback)',
          '**PIN hashing**: User PINs now hashed with `bcrypt` — no more plaintext storage',
          '**Ownership validation**: All entity and tracker API routes enforce authenticated user scoping',
          '**Input validation**: Zod schemas on entity create/update endpoints (title length, type enums, etc.)',
          '**Rate limiting**: Login endpoint limited to 5 attempts per 15-minute window per IP',
          '**Security headers**: Added `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, and `Content-Security-Policy` to nginx',
        ],
      },
      {
        title: 'Performance',
        items: [
          '**Kanban memoization**: Task filtering and drag lookups use pre-computed `Map` structures instead of per-render `Array.filter`/`Array.find`',
          '**Optimistic updates**: `useRepository` mutations now update UI instantly with automatic rollback on error',
          '**React.memo on TaskCard**: Prevents unnecessary re-renders of task cards in Kanban columns',
          '**Goal metadata caching**: Sub-goal lookups and progress calculations pre-computed via `useMemo` instead of per-card `Array.filter`',
        ],
      },
      {
        title: 'Fixed',
        items: [
          'Patched 4 high-severity npm vulnerabilities (`hono`, `@hono/node-server`, `flatted`, `express-rate-limit`)',
        ],
      },
    ],
  },
  {
    version: '0.23.0',
    date: '2026-03-14',
    phase: 'Minimalist Mind — Cognitive Dashboard',
    sections: [
      {
        title: 'Added',
        items: [
          '**Cognitive Dashboard**: Full-viewport Focus page based on Minimalist Mind philosophy — actionable left column, cognitive context right column',
          '**Capture Bar**: Ultra-fast inline capture on Focus page — press `/` to focus, `!` prefix for tasks, Enter to save (<5 seconds)',
          '**Daily Protocol**: Guided morning and evening review routines with step-by-step flow',
          '**Strategic Direction**: Top-level goals always visible on the dashboard',
          '**Active Projects**: Goals with milestones shown with progress bars',
          '**Knowledge Growth**: Recent notes/learnings displayed with age indicators',
          '**Clarity Metrics**: Focus Score (priority completion %), Noise (inbox count), Knowledge Growth (notes/week)',
          '**Focus Score pill**: Header badge showing real-time priority completion percentage',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus layout**: 7/5 column split — actionable items left, cognitive context right',
          '**3-priority rule**: Today Focus enforces max 3 priorities with numbered display',
          '**Habits**: Inline pill buttons with green completion state and streak counters',
          '**Inbox**: Hover-reveal action buttons (convert to task / archive)',
          '**Journal**: Collapsed by default, expandable on demand',
        ],
      },
    ],
  },
  {
    version: '0.22.0',
    date: '2026-03-14',
    phase: 'Focus Page Redesign & Infrastructure',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Focus Page**: Full-viewport 3-column layout — actionable items on the left (priorities, due tasks, habits, inbox), glanceable info cards on the right (schedule, goals, overview stats, quick nav)',
          '**Focus Page**: Renamed from "Today" to "Focus" with LayoutDashboard icon',
          '**Focus Page**: Removed Pomodoro timer, On This Day widget, and Health/Wealth detail cards from main flow — accessible via sidebar navigation',
          '**Focus Page**: Flat checklist-style task toggles, hover-reveal inbox actions, collapsible journal',
        ],
      },
      {
        title: 'Added',
        items: [
          '**Makefile**: `make dev` runs UI + API in parallel, targets for build, lint, typecheck, Docker, db migrations',
          '**API URL resolver**: Auto-resolves API hostname at runtime for cross-device access (no more hardcoded IPs)',
        ],
      },
    ],
  },
  {
    version: '0.21.0',
    date: '2026-03-14',
    phase: 'Google Calendar-Inspired Redesign',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Month View**: Colored event pills (rounded rectangles) instead of dots, today blue circle, previous-month leading days, slide-up detail panel with color bars',
          '**Week View**: Large date circles with Google-style header, colored event blocks, Monday-start week',
          '**Schedule View**: Clean vertical timeline with date circles, color bar indicators, time ranges',
          '**Header**: Rounded "Today" pill, chevron nav, pill-shaped view switcher, chip-style type filters with strike-through toggle',
          '**Event Detail**: Color sidebar bar per type, smooth slide-up animation, inline add button',
        ],
      },
      {
        title: 'Fixed',
        items: [
          'Month grid rows now fill available height correctly using dynamic grid-template-rows',
        ],
      },
    ],
  },
  {
    version: '0.20.0',
    date: '2026-03-14',
    phase: 'Maps & Mobile UX',
    sections: [
      {
        title: 'Added',
        items: [
          '**Live Location**: Real-time location sharing with custom JB/Sunny markers, geolocation API, auto-fit bounds',
          '**mapcn Maps**: Migrated from Leaflet to MapLibre GL via mapcn — zero-config dark/light theme tiles, modern vector rendering',
          '**HTTPS Dev Server**: Self-signed SSL for mobile geolocation testing',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Mobile Sidebar**: Auto-closes after tapping a nav item',
          '**Calendar Responsive**: Compact month grid with dot indicators, single-letter day headers, icon-only buttons on mobile',
          '**Week View Mobile**: Vertical card stack instead of 7-column grid on small screens',
          '**Type Filters**: Single-letter labels on mobile, scrollable overflow',
        ],
      },
      {
        title: 'Removed',
        items: [
          'Leaflet and react-leaflet dependencies (replaced by mapcn/MapLibre GL)',
        ],
      },
    ],
  },
  {
    version: '0.18.0',
    date: '2026-03-14',
    phase: 'Second Brain UX Redesign',
    sections: [
      {
        title: 'Changed',
        items: [
          '**Sidebar Favorites**: Pin your most-used pages to the top, star icon on hover',
          '**Sidebar Groups**: Consolidated from 8 to 4 groups (Focus, Life, Track, More)',
          '**Dashboard Focus Lane**: Single-column layout with greeting, today\'s tasks, quick stats, recent activity',
          '**Search Bar**: Always-visible search in top bar (triggers Cmd+K)',
          '**Smart Quick Capture**: Type picker (Task/Note/Idea/Goal/Habit), smart detection, optional due date and tags',
        ],
      },
    ],
  },
  {
    version: '0.17.0',
    date: '2026-03-14',
    phase: 'Phase 3.5 — Backend API & Docker',
    sections: [
      {
        title: 'Added',
        items: [
          '**API Server**: Hono + SQLite/Drizzle with REST endpoints for entities, trackers, schedules, relations',
          '**JWT Auth**: PIN-based login returns JWT token for API authentication',
          '**ApiRepository**: Frontend repository classes that call REST API instead of localStorage',
          '**Environment Toggle**: VITE_USE_API flag to switch between local and API mode',
          '**Docker Compose**: UI (nginx) + API containers with SQLite volume persistence',
          '**Seed Script**: Server-side database seeding with all 87 entities',
        ],
      },
    ],
  },
  {
    version: '0.16.0',
    date: '2026-03-14',
    phase: 'Bug Fixes & New Features',
    sections: [
      {
        title: 'Fixed',
        items: [
          '12 TypeScript build errors: Recharts formatter types, unused imports, type narrowing',
        ],
      },
      {
        title: 'Added',
        items: [
          '**Task Quick Snooze**: Reschedule tasks by 1 day or 1 week from card menu',
          '**Water Intake Tracker**: Daily counter widget on Health page with 8-glass goal',
        ],
      },
    ],
  },
  {
    version: '0.15.0',
    date: '2026-03-04',
    phase: 'Phase 14 — Larger Features',
    sections: [
      {
        title: 'Added',
        items: [
          '**Full-Text Search**: Scored search across titles, descriptions, tags, and metadata via Cmd+K',
          '**Inline Editing**: Click-to-edit component for quick field updates',
          '**Comment System**: Threaded comments on goals and skills (reuses Entity with parentId)',
          '**Saved Filters**: Persistent filter presets on Tasks, Goals, and Reading pages',
          '**Skill Practice Log**: Log practice sessions with duration and notes, track totals',
          '**Reading Progress**: Page tracking with progress bar on book cards',
          '**Reading Challenge**: Annual reading goal with completion tracking',
          '**Automation History**: Timestamped execution log with filter and clear',
          '**Conditional Logic**: AND-based conditions on automations (status, type, tag, tracker count)',
          '**Event-Driven Triggers**: Automations fire on task status change or habit check-in',
          '**Dry-Run Mode**: Preview automation effects without executing (Eye button)',
        ],
      },
    ],
  },
  {
    version: '0.14.0',
    date: '2026-03-04',
    phase: 'Phase 12+13 Cleanup — All Remaining Items',
    sections: [
      {
        title: 'Added',
        items: [
          '**Undo Delete**: Toast with "Undo" button on delete across all entity pages',
          '**Duplicate Item**: Clone any entity with one click via copy button on cards',
          '**Markdown Rendering**: Notes render bold, italic, code, links, and lists',
          '**Subtask Support**: Nested checklists within tasks with progress indicator',
          '**Goal Progress Slider**: Quick-adjust progress without opening dialog',
          '**Dashboard Motivational Message**: Trophy card when all tasks are complete',
          '**Daily Affirmation**: Rotating motivational quotes on Today page',
          '**Monthly Habit Completion Rate**: Percentage badge on habit cards',
          '**Workout Heatmap**: 90-day activity grid in Health workouts tab',
          '**Calendar Week View**: 7-day column grid with entity lists per day',
          '**Calendar Entity Type Filter**: Toggle task/goal/event/habit visibility',
          '**Net Worth Trend Chart**: Monthly line chart from localStorage snapshots',
          '**Recurring Transactions**: Auto-generate scheduled expenses/income',
          '**EXIF Date Extraction**: Auto-fill memory date from photo metadata',
          '**On This Day Widget**: Dashboard widget showing memories from same date in past years',
          '**Photo Albums**: Group memories into named collections with filter',
          '**Chore Rotation**: Auto-swap assignee on completion',
          '**Chore Completion History**: Track who completed chores and when',
          '**Household Goals Tab**: Shared family goals with progress bars',
          '**Post Emoji Reactions**: 5 preset emoji reactions on posts',
          '**Post Reply/Thread**: Comment threads with collapsible replies',
          '**Post Media Attachments**: Image upload with compression on posts',
          '**Map Picker**: Click-to-pin Leaflet dialog for setting place coordinates',
          '**Open in Maps**: Google Maps deep link on place cards',
          '**Trip Itinerary Timeline**: Day-by-day place list grouped by date',
          '**Trip Budget**: Planned vs actual spending with progress bar',
          '**Today Time-of-Day Sections**: Morning/Afternoon/Evening event grouping',
          '**Review Accomplishment Highlights**: Top 3 items as featured cards',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`use-undo-delete.ts` — Shared undo-delete hook',
          '`duplicate-entity.ts` — Entity duplication utility',
          '`markdown.tsx` — Regex-based markdown renderer',
          '`subtask-list.tsx` — Checklist component for subtasks',
          '`daily-affirmation.tsx` — Motivational quote card',
          '`workout-heatmap.tsx` — 90-day workout heatmap',
          '`week-view.tsx` — 7-day calendar week view',
          '`net-worth-chart.tsx` — Net worth trend LineChart',
          '`on-this-day-widget.tsx` — On This Day dashboard widget',
          '`map-picker-dialog.tsx` — Click-to-pin map dialog',
          '`trip-itinerary.tsx` — Trip day-by-day timeline',
        ],
      },
    ],
  },
  {
    version: '0.13.0',
    date: '2026-03-04',
    phase: 'Phase 13: Medium Features — Charts, Agenda, Pomodoro, Review',
    sections: [
      {
        title: 'Added',
        items: [
          '**Calendar Agenda View**: 14-day vertical timeline alongside month view with type-colored dots and Month/Agenda tabs',
          '**Wealth: Income vs Expense Chart**: Grouped bar chart comparing monthly totals over 6 months (Recharts)',
          '**Wealth: Budget Alerts**: Warning badge on budget cards when spending reaches 80%+',
          '**Health: Weight Trend Chart**: Line chart tracking weight entries over time with kg formatting',
          '**Health: Sleep Trend Chart**: 30-day sleep hours line chart with 8-hour reference line',
          '**Today: Pomodoro Timer**: 25/5 min focus/break cycle with Web Audio beep notification',
          '**Review: Week-over-Week**: Accomplishments step shows "+N vs last week" comparison badge',
          '**Review: Priority Suggestions**: Reflection step auto-suggests items due within 7 days',
        ],
      },
      {
        title: 'Changed',
        items: [
          '`calendar.tsx` — Month/Agenda tab switcher',
          '`wealth.tsx` — CashflowChart added to Transactions tab',
          '`health.tsx` — WeightChart and SleepChart sections above data tables',
          '`today.tsx` — PomodoroTimer widget between progress bar and priorities',
          '`review` steps — Week-over-week delta badge and next-week suggestions',
        ],
      },
      {
        title: 'New Files',
        items: [
          '`agenda-view.tsx` — Calendar agenda timeline',
          '`cashflow-chart.tsx` — Income vs Expense bar chart',
          '`weight-chart.tsx` — Weight trend line chart',
          '`sleep-chart.tsx` — Sleep trend line chart',
          '`pomodoro-timer.tsx` — Focus timer widget',
        ],
      },
    ],
  },
  {
    version: '0.12.0',
    date: '2026-03-03',
    phase: 'Phase 12: Quick Wins & Polish',
    sections: [
      {
        title: 'Added',
        items: [
          '**Dashboard v2**: Health summary, wealth snapshot, habit completion rate, review due card',
          '**Sidebar**: Collapsible groups with remembered preference, due/overdue count badges',
          '**Data export/import**: JSON backup download and restore',
          '**Goals**: Color-coded progress cards (red/yellow/green), auto-progress from sub-goals',
          '**Tasks**: Priority color on Kanban cards (red/orange/yellow/gray)',
          '**Habits**: 90-day heatmap grid, streak milestone badges (7d, 30d, 90d)',
          '**Notes**: Pin/favorite toggle, tag filter dropdown',
        ],
      },
    ],
  },
  {
    version: '0.11.0',
    date: '2026-03-02',
    phase: 'Phase 11: Productivity',
    sections: [
      {
        title: 'Added',
        items: [
          '**Today page**: Daily focus dashboard — priorities, due tasks, habits, events, inbox, journal',
          '**Inbox capture**: Floating button + `Cmd+Shift+I` for zero-friction note capture',
          '**Weekly Review wizard**: 5-step guided flow with reflection journal',
        ],
      },
    ],
  },
  {
    version: '0.10.5',
    date: '2026-03-01',
    phase: 'Phase 10.5: Memories',
    sections: [
      {
        title: 'Added',
        items: [
          '**Memories module**: Gallery + Timeline views with image compression',
          'Lightbox overlay, mood tracking, storage budget indicator',
          'New `memory` entity type with base64 images',
        ],
      },
    ],
  },
  {
    version: '0.10.0',
    date: '2026-02-28',
    phase: 'Phase 10: Polish',
    sections: [
      {
        title: 'Added',
        items: [
          '**PWA**: Service worker, offline caching, app icons',
          '**Code splitting**: React.lazy for 17 routes, manual vendor chunks',
          '**Mobile**: Responsive layout padding, spinner fallback',
        ],
      },
    ],
  },
  {
    version: '0.9.0',
    date: '2026-02-27',
    phase: 'Phase 9: Automate',
    sections: [
      {
        title: 'Added',
        items: [
          '**Automation engine**: Schedule/manual triggers, create/notify/update actions',
          '5 preset templates with one-click activation',
          'Engine evaluates due automations on page load',
        ],
      },
    ],
  },
  {
    version: '0.8.0',
    date: '2026-02-26',
    phase: 'Phase 8: Family',
    sections: [
      {
        title: 'Added',
        items: [
          '**Chore management**: Cards with category, frequency, assignee, due date',
          '**Activity feed**: Chronological feed of shared entities',
          'Category and assignee filter dropdowns',
        ],
      },
    ],
  },
  {
    version: '0.7.0',
    date: '2026-02-25',
    phase: 'Phase 7: Home',
    sections: [
      {
        title: 'Added',
        items: [
          '**Device inventory**: Server, desktop, laptop, phone, tablet, router, IoT cards',
          '**Service monitoring**: Status tracking with running/stopped/error states',
        ],
      },
    ],
  },
  {
    version: '0.6.0',
    date: '2026-02-24',
    phase: 'Phase 6: Health',
    sections: [
      {
        title: 'Added',
        items: [
          '**Body metrics**: Weight, body fat, BMI tracking table',
          '**Workouts**: Strength, cardio, flexibility, HIIT, sports cards',
          '**Sleep & Mood**: Daily sleep hours, quality, mood, and energy tracking',
        ],
      },
    ],
  },
  {
    version: '0.5.0',
    date: '2026-02-23',
    phase: 'Phase 5: Wealth',
    sections: [
      {
        title: 'Added',
        items: [
          '**Transactions**: Income/expense tracking with category filters',
          '**Budgets**: Category-based budgets with spending progress bars',
          '**Portfolio**: Asset tracking (crypto, stocks, funds, gold, property)',
          '**Wallets & Crypto Txs**: Wallet management, buy/sell/swap/transfer ledger',
        ],
      },
    ],
  },
  {
    version: '0.4.5',
    date: '2026-02-22',
    phase: 'Phase 4.5: Capture & Explore',
    sections: [
      {
        title: 'Added',
        items: [
          '**Notes**: Free-form notes + daily journal with mood',
          '**Posts**: Household activity feed with inline compose',
          '**Places & Travel**: Leaflet map integration, trip planner',
          '**Notifications**: Sonner toasts, bell dropdown, history page',
        ],
      },
    ],
  },
  {
    version: '0.4.0',
    date: '2026-02-21',
    phase: 'Phase 4: Grow',
    sections: [
      {
        title: 'Added',
        items: [
          '**Habits**: Daily check-in, streaks, frequency badges',
          '**Skills**: Proficiency levels and related resources',
          '**Reading**: Books and courses with status and rating',
        ],
      },
    ],
  },
  {
    version: '0.3.0',
    date: '2026-02-20',
    phase: 'Phase 3: AI Layer',
    sections: [
      {
        title: 'Added',
        items: [
          '**AI providers**: Swappable system (OpenAI, Claude, Ollama, custom)',
          '**Chat sidebar**: Streaming conversation with context awareness',
          '**Command bar**: `Cmd+K` with entity search + inline AI queries',
          '**Daily brief**: Dashboard widget with AI-generated summary',
        ],
      },
    ],
  },
  {
    version: '0.2.0',
    date: '2026-02-19',
    phase: 'Phase 2: Plan',
    sections: [
      {
        title: 'Added',
        items: [
          '**Dashboard**: 4 widgets — tasks, goals, habits, quick add',
          '**Tasks**: List view + Kanban board with drag-and-drop',
          '**Goals**: Sub-goal hierarchy with progress tracking',
          '**Calendar**: Month grid + iCal Google Calendar sync',
        ],
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-02-18',
    phase: 'Phase 1: Foundation',
    sections: [
      {
        title: 'Added',
        items: [
          '**Scaffold**: React 19 + Vite + TypeScript + Tailwind + shadcn/ui',
          '**Core engine**: Entity/Tracker/Schedule/Relation type system',
          '**Data layer**: Repository pattern with localStorage, TanStack Query hooks',
          '**Auth**: PIN-based multi-user authentication (JB + Sunny)',
        ],
      },
    ],
  },
]
