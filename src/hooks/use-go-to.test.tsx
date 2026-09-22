/**
 * `g`-then-letter navigation.
 *
 * Two things can go wrong silently and neither throws: the window staying armed so a stray `g`
 * eats the next letter you type, and `g g` failing because arming and dispatching were written as
 * one branch. Both are pinned here.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useGoTo } from './use-go-to'

function Harness() {
  useGoTo()
  return (
    <Routes>
      <Route path="/" element={<p>focus</p>} />
      <Route path="/tasks" element={<p>tasks</p>} />
      <Route path="/goals" element={<p>goals</p>} />
      <Route path="/wealth" element={<p>wealth</p>} />
    </Routes>
  )
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Harness />
    </MemoryRouter>,
  )
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

describe('useGoTo', () => {
  it('jumps on g then a letter', () => {
    mount()
    fireEvent.keyDown(document, { key: 'g' })
    fireEvent.keyDown(document, { key: 't' })
    expect(screen.getByText('tasks')).toBeDefined()
  })

  it('handles g g, where the destination letter is also the arming key', () => {
    mount()
    fireEvent.keyDown(document, { key: 'g' })
    fireEvent.keyDown(document, { key: 'g' })
    expect(screen.getByText('goals')).toBeDefined()
  })

  it('disarms, so a stray g does not hijack the next letter a minute later', () => {
    mount()
    fireEvent.keyDown(document, { key: 'g' })
    vi.advanceTimersByTime(2000)
    fireEvent.keyDown(document, { key: 'w' })
    expect(screen.getByText('focus')).toBeDefined()
  })

  it('stays out of the way while you are typing', () => {
    mount()
    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'g' })
    fireEvent.keyDown(input, { key: 't' })
    expect(screen.getByText('focus')).toBeDefined()
    input.remove()
  })

  it('ignores a letter that belongs to no module', () => {
    mount()
    fireEvent.keyDown(document, { key: 'g' })
    fireEvent.keyDown(document, { key: 'z' })
    expect(screen.getByText('focus')).toBeDefined()
  })
})
