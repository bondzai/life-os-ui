export { version as APP_VERSION } from '../../package.json'

export interface ChangelogSection {
  title: string
  items: string[]
}

export interface ChangelogRelease {
  version: string
  date: string
  phase: string
  sections: ChangelogSection[]
}

export const CHANGELOG: ChangelogRelease[] = [
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
