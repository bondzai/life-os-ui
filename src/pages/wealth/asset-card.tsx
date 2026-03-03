import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatTHB, getAssetValue, getAssetCost, formatGain } from './wealth-helpers'
import type { Entity } from '@/core/types'

interface AssetCardProps {
  asset: Entity
  walletName?: string
  onEdit: (asset: Entity) => void
  onDelete: (asset: Entity) => void
}

export function AssetCard({ asset, walletName, onEdit, onDelete }: AssetCardProps) {
  const assetClass = asset.metadata.assetClass as string
  const symbol = asset.metadata.symbol as string | undefined
  const chain = asset.metadata.chain as string | undefined
  const protocol = asset.metadata.protocol as string | undefined
  const platform = asset.metadata.platform as string | undefined

  const value = getAssetValue(asset)
  const cost = getAssetCost(asset)
  const gain = formatGain(cost, value)

  const subtitle = [walletName, platform, protocol, chain].filter(Boolean).join(' / ')

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium">{asset.title}</CardTitle>
              {symbol && (
                <Badge variant="secondary" className="text-xs">
                  {symbol}
                </Badge>
              )}
            </div>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <Badge variant="outline" className="text-xs capitalize shrink-0">
            {assetClass}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-2xl font-bold">{formatTHB(value)}</p>
        <p className={`text-sm font-medium ${gain.amount >= 0 ? 'text-green-600' : 'text-red-600'}`}>
          {gain.amount >= 0 ? '+' : ''}{formatTHB(gain.amount)} ({gain.pct >= 0 ? '+' : ''}{gain.pct.toFixed(1)}%)
        </p>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(asset)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(asset)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
