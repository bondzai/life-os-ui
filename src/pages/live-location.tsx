import { useState, useEffect, useCallback, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Navigation, Battery, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { MAP_TILES, DEFAULT_CENTER, DEFAULT_ZOOM, getMapTileUrl } from '@/lib/map-config'
import type { Entity, EntityStatus } from '@/core/types'

const POLL_INTERVAL = 30_000

const MARKER_STYLES = {
  jb: {
    bg: '#3b82f6',
    border: '#2563eb',
    pulse: '#3b82f680',
    label: 'JB',
  },
  sunny: {
    bg: '#ec4899',
    border: '#db2777',
    pulse: '#ec489980',
    label: 'S',
  },
} as const

function createUserIcon(variant: 'jb' | 'sunny') {
  const style = MARKER_STYLES[variant]
  return L.divIcon({
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -24],
    html: `
      <div style="position:relative;width:40px;height:40px;display:flex;align-items:center;justify-content:center;">
        <div style="
          position:absolute;inset:0;
          border-radius:50%;
          background:${style.pulse};
          animation:pulse-ring 2s ease-out infinite;
        "></div>
        <div style="
          position:relative;
          width:32px;height:32px;
          border-radius:50%;
          background:${style.bg};
          border:3px solid ${style.border};
          display:flex;align-items:center;justify-content:center;
          color:white;font-weight:700;font-size:12px;
          box-shadow:0 2px 8px rgba(0,0,0,0.3);
          z-index:1;
        ">${style.label}</div>
      </div>
      <style>
        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 1; }
          100% { transform: scale(1.8); opacity: 0; }
        }
      </style>
    `,
  })
}

const jbIcon = createUserIcon('jb')
const sunnyIcon = createUserIcon('sunny')

function MapFitter({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length > 1) {
      const bounds = L.latLngBounds(positions.map(([lat, lng]) => L.latLng(lat, lng)))
      map.fitBounds(bounds, { padding: [60, 60] })
    } else if (positions.length === 1) {
      map.flyTo(positions[0], 15)
    }
  }, [map, positions])
  return null
}

function ThemeAwareTileLayer() {
  const [url, setUrl] = useState(getMapTileUrl)

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setUrl(getMapTileUrl())
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    return () => observer.disconnect()
  }, [])

  return <TileLayer attribution={MAP_TILES.attribution} url={url} />
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
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

export function LiveLocationPage() {
  const { items: locationEntities, create, update } = useEntities('location')
  const currentUser = useAuthStore((s) => s.currentUser)
  const [sharing, setSharing] = useState(false)

  // Poll for updates
  useEffect(() => {
    const interval = setInterval(() => {
      // useEntities auto-refetches via TanStack Query; this triggers a re-render check
    }, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [])

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
        positions.push([loc.metadata.lat, loc.metadata.lng])
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
          updates: {
            metadata,
            updatedAt: new Date().toISOString(),
          },
        })
      } else {
        create.mutate({
          id: crypto.randomUUID(),
          type: 'location',
          title,
          status: 'active' as EntityStatus,
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
      const message = err instanceof GeolocationPositionError
        ? 'Location access denied. Please enable location permissions.'
        : 'Failed to get location'
      notify({ title: message, type: 'error' })
    } finally {
      setSharing(false)
    }
  }, [currentUser, locationEntities, create, update])

  const renderPopup = (entity: Entity, label: string) => {
    const updatedAt = typeof entity.metadata.updatedAt === 'string' ? entity.metadata.updatedAt : ''
    const battery = typeof entity.metadata.battery === 'number' ? entity.metadata.battery : null
    const accuracy = typeof entity.metadata.accuracy === 'number' ? entity.metadata.accuracy : null

    return (
      <Popup>
        <div className="space-y-1 min-w-[120px]">
          <p className="font-semibold text-sm">{label}</p>
          {updatedAt && (
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatTime(updatedAt)}
            </p>
          )}
          {battery !== null && (
            <p className="text-xs text-gray-500 flex items-center gap-1">
              <Battery className="h-3 w-3" />
              {battery}%
            </p>
          )}
          {accuracy !== null && (
            <p className="text-xs text-gray-500">
              Accuracy: {Math.round(accuracy)}m
            </p>
          )}
        </div>
      </Popup>
    )
  }

  return (
    <div className="relative h-[calc(100vh-7rem)] w-full">
      {/* Full-screen map */}
      <div className="absolute inset-0 rounded-lg overflow-hidden border">
        <MapContainer
          center={DEFAULT_CENTER}
          zoom={DEFAULT_ZOOM}
          className="h-full w-full"
          zoomControl={false}
        >
          <ThemeAwareTileLayer />

          {markerPositions.length > 0 && (
            <MapFitter positions={markerPositions} />
          )}

          {jbLocation &&
            typeof jbLocation.metadata.lat === 'number' &&
            typeof jbLocation.metadata.lng === 'number' && (
              <Marker
                position={[jbLocation.metadata.lat, jbLocation.metadata.lng]}
                icon={jbIcon}
              >
                {renderPopup(jbLocation, 'JB')}
              </Marker>
            )}

          {sunnyLocation &&
            typeof sunnyLocation.metadata.lat === 'number' &&
            typeof sunnyLocation.metadata.lng === 'number' && (
              <Marker
                position={[sunnyLocation.metadata.lat, sunnyLocation.metadata.lng]}
                icon={sunnyIcon}
              >
                {renderPopup(sunnyLocation, 'Sunny')}
              </Marker>
            )}
        </MapContainer>
      </div>

      {/* Share Location button */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-[1000]">
        <Button
          size="lg"
          onClick={shareLocation}
          disabled={sharing}
          className="shadow-lg gap-2 px-6"
        >
          {sharing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Navigation className="h-4 w-4" />
          )}
          {sharing ? 'Getting location...' : 'Share My Location'}
        </Button>
      </div>

      {/* Legend */}
      <div className="absolute top-4 right-4 z-[1000] bg-background/90 backdrop-blur-sm border rounded-lg p-3 space-y-2 shadow-md">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-600" />
          <span className="text-xs font-medium">JB</span>
          {jbLocation && typeof jbLocation.metadata.updatedAt === 'string' && (
            <span className="text-xs text-muted-foreground">
              {formatTime(jbLocation.metadata.updatedAt)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-pink-500 border-2 border-pink-600" />
          <span className="text-xs font-medium">Sunny</span>
          {sunnyLocation && typeof sunnyLocation.metadata.updatedAt === 'string' && (
            <span className="text-xs text-muted-foreground">
              {formatTime(sunnyLocation.metadata.updatedAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
