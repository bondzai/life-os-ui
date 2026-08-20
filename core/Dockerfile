# syntax=docker/dockerfile:1
#
# Build context is `core/` (the Rust workspace):
#   docker build -f core/Dockerfile core
#
# Produces one image containing two binaries:
#   /usr/local/bin/lyra-api      — the server (default CMD)
#   /usr/local/bin/lyra-migrate  — one-shot schema + legacy import, see docs/deployment-rust.md

# ─────────────────────────── builder ───────────────────────────
FROM rust:1-bookworm AS builder

# Two dependencies compile C, and the rust image ships a C compiler but no CMake:
#   - aws-lc-sys — rustls' default crypto provider, pulled in through reqwest (the Google
#     Calendar client). Its build script drives CMake.
#   - libsqlite3-sys — sqlx's bundled SQLite, built with plain cc.
# Nothing here uses OpenSSL, so no libssl-dev is needed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# ── Why cache mounts instead of a dependency layer ──
# This used to copy the manifests alone with a stub `main.rs` per crate, build that to compile
# the ~400 third-party crates, then copy the real sources. It worked, but the compiled
# dependencies landed in an *image layer* — about 900 MB of `target/release/deps` carried in the
# builder stage — and the layer was invalidated by any change to Cargo.lock.
#
# BuildKit cache mounts do the same job directly: `target/` and the cargo registry persist
# across builds without ever becoming layers, and cargo's own fingerprinting decides what to
# recompile. A source-only change rebuilds the seven workspace crates and nothing else, same as
# before, and the builder stage now carries no dependency artefacts at all.
#
# The trade-off, stated plainly: this cache is local to the machine and `docker builder prune`
# clears it, after which the next build is a full recompile. That is the right trade for a
# single mini PC building its own images; it would be the wrong one if these were built in CI
# and pushed to a registry, where a shared layer earns its size.
COPY Cargo.toml Cargo.lock ./
COPY crates crates

# `sharing=locked` because two concurrent builds writing one `target/` corrupt each other —
# compose builds `api` and `migrate` from this same Dockerfile.
#
# The binaries are copied to /out inside the same RUN: a cache mount is not part of the layer,
# so anything left in `target/` is gone the moment this step ends.
RUN --mount=type=cache,target=/build/target,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,target=/usr/local/cargo/git,sharing=locked \
    cargo build --release --bin lyra-api --bin lyra-migrate \
    && mkdir -p /out \
    && cp target/release/lyra-api target/release/lyra-migrate /out/

# ─────────────────────────── runtime ───────────────────────────
# Not distroless, on purpose: the knowledge module shells out to `git` (add/commit/log in
# crates/lyra-api/src/knowledge.rs), so the runtime needs a real git binary. debian-slim with
# three packages is the smallest base that keeps that feature working.
FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        tzdata \
        curl \
    && rm -rf /var/lib/apt/lists/*
# ca-certificates — reqwest/rustls verifying accounts.google.com and *.googleapis.com.
# git           — the knowledge module's version history.
# tzdata        — chrono's local-time formatting.
# curl          — the container healthcheck only; drop it if you healthcheck externally.

# Unprivileged, fixed uid so the data volume's ownership is predictable across rebuilds.
RUN useradd --system --uid 10001 --user-group --home-dir /app --shell /usr/sbin/nologin lyra \
    && mkdir -p /app /data \
    && chown -R lyra:lyra /app /data

COPY --from=builder /out/lyra-api     /usr/local/bin/lyra-api
COPY --from=builder /out/lyra-migrate /usr/local/bin/lyra-migrate

# The knowledge repo is bind-mounted from the host and therefore owned by a different uid than
# the one inside the container; without this git refuses to touch it ("dubious ownership") and
# every knowledge write silently fails to commit. Set via env so no config file is needed.
ENV GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=safe.directory \
    GIT_CONFIG_VALUE_0=*

# Defaults only — every one of these is overridable from compose. JWT_SECRET is deliberately
# absent: the binary exits 1 when it is unset, which is the behaviour we want.
ENV LYRA_DB=/data/lyra.db \
    PORT=3001 \
    RUST_LOG=info

USER lyra
WORKDIR /app
EXPOSE 3001

# Compose owns the healthcheck (see docker-compose.yml); this is the fallback for
# `docker run` without compose.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["lyra-api"]
