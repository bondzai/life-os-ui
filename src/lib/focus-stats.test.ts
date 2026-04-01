import { describe, it, expect } from 'vitest'
import { formatMinutes } from './focus-stats'

describe('formatMinutes', () => {
  it('formats minutes only', () => expect(formatMinutes(45)).toBe('45m'))
  it('formats hours and minutes', () => expect(formatMinutes(90)).toBe('1h 30m'))
  it('formats zero', () => expect(formatMinutes(0)).toBe('0m'))
  it('formats exact hours', () => expect(formatMinutes(120)).toBe('2h'))
})
