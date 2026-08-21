/**
 * Wealth · Off-chain assets — the book the chain cannot see.
 *
 * Cold-storage BTC, metals, a bank balance. These lived in `localStorage` until 2026-08-21, which
 * meant one device, no backup, and a server-side net-worth snapshot that could never agree with
 * the browser's. They are server state now, and this is where they are entered.
 *
 * `value` is kept in the asset's own denomination with `ccy` naming it, never pre-converted: the
 * USD figure is derived from live rates at read time, so a rate move is a rate move rather than a
 * silent edit to what you own.
 */

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Coins, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { notify } from '@/lib/notify'
import { manualUsd } from './derive'
import { formatAmount, formatUsd } from './format'
import { RowsSkeleton, WealthError } from './states'
import type { Currency, ManualAsset, ManualAssetInput, Tier } from './types'
import { useWealth, WEALTH_SOURCE } from './use-wealth'

const TIERS: Tier[] = ['store', 'business', 'trading']
const CURRENCIES: Currency[] = ['usd', 'thb', 'sats']

const TIER_HINT: Record<Tier, string> = {
  store: 'Long-term store of value',
  business: 'Working capital and yield',
  trading: 'Active positions',
}

/** The form's own state. Numbers stay strings until submit — see [[toInput]]. */
interface Draft {
  name: string
  value: string
  ccy: Currency
  tier: Tier
  note: string
  custody: '' | 'cold' | 'custodial'
}

const BLANK: Draft = { name: '', value: '', ccy: 'usd', tier: 'store', note: '', custody: '' }

function toDraft(asset: ManualAsset): Draft {
  return {
    name: asset.name,
    // An asset with no value at all is a legitimate placeholder, so it renders as an empty box
    // rather than a zero the user has to notice and delete.
    value: asset.value === undefined ? '' : String(asset.value),
    ccy: asset.ccy ?? 'usd',
    tier: asset.tier,
    note: asset.note ?? '',
    custody: asset.custody ?? '',
  }
}

/**
 * A draft as the API wants it, or `null` when the value is not a number.
 *
 * An unparseable value is rejected here rather than coerced: `Number('')` is 0, and silently
 * recording a typo as a balance of zero is the one failure this form must not have.
 */
function toInput(draft: Draft): ManualAssetInput | null {
  const name = draft.name.trim()
  if (!name) return null

  const raw = draft.value.trim()
  const value = raw === '' ? undefined : Number(raw)
  if (value !== undefined && !Number.isFinite(value)) return null

  return {
    name,
    tier: draft.tier,
    ...(value === undefined ? {} : { value }),
    ccy: draft.ccy,
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    ...(draft.custody ? { custody: draft.custody } : {}),
  }
}

/** `sats` and `thb` are shown as typed; only their USD conversion is derived. */
function fmtOwn(asset: ManualAsset): string {
  if (asset.value === undefined) return '—'
  return `${formatAmount(asset.value)} ${(asset.ccy ?? 'usd').toUpperCase()}`
}

function AssetForm({
  draft,
  setDraft,
  onSubmit,
  onCancel,
  pending,
  submitLabel,
}: {
  draft: Draft
  setDraft: (next: Draft) => void
  onSubmit: () => void
  onCancel: () => void
  pending: boolean
  submitLabel: string
}) {
  return (
    <form
      className="space-y-3 rounded-md border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="oc-name">Name</Label>
          <Input
            id="oc-name"
            value={draft.name}
            placeholder="Cold storage BTC"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-value">Amount</Label>
          <div className="flex gap-2">
            <Input
              id="oc-value"
              inputMode="decimal"
              value={draft.value}
              placeholder="14000000"
              className="tabular-nums"
              onChange={(e) => setDraft({ ...draft, value: e.target.value })}
            />
            <Select
              value={draft.ccy}
              onValueChange={(v) => setDraft({ ...draft, ccy: v as Currency })}
            >
              <SelectTrigger className="w-[100px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            In its own denomination — converted to USD with live rates, never stored converted.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-tier">Tier</Label>
          <Select value={draft.tier} onValueChange={(v) => setDraft({ ...draft, tier: v as Tier })}>
            <SelectTrigger id="oc-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TIERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t[0].toUpperCase() + t.slice(1)} — {TIER_HINT[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="oc-custody">Custody</Label>
          <Select
            value={draft.custody || 'none'}
            onValueChange={(v) =>
              setDraft({ ...draft, custody: v === 'none' ? '' : (v as 'cold' | 'custodial') })
            }
          >
            <SelectTrigger id="oc-custody">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Not applicable</SelectItem>
              <SelectItem value="cold">Cold — you hold the keys</SelectItem>
              <SelectItem value="custodial">Custodial — someone else does</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="oc-note">Note</Label>
        <Input
          id="oc-note"
          value={draft.note}
          placeholder="Which drawer, which bank, which receipt"
          onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <X className="size-4" /> Cancel
        </Button>
      </div>
    </form>
  )
}

export function OffChainAssets() {
  const queryClient = useQueryClient()
  // Only for the rates — the same `Ctx` every other wealth surface reads, so the USD conversion
  // shown here is the one the totals were built from rather than a second opinion.
  const { ctx } = useWealth()
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)

  const assets = useQuery({
    queryKey: ['wealth', 'manual'],
    queryFn: () => WEALTH_SOURCE.getManualAssets(),
    retry: false,
  })

  /** Every write invalidates the portfolio too: net worth just changed. */
  const settle = (title: string) => {
    void queryClient.invalidateQueries({ queryKey: ['wealth'] })
    setEditing(null)
    setDraft(BLANK)
    notify({ title, type: 'success' })
  }
  const fail = (e: Error) =>
    notify({ title: 'Could not save', message: e.message, type: 'error' })

  const create = useMutation({
    mutationFn: (input: ManualAssetInput) => WEALTH_SOURCE.createManualAsset(input),
    onSuccess: () => settle('Off-chain asset added'),
    onError: fail,
  })
  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ManualAssetInput }) =>
      WEALTH_SOURCE.updateManualAsset(id, input),
    onSuccess: () => settle('Off-chain asset saved'),
    onError: fail,
  })
  const remove = useMutation({
    mutationFn: (id: string) => WEALTH_SOURCE.deleteManualAsset(id),
    onSuccess: () => settle('Off-chain asset removed'),
    onError: fail,
  })

  const pending = create.isPending || update.isPending

  const submit = () => {
    const input = toInput(draft)
    if (!input) {
      notify({ title: 'Needs a name and a numeric amount', type: 'error' })
      return
    }
    if (editing === 'new') create.mutate(input)
    else if (editing) update.mutate({ id: editing, input })
  }

  // `manualUsd` rather than a second conversion here: this figure has to be the one the totals
  // were built from, and two implementations of the same arithmetic drift.
  const usd = (asset: ManualAsset): number | null => (ctx ? manualUsd(asset, ctx) : null)

  const rows = assets.data ?? []
  const total = ctx ? rows.reduce((sum, a) => sum + manualUsd(a, ctx), 0) : null

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Off-chain assets</CardTitle>
          <p className="text-xs text-muted-foreground">
            What the chain cannot see. Counted in net worth and in the daily series the server
            records.
          </p>
        </div>
        {editing === null && (
          <Button size="sm" variant="outline" onClick={() => { setDraft(BLANK); setEditing('new') }}>
            <Plus className="size-4" /> Add
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {editing === 'new' && (
          <AssetForm
            draft={draft}
            setDraft={setDraft}
            onSubmit={submit}
            onCancel={() => setEditing(null)}
            pending={pending}
            submitLabel="Add asset"
          />
        )}

        {assets.isLoading && <RowsSkeleton rows={3} />}
        {assets.error && (
          <WealthError
            detail={(assets.error as Error).message}
            onRetry={() => void assets.refetch()}
          />
        )}

        {!assets.isLoading && !assets.error && rows.length === 0 && editing === null && (
          <div className="flex items-center gap-3 rounded-md border border-dashed px-3 py-6 text-sm text-muted-foreground">
            <Coins className="size-5 shrink-0" />
            <p>
              Nothing recorded. Until something is here, net worth is the on-chain book only — which
              is why the old series and the live one do not line up.
            </p>
          </div>
        )}

        {rows.map((asset) =>
          editing === asset.id ? (
            <AssetForm
              key={asset.id}
              draft={draft}
              setDraft={setDraft}
              onSubmit={submit}
              onCancel={() => setEditing(null)}
              pending={pending}
              submitLabel="Save changes"
            />
          ) : (
            <div
              key={asset.id}
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{asset.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {fmtOwn(asset)} · {asset.tier}
                  {asset.custody ? ` · ${asset.custody}` : ''}
                  {asset.note ? ` · ${asset.note}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Null until the portfolio (and with it the rates) has loaded — a dash, not a
                    zero, because zero is a number this asset could actually be worth. */}
                <span className="mr-2 text-sm tabular-nums">
                  {usd(asset) === null ? '—' : formatUsd(usd(asset))}
                </span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Edit ${asset.name}`}
                  onClick={() => { setDraft(toDraft(asset)); setEditing(asset.id) }}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${asset.name}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(asset.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ),
        )}

        {rows.length > 0 && (
          <div className="flex items-center justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">
              {rows.length} asset{rows.length === 1 ? '' : 's'} off chain
            </span>
            <span className="font-medium tabular-nums">
              {total === null ? '—' : formatUsd(total)}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
