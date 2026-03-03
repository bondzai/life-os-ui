import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Entity } from '@/core/types'

interface WalletCardProps {
  wallet: Entity
  onEdit: (wallet: Entity) => void
  onDelete: (wallet: Entity) => void
}

function truncateAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

export function WalletCard({ wallet, onEdit, onDelete }: WalletCardProps) {
  const walletType = wallet.metadata.walletType as string
  const chain = wallet.metadata.chain as string | undefined
  const address = wallet.metadata.address as string | undefined
  const platform = wallet.metadata.platform as string | undefined

  const typeLabel = walletType === 'cex' ? 'CEX' : walletType.charAt(0).toUpperCase() + walletType.slice(1)
  const subtitle = [platform, chain].filter(Boolean).join(' / ')

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{wallet.title}</CardTitle>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <Badge variant="outline" className="text-xs shrink-0">
            {typeLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {address && (
          <p className="text-xs text-muted-foreground font-mono">{truncateAddress(address)}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(wallet)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(wallet)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
