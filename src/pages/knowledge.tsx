import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Brain,
  User,
  Crosshair,
  Bot,
  ScrollText,
  Search,
  Plus,
  History,
  Pencil,
  Save,
  X,
  FileText,
} from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Markdown } from '@/core/components/markdown'
import { EmptyState } from '@/core/components/empty-state'
import { notify } from '@/lib/notify'
import { API_URL } from '@/lib/api-url'

interface KnowledgeFile {
  path: string
  name: string
  frontmatter: Record<string, unknown>
  body: string
  updatedAt: string
}

interface Commit {
  hash: string
  message: string
  date: string
}

function getToken() {
  return localStorage.getItem('lyra:token') || ''
}

function api(path: string, opts?: RequestInit) {
  return fetch(`${API_URL}/knowledge${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}`, ...opts?.headers },
  })
}

// Throw on non-2xx so react-query surfaces the error instead of passing an
// `{ error }` body into code that expects a file/array (which would crash
// `.filter`/`.map` or render `undefined` fields).
async function apiJson<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await api(path, opts)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return res.json()
}

const CORE_FILES = [
  { key: 'persona', label: 'Persona', icon: User, file: 'persona.md' },
  { key: 'context', label: 'Context', icon: Crosshair, file: 'context.md' },
  { key: 'agents', label: 'Agents', icon: Bot, file: 'agents.md' },
] as const

const DEFAULT_LOG_BODY = '## What\n\n\n## Why\n\n\n## What Changed\n'

function KnowledgeViewer({ file, onEdit }: { file: KnowledgeFile; onEdit: () => void }) {
  const tags = (file.frontmatter.tags as string[]) || []
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {tags.map((t) => (
            <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
          ))}
          <span className="text-xs text-muted-foreground">updated {file.updatedAt}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
        </Button>
      </div>
      <Markdown content={file.body} />
    </div>
  )
}

function KnowledgeEditor({
  file,
  onSave,
  onCancel,
}: {
  file: KnowledgeFile
  onSave: (body: string) => void
  onCancel: () => void
}) {
  const [body, setBody] = useState(file.body)
  return (
    <div className="space-y-3">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="min-h-[400px] font-mono text-sm"
      />
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          <X className="h-3.5 w-3.5 mr-1" /> Cancel
        </Button>
        <Button size="sm" onClick={() => onSave(body)}>
          <Save className="h-3.5 w-3.5 mr-1" /> Save & commit
        </Button>
      </div>
    </div>
  )
}

function CoreFileTab({ fileKey }: { fileKey: string }) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const cfg = CORE_FILES.find((f) => f.key === fileKey)!

  const { data: file, isLoading } = useQuery<KnowledgeFile>({
    queryKey: ['knowledge', 'file', cfg.file],
    queryFn: () => apiJson<KnowledgeFile>(`/file/${cfg.file}`),
  })

  const mutation = useMutation({
    mutationFn: (body: string) =>
      apiJson<KnowledgeFile>(`/file/${cfg.file}`, {
        method: 'PUT',
        body: JSON.stringify({ frontmatter: file!.frontmatter, body }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge', 'file', cfg.file] })
      setEditing(false)
      notify({ title: 'Saved & committed', type: 'success' })
    },
  })

  if (isLoading) return <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
  if (!file) return <EmptyState icon={FileText} title={`${cfg.file} not found`} description="Check LYRA_KNOWLEDGE_PATH" />

  return editing ? (
    <KnowledgeEditor file={file} onSave={(b) => mutation.mutate(b)} onCancel={() => setEditing(false)} />
  ) : (
    <KnowledgeViewer file={file} onEdit={() => setEditing(true)} />
  )
}

function LogTab() {
  const queryClient = useQueryClient()
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState(DEFAULT_LOG_BODY)

  const { data: files = [] } = useQuery<KnowledgeFile[]>({
    queryKey: ['knowledge', 'files'],
    queryFn: () => apiJson<KnowledgeFile[]>('/'),
    select: (all) =>
      all
        .filter((f) => f.path.startsWith('log/'))
        .sort((a, b) => b.path.localeCompare(a.path)),
  })

  const create = useMutation({
    mutationFn: () =>
      apiJson<KnowledgeFile>('/log', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle, body: newBody }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge', 'files'] })
      setShowNew(false)
      setNewTitle('')
      setNewBody(DEFAULT_LOG_BODY)
      notify({ title: 'Log entry created', type: 'success' })
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button size="sm" onClick={() => setShowNew(true)}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New log
        </Button>
      </div>

      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New log entry</DialogTitle>
          </DialogHeader>
          <Input placeholder="Decision title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          <Textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            className="min-h-[200px] font-mono text-sm"
          />
          <DialogFooter>
            <Button size="sm" onClick={() => create.mutate()} disabled={!newTitle.trim()}>
              Create & commit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {files.length === 0 ? (
        <EmptyState icon={ScrollText} title="No log entries" description="Record your first decision" actionLabel="New log" onAction={() => setShowNew(true)} />
      ) : (
        <div className="space-y-3">
          {files.map((f) => (
            <Card key={f.path}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">{f.name.replace('log/', '').replace(/-/g, ' ')}</CardTitle>
                  <span className="text-xs text-muted-foreground">{f.updatedAt}</span>
                </div>
              </CardHeader>
              <CardContent>
                <Markdown content={f.body} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function SearchTab() {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  // Debounce so each keystroke doesn't trigger a full backend file scan.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 300)
    return () => clearTimeout(t)
  }, [query])

  const { data: results = [] } = useQuery<KnowledgeFile[]>({
    queryKey: ['knowledge', 'search', debounced],
    queryFn: () => apiJson<KnowledgeFile[]>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
  })

  return (
    <div className="space-y-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search knowledge…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
        />
      </div>
      {debounced.length >= 2 && results.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">No results</p>
      )}
      {results.map((f) => (
        <Card key={f.path}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">{f.name}</CardTitle>
              <div className="flex gap-1">
                {((f.frontmatter.tags as string[]) || []).map((t) => (
                  <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Markdown content={f.body.slice(0, 300) + (f.body.length > 300 ? '…' : '')} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

function HistoryTab() {
  const { data: commits = [] } = useQuery<Commit[]>({
    queryKey: ['knowledge', 'history'],
    queryFn: () => apiJson<Commit[]>('/history'),
  })

  return commits.length === 0 ? (
    <EmptyState icon={History} title="No history" description="Git commits will appear here" />
  ) : (
    <div className="space-y-1">
      {commits.map((c) => (
        <div key={c.hash} className="flex items-center gap-3 py-2 px-3 rounded hover:bg-muted/50 text-sm">
          <code className="text-xs text-muted-foreground font-mono">{c.hash}</code>
          <span className="flex-1">{c.message}</span>
          <span className="text-xs text-muted-foreground">{c.date?.split(' ')[0]}</span>
        </div>
      ))}
    </div>
  )
}

export function KnowledgePage() {
  const [tab, setTab] = useState('persona')

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Brain className="h-6 w-6" />
        <h1 className="text-2xl font-bold">Knowledge</h1>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          {CORE_FILES.map((f) => {
            const Icon = f.icon
            return (
              <TabsTrigger key={f.key} value={f.key}><Icon className="h-3.5 w-3.5 mr-1" /> {f.label}</TabsTrigger>
            )
          })}
          <TabsTrigger value="log"><ScrollText className="h-3.5 w-3.5 mr-1" /> Log</TabsTrigger>
          <TabsTrigger value="search"><Search className="h-3.5 w-3.5 mr-1" /> Search</TabsTrigger>
          <TabsTrigger value="history"><History className="h-3.5 w-3.5 mr-1" /> History</TabsTrigger>
        </TabsList>

        {CORE_FILES.map((f) => (
          <TabsContent key={f.key} value={f.key}>
            <CoreFileTab fileKey={f.key} />
          </TabsContent>
        ))}
        <TabsContent value="log"><LogTab /></TabsContent>
        <TabsContent value="search"><SearchTab /></TabsContent>
        <TabsContent value="history"><HistoryTab /></TabsContent>
      </Tabs>
    </div>
  )
}
