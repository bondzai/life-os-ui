# Improvements & Nice-to-Have Features

> **Written against the 17-module app.** Several items struck through as done belong to features
> since deleted. Read it as a backlog of ideas, not as a state claim.

Prioritized enhancements across all modules. Organized by effort tier.
For the Minimalist Mind cognitive system features, see [TODO.md](../TODO.md) Phase 16.

---

## Tier 1: Quick Wins (small effort, big impact)

### Cross-Cutting
- ~~**Bulk actions**~~: Multi-select items → bulk delete, archive, or change status
- ~~**Duplicate item**~~: Done (Phase 12)
- ~~**Undo delete**~~: Done (Phase 12)
- ~~**Sidebar collapsible groups**~~: Done (Phase 12)
- ~~**Sidebar badges**~~: Done (Phase 12)
- **Keyboard shortcuts**: `N` = new item, `J/K` = navigate list, `/` = search
- ~~**Data export**~~: Done (Phase 12)
- ~~**Data import**~~: Done (Phase 12)
- ~~**Capture Bar**~~: Done (v0.23.0) — inline fast capture on Focus page

### Dashboard / Focus
- ~~**Richer dashboard**~~: Done (Phase 12)
- ~~**Weekly Review card**~~: Done (Phase 12)
- ~~**Cognitive Dashboard**~~: Done (v0.23.0) — Today Focus, Strategic Direction, Active Projects, Knowledge Growth
- ~~**Daily Protocol**~~: Done (v0.23.0) — morning/evening guided flows
- ~~**Clarity Metrics**~~: Done (v0.23.0) — Focus Score, Noise, Knowledge Growth

### Goals
- ~~**Progress slider on card**~~: Done (Phase 12)
- ~~**Color-code by progress**~~: Done (Phase 12)
- ~~**Auto-progress from sub-goals**~~: Done (Phase 12)

### Tasks
- ~~**Priority color on Kanban cards**~~: Done (Phase 12)
- ~~**Quick snooze**~~: Done
- ~~**Subtask support**~~: Done (Phase 12)

### Habits
- ~~**Habit heatmap**~~: Done (Phase 12)
- ~~**Completion rate badge**~~: Done
- ~~**Streak milestone badges**~~: Done (Phase 12)

### Notes
- ~~**Pin/favorite toggle**~~: Done (Phase 12)
- ~~**Markdown rendering**~~: Done
- ~~**Tags filter dropdown**~~: Done (Phase 12)

### Memories
- ~~**EXIF date extraction**~~: Done
- ~~**"On This Day" widget**~~: Done
- ~~**Photo albums**~~: Done

---

## Tier 2: Medium Effort (meaningful features)

### Calendar
- ~~**Week view**~~: Done (Phase 13)
- ~~**Agenda view**~~: Done (Phase 13)
- **Drag to reschedule**: Drag entity on calendar grid to change due date
- ~~**Entity type filter**~~: Done

### Tasks
- **Time estimate field**: Add estimated hours to tasks, show on card
- **Recurring tasks**: Auto-create task at set frequency (daily, weekly, monthly)
- **"Blocked by" indicator**: Link tasks as dependencies, show blocked status

### Wealth
- ~~**Net worth trend chart**~~: Done (Phase 13)
- ~~**Income vs Expense chart**~~: Done (Phase 13)
- ~~**Budget alerts**~~: Done (Phase 13)
- ~~**Recurring transactions**~~: Done

### Health
- ~~**Weight trend chart**~~: Done (Phase 13)
- ~~**Workout heatmap**~~: Done
- ~~**Sleep trend chart**~~: Done (Phase 13)
- ~~**Water intake tracker**~~: Done

### Family
- ~~**Chore rotation**~~: Done
- ~~**Chore completion history**~~: Done
- ~~**Household goals tab**~~: Done

### Posts
- ~~**Emoji reactions**~~: Done
- ~~**Reply/thread**~~: Done
- ~~**Media attachments**~~: Done

### Places
- ~~**Click map to set location**~~: Done (mapcn)
- ~~**Open in Maps**~~: Done
- **Visit counter**: Track how many times you've visited each place
- **Photo per place**: Attach a thumbnail image to places

### Travel
- ~~**Itinerary timeline**~~: Done
- ~~**Trip budget**~~: Done
- **Packing checklist**: Reusable template-based packing list per trip

### Today / Focus
- ~~**Pomodoro timer**~~: Done (Phase 13)
- ~~**Time-of-day sections**~~: Done (Phase 13)
- ~~**Daily affirmation**~~: Done

### Review
- ~~**Week-over-week comparison**~~: Done (Phase 13)
- ~~**Accomplishment highlights**~~: Done
- ~~**Next-week priorities**~~: Done (Phase 13)

---

## Tier 3: Larger Features (significant effort)

### Cross-Cutting
- ~~**Full-text search**~~: Done (Phase 14)
- ~~**Saved filters/views**~~: Done (Phase 14)
- **Activity timeline per entity**: Show change history (who changed what, when)
- ~~**Comment system**~~: Done (Phase 14)
- ~~**Inline editing**~~: Done (Phase 14)

### Google Calendar CRUD (Bidirectional Sync)
Currently read-only via iCal feeds. Full details in [TODO.md](../TODO.md).
- **Backend**: OAuth2 flow, token management, GCal API proxy endpoints, webhook receiver
- **Frontend**: Google sign-in, calendar selector, unified event list, create/edit/delete Google events inline, drag to reschedule, conflict detection, sync status indicator
- **Sync**: Incremental sync with `syncToken`, offline queue, duplicate prevention via `googleEventId`

### Minimalist Mind Features (see [TODO.md](../TODO.md) Phase 16)
- **AI Clarify Layer**: AI-powered inbox triage (type, priority, domain suggestions)
- **Knowledge Engine**: Structured entries with title/summary/insight/source/domain
- **Knowledge Graph**: Visual linking between ideas, projects, and goals
- **Strategic Map**: Visual goal hierarchy (Strategic → Projects → Milestones)
- **Anti-Noise System**: Stale item detection, auto-archive, noise dashboard
- **AI Agent Roles**: Research, Architecture, Reviewer, Strategy agents
- **Auto-Focus Engine**: AI-suggested daily priorities
- **Cognitive Loop Tracker**: Learn → Build → Reflect → Improve cycle

### Skills
- ~~**Practice log**~~: Done (Phase 14)
- **Proficiency curve chart**: Visualize skill progression over time
- **Learning path templates**: Curated skill trees (e.g., "Full Stack Dev")

### Reading
- ~~**Reading progress**~~: Done (Phase 14)
- **Highlights/quotes**: Capture notable quotes from books
- ~~**Reading challenge**~~: Done (Phase 14)
- **Shelves**: Organize into collections (To Read, Favorites, Gifted)

### Automate
- ~~**Execution history log**~~: Done (Phase 14)
- ~~**Conditional logic**~~: Done (Phase 14)
- ~~**Event-driven triggers**~~: Done (Phase 14)
- ~~**Dry-run mode**~~: Done (Phase 14)

### Home
- **Service health monitoring**: Ping/heartbeat checks with uptime percentage
- **Docker container status**: Show running containers (if API available)
- **Service dependency tree**: Visualize which services depend on which devices

---

## Tier 4: Future Vision (post-API server)

These require backend infrastructure.

- **Real-time sync**: Multi-device sync via WebSocket
- **Push notifications**: Server-sent reminders for due tasks, habits, chores
- **Shared editing**: Both users editing simultaneously without conflicts
- **External integrations**: GitHub commits → skill practice, Fitbit → body metrics
- **AI insights**: "You complete more tasks on Tuesdays" — behavioral pattern analysis
- **Mobile app**: React Native wrapper or enhanced PWA for native feel
- **Voice capture**: Speech-to-text via OpenClaw + Web Speech API
- **Smart scheduling**: AI suggests optimal time for tasks based on past patterns
- **Gamification**: XP points, levels, and badges for consistent usage
- **Daily Brief v2**: AI-generated morning intelligence briefing with personalized insights
- **Spaced Repetition**: Review knowledge entries at optimal intervals for retention

---

## Implementation Notes

- **No new entity types needed** for most features — use `note` with structured metadata for knowledge entries
- **Charts**: Use Recharts (already installed) for trend lines, heatmaps, comparisons
- **Knowledge Graph**: Consider `reactflow` or `d3-force` for node visualization
- **Strategic Map**: Tree layout with `reactflow` or custom SVG
- **AI Agents**: Implement as system prompts in existing chat sidebar with role selector
- **Voice Capture**: Web Speech API (`webkitSpeechRecognition`) — no dependency needed
- **Spaced Repetition**: SM-2 algorithm, stored in entity metadata
- **Focus Mode**: CSS class toggle hiding sidebar + right panel, showing only left column
