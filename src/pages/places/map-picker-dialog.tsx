import { useState } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

interface MapPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (lat: number, lng: number) => void
  initialPosition?: [number, number]
}

function ClickHandler({ onSelect }: { onSelect: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onSelect(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

export function MapPickerDialog({
  open,
  onOpenChange,
  onSelect,
  initialPosition,
}: MapPickerDialogProps) {
  const [position, setPosition] = useState<[number, number] | null>(initialPosition ?? null)
  const center: [number, number] = initialPosition ?? [13.7563, 100.5018]

  const handleClick = (lat: number, lng: number) => {
    setPosition([lat, lng])
  }

  const handleConfirm = () => {
    if (position) {
      onSelect(position[0], position[1])
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
            <MapContainer center={center} zoom={12} className="h-full w-full">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <ClickHandler onSelect={handleClick} />
              {position && <Marker position={position} />}
            </MapContainer>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {position
            ? `Selected: ${position[0].toFixed(6)}, ${position[1].toFixed(6)}`
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
