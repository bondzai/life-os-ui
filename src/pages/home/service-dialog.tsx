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
import { SERVICE_TYPES, SERVICE_STATUSES, type ServiceType, type ServiceStatus } from './home-helpers'

const schema = z.object({
  title: z.string().min(1, 'Name is required'),
  serviceType: z.enum(['docker', 'web', 'database', 'api', 'monitoring', 'media', 'other']),
  serviceStatus: z.enum(['running', 'stopped', 'error', 'unknown']),
  url: z.string().optional(),
  port: z.string().optional(),
  deviceId: z.string().optional(),
  image: z.string().optional(),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface ServiceFormValues {
  title: string
  serviceType: ServiceType
  serviceStatus: ServiceStatus
  url?: string
  port?: number
  deviceId?: string
  image?: string
  note?: string
}

interface ServiceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<ServiceFormValues>
  onSubmit: (values: ServiceFormValues) => void
  title?: string
  devices: { id: string; title: string }[]
}

export function ServiceDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'New Service',
  devices,
}: ServiceDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      serviceType: defaultValues?.serviceType ?? 'docker',
      serviceStatus: defaultValues?.serviceStatus ?? 'running',
      url: defaultValues?.url ?? '',
      port: defaultValues?.port?.toString() ?? '',
      deviceId: defaultValues?.deviceId ?? '',
      image: defaultValues?.image ?? '',
      note: defaultValues?.note ?? '',
    },
  })

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        title: defaultValues.title ?? '',
        serviceType: defaultValues.serviceType ?? 'docker',
        serviceStatus: defaultValues.serviceStatus ?? 'running',
        url: defaultValues.url ?? '',
        port: defaultValues.port?.toString() ?? '',
        deviceId: defaultValues.deviceId ?? '',
        image: defaultValues.image ?? '',
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      title: values.title,
      serviceType: values.serviceType,
      serviceStatus: values.serviceStatus,
      url: values.url || undefined,
      port: values.port ? parseInt(values.port, 10) : undefined,
      deviceId: values.deviceId || undefined,
      image: values.image || undefined,
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
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="serviceType"
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
                        {SERVICE_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t === 'api' ? 'API' : t.charAt(0).toUpperCase() + t.slice(1)}
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
                name="serviceStatus"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SERVICE_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.charAt(0).toUpperCase() + s.slice(1)}
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
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Lyra API, Postgres" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="url"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>URL</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="http://localhost:3000" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="port"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Port</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} placeholder="3000" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="image"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Docker Image</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. postgres:16, nginx:latest" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {devices.length > 0 && (
              <FormField
                control={form.control}
                name="deviceId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Host Device</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select device" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">None</SelectItem>
                        {devices.map((d) => (
                          <SelectItem key={d.id} value={d.id}>
                            {d.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
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
