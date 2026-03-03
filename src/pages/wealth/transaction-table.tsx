import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataTable, type Column } from '@/core/components/data-table'
import { formatTHB } from './wealth-helpers'
import type { Entity } from '@/core/types'

interface TransactionTableProps {
  transactions: Entity[]
  onEdit: (tx: Entity) => void
  onDelete: (tx: Entity) => void
}

export function TransactionTable({ transactions, onEdit, onDelete }: TransactionTableProps) {
  const columns: Column<Entity>[] = [
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      render: (tx) => (tx.metadata.date as string) || tx.dueDate || '—',
    },
    {
      key: 'title',
      label: 'Title',
      sortable: true,
      render: (tx) => tx.title,
    },
    {
      key: 'category',
      label: 'Category',
      render: (tx) => (
        <Badge variant="outline" className="capitalize">
          {tx.metadata.category as string}
        </Badge>
      ),
    },
    {
      key: 'type',
      label: 'Type',
      render: (tx) =>
        tx.metadata.txType === 'income' ? (
          <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
            Income
          </Badge>
        ) : (
          <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
            Expense
          </Badge>
        ),
    },
    {
      key: 'amount',
      label: 'Amount',
      sortable: true,
      render: (tx) => {
        const amount = tx.metadata.amount as number
        const isIncome = tx.metadata.txType === 'income'
        return (
          <span className={isIncome ? 'text-green-600' : 'text-red-600'}>
            {isIncome ? '+' : '-'}{formatTHB(amount)}
          </span>
        )
      },
    },
    {
      key: 'actions',
      label: '',
      render: (tx) => (
        <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(tx)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(tx)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ]

  return <DataTable data={transactions} columns={columns} />
}
