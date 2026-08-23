//! The chain config table — port of `portfolio.py:56-158` (`CHAINS`, `NATIVE`), plus the
//! chain-kind registry (`CHAIN_KINDS`/`_kind`, ~line 2131) and `_order_chains` (~line 2358).
//!
//! Single source of truth, exactly as in Python: adding a chain is one entry here, not a new
//! field scattered across five modules. The fields are deliberately `Option`, mirroring the
//! Python dict's `.get()` shape — a chain without `blockscout` has no token indexer and is
//! native-coin-only, and a chain without `native` (Hyperliquid's order book) has no coin at all.
//! Filling those holes in with plausible-looking defaults would invent behaviour the Python
//! original never had, so they stay empty and the callers branch on them.

use crate::address::{AddressKind, kind_of};

/// The zero address, used chain-side as the placeholder "this is the native coin, not an ERC-20"
/// token id. Kept as a constant because comparisons against it decide native-vs-token handling.
pub const NATIVE: &str = "0x0000000000000000000000000000000000000000";

/// How a chain is read, and therefore which address shape may be paired with it.
///
/// This is `CHAIN_KINDS` minus the reader function pointers: the readers live with the fetching
/// code, but the *pairing* half has to live next to the table so a wallet is never fanned out to
/// a chain whose address format it cannot possibly have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChainKind {
    /// Default kind in Python (`CHAINS[chain].get("kind", "evm")`).
    Evm,
    Btc,
    /// Hyperliquid's L1 order book: not EVM, but keyed by the same `0x…` address.
    Hypercore,
    Solana,
}

impl ChainKind {
    /// The address shape this kind accepts.
    ///
    /// `Hypercore` maps to `Evm` — that asymmetry is the whole reason this is a separate
    /// function rather than a field: Hyperliquid is read over a completely different API, yet
    /// it is addressed by an ordinary `0x…` key, so an EVM wallet must still reach it.
    pub fn address_kind(self) -> AddressKind {
        match self {
            ChainKind::Evm | ChainKind::Hypercore => AddressKind::Evm,
            ChainKind::Btc => AddressKind::Bitcoin,
            ChainKind::Solana => AddressKind::Solana,
        }
    }

    /// The Python `kind` string, for parity tests and error messages.
    pub fn as_str(self) -> &'static str {
        match self {
            ChainKind::Evm => "evm",
            ChainKind::Btc => "btc",
            ChainKind::Hypercore => "hypercore",
            ChainKind::Solana => "solana",
        }
    }
}

/// A token to read over RPC when the chain's indexer cannot list holdings.
///
/// Enumerating what an address holds is exactly what a Blockscout instance is for, and an RPC
/// cannot do it — `balanceOf` answers about a token you already name. So this is a floor, not a
/// replacement: the tokens worth naming are the ones a wallet on this chain is actually likely to
/// hold, and anything else stays invisible while the indexer is down.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FallbackToken {
    pub symbol: &'static str,
    /// The ERC-20 contract.
    pub address: &'static str,
    pub decimals: u32,
    /// DefiLlama key, so it prices through the same path as everything else.
    pub price_key: &'static str,
}

/// The chain's own coin: what a bare balance is denominated in, and how to price it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Native {
    pub symbol: &'static str,
    /// DefiLlama price key, e.g. `coingecko:ethereum`.
    pub price_key: &'static str,
}

/// A Uniswap v3-style deployment: the position-manager NFT contract plus its pool factory.
/// Also used for v3 forks (Aerodrome Slipstream) since they share the ABI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniV3 {
    /// NonfungiblePositionManager.
    pub npm: &'static str,
    pub factory: &'static str,
}

/// Uniswap v4: liquidity is a singleton PoolManager, so positions are read through a
/// separate read-only StateView contract rather than from the pool itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniV4 {
    /// PoolManager.
    pub pm: &'static str,
    pub stateview: &'static str,
}

/// A v3-fork DEX that needs its own display label because it is not Uniswap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForkedCl {
    pub npm: &'static str,
    pub factory: &'static str,
    pub label: &'static str,
}

/// One chain's complete configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Chain {
    /// Key in the Python dict — the identifier used in API responses and cache keys.
    pub name: &'static str,
    pub kind: ChainKind,
    /// Blockscout instance base URL. `None` means no public indexer, so this chain reports the
    /// native coin only (RPC balance + price) and no ERC-20s.
    pub blockscout: Option<&'static str>,
    pub rpc: Option<&'static str>,
    /// DefiLlama chain key for price lookups.
    pub llama: Option<&'static str>,
    pub aave_pool: Option<&'static str>,
    pub native: Option<Native>,
    pub univ3: Option<UniV3>,
    pub univ4: Option<UniV4>,
    /// A non-Uniswap concentrated-liquidity fork on this chain (Base: Aerodrome Slipstream).
    pub aero_cl: Option<ForkedCl>,
    /// Numeric EVM chain id. Only populated where something actually keys off it — the vfat
    /// API indexes positions by chain id — so it is absent for most chains in Python and stays
    /// absent here rather than being helpfully filled in.
    pub chain_id: Option<u64>,
    /// LP positions come from the keyless vfat farm-balances API (by `chain_id`).
    pub vfat_api: bool,
    /// Fallback for when the vfat API is down: read the Sickle proxy's LP NFTs over RPC.
    pub sickle_rpc: bool,
    /// Read over RPC when the indexer returns nothing. Empty for chains whose Blockscout works.
    pub spot_fallback: &'static [FallbackToken],
    /// Chain-local SickleFactory (the global one is not deployed on HyperEVM).
    pub sickle_factory: Option<&'static str>,
}

impl Chain {
    /// Address shape that can hold funds on this chain.
    pub fn address_kind(&self) -> AddressKind {
        self.kind.address_kind()
    }

    /// Whether this wallet address could exist on this chain at all.
    pub fn accepts(&self, address: &str) -> bool {
        kind_of(address) == Some(self.address_kind())
    }
}

/// Base template so each entry below lists only what it actually sets, the way the Python dict
/// does. Without it every chain would carry ten `None`s and a real missing field would hide in
/// the noise.
const DEFAULT: Chain = Chain {
    spot_fallback: &[],
    name: "",
    kind: ChainKind::Evm,
    blockscout: None,
    rpc: None,
    llama: None,
    aave_pool: None,
    native: None,
    univ3: None,
    univ4: None,
    aero_cl: None,
    chain_id: None,
    vfat_api: false,
    sickle_rpc: false,
    sickle_factory: None,
};

/// Every supported chain, **in Python's dict-insertion order** — `_order_chains` sorts results
/// by position in this table, so reordering it silently reorders the UI.
pub static CHAINS: &[Chain] = &[
    Chain {
        name: "ethereum",
        blockscout: Some("https://eth.blockscout.com"),
        rpc: Some("https://ethereum-rpc.publicnode.com"),
        llama: Some("ethereum"),
        aave_pool: Some("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2"),
        native: Some(Native {
            symbol: "ETH",
            price_key: "coingecko:ethereum",
        }),
        univ3: Some(UniV3 {
            npm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        }),
        univ4: Some(UniV4 {
            pm: "0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e",
            stateview: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
        }),
        ..DEFAULT
    },
    Chain {
        name: "base",
        blockscout: Some("https://base.blockscout.com"),
        rpc: Some("https://base-rpc.publicnode.com"),
        llama: Some("base"),
        aave_pool: Some("0xA238Dd80C259a72e81d7e4664a9801593F98d1c5"),
        native: Some(Native {
            symbol: "ETH",
            price_key: "coingecko:ethereum",
        }),
        univ3: Some(UniV3 {
            npm: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
            factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        }),
        univ4: Some(UniV4 {
            pm: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
            stateview: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
        }),
        // Aerodrome Slipstream — Base's dominant DEX, a v3 fork.
        aero_cl: Some(ForkedCl {
            npm: "0x827922686190790b37229fd06084350E74485b72",
            factory: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
            label: "Aerodrome",
        }),
        ..DEFAULT
    },
    Chain {
        name: "arbitrum",
        blockscout: Some("https://arbitrum.blockscout.com"),
        rpc: Some("https://arbitrum-one-rpc.publicnode.com"),
        llama: Some("arbitrum"),
        aave_pool: Some("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
        native: Some(Native {
            symbol: "ETH",
            price_key: "coingecko:ethereum",
        }),
        univ3: Some(UniV3 {
            npm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        }),
        univ4: Some(UniV4 {
            pm: "0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869",
            stateview: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990",
        }),
        ..DEFAULT
    },
    Chain {
        name: "optimism",
        blockscout: Some("https://optimism.blockscout.com"),
        rpc: Some("https://optimism-rpc.publicnode.com"),
        llama: Some("optimism"),
        aave_pool: Some("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
        native: Some(Native {
            symbol: "ETH",
            price_key: "coingecko:ethereum",
        }),
        univ3: Some(UniV3 {
            npm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        }),
        univ4: Some(UniV4 {
            pm: "0x3C3Ea4B57a46241e54610e5f022E5c45859A1017",
            stateview: "0xc18a3169788f4f75a170290584eca6395c75ecdb",
        }),
        ..DEFAULT
    },
    Chain {
        name: "polygon",
        blockscout: Some("https://polygon.blockscout.com"),
        rpc: Some("https://polygon-bor-rpc.publicnode.com"),
        llama: Some("polygon"),
        aave_pool: Some("0x794a61358D6845594F94dc1DB02A252b5b4814aD"),
        // POL priced under its pre-rename CoinGecko id — `matic-network` is not a typo.
        native: Some(Native {
            symbol: "POL",
            price_key: "coingecko:matic-network",
        }),
        univ3: Some(UniV3 {
            npm: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
            factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        }),
        univ4: Some(UniV4 {
            pm: "0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9",
            stateview: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a",
        }),
        ..DEFAULT
    },
    // --- EVM without a public Blockscout -> native coin only (RPC balance + price) ---
    // BNB Chain has no Blockscout, so spot is native BNB only. Its vfat LP positions
    // (PancakeSwap v3 parked in Sickle proxies) are still indexed by chain id, hence the flag.
    Chain {
        name: "bnb",
        rpc: Some("https://bsc-rpc.publicnode.com"),
        native: Some(Native {
            symbol: "BNB",
            price_key: "coingecko:binancecoin",
        }),
        chain_id: Some(56),
        vfat_api: true,
        ..DEFAULT
    },
    Chain {
        name: "avalanche",
        rpc: Some("https://avalanche-c-chain-rpc.publicnode.com"),
        native: Some(Native {
            symbol: "AVAX",
            price_key: "coingecko:avalanche-2",
        }),
        ..DEFAULT
    },
    // HyperEVM: has Blockscout (hyperscan) -> full spot. Deliberately no v3/v4 config — its
    // DEXes live behind vfat Sickle proxies that hyperscan does not index, so LP positions come
    // from the vfat API (chain id 999), with a direct-RPC Sickle read as the fallback.
    Chain {
        // hyperscan.com — the Blockscout instance the Python named too — 404s on
        // `/addresses/{a}` and `/addresses/{a}/tokens`, so nothing on this chain has a listable
        // spot balance any more. These two are read over RPC instead.
        spot_fallback: &[
            FallbackToken {
                symbol: "WHYPE",
                address: "0x5555555555555555555555555555555555555555",
                decimals: 18,
                price_key: "coingecko:hyperliquid",
            },
            FallbackToken {
                symbol: "UBTC",
                address: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463",
                decimals: 8,
                price_key: "coingecko:bitcoin",
            },
        ],
        name: "hyperevm",
        blockscout: Some("https://www.hyperscan.com"),
        rpc: Some("https://rpc.hyperliquid.xyz/evm"),
        llama: Some("hyperliquid"),
        native: Some(Native {
            symbol: "HYPE",
            price_key: "coingecko:hyperliquid",
        }),
        chain_id: Some(999),
        vfat_api: true,
        sickle_rpc: true,
        sickle_factory: Some("0x233d9067677dcf1a161954d45b4c965b9d567168"),
        ..DEFAULT
    },
    // Hyperliquid L1 (order book, not EVM) -> info API, keyed by the 0x address. No native
    // entry: balances come back already denominated, so there is no single coin to price.
    Chain {
        name: "hyperliquid",
        kind: ChainKind::Hypercore,
        ..DEFAULT
    },
    // Bitcoin -> balance from mempool.space, price from DefiLlama. No `rpc`: the reader uses a
    // REST API, not JSON-RPC.
    Chain {
        name: "bitcoin",
        kind: ChainKind::Btc,
        native: Some(Native {
            symbol: "BTC",
            price_key: "coingecko:bitcoin",
        }),
        ..DEFAULT
    },
    // Solana -> JSON-RPC balances (SOL + SPL/Token-2022). Its endpoint is chosen by the reader
    // rather than configured here, matching Python.
    Chain {
        name: "solana",
        kind: ChainKind::Solana,
        llama: Some("solana"),
        native: Some(Native {
            symbol: "SOL",
            price_key: "coingecko:solana",
        }),
        ..DEFAULT
    },
];

/// All chains, in table order.
pub fn all() -> &'static [Chain] {
    CHAINS
}

/// Look up a chain by its name.
pub fn by_name(name: &str) -> Option<&'static Chain> {
    CHAINS.iter().find(|c| c.name == name)
}

/// Position of a chain in the table, i.e. its sort key. `None` for an unknown name.
pub fn order_index(name: &str) -> Option<usize> {
    CHAINS.iter().position(|c| c.name == name)
}

/// The chains a wallet address can possibly hold funds on.
///
/// This is the guard rail from `build_portfolios`: results are fanned out per
/// (wallet × chain), and pairing every wallet with every chain would mean asking Bitcoin about
/// an `0x…` address — a guaranteed error per request, and a slower response for a result that
/// could never exist. An unrecognised address pairs with nothing.
pub fn chains_for_address(address: &str) -> Vec<&'static Chain> {
    let Some(kind) = kind_of(address) else {
        return Vec::new();
    };
    CHAINS.iter().filter(|c| c.address_kind() == kind).collect()
}

/// Sort per-chain results back into table order — port of `_order_chains`.
///
/// Worth stating why it exists: the fan-out is concurrent, so results arrive in whatever order
/// the network happened to return them. Without this the UI would reshuffle its chain list on
/// every refresh. Unknown chains sort last instead of panicking (Python's `list.index` would
/// raise), keeping a stray result visible rather than taking the whole response down. The sort
/// is stable, so ties keep completion order, exactly like Python's `sorted`.
pub fn order_chains<T, F>(items: &mut [T], chain_of: F)
where
    F: Fn(&T) -> &str,
{
    items.sort_by_key(|item| order_index(chain_of(item)).unwrap_or(usize::MAX));
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVM: &str = "0x1234567890abcdef1234567890ABCDEF12345678";
    const BTC: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const BTC_LEGACY: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const SOL: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    fn names(chains: Vec<&'static Chain>) -> Vec<&'static str> {
        chains.into_iter().map(|c| c.name).collect()
    }

    #[test]
    fn chain_names_are_unique() {
        // A duplicate would make `by_name` shadow one entry and double-count the other.
        let mut seen: Vec<&str> = CHAINS.iter().map(|c| c.name).collect();
        let total = seen.len();
        seen.sort_unstable();
        seen.dedup();
        assert_eq!(seen.len(), total, "duplicate chain name in the table");
    }

    #[test]
    fn lookup_by_name_matches_the_table() {
        assert_eq!(by_name("ethereum").unwrap().native.unwrap().symbol, "ETH");
        assert_eq!(by_name("hyperevm").unwrap().chain_id, Some(999));
        assert!(by_name("Ethereum").is_none(), "lookup is case-sensitive");
        assert!(by_name("dogecoin").is_none());
    }

    #[test]
    fn an_evm_address_pairs_only_with_evm_kind_chains() {
        let paired = names(chains_for_address(EVM));
        assert_eq!(
            paired,
            vec![
                "ethereum",
                "base",
                "arbitrum",
                "optimism",
                "polygon",
                "bnb",
                "avalanche",
                "hyperevm",
                "hyperliquid",
            ]
        );
        assert!(!paired.contains(&"bitcoin"), "0x… must never reach Bitcoin");
        assert!(!paired.contains(&"solana"));
    }

    #[test]
    fn hyperliquid_is_paired_despite_not_being_evm() {
        // Its kind is `hypercore`, but it is keyed by an 0x address — dropping it here would
        // silently lose every order-book balance.
        assert!(names(chains_for_address(EVM)).contains(&"hyperliquid"));
    }

    #[test]
    fn a_bitcoin_address_pairs_only_with_bitcoin() {
        assert_eq!(names(chains_for_address(BTC)), vec!["bitcoin"]);
        assert_eq!(names(chains_for_address(BTC_LEGACY)), vec!["bitcoin"]);
    }

    #[test]
    fn a_solana_address_pairs_only_with_solana() {
        assert_eq!(names(chains_for_address(SOL)), vec!["solana"]);
    }

    #[test]
    fn an_invalid_address_pairs_with_nothing() {
        assert!(chains_for_address("not-an-address").is_empty());
        assert!(chains_for_address("").is_empty());
    }

    #[test]
    fn every_chain_accepts_exactly_one_address_shape() {
        for chain in CHAINS {
            let accepted = [EVM, BTC, SOL].iter().filter(|a| chain.accepts(a)).count();
            assert_eq!(accepted, 1, "{} accepts {accepted} shapes", chain.name);
        }
    }

    #[test]
    fn results_are_sorted_back_into_table_order() {
        // As if the concurrent fan-out returned solana first and ethereum last.
        let mut got = vec!["solana", "polygon", "bitcoin", "ethereum"];
        order_chains(&mut got, |c| c);
        assert_eq!(got, vec!["ethereum", "polygon", "bitcoin", "solana"]);
    }

    #[test]
    fn an_unknown_chain_sorts_last_rather_than_panicking() {
        let mut got = vec!["mystery", "base", "ethereum"];
        order_chains(&mut got, |c| c);
        assert_eq!(got, vec!["ethereum", "base", "mystery"]);
    }

    #[test]
    fn ordering_is_stable_for_unknown_chains() {
        let mut got = vec!["zzz", "aaa", "ethereum"];
        order_chains(&mut got, |c| c);
        assert_eq!(got, vec!["ethereum", "zzz", "aaa"]);
    }

    #[test]
    fn kinds_map_to_the_address_shape_python_uses() {
        assert_eq!(ChainKind::Evm.address_kind(), AddressKind::Evm);
        assert_eq!(ChainKind::Hypercore.address_kind(), AddressKind::Evm);
        assert_eq!(ChainKind::Btc.address_kind(), AddressKind::Bitcoin);
        assert_eq!(ChainKind::Solana.address_kind(), AddressKind::Solana);
    }

    #[test]
    fn chains_without_a_blockscout_are_native_only() {
        // These read a bare RPC balance; if one ever gained an indexer this test should be
        // updated deliberately, not discovered through missing tokens.
        let native_only: Vec<&str> = CHAINS
            .iter()
            .filter(|c| c.kind == ChainKind::Evm && c.blockscout.is_none())
            .map(|c| c.name)
            .collect();
        assert_eq!(native_only, vec!["bnb", "avalanche"]);
        for name in native_only {
            assert!(by_name(name).unwrap().rpc.is_some(), "{name} needs an RPC");
        }
    }

    #[test]
    fn vfat_indexed_chains_carry_the_chain_id_it_is_keyed_by() {
        // The vfat API takes a numeric chain id; a chain flagged for it without an id would
        // fetch nothing and quietly report zero LP value.
        for chain in CHAINS.iter().filter(|c| c.vfat_api) {
            assert!(
                chain.chain_id.is_some(),
                "{} uses the vfat API but has no chain_id",
                chain.name
            );
        }
    }

    #[test]
    fn sickle_rpc_fallback_needs_a_factory() {
        for chain in CHAINS.iter().filter(|c| c.sickle_rpc) {
            assert!(
                chain.sickle_factory.is_some(),
                "{} has no SickleFactory to resolve the proxy with",
                chain.name
            );
        }
    }
}
