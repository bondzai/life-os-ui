import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ChatConversation, ChatMessage } from '@/core/types/ai'

interface ChatState {
  conversations: ChatConversation[]
  activeConversationId: string | null
  isOpen: boolean
  setOpen: (open: boolean) => void
  toggleOpen: () => void
  createConversation: () => string
  setActiveConversation: (id: string | null) => void
  addMessage: (conversationId: string, message: ChatMessage) => void
  updateMessage: (conversationId: string, messageId: string, content: string) => void
  deleteConversation: (id: string) => void
  clearAll: () => void
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      conversations: [],
      activeConversationId: null,
      isOpen: false,

      setOpen: (open) => set({ isOpen: open }),
      toggleOpen: () => set((s) => ({ isOpen: !s.isOpen })),

      createConversation: () => {
        const id = crypto.randomUUID()
        const now = new Date().toISOString()
        const conversation: ChatConversation = {
          id,
          title: 'New Chat',
          messages: [],
          createdAt: now,
          updatedAt: now,
        }
        set((s) => ({
          conversations: [conversation, ...s.conversations],
          activeConversationId: id,
        }))
        return id
      },

      setActiveConversation: (id) => set({ activeConversationId: id }),

      addMessage: (conversationId, message) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: [...c.messages, message],
                  title:
                    c.messages.length === 0 && message.role === 'user'
                      ? message.content.slice(0, 50)
                      : c.title,
                  updatedAt: new Date().toISOString(),
                }
              : c,
          ),
        })),

      updateMessage: (conversationId, messageId, content) =>
        set((s) => ({
          conversations: s.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === messageId ? { ...m, content } : m,
                  ),
                  updatedAt: new Date().toISOString(),
                }
              : c,
          ),
        })),

      deleteConversation: (id) =>
        set((s) => {
          const conversations = s.conversations.filter((c) => c.id !== id)
          return {
            conversations,
            activeConversationId:
              s.activeConversationId === id
                ? conversations[0]?.id ?? null
                : s.activeConversationId,
          }
        }),

      clearAll: () => set({ conversations: [], activeConversationId: null }),
    }),
    {
      name: 'life-os:chat',
      partialize: (state) => ({
        conversations: state.conversations,
        activeConversationId: state.activeConversationId,
      }),
    },
  ),
)
