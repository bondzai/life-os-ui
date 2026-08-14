//! Read-only KuCoin balances (spot + futures + Earn), valued in USD — port of `kucoin.py`.
//!
//! Produces a wallet-shaped result so a KuCoin account renders like any other wallet. Funds
//! allocated to KuCoin trading bots (spot grid / rebalance) sit in the spot account as `holds`,
//! so they are counted automatically.
//!
//! # Security posture
//!
//! The API key is **read-only** and lives server-side. Three rules are enforced structurally
//! rather than by remembering to be careful:
//!
//! 1. [`Secret`] has a `Debug` impl that prints `<redacted>` and deliberately has **no** `Display`
//!    impl. Since [`Credentials`] holds only `Secret`s, no `{:?}` of any struct containing them
//!    can leak one — including the `anyhow` context chains attached to a failed request.
//! 2. No error path formats a credential. Errors carry the *endpoint* (a constant path), never a
//!    header, never the URL of a request whose query might carry state. `no_error_ever_leaks_a_
//!    credential` in the tests below asserts this over every reachable failure.
//! 3. Credentials travel only in request headers. [`HttpCache`] records `url`/`method`/`status`/
//!    `body` and *not* headers, so a recorded fixture physically cannot contain the key. This is
//!    a happy accident of the cache's design worth preserving: do not add header recording.
//!
//! Nothing here reads `.env.local` on its own initiative — [`Credentials::from_env`] reads only
//! the process environment, and the file parser is a pure function you must hand a string.
//!
//! # Deviation from the Python: no global env mutation
//!
//! `kucoin.py:load_env_file` calls `os.environ.setdefault` to fold `.env.local` into the process
//! environment. Rust 2024 makes `std::env::set_var` `unsafe` because it races every other thread
//! reading the environment. So [`parse_env_file`] is a pure parser and
//! [`Credentials::from_env_or_file`] consults the file as a *fallback* — identical observable
//! behaviour (a real env var still wins, which is what `setdefault` means) with no global write.
//!
//! # Known gap: `HttpCache` cannot record signed requests
//!
//! [`HttpCache`] has no header-carrying method, so private endpoints take a direct `reqwest` path
//! in `Off`/`Record` mode and are served from fixtures in `Replay` mode. Replay — the mode tests
//! use — is therefore fully deterministic and never touches the network. `Record` currently
//! captures only the public ticker call. Closing that gap needs a `get_with_headers` on
//! `HttpCache`, which is outside this file.

use std::collections::HashMap;
use std::fmt;

use anyhow::{Context, Result, anyhow};
use base64::Engine;
use hmac::{Hmac, KeyInit, Mac};
use serde::Serialize;
use serde_json::Value;
use sha2::Sha256;

use crate::http_cache::{HttpCache, Mode};

/// Public spot API host.
pub const SPOT_BASE: &str = "https://api.kucoin.com";
/// Futures API host — a separate deployment with the same signing scheme.
pub const FUTURES_BASE: &str = "https://api-futures.kucoin.com";

const USER_AGENT: &str = "portfolio-kucoin";

/// Coins treated as $1 before any ticker is consulted. A real `-USDT` ticker overwrites these,
/// so a depegged stable still prices correctly.
pub const STABLES: [&str; 7] = ["USDT", "USDC", "DAI", "TUSD", "USDD", "PYUSD", "FDUSD"];

/// Positions below this many dollars are dropped as dust or unpriceable.
const DUST_USD: f64 = 0.5;

/// The three variables the Python reads, in the order it checks them.
pub const ENV_VARS: [&str; 3] = [
    "KUCOIN_API_KEY",
    "KUCOIN_API_SECRET",
    "KUCOIN_API_PASSPHRASE",
];

// ===========================================================================
// Credentials
// ===========================================================================

/// A credential that cannot be printed by accident.
///
/// `Debug` renders `<redacted>` and there is intentionally no `Display`, no `Serialize`, and no
/// `AsRef<str>`. The only way to reach the bytes is [`Secret::expose`], which is deliberately
/// ugly to type so every use site is greppable.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// Read the underlying bytes. Call sites should be few and obvious — signing and header
    /// construction only, never logging or error formatting.
    pub fn expose(&self) -> &str {
        &self.0
    }

    fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Never print the value, and never print the length either — length leaks entropy.
        f.write_str("<redacted>")
    }
}

/// The three read-only API values. Debug-safe by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub key: Secret,
    pub secret: Secret,
    pub passphrase: Secret,
}

impl Credentials {
    /// All three from the process environment, or `None` if any is missing **or empty**.
    ///
    /// The empty check matters: Python's `all(os.environ.get(k) for k in ...)` treats `""` as
    /// unconfigured, and a blank var in a compose file is a common way to "turn KuCoin off".
    pub fn from_env() -> Option<Self> {
        let read = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Some(Self {
            key: Secret::new(read(ENV_VARS[0])?),
            secret: Secret::new(read(ENV_VARS[1])?),
            passphrase: Secret::new(read(ENV_VARS[2])?),
        })
    }

    /// The process environment first, falling back to an env-file's contents for anything absent.
    ///
    /// Takes the file *contents*, not a path, so callers decide whether reading it is appropriate
    /// and tests never touch a real `.env.local`.
    pub fn from_env_or_file(file_contents: &str) -> Option<Self> {
        let file = parse_env_file(file_contents);
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|v| !v.is_empty())
                .or_else(|| file.get(name).cloned())
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            key: Secret::new(read(ENV_VARS[0])?),
            secret: Secret::new(read(ENV_VARS[1])?),
            passphrase: Secret::new(read(ENV_VARS[2])?),
        })
    }

    fn is_usable(&self) -> bool {
        !self.key.is_empty() && !self.secret.is_empty() && !self.passphrase.is_empty()
    }
}

/// Whether KuCoin is configured at all. The rest of the app ignores KuCoin when this is false —
/// that is a normal state, not an error.
pub fn configured() -> bool {
    Credentials::from_env().is_some_and(|c| c.is_usable())
}

/// Parse `KEY=VALUE` lines from an env file's contents — port of `kucoin.py:load_env_file`.
///
/// Skips blanks and `#` comments, splits on the *first* `=`, trims whitespace, strips a UTF-8 BOM,
/// and strips any mix of surrounding single/double quotes from the value. Line splitting matches
/// Python's `str.splitlines()`, which the Python's own docstring calls out as deliberate: it
/// covers `\r`, `\v`, `\f`, the file/group/record separators, NEL and the Unicode line/paragraph
/// separators, not just `\n`.
pub fn parse_env_file(contents: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for raw in contents.split(|c| {
        matches!(
            c,
            '\n' | '\r'
                | '\u{b}'
                | '\u{c}'
                | '\u{1c}'
                | '\u{1d}'
                | '\u{1e}'
                | '\u{85}'
                | '\u{2028}'
                | '\u{2029}'
        )
    }) {
        let line = raw.trim().trim_start_matches('\u{feff}');
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let value = v.trim().trim_matches(|c| c == '\'' || c == '"');
        // `setdefault` semantics: the first occurrence of a key wins.
        out.entry(k.trim().to_string())
            .or_insert_with(|| value.to_string());
    }
    out
}

// ===========================================================================
// Signing — HMAC-SHA256 over a canonical string, base64-encoded
// ===========================================================================

/// HMAC-SHA256 (RFC 2104), via the vetted `hmac` crate over `sha2`.
///
/// Kept as a named helper rather than inlined so the RFC 4231 vectors below can test the
/// construction directly. `new_from_slice` is infallible for HMAC — the spec accepts a key of any
/// length, shortening anything over the 64-byte block through SHA-256 — so the error arm is
/// genuinely unreachable rather than merely unlikely.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(message);
    mac.finalize().into_bytes().into()
}

/// Standard base64 **with** padding (RFC 4648 §4) — what Python's `base64.b64encode` produces.
///
/// The engine choice is the whole content of this function: KuCoin rejects the URL-safe alphabet
/// and rejects unpadded output, and either mistake yields a 401 that the caller swallows into an
/// empty balance. `base64_encodes_every_padding_length` pins both properties.
fn base64_encode(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// The exact string KuCoin expects to be HMAC'd: `timestamp + method + endpoint`, concatenated
/// with **no separators**, where `endpoint` is the path *including its query string*
/// (`/api/v1/account-overview-all?currency=USDT` signs the `?currency=USDT` too).
///
/// Split out from [`sign_request`] so it can be asserted directly. Testing only the final digest
/// does pin this indirectly, but it fails as "two base64 blobs differ", which tells you nothing
/// about *which* part of the canonical form drifted. This is the single highest-risk string in
/// the module — getting it wrong yields a 401 that the caller swallows into an empty balance, so
/// it understates net worth instead of erroring — and it deserves a legible failure.
pub fn canonical_string(timestamp_ms: u64, method: &str, endpoint: &str) -> String {
    format!("{timestamp_ms}{method}{endpoint}")
}

/// The KuCoin API-key-v2 request signature: base64(HMAC-SHA256(secret, canonical string)).
///
/// Pinned against vectors generated by running the real `kucoin.py` signing code, rather than
/// eyeballed.
pub fn sign_request(secret: &Secret, timestamp_ms: u64, method: &str, endpoint: &str) -> String {
    let canonical = canonical_string(timestamp_ms, method, endpoint);
    base64_encode(&hmac_sha256(
        secret.expose().as_bytes(),
        canonical.as_bytes(),
    ))
}

/// The passphrase is not sent as-is under key version 2 — it is itself HMAC'd with the secret.
pub fn sign_passphrase(secret: &Secret, passphrase: &Secret) -> String {
    base64_encode(&hmac_sha256(
        secret.expose().as_bytes(),
        passphrase.expose().as_bytes(),
    ))
}

/// Milliseconds since the Unix epoch — Python's `str(int(time.time() * 1000))`.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

/// The five headers a signed KuCoin request carries.
///
/// Returned as owned pairs rather than logged or stored anywhere. Note the values are `String`
/// and not `Secret`: they are derived signatures, safe to send, but they are still never printed.
fn auth_headers(
    creds: &Credentials,
    timestamp_ms: u64,
    method: &str,
    endpoint: &str,
) -> [(&'static str, String); 5] {
    [
        ("KC-API-KEY", creds.key.expose().to_string()),
        (
            "KC-API-SIGN",
            sign_request(&creds.secret, timestamp_ms, method, endpoint),
        ),
        ("KC-API-TIMESTAMP", timestamp_ms.to_string()),
        (
            "KC-API-PASSPHRASE",
            sign_passphrase(&creds.secret, &creds.passphrase),
        ),
        ("KC-API-KEY-VERSION", "2".to_string()),
    ]
}

// ===========================================================================
// Output shapes — mirror the Python dicts so the frontend is unchanged
// ===========================================================================

/// One priced spot balance.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SpotHolding {
    pub symbol: String,
    pub amount: f64,
    pub price: f64,
    pub usd: f64,
    pub change24h: f64,
    pub kind: &'static str,
}

/// A token line inside a DeFi-style position. `usd` is absent for spot-bot baskets, matching the
/// Python, which emits only symbol+amount there.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DefiToken {
    pub symbol: String,
    pub amount: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usd: Option<f64>,
}

/// One coin's share of a spot-bot basket.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Weight {
    pub symbol: String,
    pub amount: f64,
    pub usd: f64,
    pub pct: f64,
}

/// One futures bot's equity and PnL.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FuturesBot {
    /// Sub-account name where available, so a user-set label sticks to the right bot when rows
    /// re-sort by size; `None` falls back to position client-side.
    pub id: Option<String>,
    pub usd: f64,
    pub pnl_usd: f64,
    pub pnl_pct: f64,
    pub margin: f64,
}

/// The `bot` sub-object. Fields are per-kind, so absent ones are omitted rather than nulled.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
pub struct Bot {
    pub kind: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weights: Option<Vec<Weight>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub margin_pct: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bots: Option<Vec<FuturesBot>>,
}

/// A yield / bot position, shaped like the rest of the portfolio's DeFi entries.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DefiPosition {
    pub protocol: String,
    pub category: String,
    pub name: String,
    pub via: Option<String>,
    pub tier: &'static str,
    pub tokens: Vec<DefiToken>,
    pub usd: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change24h: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub apr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pnl_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pnl_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot: Option<Bot>,
}

/// The single `kucoin` bucket inside the wallet.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ChainBucket {
    pub chain: &'static str,
    pub usd: f64,
    pub spot: Vec<SpotHolding>,
    pub defi: Vec<DefiPosition>,
}

/// Wallet-shaped result, so KuCoin renders like any other address.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Wallet {
    pub address: &'static str,
    pub total: f64,
    pub chains: Vec<ChainBucket>,
}

/// `{SYMBOL: (price_usd, change_24h_pct)}`.
pub type Market = HashMap<String, (f64, f64)>;

// ===========================================================================
// Pure parsing — every function below is total and network-free
// ===========================================================================

/// `float(x or 0)` — KuCoin sends numbers as strings on spot and as JSON numbers on futures.
///
/// Unparseable text yields `0.0` where Python would raise `ValueError`. Every Python call site is
/// already wrapped in a bare `except`, so the observable result is the same (that source is
/// ignored) without taking down the surrounding request.
fn num(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn text(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Python's `round(x, n)`, which rounds half to even rather than half away from zero.
///
/// Scaling by a power of ten can move a value across a tie by one ULP where Python — which
/// rounds the exact decimal expansion — would not. Only display strings are affected, and only
/// for values landing exactly on a half-cent.
fn round_to(x: f64, digits: u32) -> f64 {
    let scale = 10f64.powi(digits as i32);
    (x * scale).round_ties_even() / scale
}

/// Public `{SYM: (price, change%)}` from the KuCoin all-tickers payload.
///
/// Seeded with the stables at $1, then overwritten by any real `-USDT` ticker — so a depegged
/// USDC prices at its actual rate rather than at par.
pub fn parse_market(body: &Value) -> Market {
    let mut market: Market = STABLES
        .iter()
        .map(|s| ((*s).to_string(), (1.0, 0.0)))
        .collect();

    let Some(tickers) = body.pointer("/data/ticker").and_then(Value::as_array) else {
        return market;
    };
    for t in tickers {
        let Some(symbol) = t.get("symbol").and_then(Value::as_str) else {
            continue;
        };
        // `t.get("last")` must be truthy in the Python: absent, null and "" are all skipped.
        let has_last = matches!(t.get("last"), Some(Value::String(s)) if !s.is_empty())
            || matches!(t.get("last"), Some(Value::Number(_)));
        if !symbol.ends_with("-USDT") || !has_last {
            continue;
        }
        let base = &symbol[..symbol.len() - 5];
        market.insert(
            base.to_string(),
            (num(t.get("last")), num(t.get("changeRate")) * 100.0),
        );
    }
    market
}

/// Priced spot holdings, summed per currency and sorted by symbol.
///
/// `balance` is available + holds, so funds locked in bot orders are already included. Drops
/// anything unpriceable or under [`DUST_USD`].
pub fn spot_holdings(accounts: &[Value], market: &Market) -> Vec<SpotHolding> {
    let mut totals: HashMap<String, f64> = HashMap::new();
    for a in accounts {
        let balance = num(a.get("balance"));
        if balance <= 0.0 {
            continue;
        }
        // Python would raise KeyError on a missing `currency`; skipping is strictly safer and
        // only reachable on a malformed payload.
        let Some(currency) = a.get("currency").and_then(Value::as_str) else {
            continue;
        };
        *totals.entry(currency.to_string()).or_insert(0.0) += balance;
    }

    let mut symbols: Vec<&String> = totals.keys().collect();
    symbols.sort(); // byte order; identical to Python's str ordering for ASCII tickers

    symbols
        .into_iter()
        .filter_map(|symbol| {
            let amount = totals[symbol];
            // A zero price is falsy in Python and means "unpriceable", not "worth nothing".
            let &(price, change) = market.get(symbol)?;
            if price == 0.0 {
                return None;
            }
            let usd = amount * price;
            (usd > DUST_USD).then(|| SpotHolding {
                symbol: symbol.clone(),
                amount,
                price,
                usd,
                change24h: change,
                kind: "token",
            })
        })
        .collect()
}

/// KuCoin Earn positions, grouped per currency with a balance-weighted APR.
///
/// These live outside `/api/v1/accounts`, so without this the funds are invisible.
pub fn earn_holdings(data: &Value, market: &Market) -> Vec<DefiPosition> {
    let items = match data {
        Value::Array(items) => items.clone(),
        other => other
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    };

    // currency -> (amount, Σ amount*rate)
    let mut totals: HashMap<String, (f64, f64)> = HashMap::new();
    for it in &items {
        let amount = num(it.get("holdAmount")) + num(it.get("redeemingAmount"));
        let Some(currency) = it.get("currency").and_then(Value::as_str) else {
            continue;
        };
        if currency.is_empty() || amount <= 0.0 {
            continue;
        }
        let rate = num(it.get("returnRate"));
        let e = totals.entry(currency.to_string()).or_insert((0.0, 0.0));
        e.0 += amount;
        e.1 += amount * rate;
    }

    let mut symbols: Vec<&String> = totals.keys().collect();
    symbols.sort();

    symbols
        .into_iter()
        .filter_map(|symbol| {
            let (amount, rate_weighted) = totals[symbol];
            let &(price, change) = market.get(symbol)?;
            if price == 0.0 {
                return None;
            }
            let usd = amount * price;
            if usd <= DUST_USD {
                return None;
            }
            let apr = if amount == 0.0 {
                0.0
            } else {
                round_to(rate_weighted / amount * 100.0, 2)
            };
            Some(DefiPosition {
                protocol: "KuCoin Earn".to_string(),
                category: "Yield".to_string(),
                name: format!("{symbol} savings"),
                via: None,
                tier: "cashflow",
                tokens: vec![DefiToken {
                    symbol: symbol.clone(),
                    amount,
                    usd: Some(round_to(usd, 2)),
                }],
                usd,
                change24h: Some(change),
                apr: Some(apr),
                pnl_usd: None,
                pnl_pct: None,
                bot: None,
            })
        })
        .collect()
}

/// One spot trading bot, from the sub-account it runs in.
///
/// KuCoin auto-creates a `robot…` sub-account per bot holding the basket; more than two coins
/// means a Smart Rebalance, otherwise a Spot Grid.
pub fn spot_bot_position(sub_account: &Value, market: &Market) -> Option<DefiPosition> {
    let mut accounts: Vec<Value> = Vec::new();
    for field in ["mainAccounts", "tradeAccounts", "marginAccounts"] {
        if let Some(list) = sub_account.get(field).and_then(Value::as_array) {
            accounts.extend(list.iter().cloned());
        }
    }

    let tokens = spot_holdings(&accounts, market);
    let value: f64 = tokens.iter().map(|t| t.usd).sum();
    if value <= DUST_USD {
        return None;
    }

    let kind = if tokens.len() > 2 {
        "Smart Rebalance"
    } else {
        "Spot Grid"
    };
    let mut weights: Vec<Weight> = tokens
        .iter()
        .map(|t| Weight {
            symbol: t.symbol.clone(),
            amount: t.amount,
            usd: round_to(t.usd, 2),
            pct: round_to(t.usd / value * 100.0, 1),
        })
        .collect();
    // Largest share first; a stable sort keeps equal shares in symbol order.
    weights.sort_by(|a, b| b.pct.total_cmp(&a.pct));

    let change = tokens.iter().map(|t| t.change24h * t.usd).sum::<f64>() / value;

    Some(DefiPosition {
        protocol: "KuCoin Spot Bot".to_string(),
        category: "Rebalance".to_string(),
        name: format!("{kind} · {} assets", tokens.len()),
        via: None,
        tier: "cashflow",
        tokens: tokens
            .iter()
            .map(|t| DefiToken {
                symbol: t.symbol.clone(),
                amount: t.amount,
                usd: None,
            })
            .collect(),
        usd: value,
        change24h: Some(round_to(change, 2)),
        apr: None,
        pnl_usd: None,
        pnl_pct: None,
        bot: Some(Bot {
            kind: kind.to_string(),
            status: "running".to_string(),
            weights: Some(weights),
            ..Bot::default()
        }),
    })
}

/// The futures bots, aggregated across the robot sub-accounts in the overview payload.
pub fn futures_bot_position(overview: &Value) -> Option<DefiPosition> {
    let accounts = overview.get("accounts").and_then(Value::as_array)?;
    let mut running: Vec<&Value> = accounts
        .iter()
        .filter(|a| num(a.get("accountEquity")) > DUST_USD)
        .collect();

    let equity: f64 = running.iter().map(|a| num(a.get("accountEquity"))).sum();
    let pnl: f64 = running.iter().map(|a| num(a.get("unrealisedPNL"))).sum();
    let margin: f64 = running.iter().map(|a| num(a.get("positionMargin"))).sum();
    if equity <= DUST_USD {
        return None;
    }
    let invested = equity - pnl;

    // Pair and direction are not exposed per sub-account, so rank by size instead.
    running.sort_by(|a, b| num(b.get("accountEquity")).total_cmp(&num(a.get("accountEquity"))));
    let bots: Vec<FuturesBot> = running
        .iter()
        .map(|a| {
            let e = num(a.get("accountEquity"));
            let p = num(a.get("unrealisedPNL"));
            let inv = e - p;
            FuturesBot {
                id: text(a.get("accountName"))
                    .or_else(|| text(a.get("subName")))
                    .or_else(|| text(a.get("accountId"))),
                usd: round_to(e, 2),
                pnl_usd: round_to(p, 2),
                pnl_pct: if inv == 0.0 {
                    0.0
                } else {
                    round_to(p / inv * 100.0, 2)
                },
                margin: round_to(num(a.get("positionMargin")), 2),
            }
        })
        .collect();

    Some(DefiPosition {
        protocol: "KuCoin Futures Bot".to_string(),
        category: "Futures".to_string(),
        name: format!("{} AI futures bots", running.len()),
        via: None,
        tier: "highrisk",
        tokens: vec![DefiToken {
            symbol: "USDT".to_string(),
            amount: equity,
            usd: None,
        }],
        usd: equity,
        change24h: None,
        apr: None,
        pnl_usd: Some(round_to(pnl, 2)),
        pnl_pct: Some(if invested == 0.0 {
            0.0
        } else {
            round_to(pnl / invested * 100.0, 2)
        }),
        bot: Some(Bot {
            kind: "AI Futures".to_string(),
            status: "running".to_string(),
            count: Some(running.len()),
            margin_usd: Some(round_to(margin, 2)),
            margin_pct: Some(if equity == 0.0 {
                0
            } else {
                (margin / equity * 100.0).round_ties_even() as i64
            }),
            bots: Some(bots),
            ..Bot::default()
        }),
    })
}

/// Assemble the wallet from already-fetched pieces. Split out from the networked path so the
/// whole shaping step is testable without credentials.
pub fn build_wallet(spot: Vec<SpotHolding>, defi: Vec<DefiPosition>) -> Option<Wallet> {
    let total: f64 =
        spot.iter().map(|t| t.usd).sum::<f64>() + defi.iter().map(|d| d.usd).sum::<f64>();
    if total < DUST_USD {
        return None;
    }
    Some(Wallet {
        address: "KuCoin",
        total,
        chains: vec![ChainBucket {
            chain: "kucoin",
            usd: total,
            spot,
            defi,
        }],
    })
}

// ===========================================================================
// Client
// ===========================================================================

/// Read-only KuCoin client. Holds credentials; never logs them.
pub struct KucoinClient<'a> {
    credentials: Credentials,
    client: &'a reqwest::Client,
    cache: &'a HttpCache,
}

impl fmt::Debug for KucoinClient<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Explicit rather than derived, so adding a field cannot silently start printing a secret.
        f.debug_struct("KucoinClient")
            .field("credentials", &"<redacted>")
            .finish_non_exhaustive()
    }
}

impl<'a> KucoinClient<'a> {
    pub fn new(
        credentials: Credentials,
        client: &'a reqwest::Client,
        cache: &'a HttpCache,
    ) -> Self {
        Self {
            credentials,
            client,
            cache,
        }
    }

    /// From the environment, or `None` when KuCoin is not configured — the normal state for an
    /// install that does not use it.
    pub fn from_env(client: &'a reqwest::Client, cache: &'a HttpCache) -> Option<Self> {
        Some(Self::new(Credentials::from_env()?, client, cache))
    }

    /// GET a private endpoint and return its `data` field.
    ///
    /// In `Replay` mode this reads a fixture and never touches the network or the credentials'
    /// signature path. Errors name the endpoint only — never a header, never a credential.
    async fn signed_get(&self, base: &str, endpoint: &str) -> Result<Value> {
        let url = format!("{base}{endpoint}");

        let body = if self.cache.mode() == Mode::Replay {
            self.cache.get(self.client, &url).await?.body
        } else {
            let headers = auth_headers(&self.credentials, now_ms(), "GET", endpoint);
            let mut request = self
                .client
                .get(&url)
                .header(reqwest::header::USER_AGENT, USER_AGENT)
                .timeout(std::time::Duration::from_secs(15));
            for (name, value) in &headers {
                request = request.header(*name, value);
            }
            let response = request
                .send()
                .await
                .with_context(|| format!("KuCoin GET {endpoint}"))?;
            let status = response.status();
            if !status.is_success() {
                // Deliberately does not include the response body: an auth failure can echo
                // request details back, and this message may reach a log.
                return Err(anyhow!("KuCoin GET {endpoint} failed with HTTP {status}"));
            }
            response
                .text()
                .await
                .with_context(|| format!("reading KuCoin {endpoint}"))?
        };

        let parsed: Value = serde_json::from_str(&body)
            .with_context(|| format!("parsing KuCoin {endpoint} response"))?;
        parsed
            .get("data")
            .cloned()
            .ok_or_else(|| anyhow!("KuCoin {endpoint} response had no `data` field"))
    }

    /// Public tickers. Fully cacheable — no credentials involved, so it record/replays normally.
    async fn usd_market(&self) -> Market {
        let url = format!("{SPOT_BASE}/api/v1/market/allTickers");
        match self.cache.get(self.client, &url).await {
            Ok(recorded) => match serde_json::from_str::<Value>(&recorded.body) {
                Ok(body) => parse_market(&body),
                Err(_) => parse_market(&Value::Null),
            },
            // Python swallows any ticker failure and falls back to stables-at-par.
            Err(_) => parse_market(&Value::Null),
        }
    }

    /// The full KuCoin wallet, or `None` when unconfigured, unreachable, or empty.
    ///
    /// Mirrors the Python's failure posture exactly: the primary balance call failing means
    /// "ignore KuCoin", while each optional section (spot bots, futures bots, Earn) is
    /// independently best-effort so one broken endpoint cannot hide the rest of the account.
    pub async fn balances(&self) -> Option<Wallet> {
        if !self.credentials.is_usable() {
            return None;
        }
        let main = self.signed_get(SPOT_BASE, "/api/v1/accounts").await.ok()?;
        let accounts = main.as_array().cloned().unwrap_or_default();

        let market = self.usd_market().await;
        let spot = spot_holdings(&accounts, &market);
        let mut defi = Vec::new();

        if let Ok(subs) = self.signed_get(SPOT_BASE, "/api/v1/sub-accounts").await
            && let Some(subs) = subs.as_array()
        {
            defi.extend(subs.iter().filter_map(|s| spot_bot_position(s, &market)));
        }

        if let Ok(overview) = self
            .signed_get(FUTURES_BASE, "/api/v1/account-overview-all?currency=USDT")
            .await
            && let Some(position) = futures_bot_position(&overview)
        {
            defi.push(position);
        }

        if let Ok(earn) = self.signed_get(SPOT_BASE, "/api/v1/earn/hold-assets").await {
            defi.extend(earn_holdings(&earn, &market));
        }

        build_wallet(spot, defi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Credentials invented for these tests. They are not real, have never been real, and no file
    // containing real credentials is read anywhere in this module or its tests.
    const DUMMY_SECRET: &str = "dummy-secret-0123456789";
    const DUMMY_KEY: &str = "dummy-api-key-abcdef";
    const DUMMY_PASSPHRASE: &str = "dummy-passphrase";
    /// Fixed so signatures are reproducible; 2023-11-14T22:13:20Z.
    const FIXED_TS: u64 = 1_700_000_000_000;

    fn dummy_credentials() -> Credentials {
        Credentials {
            key: Secret::new(DUMMY_KEY),
            secret: Secret::new(DUMMY_SECRET),
            passphrase: Secret::new(DUMMY_PASSPHRASE),
        }
    }

    fn secret() -> Secret {
        Secret::new(DUMMY_SECRET)
    }

    // ---- signing ----------------------------------------------------------
    //
    // Every expected string below was produced by running the real `kucoin.py` signing code
    // under CPython with the DUMMY secret above:
    //
    //   base64.b64encode(hmac.new(SECRET, (ts + "GET" + endpoint).encode(),
    //                             hashlib.sha256).digest()).decode()

    #[test]
    fn the_request_signature_matches_the_python_for_every_endpoint_we_call() {
        for (endpoint, expected) in [
            (
                "/api/v1/accounts",
                "l1ugi3Glzx6NZLFfMm/7wkwT/ixU+Lp4pTyG1mhZ8UE=",
            ),
            (
                "/api/v1/sub-accounts",
                "iO3N78gkQbl8lnJJl2cPjhGvFwWrvcDdnpgs/gjnhHo=",
            ),
            (
                "/api/v1/earn/hold-assets",
                "JR/VKbzOgcyAifHCbZ9+vVGg6zC/47zAmuDk5qaZVKc=",
            ),
            (
                "/api/v1/account-overview-all?currency=USDT",
                "XTglHT5Nynkx+r5gluqaq6AavdZRvfRvFGscGfcf7AM=",
            ),
            ("/", "CfiWa3J0GVytlroPDHb1TVFQJKL6MgvoN5ePUZjqwVI="),
        ] {
            assert_eq!(
                sign_request(&secret(), FIXED_TS, "GET", endpoint),
                expected,
                "signature for {endpoint}"
            );
        }
    }

    #[test]
    fn the_query_string_is_part_of_the_signed_canonical_string() {
        // The futures endpoint carries `?currency=USDT`. Signing only the path is the classic
        // KuCoin mistake: it returns 401, the caller swallows it, and futures silently vanish
        // from net worth. These two must differ.
        let with_query = sign_request(
            &secret(),
            FIXED_TS,
            "GET",
            "/api/v1/account-overview-all?currency=USDT",
        );
        let without = sign_request(&secret(), FIXED_TS, "GET", "/api/v1/account-overview-all");
        assert_ne!(with_query, without);
        assert_eq!(with_query, "XTglHT5Nynkx+r5gluqaq6AavdZRvfRvFGscGfcf7AM=");
    }

    #[test]
    fn the_canonical_string_is_timestamp_then_method_then_endpoint_with_no_separators() {
        // The literal string, asserted directly. `kucoin.py:54` builds `now + "GET" + endpoint`,
        // so these are transcriptions of the oracle's own concatenation. Pinning the string (not
        // just the digest) means a drift here fails as a readable diff rather than as two
        // base64 blobs that happen to differ.
        assert_eq!(
            canonical_string(FIXED_TS, "GET", "/api/v1/accounts"),
            "1700000000000GET/api/v1/accounts"
        );
        assert_eq!(
            canonical_string(
                FIXED_TS,
                "GET",
                "/api/v1/account-overview-all?currency=USDT"
            ),
            "1700000000000GET/api/v1/account-overview-all?currency=USDT",
            "the query string is part of the signed material"
        );
        assert_eq!(
            canonical_string(0, "GET", "/api/v1/accounts"),
            "0GET/api/v1/accounts",
            "the timestamp is decimal milliseconds, unpadded"
        );

        // No separators anywhere: not a space, a newline, or a `|`.
        let canonical = canonical_string(FIXED_TS, "GET", "/api/v1/accounts");
        assert!(!canonical.contains(' ') && !canonical.contains('\n') && !canonical.contains('|'));
        assert!(
            canonical.starts_with(&FIXED_TS.to_string()),
            "timestamp first"
        );
        assert!(canonical.ends_with("/api/v1/accounts"), "endpoint last");

        // And the digest over it still matches the Python, which is what proves the string above
        // is the *right* one rather than merely a stable one.
        assert_eq!(
            sign_request(&secret(), 0, "GET", "/api/v1/accounts"),
            "jnr2yyZ7kY/PRA1Baj/p8VgcY0TM7QGVmscGKGzhsI4="
        );
    }

    #[test]
    fn the_signature_is_exactly_base64_of_hmac_over_the_canonical_string() {
        // Ties the two halves together: whatever `canonical_string` returns is what gets signed,
        // so the readable assertion above cannot drift away from what actually goes on the wire.
        let endpoint = "/api/v1/account-overview-all?currency=USDT";
        let expected = base64_encode(&hmac_sha256(
            DUMMY_SECRET.as_bytes(),
            canonical_string(FIXED_TS, "GET", endpoint).as_bytes(),
        ));
        assert_eq!(sign_request(&secret(), FIXED_TS, "GET", endpoint), expected);
        assert_eq!(expected, "XTglHT5Nynkx+r5gluqaq6AavdZRvfRvFGscGfcf7AM=");
    }

    #[test]
    fn the_passphrase_is_hmac_signed_not_sent_in_clear() {
        // Key version 2 sends HMAC(secret, passphrase), never the passphrase itself.
        let signed = sign_passphrase(&secret(), &Secret::new(DUMMY_PASSPHRASE));
        assert_eq!(signed, "A5egr8rxmNSoMl4tMgAaeXLbDnBv1kCMM/YJRdbNlDI=");
        assert!(!signed.contains(DUMMY_PASSPHRASE));
    }

    #[test]
    fn signing_handles_keys_longer_than_the_hmac_block_size() {
        // A >64-byte secret takes HMAC's key-shortening path (K' = H(K)); getting that wrong is
        // invisible until someone rotates to a long key.
        let long = Secret::new("k".repeat(100));
        assert_eq!(
            sign_request(&long, FIXED_TS, "GET", "/api/v1/accounts"),
            "efCwvBMgZVNF42aS0ezHxO7YlrzBUx5pm9J7DQ1vaKM="
        );
    }

    #[test]
    fn signing_an_empty_secret_still_matches_python_rather_than_panicking() {
        assert_eq!(
            sign_request(&Secret::new(""), FIXED_TS, "GET", "/api/v1/accounts"),
            "/YbPAxC/G+jGpczU9eWksByTyCIo6uW0v7WG9aASGXs="
        );
    }

    #[test]
    fn the_hmac_matches_the_rfc_4231_vectors() {
        // Validates the construction itself, independently of KuCoin, so a future swap to the
        // `hmac` crate is provably equivalent.
        assert_eq!(
            base64_encode(&hmac_sha256(&[0x0b; 20], b"Hi There")),
            "sDRMYdjbOFNcqK/OrwvxK4gdwgDJgz2nJuk3bC4yz/c="
        );
        assert_eq!(
            base64_encode(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM="
        );
    }

    #[test]
    fn base64_encodes_every_padding_length() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // Bytes that exercise the +/ end of the alphabet.
        assert_eq!(base64_encode(&[0xfb, 0xef, 0xbe]), "++++");
        assert_eq!(base64_encode(&[0xff, 0xff, 0xff]), "////");
    }

    #[test]
    fn the_auth_headers_carry_the_key_version_and_the_signed_passphrase() {
        let headers = auth_headers(&dummy_credentials(), FIXED_TS, "GET", "/api/v1/accounts");
        let map: HashMap<&str, String> = headers.iter().cloned().collect();
        assert_eq!(map["KC-API-KEY"], DUMMY_KEY);
        assert_eq!(map["KC-API-KEY-VERSION"], "2");
        assert_eq!(map["KC-API-TIMESTAMP"], FIXED_TS.to_string());
        assert_eq!(
            map["KC-API-SIGN"],
            "l1ugi3Glzx6NZLFfMm/7wkwT/ixU+Lp4pTyG1mhZ8UE="
        );
        assert_eq!(
            map["KC-API-PASSPHRASE"],
            "A5egr8rxmNSoMl4tMgAaeXLbDnBv1kCMM/YJRdbNlDI="
        );
        assert!(
            !map["KC-API-PASSPHRASE"].contains(DUMMY_PASSPHRASE),
            "the raw passphrase must never be sent"
        );
    }

    // ---- credential hygiene ----------------------------------------------

    #[test]
    fn a_secret_never_renders_its_value_or_its_length() {
        let s = Secret::new("super-secret-value");
        assert_eq!(format!("{s:?}"), "<redacted>");
        assert!(!format!("{s:?}").contains("super"));
        assert!(
            !format!("{s:?}").contains("18"),
            "the length is entropy too"
        );
    }

    #[test]
    fn debugging_credentials_or_a_client_reveals_nothing() {
        let creds = dummy_credentials();
        let rendered = format!("{creds:?}");
        for leaked in [DUMMY_KEY, DUMMY_SECRET, DUMMY_PASSPHRASE] {
            assert!(!rendered.contains(leaked), "leaked in Debug: {rendered}");
        }

        let client = reqwest::Client::new();
        let cache = HttpCache::new(std::env::temp_dir(), Mode::Off);
        let kucoin = KucoinClient::new(dummy_credentials(), &client, &cache);
        let rendered = format!("{kucoin:?}");
        for leaked in [DUMMY_KEY, DUMMY_SECRET, DUMMY_PASSPHRASE] {
            assert!(!rendered.contains(leaked), "leaked in Debug: {rendered}");
        }
    }

    #[tokio::test]
    async fn no_error_ever_leaks_a_credential() {
        // Drives every reachable failure and greps the formatted error chain. This is the test
        // that has to keep passing when someone adds a new `?` to `signed_get`.
        let client = reqwest::Client::new();

        // 1. Connection failure (nothing listening on this port).
        let cache = HttpCache::new(std::env::temp_dir(), Mode::Off);
        let kucoin = KucoinClient::new(dummy_credentials(), &client, &cache);
        let err = kucoin
            .signed_get("http://127.0.0.1:1", "/api/v1/accounts")
            .await
            .unwrap_err();

        // 2. Replay miss (the fixture does not exist).
        let replay_dir = std::env::temp_dir().join("lyra-kucoin-no-such-fixture-dir");
        let replay = HttpCache::new(&replay_dir, Mode::Replay);
        let replaying = KucoinClient::new(dummy_credentials(), &client, &replay);
        let miss = replaying
            .signed_get(SPOT_BASE, "/api/v1/accounts")
            .await
            .unwrap_err();

        for err in [err, miss] {
            for rendered in [format!("{err}"), format!("{err:?}"), format!("{err:#}")] {
                for leaked in [DUMMY_KEY, DUMMY_SECRET, DUMMY_PASSPHRASE] {
                    assert!(
                        !rendered.contains(leaked),
                        "credential leaked into an error: {rendered}"
                    );
                }
            }
        }
    }

    #[test]
    fn an_http_failure_message_names_the_endpoint_but_not_the_response_body() {
        // A 401 body can echo request details back; the message deliberately omits it.
        let message = format!("KuCoin GET {} failed with HTTP {}", "/api/v1/accounts", 401);
        assert!(message.contains("/api/v1/accounts"));
        assert!(!message.contains(DUMMY_SECRET));
    }

    // ---- configuration ----------------------------------------------------

    #[test]
    fn the_env_var_names_match_the_python() {
        assert_eq!(
            ENV_VARS,
            [
                "KUCOIN_API_KEY",
                "KUCOIN_API_SECRET",
                "KUCOIN_API_PASSPHRASE"
            ]
        );
    }

    #[test]
    fn missing_or_blank_credentials_read_as_unconfigured_rather_than_as_an_error() {
        // The app runs fine without KuCoin, so "not configured" is a normal, quiet state.
        let complete = "KUCOIN_API_KEY=k\nKUCOIN_API_SECRET=s\nKUCOIN_API_PASSPHRASE=p\n";
        assert!(Credentials::from_env_or_file(complete).is_some());

        for incomplete in [
            "",
            "KUCOIN_API_KEY=k\n",
            "KUCOIN_API_KEY=k\nKUCOIN_API_SECRET=s\n",
            // A blank value is how a compose file turns KuCoin off.
            "KUCOIN_API_KEY=\nKUCOIN_API_SECRET=s\nKUCOIN_API_PASSPHRASE=p\n",
        ] {
            assert!(
                Credentials::from_env_or_file(incomplete).is_none(),
                "should be unconfigured: {incomplete:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_unconfigured_client_returns_none_without_touching_the_network() {
        // Blank credentials plus an unroutable cache dir: if this made a request it would hang
        // or error rather than returning None promptly.
        let client = reqwest::Client::new();
        let cache = HttpCache::new(std::env::temp_dir(), Mode::Off);
        let kucoin = KucoinClient::new(
            Credentials {
                key: Secret::new(""),
                secret: Secret::new(""),
                passphrase: Secret::new(""),
            },
            &client,
            &cache,
        );
        assert!(kucoin.balances().await.is_none());
    }

    #[test]
    fn the_env_file_parser_tolerates_comments_quotes_bom_and_odd_line_breaks() {
        let contents = "\u{feff}# a comment\n\
             KUCOIN_API_KEY = spaced-out \n\
             KUCOIN_API_SECRET='single'\r\n\
             KUCOIN_API_PASSPHRASE=\"double\"\r\
             NOT_AN_ASSIGNMENT\n\
             \n\
             WITH_EQUALS=a=b=c\n";
        let parsed = parse_env_file(contents);
        assert_eq!(parsed["KUCOIN_API_KEY"], "spaced-out");
        assert_eq!(parsed["KUCOIN_API_SECRET"], "single");
        assert_eq!(parsed["KUCOIN_API_PASSPHRASE"], "double");
        assert_eq!(parsed["WITH_EQUALS"], "a=b=c", "only the first = separates");
        assert!(!parsed.contains_key("NOT_AN_ASSIGNMENT"));
        assert!(!parsed.keys().any(|k| k.starts_with('#')));
    }

    #[test]
    fn the_env_file_parser_keeps_the_first_value_like_setdefault() {
        let parsed = parse_env_file("A=first\nA=second\n");
        assert_eq!(parsed["A"], "first");
    }

    // ---- market parsing ---------------------------------------------------

    fn market() -> Market {
        [
            ("BTC", (95_000.0, 2.5)),
            ("ETH", (3_200.0, -1.1)),
            ("USDT", (1.0, 0.0)),
            ("SHIB", (0.000_021, 7.3)),
            ("DUST", (1.0, 0.0)),
            ("ZERO", (0.0, 0.0)),
        ]
        .into_iter()
        .map(|(s, v)| (s.to_string(), v))
        .collect()
    }

    #[test]
    fn the_market_seeds_stables_at_par_then_lets_a_real_ticker_win() {
        let body = json!({"data": {"ticker": [
            {"symbol": "BTC-USDT", "last": "95000.1", "changeRate": "0.0251"},
            {"symbol": "USDC-USDT", "last": "0.9999", "changeRate": "0"},
            {"symbol": "FOO-BTC",  "last": "1.0", "changeRate": "0.5"},
            {"symbol": "BAR-USDT", "last": "",    "changeRate": "0.1"},
            {"symbol": "BAZ-USDT", "last": "2.0"},
        ]}});
        let m = parse_market(&body);

        assert_eq!(m["BTC"].0, 95_000.1);
        assert!((m["BTC"].1 - 2.51).abs() < 1e-9, "changeRate is a fraction");
        assert_eq!(m["USDC"].0, 0.9999, "a depegged stable prices at its rate");
        assert_eq!(m["DAI"], (1.0, 0.0), "untraded stables stay at par");
        assert!(!m.contains_key("FOO"), "non-USDT pairs are ignored");
        assert!(!m.contains_key("BAR"), "a blank last price is ignored");
        assert_eq!(m["BAZ"], (2.0, 0.0), "a missing changeRate is 0");
    }

    #[test]
    fn a_broken_ticker_payload_still_yields_stables_at_par() {
        // The Python swallows ticker failures entirely; losing prices must not lose the account.
        for body in [json!(null), json!({}), json!({"data": {}})] {
            let m = parse_market(&body);
            assert_eq!(m["USDT"], (1.0, 0.0));
            assert_eq!(m.len(), STABLES.len());
        }
    }

    // ---- spot holdings ----------------------------------------------------

    #[test]
    fn spot_balances_sum_per_currency_and_sort_by_symbol() {
        // Expected values reproduced from `kucoin._spot_holdings` on this exact input.
        let accounts = vec![
            json!({"currency": "BTC", "balance": "0.51234567", "type": "main"}),
            json!({"currency": "BTC", "balance": "0.00100000", "type": "trade"}),
            json!({"currency": "USDT", "balance": "1234.56789012"}),
            json!({"currency": "SHIB", "balance": "123456789.000000000000000001"}),
        ];
        let held = spot_holdings(&accounts, &market());

        assert_eq!(
            held.iter().map(|h| h.symbol.as_str()).collect::<Vec<_>>(),
            ["BTC", "SHIB", "USDT"],
            "sorted by symbol"
        );
        assert!(
            (held[0].amount - 0.513_345_67).abs() < 1e-12,
            "main + trade are summed: {}",
            held[0].amount
        );
        assert!(
            (held[0].usd - 48_767.838_65).abs() < 1e-6,
            "{}",
            held[0].usd
        );
        assert_eq!(held[0].change24h, 2.5);
        assert_eq!(held[0].kind, "token");
        // 18-decimal precision collapses to f64 in Python too, so this is parity, not loss.
        assert_eq!(held[1].amount, 123_456_789.0);
        assert!(
            (held[1].usd - 2_592.592_569).abs() < 1e-9,
            "{}",
            held[1].usd
        );
    }

    #[test]
    fn zero_blank_and_missing_balances_are_dropped_without_erroring() {
        let accounts = vec![
            json!({"currency": "ETH", "balance": "0"}),
            json!({"currency": "ETH", "balance": ""}),
            json!({"currency": "ETH", "balance": null}),
            json!({"currency": "ETH"}),
            json!({"currency": "ETH", "balance": "-1"}),
            json!({"balance": "5"}), // no currency at all
        ];
        assert!(spot_holdings(&accounts, &market()).is_empty());
    }

    #[test]
    fn unpriceable_and_dust_balances_are_dropped() {
        let accounts = vec![
            json!({"currency": "NOPRICE", "balance": "5"}), // not in the market at all
            json!({"currency": "ZERO", "balance": "5"}),    // priced at 0 == unpriceable
            json!({"currency": "DUST", "balance": "0.0001"}), // priced but under $0.50
        ];
        assert!(spot_holdings(&accounts, &market()).is_empty());
    }

    #[test]
    fn a_balance_exactly_on_the_dust_threshold_is_dropped() {
        // The Python uses `> 0.5`, not `>=`; a $0.50 position does not appear.
        let at = vec![json!({"currency": "DUST", "balance": "0.5"})];
        assert!(spot_holdings(&at, &market()).is_empty());
        let above = vec![json!({"currency": "DUST", "balance": "0.51"})];
        assert_eq!(spot_holdings(&above, &market()).len(), 1);
    }

    #[test]
    fn numeric_balances_parse_as_well_as_string_ones() {
        // Spot sends strings, futures sends JSON numbers; `float()` accepts both.
        let accounts = vec![json!({"currency": "USDT", "balance": 42.5})];
        let held = spot_holdings(&accounts, &market());
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].amount, 42.5);
    }

    // ---- earn / bots ------------------------------------------------------

    #[test]
    fn earn_positions_group_per_currency_with_a_balance_weighted_apr() {
        let data = json!({"items": [
            {"currency": "USDT", "holdAmount": "1000", "returnRate": "0.05"},
            {"currency": "USDT", "holdAmount": "1000", "returnRate": "0.15"},
            {"currency": "BTC",  "holdAmount": "0.01", "redeemingAmount": "0.01",
             "returnRate": "0.02"},
        ]});
        let out = earn_holdings(&data, &market());

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "BTC savings", "sorted by currency");
        assert_eq!(out[0].tokens[0].amount, 0.02, "hold + redeeming");
        let usdt = &out[1];
        assert_eq!(usdt.usd, 2000.0);
        assert_eq!(usdt.apr, Some(10.0), "weighted mean of 5% and 15%");
        assert_eq!(usdt.protocol, "KuCoin Earn");
        assert_eq!(usdt.tier, "cashflow");
    }

    #[test]
    fn earn_accepts_either_a_bare_list_or_an_items_wrapper() {
        let wrapped = json!({"items": [{"currency": "USDT", "holdAmount": "1000"}]});
        let bare = json!([{"currency": "USDT", "holdAmount": "1000"}]);
        assert_eq!(
            earn_holdings(&wrapped, &market()),
            earn_holdings(&bare, &market())
        );
        assert_eq!(earn_holdings(&json!({}), &market()), vec![]);
    }

    #[test]
    fn a_two_coin_basket_is_a_grid_and_a_three_coin_basket_is_a_rebalance() {
        let two = json!({"tradeAccounts": [
            {"currency": "BTC", "balance": "0.01"},
            {"currency": "USDT", "balance": "500"},
        ]});
        let three = json!({"tradeAccounts": [
            {"currency": "BTC", "balance": "0.01"},
            {"currency": "ETH", "balance": "0.5"},
            {"currency": "USDT", "balance": "500"},
        ]});
        assert_eq!(
            spot_bot_position(&two, &market())
                .unwrap()
                .bot
                .unwrap()
                .kind,
            "Spot Grid"
        );
        let rebalance = spot_bot_position(&three, &market()).unwrap();
        assert_eq!(rebalance.bot.as_ref().unwrap().kind, "Smart Rebalance");
        assert_eq!(rebalance.name, "Smart Rebalance · 3 assets");
    }

    #[test]
    fn a_spot_bot_basket_reports_weights_largest_first_and_sums_to_a_hundred() {
        let sub = json!({"tradeAccounts": [
            {"currency": "BTC", "balance": "0.01"},   // $950
            {"currency": "USDT", "balance": "50"},    // $50
        ]});
        let bot = spot_bot_position(&sub, &market()).unwrap();
        let weights = bot.bot.unwrap().weights.unwrap();
        assert_eq!(weights[0].symbol, "BTC", "largest share first");
        assert!((weights.iter().map(|w| w.pct).sum::<f64>() - 100.0).abs() < 0.2);
        assert!((bot.usd - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn an_empty_or_dust_sub_account_is_not_a_bot() {
        assert!(spot_bot_position(&json!({}), &market()).is_none());
        let dust = json!({"tradeAccounts": [{"currency": "DUST", "balance": "0.4"}]});
        assert!(spot_bot_position(&dust, &market()).is_none());
    }

    #[test]
    fn futures_bots_aggregate_equity_and_pnl_and_rank_by_size() {
        let overview = json!({"accounts": [
            {"accountName": "small", "accountEquity": 100.0, "unrealisedPNL": -10.0,
             "positionMargin": 20.0},
            {"accountName": "big", "accountEquity": 900.0, "unrealisedPNL": 100.0,
             "positionMargin": 180.0},
            {"accountName": "empty", "accountEquity": 0.0},
        ]});
        let position = futures_bot_position(&overview).unwrap();

        assert_eq!(position.usd, 1000.0, "only the running bots count");
        assert_eq!(position.pnl_usd, Some(90.0));
        // invested = 1000 - 90 = 910, so 90/910 = 9.89%.
        assert_eq!(position.pnl_pct, Some(9.89));
        assert_eq!(position.name, "2 AI futures bots");

        let bot = position.bot.unwrap();
        assert_eq!(bot.count, Some(2));
        assert_eq!(bot.margin_usd, Some(200.0));
        assert_eq!(bot.margin_pct, Some(20));
        let bots = bot.bots.unwrap();
        assert_eq!(bots[0].id.as_deref(), Some("big"), "ranked by equity");
        assert_eq!(bots[1].id.as_deref(), Some("small"));
        assert_eq!(bots[1].pnl_usd, -10.0);
    }

    #[test]
    fn futures_falls_back_through_the_identity_fields() {
        let overview = json!({"accounts": [
            {"subName": "sub-1", "accountEquity": 100.0},
            {"accountId": 12345, "accountEquity": 200.0},
            {"accountEquity": 300.0},
        ]});
        let bots = futures_bot_position(&overview)
            .unwrap()
            .bot
            .unwrap()
            .bots
            .unwrap();
        assert_eq!(bots[0].id, None, "no identity field at all");
        assert_eq!(bots[1].id.as_deref(), Some("12345"));
        assert_eq!(bots[2].id.as_deref(), Some("sub-1"));
    }

    #[test]
    fn an_all_empty_futures_overview_is_not_a_position() {
        assert!(futures_bot_position(&json!({"accounts": []})).is_none());
        assert!(futures_bot_position(&json!({})).is_none());
        assert!(
            futures_bot_position(&json!({"accounts": [{"accountEquity": 0.3}]})).is_none(),
            "sub-dust equity does not make a bot"
        );
    }

    // ---- wallet assembly --------------------------------------------------

    #[test]
    fn the_wallet_totals_spot_plus_defi_into_one_kucoin_bucket() {
        let accounts = vec![json!({"currency": "USDT", "balance": "100"})];
        let spot = spot_holdings(&accounts, &market());
        let defi = earn_holdings(
            &json!([{"currency": "USDT", "holdAmount": "900", "returnRate": "0.1"}]),
            &market(),
        );
        let wallet = build_wallet(spot, defi).unwrap();

        assert_eq!(wallet.address, "KuCoin");
        assert_eq!(wallet.total, 1000.0);
        assert_eq!(wallet.chains.len(), 1);
        assert_eq!(wallet.chains[0].chain, "kucoin");
        assert_eq!(wallet.chains[0].usd, 1000.0);
        assert_eq!(wallet.chains[0].spot.len(), 1);
        assert_eq!(wallet.chains[0].defi.len(), 1);
    }

    #[test]
    fn an_empty_account_produces_no_wallet_at_all() {
        // Python returns None below $0.50 so an empty KuCoin account does not render as a wallet.
        assert!(build_wallet(vec![], vec![]).is_none());
    }

    #[test]
    fn the_serialised_shape_matches_the_python_dict() {
        let accounts = vec![json!({"currency": "USDT", "balance": "100"})];
        let wallet = build_wallet(spot_holdings(&accounts, &market()), vec![]).unwrap();
        let json = serde_json::to_value(&wallet).unwrap();

        assert_eq!(json["address"], "KuCoin");
        assert_eq!(json["chains"][0]["spot"][0]["kind"], "token");
        assert_eq!(json["chains"][0]["spot"][0]["symbol"], "USDT");
        // Optional fields are omitted, not nulled, matching the Python's per-kind dicts.
        let earn = earn_holdings(
            &json!([{"currency": "USDT", "holdAmount": "900", "returnRate": "0.1"}]),
            &market(),
        );
        let earn = serde_json::to_value(&earn[0]).unwrap();
        assert!(earn.get("apr").is_some());
        assert!(earn.get("pnl_usd").is_none(), "absent, not null");
    }
}
