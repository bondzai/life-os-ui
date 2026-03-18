import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  Plus,
  MapPin,
  Pencil,
  Trash2,
  Search,
  ExternalLink,
  Navigation,
  Battery,
  Clock,
  Loader2,
  Eye,
  EyeOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Map,
  MapMarker,
  MarkerContent,
  MarkerPopup,
  MapControls,
  useMap,
} from '@/components/ui/map'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '@/lib/map-config'
import { MapPickerDialog } from './places/map-picker-dialog'

// ---------------------------------------------------------------------------
// Live-location helpers
// ---------------------------------------------------------------------------

const MARKER_STYLES = {
  jb: { bg: '#3b82f6', border: '#2563eb', pulse: '#3b82f680', label: 'JB' },
  sunny: { bg: '#ec4899', border: '#db2777', pulse: '#ec489980', label: 'S' },
} as const

function formatTime(iso: string): string {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'Just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return d.toLocaleDateString()
}

function isJbUser(user: { name?: string; id?: string } | null): boolean {
  if (!user) return false
  const name = (user.name || '').toLowerCase()
  return name.includes('jb') || name.includes('admin') || name === 'jb'
}

// ---------------------------------------------------------------------------
// Map sub-components
// ---------------------------------------------------------------------------

function MapPanner({ center }: { center: [number, number] | null }) {
  const { map, isLoaded } = useMap()
  useEffect(() => {
    if (map && isLoaded && center) {
      map.flyTo({ center, zoom: 14 })
    }
  }, [map, isLoaded, center])
  return null
}

function MapFitter({ positions }: { positions: [number, number][] }) {
  const { map, isLoaded } = useMap()
  const fitted = useRef(false)

  useEffect(() => {
    if (!map || !isLoaded || positions.length === 0 || fitted.current) return
    fitted.current = true

    if (positions.length === 1) {
      map.flyTo({ center: positions[0], zoom: 15 })
    } else {
      const lngs = positions.map((p) => p[0])
      const lats = positions.map((p) => p[1])
      map.fitBounds(
        [
          [Math.min(...lngs), Math.min(...lats)],
          [Math.max(...lngs), Math.max(...lats)],
        ],
        { padding: 60 },
      )
    }
  }, [map, isLoaded, positions])

  useEffect(() => {
    fitted.current = false
  }, [positions])

  return null
}

function UserMarker({ variant, entity }: { variant: 'jb' | 'sunny'; entity: Entity }) {
  const lat = entity.metadata.lat as number
  const lng = entity.metadata.lng as number
  const style = MARKER_STYLES[variant]
  const updatedAt = typeof entity.metadata.updatedAt === 'string' ? entity.metadata.updatedAt : ''
  const battery = typeof entity.metadata.battery === 'number' ? entity.metadata.battery : null
  const accuracy = typeof entity.metadata.accuracy === 'number' ? entity.metadata.accuracy : null

  return (
    <MapMarker longitude={lng} latitude={lat}>
      <MarkerContent>
        <div className="relative flex items-center justify-center" style={{ width: 40, height: 40 }}>
          <div
            className="absolute inset-0 rounded-full animate-ping"
            style={{ background: style.pulse, animationDuration: '2s' }}
          />
          <div
            className="relative flex items-center justify-center rounded-full text-white text-xs font-bold shadow-lg"
            style={{
              width: 32,
              height: 32,
              background: style.bg,
              border: `3px solid ${style.border}`,
            }}
          >
            {style.label}
          </div>
        </div>
      </MarkerContent>
      <MarkerPopup className="min-w-[120px]">
        <div className="space-y-1">
          <p className="font-semibold text-sm">{variant === 'jb' ? 'JB' : 'Sunny'}</p>
          {updatedAt && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(updatedAt)}
            </p>
          )}
          {battery !== null && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Battery className="h-3 w-3" />
              {battery}%
            </p>
          )}
          {accuracy !== null && (
            <p className="text-xs text-muted-foreground">Accuracy: {Math.round(accuracy)}m</p>
          )}
        </div>
      </MarkerPopup>
    </MapMarker>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function PlacesPage() {
  // Entity hooks
  const { items: places, isLoading, create, update, remove } = useEntities('place')
  const { items: locationEntities, create: createLocation, update: updateLocation } =
    useEntities('location')
  const currentUser = useAuthStore((s) => s.currentUser)

  // Places state
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingPlace, setEditingPlace] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [mapPickerOpen, setMapPickerOpen] = useState(false)
  const [mapPickerTarget, setMapPickerTarget] = useState<Entity | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panTarget, setPanTarget] = useState<[number, number] | null>(null)

  // Live-location state
  const [sharing, setSharing] = useState(false)
  const [showLiveLocations, setShowLiveLocations] = useState(true)
  const [showPlaces, setShowPlaces] = useState(true)

  // Derived: categories
  const categories = useMemo(() => {
    const tagSet = new Set<string>()
    places.forEach((p) => p.tags.forEach((t) => tagSet.add(t)))
    return Array.from(tagSet).sort()
  }, [places])

  // Derived: filtered places
  const filteredPlaces = useMemo(() => {
    let filtered = places
    if (categoryFilter !== 'all') {
      filtered = filtered.filter((p) => p.tags.includes(categoryFilter))
    }
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          (typeof p.metadata.address === 'string' && p.metadata.address.toLowerCase().includes(q)),
      )
    }
    return filtered
  }, [places, categoryFilter, search])

  // Derived: live locations
  const jbLocation = useMemo(
    () => locationEntities.find((e) => e.title === 'JB Location'),
    [locationEntities],
  )
  const sunnyLocation = useMemo(
    () => locationEntities.find((e) => e.title === 'Sunny Location'),
    [locationEntities],
  )

  const liveMarkerPositions = useMemo(() => {
    if (!showLiveLocations) return []
    const positions: [number, number][] = []
    for (const loc of [jbLocation, sunnyLocation]) {
      if (loc && typeof loc.metadata.lat === 'number' && typeof loc.metadata.lng === 'number') {
        positions.push([loc.metadata.lng, loc.metadata.lat])
      }
    }
    return positions
  }, [jbLocation, sunnyLocation, showLiveLocations])

  // Helpers
  const getCoords = (place: Entity): [number, number] | null => {
    const lat = typeof place.metadata.lat === 'number' ? place.metadata.lat : null
    const lng = typeof place.metadata.lng === 'number' ? place.metadata.lng : null
    if (lat !== null && lng !== null) return [lng, lat]
    return null
  }

  const handleSelectPlace = (place: Entity) => {
    setSelectedId(place.id)
    const coords = getCoords(place)
    if (coords) setPanTarget(coords)
  }

  const handleMapPick = (lng: number, lat: number) => {
    if (mapPickerTarget) {
      update.mutate({
        id: mapPickerTarget.id,
        updates: {
          metadata: { ...mapPickerTarget.metadata, lat, lng },
          updatedAt: new Date().toISOString(),
        },
      })
      notify({ title: 'Location updated', type: 'success' })
      setMapPickerTarget(null)
    }
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'place',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { lat: 0, lng: 0, address: '' },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Place added', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingPlace) return
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    update.mutate({
      id: editingPlace.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        updatedAt: new Date().toISOString(),
      },
    })
    setEditingPlace(null)
  }

  // Share live location
  const shareLocation = useCallback(async () => {
    if (!currentUser) return
    setSharing(true)

    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
        })
      })

      const isJb = isJbUser(currentUser)
      const title = isJb ? 'JB Location' : 'Sunny Location'
      const existing = locationEntities.find((e) => e.title === title)

      const metadata = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        updatedAt: new Date().toISOString(),
      }

      if (existing) {
        updateLocation.mutate({
          id: existing.id,
          updates: { metadata, updatedAt: new Date().toISOString() },
        })
      } else {
        createLocation.mutate({
          id: crypto.randomUUID(),
          type: 'location',
          title,
          status: 'todo' as EntityStatus,
          priority: 'medium',
          tags: [],
          metadata,
          ownerId: currentUser.id,
          visibility: 'shared',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
      }

      notify({ title: 'Location shared', type: 'success' })
    } catch (err) {
      const message =
        err instanceof GeolocationPositionError
          ? 'Location access denied. Please enable location permissions.'
          : 'Failed to get location'
      notify({ title: message, type: 'error' })
    } finally {
      setSharing(false)
    }
  }, [currentUser, locationEntities, createLocation, updateLocation])

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  const hasLiveLocations =
    (jbLocation && typeof jbLocation.metadata.lat === 'number') ||
    (sunnyLocation && typeof sunnyLocation.metadata.lat === 'number')

  return (
    <div className="flex h-[calc(100vh-7rem)] gap-4">
      {/* Sidebar */}
      <div className="w-72 shrink-0 flex flex-col gap-3 overflow-hidden">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search places..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {categories.length > 0 && (
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger>
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add Place
        </Button>

        <div className="flex-1 overflow-y-auto space-y-2">
          {filteredPlaces.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">No places found</p>
          ) : (
            filteredPlaces.map((place) => {
              const address = typeof place.metadata.address === 'string' ? place.metadata.address : ''
              return (
                <Card
                  key={place.id}
                  className={`cursor-pointer transition-colors ${selectedId === place.id ? 'border-primary' : 'hover:bg-accent/50'}`}
                  onClick={() => handleSelectPlace(place)}
                >
                  <CardContent className="py-2 space-y-1">
                    <p className="text-sm font-medium">{place.title}</p>
                    {address && <p className="text-xs text-muted-foreground">{address}</p>}
                    {place.tags.length > 0 && (
                      <div className="flex gap-1 flex-wrap">
                        {place.tags.map((tag) => (
                          <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex gap-1 pt-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5"
                        onClick={(e) => { e.stopPropagation(); setEditingPlace(place) }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5"
                        onClick={(e) => { e.stopPropagation(); setDeleteTarget(place) }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMapPickerTarget(place)
                          setMapPickerOpen(true)
                        }}
                      >
                        <MapPin className="h-3 w-3" />
                      </Button>
                      {getCoords(place) && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-1.5"
                          onClick={(e) => {
                            e.stopPropagation()
                            const [lng, lat] = getCoords(place)!
                            window.open(`https://www.google.com/maps?q=${lat},${lng}`, '_blank')
                          }}
                        >
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>

      {/* Map area */}
      <div className="relative flex-1 rounded-lg overflow-hidden border">
        {places.length === 0 && !hasLiveLocations ? (
          <div className="h-full flex items-center justify-center">
            <EmptyState
              icon={MapPin}
              title="No places yet"
              description="Add your first place to see it on the map."
              actionLabel="Add Place"
              onAction={() => setDialogOpen(true)}
            />
          </div>
        ) : (
          <Map center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM}>
            <MapControls position="top-left" showZoom showCompass />
            <MapPanner center={panTarget} />

            {/* Fit bounds when sharing location */}
            {liveMarkerPositions.length > 0 && <MapFitter positions={liveMarkerPositions} />}

            {/* Place markers */}
            {showPlaces &&
              filteredPlaces.map((place) => {
                const coords = getCoords(place)
                if (!coords) return null
                return (
                  <MapMarker key={place.id} longitude={coords[0]} latitude={coords[1]}>
                    <MarkerContent>
                      <div className="size-4 rounded-full bg-primary border-2 border-white shadow-lg" />
                    </MarkerContent>
                    <MarkerPopup>
                      <div className="space-y-1">
                        <strong>{place.title}</strong>
                        {place.description && <p className="text-sm">{place.description}</p>}
                      </div>
                    </MarkerPopup>
                  </MapMarker>
                )
              })}

            {/* Live location markers */}
            {showLiveLocations && (
              <>
                {jbLocation &&
                  typeof jbLocation.metadata.lat === 'number' &&
                  typeof jbLocation.metadata.lng === 'number' && (
                    <UserMarker variant="jb" entity={jbLocation} />
                  )}
                {sunnyLocation &&
                  typeof sunnyLocation.metadata.lat === 'number' &&
                  typeof sunnyLocation.metadata.lng === 'number' && (
                    <UserMarker variant="sunny" entity={sunnyLocation} />
                  )}
              </>
            )}
          </Map>
        )}

        {/* Legend / toggles — top-right overlay */}
        <div className="absolute top-4 right-4 z-[1000] bg-background/90 backdrop-blur-sm border rounded-lg p-3 space-y-2 shadow-md">
          {/* Places toggle */}
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setShowPlaces((v) => !v)}
          >
            {showPlaces ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
            <div className="w-3 h-3 rounded-full bg-primary border-2 border-white" />
            <span className={`text-xs font-medium ${!showPlaces ? 'text-muted-foreground' : ''}`}>
              Places
            </span>
          </button>

          {/* Live locations toggle */}
          <button
            className="flex items-center gap-2 w-full text-left"
            onClick={() => setShowLiveLocations((v) => !v)}
          >
            {showLiveLocations ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 text-muted-foreground" />}
            <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-600" />
            <span className={`text-xs font-medium ${!showLiveLocations ? 'text-muted-foreground' : ''}`}>
              Live
            </span>
          </button>

          {/* Live location details */}
          {showLiveLocations && (
            <div className="border-t pt-2 space-y-1">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-blue-500" />
                <span className="text-xs">JB</span>
                {jbLocation && typeof jbLocation.metadata.updatedAt === 'string' && (
                  <span className="text-xs text-muted-foreground">{formatTime(jbLocation.metadata.updatedAt)}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-pink-500" />
                <span className="text-xs">Sunny</span>
                {sunnyLocation && typeof sunnyLocation.metadata.updatedAt === 'string' && (
                  <span className="text-xs text-muted-foreground">{formatTime(sunnyLocation.metadata.updatedAt)}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Share Location button — bottom-center overlay */}
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
          <Button size="lg" onClick={shareLocation} disabled={sharing} className="shadow-lg gap-2 px-6">
            {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Navigation className="h-4 w-4" />}
            {sharing ? 'Getting location...' : 'Share My Location'}
          </Button>
        </div>
      </div>

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="place"
        title="New Place"
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingPlace}
        onOpenChange={(open) => !open && setEditingPlace(null)}
        entityType="place"
        title="Edit Place"
        defaultValues={editingPlace ?? undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Place"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Place deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />

      <MapPickerDialog
        open={mapPickerOpen}
        onOpenChange={setMapPickerOpen}
        onSelect={handleMapPick}
        initialPosition={
          mapPickerTarget
            ? (getCoords(mapPickerTarget) ?? undefined)
            : undefined
        }
      />
    </div>
  )
}
