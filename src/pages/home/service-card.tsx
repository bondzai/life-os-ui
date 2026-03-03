import { Pencil, Trash2, Globe, Container } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { SERVICE_STATUS_COLORS, type ServiceStatus, type ServiceType } from './home-helpers'
import type { Entity } from '@/core/types'

interface ServiceCardProps {
  service: Entity
  deviceName?: string
  onEdit: (service: Entity) => void
  onDelete: (service: Entity) => void
}

export function ServiceCard({ service, deviceName, onEdit, onDelete }: ServiceCardProps) {
  const serviceType = service.metadata.serviceType as ServiceType
  const serviceStatus = service.metadata.serviceStatus as ServiceStatus
  const url = service.metadata.url as string | undefined
  const port = service.metadata.port as number | undefined
  const image = service.metadata.image as string | undefined
  const note = service.metadata.note as string | undefined

  const typeLabel = serviceType === 'api' ? 'API' : serviceType.charAt(0).toUpperCase() + serviceType.slice(1)
  const statusLabel = serviceStatus.charAt(0).toUpperCase() + serviceStatus.slice(1)
  const subtitle = [deviceName, image].filter(Boolean).join(' / ')

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{service.title}</CardTitle>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <Badge variant="outline" className="text-xs">
              {typeLabel}
            </Badge>
            <Badge className={`text-xs ${SERVICE_STATUS_COLORS[serviceStatus] || ''}`}>
              {statusLabel}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          {url && (
            <span className="flex items-center gap-1">
              <Globe className="h-3.5 w-3.5" />
              <span className="font-mono text-xs">{url}</span>
            </span>
          )}
          {!url && port && (
            <span className="flex items-center gap-1">
              <Container className="h-3.5 w-3.5" />
              <span className="font-mono text-xs">:{port}</span>
            </span>
          )}
        </div>
        {note && (
          <p className="text-xs text-muted-foreground italic">{note}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(service)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(service)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
