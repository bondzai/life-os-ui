/**
 * Settings → Systems: the other places Lyra speaks for.
 *
 * Under Notifications and Schedules because it is the same kind of thing — plumbing that decides
 * what reaches you — and because the questions these systems raise are delivered by the routing
 * configured above.
 *
 * Two things this screen is built around:
 *
 * **The token is write-only**, exactly as a Discord webhook is. The screen is given a preview and
 * never the value, so the field is always empty and saving it replaces what is stored. Saying that
 * on the form matters: a blank field when something *is* configured reads as broken.
 *
 * **A `fixture:` address is a visible choice.** Building against a door that does not exist yet is
 * normal, and the row says so rather than pretending the stub is the real thing.
 */

import { useState } from 'react'
import { Boxes, Check, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/core/components/empty-state'
import { formatRelativeTime } from '@/pages/wealth/format'
import {
  useCreateSystem,
  useDeleteSystem,
  useProbeSystem,
  useSystems,
  useUpdateSystem,
  type System,
  type SystemKind,
} from '@/core/hooks/use-systems'

const INPUT =
  'rounded-md border bg-background px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

const isStub = (url: string) => url.startsWith('fixture:')

export function SystemSettings() {
  const systems = useSystems()

  if (systems.isError) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {systems.error.message}
      </p>
    )
  }

  const list = systems.data?.systems
  if (!list) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading your systems…
      </p>
    )
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-semibold">Systems</h2>
        <p className="text-sm text-muted-foreground">
          The other places Lyra speaks for. It reads what they need decided and carries your answer
          back — it never acts on its own.
        </p>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No systems yet"
          description="Point Lyra at one and its decisions turn up on Today. A fixture:// address stands in for a system that is still being built."
        />
      ) : (
        <ul className="space-y-2">
          {list.map((system) => (
            <SystemRow key={system.id} system={system} />
          ))}
        </ul>
      )}

      <AddSystem />
    </section>
  )
}

function SystemRow({ system }: { system: System }) {
  const update = useUpdateSystem()
  const remove = useDeleteSystem()
  const probe = useProbeSystem()
  const [replacing, setReplacing] = useState(false)
  const [token, setToken] = useState('')
  const error = update.error ?? remove.error ?? probe.error

  return (
    <li className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {system.name}
            {system.kind === 'link' && (
              <span className="rounded-full border border-muted-foreground/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                link
              </span>
            )}
            {isStub(system.base_url) && (
              <span className="rounded-full border border-muted-foreground/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                stub
              </span>
            )}
            {!system.enabled && (
              <span className="rounded-full border border-muted-foreground/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                off
              </span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {system.url ?? system.base_url}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {system.stored_token
              ? `token ${system.token_preview ?? 'stored'}`
              : 'no token — open to anyone who can reach it'}
            {' · '}
            {system.scopes.join(', ')}
          </p>

          {system.last_error ? (
            <p className="mt-1.5 text-xs text-red-700 dark:text-red-400">
              {system.failing_since && (
                <>failing since {formatRelativeTime(system.failing_since)} — </>
              )}
              {system.last_error}
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-muted-foreground">
              {system.last_ok_at
                ? `answered ${formatRelativeTime(system.last_ok_at)}`
                : 'not reached yet'}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => probe.mutate(system.id)}
            disabled={probe.isPending}
          >
            {probe.isPending ? 'Checking…' : 'Check'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setReplacing(!replacing)}>
            Replace token
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => update.mutate({ id: system.id, enabled: !system.enabled })}
            disabled={update.isPending}
          >
            {system.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="text-red-700 dark:text-red-400"
            onClick={() => {
              if (confirm(`Remove ${system.name}? Its open decisions go with it.`)) {
                remove.mutate(system.id)
              }
            }}
            disabled={remove.isPending}
          >
            Remove
          </Button>
        </div>
      </div>

      {replacing && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3"
          onSubmit={(e) => {
            e.preventDefault()
            update.mutate({ id: system.id, token })
            setToken('')
            setReplacing(false)
          }}
        >
          <div className="min-w-[14rem] flex-1">
            <label className="block text-xs font-medium" htmlFor={`token-${system.id}`}>
              Token
            </label>
            <input
              id={`token-${system.id}`}
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="paste the CEO token"
              className={`mt-1 w-full ${INPUT}`}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Stored sealed and never shown again — only the last few characters come back.
            </p>
          </div>
          <Button type="submit" size="sm" disabled={token.trim() === '' || update.isPending}>
            Save
          </Button>
          <Button variant="outline" size="sm" type="button" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        </form>
      )}

      {probe.data && (
        <p
          className={`mt-2 flex items-center gap-1.5 text-xs ${
            probe.data.ok
              ? 'text-emerald-700 dark:text-emerald-500'
              : 'text-red-700 dark:text-red-400'
          }`}
        >
          {probe.data.ok ? (
            <>
              <Check className="size-3.5" aria-hidden /> it answered
            </>
          ) : (
            <>
              <X className="size-3.5" aria-hidden /> {probe.data.error}
            </>
          )}
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

function AddSystem() {
  const create = useCreateSystem()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<SystemKind>('link')
  const [baseUrl, setBaseUrl] = useState('')
  const [url, setUrl] = useState('')
  const [icon, setIcon] = useState('')
  const [category, setCategory] = useState('')
  const [token, setToken] = useState('')

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Add a system
      </Button>
    )
  }

  // A link only needs somewhere to go; a system also needs the door Lyra polls.
  const ready =
    name.trim() !== '' && (kind === 'link' ? url.trim() !== '' : baseUrl.trim() !== '')

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        create
          .mutateAsync({
            name: name.trim(),
            kind,
            // A link has no API door, so its address is the one you click. Sending it as both
            // keeps one column authoritative instead of leaving `base_url` empty and special.
            base_url: (kind === 'link' ? url || baseUrl : baseUrl).trim(),
            url: (url || baseUrl).trim() || undefined,
            icon: icon.trim() || undefined,
            category: category.trim() || undefined,
            token: token.trim() || undefined,
          })
          .then(() => {
            setOpen(false)
            setName('')
            setUrl('')
            setBaseUrl('')
            setIcon('')
            setCategory('')
            setToken('')
          })
          .catch(() => {
            /* the error renders below; the form keeps what was typed */
          })
      }}
    >
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[10rem] flex-1">
          <label className="block text-xs font-medium" htmlFor="system-name">
            Name
          </label>
          <input
            id="system-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="content-factory"
            className={`mt-1 w-full ${INPUT}`}
          />
        </div>
        <div>
          <label className="block text-xs font-medium" htmlFor="system-kind">
            What is it
          </label>
          <select
            id="system-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as SystemKind)}
            className={`mt-1 ${INPUT}`}
          >
            <option value="link">A link — just a tile</option>
            <option value="system">A system — Lyra asks it things</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="min-w-[14rem] flex-[2]">
          <label className="block text-xs font-medium" htmlFor="system-open-url">
            Opens
          </label>
          <input
            id="system-open-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://factory.tailnet.ts.net"
            className={`mt-1 w-full ${INPUT}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Where the tile takes you. Use the Tailscale name, not an IP — a lease moves and the
            tile breaks.
          </p>
        </div>
        <div className="min-w-[8rem] flex-1">
          <label className="block text-xs font-medium" htmlFor="system-category">
            Group
          </label>
          <input
            id="system-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Home server"
            className={`mt-1 w-full ${INPUT}`}
          />
        </div>
        <div className="min-w-[8rem] flex-1">
          <label className="block text-xs font-medium" htmlFor="system-icon">
            Icon
          </label>
          <input
            id="system-icon"
            value={icon}
            onChange={(e) => setIcon(e.target.value)}
            placeholder="server"
            className={`mt-1 w-full ${INPUT}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            A name, not a URL. Anything unknown shows the first letter.
          </p>
        </div>
      </div>

      {kind === 'system' && (
        <div>
          <label className="block text-xs font-medium" htmlFor="system-api-url">
            API door
          </label>
          <input
            id="system-api-url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://factory:8080"
            className={`mt-1 w-full ${INPUT}`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Where Lyra polls, which is usually not where you go — that one answers JSON. Or{' '}
            <code className="font-mono">fixture:///path/to/decisions.json</code> to stand in for a
            system that is still being built.
          </p>
        </div>
      )}

      <div>
        <label className="block text-xs font-medium" htmlFor="system-token">
          Token
        </label>
        <input
          id="system-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="optional for a stub or a service on this host"
          className={`mt-1 w-full ${INPUT}`}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={!ready || create.isPending}>
          {create.isPending ? 'Saving…' : 'Add system'}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {isStub(baseUrl) && (
          <span className="text-xs text-muted-foreground">this one is a stub</span>
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
