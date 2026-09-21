# AI Layer

> **This is the *browser* AI layer, and it is not an MCP server.**
>
> Three unrelated things in this repo are called MCP: this registry (which runs in the page and is
> unreachable from anything outside the tab), `lyra-mcp` (a real MCP server — see
> [`docs/mcp.md`](./mcp.md)), and vfat's hosted MCP server upstream. "Expand MCP to cover all
> features" means the second one.
>
> **Partly historical.** Written against the Phase-3 feature set; it documents
> `daily-brief-widget.tsx`, since deleted, and knows nothing of the sixteen files now in
> `src/core/ai/tools/` or the ten in `src/core/ai/context/`. The source is the list.

The AI layer (Phase 3) adds a swappable AI provider system, chat sidebar, command bar, and daily brief. All AI requests use the OpenAI-compatible `/chat/completions` endpoint format, making it work with OpenAI, Claude (via proxy), Ollama, OpenClaw, or any compatible API.

## Provider system

### Configuration

Stored in Zustand with localStorage persistence (`life-os:ai`):

```typescript
interface AIConfig {
  provider: 'openai' | 'claude' | 'ollama' | 'custom'
  endpoint: string       // e.g. http://localhost:11434/v1
  model: string          // e.g. llama3
  apiKey: string         // optional for local models
  contextWindow: number  // token limit
}
```

### Default presets

| Provider | Endpoint | Model |
|----------|----------|-------|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Claude | `http://localhost:8080/v1` | `claude-sonnet-4-20250514` |
| Ollama | `http://localhost:11434/v1` | `llama3` |
| Custom | (user-defined) | (user-defined) |

### AI Client

`AIClient` class in `src/core/ai/ai-client.ts`:

- `complete(messages)` — non-streaming POST, returns full response
- `stream(messages)` — SSE streaming via `AsyncGenerator<string>`, parses `data:` lines incrementally

The `useAIChat` hook tries streaming first, falls back to non-streaming on error.

## Context builder

`src/core/ai/context-builder.ts` gathers entity data and formats it into system prompts:

- `gatherContext()` — reads all entities, groups by type, caps at 20 tasks / 10 goals / 10 habits / 10 events
- `buildSystemPrompt(context)` — formats entities into a structured system message with today's date
- `buildDailyBriefPrompt(context)` — extends the system prompt with daily brief instructions

Every AI request includes the user's entity data as context, so the assistant knows about their tasks, goals, and habits.

## UI components

All in `src/pages/ai/`:

### Chat sidebar (`chat-sidebar.tsx`)

Right-side Sheet panel. Contains:
- Conversation list dropdown with create/delete
- Message history with auto-scroll
- Quick action buttons (daily brief, task breakdown, weekly review)
- Settings button opens AI configuration dialog
- "Not configured" state prompts to open settings

### Command bar (`command-bar.tsx`)

Dialog triggered by `Cmd+K` (global keyboard shortcut). Two modes:
- **Search mode** (default) — filters entities and module navigation by text match
- **AI mode** (prefix `/ask ` or press Tab) — sends query to AI, streams response inline

### Daily brief widget (`daily-brief-widget.tsx`)

Dashboard card showing:
- Computed stats: tasks due today, overdue count, active goals, active habits
- "Generate Brief" button (when AI is configured) — calls LLM, caches in sessionStorage by date

### Chat input (`chat-input.tsx`)

Textarea with Enter-to-send, Shift+Enter for newline.

### Chat message (`chat-message.tsx`)

Bubble component — user messages right-aligned (primary color), assistant left-aligned (muted).

### AI settings dialog (`ai-settings-dialog.tsx`)

Configuration form: provider, endpoint, model, API key, context window.

## Prompt templates

Predefined quick actions in `src/core/ai/prompt-templates.ts`:

| Template | Purpose |
|----------|---------|
| Daily Brief | Summary of today's tasks, deadlines, and priorities |
| Task Breakdown | Break down the most important goal into actionable tasks |
| Weekly Review | Review accomplishments and plan next week |

## File map

```
src/core/types/ai.ts          — Type definitions
src/core/ai/ai-client.ts      — HTTP client (streaming + non-streaming)
src/core/ai/context-builder.ts — Entity context → system prompt
src/core/ai/prompt-templates.ts — Quick action templates
src/core/ai/index.ts           — Barrel exports
src/core/hooks/use-ai-chat.ts  — React hook wrapping client + stores
src/stores/ai-store.ts         — AI config (Zustand + persist)
src/stores/chat-store.ts       — Conversations (Zustand + persist)
src/pages/ai/*.tsx              — UI components
```
