import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataTable, type Column } from '@/core/components/data-table'
import { formatTHB } from './wealth-helpers'
import type { Entity } from '@/core/types'

interface CryptoTxTableProps {
  transactions: Entity[]
  wallets: Entity[]
  onEdit: (tx: Entity) => void
  onDelete: (tx: Entity) => void
}

const ACTION_COLORS: Record<string, string> = {
  buy: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  sell: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  swap: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  'transfer-in': 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  'transfer-out': 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
}

const ACTION_LABELS: Record<string, string> = {
  buy: 'Buy',
  sell: 'Sell',
  swap: 'Swap',
  'transfer-in': 'Transfer In',
  'transfer-out': 'Transfer Out',
}

export function CryptoTxTable({ transactions, wallets, onEdit, onDelete }: CryptoTxTableProps) {
  const walletMap = new Map(wallets.map((w) => [w.id, w.title]))

  const columns: Column<Entity>[] = [
    {
      key: 'date',
      label: 'Date',
      sortable: true,
      render: (tx) => (tx.metadata.date as string) || '—',
    },
    {
      key: 'action',
      label: 'Action',
      render: (tx) => {
        const action = tx.metadata.txAction as string
        return (
          <Badge className={ACTION_COLORS[action] || ''}>
            {ACTION_LABELS[action] || action}
          </Badge>
        )
      },
    },
    {
      key: 'symbol',
      label: 'Symbol',
      render: (tx) => (
        <span className="font-medium">{(tx.metadata.symbol as string) || '—'}</span>
      ),
    },
    {
      key: 'quantity',
      label: 'Qty',
      sortable: true,
      render: (tx) => {
        const qty = tx.metadata.quantity as number
        return qty?.toLocaleString(undefined, { maximumFractionDigits: 8 }) || '—'
      },
    },
    {
      key: 'price',
      label: 'Price',
      render: (tx) => {
        const price = tx.metadata.pricePerUnit as number | undefined
        return price ? formatTHB(price) : '—'
      },
    },
    {
      key: 'total',
      label: 'Total',
      render: (tx) => {
        const qty = tx.metadata.quantity as number
        const price = tx.metadata.pricePerUnit as number | undefined
        if (qty && price) return formatTHB(qty * price)
        return (tx.metadata.totalValue as number) ? formatTHB(tx.metadata.totalValue as number) : '—'
      },
    },
    {
      key: 'fee',
      label: 'Fee',
      render: (tx) => {
        const fee = tx.metadata.fee as number | undefined
        return fee ? formatTHB(fee) : '—'
      },
    },
    {
      key: 'wallet',
      label: 'Wallet',
      render: (tx) => {
        const wId = tx.metadata.walletId as string | undefined
        const toWId = tx.metadata.toWalletId as string | undefined
        const from = wId ? walletMap.get(wId) : undefined
        const to = toWId ? walletMap.get(toWId) : undefined
        if (from && to) return <span className="text-xs">{from} → {to}</span>
        return from || '—'
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
