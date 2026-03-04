import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Entity } from '@/core/types'

interface UseUndoDeleteOptions {
  remove: { mutate: (id: string) => void }
  create: { mutate: (item: Entity) => void }
  entityLabel?: string
}

export function useUndoDelete({ remove, create, entityLabel = 'Item' }: UseUndoDeleteOptions) {
  const handleDelete = useCallback(
    (entity: Entity) => {
      remove.mutate(entity.id)
      toast.success(`${entityLabel} deleted`, {
        action: {
          label: 'Undo',
          onClick: () => create.mutate({ ...entity }),
        },
        duration: 5000,
      })
    },
    [remove, create, entityLabel],
  )

  return handleDelete
}
