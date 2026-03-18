import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Sparkles, LogIn } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import { generateMockData, clearMockData } from '@/lib/mock-data'
import type { User } from '@/core/types'

const KEY_PREFIX = 'lyra:'

function getStoredMode(): string | null {
  return localStorage.getItem('lyra:data-mode')
}

function isApiMode(): boolean {
  const stored = getStoredMode()
  return stored === 'api' || (stored === null && import.meta.env.VITE_USE_API === 'true')
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
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const loginWithApi = useAuthStore((s) => s.loginWithApi)

  const handleDemo = () => {
    clearMockData()
    generateMockData()
    localStorage.setItem('lyra:data-mode', 'demo')
    // Auto-login as demo user
    const users = getUsers()
    const demoUser = users.find((u) => u.id === 'user-demo') || users[0]
    if (demoUser) {
      login(demoUser)
    }
    navigate('/')
  }

  const [username, setUsername] = useState('')

  const handleSignIn = () => {
    // Reset users to defaults (clear demo user or bcrypt hashes)
    localStorage.setItem(`${KEY_PREFIX}users`, JSON.stringify(DEFAULT_USERS))
    setStep('pin')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (isApiMode()) {
      setLoading(true)
      try {
        localStorage.setItem('lyra:data-mode', 'api')
        await loginWithApi(pin)
        navigate('/')
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Login failed')
        setPin('')
      } finally {
        setLoading(false)
      }
      return
    }

    // Local mode: match by name + pin
    const users = getUsers()
    const trimmedName = username.trim().toLowerCase()
    const matched = users.find(
      (u) => u.name.toLowerCase() === trimmedName && u.pin === pin,
    )
    if (matched) {
      localStorage.setItem('lyra:data-mode', 'local')
      login(matched)
      navigate('/')
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
                  <p className="text-xs text-muted-foreground">Log in with your PIN</p>
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
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {!isApiMode() && (
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
              autoFocus={isApiMode()}
              maxLength={8}
              className="text-center text-lg tracking-widest"
            />
            {error && <p className="text-sm text-destructive mt-1 text-center">{error}</p>}
            <Button type="submit" className="w-full" disabled={loading || (!isApiMode() && !username.trim()) || !pin}>
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
