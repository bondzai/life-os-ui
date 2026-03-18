import { useState } from 'react'
import { Sparkles, Plus, Pencil, FileCode2, ChevronDown, ChevronRight, Tag } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { APP_VERSION, CHANGELOG } from '@/lib/changelog-data'

interface ChangelogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const sectionIcon: Record<string, React.ReactNode> = {
  Added: <Plus className="h-3.5 w-3.5" />,
  Changed: <Pencil className="h-3.5 w-3.5" />,
  'New Files': <FileCode2 className="h-3.5 w-3.5" />,
}

const sectionColor: Record<string, string> = {
  Added: 'text-green-500',
  Changed: 'text-blue-500',
  'New Files': 'text-purple-500',
}

export function ChangelogDialog({ open, onOpenChange }: ChangelogDialogProps) {
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(() => {
    // Latest version expanded by default
    return new Set(CHANGELOG.length > 0 ? [CHANGELOG[0].version] : [])
  })

  const toggleVersion = (version: string) => {
    setExpandedVersions((prev) => {
      const next = new Set(prev)
      if (next.has(version)) next.delete(version)
      else next.add(version)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] p-0 gap-0 overflow-hidden">
        {/* Hero header */}
        <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent px-6 pt-6 pb-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
                <Sparkles className="h-5 w-5 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-xl">What's New</DialogTitle>
                <DialogDescription className="mt-0.5">
                  Lyra changelog and release history
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Current version pill */}
          <div className="flex items-center gap-2 mt-4">
            <Badge variant="default" className="text-xs px-2.5 py-0.5 gap-1">
              <Tag className="h-3 w-3" />
              v{APP_VERSION}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {CHANGELOG[0]?.phase}
            </span>
          </div>
        </div>

        <Separator />

        {/* Release list */}
        <ScrollArea className="h-[55vh]">
          <div className="px-6 py-4 space-y-1">
            {CHANGELOG.map((release, i) => {
              const isExpanded = expandedVersions.has(release.version)
              const isLatest = i === 0

              return (
                <div key={release.version}>
                  {/* Version header — clickable accordion */}
                  <button
                    onClick={() => toggleVersion(release.version)}
                    className="w-full flex items-center gap-3 py-2.5 px-3 -mx-3 rounded-lg hover:bg-accent/50 transition-colors text-left group"
                  >
                    <div className="shrink-0">
                      {isExpanded
                        ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        : <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      }
                    </div>

                    {/* Timeline dot */}
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      isLatest ? 'bg-primary ring-4 ring-primary/20' : 'bg-muted-foreground/30'
                    }`} />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">v{release.version}</span>
                        {isLatest && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                            Latest
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground ml-auto shrink-0">
                          {formatDate(release.date)}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{release.phase}</p>
                    </div>
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="ml-12 pb-4 pt-1 space-y-3">
                      {release.sections.map((section) => (
                        <div key={section.title}>
                          <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-1.5 ${sectionColor[section.title] ?? 'text-muted-foreground'}`}>
                            {sectionIcon[section.title]}
                            {section.title}
                          </div>
                          <ul className="space-y-1">
                            {section.items.map((item, j) => (
                              <li key={j} className="text-sm text-muted-foreground leading-relaxed flex gap-2">
                                <span className="text-muted-foreground/50 shrink-0 mt-1.5">
                                  <span className="block w-1 h-1 rounded-full bg-current" />
                                </span>
                                <span dangerouslySetInnerHTML={{ __html: formatItem(item) }} />
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}

                  {i < CHANGELOG.length - 1 && !isExpanded && (
                    <div className="ml-[2.05rem] border-l border-dashed h-2" />
                  )}
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatItem(text: string): string {
  // Bold **text** → <strong>
  return text.replace(/\*\*(.+?)\*\*/g, '<strong class="text-foreground font-medium">$1</strong>')
    // Inline code `text` → <code>
    .replace(/`(.+?)`/g, '<code class="text-[11px] bg-muted px-1 py-0.5 rounded font-mono">$1</code>')
}
