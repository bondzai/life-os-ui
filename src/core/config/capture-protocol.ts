import {
  CheckSquare,
  NotebookPen,
  Lightbulb,
  Target,
  Repeat,
  HelpCircle,
  Bug,
  Link,
  Code,
  Clock,
  CalendarPlus,
  Zap,
  Brain,
  Flame,
  Bookmark,
  Shield,
  Megaphone,
  FlaskConical,
  Swords,
  type LucideIcon,
} from 'lucide-react'
import type { EntityType, EntityPriority } from '@/core/types'

// ─── Capture Protocol ───
// Two input modes:
//   1. Quick prefix:  !task  ?question  *idea  @goal  #habit
//   2. Slash command: /task  /bug  /snippet  /link  /someday  /meeting ...
// No prefix defaults to 'note' (inbox).

export const CapturePrefix = {
  Task: '!',
  Question: '?',
  Idea: '*',
  Goal: '@',
  Habit: '#',
} as const

export interface CaptureRule {
  prefix: (typeof CapturePrefix)[keyof typeof CapturePrefix] | string
  label: string
  icon: LucideIcon
  entityType: EntityType
  defaultPriority: EntityPriority
  autoTags: string[]
  hint: string
}

// ─── Quick prefix rules (single-char) ───
export const CAPTURE_RULES: CaptureRule[] = [
  { prefix: CapturePrefix.Task,     label: 'Task',     icon: CheckSquare, entityType: 'task', defaultPriority: 'medium', autoTags: [],           hint: '! Buy groceries' },
  { prefix: CapturePrefix.Question, label: 'Question', icon: HelpCircle,  entityType: 'note', defaultPriority: 'medium', autoTags: ['question'], hint: '? Why is deploy slow' },
  { prefix: CapturePrefix.Idea,     label: 'Idea',     icon: Lightbulb,   entityType: 'note', defaultPriority: 'medium', autoTags: ['idea'],     hint: '* Dashboard redesign' },
  { prefix: CapturePrefix.Goal,     label: 'Goal',     icon: Target,      entityType: 'goal', defaultPriority: 'medium', autoTags: [],           hint: '@ Ship v1 by Q2' },
  { prefix: CapturePrefix.Habit,    label: 'Habit',    icon: Repeat,      entityType: 'habit', defaultPriority: 'medium', autoTags: [],          hint: '# Meditate 10min' },
]

// ─── Slash commands (/command) ───
export interface SlashCommand {
  command: string
  aliases: string[]
  label: string
  emoji: string
  description: string
  icon: LucideIcon
  entityType: EntityType
  defaultPriority: EntityPriority
  autoTags: string[]
  category: 'capture' | 'strategic' | 'creative'
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Capture (daily tactical)
  { command: '/task',     aliases: ['/t'],    label: 'Task',      emoji: '✅', description: 'Create actionable task',            icon: CheckSquare,  entityType: 'task', defaultPriority: 'medium', autoTags: [],            category: 'capture' },
  { command: '/note',     aliases: ['/n'],    label: 'Note',      emoji: '📝', description: 'Quick note to self',               icon: NotebookPen,  entityType: 'note', defaultPriority: 'medium', autoTags: [],            category: 'capture' },
  { command: '/bug',      aliases: [],        label: 'Bug',       emoji: '🐛', description: 'Report a bug or issue',            icon: Bug,          entityType: 'task', defaultPriority: 'high',   autoTags: ['bug'],       category: 'capture' },
  { command: '/question', aliases: ['/q'],    label: 'Question',  emoji: '❓', description: 'Something to investigate',         icon: HelpCircle,   entityType: 'note', defaultPriority: 'medium', autoTags: ['question'],  category: 'capture' },
  { command: '/meeting',  aliases: ['/mtg'],  label: 'Meeting',   emoji: '🤝', description: 'Meeting note or action item',      icon: CalendarPlus, entityType: 'note', defaultPriority: 'medium', autoTags: ['meeting'],   category: 'capture' },
  { command: '/link',     aliases: ['/url'],  label: 'Link',      emoji: '🔗', description: 'Save URL or bookmark',             icon: Link,         entityType: 'note', defaultPriority: 'medium', autoTags: ['link'],      category: 'capture' },
  { command: '/snippet',  aliases: ['/code'], label: 'Snippet',   emoji: '💻', description: 'Save code snippet or pattern',     icon: Code,         entityType: 'note', defaultPriority: 'medium', autoTags: ['snippet'],   category: 'capture' },
  { command: '/bookmark', aliases: ['/bm'],   label: 'Bookmark',  emoji: '🔖', description: 'Bookmark for later reading',       icon: Bookmark,     entityType: 'note', defaultPriority: 'low',    autoTags: ['bookmark'],  category: 'capture' },

  // ── Strategic (INTJ master plan)
  { command: '/idea',     aliases: ['/i'],    label: 'Idea',      emoji: '💡', description: 'Spark worth exploring',            icon: Lightbulb,    entityType: 'note', defaultPriority: 'medium', autoTags: ['idea'],      category: 'strategic' },
  { command: '/goal',     aliases: ['/g'],    label: 'Goal',      emoji: '🎯', description: 'Define an objective',              icon: Target,       entityType: 'goal', defaultPriority: 'medium', autoTags: [],            category: 'strategic' },
  { command: '/habit',    aliases: ['/h'],    label: 'Habit',     emoji: '🔁', description: 'Build a recurring system',         icon: Repeat,       entityType: 'habit', defaultPriority: 'medium', autoTags: [],           category: 'strategic' },
  { command: '/someday',  aliases: [],        label: 'Someday',   emoji: '🌙', description: 'Low-priority, revisit later',      icon: Clock,        entityType: 'task', defaultPriority: 'low',    autoTags: ['someday'],   category: 'strategic' },
  { command: '/decide',   aliases: ['/d'],    label: 'Decision',  emoji: '⚖️', description: 'Decision to make or log',          icon: Shield,       entityType: 'note', defaultPriority: 'high',   autoTags: ['decision'],  category: 'strategic' },
  { command: '/blocker',  aliases: ['/block'], label: 'Blocker',  emoji: '🚧', description: 'Something blocking progress',      icon: Swords,       entityType: 'task', defaultPriority: 'urgent', autoTags: ['blocker'],   category: 'strategic' },

  // ── Creative (deep mind)
  { command: '/spark',    aliases: [],        label: 'Spark',     emoji: '⚡', description: 'Flash insight, capture fast',       icon: Zap,          entityType: 'note', defaultPriority: 'medium', autoTags: ['spark'],     category: 'creative' },
  { command: '/think',    aliases: [],        label: 'Think',     emoji: '🧠', description: 'Deep thought, needs processing',   icon: Brain,        entityType: 'note', defaultPriority: 'medium', autoTags: ['think'],     category: 'creative' },
  { command: '/rant',     aliases: [],        label: 'Rant',      emoji: '🔥', description: 'Frustration dump, get it out',      icon: Flame,        entityType: 'note', defaultPriority: 'low',    autoTags: ['rant'],      category: 'creative' },
  { command: '/announce', aliases: ['/ann'],  label: 'Announce',  emoji: '📢', description: 'Something to share with the team', icon: Megaphone,    entityType: 'note', defaultPriority: 'medium', autoTags: ['announce'],  category: 'creative' },
  { command: '/experiment', aliases: ['/exp'], label: 'Experiment', emoji: '🧪', description: 'Hypothesis to test',             icon: FlaskConical, entityType: 'note', defaultPriority: 'medium', autoTags: ['experiment'], category: 'creative' },
]

const CATEGORY_LABELS: Record<SlashCommand['category'], string> = {
  capture: '⚡ Capture',
  strategic: '♟️ Strategic',
  creative: '🧠 Deep Mind',
}

const NOTE_RULE: CaptureRule = {
  prefix: '',
  label: 'Note',
  icon: NotebookPen,
  entityType: 'note',
  defaultPriority: 'medium',
  autoTags: [],
  hint: 'Capture anything...',
}

export interface ParsedCapture {
  rule: CaptureRule
  cleanText: string
}

/** Match a slash command from input, returns command + remaining text */
function matchSlashCommand(text: string): { cmd: SlashCommand; rest: string } | null {
  const lower = text.toLowerCase()
  for (const cmd of SLASH_COMMANDS) {
    for (const key of [cmd.command, ...cmd.aliases]) {
      if (lower === key || lower.startsWith(key + ' ')) {
        return { cmd, rest: text.slice(key.length).trim() }
      }
    }
  }
  return null
}

/** Convert a SlashCommand to a CaptureRule */
function slashToRule(cmd: SlashCommand): CaptureRule {
  return {
    prefix: cmd.command,
    label: cmd.label,
    icon: cmd.icon,
    entityType: cmd.entityType,
    defaultPriority: cmd.defaultPriority,
    autoTags: cmd.autoTags,
    hint: '',
  }
}

/** Parse raw input text → matched rule + cleaned text */
export function parseCapture(raw: string): ParsedCapture {
  const text = raw.trim()
  if (!text) return { rule: NOTE_RULE, cleanText: '' }

  // Slash commands: /task, /bug, /snippet ...
  const slash = matchSlashCommand(text)
  if (slash) {
    return { rule: slashToRule(slash.cmd), cleanText: slash.rest }
  }

  // Legacy "todo " prefix
  if (text.toLowerCase().startsWith('todo ')) {
    return { rule: CAPTURE_RULES[0], cleanText: text.slice(5).trim() }
  }

  // Quick prefixes: ! ? * @ #
  for (const rule of CAPTURE_RULES) {
    if (text.startsWith(rule.prefix as string)) {
      return { rule, cleanText: text.slice((rule.prefix as string).length).trim() }
    }
  }

  return { rule: NOTE_RULE, cleanText: text }
}

/** Filter slash commands by partial input (for suggestion dropdown). Returns grouped. */
export function filterSlashCommands(input: string): SlashCommand[] {
  const lower = input.toLowerCase()
  if (!lower.startsWith('/')) return []
  if (lower === '/') return SLASH_COMMANDS
  return SLASH_COMMANDS.filter((cmd) =>
    cmd.command.startsWith(lower) ||
    cmd.aliases.some((a) => a.startsWith(lower)) ||
    cmd.label.toLowerCase().startsWith(lower.slice(1))
  )
}

/** Group filtered commands by category for display */
export function groupSlashCommands(commands: SlashCommand[]): { category: string; label: string; commands: SlashCommand[] }[] {
  const groups = new Map<string, SlashCommand[]>()
  for (const cmd of commands) {
    const list = groups.get(cmd.category) ?? []
    list.push(cmd)
    groups.set(cmd.category, list)
  }
  return Array.from(groups.entries()).map(([cat, cmds]) => ({
    category: cat,
    label: CATEGORY_LABELS[cat as SlashCommand['category']] ?? cat,
    commands: cmds,
  }))
}

/** Build placeholder string */
export function capturePlaceholder(): string {
  return '/ commands  !task  ?question  *idea  @goal  #habit'
}

// ─── Note Templates (for per-task note input) ───
// These insert emoji-prefixed text into task/subtask notes.

export interface NoteTemplate {
  command: string
  emoji: string
  label: string
  description: string
  insert: string // text inserted into the note
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  { command: '/action',   emoji: '✅', label: 'Action',   description: 'Action item to follow up',       insert: '✅ ' },
  { command: '/blocker',  emoji: '🚧', label: 'Blocker',  description: 'Something blocking progress',    insert: '🚧 Blocked: ' },
  { command: '/question', emoji: '❓', label: 'Question', description: 'Question to resolve',             insert: '❓ ' },
  { command: '/decision', emoji: '⚖️', label: 'Decision', description: 'Decision made or needed',         insert: '⚖️ Decision: ' },
  { command: '/risk',     emoji: '⚠️', label: 'Risk',     description: 'Risk or concern flagged',         insert: '⚠️ Risk: ' },
  { command: '/idea',     emoji: '💡', label: 'Idea',     description: 'Idea or suggestion',              insert: '💡 ' },
  { command: '/win',      emoji: '🏆', label: 'Win',      description: 'Progress or achievement',         insert: '🏆 ' },
  { command: '/handoff',  emoji: '🤝', label: 'Handoff',  description: 'Hand off to someone',             insert: '🤝 → ' },
  { command: '/deadline', emoji: '⏰', label: 'Deadline', description: 'Time-sensitive note',             insert: '⏰ Due: ' },
  { command: '/context',  emoji: '📎', label: 'Context',  description: 'Background info or reference',    insert: '📎 ' },
  { command: '/update',   emoji: '📡', label: 'Update',   description: 'Status update',                   insert: '📡 ' },
  { command: '/learn',    emoji: '🧠', label: 'Learned',  description: 'Insight or lesson learned',       insert: '🧠 ' },
]

/** Filter note templates by partial input */
export function filterNoteTemplates(input: string): NoteTemplate[] {
  const lower = input.toLowerCase()
  if (!lower.startsWith('/')) return []
  if (lower === '/') return NOTE_TEMPLATES
  return NOTE_TEMPLATES.filter((t) =>
    t.command.startsWith(lower) ||
    t.label.toLowerCase().startsWith(lower.slice(1))
  )
}
