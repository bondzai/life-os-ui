import { useEffect, useState } from 'react'
import { Sparkles, LogIn } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import { generateMockData, clearMockData } from '@/lib/mock-data'
import { API_URL } from '@/lib/api-url'
import type { User } from '@/core/types'

const KEY_PREFIX = 'lyra:'

type DataMode = 'api' | 'local' | 'demo'

/**
 * Land in the app with the chosen mode actually in force.
 *
 * A full page load, **not** `navigate()`. `USE_API` and every repository built from it are
 * module-level constants, read once when the bundle first ran — so a client-side transition
 * leaves the session bound to whatever mode was in effect *before* the sign-in. That is how
 * signing in as JB produced mock balances against a perfectly healthy API. `setDataMode` in
 * Settings has always reloaded for exactly this reason.
 */
function enter(mode: DataMode): void {
  localStorage.setItem('lyra:data-mode', mode)
  window.location.href = '/'
}

const DEFAULT_USERS: User[] = [
  { id: 'user-jb', name: 'JB', role: 'admin', pin: '1234' },
  { id: 'user-sunny', name: 'Sunny', role: 'member', pin: '5678' },
]

function getUsers(): User[] {
  const raw = localStorage.getItem(`${KEY_PREFIX}users`)
  if (raw) {
    const users = JSON.parse(raw) as User[]
    // Fix: if PINs are bcrypt hashes (from API seed), reset to plain PINs
    const hasBcrypt = users.some((u) => u.pin && u.pin.startsWith('$2'))
    if (hasBcrypt) {
      localStorage.setItem(`${KEY_PREFIX}users`, JSON.stringify(DEFAULT_USERS))
      return DEFAULT_USERS
    }
    return users
  }
  localStorage.setItem(`${KEY_PREFIX}users`, JSON.stringify(DEFAULT_USERS))
  return DEFAULT_USERS
}

type LoginStep = 'choose' | 'pin'

export function LoginPage() {
  const [step, setStep] = useState<LoginStep>('choose')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const login = useAuthStore((s) => s.login)
  const loginWithApi = useAuthStore((s) => s.loginWithApi)

  /**
   * Whether the backend is actually up. `null` while the probe is in flight.
   *
   * **Probed, not configured.** This used to read `VITE_USE_API`, a build-time flag — so on a
   * box whose server was running perfectly, a fresh browser still took the local branch, wrote
   * `data-mode: local`, and served mock balances. Worse, `logout` left that mode behind, so
   * signing out and back in could never escape it. A self-hosted box either has its server
   * running or it does not; that is a question to ask at sign-in, not to rebuild the bundle for.
   */
  const [apiUp, setApiUp] = useState<boolean | null>(null)

  useEffect(() => {
    const abort = new AbortController()
    let live = true
    fetch(`${API_URL}/health`, { signal: abort.signal })
      .then((res) => { if (live) setApiUp(res.ok) })
      .catch(() => { if (live) setApiUp(false) })
    return () => { live = false; abort.abort() }
  }, [])

  const useApi = apiUp === true

  const handleDemo = () => {
    clearMockData()
    generateMockData()
    // Auto-login as demo user
    const users = getUsers()
    const demoUser = users.find((u) => u.id === 'user-demo') || users[0]
    if (demoUser) {
      login(demoUser)
    }
    enter('demo')
  }

  const [username, setUsername] = useState('')

  const handleSignIn = () => {
    // Reset users to defaults (clear demo user or bcrypt hashes)
    localStorage.setItem(`${KEY_PREFIX}users`, JSON.stringify(DEFAULT_USERS))
    setStep('pin')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (useApi) {
      setLoading(true)
      try {
        await loginWithApi(pin)
        enter('api')
      } catch (err) {
        // The server answered and said no — staying here with the reason beats falling back to
        // a local session that would quietly show different numbers for the same PIN.
        setError(err instanceof Error ? err.message : 'Login failed')
        setPin('')
        setLoading(false)
      }
      return
    }

    // No server reachable: browser-local storage, matched by name + pin.
    const users = getUsers()
    const trimmedName = username.trim().toLowerCase()
    const matched = users.find(
      (u) => u.name.toLowerCase() === trimmedName && u.pin === pin,
    )
    if (matched) {
      login(matched)
      enter('local')
    } else {
      setError('Invalid name or PIN')
      setPin('')
    }
  }

  // ── Step 1: Choose mode ──
  if (step === 'choose') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-6 p-4">
          <div className="text-center space-y-3">
            <div className="mx-auto h-16 w-16 rounded-2xl flex items-center justify-center" style={{ background: '#0f172a' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                <g stroke="#94a3b8" strokeWidth="0.6" opacity="0.4">
                  <line x1="12" y1="3" x2="8.5" y2="7.5"/>
                  <line x1="12" y1="3" x2="15.5" y2="7.5"/>
                  <line x1="8.5" y1="7.5" x2="8" y2="14"/>
                  <line x1="15.5" y1="7.5" x2="16" y2="14"/>
                  <line x1="8" y1="14" x2="9.5" y2="19.5"/>
                  <line x1="16" y1="14" x2="14.5" y2="19.5"/>
                  <line x1="9.5" y1="19.5" x2="14.5" y2="19.5"/>
                </g>
                <circle cx="12" cy="3" r="1.8" fill="#60a5fa"/>
                <circle cx="8.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
                <circle cx="15.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
                <circle cx="8" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
                <circle cx="16" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
                <circle cx="9.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
                <circle cx="14.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Lyra</h1>
              <p className="text-sm text-muted-foreground">Navigate your life by the stars</p>
            </div>
          </div>

          <div className="grid gap-3">
            <Card
              className="cursor-pointer hover:bg-accent/50 transition-colors border-2 border-transparent hover:border-primary/20"
              onClick={handleDemo}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center">
                  <Sparkles className="h-6 w-6 text-white" />
                </div>
                <div>
                  <p className="font-medium">Try Demo</p>
                  <p className="text-xs text-muted-foreground">Explore with sample data — no account needed</p>
                </div>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer hover:bg-accent/50 transition-colors border-2 border-transparent hover:border-primary/20"
              onClick={handleSignIn}
            >
              <CardContent className="flex items-center gap-4 p-4">
                <div className="h-12 w-12 rounded-full bg-primary flex items-center justify-center">
                  <LogIn className="h-6 w-6 text-primary-foreground" />
                </div>
                <div>
                  <p className="font-medium">Sign In</p>
                  {/* Which store you are about to land in, answered before the PIN rather than
                      discovered afterwards by noticing the balances are invented. */}
                  <p className="text-xs text-muted-foreground">
                    {apiUp === null
                      ? 'Log in with your PIN'
                      : apiUp
                        ? 'Your live server — real balances'
                        : 'Server offline — this browser only'}
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    )
  }

  // ── Step 2: Sign In form (name + PIN) ──
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto h-16 w-16 rounded-2xl flex items-center justify-center mb-2" style={{ background: '#0f172a' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
              <g stroke="#94a3b8" strokeWidth="0.6" opacity="0.4">
                <line x1="12" y1="3" x2="8.5" y2="7.5"/>
                <line x1="12" y1="3" x2="15.5" y2="7.5"/>
                <line x1="8.5" y1="7.5" x2="8" y2="14"/>
                <line x1="15.5" y1="7.5" x2="16" y2="14"/>
                <line x1="8" y1="14" x2="9.5" y2="19.5"/>
                <line x1="16" y1="14" x2="14.5" y2="19.5"/>
                <line x1="9.5" y1="19.5" x2="14.5" y2="19.5"/>
              </g>
              <circle cx="12" cy="3" r="1.8" fill="#60a5fa"/>
              <circle cx="8.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
              <circle cx="15.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
              <circle cx="8" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
              <circle cx="16" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
              <circle cx="9.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
              <circle cx="14.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
            </svg>
          </div>
          <CardTitle>Sign In</CardTitle>
          <p className="text-xs text-muted-foreground">
            {apiUp === null
              ? 'Checking for your server…'
              : apiUp
                ? 'Signing in to your live server'
                : 'No server reachable — signing in to this browser only'}
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!useApi && (
              <Input
                type="text"
                placeholder="Name"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError('') }}
                autoFocus
                className="text-center"
              />
            )}
            <Input
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError('') }}
              autoFocus={useApi}
              maxLength={8}
              className="text-center text-lg tracking-widest"
            />
            {error && <p className="text-sm text-destructive mt-1 text-center">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || (!useApi && !username.trim()) || !pin}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => { setStep('choose'); setPin(''); setUsername(''); setError('') }}>
              Back
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
