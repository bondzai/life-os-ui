//! Spam-token filtering and the price-confidence gate — port of `portfolio.py:224-244`.
//!
//! **Ported verbatim on purpose.** These heuristics encode real experience of what airdropped
//! scam tokens look like; "cleaning them up" changes which tokens appear in the portfolio and
//! what the totals say. Any change here should be driven by a token that was wrongly kept or
//! wrongly dropped, not by taste.

use std::sync::LazyLock;

use regex::Regex;

/// A DefiLlama price below this confidence is untrustworthy — scam coins get a bogus low-confidence
/// price, which is how a worthless token would otherwise inflate net worth.
pub const MIN_CONFIDENCE: f64 = 0.9;

/// Symbols longer than this are not real tickers.
const MAX_SYMBOL_LEN: usize = 20;

static SPAM_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(https?://|www\.|\.com|\.io\b|\.xyz|\.net|\.org\b|\.app|\.vip|\.live|\.cc\b|t\.me/|claim|airdrop|voucher|giveaway|\$\s|→|🎁|💰|reward[s]?\b|visit )",
    )
    .unwrap()
});

/// One token as Blockscout reports it, reduced to the fields the filter looks at.
#[derive(Debug, Default, Clone)]
pub struct TokenInfo<'a> {
    pub symbol: Option<&'a str>,
    pub name: Option<&'a str>,
    /// Blockscout's own reputation label, e.g. `"spam"`.
    pub reputation: Option<&'a str>,
}

/// Three independent layers, any of which condemns a token:
/// Blockscout's own label, a scam-shaped name or symbol, and an absurd symbol length.
pub fn is_spam(token: &TokenInfo) -> bool {
    if matches!(
        token.reputation.unwrap_or("").to_lowercase().as_str(),
        "spam" | "scam"
    ) {
        return true;
    }
    let text = format!(
        "{} {}",
        token.symbol.unwrap_or(""),
        token.name.unwrap_or("")
    );
    if SPAM_RE.is_match(&text) {
        return true;
    }
    token.symbol.unwrap_or("").chars().count() > MAX_SYMBOL_LEN
}

/// Whether a DefiLlama price may be trusted for valuation.
pub fn price_is_trustworthy(confidence: Option<f64>) -> bool {
    confidence.is_some_and(|c| c >= MIN_CONFIDENCE)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn token(symbol: &'static str, name: &'static str) -> TokenInfo<'static> {
        TokenInfo {
            symbol: Some(symbol),
            name: Some(name),
            reputation: None,
        }
    }

    #[test]
    fn real_tokens_pass() {
        assert!(!is_spam(&token("ETH", "Ether")));
        assert!(!is_spam(&token("USDC", "USD Coin")));
        assert!(!is_spam(&token("WBTC", "Wrapped Bitcoin")));
        assert!(!is_spam(&token("cbBTC", "Coinbase Wrapped BTC")));
    }

    #[test]
    fn blockscout_reputation_is_honoured() {
        let flagged = TokenInfo {
            symbol: Some("OK"),
            name: Some("Fine"),
            reputation: Some("SPAM"),
        };
        assert!(is_spam(&flagged));
        let scam = TokenInfo {
            symbol: Some("OK"),
            name: Some("Fine"),
            reputation: Some("scam"),
        };
        assert!(is_spam(&scam));
    }

    #[test]
    fn urls_in_the_name_are_spam() {
        assert!(is_spam(&token("FREE", "Visit https://claim-me.xyz")));
        assert!(is_spam(&token("AIR", "www.airdrop.io")));
        assert!(is_spam(&token("T", "join t.me/somechannel")));
        assert!(is_spam(&token("X", "rewards at example.com")));
    }

    #[test]
    fn free_money_words_are_spam() {
        for name in [
            "Claim your tokens",
            "Airdrop 2026",
            "Voucher inside",
            "Giveaway!",
            "Rewards",
        ] {
            assert!(is_spam(&token("TKN", name)), "{name} should be spam");
        }
    }

    #[test]
    fn emoji_and_arrow_bait_is_spam() {
        assert!(is_spam(&token("X", "🎁 open me")));
        assert!(is_spam(&token("X", "💰 big money")));
        assert!(is_spam(&token("X", "go → here")));
    }

    #[test]
    fn an_absurdly_long_symbol_is_spam() {
        assert!(!is_spam(&token(
            "ABCDEFGHIJKLMNOPQRST",
            "twenty chars is fine"
        )));
        assert!(is_spam(&token(
            "ABCDEFGHIJKLMNOPQRSTU",
            "twenty-one is not"
        )));
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(is_spam(&token("X", "CLAIM NOW")));
        assert!(is_spam(&token("X", "AirDrop")));
    }

    #[test]
    fn word_boundaries_stop_false_positives() {
        // `.io\b` must not fire on "ratio", nor `.org\b` on "organic".
        assert!(!is_spam(&token("RATIO", "Ratio Finance")));
        assert!(!is_spam(&token("ORG", "Organic Growth")));
    }

    #[test]
    fn the_confidence_gate_matches_the_python_threshold() {
        assert!(price_is_trustworthy(Some(0.99)));
        assert!(
            price_is_trustworthy(Some(MIN_CONFIDENCE)),
            "the boundary is inclusive"
        );
        assert!(!price_is_trustworthy(Some(0.89)));
        assert!(
            !price_is_trustworthy(None),
            "no confidence means no valuation"
        );
    }
}
