# Improvements & Nice-to-Have Features

Prioritized enhancements across all modules. Organized by effort tier — pick from any tier based on current goals.

---

## Tier 1: Quick Wins (small effort, big impact)

### Cross-Cutting
- **Bulk actions**: Multi-select items → bulk delete, archive, or change status
- **Duplicate item**: Clone any entity (task, goal, chore, etc.) with one click
- **Undo delete**: Toast with "Undo" button after deleting an entity (soft delete → restore)
- ~~**Sidebar collapsible groups**~~: Done (Phase 12)
- ~~**Sidebar badges**~~: Done (Phase 12)
- **Keyboard shortcuts**: `N` = new item, `J/K` = navigate list, `/` = search
- ~~**Data export**~~: Done (Phase 12)
- ~~**Data import**~~: Done (Phase 12)

### Dashboard
- ~~**Richer dashboard**~~: Done (Phase 12) — health summary, wealth snapshot, habit completion rate
- ~~**"Start Weekly Review" card**~~: Done (Phase 12)
- **Motivational message**: Show encouraging text when all tasks complete

### Goals
- **Progress slider on card**: Quick-adjust progress without opening dialog
- ~~**Color-code by progress**~~: Done (Phase 12)
- ~~**Auto-progress from sub-goals**~~: Done (Phase 12)

### Tasks
- ~~**Priority color on Kanban cards**~~: Done (Phase 12)
- **Quick snooze**: Reschedule task by 1 day or 1 week from card
- **Subtask support**: Nested checklist items within a task

### Habits
- ~~**Habit heatmap**~~: Done (Phase 12)
- **Completion rate badge**: "85% this month" on each habit card
- ~~**Streak milestone badges**~~: Done (Phase 12)

### Notes
- ~~**Pin/favorite toggle**~~: Done (Phase 12)
- **Markdown rendering**: Render note body as markdown (bold, links, code blocks)
- ~~**Tags filter dropdown**~~: Done (Phase 12)

### Memories
- **EXIF date extraction**: Auto-fill date from photo metadata
- **"On This Day" widget**: Show memories from same date in past years (dashboard card)
- **Photo albums**: Group memories into named collections

---

## Tier 2: Medium Effort (meaningful features)

### Calendar
- **Week view**: 7-day grid with hourly time blocks
- ~~**Agenda view**~~: Done (Phase 13) — 14-day vertical timeline with Month/Agenda tabs
- **Drag to reschedule**: Drag entity on calendar grid to change due date
- **Entity type filter**: Toggle visibility of tasks, events, habits on calendar

### Tasks
- **Time estimate field**: Add estimated hours to tasks, show on card
- **Recurring tasks**: Auto-create task at set frequency (daily, weekly, monthly)
- **"Blocked by" indicator**: Link tasks as dependencies, show blocked status

### Wealth
- **Net worth trend chart**: Monthly line chart showing progression
- ~~**Income vs Expense chart**~~: Done (Phase 13) — grouped bar chart, 6 months
- ~~**Budget alerts**~~: Done (Phase 13) — warning badge at 80%+ spending
- **Recurring transactions**: Auto-create scheduled expenses/income

### Health
- ~~**Weight trend chart**~~: Done (Phase 13) — line chart with kg formatting
- **Workout heatmap**: Calendar-style grid showing workout days
- ~~**Sleep trend chart**~~: Done (Phase 13) — 30-day line chart with 8h reference
- **Water intake tracker**: Simple daily counter

### Family
- **Chore rotation**: Auto-swap assignee on completion (JB → Sunny → JB)
- **Chore completion history**: Track who completed what and when
- **Household goals tab**: Shared goals for the family (e.g., "Save 50K THB by June")

### Posts
- **Emoji reactions**: React to posts with emoji (heart, thumbs up, laugh)
- **Reply/thread**: Comment on posts to create conversations
- **Media attachments**: Attach images to posts (reuse memory image compression)

### Places
- **Click map to set location**: Click on Leaflet map instead of manual lat/lng
- **Open in Maps**: Deep link to Google Maps/Apple Maps for directions
- **Visit counter**: Track how many times you've visited each place
- **Photo per place**: Attach a thumbnail image to places

### Travel
- **Itinerary timeline**: Day-by-day view of trip places with time slots
- **Trip budget**: Track planned vs actual spending per trip
- **Packing checklist**: Reusable template-based packing list per trip

### Today Page
- ~~**Pomodoro timer**~~: Done (Phase 13) — 25/5 cycle with Web Audio beep
- **Time-of-day sections**: Group items into Morning, Afternoon, Evening blocks
- **Daily affirmation**: Random motivational quote at top

### Review
- ~~**Week-over-week comparison**~~: Done (Phase 13) — delta badge in accomplishments
- **Accomplishment highlights**: Top 3 items with larger cards and emoji badges
- ~~**Next-week priorities**~~: Done (Phase 13) — auto-suggest in reflection step

---

## Tier 3: Larger Features (significant effort)

### Cross-Cutting
- **Full-text search**: Search across all entity titles, descriptions, and metadata bodies
- **Saved filters/views**: Save filter combinations as named views per module
- **Activity timeline per entity**: Show change history (who changed what, when)
- **Comment system**: Add comments/notes to any entity
- **Inline editing**: Edit fields directly on cards without opening dialog

### Skills
- **Practice log**: Quick "Log practice" button that creates tracker entries
- **Proficiency curve chart**: Visualize skill progression over time
- **Learning path templates**: Curated skill trees (e.g., "Full Stack Dev")

### Reading
- **Reading progress**: Pages read / total pages with progress bar
- **Highlights/quotes**: Capture notable quotes from books
- **Reading challenge**: Annual goal (e.g., "Read 24 books in 2026") with tracker
- **Shelves**: Organize into collections (To Read, Favorites, Gifted)

### Automate
- **Execution history log**: Timestamped list of past runs with results
- **Conditional logic**: If/then rules (e.g., "if task overdue 3+ days, send notification")
- **Event-driven triggers**: Fire on entity status change, tag match, or tracker threshold
- **Dry-run mode**: Preview what automation would do before executing

### Home
- **Service health monitoring**: Ping/heartbeat checks with uptime percentage
- **Docker container status**: Show running containers (if API available)
- **Service dependency tree**: Visualize which services depend on which devices

---

## Tier 4: Future Vision (post-API server)

These require the Phase 3.5 API server to be in place.

- **Real-time sync**: Multi-device sync via API (currently localStorage only)
- **Push notifications**: Server-sent reminders for due tasks, habits, chores
- **Shared editing**: Both users editing simultaneously without conflicts
- **External integrations**: GitHub commits → skill practice, Fitbit → body metrics
- **AI insights**: "You complete more tasks on Tuesdays" — pattern analysis
- **Mobile app**: React Native wrapper or PWA improvements for native feel
- **Voice capture**: "Hey Life-OS, add a task" via OpenClaw + speech-to-text
- **Smart scheduling**: AI suggests optimal time for tasks based on past patterns
- **Gamification**: XP points, levels, and badges for consistent usage

---

## Implementation Notes

- **No new entity types needed** for Tier 1 and most of Tier 2
- **Charts**: Use Recharts (already installed) for trend lines, heatmaps, comparisons
- **Heatmap**: Can build with a simple CSS grid + color scale (no new dependency)
- **Pomodoro**: Pure client-side timer with `setInterval` + notification API
- **EXIF**: Use browser `createImageBitmap` or a tiny EXIF parser (~2KB)
- **Data export/import**: JSON `Blob` download + `FileReader` upload
- **Markdown**: Use `react-markdown` or render with simple regex for bold/italic/links
