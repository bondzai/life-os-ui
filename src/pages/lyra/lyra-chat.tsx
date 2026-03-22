import { useRef, useEffect, useCallback } from 'react'
import { Plus, MessageSquare, Trash2, Sparkles } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useAIChat } from '@/core/hooks/use-ai-chat'
import { useChatStore } from '@/stores/chat-store'
import { useAIStore } from '@/stores/ai-store'
import { promptTemplates } from '@/core/ai/prompt-templates'
import { ChatInput } from '@/pages/ai/chat-input'
import { Markdown } from '@/core/components/markdown'
import { webSearch, formatSearchResults } from '@/core/ai/web-search'
import { AIClient } from '@/core/ai/ai-client'
import { getSolPrefix } from '@/core/ai/sol'

export function LyraChat() {
  const { activeConversation, isLoading, sendMessage } = useAIChat()
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const createConversation = useChatStore((s) => s.createConversation)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)

  const scrollRef = useRef<HTMLDivElement>(null)
  const messages = activeConversation?.messages ?? []

  // Auto-scroll to bottom on new messages
  const lastContent = messages[messages.length - 1]?.content
  useEffect(() => {
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
    })
  }, [messages.length, lastContent])

  const storeConfig = useAIStore((s) => s.config)
  const FALLBACK = { provider: 'ollama' as const, endpoint: 'http://localhost:11434/v1', model: 'llama3.2:3b', apiKey: '', contextWindow: 8192 }
  const config = storeConfig.endpoint && storeConfig.model ? storeConfig : FALLBACK

  const handleWebSearch = useCallback(async (query: string) => {
    // Ensure conversation exists
    let convId = activeConversationId
    if (!convId) convId = createConversation()

    // Add user message
    const addMsg = useChatStore.getState().addMessage
    const updateMsg = useChatStore.getState().updateMessage
    addMsg(convId!, { id: crypto.randomUUID(), role: 'user', content: `/search ${query}`, timestamp: new Date().toISOString() })

    // Add placeholder for search status
    const searchMsgId = crypto.randomUUID()
    addMsg(convId!, { id: searchMsgId, role: 'assistant', content: '', timestamp: new Date().toISOString() })
    updateMsg(convId!, searchMsgId, 'Searching the web...')

    // Search
    const results = await webSearch(query)
    const searchContext = formatSearchResults(results)

    // Build prompt with search results
    const messages = [
      {
        role: 'system' as const,
        content: [
          getSolPrefix(300),
          '',
          'The user asked a question that requires web knowledge.',
          'Web search results are provided below. Answer based on these results.',
          'Cite sources with [1], [2], etc. Be concise and factual.',
          'If results are insufficient, say so.',
          '',
          '## Web Results:',
          searchContext,
        ].join('\n'),
      },
      { role: 'user' as const, content: query },
    ]

    // Stream response
    const client = new AIClient(config)
    try {
      let full = ''
      for await (const chunk of client.stream(messages)) {
        full += chunk
        updateMsg(convId!, searchMsgId, full)
      }
    } catch {
      try {
        const response = await client.complete(messages)
        updateMsg(convId!, searchMsgId, response)
      } catch {
        updateMsg(convId!, searchMsgId, 'Search failed — is the API server running? (`cd api && npm run dev`)')
      }
    }
  }, [config, activeConversationId, createConversation])

  const handleSend = (content: string) => {
    // Intercept /search command
    if (content.toLowerCase().startsWith('/search ')) {
      const query = content.slice(8).trim()
      if (query) {
        handleWebSearch(query)
        return
      }
    }
    sendMessage(content)
  }

  const handleNewConversation = () => {
    createConversation()
  }

  const handleDeleteConversation = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteConversation(id)
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Conversation tabs */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border/40 overflow-x-auto scrollbar-thin">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 shrink-0"
          onClick={handleNewConversation}
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          <span className="text-[11px]">New</span>
        </Button>
        {conversations.map((conv) => (
          <button
            key={conv.id}
            onClick={() => setActiveConversation(conv.id)}
            className={`group flex items-center gap-1.5 h-7 px-2.5 rounded-md text-[11px] font-mono shrink-0 transition-colors ${
              conv.id === activeConversationId
                ? 'bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            }`}
          >
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate max-w-[120px]">{conv.title}</span>
            <button
              onClick={(e) => handleDeleteConversation(conv.id, e)}
              className="opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
            </button>
          </button>
        ))}
      </div>

      {/* Messages area */}
      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="px-4 py-4 space-y-3 min-h-full flex flex-col">
          {messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-4 py-12">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Start a conversation
              </p>
              <div className="flex flex-wrap justify-center gap-2 max-w-lg">
                {promptTemplates.map((tpl) => (
                  <Badge
                    key={tpl.id}
                    variant="outline"
                    className="cursor-pointer hover:bg-primary/10 transition-colors px-3 py-1.5 text-xs"
                    onClick={() => handleSend(tpl.prompt)}
                  >
                    {tpl.label}
                  </Badge>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground/60 mt-2">
                Click a template or type below
              </p>
            </div>
          ) : (
            messages.filter((msg) => msg.role !== 'system').map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[80%] rounded-lg px-3 py-2 ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-foreground'
                  }`}
                >
                  {msg.role === 'user' ? (
                    <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
                  ) : (
                    <div className="flex gap-2">
                      <Sparkles className="h-3.5 w-3.5 text-primary shrink-0 mt-1" />
                      <div className="min-w-0 flex-1">
                        {msg.content ? (
                          <Markdown content={msg.content} className="text-sm" />
                        ) : (
                          <span className="text-xs text-muted-foreground animate-pulse">Thinking...</span>
                        )}
                      </div>
                    </div>
                  )}
                  <p
                    className={`text-[10px] mt-1 ${
                      msg.role === 'user'
                        ? 'text-primary-foreground/50'
                        : 'text-muted-foreground/50'
                    }`}
                  >
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
              </div>
            ))
          )}

          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2">
                <span className="text-xs text-muted-foreground animate-pulse">
                  Lyra is thinking...
                </span>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Chat input */}
      <div className="px-4 py-3 border-t border-border/40">
        <ChatInput onSend={handleSend} disabled={isLoading} />
      </div>
    </div>
  )
}
