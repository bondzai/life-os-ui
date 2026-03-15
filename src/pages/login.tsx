import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Sparkles, LogIn } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import { generateMockData, clearMockData } from '@/lib/mock-data'
import type { User } from '@/core/types'

const KEY_PREFIX = 'life-os:'

function getStoredMode(): string | null {
  return localStorage.getItem('life-os:data-mode')
}

function isApiMode(): boolean {
  const stored = getStoredMode()
  return stored === 'api' || (stored === null && import.meta.env.VITE_USE_API === 'true')
}

function getUsers(): User[] {
  const raw = localStorage.getItem(`${KEY_PREFIX}users`)
  return raw ? (JSON.parse(raw) as User[]) : []
}

type LoginStep = 'choose' | 'pin' | 'user-select'

export function LoginPage() {
  const [step, setStep] = useState<LoginStep>('choose')
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const loginWithApi = useAuthStore((s) => s.loginWithApi)

  const handleDemo = () => {
    clearMockData()
    generateMockData()
    localStorage.setItem('life-os:data-mode', 'demo')
    // Auto-login as demo user
    const users = getUsers()
    const demoUser = users.find((u) => u.id === 'user-demo') || users[0]
    if (demoUser) {
      login(demoUser)
    }
    navigate('/')
  }

  const handleSignIn = () => {
    if (isApiMode()) {
      setStep('pin')
    } else {
      const users = getUsers()
      if (users.length === 1) {
        setSelectedUser(users[0])
        setStep('pin')
      } else if (users.length > 1) {
        setStep('user-select')
      } else {
        setStep('pin')
      }
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (isApiMode()) {
      setLoading(true)
      try {
        localStorage.setItem('life-os:data-mode', 'api')
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

    if (!selectedUser) return
    if (pin === selectedUser.pin) {
      localStorage.setItem('life-os:data-mode', 'local')
      login(selectedUser)
      navigate('/')
    } else {
      setError('Incorrect PIN')
      setPin('')
    }
  }

  // ── Step 1: Choose mode ──
  if (step === 'choose') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-6 p-4">
          <div className="text-center space-y-2">
            <div className="mx-auto h-16 w-16 rounded-2xl bg-primary flex items-center justify-center text-2xl text-primary-foreground font-bold">
              L
            </div>
            <h1 className="text-2xl font-bold">Life-OS</h1>
            <p className="text-sm text-muted-foreground">Your personal life operating system</p>
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

  // ── Step 2a: User select (local mode, multiple users) ──
  if (step === 'user-select') {
    const users = getUsers()
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-md space-y-6 p-4">
          <div className="text-center">
            <h1 className="text-2xl font-bold">Life-OS</h1>
            <p className="text-sm text-muted-foreground mt-1">Select your account</p>
          </div>
          <div className="grid gap-3">
            {users.map((user) => (
              <Card
                key={user.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => { setSelectedUser(user); setStep('pin') }}
              >
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="h-12 w-12 rounded-full bg-primary flex items-center justify-center text-lg text-primary-foreground font-medium">
                    {user.name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium">{user.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{user.role}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <Button variant="ghost" className="w-full" onClick={() => setStep('choose')}>Back</Button>
        </div>
      </div>
    )
  }

  // ── Step 2b: PIN entry ──
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {isApiMode() ? (
            <>
              <div className="mx-auto h-16 w-16 rounded-2xl bg-primary flex items-center justify-center text-2xl text-primary-foreground font-bold mb-2">
                L
              </div>
              <CardTitle>Life-OS</CardTitle>
            </>
          ) : selectedUser ? (
            <>
              <div className="mx-auto h-16 w-16 rounded-full bg-primary flex items-center justify-center text-2xl text-primary-foreground font-medium mb-2">
                {selectedUser.name.charAt(0)}
              </div>
              <CardTitle>{selectedUser.name}</CardTitle>
            </>
          ) : null}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                type="password"
                inputMode="numeric"
                placeholder="Enter PIN"
                value={pin}
                onChange={(e) => { setPin(e.target.value); setError('') }}
                autoFocus
                maxLength={8}
                className="text-center text-lg tracking-widest"
              />
              {error && <p className="text-sm text-destructive mt-1 text-center">{error}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={() => { setStep('choose'); setPin(''); setError(''); setSelectedUser(null) }}>
              Back
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
