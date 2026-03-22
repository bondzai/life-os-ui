import { useState, useCallback, useEffect } from 'react'

export interface StrategicMove {
  id: string
  type: 'commit' | 'pivot' | 'park' | 'double-down' | 'explore' | 'connect' | 'decide'
  title: string
  reasoning: string
  impact: 'high' | 'medium'
  effort: 'low' | 'medium' | 'high'
  timeframe: string
  tags: string[]
  status: 'suggested' | 'accepted' | 'passed' | 'completed'
  createdAt: string
}

const STORAGE_KEY = 'lyra:strategic-moves'
const MAX_HISTORY = 30

function loadMoves(): StrategicMove[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveMoves(moves: StrategicMove[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(moves.slice(0, MAX_HISTORY)))
}

export function useStrategicMoves() {
  const [moves, setMovesState] = useState<StrategicMove[]>(loadMoves)

  // Sync state to localStorage
  useEffect(() => {
    saveMoves(moves)
  }, [moves])

  const setMoves = useCallback((newMoves: StrategicMove[]) => {
    setMovesState((prev) => {
      // Prepend new moves, keep history capped
      const combined = [...newMoves, ...prev]
      return combined.slice(0, MAX_HISTORY)
    })
  }, [])

  const updateMoveStatus = useCallback(
    (id: string, status: StrategicMove['status']) => {
      setMovesState((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)))
    },
    [],
  )

  const acceptMove = useCallback(
    (id: string) => updateMoveStatus(id, 'accepted'),
    [updateMoveStatus],
  )

  const passMove = useCallback(
    (id: string) => updateMoveStatus(id, 'passed'),
    [updateMoveStatus],
  )

  const completeMove = useCallback(
    (id: string) => updateMoveStatus(id, 'completed'),
    [updateMoveStatus],
  )

  const suggested = moves.filter((m) => m.status === 'suggested')
  const accepted = moves.filter((m) => m.status === 'accepted')
  const history = moves.filter((m) => m.status === 'passed' || m.status === 'completed')

  return { moves, suggested, accepted, history, setMoves, acceptMove, passMove, completeMove }
}
