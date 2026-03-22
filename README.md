# Lyra

A self-hosted life operating system with AI-powered strategic intelligence.

> Navigate your life by the stars.

## What is Lyra?

Lyra is a full-stack personal life management system that tracks everything — goals, tasks, projects, habits, health, wealth, learning, travel, and family — in one unified interface. It features a local AI assistant (powered by Ollama) that proactively monitors your data and surfaces insights.

## Features

### Core System
- **Entity-based architecture** — 30+ entity types, one unified data model
- **Projects** — track online & offline projects with velocity, stack, links
- **Goals** — hierarchical with sub-goals, progress tracking, deadline velocity
- **Tasks** — stories with subtasks, kanban board, list/log views, recurrence
- **Habits** — daily streaks, protocols (multi-step checklists), heatmaps
- **Skills** — mastery levels (novice → expert), rusty detection, learning paths
- **Notes** — freeform, journal, decision journal with revisit prompts
- **Health** — body metrics, workouts, sleep/mood tracking
- **Wealth** — transactions, budgets, accounts, portfolio, crypto

### Lyra AI
- **Local LLM** via Ollama (llama3.2) — data never leaves your machine
- **MCP-style tool system** — 5 registered tools: suggest-focus, break-down, analyze-risk, coaching, weekly-summary
- **Sol personality** — INTJ strategist with time-of-day awareness, customizable
- **Lyra page** — full command interface: chat, tool arsenal, settings
- **Graceful degradation** — AI offline = algorithmic fallback, no broken states

### Proactive Intelligence
- **Lyra Pulse** — background 10-min detector cycle, toast notifications
- **Deep Work Coach** — streak alerts, progress, next task during focus sessions
- **Session Summary** — toast on pomodoro end with task progress
- **Real-time Celebrations** — instant toasts on achievements
- **Morning Brief** — 8 signal detectors: streak risk, stale projects, budget, sleep, energy, decisions, achievements, velocity
- **Dynamic Dashboard** — 12 signal-driven widgets, Rules/Lyra mode toggle

### Focus & Productivity
- **Deep Work** — Pomodoro timer (classic/deep/sprint), Emperor Time
- **Focus Score** — daily priority completion percentage
- **Weekly Review** — 6-step wizard with System Audit
- **Automation Rules** — 5 rule templates with toggle switches
- **Command Palette** — `Cmd+K` to search and navigate everywhere

## Tech Stack

- **Frontend**: React 19, TypeScript 5.9, Vite 7, Tailwind CSS 4, Radix/shadcn UI
- **State**: Zustand, TanStack React Query
- **Backend**: Hono, SQLite via Drizzle ORM, JWT auth
- **AI**: Ollama (local), OpenAI-compatible API, provider-agnostic
- **Charts**: Recharts
- **PWA**: Offline support via vite-plugin-pwa

## Quick Start

```bash
npm install
npm run dev:safe    # Vite + TypeScript watch

# Enable AI (optional)
brew install ollama
brew services start ollama
ollama pull llama3.2:3b
```

## Release History

| Version | Codename | Phase |
|---------|----------|-------|
| v1.3.0 | | Proactive Lyra |
| v1.2.0 | | Dynamic Dashboard |
| v1.1.0 | | Lyra Command Interface |
| v1.0.0 | Trident | Lyra AI |
| v0.66.0 | Tomahawk | Strategic Arsenal |
| v0.65.0 | | Projects & Command Center |

## Architecture

```
src/
  core/           # Entity types, repositories, hooks, AI system
    ai/           # AI client, tools registry, context builders, Sol personality
    hooks/        # useEntities, useTrackers, useRelations, useAIChat
  pages/          # Feature pages (lazy-loaded)
  hooks/          # App hooks: useAI, useMorningBrief, useLyraPulse, useCelebrations
  components/     # Shared UI: AIAction, ViewToggle, view-toggle
  stores/         # Zustand stores: auth, focus, chat, ai, ui
  layout/         # AppLayout, sidebar, top bar
api/              # Hono backend with SQLite
```

## License

Private — personal use.
