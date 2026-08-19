/**
 * Wealth · Settings — the alert sweep's knobs, and whether it is actually running.
 *
 * Every field here is an *override*: clearing one reverts it to the server's environment default
 * rather than setting it to zero. Those are different instructions — "off" and "whatever the box
 * is configured for" — so the form sends `null` to clear and never conflates the two.
 */

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, BellRing, CheckCircle2, CircleSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { EmptyState } from '@/core/components/empty-state'
import { notify } from '@/lib/notify'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from './format'
import { RowsSkeleton, WealthError } from './states'
import type { AlertStatus } from './types'
import { StatCard } from './wealth-ui'

/** A number field that distinguishes empty (revert to default) from 0 (explicitly off). */
function NumberField({
  id,
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  placeholder: string
  onChange: (next: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="tabular-nums"
      />
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

/** `""` → null (clear the override). Anything unparseable is rejected by the caller. */
function toPatchValue(raw: string): number | null | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function SweepState({ status }: { status: AlertStatus }) {
  const running = status.running
  const Icon = !running ? CircleSlash : status.last_error ? AlertTriangle : CheckCircle2
  const tone = !running
    ? 'text-muted-foreground'
    : status.last_error
      ? 'text-amber-600 dark:text-amber-500'
      : 'text-emerald-600 dark:text-emerald-500'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <div>
          <CardTitle className="text-base">Sweep</CardTitle>
          <p className="text-xs text-muted-foreground">
            The always-on loop: range alerts, the daily brief, and the net-worth series
          </p>
        </div>
        <Icon className={cn('size-5 shrink-0', tone)} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard
            label="Status"
            value={<span className={tone}>{running ? 'Running' : 'Not running'}</span>}
            hint={running ? `every ${status.interval}s` : 'no wallets, digest hour or exchange key'}
          />
          <StatCard
            label="Last check"
            value={status.last_check === null ? '—' : formatRelativeTime(status.last_check)}
            hint={status.watching === null ? 'nothing swept yet' : `watching ${status.watching} positions`}
          />
          <StatCard
            label="Telegram"
            value={status.can_send ? 'Connected' : 'Not set up'}
            hint={status.can_send ? `${status.wallets} wallet(s) watched` : 'bot token and chat id required'}
          />
        </div>

        {status.last_error && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-500">Last error</p>
            {/* Sticky: never cleared on success, so a fault that has stopped is still visible once. */}
            <p className="mt-0.5 text-muted-foreground">{status.last_error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function WealthSettingsPage() {
  const queryClient = useQueryClient()
  const {
    data: status,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['wealth', 'alerts'],
    queryFn: () => apiWealthRepository.getAlertStatus(),
    // Alert config is server state — the sweep interval, the Telegram wiring, the live cursor.
    // A demo session has none of it, so the request is not made rather than left to fail.
    enabled: USE_API,
  })

  const [interval, setInterval] = useState('')
  const [feeThreshold, setFeeThreshold] = useState('')
  const [hfAlert, setHfAlert] = useState('')
  const [digestHour, setDigestHour] = useState('')

  // Seed from the saved overrides only — an empty box means "use the box's default", which is
  // exactly what an absent override means. Pre-filling with the resolved value would turn every
  // default into an override on the first save.
  useEffect(() => {
    if (!status) return
    const o = status.overrides as Record<string, unknown>
    const str = (key: string) => (o[key] === undefined || o[key] === null ? '' : String(o[key]))
    setInterval(str('interval'))
    setFeeThreshold(str('fee_threshold'))
    setHfAlert(str('hf_alert'))
    setDigestHour(str('digest_hour'))
  }, [status])

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => apiWealthRepository.saveAlertConfig(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(['wealth', 'alerts'], next)
      notify({ title: 'Alert settings saved', type: 'success' })
    },
    onError: (e: Error) => notify({ title: 'Could not save', message: e.message, type: 'error' }),
  })

  if (!USE_API) {
    return (
      <EmptyState
        icon={BellRing}
        title="Alerts need the live backend"
        description="Range and health-factor alerts are configured on the server that runs the sweep. Sign in against the API to change them."
      />
    )
  }
  if (isLoading) return <RowsSkeleton rows={5} />
  if (error) return <WealthError detail={(error as Error).message} onRetry={() => void refetch()} />
  if (!status) return null

  const onSave = () => {
    const patch: Record<string, unknown> = {}
    const fields: [string, string][] = [
      ['interval', interval],
      ['fee_threshold', feeThreshold],
      ['hf_alert', hfAlert],
      ['digest_hour', digestHour],
    ]
    for (const [key, raw] of fields) {
      const value = toPatchValue(raw)
      if (value === undefined) {
        notify({ title: `${key} must be a number`, type: 'error' })
        return
      }
      patch[key] = value
    }
    save.mutate(patch)
  }

  return (
    <div className="space-y-4">
      <SweepState status={status} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Alert thresholds</CardTitle>
          <p className="text-xs text-muted-foreground">
            Leave a field empty to use the server's default. A saved <code>0</code> means off — the
            two are not the same instruction.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              id="alert-interval"
              label="Sweep interval"
              hint={`Seconds between sweeps. Currently ${status.interval}s.`}
              value={interval}
              placeholder={String(status.interval)}
              onChange={setInterval}
            />
            <NumberField
              id="fee-threshold"
              label="Fees-ready threshold"
              hint={
                status.fee_threshold === null
                  ? 'USD of unclaimed fees before a ping. Currently off.'
                  : `USD of unclaimed fees before a ping. Currently $${status.fee_threshold}.`
              }
              value={feeThreshold}
              placeholder={status.fee_threshold === null ? 'off' : String(status.fee_threshold)}
              onChange={setFeeThreshold}
            />
            <NumberField
              id="hf-alert"
              label="Health-factor floor"
              hint={`Warn when a lending position drops below this. Currently ${status.hf_alert ?? 'off'}.`}
              value={hfAlert}
              placeholder={String(status.hf_alert ?? 'off')}
              onChange={setHfAlert}
            />
            <NumberField
              id="digest-hour"
              label="Daily brief hour"
              hint={
                status.digest_hour === null
                  ? 'Hour 0–23 in the server timezone. Currently disabled.'
                  : `Hour 0–23 in the server timezone. Currently ${status.digest_hour}:00.`
              }
              value={digestHour}
              placeholder={status.digest_hour === null ? 'disabled' : String(status.digest_hour)}
              onChange={setDigestHour}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={onSave} disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Takes effect on the next sweep — the loop re-reads its config every cycle, so there is
              nothing to restart.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Reporting</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Report currency" value={status.report_ccy.toUpperCase()} hint="set by the server" />
          <StatCard
            label="Daily brief"
            value={status.digest_enabled ? 'On' : 'Off'}
            hint={status.digest_last ? `last sent ${status.digest_last}` : 'never sent'}
          />
          <StatCard label="Wallets watched" value={String(status.wallets)} hint="from ALERT_WALLETS" />
        </CardContent>
      </Card>
    </div>
  )
}
