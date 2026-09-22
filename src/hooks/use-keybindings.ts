import { useState, useCallback, useEffect } from 'react'
import { isTypingTarget } from '@/lib/utils'

// ─── Types ───

export interface KeyCombo {
  key: string        // e.g. 'k', 'f', 'b', 'p'
  meta?: boolean     // Cmd (Mac) / Ctrl (Win)
  shift?: boolean
  alt?: boolean
}

export interface KeybindingAction {
  id: string
  label: string
  description: string
  defaultCombo: KeyCombo
}

export interface KeybindingConfig {
  [actionId: string]: KeyCombo
}

// ─── Actions registry ───

export const ACTIONS: KeybindingAction[] = [
  { id: 'command-bar',   label: 'Command Bar',    description: 'Open search & command palette', defaultCombo: { key: 'k', meta: true } },
  { id: 'focus-mode',    label: 'Focus Mode',     description: 'Toggle sidebar & top bar',      defaultCombo: { key: 'f', meta: true, shift: true } },
  { id: 'briefing',      label: 'Briefing',       description: 'Open standup briefing',         defaultCombo: { key: 'b', meta: true, shift: true } },
  { id: 'quick-capture', label: 'Quick Capture',  description: 'Open inbox capture',            defaultCombo: { key: 'i', meta: true, shift: true } },
  { id: 'deep-work',     label: 'Deep Work',      description: 'Go to Emperor Time',            defaultCombo: { key: 'd', meta: true, shift: true } },
]

// ─── OS conflict detection ───

const OS_CONFLICTS: { combo: string; description: string }[] = [
  // macOS
  { combo: 'meta+c', description: 'Copy (OS)' },
  { combo: 'meta+v', description: 'Paste (OS)' },
  { combo: 'meta+x', description: 'Cut (OS)' },
  { combo: 'meta+z', description: 'Undo (OS)' },
  { combo: 'meta+shift+z', description: 'Redo (OS)' },
  { combo: 'meta+a', description: 'Select All (OS)' },
  { combo: 'meta+s', description: 'Save (OS/Browser)' },
  { combo: 'meta+w', description: 'Close Tab (Browser)' },
  { combo: 'meta+t', description: 'New Tab (Browser)' },
  { combo: 'meta+n', description: 'New Window (Browser)' },
  { combo: 'meta+q', description: 'Quit (OS)' },
  { combo: 'meta+h', description: 'Hide Window (OS)' },
  { combo: 'meta+m', description: 'Minimize (OS)' },
  { combo: 'meta+l', description: 'Address Bar (Browser)' },
  { combo: 'meta+r', description: 'Reload (Browser)' },
  { combo: 'meta+shift+t', description: 'Reopen Tab (Browser)' },
  { combo: 'meta+shift+n', description: 'Incognito (Browser)' },
  { combo: 'meta+shift+i', description: 'DevTools (Browser)' },
  { combo: 'meta+shift+j', description: 'Downloads (Browser)' },
  { combo: 'meta+shift+r', description: 'Hard Reload (Browser)' },
  { combo: 'meta+p', description: 'Print (Browser)' },
  { combo: 'meta+f', description: 'Find (Browser)' },
  // Common alt combos
  { combo: 'alt+tab', description: 'Switch App (OS)' },
]

export function comboToString(combo: KeyCombo): string {
  const parts: string[] = []
  if (combo.meta) parts.push('meta')
  if (combo.alt) parts.push('alt')
  if (combo.shift) parts.push('shift')
  parts.push(combo.key.toLowerCase())
  return parts.join('+')
}

export function comboToDisplay(combo: KeyCombo): string {
  const isMac = navigator.platform.includes('Mac')
  const parts: string[] = []
  if (combo.meta) parts.push(isMac ? '⌘' : 'Ctrl')
  if (combo.alt) parts.push(isMac ? '⌥' : 'Alt')
  if (combo.shift) parts.push('⇧')
  parts.push(combo.key.toUpperCase())
  return parts.join('')
}

export function checkConflict(combo: KeyCombo): string | null {
  const str = comboToString(combo)
  const conflict = OS_CONFLICTS.find((c) => c.combo === str)
  return conflict ? conflict.description : null
}

function eventMatchesCombo(e: KeyboardEvent, combo: KeyCombo): boolean {
  if (combo.meta && !(e.metaKey || e.ctrlKey)) return false
  if (!combo.meta && (e.metaKey || e.ctrlKey)) return false
  if (combo.shift && !e.shiftKey) return false
  if (!combo.shift && e.shiftKey) return false
  if (combo.alt && !e.altKey) return false
  if (!combo.alt && e.altKey) return false
  return e.key.toLowerCase() === combo.key.toLowerCase()
}

// ─── Storage ───

const STORAGE_KEY = 'lyra:keybindings'

function loadConfig(): KeybindingConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw)
  } catch { /* */ }
  return {}
}

function saveConfig(config: KeybindingConfig) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

// ─── Hook ───

export function useKeybindings() {
  const [config, setConfigState] = useState<KeybindingConfig>(loadConfig)

  const getCombo = useCallback((actionId: string): KeyCombo => {
    if (config[actionId]) return config[actionId]
    const action = ACTIONS.find((a) => a.id === actionId)
    return action?.defaultCombo ?? { key: '?', meta: true }
  }, [config])

  const setCombo = useCallback((actionId: string, combo: KeyCombo) => {
    const next = { ...config, [actionId]: combo }
    setConfigState(next)
    saveConfig(next)
  }, [config])

  const resetAll = useCallback(() => {
    setConfigState({})
    localStorage.removeItem(STORAGE_KEY)
  }, [])

  return { config, getCombo, setCombo, resetAll }
}

/** Global shortcut listener — call in app layout */
export function useGlobalShortcuts(handlers: Record<string, () => void>) {
  const { getCombo } = useKeybindings()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in inputs
      const isInput = isTypingTarget(e.target)

      for (const actionId of Object.keys(handlers)) {
        const combo = getCombo(actionId)
        if (eventMatchesCombo(e, combo)) {
          // command-bar works even in inputs
          if (actionId !== 'command-bar' && isInput) continue
          e.preventDefault()
          handlers[actionId]()
          return
        }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [getCombo, handlers])
}
