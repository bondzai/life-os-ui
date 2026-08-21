/**
 * Wealth · Wallets — which addresses the book is built from.
 *
 * The list used to be `ALERT_WALLETS` on the server and a browser-local list in the old app, so
 * adding a cold-storage Bitcoin address meant editing an env file and restarting. It is server
 * state now, and the environment is only the seed: an empty list means `ALERT_WALLETS` still
 * owns it, and adding one address here takes over completely.
 *
 * Every chain the fan-out can read is accepted — EVM, Bitcoin, Solana — and the server rejects
 * anything else, so a typo cannot become a wallet that silently contributes nothing.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bitcoin, Link2, Plus, Trash2, Wallet as WalletIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { RowsSkeleton, WealthError } from './states'
import type { WalletEntry } from './types'

const KIND: Record<WalletEntry['kind'], { icon: typeof Link2; label: string; tone: string }> = {
  evm: { icon: Link2, label: 'EVM', tone: 'text-sky-600 dark:text-sky-400' },
  bitcoin: { icon: Bitcoin, label: 'Bitcoin', tone: 'text-amber-600 dark:text-amber-500' },
  solana: { icon: WalletIcon, label: 'Solana', tone: 'text-violet-600 dark:text-violet-400' },
}

/** Long enough to recognise, short enough to sit on one line next to a label. */
function shorten(address: string): string {
  return address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address
}

export function WalletList() {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')

  const list = useQuery({
    queryKey: ['wealth', 'wallets'],
    queryFn: () => apiWealthRepository.getWallets(),
    enabled: USE_API,
    retry: false,
  })

  /** Changing the address list changes every number on every wealth page. */
  const settle = (title: string) => {
    void queryClient.invalidateQueries({ queryKey: ['wealth'] })
    setAdding(false)
    setAddress('')
    setLabel('')
    notify({ title, type: 'success' })
  }

  const add = useMutation({
    mutationFn: () => apiWealthRepository.addWallet(address.trim(), label.trim() || undefined),
    onSuccess: () => settle('Wallet added — recounting the book'),
    onError: (e: Error) => notify({ title: 'Could not add it', message: e.message, type: 'error' }),
  })
  const remove = useMutation({
    mutationFn: (id: string) => apiWealthRepository.removeWallet(id),
    onSuccess: () => settle('Wallet removed'),
    onError: (e: Error) => notify({ title: 'Could not remove it', message: e.message, type: 'error' }),
  })

  if (!USE_API) return null

  const wallets = list.data?.wallets ?? []
  const fromEnv = list.data?.source === 'env'
  const effective = list.data?.effective ?? []

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Wallets</CardTitle>
          <p className="text-xs text-muted-foreground">
            Every address the book is counted from — EVM, Bitcoin or Solana.
          </p>
        </div>
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-4" /> Add
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {adding && (
          <form
            className="space-y-3 rounded-md border bg-muted/30 p-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (address.trim()) add.mutate()
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
              <div className="space-y-1.5">
                <Label htmlFor="wallet-address">Address</Label>
                <Input
                  id="wallet-address"
                  value={address}
                  autoFocus
                  spellCheck={false}
                  placeholder="0x… or bc1…"
                  className="font-mono text-xs"
                  onChange={(e) => setAddress(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wallet-label">Label</Label>
                <Input
                  id="wallet-label"
                  value={label}
                  placeholder="cold, trading…"
                  onChange={(e) => setLabel(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={add.isPending || !address.trim()}>
                {add.isPending ? 'Checking…' : 'Add wallet'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                <X className="size-4" /> Cancel
              </Button>
            </div>
          </form>
        )}

        {list.isLoading && <RowsSkeleton rows={2} />}
        {list.error && (
          <WealthError
            detail={(list.error as Error).message}
            onRetry={() => void list.refetch()}
          />
        )}

        {/* An env-owned list is not "no wallets" — saying which it is stops someone adding a
            duplicate of an address that is already being counted. */}
        {fromEnv && (
          <div className="rounded-md border border-dashed px-3 py-3 text-sm">
            <p className="text-muted-foreground">
              {effective.length > 0 ? (
                <>
                  Counting <span className="font-medium text-foreground">{effective.length}</span>{' '}
                  address{effective.length === 1 ? '' : 'es'} from <code>ALERT_WALLETS</code>. Add one
                  here and this list takes over.
                </>
              ) : (
                <>No wallets configured. Add an address to start counting a book.</>
              )}
            </p>
            {effective.length > 0 && (
              <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted-foreground">
                {effective.map((a) => (
                  <li key={a}>{shorten(a)}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {wallets.map((wallet) => {
          const kind = KIND[wallet.kind]
          const Icon = kind.icon
          return (
            <div
              key={wallet.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-3">
                <Icon className={cn('size-4 shrink-0', kind.tone)} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {wallet.label ?? kind.label}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {shorten(wallet.address)}
                  </p>
                </div>
              </div>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Remove ${wallet.label ?? wallet.address}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(wallet.id)}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
