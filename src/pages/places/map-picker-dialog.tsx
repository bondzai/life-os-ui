import { useState, useCallback, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Map,
  MapMarker,
  MarkerContent,
  MapControls,
  useMap,
} from '@/components/ui/map'
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '@/lib/map-config'

interface MapPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (lng: number, lat: number) => void
  initialPosition?: [number, number] // [lng, lat]
}

function ClickHandler({ onSelect }: { onSelect: (lng: number, lat: number) => void }) {
  const { map, isLoaded } = useMap()

  useEffect(() => {
    if (!map || !isLoaded) return
    const handler = (e: { lngLat: { lng: number; lat: number } }) => {
      onSelect(e.lngLat.lng, e.lngLat.lat)
    }
    map.on('click', handler)
    return () => { map.off('click', handler) }
  }, [map, isLoaded, onSelect])

  return null
}

export function MapPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPosition,
}: MapPickerDialogProps) {
  const [position, setPosition] = useState<[number, number] | null>(initialPosition ?? null)
  const center: [number, number] = initialPosition ?? DEFAULT_CENTER

  const handleClick = useCallback((lng: number, lat: number) => {
    setPosition([lng, lat])
  }, [])

  const handleConfirm = () => {
    if (position) {
      onSelect(position[0], position[1]) // [lng, lat]
      onOpenChange(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Pick Location</DialogTitle>
        </DialogHeader>
        <div className="h-[400px] rounded-lg overflow-hidden border">
          {open && (
            <Map center={center} zoom={DEFAULT_ZOOM}>
              <MapControls position="top-left" showZoom />
              <ClickHandler onSelect={handleClick} />
              {position && (
                <MapMarker longitude={position[0]} latitude={position[1]}>
                  <MarkerContent>
                    <div className="size-4 rounded-full bg-primary border-2 border-white shadow-lg" />
                  </MarkerContent>
                </MapMarker>
              )}
            </Map>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {position
            ? `Selected: ${position[1].toFixed(6)}, ${position[0].toFixed(6)}`
            : 'Click on the map to set a location'}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!position}>
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
