import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EntityForm } from './entity-form'
import type { Entity, EntityType } from '@/core/types'

interface EntityDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entityType: EntityType
  defaultValues?: Partial<Entity>
  onSubmit: (values: Record<string, unknown>) => void
  title?: string
}

export function EntityDialog({
  open,
  onOpenChange,
  entityType,
  defaultValues,
  onSubmit,
  title,
}: EntityDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title ?? `New ${entityType}`}</DialogTitle>
        </DialogHeader>
        <EntityForm
          entityType={entityType}
          defaultValues={defaultValues}
          onSubmit={(values) => {
            onSubmit(values)
            onOpenChange(false)
          }}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
