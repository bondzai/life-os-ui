import { useEffect, useRef, useState } from 'react'
import { MessageSquarePlus, Settings, Trash2 } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { useChatStore } from '@/stores/chat-store'
import { useAIStore } from '@/stores/ai-store'
import { useAIChat } from '@/core/hooks/use-ai-chat'
import { promptTemplates } from '@/core/ai'
import { ChatMessage } from './chat-message'
import { ChatInput } from './chat-input'
import { AISettingsDialog } from './ai-settings-dialog'

export function ChatSidebar() {
  const isOpen = useChatStore((s) => s.isOpen)
  const setOpen = useChatStore((s) => s.setOpen)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const createConversation = useChatStore((s) => s.createConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const isConfigured = useAIStore((s) => s.isConfigured)

  const { activeConversation, isLoading, sendMessage } = useAIChat()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeConversation?.messages])

  return (
    <>
      <Sheet open={isOpen} onOpenChange={setOpen}>
        <SheetContent side="right" className="sm:max-w-md w-full flex flex-col p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <div className="flex items-center justify-between">
              <SheetTitle className="text-base">Chat</SheetTitle>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => createConversation()}
                  title="New chat"
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setSettingsOpen(true)}
                  title="Settings"
                >
                  <Settings className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {conversations.length > 0 && (
              <div className="flex gap-2 items-center">
                <Select
                  value={activeConversationId ?? ''}
                  onValueChange={setActiveConversation}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select conversation" />
                  </SelectTrigger>
                  <SelectContent>
                    {conversations.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-xs">
                        {c.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {activeConversationId && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => deleteConversation(activeConversationId)}
                    title="Delete conversation"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            )}
          </SheetHeader>

          <Separator />

          {/* Messages */}
          <ScrollArea className="flex-1 px-4">
            <div ref={scrollRef} className="space-y-4 py-4">
              {!isConfigured ? (
                <div className="text-center py-8 space-y-3">
                  <p className="text-sm text-muted-foreground">
                    AI is not configured yet.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings className="h-3.5 w-3.5 mr-1.5" />
                    Configure AI
                  </Button>
                </div>
              ) : !activeConversation || activeConversation.messages.length === 0 ? (
                <div className="space-y-3 py-4">
                  <p className="text-sm text-muted-foreground text-center">
                    Start a conversation or try a quick action:
                  </p>
                  <div className="space-y-2">
                    {promptTemplates.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => sendMessage(t.prompt)}
                        className="w-full text-left rounded-md border p-2.5 text-xs hover:bg-accent transition-colors"
                      >
                        <span className="font-medium">{t.label}</span>
                        <span className="block text-muted-foreground mt-0.5">
                          {t.description}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                activeConversation.messages
                  .filter((m) => m.role !== 'system')
                  .map((msg) => <ChatMessage key={msg.id} message={msg} />)
              )}
            </div>
          </ScrollArea>

          <Separator />

          {/* Input */}
          <div className="p-4">
            <ChatInput
              onSend={sendMessage}
              disabled={isLoading || !isConfigured}
            />
          </div>
        </SheetContent>
      </Sheet>

      <AISettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  )
}
