/**
 * Snowball — the slice of the book that is supposed to compound.
 *
 * Not a tier and not a chain: a hand-picked basket that can cut across a BTC wallet, an LP and a
 * bot at once. Membership is tagged with the ❄ button on the position itself (DeFi, Bots,
 * Holdings) and the panel here answers the only question that basket exists to ask — is it
 * actually growing, and how fast.
 *
 * The panel self-hides until something is tagged, so a book with no snowball never sees it.
 */

import { useMemo, useState } from 'react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Bitcoin, Bot, ChevronDown, Coins, Droplets, Snowflake, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { useMoney } from './money'
import { snowballCandidates, type Ctx, type SbKind, type SbMember } from './derive'

import { useSnowball, useSnowballTags } from './use-snowball'

const KIND_ICON: Record<SbKind, typeof Wallet> = {
  wallet: Wallet,
  lp: Droplets,
  bot: Bot,
  manual: Coins,
}

const KIND_GROUP: Record<SbKind, string> = {
  wallet: 'Wallets',
  lp: 'LP positions',
  bot: 'Trading bots',
  manual: 'Off-chain',
}

const KIND_LABEL: Record<SbKind, string> = {
  wallet: 'whole wallet',
  lp: 'LP position',
  bot: 'trading bot',
  manual: 'off-chain',
}

/**
 * The ❄ tag button, rendered on whatever the tag points at.
 *
 * `aria-pressed` rather than a checkbox: it toggles membership of the thing it sits on, and the
 * label has to name that thing or a screen reader hears a page full of identical "snowball"
 * buttons.
 */
export function SnowballToggle({ id, name, className }: { id: string; name: string; className?: string }) {
  const { isTagged, toggle } = useSnowballTags()
  const on = isTagged(id)
  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-pressed={on}
      aria-label={on ? `Remove ${name} from snowball` : `Add ${name} to snowball`}
      title={on ? 'In your snowball — click to remove' : 'Add to snowball'}
      onClick={() => toggle(id)}
      // 28px of visible button, 44px of tappable area. The glyph has to stay small — it sits in a
      // dense table row — but on the card layout below `sm` this is the only control on the
      // screen, and 28px misses the 44px touch minimum badly enough to be a real miss, not a
      // pedantic one. The pseudo-element grows the hit box without moving a single pixel of
      // layout; nothing beside it is interactive, so the overlap costs nothing.
      className={cn(
        'relative size-7 shrink-0 before:absolute before:-inset-2 before:content-[""]',
        on ? 'text-sky-500 hover:text-sky-500' : 'text-muted-foreground/50',
        className,
      )}
    >
      <Snowflake className={cn('size-3.5', on && 'fill-current')} />
    </Button>
  )
}

/** One row per tagged source, largest first — "what is actually inside the snowball". */
function Sources({ members, total }: { members: SbMember[]; total: number }) {
  const { money } = useMoney()
  const [open, setOpen] = useState(false)

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2 text-left"
      >
        <div className="flex h-2 flex-1 overflow-hidden rounded-full bg-muted">
          {members.map((m) => (
            <div
              key={m.id}
              className="h-full bg-sky-500/70 first:rounded-l-full last:rounded-r-full"
              style={{ width: `${(m.usd / total) * 100}%` }}
              title={`${m.label} · ${((m.usd / total) * 100).toFixed(0)}%`}
            />
          ))}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {members.length} {members.length === 1 ? 'source' : 'sources'}
        </span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div className="space-y-1">
          {members.map((m) => {
            const Icon = KIND_ICON[m.kind]
            const pct = (m.usd / total) * 100
            return (
              <div key={m.id} className="flex items-center gap-2.5 rounded-md border px-2 py-1.5">
                <span className="grid size-6 shrink-0 place-items-center rounded bg-muted" title={KIND_LABEL[m.kind]}>
                  <Icon className="size-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{m.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{m.sub}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-medium tabular-nums">{money(m.usd)}</div>
                  <div className="text-xs tabular-nums text-muted-foreground">{pct.toFixed(0)}%</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Every taggable source, grouped by kind.
 *
 * The ❄ buttons on DeFi and Bots cover the positions, but a whole wallet and an off-chain asset
 * have no row of their own anywhere else — without this they would be taggable in the data model
 * and unreachable in the UI.
 */
function SnowballPicker({ ctx }: { ctx: Ctx }) {
  const { money } = useMoney()
  const { isTagged, toggle } = useSnowballTags()
  const groups = useMemo(() => {
    const all = snowballCandidates(ctx)
    return (['wallet', 'lp', 'bot', 'manual'] as SbKind[])
      .map((kind) => ({ kind, rows: all.filter((c) => c.kind === kind).sort((a, b) => b.usd - a.usd) }))
      .filter((g) => g.rows.length > 0)
  }, [ctx])

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <div key={group.kind} className="space-y-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {KIND_GROUP[group.kind]}
          </p>
          {group.rows.map((row) => {
            const on = isTagged(row.id)
            const Icon = KIND_ICON[row.kind]
            return (
              <button
                key={row.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(row.id)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors',
                  on ? 'border-sky-500/40 bg-sky-500/5' : 'hover:bg-muted/50',
                )}
              >
                <Snowflake className={cn('size-3.5 shrink-0', on ? 'fill-current text-sky-500' : 'text-muted-foreground/40')} />
                <Icon className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{money(row.usd)}</span>
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function SnowballPanel({ ctx }: { ctx: Ctx }) {
  const { money, compact } = useMoney()
  const { members, total, btcUsd, history, weekDelta, monthly } = useSnowball(ctx)
  const [picking, setPicking] = useState(false)

  // Nothing tagged yet. The original hid the panel outright, which left a book with no LPs or
  // bots — the two surfaces carrying a ❄ button — no way to ever find the feature. One quiet
  // line and a picker costs the Overview almost nothing and makes it reachable.
  if (!members.length) {
    return (
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <div>
            <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
              <Snowflake className="size-3.5 text-muted-foreground" />
              Snowball
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Tag the holdings meant to compound and watch that slice climb on its own.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => setPicking((v) => !v)}>
            {picking ? 'Done' : 'Choose sources'}
          </Button>
        </CardHeader>
        {picking && (
          <CardContent>
            <SnowballPicker ctx={ctx} />
          </CardContent>
        )}
      </Card>
    )
  }

  const btcPrice = ctx.data.rates?.btc_usd
  const sats = typeof btcPrice === 'number' && btcPrice > 0 && btcUsd > 0 ? (btcUsd * 1e8) / btcPrice : null
  // Three months out at today's feed rate. Only ever shown for a basket that is actually growing:
  // extrapolating a decline as a "projection" would dress up a loss as a plan.
  const projected = monthly !== null && monthly > 0 ? total + monthly * 3 : null

  const chartData = history.map((p) => ({ ...p, label: new Date(p.d).toLocaleDateString() }))

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 pb-2">
        <div>
          <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
            <Snowflake className="size-3.5 text-sky-500" />
            Snowball
          </CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">The slice you tagged to compound</p>
        </div>
        <div className="flex items-start gap-2">
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums">{money(total)}</div>
            {weekDelta !== null && weekDelta !== 0 && (
              <div
                className={cn(
                  'text-xs font-medium tabular-nums',
                  weekDelta > 0 ? 'text-emerald-600 dark:text-emerald-500' : 'text-red-600 dark:text-red-500',
                )}
              >
                {weekDelta > 0 ? '+' : '−'}
                {money(Math.abs(weekDelta))} this week
              </div>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-expanded={picking}
            onClick={() => setPicking((v) => !v)}
          >
            {picking ? 'Done' : 'Edit'}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {chartData.length < 2 ? (
          // The series starts the day the first tag is added, so a new snowball is legitimately
          // empty. Saying so beats a flat line that reads as "it never moved".
          <p className="py-6 text-center text-xs text-muted-foreground">
            The climb fills in daily — come back tomorrow for the first step up.
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={120}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="sbFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                axisLine={false}
                tickLine={false}
                width={52}
                tickFormatter={(v) => compact(Number(v))}
              />
              <Tooltip
                formatter={(v) => [money(Number(v)), 'Snowball']}
                labelFormatter={(l) => String(l)}
                contentStyle={{
                  background: 'var(--popover)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  fontSize: 12,
                  color: 'var(--popover-foreground)',
                }}
              />
              <Area type="monotone" dataKey="v" stroke="var(--chart-2)" strokeWidth={2} fill="url(#sbFill)" />
            </AreaChart>
          </ResponsiveContainer>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {monthly !== null && monthly > 0 && <span>feed ≈{money(monthly)}/mo</span>}
          {projected !== null && (
            <span title="Where the basket lands in three months at today's feed rate">
              → 3mo {compact(projected)}
            </span>
          )}
          {sats !== null && (
            <span className="inline-flex items-center gap-1">
              <Bitcoin className="size-3" />
              {Math.round(sats).toLocaleString('en-US')} sats
            </span>
          )}
        </div>

        {picking ? <SnowballPicker ctx={ctx} /> : <Sources members={members} total={total} />}
      </CardContent>
    </Card>
  )
}
