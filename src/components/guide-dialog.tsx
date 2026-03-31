import { useState } from 'react'
import {
  BarChart3,
  Bell,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Command,
  Crown,
  Eye,
  Keyboard,
  LayoutDashboard,
  ListChecks,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'

interface GuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface GuideSection {
  id: string
  icon: React.ReactNode
  title: string
  items: { label: string; detail: string }[]
}

const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'quick-start',
    icon: <Zap className="h-4 w-4" />,
    title: 'Quick Start',
    items: [
      { label: 'Focus page', detail: 'Your home screen — set up to 3 daily priorities, run morning/evening protocols, and launch Deep Focus sessions. Uses GitHub-style tabs: Overview shows priorities + schedule, favorite tabs embed full pages inline.' },
      { label: 'Favorite tabs', detail: 'Click the gear icon on the Focus tab bar to add/remove tabs. Each tab renders the full module page (Tasks, Calendar, Habits, Report, etc.) directly — no navigation needed.' },
      { label: 'Capture anything', detail: 'Press `⌘⇧I` from any page (including during Deep Focus) to open Quick Capture. Three types: `!action` (task), `@outcome` (goal), `#system` (habit). Type `/` for more commands.' },
      { label: 'Review', detail: '4 tabs — Plan (weekly planning), Standup (daily report + copy), Debrief (evening review), Weekly (6-step wizard). Plan tab is the default.' },
      { label: 'Command palette', detail: 'Press `Cmd+K` from any page to search everything — tasks, goals, notes, habits, and navigation.' },
    ],
  },
  {
    id: 'lyra-ai',
    icon: <Sparkles className="h-4 w-4" />,
    title: 'Lyra AI',
    items: [
      { label: 'Lyra page', detail: 'Navigate to `/lyra` for the full strategic command interface — AI chat, tool arsenal, and dashboard in one war room.' },
      { label: 'AI status', detail: 'Green wifi icon = Lyra AI is online (Ollama running). Gray = offline. When offline, all features gracefully fall back to algorithmic mode.' },
      { label: 'Ask Lyra', detail: 'Type any question in the Lyra widget on Focus page or the full chat on the Lyra page. Responses stream in real-time.' },
      { label: 'AI tools', detail: 'Sparkle (✨) buttons on tasks, goals, projects, and habits. Click to run AI analysis: **Break Down** (subtasks), **Risk Analysis** (deadlines), **Coach Me** (habits), **Weekly Summary**.' },
      { label: 'Personality', detail: 'Lyra speaks like an INTJ strategist — direct, specific, no fluff. Customize her personality in AI Settings → Personality tab.' },
      { label: 'Ollama setup', detail: 'Run `brew services start ollama` to enable AI. Uses llama3.2:1b locally — your data never leaves your machine.' },
    ],
  },
  {
    id: 'tasks',
    icon: <ListChecks className="h-4 w-4" />,
    title: 'Tasks & Stories',
    items: [
      { label: 'Task types', detail: 'Simple tasks stand alone. Add subtasks to create a **story** — the parent status auto-derives from subtask progress.' },
      { label: 'Status workflow', detail: 'Click the status badge on any task to change: Backlog → To Do → In Progress → Done. Stories with subtasks show a static badge.' },
      { label: 'Subtask 3-state cycle', detail: 'Click the circle on a subtask to cycle: Todo → In Progress (WIP) → Done. The parent task status updates automatically.' },
      { label: 'Drag to reorder', detail: 'Grab the grip handle on subtasks to drag and reorder them in any view — task detail, Focus page, or Emperor Time.' },
      { label: 'Recurring tasks', detail: 'Set recurrence (daily/weekly/biweekly/monthly) in task detail. When completed, the next occurrence auto-creates with reset subtasks.' },
      { label: 'Task relations', detail: 'In the task detail panel, link tasks as **blockers**, **supporters**, or **related**. Blocked tasks show a Ban icon. Relations use the core Relation primitive.' },
      { label: 'Visibility', detail: 'Set tasks as **Private** or **Shared** in the detail panel. Shared tasks show a globe icon on their card. Private tasks are only visible to the owner.' },
      { label: 'Bulk actions', detail: 'Toggle "Select" mode in the task toolbar, check multiple tasks, then archive, delete, or change status in batch.' },
      { label: 'Workspaces', detail: 'Tag tasks as Work or Personal. Filter by workspace in the task toolbar and standup summary.' },
      { label: 'Collapse/expand groups', detail: 'Click any time group header (Today, Tomorrow, etc.) to collapse it. Use the "Collapse All" / "Expand All" button next to view tabs.' },
      { label: 'Task notes', detail: 'Add timestamped notes to any task in the detail panel. Press `Enter` to save, `Shift+Enter` for newlines. Notes appear in the Standup Summary and can be jotted during Emperor Time.' },
      { label: 'Subtask notes', detail: 'Click the chat icon on any subtask to add notes. Subtask notes show in the Standup Summary prefixed with the subtask name, and are editable from Emperor Time.' },
      { label: 'Subtask priority', detail: 'Click the priority icon on a subtask to cycle through urgent (red ⬆⬆), high (orange ⬆), medium (yellow —), and low (blue ⬇). Priority icons appear in Task Detail, Focus page, Emperor Time, and Standup Report.' },
      { label: 'Activity timeline', detail: 'Open a task detail panel — the Activity section (bottom) logs status changes, priority changes, and subtask completions with timestamps.' },
    ],
  },
  {
    id: 'focus',
    icon: <Target className="h-4 w-4" />,
    title: 'Focus System',
    items: [
      { label: 'Daily priorities', detail: 'Pick up to 3 tasks/stories as today\'s focus on the Focus page. These drive your Focus Score and appear in the standup summary.' },
      { label: 'Focus streak', detail: 'Flame icon shows consecutive days with 25+ minutes of deep work. Visible next to the Deep Focus button.' },
      { label: 'Standup summary', detail: 'Click "Summary" on the Focus page to see what\'s done, in progress, and planned. Copy to clipboard for standups.' },
      { label: 'Stale item detector', detail: 'Items untouched for 14+ days surface in the Focus sidebar. Snooze them (resets the clock) or archive to reduce noise.' },
    ],
  },
  {
    id: 'emperor-time',
    icon: <Crown className="h-4 w-4" />,
    title: 'Emperor Time (Deep Work)',
    items: [
      { label: 'What it is', detail: 'A full-screen distraction-free mode with a Pomodoro timer. Sidebar and top bar disappear — just you and your focus tasks.' },
      { label: 'Timer presets', detail: '**Classic** (25m work / 5m break), **Deep** (50m / 10m), **Sprint** (90m / 20m). Pick in the bottom bar.' },
      { label: 'Focus tasks', detail: 'Your daily priorities carry into Deep Focus. Click a task to expand its subtasks. Cycle subtask status inline.' },
      { label: 'Quick Capture', detail: 'Click the inbox icon in the top bar or press `⌘⇧I` to capture thoughts without leaving the session.' },
      { label: 'Quick notes', detail: 'Jot notes on the active task during a session — they persist on the task and show up in your standup summary.' },
      { label: 'Subtask notes', detail: 'Click the chat icon on any subtask row to add or view notes per subtask — great for tracking context during deep work.' },
      { label: 'Task detail drawer', detail: 'Click the arrow icon on a task card to open the full detail panel as a drawer — edit all fields, manage relations, notes, and subtasks without leaving Deep Focus.' },
      { label: 'Session logging', detail: 'Each completed pomodoro is logged as a tracker entry. View session history on the Sessions page.' },
      { label: 'Session persistence', detail: 'Leaving Deep Focus (Esc or X) pauses the timer but keeps the session alive. The Focus sidebar blinks amber with remaining time. The "Continue" button on Focus page resumes instantly.' },
    ],
  },
  {
    id: 'focus-mode',
    icon: <Eye className="h-4 w-4" />,
    title: 'Focus Mode',
    items: [
      { label: 'Toggle', detail: 'Press `Cmd+Shift+F` or click the eye icon (bottom-right corner) to hide the sidebar and top bar for distraction-free browsing.' },
      { label: 'Floating bar', detail: 'In focus mode, hover the top center to reveal a floating bar showing the current time, page title, and exit button.' },
      { label: 'Difference from Emperor Time', detail: 'Focus Mode keeps you on your current page with full navigation via `Cmd+K`. Emperor Time is a dedicated deep work session with timer.' },
    ],
  },
  {
    id: 'proactive',
    icon: <Bell className="h-4 w-4" />,
    title: 'Proactive Features',
    items: [
      { label: 'Lyra Pulse', detail: 'Background monitoring every 10 minutes — fires toast notifications for critical signals (streak risk, budget warnings, stale projects) on any page.' },
      { label: 'Deep Work Coach', detail: 'During focus sessions, a collapsible coach panel shows at-risk streaks, session progress, and next task suggestions. Collapsed by default — expand with the chevron button.' },
      { label: 'Session Summary', detail: 'When a pomodoro work phase ends, Lyra shows a toast with your session count, tasks worked on, and any pending streak check-ins.' },
      { label: 'Celebrations', detail: 'Lyra toasts real-time achievements: task completions, goal completions, and habit streak milestones (7, 30, 90, 180, 365 days).' },
      { label: 'Morning Brief', detail: 'Right sidebar on Focus page — algorithmic signals from 8 detectors: streak risk, stale projects, budget warnings, sleep drops, energy patterns, decision reviews, achievements, velocity changes.' },
    ],
  },
  {
    id: 'goals',
    icon: <Target className="h-4 w-4" />,
    title: 'Goals (Outcomes)',
    items: [
      { label: 'Three types', detail: 'Lyra uses 3 entity types: **Goal** (outcome — where you\'re going), **Task** (action — what to do next), **Habit** (system — who you\'re becoming).' },
      { label: 'Goals absorb projects', detail: 'Projects and goals are unified. Create goals with `@outcome` capture. Set category, domain, tech stack, and linked tasks.' },
      { label: 'Link tasks', detail: 'In any task detail panel, select a goal from the Goal dropdown. Linked tasks drive velocity tracking.' },
      { label: 'Velocity panel', detail: 'Goal detail views show a velocity panel: 4-week task completion bars, projected completion date, and risk indicator.' },
      { label: 'Weekly outcomes', detail: 'Set 3 weekly outcomes in Review → Plan tab. Track done/missed in Weekly Review.' },
    ],
  },
  {
    id: 'dashboard',
    icon: <BarChart3 className="h-4 w-4" />,
    title: 'Dynamic Dashboard',
    items: [
      { label: 'Signal-driven widgets', detail: '12 widgets auto-selected by relevance: streak tracker, overdue tasks, project velocity, budget meter, sleep trend, goal progress, focus hours, energy pattern, stale projects, upcoming events, decision review, weekly velocity.' },
      { label: 'Pin & hide', detail: 'Hover any widget to pin (always show) or hide (never show). Pinned widgets get a primary border accent.' },
      { label: 'Shuffle', detail: 'Re-roll widget selection to surface different signals.' },
      { label: 'Strategy tab', detail: 'Threats from morning brief + AI strategic moves + knowledge pulse + scoreboard with goal velocity.' },
    ],
  },
  {
    id: 'modules',
    icon: <LayoutDashboard className="h-4 w-4" />,
    title: 'Modules Overview',
    items: [
      { label: 'Daily', detail: '**Focus** (daily priorities, protocols, AI brief), **Dashboard** (dynamic widgets, life radar), **Lyra** (AI command interface).' },
      { label: 'Plan', detail: '**Tasks** (Jira-style board + list), **Projects** (online/offline projects with velocity), **Calendar** (schedule + Google Calendar feeds), **Notes** (freeform + journal + decisions), **Goals** (strategic direction, velocity), **Habits** (daily streaks, protocols), **Skills** (mastery levels, learning vault).' },
      { label: 'Life', detail: '**Health** (body metrics, workouts), **Wealth** (transactions, budgets), **Learning** (skills, reading lists), **Travel** (trips, places), **Family** (chores, shared tasks).' },
    ],
  },
  {
    id: 'keyboard',
    icon: <Keyboard className="h-4 w-4" />,
    title: 'Keyboard Shortcuts',
    items: [
      { label: '`Cmd+K`', detail: 'Open command palette — search and navigate anywhere.' },
      { label: '`Cmd+Shift+I`', detail: 'Open inbox capture dialog from any page.' },
      { label: '`Cmd+Shift+F`', detail: 'Toggle Focus Mode (hide sidebar + top bar).' },
      { label: '`Cmd+B`', detail: 'Toggle sidebar collapse.' },
      { label: '`/`', detail: 'Focus the capture bar (on Focus page).' },
      { label: '`J` / `K`', detail: 'Navigate down/up through task list items. `Enter` opens the focused task.' },
      { label: '`Esc`', detail: 'Pause / leave Emperor Time session. Deselect focused task in list.' },
    ],
  },
  {
    id: 'data',
    icon: <Command className="h-4 w-4" />,
    title: 'Data & Settings',
    items: [
      { label: 'Export / Import', detail: 'Click your avatar in the sidebar footer to export a full JSON backup or import from a previous backup.' },
      { label: 'Two users', detail: 'Lyra supports two accounts — admin and member. Switch in the login screen.' },
      { label: 'Local-first', detail: 'All data lives in localStorage by default. Enable the API backend (`VITE_USE_API=true`) for server-side SQLite persistence.' },
      { label: 'Dark mode', detail: 'Toggle in the sidebar footer (sun/moon icon). Follows your system preference by default.' },
    ],
  },
]

export function GuideDialog({ open, onOpenChange }: GuideDialogProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['quick-start']))

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-br from-blue-500/10 via-purple-500/5 to-transparent px-6 pt-6 pb-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
                <BookOpen className="h-5 w-5 text-blue-500" />
              </div>
              <div>
                <DialogTitle className="text-xl">How to Use Lyra</DialogTitle>
                <DialogDescription className="mt-0.5">
                  Navigate your life by the stars
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        <Separator />

        <ScrollArea className="h-[60vh]">
          <div className="px-6 py-4 space-y-1">
            {GUIDE_SECTIONS.map((section) => {
              const isOpen = expanded.has(section.id)
              return (
                <div key={section.id}>
                  <button
                    onClick={() => toggle(section.id)}
                    className="w-full flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-accent/50 transition-colors text-left cursor-pointer"
                  >
                    {isOpen
                      ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    }
                    <span className="text-muted-foreground shrink-0">{section.icon}</span>
                    <span className="text-sm font-semibold flex-1">{section.title}</span>
                    <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">
                      {section.items.length}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="ml-11 pb-3 pt-1 space-y-3">
                      {section.items.map((item, i) => (
                        <div key={i} className="flex gap-2.5">
                          <span className="text-muted-foreground/30 shrink-0 mt-1.5">
                            <span className="block w-1.5 h-1.5 rounded-full bg-current" />
                          </span>
                          <div>
                            <span
                              className="text-sm font-medium text-foreground"
                              dangerouslySetInnerHTML={{ __html: formatText(item.label) }}
                            />
                            <p
                              className="text-sm text-muted-foreground leading-relaxed mt-0.5"
                              dangerouslySetInnerHTML={{ __html: formatText(item.detail) }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function formatText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
    .replace(/`(.+?)`/g, '<kbd class="text-[11px] bg-muted px-1.5 py-0.5 rounded font-mono border border-border">$1</kbd>')
}
