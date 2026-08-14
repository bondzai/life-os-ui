//! Differential parity for the chain config table, against the Python oracle.
//!
//! `chains_corpus.json` is dumped straight out of the live `portfolio.CHAINS` dict by
//! `dump_chains_corpus.py` (in this directory) — nothing is hand-transcribed, so a chain added,
//! renamed, re-ordered or re-pointed in Python fails here instead of drifting silently.
//! Regenerate with:
//!
//! ```text
//! cd ~/Desktop/code/home-ai-assistant/wallet-portfolio
//! .venv/bin/python ../lyra/core/crates/lyra-chain/tests/dump_chains_corpus.py
//! ```
//!
//! Every field is compared exactly, on purpose. A wrong chain id sends requests to the wrong
//! network, a wrong RPC host reads someone else's state, and a dropped chain removes real money
//! from the total — all of which look like a working portfolio that is simply short. There is no
//! field here where "close enough" is a safe outcome, so the assertions are equality, not shape.

use std::collections::BTreeMap;

use serde::Deserialize;

use lyra_chain::address::AddressKind;
use lyra_chain::chains::{self, CHAINS, NATIVE};

#[derive(Debug, Deserialize)]
struct Corpus {
    native_placeholder: String,
    count: usize,
    order: Vec<String>,
    chains: Vec<PyChain>,
    pairings: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct PyChain {
    name: String,
    kind: String,
    address_kind: String,
    blockscout: Option<String>,
    rpc: Option<String>,
    llama: Option<String>,
    aave_pool: Option<String>,
    native_symbol: Option<String>,
    native_price_key: Option<String>,
    chain_id: Option<u64>,
    vfat_api: bool,
    sickle_rpc: bool,
    sickle_factory: Option<String>,
    univ3: Option<PyUniV3>,
    univ4: Option<PyUniV4>,
    aero_cl: Option<PyForkedCl>,
}

#[derive(Debug, Deserialize)]
struct PyUniV3 {
    npm: String,
    factory: String,
}

#[derive(Debug, Deserialize)]
struct PyUniV4 {
    pm: String,
    stateview: String,
}

#[derive(Debug, Deserialize)]
struct PyForkedCl {
    npm: String,
    factory: String,
    label: String,
}

fn load() -> Corpus {
    let raw = include_str!("chains_corpus.json");
    serde_json::from_str(raw).expect("chains_corpus.json should parse")
}

/// Compares `Option<&'static str>` against the corpus' `Option<String>` without allocating.
fn same(ours: Option<&'static str>, theirs: &Option<String>) -> bool {
    ours == theirs.as_deref()
}

#[test]
fn the_chain_count_matches_python() {
    // Asserted on its own so a dropped chain fails loudly with a readable message, rather than
    // as a confusing per-field mismatch halfway down the table.
    let corpus = load();
    assert_eq!(
        CHAINS.len(),
        corpus.count,
        "rust has {} chains, python has {} — missing: {:?}",
        CHAINS.len(),
        corpus.count,
        corpus
            .order
            .iter()
            .filter(|n| chains::by_name(n).is_none())
            .collect::<Vec<_>>()
    );
}

#[test]
fn the_chain_set_and_ordering_match_python() {
    // Ordering is load-bearing: `order_chains` sorts every response by table position.
    let corpus = load();
    let ours: Vec<&str> = CHAINS.iter().map(|c| c.name).collect();
    let theirs: Vec<&str> = corpus.order.iter().map(|s| s.as_str()).collect();
    assert_eq!(ours, theirs);
}

#[test]
fn the_native_placeholder_matches_python() {
    assert_eq!(NATIVE, load().native_placeholder);
}

#[test]
fn every_chain_matches_python_field_for_field() {
    let corpus = load();
    let mut disagreements: Vec<String> = Vec::new();

    for (index, py) in corpus.chains.iter().enumerate() {
        let Some(ours) = chains::by_name(&py.name) else {
            disagreements.push(format!("{}: missing from the rust table", py.name));
            continue;
        };
        let mut diff = |field: &str, python: String, rust: String| {
            if python != rust {
                disagreements.push(format!("{}.{field}: python={python} rust={rust}", py.name));
            }
        };

        if chains::order_index(&py.name) != Some(index) {
            diff(
                "position",
                index.to_string(),
                format!("{:?}", chains::order_index(&py.name)),
            );
        }
        if ours.kind.as_str() != py.kind {
            diff("kind", py.kind.clone(), ours.kind.as_str().to_string());
        }

        let expected_kind = match py.address_kind.as_str() {
            "evm" => AddressKind::Evm,
            "bitcoin" => AddressKind::Bitcoin,
            "solana" => AddressKind::Solana,
            other => panic!("unknown address kind {other:?} in corpus"),
        };
        if ours.address_kind() != expected_kind {
            diff(
                "address_kind",
                py.address_kind.clone(),
                format!("{:?}", ours.address_kind()),
            );
        }

        for (field, rust, python) in [
            ("blockscout", ours.blockscout, &py.blockscout),
            ("rpc", ours.rpc, &py.rpc),
            ("llama", ours.llama, &py.llama),
            ("aave_pool", ours.aave_pool, &py.aave_pool),
            ("sickle_factory", ours.sickle_factory, &py.sickle_factory),
            (
                "native.symbol",
                ours.native.map(|n| n.symbol),
                &py.native_symbol,
            ),
            (
                "native.price_key",
                ours.native.map(|n| n.price_key),
                &py.native_price_key,
            ),
            (
                "univ3.npm",
                ours.univ3.map(|u| u.npm),
                &optref(&py.univ3, |u| &u.npm),
            ),
            (
                "univ3.factory",
                ours.univ3.map(|u| u.factory),
                &optref(&py.univ3, |u| &u.factory),
            ),
            (
                "univ4.pm",
                ours.univ4.map(|u| u.pm),
                &optref(&py.univ4, |u| &u.pm),
            ),
            (
                "univ4.stateview",
                ours.univ4.map(|u| u.stateview),
                &optref(&py.univ4, |u| &u.stateview),
            ),
            (
                "aero_cl.npm",
                ours.aero_cl.map(|a| a.npm),
                &optref(&py.aero_cl, |a| &a.npm),
            ),
            (
                "aero_cl.factory",
                ours.aero_cl.map(|a| a.factory),
                &optref(&py.aero_cl, |a| &a.factory),
            ),
            (
                "aero_cl.label",
                ours.aero_cl.map(|a| a.label),
                &optref(&py.aero_cl, |a| &a.label),
            ),
        ] {
            if !same(rust, python) {
                diff(field, format!("{python:?}"), format!("{rust:?}"));
            }
        }

        if ours.chain_id != py.chain_id {
            diff(
                "chain_id",
                format!("{:?}", py.chain_id),
                format!("{:?}", ours.chain_id),
            );
        }
        if ours.vfat_api != py.vfat_api {
            diff(
                "vfat_api",
                py.vfat_api.to_string(),
                ours.vfat_api.to_string(),
            );
        }
        if ours.sickle_rpc != py.sickle_rpc {
            diff(
                "sickle_rpc",
                py.sickle_rpc.to_string(),
                ours.sickle_rpc.to_string(),
            );
        }
    }

    assert!(
        disagreements.is_empty(),
        "{} field(s) disagree with python:\n{}",
        disagreements.len(),
        disagreements.join("\n")
    );
}

/// Pulls one field out of an optional nested block, cloning only when it is present.
fn optref<T, F>(block: &Option<T>, field: F) -> Option<String>
where
    F: Fn(&T) -> &String,
{
    block.as_ref().map(|b| field(b).clone())
}

#[test]
fn address_to_chain_pairing_matches_python() {
    // The corpus pairings were produced by Python's own CHAIN_KINDS matchers, so this compares
    // fan-out plans rather than our reading of the rules.
    let corpus = load();
    for (kind, expected) in &corpus.pairings {
        let address = match kind.as_str() {
            "evm" => "0x1234567890abcdef1234567890ABCDEF12345678",
            "bitcoin" => "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            "solana" => "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            other => panic!("unknown pairing kind {other:?}"),
        };
        let ours: Vec<&str> = chains::chains_for_address(address)
            .into_iter()
            .map(|c| c.name)
            .collect();
        let theirs: Vec<&str> = expected.iter().map(|s| s.as_str()).collect();
        assert_eq!(ours, theirs, "pairing for {kind} differs");
    }
}

#[test]
fn no_chain_is_reachable_by_more_than_one_address_shape() {
    // Cross-check on the corpus itself: if a chain appeared under two pairings, one wallet's
    // balance would be fetched twice and double-counted in the total.
    let corpus = load();
    let mut seen: BTreeMap<&str, usize> = BTreeMap::new();
    for chains in corpus.pairings.values() {
        for chain in chains {
            *seen.entry(chain.as_str()).or_default() += 1;
        }
    }
    let dupes: Vec<&&str> = seen
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(c, _)| c)
        .collect();
    assert!(dupes.is_empty(), "chains in multiple pairings: {dupes:?}");
    assert_eq!(seen.len(), corpus.count, "some chain pairs with no address");
}
