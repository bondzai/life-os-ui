import { describe, it, expect } from 'vitest'
import { parseCapture, filterSlashCommands, capturePlaceholder } from './capture-protocol'

describe('parseCapture', () => {
  it('default to note for empty', () => {
    const { rule } = parseCapture('')
    expect(rule.entityType).toBe('note')
  })

  it('parses ! prefix as task', () => {
    const { rule, cleanText } = parseCapture('!fix login bug')
    expect(rule.entityType).toBe('task')
    expect(cleanText).toBe('fix login bug')
  })

  it('parses @ prefix as goal', () => {
    const { rule, cleanText } = parseCapture('@ship v3 by June')
    expect(rule.entityType).toBe('goal')
    expect(cleanText).toBe('ship v3 by June')
  })

  it('parses # prefix as habit', () => {
    const { rule, cleanText } = parseCapture('#meditate 10min')
    expect(rule.entityType).toBe('habit')
    expect(cleanText).toBe('meditate 10min')
  })

  it('parses ? prefix as question note', () => {
    const { rule, cleanText } = parseCapture('?why is deploy slow')
    expect(rule.entityType).toBe('note')
    expect(rule.autoTags).toContain('question')
    expect(cleanText).toBe('why is deploy slow')
  })

  it('parses * prefix as idea note', () => {
    const { rule } = parseCapture('*new dashboard')
    expect(rule.entityType).toBe('note')
    expect(rule.autoTags).toContain('idea')
  })

  it('parses /task command', () => {
    const { rule, cleanText } = parseCapture('/task buy groceries')
    expect(rule.entityType).toBe('task')
    expect(cleanText).toBe('buy groceries')
  })

  it('parses /bug command with tag', () => {
    const { rule } = parseCapture('/bug login crash')
    expect(rule.entityType).toBe('task')
    expect(rule.autoTags).toContain('bug')
  })

  it('parses /goal command', () => {
    const { rule } = parseCapture('/goal learn rust')
    expect(rule.entityType).toBe('goal')
  })

  it('defaults plain text to note', () => {
    const { rule, cleanText } = parseCapture('random thought')
    expect(rule.entityType).toBe('note')
    expect(cleanText).toBe('random thought')
  })
})

describe('filterSlashCommands', () => {
  it('returns empty for non-slash input', () => {
    expect(filterSlashCommands('hello')).toEqual([])
  })

  it('returns all for bare slash', () => {
    expect(filterSlashCommands('/').length).toBeGreaterThan(0)
  })

  it('filters by prefix', () => {
    const results = filterSlashCommands('/ta')
    expect(results.some((r) => r.command === '/task')).toBe(true)
  })
})

describe('capturePlaceholder', () => {
  it('returns non-empty string', () => {
    expect(capturePlaceholder()).toBeTruthy()
  })
})
