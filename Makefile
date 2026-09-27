.PHONY: help dev dev-safe dev-ui dev-api install install-ui build build-ui build-api \
       server-install server-status server-restart server-stop server-logs \
       server-setup-linux server-update-linux server-rollback-linux \
       lint typecheck typecheck-w check test clean docker-up docker-down docker-build docker-logs \
       preview core-build core-test core-check parity oracle oracle-clone mcp visual

# ──────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────
HOST        ?= 0.0.0.0
UI_PORT     ?= 5174
API_PORT    ?= 3001
COMPOSE     := docker compose

# Homebrew's rustup keg only links `rustup` into PATH; the cargo/rustc shims live in the opt
# dir. Put that whole directory on PATH — pointing at the cargo binary alone is not enough,
# since cargo shells out to rustc and would not find it.
RUST_BIN    ?= $(shell dirname "$$(command -v cargo 2>/dev/null || echo /opt/homebrew/opt/rustup/bin/cargo)")
export PATH := $(RUST_BIN):$(PATH)
CARGO       ?= cargo
ORACLE_DIR  ?= ../wallet-portfolio

# ──────────────────────────────────────────────
# Help
# ──────────────────────────────────────────────
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────
# Install
# ──────────────────────────────────────────────
install: install-ui ## Install all dependencies

install-ui: ## Install frontend dependencies
	npm ci

# ──────────────────────────────────────────────
# Development
# ──────────────────────────────────────────────
dev: ## Start both UI and API in parallel
	@$(MAKE) -j2 dev-ui dev-api

dev-safe: ## Start UI + API + live typecheck (catches TS errors in real time)
	@$(MAKE) -j3 dev-ui dev-api typecheck-w

dev-ui: ## Start frontend dev server (HTTPS)
	npx vite --host $(HOST) --port $(UI_PORT)

# The backend is the Rust binary. It reads its configuration from the environment, and
# JWT_SECRET has no default on purpose — the process exits 1 rather than sign tokens with a
# fallback secret. Source your .env before running, or pass it inline.
dev-api: ## Start the Rust API (port 3001)
	cd core && $(CARGO) run --bin lyra-api

# ──────────────────────────────────────────────
# Build
# ──────────────────────────────────────────────
build: build-ui build-api ## Build everything

build-ui: ## Build frontend for production
	npm run build

build-api: ## Build the Rust API, the migrator and the MCP desk, optimised
	cd core && $(CARGO) build --release

# ──────────────────────────────────────────────
# Quality
# ──────────────────────────────────────────────
lint: ## Run ESLint
	npm run lint

typecheck: ## Run TypeScript type checking (one-shot)
	npx tsc -b

typecheck-w: ## Run TypeScript type checking (watch mode)
	npx tsc -b --watch --preserveWatchOutput

check: typecheck lint ## Run all quality checks (same as prod)

# Needs the UI and the API running, and a browser. Not part of `check` for that reason — it is
# the "does this work when a person opens it" pass, which found a blank page with no way out and
# a setState-during-render on its first run. See docs/parity.md.
visual: ## Click through every route in a real Chrome and report what breaks
	npm i --no-save playwright-core
	node scripts/visual-sweep.mjs

# ──────────────────────────────────────────────
# Database
# ──────────────────────────────────────────────
# Schema changes are forward-only SQL in crates/lyra-db/src/migrations, applied automatically at
# API startup and tracked by PRAGMA user_version. There is nothing to generate: no ORM sits
# between the code and the schema any more.
db-migrate: ## Import a legacy database into lyra.db (incremental, safe to re-run)
	cd core && $(CARGO) run --bin lyra-migrate -- data/lyra.db

# ──────────────────────────────────────────────
# Rust core (the port target — see docs/parity.md)
# ──────────────────────────────────────────────
core-build: ## Build the Rust workspace
	cd core && $(CARGO) build

mcp: ## Build the MCP research desk (stdio; see docs/deployment.md 7.2)
	cd core && $(CARGO) build --release --bin lyra-mcp

core-test: ## Run Rust tests
	cd core && $(CARGO) test

core-fmt: ## Format the Rust workspace
	cd core && $(CARGO) fmt

core-check: ## Rust format check + clippy (warnings are errors)
	cd core && $(CARGO) fmt --check
	cd core && $(CARGO) clippy --all-targets -- -D warnings

# The oracle was deleted on 2026-08-19, once the port was complete. Both targets below need it
# back; `make oracle-clone` fetches it. See docs/parity.md → "Getting the oracle back".
oracle-clone: ## Re-clone the Python oracle next to this repo
	test -d $(ORACLE_DIR) || git clone git@github.com:bondzai/wallet-portfolio.git $(ORACLE_DIR)
	cd $(ORACLE_DIR) && python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
	@echo "Now copy the secrets it needs: cp .env.local $(ORACLE_DIR)/.env.local"

oracle: ## Run the Python oracle on :8000 (the parity source of truth; needs oracle-clone first)
	cd $(ORACLE_DIR) && .venv/bin/python server.py

parity: ## Diff the Rust port against the Python oracle (green with no endpoints configured)
	cd core && $(CARGO) run -q -p lyra-parity -- --config parity.toml

# ──────────────────────────────────────────────
# Docker
# ──────────────────────────────────────────────
server-install: ## Install Lyra as a local service (macOS/launchd; builds, then starts on login)
	./ops/lyra-server.sh install

# The mini PC deliberately has no build target: GitHub Actions builds the x86_64 tarball and
# ops/lyra-update.sh installs it. `setup` only needs .env.local. See docs/deployment.md.
server-setup-linux: ## Install Lyra as a systemd service (the mini PC; needs sudo)
	sudo ./ops/lyra-server-linux.sh setup

server-update-linux: ## Pull and install the latest release now instead of waiting for the timer
	sudo /opt/lyra/bin/lyra-update.sh

server-rollback-linux: ## Put the previous release back
	sudo ./ops/lyra-server-linux.sh rollback

server-status: ## Is the local service up?
	@./ops/lyra-server.sh status

server-restart: ## Rebuild and restart the local service
	./ops/lyra-server.sh install

server-stop: ## Stop the local service
	@./ops/lyra-server.sh stop

server-logs: ## Tail the local service log
	@./ops/lyra-server.sh logs

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
	rm -rf dist
	rm -rf node_modules
