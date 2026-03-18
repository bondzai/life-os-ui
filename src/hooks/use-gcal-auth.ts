import { useState, useEffect, useCallback } from 'react'
import { API_URL } from '@/lib/api-url'

function getToken(): string | null {
  return localStorage.getItem('lyra:token')
}

function authHeaders(): Record<string, string> {
  const token = getToken()
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' }
}

interface GCalEventInput {
  calendarId?: string
  summary: string
  description?: string
  location?: string
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  colorId?: string
}

interface GCalEventUpdate {
  calendarId?: string
  summary?: string
  description?: string
  location?: string
  start?: { dateTime: string; timeZone: string }
  end?: { dateTime: string; timeZone: string }
  colorId?: string
}

export function useGCalAuth() {
  const [isConnected, setIsConnected] = useState(false)
  const [calendarId, setCalendarId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/gcal/auth/status`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = await res.json()
        setIsConnected(data.connected)
        setCalendarId(data.calendarId)
      }
    } catch {
      // Silently fail — user not connected
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  // Check URL params for callback result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const googleParam = params.get('google')
    if (googleParam) {
      // Clean the URL
      const url = new URL(window.location.href)
      url.searchParams.delete('google')
      window.history.replaceState({}, '', url.pathname + url.search)

      if (googleParam === 'connected') {
        checkStatus()
      }
    }
  }, [checkStatus])

  const connect = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/gcal/auth/url`, {
        headers: authHeaders(),
      })
      if (res.ok) {
        const data = await res.json()
        window.location.href = data.url
      }
    } catch {
      // Failed to get auth URL
    }
  }, [])

  const disconnect = useCallback(async () => {
    try {
      await fetch(`${API_URL}/gcal/auth/disconnect`, {
        method: 'DELETE',
        headers: authHeaders(),
      })
      setIsConnected(false)
      setCalendarId(null)
    } catch {
      // Failed to disconnect
    }
  }, [])

  const createEvent = useCallback(async (event: GCalEventInput) => {
    const res = await fetch(`${API_URL}/gcal/events`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(event),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to create event')
    }
    return res.json()
  }, [])

  const updateEvent = useCallback(async (eventId: string, event: GCalEventUpdate) => {
    const res = await fetch(`${API_URL}/gcal/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(event),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to update event')
    }
    return res.json()
  }, [])

  const deleteEvent = useCallback(async (eventId: string, eventCalendarId?: string) => {
    const params = eventCalendarId ? `?calendarId=${encodeURIComponent(eventCalendarId)}` : ''
    const res = await fetch(`${API_URL}/gcal/events/${encodeURIComponent(eventId)}${params}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || 'Failed to delete event')
    }
    return res.json()
  }, [])

  return {
    isConnected,
    calendarId,
    loading,
    connect,
    disconnect,
    createEvent,
    updateEvent,
    deleteEvent,
    refresh: checkStatus,
  }
}
