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

# ── Why the layer order below ──
# Cargo has no notion of "dependencies only": it rebuilds from the oldest changed input, and
# every file in the context is an input. Copying the whole workspace first would mean a
# one-line change in a handler recompiles aws-lc, SQLite, axum and ~400 other crates — several
# minutes each time, on a mini PC more like ten.
#
# So the manifests come first, alone, with a fake entry point per crate. That layer's only
# inputs are Cargo.toml/Cargo.lock, so Docker reuses it for every commit that doesn't touch
# dependencies, and the expensive third-party compile happens once. Real sources are copied
# afterwards, and the final build recompiles only the seven workspace crates.
#
# rust-toolchain.toml is deliberately NOT copied. It asks for `channel = "stable"` plus rustfmt
# and clippy — but the rust image installs its toolchain under a version name, not under the
# name "stable", so the file makes rustup download a whole second toolchain (~500 MB) on the
# first build, for the same compiler. The image tag pins the toolchain instead: `rust:1` tracks
# latest stable, which is what the file asks for, and the two dev components are of no use in a
# deploy build. If you ever need an exact pin, change the tag (e.g. rust:1.97-bookworm) rather
# than adding the file back.
COPY Cargo.toml Cargo.lock ./
COPY crates/lyra-alerts/Cargo.toml    crates/lyra-alerts/Cargo.toml
COPY crates/lyra-analytics/Cargo.toml crates/lyra-analytics/Cargo.toml
COPY crates/lyra-api/Cargo.toml       crates/lyra-api/Cargo.toml
COPY crates/lyra-chain/Cargo.toml     crates/lyra-chain/Cargo.toml
COPY crates/lyra-db/Cargo.toml        crates/lyra-db/Cargo.toml
COPY crates/lyra-mcp/Cargo.toml       crates/lyra-mcp/Cargo.toml
COPY crates/lyra-parity/Cargo.toml    crates/lyra-parity/Cargo.toml

# `members = ["crates/*"]` means cargo insists every member parses, so each one gets a stub
# matching the target its manifest implies (lib, bin, or both).
RUN mkdir -p crates/lyra-alerts/src crates/lyra-analytics/src crates/lyra-api/src \
             crates/lyra-chain/src crates/lyra-db/src/bin crates/lyra-mcp/src \
             crates/lyra-parity/src \
    && touch crates/lyra-alerts/src/lib.rs \
             crates/lyra-analytics/src/lib.rs \
             crates/lyra-chain/src/lib.rs \
             crates/lyra-db/src/lib.rs \
             crates/lyra-mcp/src/lib.rs \
    && echo 'fn main() {}' > crates/lyra-api/src/main.rs \
    && echo 'fn main() {}' > crates/lyra-parity/src/main.rs \
    && echo 'fn main() {}' > crates/lyra-db/src/bin/lyra-migrate.rs

# Dependencies only. Same profile as the real build so the artefacts are reusable —
# a debug prebuild here would be wasted work.
RUN cargo build --release --bin lyra-api --bin lyra-migrate

# Now the real code. Everything above this line stays cached across ordinary commits.
COPY crates crates

# COPY gives the sources fresh mtimes, which is what makes cargo rebuild them — except for the
# stub files it just overwrote, where the fingerprint can still look current. Removing the
# workspace crates' own artefacts is cheap (they are seconds of compile time) and removes the
# guesswork; the dependency artefacts in target/release/deps are untouched.
RUN find target/release -maxdepth 1 -name '*lyra*' -delete \
    && rm -rf target/release/.fingerprint/lyra-* \
    && cargo build --release --bin lyra-api --bin lyra-migrate

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

COPY --from=builder /build/target/release/lyra-api     /usr/local/bin/lyra-api
COPY --from=builder /build/target/release/lyra-migrate /usr/local/bin/lyra-migrate

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

# Compose owns the healthcheck (see docker-compose.rust.yml); this is the fallback for
# `docker run` without compose.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["lyra-api"]
