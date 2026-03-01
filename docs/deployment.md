# Deployment

Life-OS runs on a mini PC (home server) via Docker Compose. All services are local-only by default — no cloud, no public exposure.

## Prerequisites

- Mini PC running Linux (Ubuntu/Debian) or macOS
- Docker + Docker Compose
- Node.js >= 22 (for OpenClaw)
- Optional: Tailscale for secure remote access

## Docker Compose (planned)

```yaml
version: '3.8'

services:
  # Life-OS UI — React SPA served by nginx
  ui:
    build: ./life-os-ui
    ports:
      - "5173:80"
    depends_on:
      - api
    environment:
      - VITE_API_URL=http://localhost:3000

  # Life-OS API — Hono + SQLite
  api:
    build: ./life-os-api
    ports:
      - "3000:3000"
    volumes:
      - life-os-data:/app/data    # SQLite file persistence
    environment:
      - DATABASE_PATH=/app/data/life-os.db
      - AUTH_TOKEN_JB=${AUTH_TOKEN_JB}
      - AUTH_TOKEN_SUNNY=${AUTH_TOKEN_SUNNY}

  # OpenClaw Gateway — AI agent
  openclaw:
    image: node:22
    command: npx openclaw@latest start
    ports:
      - "18789:18789"
    volumes:
      - openclaw-data:/root/.openclaw
    environment:
      - LIFEOS_API=http://api:3000
    depends_on:
      - api

volumes:
  life-os-data:
  openclaw-data:
```

## Directory structure on the server

```
~/life-os/
├── docker-compose.yml
├── life-os-ui/          ← this repo
│   └── Dockerfile
├── life-os-api/         ← API server repo
│   └── Dockerfile
└── .env                 ← AUTH_TOKEN_JB, AUTH_TOKEN_SUNNY
```

## UI Dockerfile

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

## Network

All services communicate on the Docker bridge network. Only the UI port (5173) and optionally the API port (3000) are exposed to the LAN.

```
LAN device → http://minipc:5173 → Life-OS UI
LAN device → http://minipc:3000 → Life-OS API (direct, optional)
OpenClaw → http://api:3000     → Life-OS API (internal Docker network)
```

## Remote access

For accessing Life-OS outside the home network:

### Option A: Tailscale (recommended)

```bash
# On the mini PC
tailscale up
tailscale serve --https=443 http://localhost:5173
```

Access from anywhere on your tailnet: `https://minipc.tail1234.ts.net`

### Option B: Tailscale Funnel (public)

```bash
tailscale funnel --https=443 http://localhost:5173
```

Public HTTPS URL. Use with caution — add auth middleware.

### Option C: SSH tunnel

```bash
# From your laptop
ssh -L 5173:localhost:5173 user@minipc
```

Then open `http://localhost:5173` on your laptop.

## Backup

SQLite is a single file. Back it up with cron:

```bash
# crontab -e
0 3 * * * cp ~/life-os/data/life-os.db ~/backups/life-os-$(date +\%Y\%m\%d).db
```

OpenClaw data is in `~/.openclaw/` — back up the whole directory.

## Updates

```bash
cd ~/life-os
git -C life-os-ui pull
git -C life-os-api pull
docker compose build
docker compose up -d
```
