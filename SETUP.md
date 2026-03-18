# Lyra — Setup Guide

## Prerequisites

- Node.js 20+
- npm
- Git

## Quick Start (Local Development)

```bash
# Clone
git clone git@github.com:bondzai/life-os-ui.git
cd life-os-ui

# Frontend
npm install
npm run dev              # http://localhost:5173

# API (separate terminal)
cd api
npm install
cp .env.example .env     # Edit: set JWT_SECRET
npm run db:push          # Create tables in local SQLite
npm run seed             # Seed demo data
npm run dev              # http://localhost:3001
```

Set `VITE_USE_API=true` and `VITE_API_URL=http://localhost:3001/api` in a root `.env` file to connect the frontend to the API. Without these, the frontend uses localStorage only.

Default PINs: JB=`1234`, Sunny=`5678`.

---

## Production Deployment (Render + Turso)

### 1. Create Turso Database

```bash
brew install tursodatabase/tap/turso
turso auth login
turso db create lyra --location sin    # Singapore (closest region)
turso db show lyra --url               # Copy the libsql:// URL
turso db tokens create lyra            # Copy the auth token
```

### 2. Deploy API on Render

Create a **Web Service** on [render.com](https://render.com):

| Setting       | Value                                    |
|---------------|------------------------------------------|
| Root Dir      | `api`                                    |
| Build Command | `npm install`                            |
| Start Command | `npm run db:migrate && npx tsx src/index.ts` |
| Region        | Singapore                                |

Set these environment variables:

| Variable             | Value                                         |
|----------------------|-----------------------------------------------|
| `JWT_SECRET`         | `openssl rand -hex 32` (generate one)         |
| `TURSO_DATABASE_URL` | `libsql://your-db.turso.io` (from step 1)     |
| `TURSO_AUTH_TOKEN`   | Token from step 1                             |
| `CORS_ORIGINS`       | `https://lyra.onrender.com` (your frontend)   |
| `FRONTEND_URL`       | `https://lyra.onrender.com`                   |
| `PORT`               | `3001`                                        |

Optional (Google Calendar):

| Variable                | Value                                      |
|-------------------------|--------------------------------------------|
| `GOOGLE_CLIENT_ID`      | OAuth client ID from Google Cloud Console  |
| `GOOGLE_CLIENT_SECRET`  | OAuth client secret                        |
| `GOOGLE_REDIRECT_URI`   | `https://lyra-api.onrender.com/api/gcal/auth/callback` |

### 3. Seed the Database

Run once after first deploy:

```bash
cd api
TURSO_DATABASE_URL=libsql://your-db.turso.io \
TURSO_AUTH_TOKEN=your-token \
SEED_PIN_ADMIN=your-pin \
SEED_PIN_MEMBER=your-pin \
npm run seed
```

### 4. Deploy Frontend on Render

Create a **Static Site** on Render:

| Setting              | Value                        |
|----------------------|------------------------------|
| Build Command        | `npm install && npm run build` |
| Publish Directory    | `dist`                       |

Environment variables:

| Variable       | Value                                          |
|----------------|-------------------------------------------------|
| `VITE_USE_API` | `true`                                          |
| `VITE_API_URL` | `https://lyra-api.onrender.com/api`             |

Add a rewrite rule: `/* → /index.html` (for SPA routing).

### Alternative: Blueprint Deploy

Push `render.yaml` to your repo, then go to **Render > Blueprints > New Blueprint** and connect the repo. It provisions both services automatically.

---

## Docker Compose (Self-Hosted)

For running on a home server or mini PC:

```bash
cp api/.env.example api/.env
# Edit api/.env: set JWT_SECRET, optionally TURSO_* vars

docker compose up --build
# Frontend: http://localhost:8080
# API:      http://localhost:3001
```

Without Turso vars, the API uses a local SQLite file at `api/data/lyra.db`.

---

## Database Migrations

Lyra uses [Drizzle ORM](https://orm.drizzle.team) with migration files tracked in `api/drizzle/`.

### Workflow

```
1. Edit api/src/db/schema.ts        # Change your schema
2. cd api && npm run db:generate    # Generate SQL migration file
3. git add drizzle/ && git commit   # Version the migration
4. Deploy                           # Render auto-runs db:migrate on startup
```

### Commands

| Command            | Purpose                                              |
|--------------------|------------------------------------------------------|
| `npm run db:push`  | Sync schema directly to DB (dev only, no migration file) |
| `npm run db:generate` | Generate a migration file from schema changes      |
| `npm run db:migrate`  | Apply pending migration files to DB                |
| `npm run db:studio`   | Open Drizzle Studio (visual DB browser)            |
| `npm run seed`        | Seed demo data (destructive — clears existing data) |

### Rules

- **Dev**: Use `db:push` for fast iteration. No migration files needed.
- **Production**: Always use `db:generate` + commit + deploy. Migrations run automatically on startup.
- **Never** edit a migration file after it has been applied to production.
- **Never** run `seed` on production unless you want to reset all data.

### Adding a Column (Example)

```typescript
// api/src/db/schema.ts
export const entities = sqliteTable('entities', {
  // ... existing columns
  color: text('color'),  // ← add new column
})
```

```bash
cd api
npm run db:generate    # Creates api/drizzle/0001_xxx.sql
npm run db:migrate     # Apply locally
# Commit and deploy — Render applies it automatically
```

---

## Project Structure

```
lyra/
├── src/                    # Frontend (React + Vite)
│   ├── core/               # Entity engine, hooks, types
│   ├── pages/              # Route pages
│   ├── components/         # Shared UI components
│   ├── stores/             # Zustand stores
│   ├── layout/             # Sidebar, shell
│   └── lib/                # Utilities
├── api/                    # Backend (Hono + Drizzle)
│   ├── src/
│   │   ├── db/             # Schema, connection, migrations
│   │   ├── routes/         # API route handlers
│   │   ├── middleware/     # Auth (JWT)
│   │   └── index.ts        # Server entry
│   ├── drizzle/            # Migration files (committed)
│   └── data/               # Local SQLite file (gitignored)
├── docker-compose.yml      # Self-hosted deployment
├── render.yaml             # Render blueprint
└── nginx.conf              # Frontend proxy config
```

## API Endpoints

All protected routes require `Authorization: Bearer <jwt>` header.

| Method | Endpoint              | Auth | Description           |
|--------|-----------------------|------|-----------------------|
| GET    | `/api/health`         | No   | Health check          |
| POST   | `/api/auth/login`     | No   | Login with PIN        |
| GET    | `/api/entities`       | Yes  | List user entities    |
| POST   | `/api/entities`       | Yes  | Create entity         |
| PUT    | `/api/entities/:id`   | Yes  | Update entity         |
| DELETE | `/api/entities/:id`   | Yes  | Delete entity         |
| GET    | `/api/trackers`       | Yes  | List trackers         |
| POST   | `/api/trackers`       | Yes  | Create tracker entry  |
| DELETE | `/api/trackers/:id`   | Yes  | Delete tracker        |
| GET    | `/api/schedules`      | Yes  | List schedules        |
| POST   | `/api/schedules`      | Yes  | Create schedule       |
| PUT    | `/api/schedules/:id`  | Yes  | Update schedule       |
| DELETE | `/api/schedules/:id`  | Yes  | Delete schedule       |
| GET    | `/api/relations`      | Yes  | List relations        |
| POST   | `/api/relations`      | Yes  | Create relation       |
| DELETE | `/api/relations/:id`  | Yes  | Delete relation       |
| GET    | `/api/gcal/events`    | Yes  | List calendar events  |
| POST   | `/api/gcal/events`    | Yes  | Create calendar event |
| PUT    | `/api/gcal/events/:id`| Yes  | Update calendar event |
| DELETE | `/api/gcal/events/:id`| Yes  | Delete calendar event |

## Environment Variables Reference

### Frontend (root `.env`)

| Variable         | Default | Description                     |
|------------------|---------|---------------------------------|
| `VITE_USE_API`   | —       | Set `true` to use backend API   |
| `VITE_API_URL`   | —       | API base URL (e.g. `/api`)      |

### Backend (`api/.env`)

| Variable             | Default                 | Description                       |
|----------------------|-------------------------|-----------------------------------|
| `JWT_SECRET`         | *required*              | Secret for JWT signing            |
| `TURSO_DATABASE_URL` | `file:./data/lyra.db`   | Turso URL or local SQLite path    |
| `TURSO_AUTH_TOKEN`   | —                       | Turso auth token (cloud only)     |
| `PORT`               | `3001`                  | API server port                   |
| `CORS_ORIGINS`       | `http://localhost:5173`  | Comma-separated allowed origins  |
| `FRONTEND_URL`       | —                       | Frontend URL (for OAuth redirect) |
| `SEED_PIN_ADMIN`     | `1234`                  | Admin user PIN (seed only)        |
| `SEED_PIN_MEMBER`    | `5678`                  | Member user PIN (seed only)       |
| `GOOGLE_CLIENT_ID`   | —                       | Google OAuth client ID            |
| `GOOGLE_CLIENT_SECRET`| —                      | Google OAuth client secret        |
| `GOOGLE_REDIRECT_URI`| —                       | Google OAuth callback URL         |
