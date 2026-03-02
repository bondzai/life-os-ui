import { useState, useMemo } from 'react'
import { Pencil, Trash2, Newspaper } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityVisibility } from '@/core/types'

const AUTHORS: Record<string, string> = {
  'user-jb': 'JB',
  'user-sunny': 'Sunny',
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  return new Date(iso).toLocaleDateString()
}

export function PostsPage() {
  const { items: posts, isLoading, create, remove } = useEntities('post')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [composeBody, setComposeBody] = useState('')
  const [composeVisibility, setComposeVisibility] = useState<EntityVisibility>('shared')
  const [editingPost, setEditingPost] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [posts],
  )

  const handlePost = () => {
    if (!composeBody.trim()) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'post',
      title: 'Post',
      description: undefined,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: { body: composeBody.trim() },
      ownerId: currentUser?.id ?? '',
      visibility: composeVisibility,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setComposeBody('')
    notify({ title: 'Post published', type: 'success' })
  }

  const handleEdit = (_values: Record<string, unknown>) => {
    if (!editingPost) return
    setEditingPost(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      {/* Compose box */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          <Textarea
            placeholder="What's on your mind?"
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            rows={3}
          />
          <div className="flex items-center justify-between">
            <Select
              value={composeVisibility}
              onValueChange={(v) => setComposeVisibility(v as EntityVisibility)}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="shared">Shared</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={handlePost} disabled={!composeBody.trim()}>
              Post
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Feed */}
      {sortedPosts.length === 0 ? (
        <EmptyState
          icon={Newspaper}
          title="No posts yet"
          description="Share an update with your household."
        />
      ) : (
        <div className="space-y-3">
          {sortedPosts.map((post) => {
            const authorName = AUTHORS[post.ownerId] || post.ownerId
            const initials = authorName.charAt(0).toUpperCase()
            const isOwn = post.ownerId === currentUser?.id
            const body = typeof post.metadata.body === 'string' ? post.metadata.body : ''

            return (
              <Card key={post.id}>
                <CardContent className="pt-4 space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
                      {initials}
                    </div>
                    <div className="flex-1">
                      <span className="text-sm font-medium">{authorName}</span>
                      <span className="text-xs text-muted-foreground ml-2">
                        {formatRelativeTime(post.createdAt)}
                      </span>
                    </div>
                    <Badge variant="outline" className="text-xs capitalize">
                      {post.visibility}
                    </Badge>
                  </div>
                  {body && <p className="text-sm">{body}</p>}
                  {isOwn && (
                    <div className="flex gap-1 pt-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => setEditingPost(post)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => setDeleteTarget(post)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingPost}
        onOpenChange={(open) => !open && setEditingPost(null)}
        entityType="post"
        title="Edit Post"
        defaultValues={editingPost ?? undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Post"
        description="Are you sure you want to delete this post?"
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Post deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
