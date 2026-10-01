/**
 * Settings → Schedules: things Lyra does on its own, on a clock you set.
 *
 * Sits under Notifications because a schedule's whole output is a notification, and which channel it
 * lands on is decided by the routing grid above rather than here. A schedule says *when* and *what*;
 * routing says *where*.
 *
 * Two things this screen is built around:
 *
 * **A schedule is picked, not typed.** No cron expression. A mis-typed `30 7 * * 1-5` fails by the
 * message silently never arriving, which is the one failure a schedule cannot have, so the form
 * offers daily / weekly / every-N and a clock time.
 *
 * **A missed firing is shown.** If the box was off past the catch-up window, the row says so and
 * counts it. A schedule that quietly stopped is the thing this screen exists to make visible.
 */

import { useState } from 'react'
import { AlarmClock, Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/core/components/empty-state'
import { formatRelativeTime } from '@/pages/wealth/format'
import {
  fromClock,
  toClock,
  useCreateCron,
  useCrons,
  useDeleteCron,
  useRunCron,
  useUpdateCron,
  type Cron,
  type Schedule,
} from '@/core/hooks/use-crons'

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const GROUP_LABEL: Record<string, string> = {
  money: 'Money',
  day: 'Your day',
  system: 'The box',
}

/** What each action does, in words. The ids are what the server runs. */
const ACTION_LABEL: Record<string, string> = {
  'notify.message': 'Send a message I write',
  'wealth.defi': 'Report my DeFi positions and rewards',
}

/** Actions that go and read something, so there is no message to type. */
const FETCHES = new Set(['wealth.defi'])

const INPUT =
  'rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

export function ScheduleSettings() {
  const crons = useCrons()

  if (crons.isError) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {crons.error.message}
      </p>
    )
  }

  // Loading is its own branch, not a falsy `?.` that renders an empty list — "you have none" and
  // "still reading" are different things to tell someone.
  const list = crons.data?.crons
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading your schedules…
      </p>
    )
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold">Schedules</h2>
        <p className="text-sm text-muted-foreground">
          Things Lyra does on its own. Where each one lands is decided by the routing above.
        </p>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={AlarmClock}
          title="No schedules yet"
          description="The daily brief and the habits nudge still come from .env.local. Anything you add here is your own."
        />
      ) : (
        <ul className="space-y-2">
          {list.map((cron) => (
            <CronRow key={cron.id} cron={cron} />
          ))}
        </ul>
      )}

      <AddCron groups={crons.data?.groups ?? []} actions={crons.data?.actions ?? []} />
    </section>
  )
}

function CronRow({ cron }: { cron: Cron }) {
  const update = useUpdateCron()
  const remove = useDeleteCron()
  const run = useRunCron()
  const error = update.error ?? remove.error ?? run.error

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            {cron.name}
            {!cron.enabled && (
              <span className="rounded-full border border-muted-foreground/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                off
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {cron.describes}
            {cron.payload.group && ` → ${GROUP_LABEL[cron.payload.group] ?? cron.payload.group}`}
          </p>
          {cron.payload.text ? (
            <p className="mt-1 truncate text-sm">“{cron.payload.text}”</p>
          ) : (
            <p className="mt-1 truncate text-sm">{ACTION_LABEL[cron.action] ?? cron.action}</p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {cron.last_fired_at
              ? `last ran ${formatRelativeTime(cron.last_fired_at)}`
              : 'has not run yet'}
          </p>
          {/* Shown rather than buried in a log. A schedule that stopped arriving is the failure
              this row exists to surface. */}
          {cron.missed > 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              {cron.missed} missed
              {cron.last_missed_at && ` — most recently ${formatRelativeTime(cron.last_missed_at)}`}
              . The box was off past the {cron.catch_up_minutes}-minute catch-up window.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => run.mutate(cron.id)}
            disabled={run.isPending}
            // Safe to press: a manual run is its own job and does not consume today's firing.
            title="Run once now. The scheduled firing still happens."
          >
            {run.isPending ? 'Running…' : 'Run now'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate({ id: cron.id, enabled: !cron.enabled })}
            disabled={update.isPending}
          >
            {cron.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-700 dark:text-red-400"
            onClick={() => {
              if (confirm(`Delete “${cron.name}”?`)) remove.mutate(cron.id)
            }}
            disabled={remove.isPending}
          >
            Delete
          </Button>
        </div>
      </div>

      {run.isSuccess && !run.isPending && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-500">
          <Check className="size-3.5" aria-hidden /> queued — it will arrive on whatever this group
          is routed to
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {error.message}
        </p>
      )}
    </li>
  )
}

function AddCron({ groups, actions }: { groups: string[]; actions: string[] }) {
  const create = useCreateCron()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [action, setAction] = useState('notify.message')
  const [text, setText] = useState('')
  const [group, setGroup] = useState('day')
  const [kind, setKind] = useState<Schedule['kind']>('daily')
  const [clock, setClock] = useState('09:00')
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4])
  const [everyMinutes, setEveryMinutes] = useState(60)
  // An hour by default: long enough that a reboot does not lose the morning, short enough that a
  // nudge does not turn up at lunchtime.
  const [catchUp, setCatchUp] = useState(60)

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a schedule
      </Button>
    )
  }

  const at_minute = fromClock(clock)
  const schedule: Schedule | null =
    kind === 'daily'
      ? at_minute == null
        ? null
        : { kind: 'daily', at_minute }
      : kind === 'weekly'
        ? at_minute == null || days.length === 0
          ? null
          : { kind: 'weekly', days, at_minute }
        : { kind: 'every', seconds: everyMinutes * 60 }

  // An action that fetches has nothing for you to type, so requiring a message would make it
  // unsubmittable.
  const fetches = FETCHES.has(action)
  const ready = name.trim() !== '' && (fetches || text.trim() !== '') && schedule != null

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!schedule || !ready) return
        create
          .mutateAsync({
            name: name.trim(),
            schedule,
            action,
            payload: fetches ? {} : { text: text.trim(), group },
            catch_up_minutes: catchUp,
          })
          .then(() => {
            setOpen(false)
            setName('')
            setText('')
          })
          .catch(() => {
            /* the error renders below; the form keeps what was typed */
          })
      }}
    >
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-xs font-medium" htmlFor="cron-name">
            Name
          </label>
          <input
            id="cron-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Stand up"
            className={`mt-1 w-full ${INPUT}`}
          />
        </div>
        <div hidden={fetches}>
          <label className="block text-xs font-medium" htmlFor="cron-group">
            Goes to
          </label>
          <select
            id="cron-group"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            className={`mt-1 ${INPUT}`}
          >
            {groups.map((g) => (
              <option key={g} value={g}>
                {GROUP_LABEL[g] ?? g}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium" htmlFor="cron-action">
          What it does
        </label>
        <select
          id="cron-action"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className={`mt-1 w-full ${INPUT}`}
        >
          {actions.map((id) => (
            <option key={id} value={id}>
              {ACTION_LABEL[id] ?? id}
            </option>
          ))}
        </select>
      </div>

      {/* Only for an action that sends what you wrote. One that reads the chains has nothing
          for you to type here. */}
      {!fetches && (
        <div>
          <label className="block text-xs font-medium" htmlFor="cron-text">
            Message
          </label>
          <input
            id="cron-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Stand up and stretch"
            className={`mt-1 w-full ${INPUT}`}
          />
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs font-medium" htmlFor="cron-kind">
            When
          </label>
          <select
            id="cron-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as Schedule['kind'])}
            className={`mt-1 ${INPUT}`}
          >
            <option value="daily">Every day</option>
            <option value="weekly">On certain days</option>
            <option value="every">Every so often</option>
          </select>
        </div>

        {kind !== 'every' ? (
          <div>
            <label className="block text-xs font-medium" htmlFor="cron-clock">
              At
            </label>
            <input
              id="cron-clock"
              type="time"
              value={clock}
              onChange={(e) => setClock(e.target.value)}
              className={`mt-1 ${INPUT}`}
            />
          </div>
        ) : (
          <div>
            <label className="block text-xs font-medium" htmlFor="cron-every">
              Minutes apart
            </label>
            <input
              id="cron-every"
              type="number"
              min={1}
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(Math.max(1, Number(e.target.value) || 1))}
              className={`mt-1 w-28 ${INPUT}`}
            />
          </div>
        )}

        {kind !== 'every' && (
          <div>
            <label className="block text-xs font-medium" htmlFor="cron-catchup">
              Still send if late by
            </label>
            <select
              id="cron-catchup"
              value={catchUp}
              onChange={(e) => setCatchUp(Number(e.target.value))}
              className={`mt-1 ${INPUT}`}
            >
              <option value={0}>not at all</option>
              <option value={60}>an hour</option>
              <option value={240}>four hours</option>
              <option value={1440}>any time that day</option>
            </select>
          </div>
        )}
      </div>

      {kind === 'weekly' && (
        <fieldset>
          <legend className="text-xs font-medium">Days</legend>
          <div className="mt-1 flex flex-wrap gap-1">
            {DAYS.map((label, index) => (
              <button
                key={label}
                type="button"
                aria-pressed={days.includes(index)}
                onClick={() =>
                  setDays((was) =>
                    was.includes(index) ? was.filter((d) => d !== index) : [...was, index],
                  )
                }
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  days.includes(index) ? 'border-primary bg-primary/10 font-medium' : ''
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {days.length === 0 && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              Pick at least one day, or it would never fire.
            </p>
          )}
        </fieldset>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!ready || create.isPending}>
          {create.isPending ? 'Saving…' : 'Add schedule'}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {schedule && (
          <span className="text-xs text-muted-foreground">
            {kind === 'every'
              ? `every ${everyMinutes} minutes`
              : kind === 'daily'
                ? `every day at ${toClock(at_minute ?? 0)}`
                : `${days.map((d) => DAYS[d]).join(', ')} at ${toClock(at_minute ?? 0)}`}
          </span>
        )}
      </div>

      {create.error && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {create.error.message}
        </p>
      )}
    </form>
  )
}
