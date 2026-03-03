import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatTHB } from './wealth-helpers'
import type { Entity } from '@/core/types'

interface AccountCardProps {
  account: Entity
  onEdit: (account: Entity) => void
  onDelete: (account: Entity) => void
}

export function AccountCard({ account, onEdit, onDelete }: AccountCardProps) {
  const balance = account.metadata.balance as number
  const accountType = account.metadata.accountType as string
  const institution = account.metadata.institution as string | undefined
  const isCredit = accountType === 'credit'

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{account.title}</CardTitle>
            {institution && (
              <p className="text-xs text-muted-foreground">{institution}</p>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <Badge variant="outline" className="text-xs capitalize">
              {accountType}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className={`text-2xl font-bold ${isCredit ? 'text-red-600' : ''}`}>
          {isCredit && balance > 0 ? '-' : ''}{formatTHB(balance)}
        </p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(account)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(account)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
