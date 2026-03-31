export { version as APP_VERSION } from '../../package.json'

interface ChangelogSection {
  title: string
  items: string[]
}

interface ChangelogRelease {
  version: string
  date: string
  phase: string
  codename?: string
  tag?: string
  sections: ChangelogSection[]
}

export const CHANGELOG: ChangelogRelease[] = [
  {
    version: '2.3.0',
    date: '2026-03-31',
    phase: 'Lyra Protocol',
    sections: [
      {
        title: 'Added',
        items: [
          '**Lyra Protocol**: Weekly planning system — set 3 weekly outcomes ("Three Stars"), allocate tasks to day buckets with drag-and-drop, intel briefing shows carried tasks/deadlines/velocity gaps/calendar load',
          '**Daily Protocol**: Auto-populates today\'s priorities from weekly plan with morning brief signals, one-click confirm to Emperor Time',
          '**Weekly outcome tracking**: Done/missed status toggles in Weekly Review step 1, closes the plan-execute-review loop',
          '**Distraction tally**: Zap button during deep work sessions, count saved per pomodoro in tracker log',
          '**Auto-pause on tab switch**: Deep work pauses timer when you leave the tab, shows resume banner on return',
          '**Session micro-goal**: Optional goal input before starting focus, displayed below timer as reminder',
          '**Focus streak badge**: Flame icon + consecutive days (25+ min/day) on Today page next to Deep Focus button',
          '**Focus mode timer**: Live countdown in app-level focus mode floating bar',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Entity simplification**: Merged Project into Goal (`isGoal` helper), Chore into Task (`isTask` helper) — 3 mental models: outcome, action, system',
          '**Projects sidebar removed**: `/projects` redirects to Goals page, goals page shows both goals and old projects',
          '**Habits unified as protocols**: Every habit requires steps — no more bare checkbox toggles. Streak increments only when ALL steps complete',
          '**Today page anti-dopamine**: Removed task-count progress bar and focus score percentage, shows focus streak + systems instead',
          '**Capture simplified**: Placeholder shows `!action @outcome #system / more`',
          '**Review page**: 4 tabs — Plan, Standup, Debrief, Weekly. Plan tab is default',
          '**HabitStrip rewritten**: Self-contained component with step checklists, labeled "Systems"',
          '**Default AI model**: Switched from Qwen3 to llama3.2:1b across all defaults',
        ],
      },
      {
        title: 'Removed',
        items: [
          '**Foresight tab**: Threats merged into Strategy tab, connections and scenarios dropped',
          '**Report page**: Merged into Review (standup tab with markdown copy)',
          '**LyraAI widget**: Removed from Today page (duplicate of morning brief + /lyra chat)',
          '**Dashboard Lyra/Rules mode**: Non-functional toggle removed',
          '**AI tools removed**: suggest-focus, find-connections, extract-memories (duplicates)',
          '**Dead components**: daily-affirmation, daily-protocol, daily-brief-widget, protocol-card',
          '**~2,500 lines removed** across the full cleanup',
        ],
      },
    ],
  },
  {
    version: '2.2.0',
    date: '2026-03-22',
    phase: 'Lyra Foresight',
    sections: [
      {
        title: 'Added',
        items: [
          '**Threat Radar**: Predictive intelligence — budget overspend projection, streak break probability, deadline miss forecast, sleep crash prediction',
          '**Connection Engine**: AI finds non-obvious links across knowledge, skills, and problems — "Your rate limiting notes solve the API task"',
          '**Scenario Simulator**: 3 timelines per project/goal — optimistic, realistic, pessimistic with projected dates and risk levels',
          '**Foresight tab**: Dashboard tab combining Threats + Connections + Scenarios in one predictive view',
          '**find-connections AI tool**: 12 tools total',
          '**detect-threats detector**: 9 detectors total',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Dashboard**: 4 tabs — Overview, Strategy, Foresight, Focus Log',
          '**Morning Brief**: Now includes predictive threat insights alongside reactive signals',
        ],
      },
    ],
  },
  {
    version: '2.1.0',
    date: '2026-03-22',
    phase: 'Lyra Memory',
    sections: [
      {
        title: 'Added',
        items: [
          '**Persistent Memory**: Lyra remembers key facts, preferences, patterns, decisions, and context across all conversations',
          '**Auto-extraction**: After each chat, Lyra silently extracts 0-3 memories worth keeping (background, non-blocking)',
          '**Memory injection**: Every conversation starts with relevant memories from past interactions — "Last time you mentioned X"',
          '**Memory UI**: View, search, filter, and delete memories on the Lyra page (Chat / Event Log / Memory tabs)',
          '**5 memory categories**: fact, preference, pattern, decision, context — each with colored badges',
          '**Duplicate prevention**: Memories with identical titles are not re-created',
          '**extract-memories AI tool**: 11 tools total',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Lyra page**: 3 tabs — Chat, Event Log, Memory',
          '**Soul prompt**: Lyra references memories naturally when relevant, never forces them',
          '**Chat context**: Memories always injected (lightweight), entity data only when asked',
        ],
      },
    ],
  },
  {
    version: '2.0.0',
    date: '2026-03-22',
    phase: 'Strategic Intelligence',
    codename: 'Aegis',
    tag: 'aegis',
    sections: [
      {
        title: 'Added',
        items: [
          '**Strategic Board** (`/strategic-board`): Full strategic command page — Next Moves, Knowledge Pulse, Scoreboard with project/goal velocity',
          '**Knowledge Profile hook**: Aggregates ALL notes, decisions, ideas, journal, skills, projects into a structured intelligence profile — top themes, unactioned ideas, open questions, recurring concerns, knowledge gaps, thinking velocity',
          '**Strategic Moves AI tool**: Lyra reads everything (knowledge + data) and generates 3 high-impact moves: commit, pivot, park, double-down, explore, connect, decide',
          '**Move lifecycle**: Accept/pass/complete moves with localStorage persistence and 30-move history',
          '**Knowledge Context builder**: Formats knowledge profile into AI-consumable context for any tool',
          '**Scoreboard hook**: Quantitative metrics — task velocity, focus hours, habit rate, sleep, goal progress with risk, project velocity, budget health, streaks',
          '**Web Search**: `/search` command in Lyra chat — DuckDuckGo proxy via API backend, results injected into Ollama context with source citations',
          '**web-search AI tool**: 10 tools total',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Lyra reads everything**: Notes, decisions, ideas, journal, projects, goals, skills, health, wealth — full knowledge awareness',
          '**Sidebar**: Strategic Board added to Daily group with Map icon',
          '**AI context**: Knowledge profile injected alongside global context for richer analysis',
        ],
      },
      {
        title: 'Architecture',
        items: [
          '**Agent-ready data layer**: KnowledgeProfile, Scoreboard, StrategicMove interfaces designed for future multi-agent consumption',
          '**Modular context builders**: knowledge-context.ts composable with other contexts for any AI agent',
          '**Move types taxonomy**: commit/pivot/park/double-down/explore/connect/decide — strategic vocabulary for AI recommendations',
        ],
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-03-22',
    phase: 'Smart Capture',
    sections: [
      {
        title: 'Added',
        items: [
          '**AI Smart Capture**: Type natural language in Quick Capture — Lyra parses entity type, title, priority, due date, project, and subtasks automatically',
          '**Auto-link**: Lyra matches project and goal names mentioned in capture text to existing entities',
          '**Subtask suggestion**: Complex tasks get 2-4 AI-suggested subtasks, created as stories',
          '**Duplicate detection**: Warns if a similar entity already exists before creating',
          '**parse-capture AI tool**: Structured JSON output from natural language (8 tools total)',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Quick Capture dialog**: AI preview card shows between input and type picker — type badge, priority, due date, linked project, subtask count',
          '**Prefix fast path preserved**: `!` `?` `*` `@` `#` and `/commands` bypass AI entirely for instant capture',
          '**Graceful fallback**: AI offline = existing prefix-based capture works unchanged',
        ],
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-03-22',
    phase: 'AI Co-Pilot',
    sections: [
      {
        title: 'Added',
        items: [
          '**Smart Priority Suggestion**: Lyra analyzes deadlines, leverage, energy, and momentum to suggest 3 daily priorities — one-click accept or pick manually',
          '**Session Planner**: Before starting deep work, Lyra plans optimal task order with estimated timing based on energy patterns and task complexity',
          '**Deep Work AI Assistant**: Ask Lyra about your current task during focus sessions — context-aware streaming responses with task, project, and goal awareness',
          '**Post-Session Reflection**: Rate sessions (Focused/Okay/Struggled), optional notes — Lyra learns your patterns and suggests optimal times after 5+ sessions',
          '**Session Patterns Hook**: Analyzes quality data by time of day, day of week, and recent trends — surfaces insights like "You focus best Tuesday mornings"',
          '**2 new AI tools**: suggest-priorities (daily focus), plan-session (deep work planning)',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus page**: Empty priority state now shows AI suggestions first, manual picker as fallback',
          '**Deep Work page**: Session planner shown when idle, AI ask input in coach panel, reflection overlay on session end',
          '**AI tool count**: 7 registered tools total (suggest-focus, suggest-priorities, plan-session, break-down, analyze-risk, coaching, weekly-summary)',
        ],
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-03-22',
    phase: 'Proactive Lyra',
    sections: [
      {
        title: 'Added',
        items: [
          '**Lyra Pulse**: Background heartbeat runs signal detectors every 10 minutes — fires toast notifications for critical insights on any page, not just Focus',
          '**Deep Work Coach**: Collapsible Lyra panel during focus sessions — streak alerts with hours remaining, session progress with subtask counts, "Next up" task suggestion',
          '**Session End Summary**: Toast notification when pomodoro work phase ends — session count, current tasks, streak reminders',
          '**Real-time Celebrations**: Instant toasts on achievements — task completion, goal completion, habit streak milestones (7/30/90/180/365 days)',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**AppLayout**: Now runs 3 global hooks — Lyra Pulse, Session Summary, Celebrations — Lyra is alive on every page',
          '**Deep Work page**: Coach panel appears during active sessions, collapsed by default, non-intrusive',
          '**Lyra behavior**: Shifted from 85% reactive to proactive — background monitoring, real-time feedback, contextual coaching during focus',
        ],
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-03-22',
    phase: 'Dynamic Dashboard',
    sections: [
      {
        title: 'Added',
        items: [
          '**Dynamic dashboard**: 12 signal-driven widgets auto-selected by relevance — streak tracker, overdue tasks, project velocity, budget meter, sleep trend, goal progress, focus hours, energy pattern, stale projects, upcoming events, decision review, weekly velocity',
          '**Widget registry**: MCP-style pattern — `registerWidget()` with relevance scoring, any widget self-registers at import',
          '**Rules / Lyra mode toggle**: Switch between algorithmic widget selection (rules-based) and AI-curated dashboard (Lyra mode)',
          '**Pin & hide widgets**: Pin widgets to always show, hide to never show, persisted to localStorage',
          '**Shuffle button**: Re-roll widget selection in rules mode, regenerate AI summary in Lyra mode',
          '**AI dashboard summary**: Lyra generates a one-line focus suggestion when in Lyra mode',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Dashboard page**: Dynamic grid added ABOVE existing radar chart and trend cards — all original content preserved',
          '**Lyra mode auto-fallback**: When AI is offline, Lyra mode button is disabled with tooltip, falls back to rules mode',
        ],
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-03-22',
    phase: 'Lyra Command Interface & MCP-Style AI System',
    sections: [
      {
        title: 'Added',
        items: [
          '**Lyra page** (`/lyra`): Full strategic command interface — AI greeting, chat, tool arsenal, settings in one war room',
          '**Strategic Dashboard**: Auto-generated focus suggestion, AI status, quick action chips for all tools',
          '**Full Chat**: Conversation management (create/switch/delete), streaming responses, prompt template chips, auto-scroll',
          '**Arsenal Panel**: All AI tools accessible with entity picker, run button, cached results, inline display',
          '**MCP-style AI tool system**: Registry pattern — `registerTool()`, `getTool()`, `getAllTools()`, scope-aware entity filtering',
          '**5 AI tools**: suggest-focus, break-down, analyze-risk, coaching, weekly-summary — each with modular context builders',
          '**`useAI()` hook**: Single interface for all AI interactions — `ask()` (streaming), `run()` (tool execution), `status`, `isOnline`',
          '**`<AIAction>` component**: DRY AI trigger + response UI — one component used across task detail, goal detail, project detail, habits, weekly review',
          '**Sol personality system**: INTJ mastermind personality with time-of-day awareness, configurable via settings',
          '**Custom system prompt**: Users can override Lyra personality in AI Settings → Personality tab',
          '**`sol.md`**: Lyra soul document — voice principles, tone map, time-of-day behavior, fallback rules',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Lyra is someone, not a feature**: Header says "Lyra" not "Lyra AI", speaks in first person, has opinions',
          '**AI Settings dialog**: Split into Connection + Personality tabs, custom system prompt textarea',
          '**LyraAI widget refactored**: Uses `useAI()` hook instead of direct AIClient — same interface as all other AI',
          '**All AI prompts use Sol**: Consistent personality across greeting, tools, chat, brief summary',
          '**Sidebar**: Lyra page added to Daily group with Sparkles icon',
          '**Context builders modularized**: task, goal, project, habit, global — reusable across tools',
        ],
      },
      {
        title: 'Architecture',
        items: [
          '**Tool → Context → Sol → Client pipeline**: Every AI interaction follows the same path. Adding a new tool = 1 file.',
          '**Provider-agnostic**: Ollama, OpenAI, Claude, custom — swap with one config change',
          '**Graceful degradation**: AI offline = tools hidden, algorithmic brief stays, no errors',
        ],
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-03-22',
    phase: 'Lyra AI',
    codename: 'Trident',
    tag: 'trident',
    sections: [
      {
        title: 'Added',
        items: [
          '**Lyra AI panel**: AI interface on Focus page — auto-generates greeting from your data, shows AI status (online/offline), quick ask input with streaming responses',
          '**Morning Brief**: Algorithmic signal detection engine with 8 detectors — streak risk, stale projects, budget warnings, sleep drops, energy patterns, decision reviews, achievements, velocity changes',
          '**10 signal detectors**: Modular pure-function architecture (src/hooks/brief-detectors/) — each detector returns typed Insight[] for both UI rendering and future AI context',
          '**AI health monitoring**: Real-time Ollama connectivity check with 30s polling, graceful online/offline transitions',
          '**AI Brief Summary**: Auto-generates natural language summary from algorithmic insights via local Ollama (Llama 3.2)',
          '**Quick Ask**: Type questions directly on Focus page, get streaming AI responses with full app context',
          '**4 new prompt templates**: What to Focus On, Project Health Check, Habit Coach, Life Balance Check',
          '**Ollama integration**: Local LLM (llama3.2:3b) as default provider — zero cloud dependency, data stays private',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus page right sidebar**: Redesigned — Lyra AI panel at top, algorithmic Brief below, Goal Cascade, then Schedule',
          '**Brief deduplication**: Removed overdue tasks and goal risk from Brief (already visible in Focus picker). Brief now shows only cross-domain signals (habits, projects, wealth, health, decisions)',
          '**Removed duplicate sections**: Energy check-in, Highest Leverage, System Health removed from sidebar — replaced by Brief detectors and AI summary',
          '**Default AI model**: Updated from llama3 to llama3.2:3b',
          '**AI health check**: No longer depends on isConfigured flag — always attempts Ollama connection with fallback defaults',
          '**Graceful degradation**: AI offline = algorithmic fallback with status hint. No broken states, no errors.',
        ],
      },
      {
        title: 'Architecture',
        items: [
          '**Signal → Formatter → Renderer pipeline**: Detectors produce Insight[], same data feeds both bullet UI and AI summary. Future AI just receives pre-computed signals.',
          '**AI-ready data contract**: Insight type with severity, category, data payload — designed for LLM context injection',
          '**Provider-agnostic**: Swap Ollama for OpenAI/Claude/Groq by changing one config. Same AIClient, same prompts.',
        ],
      },
    ],
  },
  {
    version: '0.66.0',
    date: '2026-03-21',
    phase: 'Strategic Arsenal',
    codename: 'Tomahawk',
    tag: 'tomahawk',
    sections: [
      {
        title: 'Added',
        items: [
          '**Weekly System Audit**: Strategic review step with project velocity tracking (this week vs last), risk detection (habits at risk, stale goals/projects, overdue tasks), life balance radar, and AI-suggested priorities',
          '**Automation Rules**: 5 rule templates with toggle switches — task completion updates project, habit streak break creates reminder, domain inactivity alerts, goal completion auto-archives, focus session logs time to project',
          '**Skill & Knowledge Vault**: Full skills page with mastery levels (novice/competent/proficient/expert), domain tags, rusty skill detection (30+ days), linked projects, grid/list view, search and mastery filter',
          '**Energy & Time Mapping**: AM/PM energy check-in widget on Focus page (1-5 scale), energy pattern tracking with peak time detection and 14-day history',
          '**Decision Journal**: Decisions tab in Notes with full create/view/edit flow — reasoning, alternatives, linked project/goal, 30/90 day revisit prompts with validate/reverse status',
          '**Scenario Planner**: Velocity panels on Goal and Project detail views — 4-week velocity bars, projected completion date, risk indicator (on-track/at-risk/will-miss)',
          '**Switch component**: New shadcn-style toggle switch for automation rules',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Weekly Review**: System Audit added as step 5 before Reflection',
          '**Focus page sidebar**: Energy check-in widget added before Today\'s Schedule',
          '**Notes page**: Third tab "Decisions" with separate filtering from regular notes',
          '**Automation page**: Templates split into Rule Templates (with toggles) and Schedule Templates',
          '**Sidebar**: Skills page added under Plan group with Zap icon',
        ],
      },
    ],
  },
  {
    version: '0.65.0',
    date: '2026-03-21',
    phase: 'Projects & Strategic Command Center',
    sections: [
      {
        title: 'Added',
        items: [
          '**Projects page**: New entity type for tracking online & offline projects — software, business, creative, learning, lifestyle',
          '**List/Grid toggle**: Switch between card grid and compact list view, persisted to localStorage',
          '**Project create dialog**: Dedicated form with category, domain, tech stack, summary (AI context), and external links',
          '**Inline metadata editor**: Edit category, domain, stack, summary, and links directly in project detail view',
          '**Project picker on tasks**: Assign tasks to projects from task detail panel and story dialog',
          '**Strategic Command Center**: Merged into Focus page right sidebar — goal cascade tree, system health indicators (green/yellow/red per life domain), highest leverage tasks',
          '**Search filter**: Filter projects by title, description, stack, category, or tags',
          '**Quick status change**: Change project status directly from list view without opening detail',
          '**AI project awareness**: Active projects with stack and summary injected into AI context for smarter suggestions',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus page right sidebar**: Now includes schedule, leverage tasks, system health, and collapsible goal cascade',
          '**Sidebar navigation**: Projects added under Plan group between Tasks and Goals',
        ],
      },
    ],
  },
  {
    version: '0.64.0',
    date: '2026-03-20',
    phase: 'Lyra Constellation Loader',
    sections: [
      {
        title: 'Added',
        items: [
          '**Lyra constellation loader**: Custom branded loading animation — stars connect one by one with progressive glow, matching the Lyra logo',
          '**Loader test page**: `/test-loader` page to preview loader at different sizes and simulated load delays',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Page loading**: Suspense fallback replaced with LyraPageLoader constellation animation',
          '**Export/Import buttons**: Loading spinner replaced with inline Lyra constellation loader',
        ],
      },
    ],
  },
  {
    version: '0.63.0',
    date: '2026-03-20',
    phase: 'GitHub-Style Focus Tabs & Deep Focus UX',
    sections: [
      {
        title: 'Added',
        items: [
          '**GitHub-style tab bar**: Focus page now has Overview + configurable favorite tabs — each tab renders the full page inline (Tasks, Calendar, Habits, Report, etc.)',
          '**Embedded report view**: Report tab renders the present/briefing view directly when Daily is selected — no extra click needed',
          '**Deep Focus timer in sidebar**: When a focus session is active, the Focus menu item blinks amber and shows remaining time',
          '**Browser tab countdown**: Document title shows focus countdown (e.g. "24:30 Focus — Lyra") when a session is active',
          '**Quick Capture in deep work**: Inbox button + `⌘⇧I` shortcut now available during Emperor Time sessions',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Emperor Time → Deep Focus**: Renamed the focus button, now styled as a proper button with amber outline',
          '**Deep Focus button blinks**: Shows "Continue MM:SS" with pulse animation when a session is active',
          '**Reset button**: Now styled as a ghost button instead of plain text',
          '**Sidebar groups reorganized**: Daily (Focus, Dashboard) / Plan (Tasks, Calendar, Notes, Goals, Habits) / Life (Health, Wealth, Learning, Travel, Family)',
          '**Pages support embedding**: Calendar, Inbox, Report, Review adapt layout when rendered inside Focus tabs (no redundant headers/constraints)',
        ],
      },
    ],
  },
  {
    version: '0.62.0',
    date: '2026-03-20',
    phase: 'Configurable Focus Dashboard',
    sections: [
      {
        title: 'Added',
        items: [
          '**Favorites system**: Focus page right column now shows configurable widgets — pick from Inbox, Tasks, Schedule, Habits, Goals, Notes, Report, Review',
          '**Favorites editor**: Click the gear icon on Focus to toggle which modules appear as widgets and action buttons',
          '**Habit widget**: Check off daily habits directly from Focus page with streak display',
          '**Goals widget**: View active goals with progress bars inline',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Focus action strip**: Now driven by favorites config — buttons navigate to full page, widgets show compact content inline',
          '**Capture button**: Navigates to full Inbox page instead of opening modal dialog',
          '**Sidebar streamlined**: Removed Inbox, Report, Review as standalone sidebar items — accessible from Focus page favorites',
          '**Capture dialog**: Now uses global store state, triggerable from anywhere via `⌘⇧I`',
        ],
      },
    ],
  },
  {
    version: '0.61.0',
    date: '2026-03-20',
    phase: 'Sidebar Redesign, Events Page & Quick Capture',
    sections: [
      {
        title: 'Added',
        items: [
          '**Events page**: Dedicated `/events` page for event CRUD — flat rows with done toggle, time/location badges, date grouping (Today/Tomorrow/This Week/Later/Past), pill filters with counts',
          '**Quick Capture shortcut**: `⌘⇧I` hotkey hint shown in sidebar, floating button tooltip, and capture dialog footer',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Sidebar groups**: Reorganized from 4 groups (Command/Operate/Track/Life) to 3 intuitive groups (Daily/Plan/Life)',
          '**Inbox → Quick Capture**: Renamed sidebar entry for clarity (module ID unchanged for compatibility)',
          '**Calendar children**: Events page added as child of Calendar module',
          '**Focus page**: Removed inbox section and quick journal — inbox lives in its own dedicated page now',
        ],
      },
    ],
  },
  {
    version: '0.60.0',
    date: '2026-03-20',
    phase: 'Goal Map, Note Map & Rich Demo Data',
    sections: [
      {
        title: 'Added',
        items: [
          '**Goal Map**: Interactive goal → task → subtask tree visualization using ReactFlow — click nodes, cycle status, add tasks, toggle subtasks, stale indicators, detail side panel',
          '**Note Map**: Knowledge graph for notes — notes as nodes, shared tags as hub nodes, relation edges (relates/supports/blocks/parent), tag filtering, detail panel with connected notes',
          '**Rich demo data**: 14 interconnected notes with overlapping tags, 14 note-to-note relations, tasks linked to goals with subtasks — both maps show compelling MVP on demo login',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Goal Map background**: Switched from dots to grid lines for cleaner look',
          '**Sidebar**: Note Map added as child of Notes, Goal Map as child of Goals',
          '**Weekly Report**: Removed spending section (sensitive data)',
        ],
      },
    ],
  },
  {
    version: '0.59.0',
    date: '2026-03-20',
    phase: 'Report & Review Restructure',
    sections: [
      {
        title: 'Added',
        items: [
          '**Report page**: New unified Report page (Focus > Report) with Daily/Weekly tab toggle',
          '**Weekly Report**: Summary of completed tasks, active goals with progress bars, habit streaks, spending — with Copy Markdown',
          '**Daily Review**: Evening debrief — energy level selector, today\'s win, lesson learned, tomorrow\'s intent — saves as journal entry',
          '**Present mode**: "Present" button on Daily Report launches the full-screen briefing page for standup delivery',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Sidebar restructure**: Focus submenus are now Inbox, Report, Review (was Inbox, Morning Summary, Review)',
          '**Review page**: Added Daily/Weekly tab toggle — Daily = evening debrief, Weekly = existing 5-step wizard',
          '**Tasks page**: "Standup" button renamed to "Report", navigates to `/report`',
        ],
      },
    ],
  },
  {
    version: '0.58.0',
    date: '2026-03-20',
    phase: 'Inbox, Capture Protocol & Note Templates',
    sections: [
      {
        title: 'Added',
        items: [
          '**Inbox page**: Full CRUD for inbox items — view, edit, convert to task, archive, delete with type filters (Focus > Inbox)',
          '**Capture protocol**: Enum-based prefix system — `!` task, `?` question, `*` idea, `@` goal, `#` habit with shared single source of truth',
          '**Slash commands**: 20+ VS Code-style `/commands` with emoji, grouped into ⚡ Capture, ♟️ Strategic, 🧠 Deep Mind categories',
          '**Slash command dropdown**: Type `/` in capture bar to browse commands with dynamic filtering, arrow key navigation, Enter/Tab to select',
          '**Note templates**: Type `/` in any task note input for 12 emoji-prefixed templates (`/action`, `/blocker`, `/decision`, `/risk`, `/win`, `/handoff`, etc.)',
          '**Capture bar direction**: Dropdown renders below on Focus/Inbox pages, dropup on Morning Summary bottom bar — always stays on screen',
        ],
      },
      {
        title: 'Changed',
        items: [
          '**Morning Summary capture**: Bottom bar upgraded from plain text input to protocol-aware capture bar with slash commands',
          '**InboxCapture dialog**: Refactored to use shared capture protocol instead of duplicated type detection logic',
          '**Sidebar**: Inbox added as first submenu under Focus alongside Morning Summary and Review',
        ],
      },
    ],
  },
  {
    version: '0.57.0',
    date: '2026-03-20',
    phase: 'Event Delete, Subtask Notes & Emperor Time CRUD',
    sections: [
      {
        title: 'Added',
        items: [
          '**Subtask notes**: Add timestamped notes per subtask — click the chat icon on any subtask row in the detail panel or Emperor Time',
          '**Emperor Time task detail**: Click the arrow icon on any task card in Emperor Time to open the full detail drawer for complete CRUD without leaving deep work',
          '**Subtask notes in standup**: Subtask notes appear in the Standup Summary prefixed with the subtask name',
          '**Subtask priority icons**: Jira-style priority icons (urgent/high/medium/low) on subtasks across Task Detail, Emperor Time, Focus page, and Standup Report',
        ],
      },
      {
        title: 'Fixed',
        items: [
          '**Local event delete**: Local events can now be deleted from the calendar event detail sheet — previously only Google Calendar events had a delete button',
        ],
      },
    ],
  },
  {
    version: '0.56.0',
    date: '2026-03-20',
    phase: 'Task Notes',
    sections: [
      {
        title: 'Added',
        items: [
          '**Task notes**: Add timestamped notes to any task from the detail panel — press Enter to save, Shift+Enter for newlines',
          '**Emperor Time notes**: Quick note input below subtasks during deep work sessions — jot context without leaving focus',
          '**Standup notes**: Recent notes (since last workday) appear under each task in the Standup Summary and copy to clipboard',
        ],
      },
    ],
  },
  {
    version: '0.55.0',
    date: '2026-03-20',
    phase: 'Relations Primitive, Keyboard Navigation & Visibility',
    sections: [
      {
        title: 'Added',
        items: [
          '**Relation primitive**: Task dependencies now use proper Relations (blocks, supports, relates) instead of metadata — foundation for knowledge graph and strategic map',
          '**J/K keyboard navigation**: Press `J`/`K` to navigate up/down through task list, `Enter` to open detail, `Esc` to deselect',
          '**Visibility toggle**: Set tasks as Private or Shared in the detail panel — shared tasks show a globe icon on cards',
          '**Multi-type relation linking**: Search tasks and link as blocker, supporter, or related — all managed via the Relations store',
          '**Related tasks section**: Detail panel shows all linked relations (supports, relates) with type labels and remove buttons',
        ],
      },
    ],
  },
  {
    version: '0.54.0',
    date: '2026-03-20',
    phase: 'Blocked By Dependencies & Workspace Dashboard',
    sections: [
      {
        title: 'Added',
        items: [
          '**Blocked by dependencies**: Link tasks as blockers in the detail panel — search/link UI with activity logging',
          '**Blocked indicator**: Ban icon on task cards when a task has blockers',
          '**Workspace dashboard split**: Filter all dashboard metrics (Life Score, trends, heatmaps, focus) by Work or Personal workspace',
        ],
      },
    ],
  },
  {
    version: '0.53.0',
    date: '2026-03-20',
    phase: 'Focus Bar, Activity Timeline & Collapsible Groups',
    sections: [
      {
        title: 'Added',
        items: [
          '**Focus Mode floating bar**: Clock + page title + exit button appears at top when in focus mode',
          '**Activity timeline**: Task detail panel logs status changes, priority changes, and subtask completions with relative timestamps',
          '**Collapse/expand all**: Toggle all time groups in task list view with one click',
          '**Collapsible time groups**: Each group (Today, Tomorrow, This Week, etc.) is independently collapsible',
        ],
      },
    ],
  },
  {
    version: '0.52.0',
    date: '2026-03-20',
    phase: 'Focus Mode',
    sections: [
      {
        title: 'Added',
        items: [
          '**Focus Mode**: Hide sidebar and top bar for distraction-free work — toggle via floating button or `Cmd+Shift+F`',
        ],
      },
    ],
  },
  {
    version: '0.51.0',
    date: '2026-03-20',
    phase: 'Drag-to-Reorder Subtasks',
    sections: [
      {
        title: 'Added',
        items: [
          '**Drag-to-reorder subtasks**: Drag handle on subtask rows for intuitive reordering via @dnd-kit/sortable',
        ],
      },
      {
        title: 'Changed',
        items: [
          'Replaced arrow-based subtask reorder buttons with drag handles (GripVertical icon)',
        ],
      },
    ],
  },
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
