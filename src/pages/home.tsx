import { useState, useMemo } from 'react'
import { Plus, Monitor, Server, Container, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  DEVICE_TYPES,
  SERVICE_TYPES,
  type DeviceType,
  type ServiceType,
  type ServiceStatus,
} from './home/home-helpers'
import { DeviceDialog, type DeviceFormValues } from './home/device-dialog'
import { ServiceDialog, type ServiceFormValues } from './home/service-dialog'
import { DeviceCard } from './home/device-card'
import { ServiceCard } from './home/service-card'
import type { Entity } from '@/core/types'

export function HomePage() {
  const { items: devices, create: createDevice, update: updateDevice, remove: removeDevice } = useEntities('device')
  const { items: services, create: createService, update: updateService, remove: removeService } = useEntities('service')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('devices')
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all')
  const [serviceTypeFilter, setServiceTypeFilter] = useState('all')

  // Dialogs
  const [deviceDialogOpen, setDeviceDialogOpen] = useState(false)
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false)
  const [editingDevice, setEditingDevice] = useState<Entity | null>(null)
  const [editingService, setEditingService] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entity: Entity; type: 'device' | 'service' } | null>(null)

  // Summary stats
  const runningServices = useMemo(
    () => services.filter((s) => s.metadata.serviceStatus === 'running').length,
    [services],
  )

  const errorServices = useMemo(
    () => services.filter((s) => s.metadata.serviceStatus === 'error').length,
    [services],
  )

  // Device map for resolving names
  const deviceMap = useMemo(() => new Map(devices.map((d) => [d.id, d.title])), [devices])

  // Filtered lists
  const filteredDevices = useMemo(() => {
    if (deviceTypeFilter === 'all') return devices
    return devices.filter((d) => d.metadata.deviceType === deviceTypeFilter)
  }, [devices, deviceTypeFilter])

  const filteredServices = useMemo(() => {
    if (serviceTypeFilter === 'all') return services
    return services.filter((s) => s.metadata.serviceType === serviceTypeFilter)
  }, [services, serviceTypeFilter])

  // CRUD handlers
  const handleCreateDevice = (values: DeviceFormValues) => {
    createDevice.mutate({
      id: crypto.randomUUID(),
      type: 'device',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        deviceType: values.deviceType,
        ip: values.ip,
        mac: values.mac,
        os: values.os,
        location: values.location,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Device added', type: 'success' })
  }

  const handleEditDevice = (values: DeviceFormValues) => {
    if (!editingDevice) return
    updateDevice.mutate({
      id: editingDevice.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingDevice.metadata,
          deviceType: values.deviceType,
          ip: values.ip,
          mac: values.mac,
          os: values.os,
          location: values.location,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Device updated', type: 'success' })
    setEditingDevice(null)
  }

  const handleCreateService = (values: ServiceFormValues) => {
    createService.mutate({
      id: crypto.randomUUID(),
      type: 'service',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        serviceType: values.serviceType,
        serviceStatus: values.serviceStatus,
        url: values.url,
        port: values.port,
        deviceId: values.deviceId,
        image: values.image,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Service added', type: 'success' })
  }

  const handleEditService = (values: ServiceFormValues) => {
    if (!editingService) return
    updateService.mutate({
      id: editingService.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingService.metadata,
          serviceType: values.serviceType,
          serviceStatus: values.serviceStatus,
          url: values.url,
          port: values.port,
          deviceId: values.deviceId,
          image: values.image,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Service updated', type: 'success' })
    setEditingService(null)
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    const { entity, type } = deleteTarget
    if (type === 'device') removeDevice.mutate(entity.id)
    else removeService.mutate(entity.id)
    notify({ title: `${type.charAt(0).toUpperCase() + type.slice(1)} deleted`, type: 'success' })
    setDeleteTarget(null)
  }

  const addButton = (
    <Button
      size="sm"
      onClick={() => {
        if (tab === 'devices') setDeviceDialogOpen(true)
        else setServiceDialogOpen(true)
      }}
    >
      <Plus className="h-4 w-4 mr-1" /> Add
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Devices</CardTitle>
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{devices.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Services</CardTitle>
            <Container className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{services.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Running</CardTitle>
            <Wifi className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{runningServices}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Errors</CardTitle>
            <Server className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${errorServices > 0 ? 'text-red-600' : ''}`}>{errorServices}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="devices">Devices</TabsTrigger>
            <TabsTrigger value="services">Services</TabsTrigger>
          </TabsList>
          {addButton}
        </div>

        {/* Devices Tab */}
        <TabsContent value="devices" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={deviceTypeFilter} onValueChange={setDeviceTypeFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {DEVICE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === 'iot' ? 'IoT' : t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredDevices.length === 0 ? (
            <EmptyState
              icon={Monitor}
              title="No devices yet"
              description="Add your home server, computers, and IoT devices."
              actionLabel="New Device"
              onAction={() => setDeviceDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredDevices.map((device) => (
                <DeviceCard
                  key={device.id}
                  device={device}
                  onEdit={setEditingDevice}
                  onDelete={(d) => setDeleteTarget({ entity: d, type: 'device' })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Services Tab */}
        <TabsContent value="services" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={serviceTypeFilter} onValueChange={setServiceTypeFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {SERVICE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === 'api' ? 'API' : t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredServices.length === 0 ? (
            <EmptyState
              icon={Container}
              title="No services yet"
              description="Add your Docker containers, APIs, and web services."
              actionLabel="New Service"
              onAction={() => setServiceDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredServices.map((service) => (
                <ServiceCard
                  key={service.id}
                  service={service}
                  deviceName={service.metadata.deviceId ? deviceMap.get(service.metadata.deviceId as string) : undefined}
                  onEdit={setEditingService}
                  onDelete={(s) => setDeleteTarget({ entity: s, type: 'service' })}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialogs */}
      <DeviceDialog
        open={deviceDialogOpen}
        onOpenChange={setDeviceDialogOpen}
        onSubmit={handleCreateDevice}
      />
      <ServiceDialog
        open={serviceDialogOpen}
        onOpenChange={setServiceDialogOpen}
        onSubmit={handleCreateService}
        devices={devices.map((d) => ({ id: d.id, title: d.title }))}
      />

      {/* Edit dialogs */}
      <DeviceDialog
        open={!!editingDevice}
        onOpenChange={(open) => !open && setEditingDevice(null)}
        title="Edit Device"
        defaultValues={
          editingDevice
            ? {
                title: editingDevice.title,
                deviceType: editingDevice.metadata.deviceType as DeviceType,
                ip: (editingDevice.metadata.ip as string) || '',
                mac: (editingDevice.metadata.mac as string) || '',
                os: (editingDevice.metadata.os as string) || '',
                location: (editingDevice.metadata.location as string) || '',
                note: (editingDevice.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditDevice}
      />
      <ServiceDialog
        open={!!editingService}
        onOpenChange={(open) => !open && setEditingService(null)}
        title="Edit Service"
        defaultValues={
          editingService
            ? {
                title: editingService.title,
                serviceType: editingService.metadata.serviceType as ServiceType,
                serviceStatus: editingService.metadata.serviceStatus as ServiceStatus,
                url: (editingService.metadata.url as string) || '',
                port: editingService.metadata.port as number | undefined,
                deviceId: (editingService.metadata.deviceId as string) || '',
                image: (editingService.metadata.image as string) || '',
                note: (editingService.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditService}
        devices={devices.map((d) => ({ id: d.id, title: d.title }))}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type || ''}`}
        description={`Are you sure you want to delete "${deleteTarget?.entity.title}"?`}
        onConfirm={handleDelete}
      />
    </div>
  )
}
