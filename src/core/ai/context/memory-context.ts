import type { LyraMemory } from '@/hooks/use-lyra-memory'

export function buildMemoryContext(memories: LyraMemory[]): string {
  if (memories.length === 0) return ''

  const lines = ["## Lyra's Memory (from past conversations):"]
  for (const m of memories) {
    const detail = m.entity.description ? ` — ${m.entity.description}` : ''
    lines.push(`- [${m.category}] ${m.entity.title}${detail}`)
  }
  lines.push('')
  lines.push(
    "Reference these memories naturally when relevant. Don't force them into every response.",
  )

  return lines.join('\n')
}
