import { useState, useMemo, useEffect } from 'react'
import { Plus, MapPin, Pencil, Trash2, Search } from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
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
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'

// Fix Leaflet default marker icons (Vite bundler issue)
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

const DEFAULT_CENTER: [number, number] = [13.7563, 100.5018] // Bangkok
const DEFAULT_ZOOM = 10

function MapPanner({ center }: { center: [number, number] | null }) {
  const map = useMap()
  useEffect(() => {
    if (center) {
      map.flyTo(center, 14)
    }
  }, [map, center])
  return null
}

export function PlacesPage() {
  const { items: places, isLoading, create, update, remove } = useEntities('place')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingPlace, setEditingPlace] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panTarget, setPanTarget] = useState<[number, number] | null>(null)

  const categories = useMemo(() => {
    const tagSet = new Set<string>()
    places.forEach((p) => p.tags.forEach((t) => tagSet.add(t)))
    return Array.from(tagSet).sort()
  }, [places])

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

  const getCoords = (place: Entity): [number, number] | null => {
    const lat = typeof place.metadata.lat === 'number' ? place.metadata.lat : null
    const lng = typeof place.metadata.lng === 'number' ? place.metadata.lng : null
    if (lat !== null && lng !== null) return [lat, lng]
    return null
  }

  const handleSelectPlace = (place: Entity) => {
    setSelectedId(place.id)
    const coords = getCoords(place)
    if (coords) setPanTarget(coords)
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
      status: (values.status as EntityStatus) || 'active',
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

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

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
                    {address && (
                      <p className="text-xs text-muted-foreground">{address}</p>
                    )}
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
                        onClick={(e) => {
                          e.stopPropagation()
                          setEditingPlace(place)
                        }}
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleteTarget(place)
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      </div>

      {/* Map */}
      <div className="flex-1 rounded-lg overflow-hidden border">
        {places.length === 0 ? (
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
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapPanner center={panTarget} />
            {filteredPlaces.map((place) => {
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
          </MapContainer>
        )}
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
    </div>
  )
}
