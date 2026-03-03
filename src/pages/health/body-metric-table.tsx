import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataTable, type Column } from '@/core/components/data-table'
import { METRIC_UNITS, type BodyMetricType } from './health-helpers'
import type { Entity } from '@/core/types'

interface BodyMetricTableProps {
  metrics: Entity[]
  onEdit: (metric: Entity) => void
  onDelete: (metric: Entity) => void
}

export function BodyMetricTable({ metrics, onEdit, onDelete }: BodyMetricTableProps) {
  const columns: Column<Entity>[] = [
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      render: (m) => (m.metadata.date as string) || '—',
    },
    {
      key: 'metric',
      label: 'Metric',
      render: (m) => {
        const t = m.metadata.metricType as string
        return (
          <Badge variant="outline" className="capitalize">
            {t === 'body-fat' ? 'Body Fat' : t === 'bmi' ? 'BMI' : t}
          </Badge>
        )
      },
    },
    {
      key: 'value',
      label: 'Value',
      sortable: true,
      render: (m) => {
        const val = m.metadata.value as number
        const unit = METRIC_UNITS[m.metadata.metricType as BodyMetricType] || ''
        return (
          <span className="font-medium">
            {val}{unit ? ` ${unit}` : ''}
          </span>
        )
      },
    },
    {
      key: 'note',
      label: 'Note',
      render: (m) => (
        <span className="text-xs text-muted-foreground">{(m.metadata.note as string) || '—'}</span>
      ),
    },
    {
      key: 'actions',
      label: '',
      render: (m) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(m)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(m)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  return <DataTable data={metrics} columns={columns} />
}
