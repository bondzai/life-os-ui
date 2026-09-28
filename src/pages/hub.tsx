/**
 * The hub — one way in to everything on the tailnet.
 *
 * Heimdall-shaped, with one difference that is the whole point: the tiles come from the same
 * `systems` rows Lyra already polls, so the dot that says the factory is up is the *same fact* the
 * decision inbox is working from. Two tables would have meant two dots that can disagree.
 *
 * What needs you comes before where to go. A launcher you open and immediately leave has told you
 * nothing; this one answers "is anything waiting?" in the first screenful.
 *
 * Three things worth knowing about the build:
 *
 * **No icon CDN.** A dashboard full of broken images when the house internet is down — exactly when
 * you would open it — is worse than one with letters in circles. A small bundled set by name, and a
 * monogram for everything else. Importing all of lucide to render eight tiles would cost more than
 * the page.
 *
 * **One pass to group.** `filter` per category is O(tiles x categories); a single reduce is O(n) and
 * keeps the order the server sorted them in.
 *
 * **Tiles open `url`, never `base_url`.** The API door answers JSON.
 *
 * **Everything red at once is one fault, not many.** Two services failing in the same minute is
 * possible; eight is Tailscale on the box. Saying so is the difference between checking one thing
 * and checking eight.
 *
 * Filtering is `/` and a box, not a command palette. This app already navigates with `g <key>`, and
 * a second global mechanism competing with it would be the more complicated answer to "at fifteen
 * tiles, typing beats hunting".
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bot,
  Boxes,
  Clapperboard,
  Cloud,
  Database,
  Factory,
  Film,
  Gauge,
  Github,
  HardDrive,
  Home,
  Loader2,
  Network,
  Search,
  Router,
  Server,
  Shield,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { EmptyState } from '@/core/components/empty-state'
import { formatRelativeTime } from '@/pages/wealth/format'
import { WaitingOnYou } from '@/pages/today/waiting-on-you'
import { useSystems, type System } from '@/core/hooks/use-systems'

/**
 * The icons a tile may name.
 *
 * A fixed set, bundled. Anything else falls back to a monogram, which is why this can stay short
 * without the page looking broken — add a name here when you actually want one.
 */
const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  bot: Bot,
  box: Boxes,
  clapperboard: Clapperboard,
  cloud: Cloud,
  database: Database,
  factory: Factory,
  film: Film,
  gauge: Gauge,
  github: Github,
  home: Home,
  network: Network,
  router: Router,
  server: Server,
  shield: Shield,
  storage: HardDrive,
  terminal: Terminal,
  wrench: Wrench,
}

const UNFILED = 'Everything else'

/** Alive, failing, or never reached. Kept as a word so nothing decides on colour alone. */
type Health = 'up' | 'down' | 'unknown'

function healthOf(system: System): Health {
  if (system.last_error) return 'down'
  return system.last_ok_at ? 'up' : 'unknown'
}

/**
 * Whether a tile survives the filter.
 *
 * Name, group and address, because you reach for a tile by whichever of those you remember — and
 * the address is often the only thing you can recall about a box you visit twice a year.
 */
function matches(system: System, needle: string): boolean {
  return (
    system.name.toLowerCase().includes(needle) ||
    (system.category?.toLowerCase().includes(needle) ?? false) ||
    (system.url ?? system.base_url).toLowerCase().includes(needle)
  )
}

const DOT: Record<Health, string> = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
}

export function HubPage() {
  const systems = useSystems()
  const list = systems.data?.systems
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)

  // `/` to search, the way every list on the web has for thirty years. Not ⌘K: this app navigates
  // with `g <key>`, and a second global mechanism competing with it is the more complicated answer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      // Not while someone is typing somewhere else, or `/` stops being typeable.
      if (target?.matches('input, textarea, [contenteditable]')) return
      e.preventDefault()
      search.current?.focus()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // Filtered and grouped in **one** pass, in the order the server sorted them — so `sort` means
  // something and a category appears where its first tile does rather than alphabetically.
  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const groups = new Map<string, System[]>()
    for (const system of list ?? []) {
      if (!system.enabled) continue
      if (needle && !matches(system, needle)) continue
      const key = system.category?.trim() || UNFILED
      const bucket = groups.get(key)
      if (bucket) bucket.push(system)
      else groups.set(key, [system])
    }
    return [...groups]
  }, [list, query])

  /** The first tile the current filter leaves, so Enter can open it. */
  const top = grouped[0]?.[1]?.[0]

  // Counted over everything enabled rather than over the filter, because "3 up" has to mean the
  // network, not whatever you happen to have typed.
  const counts = useMemo(() => {
    let up = 0
    let down = 0
    for (const system of list ?? []) {
      if (!system.enabled) continue
      const health = healthOf(system)
      if (health === 'up') up += 1
      else if (health === 'down') down += 1
    }
    return { up, down }
  }, [list])

  // Two services failing in the same minute is possible. Eight is the box losing the tailnet, and
  // reporting that as eight separate faults sends you to check eight things.
  const allDown = counts.down > 1 && counts.up === 0

  if (systems.isError) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {systems.error.message}
      </p>
    )
  }

  if (!list) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Reading the network…
      </p>
    )
  }

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">The network</h1>
        {(counts.up > 0 || counts.down > 0) && (
          <p className="text-sm text-muted-foreground tabular-nums">
            {counts.up} up
            {counts.down > 0 && (
              <span className="text-red-700 dark:text-red-400"> · {counts.down} not answering</span>
            )}
          </p>
        )}
      </header>

      {allDown && (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-500"
        >
          <strong className="font-medium">Nothing on the network is answering.</strong> All{' '}
          {counts.down} of them failed their last check, which is almost always Tailscale on the box
          rather than {counts.down} services going down together. Check{' '}
          <code className="font-mono text-xs">tailscale status</code> there first.
        </p>
      )}

      {/* What needs you, before where to go. Renders nothing when nothing is waiting. */}
      <WaitingOnYou />

      {/* Only once there are enough tiles for hunting to be slower than typing. */}
      {(list.length > 6 || query !== '') && (
        <div className="relative max-w-sm">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            ref={search}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('')
              // Enter opens the top hit, so the whole interaction is type-three-letters-enter.
              if (e.key === 'Enter' && top) {
                window.open(top.url ?? top.base_url, '_blank', 'noreferrer')
              }
            }}
            placeholder="Filter — press / from anywhere"
            aria-label="Filter the network"
            className="w-full rounded-md border bg-background py-2 pr-3 pl-9 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
      )}

      {grouped.length === 0 ? (
        query !== '' ? (
          <p className="text-sm text-muted-foreground">
            Nothing matches &ldquo;{query}&rdquo;.
          </p>
        ) : (
          <EmptyState
            icon={Boxes}
            title="Nothing on the network yet"
            description="Add a system in Settings and it turns up here. A fixture:// address stands in for one that is still being built."
          />
        )
      ) : (
        grouped.map(([category, tiles]) => (
          <section key={category} className="space-y-3" aria-labelledby={`cat-${category}`}>
            <h2
              id={`cat-${category}`}
              className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
            >
              {category}
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {tiles.map((system) => (
                <Tile key={system.id} system={system} />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}

function Tile({ system }: { system: System }) {
  const health = healthOf(system)
  // `url` is where a person goes; `base_url` answers JSON. Falling back to it is better than a
  // dead tile, but the row is misconfigured and the title says so.
  const href = system.url ?? system.base_url
  const Icon = system.icon ? ICONS[system.icon] : undefined

  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={system.last_error ?? `Open ${system.name}`}
        className="flex h-full items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
          {Icon ? (
            <Icon className="size-4.5" aria-hidden />
          ) : (
            // The monogram. Cheaper than an icon set and never a broken image.
            <span aria-hidden className="text-sm font-semibold text-muted-foreground">
              {system.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{system.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            {/* Colour and a word: a dot alone is unreadable to anyone who cannot tell red from
                green, and "not answering" is the part that matters anyway. */}
            <span className={`size-1.5 shrink-0 rounded-full ${DOT[health]}`} aria-hidden />
            <span className="truncate">
              {health === 'down'
                ? 'not answering'
                : health === 'up'
                  ? system.last_ok_at
                    ? formatRelativeTime(system.last_ok_at)
                    : 'up'
                  : 'not checked yet'}
            </span>
          </span>
        </span>
      </a>
    </li>
  )
}
