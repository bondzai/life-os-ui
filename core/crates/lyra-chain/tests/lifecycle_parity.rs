//! Differential tests for the vfat lifecycle port, against a corpus the Python generated.
//!
//! `_iso_epoch` and `position_perf.key` are pure functions, so they can be compared exhaustively
//! and offline — no servers, no network, no flakiness. That matters more here than usual:
//! `perf_key` is a *contract between two processes*. The alert loop writes `pos_perf` rows under
//! that string and every portfolio build reads them back by it. A divergence would not error; the
//! join would simply never match and `in_range_secs` would be quietly absent forever.
//!
//! Regenerate `lifecycle_corpus.json` from `wallet-portfolio` after any change to either Python
//! function — see `docs/parity.md`.

use serde_json::Value;

use lyra_chain::adapters::vfat::{iso_epoch, perf_key};

fn corpus() -> Value {
    let raw = include_str!("lifecycle_corpus.json");
    serde_json::from_str(raw).expect("lifecycle_corpus.json is valid JSON")
}

#[test]
fn iso_epoch_matches_python() {
    let corpus = corpus();
    let cases = corpus["iso_epoch"]
        .as_array()
        .expect("iso_epoch is an array");
    assert!(cases.len() >= 25, "corpus shrank: {} cases", cases.len());

    let mut compared = 0;
    for case in cases {
        let input = &case["in"];

        // The one documented divergence: a zone-less stamp is UTC here and *local* in Python, so
        // the oracle's own answer depends on the host's timezone. Skipped rather than asserted —
        // see `chrono_free_parse`. vfat always stamps `Z`.
        // A 19-character stamp carries no zone at all — the naive case.
        if input.as_str().is_some_and(|text| text.len() == 19) {
            continue;
        }

        let expected = case["out"].as_i64();
        assert_eq!(
            iso_epoch(input),
            expected,
            "_iso_epoch({input}) should be {expected:?}"
        );
        compared += 1;
    }
    assert!(compared >= 24, "only {compared} cases actually compared");
}

#[test]
fn perf_key_matches_python() {
    let corpus = corpus();
    let cases = corpus["perf_key"].as_array().expect("perf_key is an array");
    assert!(!cases.is_empty());

    for case in cases {
        let chain_id = case["chain_id"].as_u64().expect("chain_id");
        // The Python takes `#123`, `123` and `123` (int) alike; `str(token_id)` normalises them
        // before stripping, which is what the Rust signature already assumes.
        let token = match (case["token_id"].as_str(), case["token_num"].as_i64()) {
            (Some(text), _) => text.to_string(),
            (None, Some(number)) => number.to_string(),
            _ => panic!("corpus row has neither token_id nor token_num"),
        };
        let expected = case["out"].as_str().expect("out");
        assert_eq!(
            perf_key(chain_id, &token),
            expected,
            "position_perf.key({chain_id}, {token:?})"
        );
    }
}
