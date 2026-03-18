import { useState, useMemo, useRef } from 'react'
import { Pencil, Trash2, Newspaper, MessageCircle, ChevronDown, ChevronUp, ImagePlus } from 'lucide-react'
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
import { compressImage } from './memories/image-utils'
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
  const { items: posts, isLoading, create, update, remove } = useEntities('post')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [composeBody, setComposeBody] = useState('')
  const [composeVisibility, setComposeVisibility] = useState<EntityVisibility>('shared')
  const [composeImage, setComposeImage] = useState<string | null>(null)
  const composeFileRef = useRef<HTMLInputElement>(null)
  const [editingPost, setEditingPost] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set())
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [posts],
  )

  const topLevelPosts = useMemo(
    () => sortedPosts.filter((p) => !p.parentId),
    [sortedPosts],
  )

  const getReplies = (postId: string) =>
    sortedPosts.filter((p) => p.parentId === postId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const handleComposeImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const compressed = await compressImage(file)
    setComposeImage(compressed)
  }

  const handlePost = () => {
    if (!composeBody.trim()) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'post',
      title: 'Post',
      description: undefined,
      status: 'todo',
      priority: 'medium',
      tags: [],
      metadata: { body: composeBody.trim(), ...(composeImage ? { imageData: composeImage } : {}) },
      ownerId: currentUser?.id ?? '',
      visibility: composeVisibility,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setComposeBody('')
    setComposeImage(null)
    notify({ title: 'Post published', type: 'success' })
  }

  const handleReply = (parentId: string) => {
    if (!replyBody.trim()) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'post',
      title: 'Reply',
      status: 'todo',
      priority: 'medium',
      tags: [],
      metadata: { body: replyBody.trim() },
      parentId,
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setReplyBody('')
    setReplyingTo(null)
    setExpandedThreads((prev) => new Set(prev).add(parentId))
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
          <input
            ref={composeFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleComposeImage}
          />
          {composeImage && (
            <img src={composeImage} alt="Attachment" className="max-h-32 rounded object-contain" />
          )}
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
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => composeFileRef.current?.click()}>
                <ImagePlus className="h-4 w-4" />
              </Button>
              <Button size="sm" onClick={handlePost} disabled={!composeBody.trim()}>
                Post
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Feed */}
      {topLevelPosts.length === 0 ? (
        <EmptyState
          icon={Newspaper}
          title="No posts yet"
          description="Share an update with your household."
        />
      ) : (
        <div className="space-y-3">
          {topLevelPosts.map((post) => {
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
                  {typeof post.metadata.imageData === 'string' && post.metadata.imageData && (
                    <img
                      src={post.metadata.imageData}
                      alt="Post attachment"
                      className="max-h-48 rounded object-contain"
                    />
                  )}
                  {/* Reactions */}
                  {(() => {
                    const EMOJIS = ['\u2764\uFE0F', '\uD83D\uDC4D', '\uD83D\uDE02', '\uD83C\uDF89', '\uD83E\uDD14']
                    const reactions = (post.metadata.reactions || {}) as Record<string, number>
                    return (
                      <div className="flex gap-1 pt-1">
                        {EMOJIS.map((emoji) => {
                          const count = reactions[emoji] || 0
                          return (
                            <Button
                              key={emoji}
                              variant={count > 0 ? 'secondary' : 'ghost'}
                              size="sm"
                              className="h-7 px-2 text-xs gap-1"
                              onClick={() => {
                                const newReactions = { ...reactions }
                                newReactions[emoji] = (newReactions[emoji] || 0) + 1
                                update.mutate({
                                  id: post.id,
                                  updates: {
                                    metadata: { ...post.metadata, reactions: newReactions },
                                    updatedAt: new Date().toISOString(),
                                  },
                                })
                              }}
                            >
                              {emoji} {count > 0 && count}
                            </Button>
                          )
                        })}
                      </div>
                    )
                  })()}
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
                {/* Reply section */}
                {(() => {
                  const replies = getReplies(post.id)
                  const isExpanded = expandedThreads.has(post.id)
                  return (
                    <>
                      <div className="flex items-center gap-2 px-4 pb-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs gap-1"
                          onClick={() => setReplyingTo(replyingTo === post.id ? null : post.id)}
                        >
                          <MessageCircle className="h-3.5 w-3.5" /> Reply
                        </Button>
                        {replies.length > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs gap-1"
                            onClick={() => {
                              const next = new Set(expandedThreads)
                              isExpanded ? next.delete(post.id) : next.add(post.id)
                              setExpandedThreads(next)
                            }}
                          >
                            {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
                          </Button>
                        )}
                      </div>
                      {/* Reply input */}
                      {replyingTo === post.id && (
                        <div className="px-4 pb-3 flex gap-2">
                          <Textarea
                            placeholder="Write a reply..."
                            value={replyBody}
                            onChange={(e) => setReplyBody(e.target.value)}
                            rows={2}
                            className="flex-1"
                          />
                          <Button size="sm" onClick={() => handleReply(post.id)} disabled={!replyBody.trim()}>
                            Send
                          </Button>
                        </div>
                      )}
                      {/* Thread */}
                      {isExpanded && replies.length > 0 && (
                        <div className="px-4 pb-3 space-y-2 ml-8 border-l-2 border-muted">
                          {replies.map((reply) => {
                            const rAuthor = AUTHORS[reply.ownerId] || reply.ownerId
                            const rBody = typeof reply.metadata.body === 'string' ? reply.metadata.body : ''
                            return (
                              <div key={reply.id} className="space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium">{rAuthor}</span>
                                  <span className="text-[10px] text-muted-foreground">{formatRelativeTime(reply.createdAt)}</span>
                                </div>
                                {rBody && <p className="text-sm">{rBody}</p>}
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </>
                  )
                })()}
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
