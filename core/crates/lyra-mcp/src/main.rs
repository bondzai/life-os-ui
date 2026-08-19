//! `lyra-mcp` — the research desk, spoken over stdio.
//!
//! Port of `wallet-portfolio/mcp_server.py`'s entry point. Launched by an MCP client (Claude
//! Desktop / Claude Code) as a child process, it speaks newline-delimited JSON-RPC on stdin and
//! stdout and never listens on a socket.
//!
//! Three things this process refuses to do, each checked before it can serve a single frame:
//!
//! 1. **Sign anything.** [`Startup::from_env`] refuses to boot with signing material in the
//!    environment, and no tool body in the crate has a signing path to begin with.
//! 2. **Listen on the network.** `MCP_TRANSPORT` may only be stdio. The Python's v1 HTTP
//!    transport bound `allowed_hosts=['*']` with no auth, which served a full net worth and live
//!    PnL to anyone who found the URL. It stays fail-closed until remote auth exists.
//! 3. **Log on stdout.** Tracing goes to **stderr**, because stdout *is* the protocol — one
//!    stray log line there is a corrupt frame and a dead session.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use lyra_chain::aggregate::AggregateConfig;
use lyra_chain::http_cache::{HttpCache, Mode};
use lyra_chain::sources::LiveSources;
use lyra_mcp::server::{Server, Startup, desk_config_from_env};
use lyra_mcp::sources::{LiveMarket, LivePortfolio, RoomConfig, SqliteAnalyses};
use lyra_mcp::tools::Desk;

/// stdio only. An empty value is the unset case and is allowed; anything else is refused by name
/// so the operator sees which setting stopped the boot.
fn assert_stdio_transport() -> Result<()> {
    let transport = std::env::var("MCP_TRANSPORT").unwrap_or_default();
    let transport = transport.trim().to_lowercase();
    if transport.is_empty() || transport == "stdio" {
        return Ok(());
    }
    anyhow::bail!(
        "MCP_TRANSPORT={transport:?} is disabled in this build. The research desk ships \
         stdio-only until remote auth is wired. Unset MCP_TRANSPORT or use stdio."
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    // stderr, always — see the module docs. `RUST_LOG` still tunes the level.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()))
        .init();

    assert_stdio_transport()?;

    // Before anything else opens a file or a socket: if this host can sign, the desk does not run
    // here at all.
    let startup = Startup::from_env().map_err(|refused| anyhow::anyhow!("{refused}"))?;

    let database = std::env::var("LYRA_DB").unwrap_or_else(|_| "data/lyra.db".into());
    let pool = lyra_db::open_and_migrate(&PathBuf::from(&database))
        .await
        .with_context(|| format!("opening {database}"))?;

    let aggregate = AggregateConfig::from_env();
    let cache = HttpCache::new(
        std::env::var("LYRA_HTTP_FIXTURES").unwrap_or_else(|_| "fixtures".into()),
        Mode::from_env(),
    );
    let sources = Arc::new(LiveSources::new(
        reqwest::Client::new(),
        cache,
        aggregate.adapter_concurrency,
    ));

    let desk = Desk::new(
        LivePortfolio::new(Arc::clone(&sources), aggregate, RoomConfig::from_env()),
        LiveMarket::new(sources),
        SqliteAnalyses::new(pool.clone()),
        desk_config_from_env(),
    );

    tracing::info!(database, "research desk ready on stdio");
    let result = Server::new(desk, startup).serve_stdio().await;

    pool.close().await;
    result.context("serving stdio")
}
