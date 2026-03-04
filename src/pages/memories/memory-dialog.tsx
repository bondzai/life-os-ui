import { useRef, useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ImagePlus } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { MOODS, MOOD_EMOJI } from './memory-helpers'
import { compressImage, generateThumbnail } from './image-utils'

const memorySchema = z.object({
  title: z.string().min(1, 'Title is required'),
  date: z.string().min(1, 'Date is required'),
  mood: z.string().min(1, 'Mood is required'),
  location: z.string().optional(),
  caption: z.string().optional(),
  tags: z.string().optional(),
})

export type MemoryFormValues = z.infer<typeof memorySchema>

interface MemoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  defaultValues?: MemoryFormValues & { imageData?: string; thumbnailData?: string }
  onSubmit: (values: MemoryFormValues & { imageData: string; thumbnailData: string }) => void
}

export function MemoryDialog({
  open,
  onOpenChange,
  title = 'New Memory',
  defaultValues,
  onSubmit,
}: MemoryDialogProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [imageData, setImageData] = useState<string>('')
  const [thumbnailData, setThumbnailData] = useState<string>('')
  const [compressing, setCompressing] = useState(false)

  const form = useForm<MemoryFormValues>({
    resolver: zodResolver(memorySchema),
    defaultValues: defaultValues
      ? { ...defaultValues }
      : {
          title: '',
          date: new Date().toISOString().split('T')[0],
          mood: '',
          location: '',
          caption: '',
          tags: '',
        },
  })

  // Reset when defaultValues change (edit mode)
  useEffect(() => {
    if (open && defaultValues) {
      form.reset(defaultValues)
      setPreview(defaultValues.thumbnailData ?? null)
      setImageData(defaultValues.imageData ?? '')
      setThumbnailData(defaultValues.thumbnailData ?? '')
    } else if (open && !defaultValues) {
      form.reset({
        title: '',
        date: new Date().toISOString().split('T')[0],
        mood: '',
        location: '',
        caption: '',
        tags: '',
      })
      setPreview(null)
      setImageData('')
      setThumbnailData('')
    }
  }, [open, defaultValues, form])

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setCompressing(true)
    try {
      const [compressed, thumb] = await Promise.all([
        compressImage(file),
        generateThumbnail(file),
      ])
      setImageData(compressed)
      setThumbnailData(thumb)
      setPreview(thumb)
    } finally {
      setCompressing(false)
    }
  }

  const handleSubmit = (values: MemoryFormValues) => {
    if (!imageData && !defaultValues?.imageData) return
    onSubmit({
      ...values,
      imageData: imageData || defaultValues?.imageData || '',
      thumbnailData: thumbnailData || defaultValues?.thumbnailData || '',
    })
    form.reset()
    setPreview(null)
    setImageData('')
    setThumbnailData('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* Image upload zone */}
            <div
              className="border-2 border-dashed rounded-lg p-4 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleFileChange}
              />
              {preview ? (
                <img
                  src={preview}
                  alt="Preview"
                  className="mx-auto max-h-48 rounded object-contain"
                />
              ) : (
                <div className="py-6 text-muted-foreground">
                  <ImagePlus className="h-8 w-8 mx-auto mb-2" />
                  <p className="text-sm">Click to upload a photo</p>
                </div>
              )}
              {compressing && (
                <p className="text-xs text-muted-foreground mt-2">Compressing...</p>
              )}
            </div>
            {!imageData && !defaultValues?.imageData && (
              <p className="text-xs text-destructive">A photo is required</p>
            )}

            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input placeholder="A beautiful sunset" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mood"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mood</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select mood" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {MOODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {MOOD_EMOJI[m]} {m.charAt(0).toUpperCase() + m.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="location"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Location</FormLabel>
                  <FormControl>
                    <Input placeholder="Bangkok, Thailand" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="caption"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Caption</FormLabel>
                  <FormControl>
                    <Textarea placeholder="Describe this memory..." rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="tags"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tags</FormLabel>
                  <FormControl>
                    <Input placeholder="travel, family (comma-separated)" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="submit" disabled={compressing}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
