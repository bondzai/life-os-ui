import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Plus, X, ChevronDown, ChevronRight } from 'lucide-react'
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
import {
  TRIGGER_TYPES,
  TRIGGER_LABELS,
  SCHEDULE_INTERVALS,
  SCHEDULE_LABELS,
  ACTION_TYPES,
  ACTION_LABELS,
  CONDITION_FIELDS,
  CONDITION_OPERATORS,
  type Condition,
  type ConditionField,
  type ConditionOperator,
} from './automate-helpers'

const automationSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  triggerType: z.enum(TRIGGER_TYPES),
  scheduleInterval: z.enum(SCHEDULE_INTERVALS).optional(),
  actionType: z.enum(ACTION_TYPES),
  // Create-entity config
  entityType: z.string().optional(),
  entityTitle: z.string().optional(),
  entityTags: z.string().optional(),
  // Notify config
  notifyTitle: z.string().optional(),
  notifyMessage: z.string().optional(),
  // Update-entities config
  targetType: z.string().optional(),
  targetStatus: z.string().optional(),
  newStatus: z.string().optional(),
  // Event trigger config
  watchType: z.string().optional(),
  watchStatus: z.string().optional(),
})

export type AutomationFormValues = z.infer<typeof automationSchema>

interface AutomationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  defaultValues?: AutomationFormValues
  defaultConditions?: Condition[]
  onSubmit: (values: AutomationFormValues, conditions?: Condition[]) => void
}

export function AutomationDialog({
  open,
  onOpenChange,
  title = 'New Automation',
  defaultValues,
  defaultConditions,
  onSubmit,
}: AutomationDialogProps) {
  const form = useForm<AutomationFormValues>({
    resolver: zodResolver(automationSchema),
    defaultValues: defaultValues ?? {
      title: '',
      description: '',
      triggerType: 'schedule',
      scheduleInterval: 'weekly',
      actionType: 'notify',
      entityType: 'task',
      entityTitle: '',
      entityTags: '',
      notifyTitle: '',
      notifyMessage: '',
      targetType: '',
      targetStatus: '',
      newStatus: '',
      watchType: '',
      watchStatus: '',
    },
  })

  const [conditions, setConditions] = useState<Condition[]>(defaultConditions ?? [])
  const [conditionsOpen, setConditionsOpen] = useState(false)

  const triggerType = form.watch('triggerType')
  const actionType = form.watch('actionType')

  const addCondition = () => {
    setConditions([...conditions, { field: 'entityStatus', operator: 'eq', value: '' }])
    setConditionsOpen(true)
  }

  const removeCondition = (index: number) => {
    setConditions(conditions.filter((_, i) => i !== index))
  }

  const updateCondition = (index: number, updates: Partial<Condition>) => {
    setConditions(conditions.map((c, i) => (i === index ? { ...c, ...updates } : c)))
  }

  const handleSubmit = (values: AutomationFormValues) => {
    onSubmit(values, conditions.length > 0 ? conditions : undefined)
    form.reset()
    setConditions([])
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="Weekly Review" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea placeholder="What this automation does" rows={2} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="triggerType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Trigger</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {TRIGGER_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {TRIGGER_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {triggerType === 'schedule' && (
                <FormField
                  control={form.control}
                  name="scheduleInterval"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Interval</FormLabel>
                      <Select value={field.value ?? 'weekly'} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {SCHEDULE_INTERVALS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {SCHEDULE_LABELS[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}
            </div>
            {/* Event trigger config */}
            {triggerType === 'event' && (
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="watchType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Watch entity type</FormLabel>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Any" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="task">Task</SelectItem>
                          <SelectItem value="habit">Habit</SelectItem>
                          <SelectItem value="goal">Goal</SelectItem>
                          <SelectItem value="chore">Chore</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="watchStatus"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>On status change to</FormLabel>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Any" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="todo">To Do</SelectItem>
                          <SelectItem value="done">Done</SelectItem>
                          <SelectItem value="in-progress">In Progress</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            <FormField
              control={form.control}
              name="actionType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Action</FormLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ACTION_TYPES.map((a) => (
                        <SelectItem key={a} value={a}>
                          {ACTION_LABELS[a]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Create-entity action config */}
            {actionType === 'create-entity' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="entityType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Entity type</FormLabel>
                        <Select value={field.value ?? 'task'} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="task">Task</SelectItem>
                            <SelectItem value="event">Event</SelectItem>
                            <SelectItem value="note">Note</SelectItem>
                            <SelectItem value="chore">Chore</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="entityTags"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tags</FormLabel>
                        <FormControl>
                          <Input placeholder="review, weekly" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="entityTitle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Entity title</FormLabel>
                      <FormControl>
                        <Input placeholder="Weekly review" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* Notify action config */}
            {actionType === 'notify' && (
              <>
                <FormField
                  control={form.control}
                  name="notifyTitle"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notification title</FormLabel>
                      <FormControl>
                        <Input placeholder="Reminder" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notifyMessage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Message</FormLabel>
                      <FormControl>
                        <Textarea placeholder="Don't forget to..." rows={2} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* Update-entities action config */}
            {actionType === 'update-entities' && (
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="targetType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target type</FormLabel>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Type" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="task">Task</SelectItem>
                          <SelectItem value="habit">Habit</SelectItem>
                          <SelectItem value="chore">Chore</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="targetStatus"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>From status</FormLabel>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Any" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="todo">To Do</SelectItem>
                          <SelectItem value="done">Done</SelectItem>
                          <SelectItem value="in-progress">In Progress</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="newStatus"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>To status</FormLabel>
                      <Select value={field.value ?? ''} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="New" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="todo">To Do</SelectItem>
                          <SelectItem value="done">Done</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            )}

            {/* Conditions */}
            <div className="border rounded-md p-3 space-y-2">
              <button
                type="button"
                className="flex items-center gap-1 text-sm font-medium w-full text-left"
                onClick={() => setConditionsOpen(!conditionsOpen)}
              >
                {conditionsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                Conditions ({conditions.length})
              </button>
              {conditionsOpen && (
                <div className="space-y-2 pt-1">
                  {conditions.map((condition, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <Select
                        value={condition.field}
                        onValueChange={(v) => updateCondition(i, { field: v as ConditionField })}
                      >
                        <SelectTrigger className="w-[130px] h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_FIELDS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={condition.operator}
                        onValueChange={(v) => updateCondition(i, { operator: v as ConditionOperator })}
                      >
                        <SelectTrigger className="w-[70px] h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_OPERATORS.map((op) => (
                            <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={condition.value}
                        onChange={(e) => updateCondition(i, { value: e.target.value })}
                        className="flex-1 h-8 text-xs"
                        placeholder="Value"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        onClick={() => removeCondition(i)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                  <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={addCondition}>
                    <Plus className="h-3 w-3 mr-1" /> Add Condition
                  </Button>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button type="submit">Save</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
