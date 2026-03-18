import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Navigation, Battery, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { notify } from '@/lib/notify'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '@/lib/map-config'
import type { Entity, EntityStatus } from '@/core/types'

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

  // Re-fit when positions change
  useEffect(() => {
    fitted.current = false
  }, [positions])

  return null
}

function UserMarker({
  variant,
  entity,
}: {
  variant: 'jb' | 'sunny'
  entity: Entity
}) {
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

export function LiveLocationPage() {
  const { items: locationEntities, create, update } = useEntities('location')
  const currentUser = useAuthStore((s) => s.currentUser)
  const [sharing, setSharing] = useState(false)

  const jbLocation = useMemo(
    () => locationEntities.find((e) => e.title === 'JB Location'),
    [locationEntities],
  )

  const sunnyLocation = useMemo(
    () => locationEntities.find((e) => e.title === 'Sunny Location'),
    [locationEntities],
  )

  const markerPositions = useMemo(() => {
    const positions: [number, number][] = []
    for (const loc of [jbLocation, sunnyLocation]) {
      if (loc && typeof loc.metadata.lat === 'number' && typeof loc.metadata.lng === 'number') {
        positions.push([loc.metadata.lng, loc.metadata.lat]) // [lng, lat]
      }
    }
    return positions
  }, [jbLocation, sunnyLocation])

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
        update.mutate({
          id: existing.id,
          updates: { metadata, updatedAt: new Date().toISOString() },
        })
      } else {
        create.mutate({
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
  }, [currentUser, locationEntities, create, update])

  return (
    <div className="relative h-[calc(100vh-7rem)] w-full">
      <div className="absolute inset-0 rounded-lg overflow-hidden border">
        <Map center={DEFAULT_CENTER} zoom={DEFAULT_ZOOM}>
          <MapControls position="top-left" showZoom showCompass />
          {markerPositions.length > 0 && <MapFitter positions={markerPositions} />}

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
        </Map>
      </div>

      {/* Share Location button */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
        <Button size="lg" onClick={shareLocation} disabled={sharing} className="shadow-lg gap-2 px-6">
          {sharing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Navigation className="h-4 w-4" />}
          {sharing ? 'Getting location...' : 'Share My Location'}
        </Button>
      </div>

      {/* Legend */}
      <div className="absolute top-4 right-4 z-[1000] bg-background/90 backdrop-blur-sm border rounded-lg p-3 space-y-2 shadow-md">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-600" />
          <span className="text-xs font-medium">JB</span>
          {jbLocation && typeof jbLocation.metadata.updatedAt === 'string' && (
            <span className="text-xs text-muted-foreground">{formatTime(jbLocation.metadata.updatedAt)}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-pink-500 border-2 border-pink-600" />
          <span className="text-xs font-medium">Sunny</span>
          {sunnyLocation && typeof sunnyLocation.metadata.updatedAt === 'string' && (
            <span className="text-xs text-muted-foreground">{formatTime(sunnyLocation.metadata.updatedAt)}</span>
          )}
        </div>
      </div>
    </div>
  )
}
