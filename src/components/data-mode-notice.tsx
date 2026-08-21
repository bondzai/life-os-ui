/**
 * "You are not looking at your real data."
 *
 * The session's data mode is sticky: it is written at sign-in and survives every reload. That is
 * fine until a session is *stranded* — signed in under `local` or `demo` on a box whose server is
 * now running. Nothing on screen said so, so the wealth pages showed a $225.7K mock portfolio to
 * someone whose actual book was $476, and a hard refresh could not fix it because a signed-in
 * session never passes the login screen again.
 *
 * The bar shows only when both halves are true — not live, and a live server is answering. In a
 * genuine demo, or with no backend running, there is nothing useful to offer and it stays hidden.
 */

import { useEffect, useState } from 'react'
import { FlaskConical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { USE_API } from '@/core/repositories'
import { API_URL } from '@/lib/api-url'

export function DataModeNotice() {
  const [serverUp, setServerUp] = useState(false)

  useEffect(() => {
    if (USE_API) return
    const abort = new AbortController()
    let live = true
    fetch(`${API_URL}/health`, { signal: abort.signal })
      .then((res) => { if (live) setServerUp(res.ok) })
      .catch(() => {})
    return () => { live = false; abort.abort() }
  }, [])

  if (USE_API || !serverUp) return null

  /**
   * Switch to live, which means signing in to the server.
   *
   * A local or demo session holds no server credentials, so it is dropped here rather than
   * carried across — otherwise the first API call 401s and bounces to the login screen anyway,
   * from a page that briefly claimed to be showing real money.
   *
   * A full load, not a route change: `USE_API` and every repository built from it are captured
   * when the bundle first runs, so nothing would actually switch without one.
   */
  const goLive = () => {
    localStorage.setItem('lyra:data-mode', 'api')
    localStorage.removeItem('lyra:token')
    localStorage.removeItem('lyra:auth')
    window.location.href = '/login'
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm">
      <FlaskConical className="size-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="font-medium text-amber-700 dark:text-amber-500">Sample data</span>
      <span className="text-muted-foreground">
        These numbers are invented. Your server is running — sign in to it to see your real book.
      </span>
      <Button size="sm" variant="outline" className="ml-auto" onClick={goLive}>
        Use live data
      </Button>
    </div>
  )
}
