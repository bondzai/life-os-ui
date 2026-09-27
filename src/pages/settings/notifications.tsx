/**
 * Settings → Notifications: where messages can go, and which groups go there.
 *
 * Channels above, routing below, because you add a channel once and change routing often.
 *
 * Two things this screen is built around:
 *
 * **The webhook URL is write-only.** It is a credential — the last path segment of a Discord webhook
 * is a token, and anyone holding the URL can post to that room. The server returns a preview and
 * never the value, so the field is always empty and saving it replaces what is stored. Saying that
 * on the form matters: a field that looks blank when something *is* configured reads as broken.
 *
 * **Save and test are one action.** A saved-but-broken webhook is the failure this screen exists to
 * prevent, and a separate Test button is an invitation to skip it.
 */

import { useState } from 'react'
import { Bell, Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/core/components/empty-state'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from '@/pages/wealth/format'
import {
  useChannels,
  useCreateChannel,
  useDeleteChannel,
  useRoutes,
  useSaveRoutes,
  useTestChannel,
  useUpdateChannel,
  type Channel,
  type Route,
  type RouteDraft,
  type Severity,
} from '@/core/hooks/use-channels'

/** Plain words for the groups. The ids are what the server routes on. */
const GROUP_LABEL: Record<string, string> = {
  money: 'Money',
  day: 'Your day',
  system: 'The box',
}
const GROUP_HINT: Record<string, string> = {
  money: 'Positions, balances, anything about real money',
  day: 'The daily brief, habits, anything scheduled',
  system: 'Failed jobs, deploys, restarts',
}

const SEVERITIES: Severity[] = ['info', 'warning', 'critical']

/**
 * A signature of the saved routing, used as the matrix's `key`.
 *
 * Remounting on a real change is how the grid takes new server state without an effect, and it is
 * also what stops a background refetch wiping an edit in progress: the signature only moves when the
 * saved rows differ, not when the array is merely a new object.
 */
function routingKey(routes: Route[]): string {
  return routes
    .map((r) => `${r.group}:${r.channel_id}:${r.min_severity}:${r.quiet_from}:${r.quiet_to}`)
    .sort()
    .join('|')
}

export function NotificationSettings() {
  const channels = useChannels()
  const routes = useRoutes()

  if (channels.isError || routes.isError) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {(channels.error ?? routes.error)?.message ?? 'Could not read the notification settings.'}
      </p>
    )
  }

  // Loading is its own branch rather than a falsy `?.` that renders an empty list. Written the other
  // way first, and it showed a channel list with nothing in it for as long as the request took —
  // indistinguishable from "you have no channels", which is a different thing to tell someone.
  const list = channels.data?.channels
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading your channels…
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="font-semibold">Channels</h2>
          <p className="text-sm text-muted-foreground">
            Where a notification can go. Add a Discord room by pasting its webhook URL.
          </p>
        </div>

        {list.length === 0 ? (
          <EmptyState
            icon={Bell}
            title="No channels yet"
            description="Nothing will be delivered until at least one channel exists and a group is routed to it."
          />
        ) : (
          <ul className="space-y-2">
            {list.map((channel) => (
              <ChannelRow key={channel.id} channel={channel} />
            ))}
          </ul>
        )}

        <AddChannel transports={channels.data?.transports ?? []} />
      </section>

      {/* Routing needs channels to route to, so it says so rather than rendering an empty grid. */}
      {list.length > 0 && (
        <RoutingMatrix
          key={routingKey(routes.data?.routes ?? [])}
          channels={list}
          groups={routes.data?.groups ?? []}
          saved={routes.data?.routes ?? []}
        />
      )}
    </div>
  )
}

function ChannelRow({ channel }: { channel: Channel }) {
  const update = useUpdateChannel()
  const remove = useDeleteChannel()
  const test = useTestChannel()
  const [editing, setEditing] = useState(false)

  const failing = channel.failing_since != null
  const error = update.error ?? remove.error ?? test.error

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 font-medium">
            {channel.name}
            {!channel.enabled ? (
              <Chip tone="muted">off</Chip>
            ) : failing ? (
              <Chip tone="bad">failing since {formatRelativeTime(channel.failing_since!)}</Chip>
            ) : (
              <Chip tone="good">healthy</Chip>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {channel.preview ?? `${channel.transport} — credential from .env.local`}
          </p>
          {/* Why it is failing is the reason the row is worth reading at all. A deleted webhook
              answers 401 forever, and the row should say that rather than going quiet. */}
          {failing && channel.last_error && (
            <p className="mt-1 text-xs text-red-700 dark:text-red-400">{channel.last_error}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate(channel.id)}
            disabled={test.isPending}
          >
            {test.isPending ? 'Testing…' : 'Test'}
          </Button>
          {channel.stored_secret && (
            <Button variant="outline" size="sm" onClick={() => setEditing((was) => !was)}>
              {editing ? 'Cancel' : 'Replace URL'}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate({ id: channel.id, enabled: !channel.enabled })}
            disabled={update.isPending}
          >
            {channel.enabled ? 'Disable' : 'Enable'}
          </Button>
          {/* Disable is offered first and reads as the reversible one; removing also drops this
              channel's routing, which the confirmation says out loud. */}
          <Button
            variant="outline"
            size="sm"
            className="text-red-700 dark:text-red-400"
            onClick={() => {
              if (confirm(`Remove ${channel.name}? Its routing goes with it.`)) {
                remove.mutate(channel.id)
              }
            }}
            disabled={remove.isPending}
          >
            Remove
          </Button>
        </div>
      </div>

      {test.isSuccess && !test.isPending && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-500">
          <Check className="size-3.5" aria-hidden /> the test message went out
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {error.message}
        </p>
      )}

      {editing && (
        <UrlField
          submitLabel="Replace and test"
          busy={update.isPending}
          onSubmit={async (url) => {
            await update.mutateAsync({ id: channel.id, url })
            await test.mutateAsync(channel.id)
            setEditing(false)
          }}
        />
      )}
    </li>
  )
}

/**
 * The write-only URL field.
 *
 * Always empty, and it says why. Rendering the stored value back would put a live token in every
 * response, in the browser's memory, and in anything that caches a page.
 */
function UrlField({
  submitLabel,
  busy,
  onSubmit,
}: {
  submitLabel: string
  busy: boolean
  onSubmit: (url: string) => void | Promise<void>
}) {
  const [url, setUrl] = useState('')

  return (
    <form
      className="mt-3 space-y-2 border-t pt-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (url.trim()) void onSubmit(url.trim())
      }}
    >
      <label className="block text-xs font-medium" htmlFor="webhook-url">
        Webhook URL
      </label>
      <input
        id="webhook-url"
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://discord.com/api/webhooks/…"
        className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      />
      <p className="text-xs text-muted-foreground">
        From Discord → Channel → Integrations → Webhooks. Must be an <code>https</code> URL on
        discord.com.
      </p>
      <p className="text-xs text-amber-600 dark:text-amber-500">
        Saving replaces what is stored. It is never shown again — only the last four characters.
      </p>
      <Button type="submit" size="sm" disabled={busy || !url.trim()}>
        {busy ? (
          <>
            <Loader2 className="mr-1.5 size-3.5 animate-spin" aria-hidden /> Saving…
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  )
}

function AddChannel({ transports }: { transports: { id: string; stores_credential: boolean }[] }) {
  const create = useCreateChannel()
  const test = useTestChannel()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState('discord')

  const needsUrl = transports.find((t) => t.id === transport)?.stores_credential ?? true

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a channel
      </Button>
    )
  }

  return (
    <div className="rounded-lg border border-dashed p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-xs font-medium" htmlFor="channel-name">
            Name
          </label>
          <input
            id="channel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Discord · money"
            className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium" htmlFor="channel-transport">
            Kind
          </label>
          <select
            id="channel-transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {transports.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}
              </option>
            ))}
          </select>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>

      {needsUrl ? (
        <UrlField
          submitLabel="Save and test"
          busy={create.isPending || test.isPending}
          onSubmit={async (url) => {
            const made = await create.mutateAsync({ name: name.trim() || transport, transport, url })
            // Tested immediately, because the whole point of adding it is that it works.
            await test.mutateAsync(made.id)
            setOpen(false)
            setName('')
          }}
        />
      ) : (
        <div className="mt-3 space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            This kind takes its credential from <code>.env.local</code>, so there is nothing to paste.
          </p>
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={async () => {
              const made = await create.mutateAsync({ name: name.trim() || transport, transport })
              await test.mutateAsync(made.id)
              setOpen(false)
              setName('')
            }}
          >
            Add and test
          </Button>
        </div>
      )}

      {(create.error ?? test.error) && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {(create.error ?? test.error)!.message}
        </p>
      )}
    </div>
  )
}

/**
 * The grid: a row per group, a column per channel.
 *
 * Edited locally and saved as a whole, matching the endpoint. A per-cell save would let a save
 * half-apply and leave a group delivering somewhere it had just been unticked.
 */
function RoutingMatrix({
  channels,
  groups,
  saved,
}: {
  channels: Channel[]
  groups: string[]
  saved: Route[]
}) {
  const save = useSaveRoutes()
  // Seeded once. The caller remounts this component when the *saved* routes actually change — see
  // `routingKey` — so there is no effect syncing server state into local state. The obvious
  // `useEffect(() => setDraft(saved), [saved])` looked right and was not: `saved` is a new array on
  // every refetch, so a poll landing mid-edit discarded whatever had been ticked.
  const [draft, setDraft] = useState<RouteDraft[]>(saved)

  const find = (group: string, channelId: string) =>
    draft.find((r) => r.group === group && r.channel_id === channelId)

  const toggle = (group: string, channelId: string) =>
    setDraft((rows) =>
      find(group, channelId)
        ? rows.filter((r) => !(r.group === group && r.channel_id === channelId))
        : [
            ...rows,
            { group, channel_id: channelId, min_severity: 'info', quiet_from: null, quiet_to: null },
          ],
    )

  const setSeverity = (group: string, channelId: string, min_severity: Severity) =>
    setDraft((rows) =>
      rows.map((r) =>
        r.group === group && r.channel_id === channelId ? { ...r, min_severity } : r,
      ),
    )

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold">Routing</h2>
        <p className="text-sm text-muted-foreground">
          Which groups go where, and how loud something has to be to count.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="border p-2 text-left text-xs tracking-wide text-muted-foreground uppercase">
                Group
              </th>
              {channels.map((channel) => (
                <th key={channel.id} className="border p-2 text-xs font-medium">
                  {channel.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr key={group}>
                <td className="border p-2 align-top">
                  <span className="font-medium">{GROUP_LABEL[group] ?? group}</span>
                  <span className="block text-xs text-muted-foreground">{GROUP_HINT[group]}</span>
                </td>
                {channels.map((channel) => {
                  const route = find(group, channel.id)
                  return (
                    <td key={channel.id} className="border p-2 text-center align-top">
                      <label className="flex items-center justify-center gap-2">
                        <span className="sr-only">
                          {GROUP_LABEL[group] ?? group} to {channel.name}
                        </span>
                        <input
                          type="checkbox"
                          checked={route != null}
                          onChange={() => toggle(group, channel.id)}
                          aria-label={`${group} to ${channel.name}`}
                        />
                      </label>
                      {route && (
                        <select
                          value={route.min_severity}
                          onChange={(e) =>
                            setSeverity(group, channel.id, e.target.value as Severity)
                          }
                          aria-label={`minimum severity for ${group} to ${channel.name}`}
                          className="mt-1 rounded border bg-background px-1 py-0.5 text-xs"
                        >
                          {SEVERITIES.map((s) => (
                            <option key={s} value={s}>
                              {s}+
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
          {save.isPending ? 'Saving…' : 'Save routing'}
        </Button>
        {dirty && <span className="text-xs text-amber-600 dark:text-amber-500">unsaved changes</span>}
        {save.isSuccess && !dirty && (
          <span className="flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-500">
            <Check className="size-3.5" aria-hidden /> saved
          </span>
        )}
        {save.error && (
          <span role="alert" className="flex items-center gap-1.5 text-xs text-red-700 dark:text-red-400">
            <X className="size-3.5" aria-hidden /> {save.error.message}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        A route delivers its severity and above. <strong>Critical ignores quiet hours</strong> — a
        liquidation at 3am is the message you would be angry to have been protected from.
      </p>
    </section>
  )
}

/** A small status pill. The word carries the meaning; colour only repeats it. */
function Chip({ tone, children }: { tone: 'good' | 'bad' | 'muted'; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-medium',
        tone === 'good' && 'border-emerald-600/40 text-emerald-700 dark:text-emerald-500',
        tone === 'bad' && 'border-red-600/40 text-red-700 dark:text-red-400',
        tone === 'muted' && 'border-muted-foreground/30 text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}
