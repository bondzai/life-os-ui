import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { DEVICE_TYPES, type DeviceType } from './home-helpers'

const schema = z.object({
  title: z.string().min(1, 'Name is required'),
  deviceType: z.enum(['server', 'desktop', 'laptop', 'phone', 'tablet', 'router', 'iot', 'other']),
  ip: z.string().optional(),
  mac: z.string().optional(),
  os: z.string().optional(),
  location: z.string().optional(),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface DeviceFormValues {
  title: string
  deviceType: DeviceType
  ip?: string
  mac?: string
  os?: string
  location?: string
  note?: string
}

interface DeviceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<DeviceFormValues>
  onSubmit: (values: DeviceFormValues) => void
  title?: string
}

export function DeviceDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Device',
}: DeviceDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      deviceType: defaultValues?.deviceType ?? 'server',
      ip: defaultValues?.ip ?? '',
      mac: defaultValues?.mac ?? '',
      os: defaultValues?.os ?? '',
      location: defaultValues?.location ?? '',
      note: defaultValues?.note ?? '',
    },
  })

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        title: defaultValues.title ?? '',
        deviceType: defaultValues.deviceType ?? 'server',
        ip: defaultValues.ip ?? '',
        mac: defaultValues.mac ?? '',
        os: defaultValues.os ?? '',
        location: defaultValues.location ?? '',
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      title: values.title,
      deviceType: values.deviceType,
      ip: values.ip || undefined,
      mac: values.mac || undefined,
      os: values.os || undefined,
      location: values.location || undefined,
      note: values.note || undefined,
    })
    form.reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="deviceType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {DEVICE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t === 'iot' ? 'IoT' : t.charAt(0).toUpperCase() + t.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Mini PC, MacBook Pro" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="ip"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>IP Address</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="192.168.1.x" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="mac"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>MAC Address</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="AA:BB:CC:DD:EE:FF" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="os"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>OS</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Ubuntu 24.04, macOS" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="location"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Location</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="e.g. Living room, Office" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Optional note" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
