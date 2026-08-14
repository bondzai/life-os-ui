//! Wallet-address shapes — port of `portfolio.py:166-196`.
//!
//! These do double duty: validating user input, and pairing a wallet with the chains it can
//! possibly exist on, so the fan-out never asks Bitcoin about an `0x…` address.

use std::sync::LazyLock;

use regex::Regex;

static EVM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^0x[a-fA-F0-9]{40}$").unwrap());
static BTC_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(bc1[a-z0-9]{11,71}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$").unwrap()
});
static SOL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$").unwrap());
static SPLIT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[,\s]+").unwrap());

pub const MAX_WALLETS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressKind {
    Evm,
    Bitcoin,
    Solana,
}

pub fn is_evm(address: &str) -> bool {
    EVM_RE.is_match(address)
}

pub fn is_bitcoin(address: &str) -> bool {
    BTC_RE.is_match(address)
}

/// base58 shape, **excluding** EVM and Bitcoin.
///
/// The exclusion matters: a legacy Bitcoin address is also valid base58, so without it a `1…`
/// address would be claimed by Solana and its balance would silently vanish from the portfolio.
pub fn is_solana(address: &str) -> bool {
    SOL_RE.is_match(address) && !is_evm(address) && !is_bitcoin(address)
}

pub fn kind_of(address: &str) -> Option<AddressKind> {
    if is_evm(address) {
        Some(AddressKind::Evm)
    } else if is_bitcoin(address) {
        Some(AddressKind::Bitcoin)
    } else if is_solana(address) {
        Some(AddressKind::Solana)
    } else {
        None
    }
}

pub fn is_valid(address: &str) -> bool {
    kind_of(address).is_some()
}

/// Splits a comma/whitespace separated list, rejecting the whole input if **any** entry is
/// invalid — same all-or-nothing contract as `parse_addresses`, so a typo never silently drops
/// one wallet from the total.
pub fn parse_addresses(raw: &str, max_wallets: usize) -> Result<Vec<String>, String> {
    let addresses: Vec<String> = SPLIT_RE
        .split(raw.trim())
        .filter(|a| !a.is_empty())
        .map(|a| a.to_string())
        .collect();

    if addresses.is_empty() || !addresses.iter().all(|a| is_valid(a)) {
        return Err("invalid address".into());
    }
    if addresses.len() > max_wallets {
        return Err(format!("too many wallets (max {max_wallets})"));
    }
    Ok(addresses)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EVM: &str = "0x1234567890abcdef1234567890ABCDEF12345678";
    const BTC_BECH32: &str = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const BTC_LEGACY: &str = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
    const SOL: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

    #[test]
    fn recognises_each_address_kind() {
        assert_eq!(kind_of(EVM), Some(AddressKind::Evm));
        assert_eq!(kind_of(BTC_BECH32), Some(AddressKind::Bitcoin));
        assert_eq!(kind_of(BTC_LEGACY), Some(AddressKind::Bitcoin));
        assert_eq!(kind_of(SOL), Some(AddressKind::Solana));
        assert_eq!(kind_of("not-an-address"), None);
    }

    #[test]
    fn a_legacy_bitcoin_address_is_not_stolen_by_solana() {
        // Both are base58; Bitcoin must win or the BTC balance disappears.
        assert!(is_bitcoin(BTC_LEGACY));
        assert!(!is_solana(BTC_LEGACY));
    }

    #[test]
    fn evm_addresses_are_case_insensitive_but_length_checked() {
        assert!(is_evm("0xABCDEF1234567890abcdef1234567890ABCDEF12"));
        assert!(!is_evm("0x1234"), "too short");
        assert!(!is_evm(&format!("{EVM}00")), "too long");
        assert!(
            !is_evm("1234567890abcdef1234567890abcdef12345678"),
            "missing 0x"
        );
    }

    #[test]
    fn parses_a_comma_or_space_separated_list() {
        assert_eq!(
            parse_addresses(EVM, MAX_WALLETS).unwrap(),
            vec![EVM.to_string()]
        );
        assert_eq!(
            parse_addresses(&format!("{EVM}, {BTC_BECH32}"), MAX_WALLETS).unwrap(),
            vec![EVM.to_string(), BTC_BECH32.to_string()]
        );
        assert_eq!(
            parse_addresses(&format!("{EVM}   {BTC_BECH32}"), MAX_WALLETS)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn one_bad_entry_rejects_the_whole_list() {
        // Partial acceptance would understate net worth without saying so.
        let err = parse_addresses(&format!("{EVM}, garbage"), MAX_WALLETS).unwrap_err();
        assert_eq!(err, "invalid address");
    }

    #[test]
    fn empty_input_is_rejected() {
        assert!(parse_addresses("", MAX_WALLETS).is_err());
        assert!(parse_addresses("   ", MAX_WALLETS).is_err());
    }

    #[test]
    fn the_wallet_cap_is_enforced() {
        let many = [EVM; MAX_WALLETS + 1].join(",");
        assert_eq!(
            parse_addresses(&many, MAX_WALLETS).unwrap_err(),
            "too many wallets (max 10)"
        );
    }

    #[test]
    fn duplicates_are_preserved_here_and_deduped_later() {
        // build_portfolios does the dedup (`dict.fromkeys`); parsing must not silently differ.
        let pair = format!("{EVM},{EVM}");
        assert_eq!(parse_addresses(&pair, MAX_WALLETS).unwrap().len(), 2);
    }
}
