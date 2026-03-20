import { useMemo } from 'react'
import type { Node, Edge } from '@xyflow/react'
import { useEntities } from '@/core/hooks'
import { useRelations } from '@/core/hooks/use-relations'
import type { Entity } from '@/core/types'

const RING_RADIUS = 400
const TAG_RADIUS = 120

function circlePosition(index: number, total: number, radius: number, cx: number, cy: number) {
  const angle = (2 * Math.PI * index) / total - Math.PI / 2
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
}

const RELATION_COLORS: Record<string, string> = {
  relates: 'hsl(217 91% 60%)',   // blue
  supports: 'hsl(142 71% 45%)',  // green
  blocks: 'hsl(0 84% 60%)',      // red
  parent: 'hsl(220 9% 46%)',     // gray
}

export function useNoteGraph(showJournals = false) {
  const { items: allEntities } = useEntities('note')
  const { items: relations } = useRelations()

  return useMemo(() => {
    // Filter notes
    const notes = allEntities.filter((e: Entity) => {
      if (e.status === 'archived') return false
      if (!showJournals && (e.metadata?.isJournal || e.metadata?.isInbox)) return false
      return true
    })

    const noteIds = new Set(notes.map((n) => n.id))

    // Collect tags with counts (only tags appearing on 2+ notes)
    const tagCounts = new Map<string, number>()
    for (const note of notes) {
      for (const tag of note.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1)
      }
    }
    const hubTags = Array.from(tagCounts.entries()).filter(([, count]) => count >= 2)

    // Center of layout
    const cx = 0
    const cy = 0

    const nodes: Node[] = []
    const edges: Edge[] = []

    // Tag hub nodes — placed in center area
    hubTags.forEach(([tag, count], index) => {
      const pos = hubTags.length === 1
        ? { x: cx, y: cy }
        : circlePosition(index, hubTags.length, TAG_RADIUS, cx, cy)
      nodes.push({
        id: `tag__${tag}`,
        type: 'tag',
        position: pos,
        data: { label: tag, count },
      })
    })

    // Note nodes — arranged in a ring around center
    notes.forEach((note, index) => {
      const pos = notes.length === 1
        ? { x: cx + RING_RADIUS, y: cy }
        : circlePosition(index, notes.length, RING_RADIUS, cx, cy)
      nodes.push({
        id: note.id,
        type: 'note',
        position: pos,
        data: {
          entity: note,
          title: note.title,
          tagCount: note.tags.length,
          isPinned: !!note.metadata?.isPinned,
        },
      })

      // Tag edges (note ↔ tag hub)
      for (const tag of note.tags) {
        if (tagCounts.get(tag)! >= 2) {
          edges.push({
            id: `te-${note.id}-${tag}`,
            source: note.id,
            target: `tag__${tag}`,
            style: { stroke: 'hsl(var(--border))', strokeDasharray: '4 4' },
          })
        }
      }
    })

    // Relation edges (note ↔ note)
    for (const rel of relations) {
      if (noteIds.has(rel.fromId) && noteIds.has(rel.toId)) {
        edges.push({
          id: `rel-${rel.id}`,
          source: rel.fromId,
          target: rel.toId,
          style: { stroke: RELATION_COLORS[rel.type] ?? 'hsl(var(--border))' },
          label: rel.type,
        })
      }
    }

    return {
      nodes,
      edges,
      noteCount: notes.length,
      tagCount: hubTags.length,
      relationCount: edges.filter((e) => e.id.startsWith('rel-')).length,
    }
  }, [allEntities, relations, showJournals])
}
