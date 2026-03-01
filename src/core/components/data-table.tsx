import { useState, useMemo } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export interface Column<T> {
  key: string
  label: string
  render: (item: T) => React.ReactNode
  sortable?: boolean
}

interface DataTableProps<T> {
  data: T[]
  columns: Column<T>[]
  onRowClick?: (item: T) => void
}

export function DataTable<T extends { id: string }>({
  data,
  columns,
  onRowClick,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortAsc, setSortAsc] = useState(true)

  const sorted = useMemo(() => {
    if (!sortKey) return data
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return data
    return [...data].sort((a, b) => {
      const aVal = String(col.render(a))
      const bVal = String(col.render(b))
      return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
    })
  }, [data, columns, sortKey, sortAsc])

  const handleSort = (key: string, sortable?: boolean) => {
    if (!sortable) return
    if (sortKey === key) {
      setSortAsc(!sortAsc)
    } else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((col) => (
            <TableHead
              key={col.key}
              className={col.sortable ? 'cursor-pointer select-none' : ''}
              onClick={() => handleSort(col.key, col.sortable)}
            >
              {col.label}
              {col.sortable && sortKey === col.key && (sortAsc ? ' \u2191' : ' \u2193')}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((item) => (
          <TableRow
            key={item.id}
            className={onRowClick ? 'cursor-pointer' : ''}
            onClick={() => onRowClick?.(item)}
          >
            {columns.map((col) => (
              <TableCell key={col.key}>{col.render(item)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
