import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/auth-store'
import type { User } from '@/core/types'

const KEY_PREFIX = 'life-os:'
const USE_API = import.meta.env.VITE_USE_API === 'true'

function getUsers(): User[] {
  const raw = localStorage.getItem(`${KEY_PREFIX}users`)
  return raw ? (JSON.parse(raw) as User[]) : []
}

export function LoginPage() {
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)
  const loginWithApi = useAuthStore((s) => s.loginWithApi)
  const users = getUsers()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (USE_API) {
      setLoading(true)
      try {
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
      login(selectedUser)
      navigate('/')
    } else {
      setError('Incorrect PIN')
      setPin('')
    }
  }

  if (!USE_API && !selectedUser) {
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
                onClick={() => setSelectedUser(user)}
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
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          {USE_API ? (
            <>
              <div className="mx-auto h-16 w-16 rounded-full bg-primary flex items-center justify-center text-2xl text-primary-foreground font-medium mb-2">
                L
              </div>
              <CardTitle>Life-OS</CardTitle>
            </>
          ) : (
            <>
              <div className="mx-auto h-16 w-16 rounded-full bg-primary flex items-center justify-center text-2xl text-primary-foreground font-medium mb-2">
                {selectedUser!.name.charAt(0)}
              </div>
              <CardTitle>{selectedUser!.name}</CardTitle>
            </>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Input
                type="password"
                inputMode="numeric"
                placeholder="Enter PIN"
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value)
                  setError('')
                }}
                autoFocus
                maxLength={8}
                className="text-center text-lg tracking-widest"
              />
              {error && <p className="text-sm text-destructive mt-1 text-center">{error}</p>}
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign In'}
            </Button>
            {!USE_API && (
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setSelectedUser(null)
                  setPin('')
                  setError('')
                }}
              >
                Back
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
