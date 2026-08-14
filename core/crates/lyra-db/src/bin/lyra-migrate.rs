//! `lyra-migrate` — create `lyra.db` and import the two legacy databases into it.
//!
//! Run once when moving to the Rust backend:
//!
//! ```text
//! lyra-migrate data/lyra.db \
//!     --from-lyra ../api/data/life-os.db \
//!     --from-pow  /path/to/pow.db
//! ```
//!
//! Safe to re-run: the schema migration is versioned and the import is `INSERT OR IGNORE`.
//!
//! **Copy the legacy files first, together with their `-wal`/`-shm` sidecars.** A hot WAL holds
//! rows that are not in the main `.db` file yet, so copying the `.db` alone loses recent data —
//! and reading one may make SQLite recover the WAL, which writes to the source.

use anyhow::{Context, Result};
use clap::Parser;
use lyra_db::import::{self, LYRA_TABLES, POW_TABLES};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(name = "lyra-migrate", about = "Create lyra.db and import legacy data")]
struct Args {
    /// Destination database; created if missing.
    database: PathBuf,

    /// Lyra's Drizzle database (`api/data/life-os.db`).
    #[arg(long)]
    from_lyra: Option<PathBuf>,

    /// wallet-portfolio's `pow.db`.
    #[arg(long)]
    from_pow: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    let pool = lyra_db::open_and_migrate(&args.database)
        .await
        .with_context(|| format!("preparing {}", args.database.display()))?;
    println!("schema ready: {}", args.database.display());

    if let Some(source) = &args.from_lyra {
        println!("\nimporting Lyra data from {}", source.display());
        let report = import::import_from(&pool, source, LYRA_TABLES).await?;
        println!("{}", report.summary());
        println!("  → {} rows", report.total_rows());
    }

    if let Some(source) = &args.from_pow {
        println!("\nimporting wealth data from {}", source.display());
        let report = import::import_from(&pool, source, POW_TABLES).await?;
        println!("{}", report.summary());
        println!("  → {} rows", report.total_rows());
    }

    if args.from_lyra.is_none() && args.from_pow.is_none() {
        println!("\nno --from-lyra / --from-pow given; schema only.");
    }

    pool.close().await;
    Ok(())
}
