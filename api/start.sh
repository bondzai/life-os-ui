#!/bin/bash
# Lyra API — production startup script
# Run with: ./api/start.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Load env file if exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

# Validate required env vars
if [ -z "$JWT_SECRET" ]; then
  echo "ERROR: JWT_SECRET is required. Generate one with:"
  echo "  openssl rand -hex 32"
  exit 1
fi

# Defaults
export PORT="${PORT:-3001}"
export CORS_ORIGINS="${CORS_ORIGINS:-https://lyra.onrender.com,http://localhost:5173}"
export FRONTEND_URL="${FRONTEND_URL:-https://lyra.onrender.com}"

echo "Lyra API starting..."
echo "  Port: $PORT"
echo "  CORS: $CORS_ORIGINS"
echo "  Frontend: $FRONTEND_URL"
echo "  DB: ${TURSO_DATABASE_URL:-file:./data/lyra.db}"

# Run migrations (safe to run repeatedly — only applies new ones)
echo "  Running migrations..."
npx tsx src/db/migrate.ts

# Seed database if needed (for local file DB only)
if [[ "${TURSO_DATABASE_URL:-}" != http* ]] && [ ! -f data/lyra.db ]; then
  echo "  Seeding database..."
  mkdir -p data
  npx tsx src/seed.ts
fi

# Start server
exec npx tsx src/index.ts
