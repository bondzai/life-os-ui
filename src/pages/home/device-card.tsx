import { Pencil, Trash2, Wifi, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { DEVICE_TYPE_COLORS, type DeviceType } from './home-helpers'
import type { Entity } from '@/core/types'

interface DeviceCardProps {
  device: Entity
  onEdit: (device: Entity) => void
  onDelete: (device: Entity) => void
}

export function DeviceCard({ device, onEdit, onDelete }: DeviceCardProps) {
  const deviceType = device.metadata.deviceType as DeviceType
  const ip = device.metadata.ip as string | undefined
  const os = device.metadata.os as string | undefined
  const location = device.metadata.location as string | undefined
  const note = device.metadata.note as string | undefined

  const typeLabel = deviceType === 'iot' ? 'IoT' : deviceType.charAt(0).toUpperCase() + deviceType.slice(1)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{device.title}</CardTitle>
            {os && (
              <p className="text-xs text-muted-foreground mt-0.5">{os}</p>
            )}
          </div>
          <Badge className={`text-xs shrink-0 ${DEVICE_TYPE_COLORS[deviceType] || ''}`}>
            {typeLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {ip && (
            <span className="flex items-center gap-1">
              <Wifi className="h-3.5 w-3.5" />
              <span className="font-mono text-xs">{ip}</span>
            </span>
          )}
          {location && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3.5 w-3.5" />
              {location}
            </span>
          )}
        </div>
        {note && (
          <p className="text-xs text-muted-foreground italic">{note}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(device)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(device)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
