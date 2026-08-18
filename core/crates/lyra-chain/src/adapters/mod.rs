//! DeFi position adapters — the port of the `ADAPTERS` registry at `portfolio.py:1849`.
//!
//! Each adapter reads one protocol's positions for a wallet and returns them through the shared
//! position schema in [`crate::model`]. They are registered in the same order as the Python, since
//! that order decides which adapter claims a position when two could.
pub mod aave;
pub mod aero_cl;
pub mod avalon;
pub mod compound;
pub mod erc4626;
pub mod morpho;
pub mod sickle_rpc;
pub mod univ3;
pub mod univ4;
pub mod vfat;
