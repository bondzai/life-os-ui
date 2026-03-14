.PHONY: help dev dev-ui dev-api install install-ui install-api build build-ui build-api \
       lint typecheck test seed clean docker-up docker-down docker-build docker-logs \
       preview

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
HOST        ?= 0.0.0.0
UI_PORT     ?= 5174
API_PORT    ?= 3001
COMPOSE     := docker compose

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────
# Install
# ──────────────────────────────────────────────
install: install-ui install-api ## Install all dependencies

install-ui: ## Install frontend dependencies
	npm ci

install-api: ## Install API dependencies
	cd api && npm ci

# ──────────────────────────────────────────────
# Development
# ──────────────────────────────────────────────
dev: ## Start both UI and API in parallel
	@$(MAKE) -j2 dev-ui dev-api

dev-ui: ## Start frontend dev server (HTTPS)
	npx vite --host $(HOST) --port $(UI_PORT)

dev-api: ## Start API dev server
	cd api && npm run dev

# ──────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────
build: build-ui build-api ## Build everything

build-ui: ## Build frontend for production
	npm run build

build-api: ## Build API
	cd api && npm run build

# ──────────────────────────────────────────────
# Quality
# ──────────────────────────────────────────────
lint: ## Run ESLint
	npm run lint

typecheck: ## Run TypeScript type checking
	npx tsc -b --noEmit

# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
seed: ## Seed the database with sample data
	cd api && npm run seed

db-generate: ## Generate Drizzle migrations
	cd api && npm run db:generate

db-migrate: ## Run Drizzle migrations
	cd api && npm run db:migrate

# ──────────────────────────────────────────────
# Docker
# ──────────────────────────────────────────────
docker-up: ## Start all containers
	$(COMPOSE) up -d

docker-down: ## Stop all containers
	$(COMPOSE) down

docker-build: ## Build Docker images
	$(COMPOSE) build

docker-logs: ## Tail container logs
	$(COMPOSE) logs -f

docker-restart: ## Rebuild and restart containers
	$(COMPOSE) down
	$(COMPOSE) up -d --build

# ──────────────────────────────────────────────
# Misc
# ──────────────────────────────────────────────
preview: ## Preview production build locally
	npm run preview -- --host $(HOST) --port $(UI_PORT)

clean: ## Remove build artifacts and node_modules
	rm -rf dist api/dist
	rm -rf node_modules api/node_modules
