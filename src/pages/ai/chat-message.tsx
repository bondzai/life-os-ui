import { Sparkles } from 'lucide-react'
import type { ChatMessage as ChatMessageType } from '@/core/types/ai'
import { Markdown } from '@/core/components/markdown'
import { cn } from '@/lib/utils'

interface ChatMessageProps {
  message: ChatMessageType
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user'
  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })

  if (message.role === 'system') return null

  return (
    <div className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg px-3 py-2',
          isUser ? 'bg-primary text-primary-foreground' : 'bg-muted',
        )}
      >
        {isUser ? (
          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
        ) : (
          <div className="flex gap-2">
            <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-1" />
            <div className="min-w-0 flex-1">
              {message.content ? (
                <Markdown content={message.content} className="text-sm" />
              ) : (
                <span className="text-xs text-muted-foreground animate-pulse">Thinking...</span>
              )}
            </div>
          </div>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground px-1">{time}</span>
    </div>
  )
}
