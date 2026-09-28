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
 */

import { useMemo } from 'react'
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

const DOT: Record<Health, string> = {
  up: 'bg-emerald-500',
  down: 'bg-red-500',
  unknown: 'bg-muted-foreground/40',
}

export function HubPage() {
  const systems = useSystems()
  const list = systems.data?.systems

  // One pass. Grouped in the order the server sorted them, so `sort` means something and the
  // categories appear in the order their first tile does rather than alphabetically.
  const grouped = useMemo(() => {
    const groups = new Map<string, System[]>()
    for (const system of list ?? []) {
      if (!system.enabled) continue
      const key = system.category?.trim() || UNFILED
      const bucket = groups.get(key)
      if (bucket) bucket.push(system)
      else groups.set(key, [system])
    }
    return [...groups]
  }, [list])

  const counts = useMemo(() => {
    let up = 0
    let down = 0
    for (const [, tiles] of grouped) {
      for (const tile of tiles) {
        const health = healthOf(tile)
        if (health === 'up') up += 1
        else if (health === 'down') down += 1
      }
    }
    return { up, down }
  }, [grouped])

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

      {/* What needs you, before where to go. Renders nothing when nothing is waiting. */}
      <WaitingOnYou />

      {grouped.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="Nothing on the network yet"
          description="Add a system in Settings and it turns up here. A fixture:// address stands in for one that is still being built."
        />
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
