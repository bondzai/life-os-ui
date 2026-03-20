import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Maximize2, X, ExternalLink, NotebookPen } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useEntities } from '@/core/hooks'
import { useRelations } from '@/core/hooks/use-relations'
import type { Entity } from '@/core/types'
import { useNoteGraph } from './note-map/use-note-graph'
import { nodeTypes, MapActionsContext, type NoteMapActions } from './note-map/map-nodes'

export function NoteMapPage() {
  const [showJournals, setShowJournals] = useState(false)
  const { nodes, edges, noteCount, tagCount, relationCount } = useNoteGraph(showJournals)
  const { items: allNotes } = useEntities('note')
  const { items: relations } = useRelations()
  const navigate = useNavigate()
  const rfRef = useRef<ReactFlowInstance | null>(null)
  const [selected, setSelected] = useState<Entity | null>(null)
  const [selectedTag, setSelectedTag] = useState<string | null>(null)

  const handleFitView = useCallback(() => {
    rfRef.current?.fitView({ padding: 0.2 })
  }, [])

  // Connected notes for the detail panel
  const connectedNotes = useMemo(() => {
    if (!selected) return []
    const connected: { entity: Entity; relationType: string }[] = []
    for (const rel of relations) {
      if (rel.fromId === selected.id) {
        const target = allNotes.find((n) => n.id === rel.toId)
        if (target) connected.push({ entity: target, relationType: rel.type })
      } else if (rel.toId === selected.id) {
        const source = allNotes.find((n) => n.id === rel.fromId)
        if (source) connected.push({ entity: source, relationType: rel.type })
      }
    }
    return connected
  }, [selected, relations, allNotes])

  // Shared tags — tags on the selected note that also appear on other notes
  const sharedTags = useMemo(() => {
    if (!selected) return []
    return selected.tags.filter((tag) =>
      allNotes.some((n) => n.id !== selected.id && n.tags.includes(tag)),
    )
  }, [selected, allNotes])

  const actions: NoteMapActions = useMemo(() => ({
    onNodeClick: (noteId) => {
      const note = allNotes.find((n) => n.id === noteId)
      if (note) {
        setSelected(note)
        setSelectedTag(null)
      }
    },
    onTagClick: (tag) => {
      setSelectedTag(tag)
      setSelected(null)
      toast(`Tag: ${tag}`, { description: `Filtering to notes tagged "${tag}"` })
    },
  }), [allNotes])

  // Filter nodes/edges when a tag is selected
  const filteredNodes = useMemo(() => {
    if (!selectedTag) return nodes
    const noteIdsWithTag = new Set(
      allNotes.filter((n) => n.tags.includes(selectedTag)).map((n) => n.id),
    )
    return nodes.filter((n) => {
      if (n.type === 'note') return noteIdsWithTag.has(n.id)
      if (n.type === 'tag') return n.id === `tag__${selectedTag}`
      return true
    })
  }, [nodes, selectedTag, allNotes])

  const filteredEdges = useMemo(() => {
    if (!selectedTag) return edges
    const visibleIds = new Set(filteredNodes.map((n) => n.id))
    return edges.filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
  }, [edges, selectedTag, filteredNodes])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Note Map</h1>
          <span className="text-xs text-muted-foreground/50">
            {noteCount} notes · {tagCount} tags · {relationCount} relations
          </span>
        </div>
        <div className="flex items-center gap-2">
          {selectedTag && (
            <Button variant="outline" size="sm" onClick={() => setSelectedTag(null)}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              Clear filter
            </Button>
          )}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={showJournals}
              onChange={(e) => setShowJournals(e.target.checked)}
              className="rounded border-border"
            />
            Show Journals
          </label>
          <Button variant="outline" size="sm" onClick={handleFitView}>
            <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
            Fit View
          </Button>
        </div>
      </div>

      <div className="relative flex-1">
        <MapActionsContext.Provider value={actions}>
          <ReactFlow
            nodes={filteredNodes}
            edges={filteredEdges}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            onInit={(instance) => { rfRef.current = instance }}
            onPaneClick={() => { setSelected(null); setSelectedTag(null) }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: 'hsl(var(--border))' },
            }}
          >
            <Background variant={BackgroundVariant.Lines} gap={20} size={1} color="hsl(var(--border) / 0.4)" />
            <Controls
              showInteractive={false}
              className="!rounded-lg !border !border-border !bg-background !shadow-sm [&>button]:!border-border [&>button]:!bg-background [&>button]:!fill-foreground hover:[&>button]:!bg-muted"
            />
            <MiniMap
              nodeColor="hsl(var(--muted))"
              maskColor="hsl(var(--background) / 0.7)"
              className="!rounded-lg !border !border-border !bg-background/80 !shadow-sm"
            />
          </ReactFlow>
        </MapActionsContext.Provider>

        {/* Detail side panel */}
        {selected && (
          <div className="absolute right-0 top-0 h-full w-80 border-l bg-background shadow-lg overflow-y-auto animate-in slide-in-from-right-2 duration-200">
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <NotebookPen className="h-4 w-4" />
                  Note
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelected(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <h2 className="text-base font-semibold leading-snug">{selected.title}</h2>

              {selected.description && (
                <p className="text-sm text-muted-foreground leading-relaxed">{selected.description}</p>
              )}

              {selected.tags.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Tags</span>
                  <div className="flex flex-wrap gap-1">
                    {selected.tags.map((tag) => (
                      <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {connectedNotes.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    Connected Notes ({connectedNotes.length})
                  </span>
                  {connectedNotes.map(({ entity, relationType }) => (
                    <button
                      key={entity.id}
                      onClick={() => setSelected(entity)}
                      className="flex items-center gap-2 w-full text-left text-xs py-1 hover:bg-muted/50 rounded px-1.5 cursor-pointer"
                    >
                      <NotebookPen className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="flex-1">{entity.title}</span>
                      <span className="text-[10px] text-muted-foreground/50">{relationType}</span>
                    </button>
                  ))}
                </div>
              )}

              {sharedTags.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">Shared Tags</span>
                  <div className="flex flex-wrap gap-1">
                    {sharedTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => { setSelectedTag(tag); setSelected(null) }}
                        className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20 cursor-pointer"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="pt-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => navigate('/notes')}
                >
                  <ExternalLink className="mr-1.5 h-3 w-3" />
                  Open in Notes
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
