import { useState, useMemo, useEffect } from 'react'
import { Plus, Zap, Play, Clock, BookTemplate } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  TRIGGER_TYPES,
  TRIGGER_LABELS,
  ACTION_TYPES,
  ACTION_LABELS,
  AUTOMATION_TEMPLATES,
  type TriggerType,
  type ScheduleInterval,
  type ActionType,
} from './automate/automate-helpers'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AutomationDialog, type AutomationFormValues } from './automate/automation-dialog'
import { AutomationCard } from './automate/automation-card'
import { AutomationHistory } from './automate/automation-history'
import { runAutomation, runDueAutomations, handleAutomationEvent } from './automate/automation-engine'
import { subscribeAutomationEvents } from './automate/automation-event-bus'
import type { Condition } from './automate/automate-helpers'
import type { Entity } from '@/core/types'

function formToMetadata(values: AutomationFormValues, conditions?: Condition[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    triggerType: values.triggerType,
    actionType: values.actionType,
    enabled: true,
    runCount: 0,
  }

  if (conditions && conditions.length > 0) {
    meta.conditions = conditions
  }

  if (values.triggerType === 'schedule') {
    meta.scheduleInterval = values.scheduleInterval ?? 'weekly'
    // Set initial nextDue to tomorrow
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    meta.nextDue = tomorrow.toISOString().split('T')[0]
  }

  if (values.triggerType === 'event') {
    meta.eventConfig = {
      watchType: values.watchType || undefined,
      watchStatus: values.watchStatus || undefined,
    }
  }

  const actionConfig: Record<string, unknown> = {}
  switch (values.actionType) {
    case 'create-entity':
      actionConfig.entityType = values.entityType || 'task'
      actionConfig.title = values.entityTitle || values.title
      actionConfig.tags = values.entityTags ? values.entityTags.split(',').map((t) => t.trim()).filter(Boolean) : []
      actionConfig.priority = 'medium'
      break
    case 'notify':
      actionConfig.notifyTitle = values.notifyTitle || values.title
      actionConfig.notifyMessage = values.notifyMessage || ''
      break
    case 'update-entities':
      actionConfig.targetType = values.targetType || ''
      actionConfig.targetStatus = values.targetStatus || ''
      actionConfig.newStatus = values.newStatus || ''
      break
  }
  meta.actionConfig = actionConfig

  return meta
}

function metadataToForm(entity: Entity): AutomationFormValues {
  const actionConfig = (entity.metadata.actionConfig as Record<string, unknown>) || {}
  const eventConfig = (entity.metadata.eventConfig as Record<string, unknown>) || {}
  return {
    title: entity.title,
    description: entity.description || '',
    triggerType: entity.metadata.triggerType as TriggerType,
    scheduleInterval: entity.metadata.scheduleInterval as ScheduleInterval | undefined,
    actionType: entity.metadata.actionType as ActionType,
    entityType: (actionConfig.entityType as string) || 'task',
    entityTitle: (actionConfig.title as string) || '',
    entityTags: Array.isArray(actionConfig.tags) ? (actionConfig.tags as string[]).join(', ') : '',
    notifyTitle: (actionConfig.notifyTitle as string) || '',
    notifyMessage: (actionConfig.notifyMessage as string) || '',
    targetType: (actionConfig.targetType as string) || '',
    targetStatus: (actionConfig.targetStatus as string) || '',
    newStatus: (actionConfig.newStatus as string) || '',
    watchType: (eventConfig.watchType as string) || '',
    watchStatus: (eventConfig.watchStatus as string) || '',
  }
}

function metadataToConditions(entity: Entity): Condition[] {
  const conditions = entity.metadata.conditions
  return Array.isArray(conditions) ? (conditions as Condition[]) : []
}

export function AutomatePage() {
  const { items: automations, create, update, remove } = useEntities('automation')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('automations')
  const [triggerFilter, setTriggerFilter] = useState('all')
  const [actionFilter, setActionFilter] = useState('all')

  // Dialogs
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingAutomation, setEditingAutomation] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [previewResult, setPreviewResult] = useState<string | null>(null)

  // Run due automations on mount
  useEffect(() => {
    if (currentUser) {
      const count = runDueAutomations(currentUser.id)
      if (count > 0) {
        notify({ title: `Ran ${count} scheduled automation(s)`, type: 'info' })
      }
    }
  }, [currentUser])

  // Subscribe to event bus
  useEffect(() => {
    if (!currentUser) return
    const unsub = subscribeAutomationEvents((event) => {
      handleAutomationEvent(event, currentUser.id)
    })
    return unsub
  }, [currentUser])

  // Summary stats
  const activeCount = useMemo(
    () => automations.filter((a) => a.status === 'todo' && a.metadata.enabled !== false).length,
    [automations],
  )
  const scheduledCount = useMemo(
    () => automations.filter((a) => a.metadata.triggerType === 'schedule').length,
    [automations],
  )
  const totalRuns = useMemo(
    () => automations.reduce((sum, a) => sum + ((a.metadata.runCount as number) || 0), 0),
    [automations],
  )

  // Filtered
  const filteredAutomations = useMemo(() => {
    let result = automations
    if (triggerFilter !== 'all') result = result.filter((a) => a.metadata.triggerType === triggerFilter)
    if (actionFilter !== 'all') result = result.filter((a) => a.metadata.actionType === actionFilter)
    return result
  }, [automations, triggerFilter, actionFilter])

  // CRUD handlers
  const handleCreate = (values: AutomationFormValues, conditions?: Condition[]) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'automation',
      title: values.title,
      description: values.description || undefined,
      status: 'todo',
      priority: 'medium',
      tags: [],
      metadata: formToMetadata(values, conditions),
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Automation created', type: 'success' })
  }

  const handleEdit = (values: AutomationFormValues, conditions?: Condition[]) => {
    if (!editingAutomation) return
    const meta = formToMetadata(values, conditions)
    // Preserve runtime state
    meta.lastRun = editingAutomation.metadata.lastRun
    meta.runCount = editingAutomation.metadata.runCount
    meta.nextDue = editingAutomation.metadata.nextDue
    meta.enabled = editingAutomation.metadata.enabled !== false

    update.mutate({
      id: editingAutomation.id,
      updates: {
        title: values.title,
        description: values.description || undefined,
        metadata: meta,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Automation updated', type: 'success' })
    setEditingAutomation(null)
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    remove.mutate(deleteTarget.id)
    notify({ title: 'Automation deleted', type: 'success' })
    setDeleteTarget(null)
  }

  const handleRun = (automation: Entity) => {
    if (!currentUser) return
    runAutomation(automation, currentUser.id)
    notify({ title: `Ran "${automation.title}"`, type: 'success' })
  }

  const handlePreview = (automation: Entity) => {
    if (!currentUser) return
    const result = runAutomation(automation, currentUser.id, { dryRun: true })
    setPreviewResult(typeof result === 'string' ? result : 'No preview available')
  }

  const handleActivateTemplate = (templateId: string) => {
    const template = AUTOMATION_TEMPLATES.find((t) => t.id === templateId)
    if (!template) return

    // Check if already activated
    const exists = automations.some((a) => a.metadata.templateId === templateId)
    if (exists) {
      notify({ title: 'Template already active', type: 'warning' })
      return
    }

    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)

    create.mutate({
      id: crypto.randomUUID(),
      type: 'automation',
      title: template.name,
      description: template.description,
      status: 'todo',
      priority: 'medium',
      tags: ['template'],
      metadata: {
        templateId: template.id,
        triggerType: template.triggerType,
        scheduleInterval: template.scheduleInterval,
        actionType: template.actionType,
        actionConfig: template.actionConfig,
        enabled: true,
        runCount: 0,
        nextDue: tomorrow.toISOString().split('T')[0],
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: `Activated "${template.name}"`, type: 'success' })
  }

  const activatedTemplateIds = useMemo(
    () => new Set(automations.map((a) => a.metadata.templateId as string).filter(Boolean)),
    [automations],
  )

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Automations</CardTitle>
            <Zap className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{automations.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active</CardTitle>
            <Play className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-600">{activeCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Scheduled</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{scheduledCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Runs</CardTitle>
            <Zap className="h-4 w-4 text-yellow-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalRuns}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="automations">Automations</TabsTrigger>
            <TabsTrigger value="templates">Templates</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          {tab === 'automations' && (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Automation
            </Button>
          )}
        </div>

        {/* Automations Tab */}
        <TabsContent value="automations" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={triggerFilter} onValueChange={setTriggerFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Trigger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Triggers</SelectItem>
                {TRIGGER_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TRIGGER_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={actionFilter} onValueChange={setActionFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                {ACTION_TYPES.map((a) => (
                  <SelectItem key={a} value={a}>
                    {ACTION_LABELS[a]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredAutomations.length === 0 ? (
            <EmptyState
              icon={Zap}
              title="No automations yet"
              description="Create custom automations or activate a template to get started."
              actionLabel="New Automation"
              onAction={() => setDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAutomations.map((automation) => (
                <AutomationCard
                  key={automation.id}
                  automation={automation}
                  onEdit={setEditingAutomation}
                  onDelete={setDeleteTarget}
                  onRun={handleRun}
                  onPreview={handlePreview}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Templates Tab */}
        <TabsContent value="templates" className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {AUTOMATION_TEMPLATES.map((template) => {
              const isActive = activatedTemplateIds.has(template.id)
              return (
                <Card key={template.id} className={isActive ? 'border-green-500/50' : ''}>
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="text-sm font-medium">{template.name}</CardTitle>
                      <BookTemplate className="h-4 w-4 text-muted-foreground shrink-0" />
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-xs text-muted-foreground">{template.description}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="capitalize">{template.triggerType}</span>
                      {template.scheduleInterval && (
                        <>
                          <span>&middot;</span>
                          <span className="capitalize">{template.scheduleInterval}</span>
                        </>
                      )}
                      <span>&middot;</span>
                      <span>{ACTION_LABELS[template.actionType]}</span>
                    </div>
                    <Button
                      size="sm"
                      variant={isActive ? 'outline' : 'default'}
                      className="w-full"
                      disabled={isActive}
                      onClick={() => handleActivateTemplate(template.id)}
                    >
                      {isActive ? 'Active' : 'Activate'}
                    </Button>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </TabsContent>
        {/* History Tab */}
        <TabsContent value="history" className="space-y-4">
          <AutomationHistory
            automationNames={automations.map((a) => ({ id: a.id, title: a.title }))}
          />
        </TabsContent>
      </Tabs>

      {/* Preview dialog */}
      <Dialog open={!!previewResult} onOpenChange={(open) => !open && setPreviewResult(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Dry Run Preview</DialogTitle>
          </DialogHeader>
          <p className="text-sm whitespace-pre-wrap">{previewResult}</p>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <AutomationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <AutomationDialog
        open={!!editingAutomation}
        onOpenChange={(open) => !open && setEditingAutomation(null)}
        title="Edit Automation"
        defaultValues={editingAutomation ? metadataToForm(editingAutomation) : undefined}
        defaultConditions={editingAutomation ? metadataToConditions(editingAutomation) : undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Automation"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={handleDelete}
      />
    </div>
  )
}
