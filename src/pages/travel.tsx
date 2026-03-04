import { useState, useMemo, useEffect } from 'react'
import { Plus, Plane, Trash2, MapPin, DollarSign } from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import { useEntities, useRelations } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { TripItinerary } from './travel/trip-itinerary'
import type { Entity, EntityStatus } from '@/core/types'

// Fix Leaflet default marker icons
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

const DEFAULT_CENTER: [number, number] = [13.7563, 100.5018]
const DEFAULT_ZOOM = 6

function MapFitter({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length > 0) {
      const bounds = L.latLngBounds(positions.map(([lat, lng]) => L.latLng(lat, lng)))
      map.fitBounds(bounds, { padding: [40, 40] })
    }
  }, [map, positions])
  return null
}

export function TravelPage() {
  const { items: trips, isLoading: tripsLoading, create, update, remove } = useEntities('trip')
  const { items: allPlaces } = useEntities('place')
  const { items: relations, create: createRelation, remove: removeRelation } = useRelations()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)
  const [addPlaceId, setAddPlaceId] = useState<string>('')

  const filteredTrips = useMemo(() => {
    if (statusFilter === 'all') return trips
    return trips.filter((t) => t.status === statusFilter)
  }, [trips, statusFilter])

  const selectedTrip = useMemo(
    () => trips.find((t) => t.id === selectedTripId) ?? null,
    [trips, selectedTripId],
  )

  const tripPlaceIds = useMemo(() => {
    if (!selectedTripId) return []
    return relations
      .filter((r) => r.fromId === selectedTripId && r.type === 'relates')
      .map((r) => r.toId)
  }, [relations, selectedTripId])

  const tripPlaces = useMemo(
    () => allPlaces.filter((p) => tripPlaceIds.includes(p.id)),
    [allPlaces, tripPlaceIds],
  )

  const availablePlaces = useMemo(
    () => allPlaces.filter((p) => !tripPlaceIds.includes(p.id)),
    [allPlaces, tripPlaceIds],
  )

  const getCoords = (place: Entity): [number, number] | null => {
    const lat = typeof place.metadata.lat === 'number' ? place.metadata.lat : null
    const lng = typeof place.metadata.lng === 'number' ? place.metadata.lng : null
    if (lat !== null && lng !== null) return [lat, lng]
    return null
  }

  const tripCoords = useMemo(
    () => tripPlaces.map(getCoords).filter((c): c is [number, number] => c !== null),
    [tripPlaces],
  )

  const getPlaceCount = (tripId: string) =>
    relations.filter((r) => r.fromId === tripId && r.type === 'relates').length

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'trip',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { endDate: '' },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Trip created', type: 'success' })
  }

  const handleAddPlace = () => {
    if (!selectedTripId || !addPlaceId) return
    createRelation.mutate({
      id: crypto.randomUUID(),
      fromId: selectedTripId,
      toId: addPlaceId,
      type: 'relates',
    })
    setAddPlaceId('')
  }

  const handleRemovePlace = (placeId: string) => {
    const rel = relations.find(
      (r) => r.fromId === selectedTripId && r.toId === placeId && r.type === 'relates',
    )
    if (rel) removeRelation.mutate(rel.id)
  }

  if (tripsLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      {/* Left panel: Trip list */}
      <div className="w-80 shrink-0 flex flex-col gap-3 overflow-hidden">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
        >
          <SelectTrigger>
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>

        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Trip
        </Button>

        <div className="flex-1 overflow-y-auto space-y-2">
          {filteredTrips.length === 0 ? (
            <EmptyState
              icon={Plane}
              title="No trips yet"
              description="Plan your first trip."
              actionLabel="New Trip"
              onAction={() => setDialogOpen(true)}
            />
          ) : (
            filteredTrips.map((trip) => {
              const endDate = typeof trip.metadata.endDate === 'string' ? trip.metadata.endDate : ''
              const placeCount = getPlaceCount(trip.id)
              return (
                <Card
                  key={trip.id}
                  className={`cursor-pointer transition-colors ${selectedTripId === trip.id ? 'border-primary' : 'hover:bg-accent/50'}`}
                  onClick={() => setSelectedTripId(trip.id)}
                >
                  <CardHeader className="pb-1 pt-3 px-3">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm font-medium">{trip.title}</CardTitle>
                      <StatusBadge status={trip.status} />
                    </div>
                  </CardHeader>
                  <CardContent className="px-3 pb-3 space-y-1">
                    {(trip.dueDate || endDate) && (
                      <p className="text-xs text-muted-foreground">
                        {trip.dueDate && new Date(trip.dueDate).toLocaleDateString()}
                        {trip.dueDate && endDate && ' → '}
                        {endDate && new Date(endDate).toLocaleDateString()}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">
                        <MapPin className="h-3 w-3 mr-0.5" /> {placeCount} place{placeCount !== 1 ? 's' : ''}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>

      {/* Right panel: Trip detail + map */}
      <div className="flex-1 flex flex-col gap-3 overflow-hidden">
        {!selectedTrip ? (
          <div className="h-full flex items-center justify-center">
            <p className="text-sm text-muted-foreground">Select a trip to view details</p>
          </div>
        ) : (
          <>
            {/* Trip header + add place */}
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">{selectedTrip.title}</h3>
              <div className="flex items-center gap-2">
                {availablePlaces.length > 0 && (
                  <>
                    <Select value={addPlaceId} onValueChange={setAddPlaceId}>
                      <SelectTrigger className="w-[180px]">
                        <SelectValue placeholder="Add a place..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availablePlaces.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button size="sm" onClick={handleAddPlace} disabled={!addPlaceId}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDeleteTarget(selectedTrip)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Map */}
            <div className="flex-1 rounded-lg overflow-hidden border min-h-[300px]">
              <MapContainer
                center={DEFAULT_CENTER}
                zoom={DEFAULT_ZOOM}
                className="h-full w-full"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                {tripCoords.length > 0 && <MapFitter positions={tripCoords} />}
                {tripPlaces.map((place) => {
                  const coords = getCoords(place)
                  if (!coords) return null
                  return (
                    <Marker key={place.id} position={coords}>
                      <Popup>
                        <strong>{place.title}</strong>
                        {place.description && <p>{place.description}</p>}
                      </Popup>
                    </Marker>
                  )
                })}
                {tripCoords.length >= 2 && (
                  <Polyline positions={tripCoords} color="blue" weight={3} opacity={0.6} />
                )}
              </MapContainer>
            </div>

            {/* Place list */}
            {tripPlaces.length > 0 && (
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Places in this trip</h4>
                {tripPlaces.map((place) => (
                  <div key={place.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                    <div className="flex items-center gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm">{place.title}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => handleRemovePlace(place.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Itinerary */}
            <TripItinerary places={tripPlaces} />

            {/* Budget */}
            {selectedTrip && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Trip Budget</h4>
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Budget</label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={(selectedTrip.metadata.budget as number) || ''}
                      onChange={(e) => {
                        update.mutate({
                          id: selectedTrip.id,
                          updates: {
                            metadata: { ...selectedTrip.metadata, budget: parseFloat(e.target.value) || 0 },
                            updatedAt: new Date().toISOString(),
                          },
                        })
                      }}
                      className="h-8"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Spent</label>
                    <Input
                      type="number"
                      placeholder="0"
                      value={(selectedTrip.metadata.spent as number) || ''}
                      onChange={(e) => {
                        update.mutate({
                          id: selectedTrip.id,
                          updates: {
                            metadata: { ...selectedTrip.metadata, spent: parseFloat(e.target.value) || 0 },
                            updatedAt: new Date().toISOString(),
                          },
                        })
                      }}
                      className="h-8"
                    />
                  </div>
                </div>
                {typeof selectedTrip.metadata.budget === 'number' && (selectedTrip.metadata.budget as number) > 0 && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-muted-foreground">
                        {((selectedTrip.metadata.spent as number) || 0).toLocaleString()} / {((selectedTrip.metadata.budget as number) || 0).toLocaleString()}
                      </span>
                      <span>{Math.round((((selectedTrip.metadata.spent as number) || 0) / (selectedTrip.metadata.budget as number)) * 100)}%</span>
                    </div>
                    <Progress
                      value={Math.min(100, Math.round((((selectedTrip.metadata.spent as number) || 0) / (selectedTrip.metadata.budget as number)) * 100))}
                      className="h-2"
                    />
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="trip"
        title="New Trip"
        onSubmit={handleCreate}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Trip"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Trip deleted', type: 'success' })
            if (selectedTripId === deleteTarget.id) setSelectedTripId(null)
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
