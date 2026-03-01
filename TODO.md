# Phase 3.5 — Deferred Tasks

These items were deferred from Phase 3 (AI layer) and should be addressed before or during Phase 4+.

## API Server
- [ ] Set up API server project (Hono or Fastify + SQLite/Drizzle)
- [ ] Define REST endpoints for entities, trackers, relations, schedules
- [ ] Add authentication middleware (PIN-based or token)

## localStorage to API Migration
- [ ] Replace `LocalRepository` with `ApiRepository` implementation
- [ ] Update `useRepository` hook to use API client (TanStack Query already in place)
- [ ] Migrate seed data to server-side database seeding

## OpenClaw Integration
- [ ] Create OpenClaw AI provider skill in `src/core/ai/`
- [ ] Connect to OpenClaw agent hub on mini PC
- [ ] Enable agent-to-agent communication for automated tasks

## Cron Jobs / Scheduled Tasks
- [ ] Daily brief generation (morning summary)
- [ ] Habit streak reset at midnight if not checked in
- [ ] Weekly/monthly report generation

## Docker Compose
- [ ] Create `docker-compose.yml` for Life-OS stack (UI + API + OpenClaw)
- [ ] Add Dockerfile for UI (Vite build + static serve)
- [ ] Add Dockerfile for API server
- [ ] Configure networking between services
