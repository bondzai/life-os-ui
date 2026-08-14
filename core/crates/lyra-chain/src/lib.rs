//! `lyra-chain` — keyless multi-chain portfolio reading.
//!
//! The Rust port of `wallet-portfolio/portfolio.py` (2,486 LOC): chain config, Blockscout spot
//! balances, DefiLlama prices, the spam filter, Uniswap v3/v4 tick math, and the DeFi adapter
//! registry. Every endpoint here is gated by `lyra-parity` against the Python original before
//! it is considered ported.

pub mod abi;
pub mod address;
pub mod bitcoin;
pub mod chains;
pub mod evm;
pub mod http_cache;
pub mod hyperliquid;
pub mod kucoin;
pub mod lp_math;
pub mod market;
pub mod model;
pub mod prices;
pub mod solana;
pub mod spam;
pub mod spot;
