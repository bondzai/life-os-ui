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
import { BODY_METRIC_TYPES, METRIC_UNITS, type BodyMetricType } from './health-helpers'

const schema = z.object({
  metricType: z.enum(['weight', 'body-fat', 'waist', 'chest', 'arms', 'bmi']),
  value: z.string().min(1, 'Value is required'),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface BodyMetricFormValues {
  metricType: BodyMetricType
  value: number
  date: string
  note?: string
}

interface BodyMetricDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<BodyMetricFormValues>
  onSubmit: (values: BodyMetricFormValues) => void
  title?: string
}

export function BodyMetricDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'Log Body Metric',
}: BodyMetricDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      metricType: defaultValues?.metricType ?? 'weight',
      value: defaultValues?.value?.toString() ?? '',
      date: defaultValues?.date ?? new Date().toISOString().split('T')[0],
      note: defaultValues?.note ?? '',
    },
  })

  const metricType = form.watch('metricType') as BodyMetricType
  const unit = METRIC_UNITS[metricType]

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        metricType: defaultValues.metricType ?? 'weight',
        value: defaultValues.value?.toString() ?? '',
        date: defaultValues.date ?? new Date().toISOString().split('T')[0],
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      metricType: values.metricType,
      value: parseFloat(values.value),
      date: values.date,
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
              name="metricType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Metric</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {BODY_METRIC_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t === 'body-fat' ? 'Body Fat' : t === 'bmi' ? 'BMI' : t.charAt(0).toUpperCase() + t.slice(1)}
                          {METRIC_UNITS[t] ? ` (${METRIC_UNITS[t]})` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Value{unit ? ` (${unit})` : ''}</FormLabel>
                    <FormControl>
                      <Input type="number" step="any" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
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
