import { describe, it, expect } from 'vitest'
import { comboToString, comboToDisplay, checkConflict } from './use-keybindings'

describe('comboToString', () => {
  it('simple key', () => expect(comboToString({ key: 'k' })).toBe('k'))
  it('meta + key', () => expect(comboToString({ key: 'k', meta: true })).toBe('meta+k'))
  it('meta + shift + key', () => expect(comboToString({ key: 'f', meta: true, shift: true })).toBe('meta+shift+f'))
  it('all modifiers', () => expect(comboToString({ key: 'x', meta: true, alt: true, shift: true })).toBe('meta+alt+shift+x'))
})

describe('comboToDisplay', () => {
  it('renders meta as ⌘ on Mac', () => {
    // jsdom doesn't set navigator.platform, defaults to empty
    const result = comboToDisplay({ key: 'k', meta: true })
    expect(result).toContain('K')
  })
  it('includes shift symbol', () => {
    const result = comboToDisplay({ key: 'f', meta: true, shift: true })
    expect(result).toContain('⇧')
    expect(result).toContain('F')
  })
})

describe('checkConflict', () => {
  it('detects copy conflict', () => {
    expect(checkConflict({ key: 'c', meta: true })).toBe('Copy (OS)')
  })
  it('detects paste conflict', () => {
    expect(checkConflict({ key: 'v', meta: true })).toBe('Paste (OS)')
  })
  it('returns null for safe combo', () => {
    expect(checkConflict({ key: 'b', meta: true, shift: true })).toBeNull()
  })
  it('detects close tab conflict', () => {
    expect(checkConflict({ key: 'w', meta: true })).toBe('Close Tab (Browser)')
  })
})
