//! Market context and crypto sentiment — port of `portfolio.py:2164-2356`.
//!
//! Everything the Sentiment page shows: FX rates, a Thai mutual-fund NAV, the BTC rainbow band,
//! and the MVRV-Z / SOPR / Puell on-chain oscillators.
//!
//! **The maths is deliberately separated from the fetching.** [`btc_rainbow_at`] and [`zoned`] are
//! pure — a number in, a band or zone out — which is what lets the parity harness compare them
//! against the Python oracle exhaustively offline, including one ULP either side of every
//! boundary. The networked half ([`Market`]) does nothing but fetch and hand numbers to them, and
//! goes through [`crate::http_cache`] so tests replay recorded bytes instead of hitting upstream.
//!
//! Two places the Rust deliberately does *not* reproduce the Python (both are Python bugs; see the
//! doc comments on [`zoned`] and [`btc_rainbow_at`]):
//!
//! * a value at or above the top zone bound makes Python raise `StopIteration`; here it is `None`.
//! * `days == 0` makes Python raise `ValueError` from `log(0)`; here it is `None`.

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};

use crate::http_cache::HttpCache;

// ---------------------------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------------------------

/// Python's `round(value, dp)`.
///
/// Not `(value * 10^dp).round() / 10^dp`. That rounds halves *away from zero*, whereas Python
/// rounds the exact decimal value of the double half-to-**even**, and the difference is visible in
/// real output: `round(0.0625, 3)` is `0.062` in Python but `0.063` the naive way, and the UI
/// prints whatever we return. Rust's float formatter uses the same exact-decimal, half-to-even
/// rule, so formatting and re-parsing reproduces Python bit for bit.
fn round_py(value: f64, dp: usize) -> f64 {
    if !value.is_finite() {
        return value;
    }
    format!("{value:.dp$}").parse().unwrap_or(value)
}

/// Python's zero-argument `round(value)`, which yields an `int`.
///
/// Saturates rather than wrapping on absurd inputs — an `as` cast on an out-of-range float is a
/// silent clamp in Rust, and being explicit documents that we know.
fn round_py_int(value: f64) -> i64 {
    if !value.is_finite() {
        return 0;
    }
    let rounded: f64 = round_py(value, 0);
    if rounded >= i64::MAX as f64 {
        i64::MAX
    } else if rounded <= i64::MIN as f64 {
        i64::MIN
    } else {
        rounded as i64
    }
}

// ---------------------------------------------------------------------------------------------
// BTC rainbow chart (pure)
// ---------------------------------------------------------------------------------------------

/// Days from the Unix epoch to the Bitcoin genesis block, 2009-01-09.
const GENESIS_EPOCH_DAY: i64 = 14253;

/// Log-regression constants from the widely-used blockchaincenter rainbow model.
///
/// Kept as the exact literals from the Python: the fair value is `10^(SLOPE·ln(days) - INTERCEPT)`
/// and a rounded constant would shift every band edge. Sanity-checked against history — the 2017
/// peak lands near 4.8×, 2021 near 1.8×, the 2018/2022 bottoms near 0.4×/0.26×.
const RAINBOW_SLOPE: f64 = 2.661_671_550_059_61;
const RAINBOW_INTERCEPT: f64 = 17.918_376_188_986_4;

/// One rainbow band: the lowest price/fair-value ratio that belongs to it, and how the UI paints it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RainbowBand {
    pub min_ratio: f64,
    pub label: &'static str,
    pub color: &'static str,
}

/// Bands from the top down; the first whose `min_ratio` the ratio reaches wins, so the ordering is
/// load-bearing and must stay descending.
#[rustfmt::skip]
pub const RAINBOW_BANDS: [RainbowBand; 8] = [
    RainbowBand { min_ratio: 3.0, label: "Maximum bubble territory", color: "#c0392b" },
    RainbowBand { min_ratio: 2.2, label: "Sell. Seriously, SELL!", color: "#e74c3c" },
    RainbowBand { min_ratio: 1.5, label: "FOMO intensifies", color: "#e67e22" },
    RainbowBand { min_ratio: 1.1, label: "Is this a bubble?", color: "#e0b30b" },
    RainbowBand { min_ratio: 0.8, label: "HODL!", color: "#9acd32" },
    RainbowBand { min_ratio: 0.55, label: "Still cheap", color: "#27ae60" },
    RainbowBand { min_ratio: 0.35, label: "Accumulate", color: "#2980b9" },
    RainbowBand { min_ratio: 0.0, label: "Basically a fire sale", color: "#5b4bbf" },
];

/// Where BTC sits on the rainbow, in the shape the UI consumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rainbow {
    pub label: String,
    pub color: String,
    /// Price ÷ model fair value, rounded to 3dp.
    pub ratio: f64,
    /// Model fair value in USD, rounded to a whole dollar.
    pub fair_usd: i64,
}

/// Model fair value in USD after `days` of Bitcoin's life.
///
/// `days == 0` has no answer (`ln(0)` is `-inf`); the caller decides what to do about it.
pub fn rainbow_fair_value_usd(days: u32) -> Option<f64> {
    if days == 0 {
        return None;
    }
    Some(10f64.powf(RAINBOW_SLOPE * f64::from(days).ln() - RAINBOW_INTERCEPT))
}

/// The band a price/fair-value ratio belongs to.
///
/// Edges are **inclusive from below**: at exactly 3.0× fair value you are already in "Maximum
/// bubble territory", not the band beneath it. This is the opposite convention to [`zoned`]'s, and
/// getting it backwards is the classic rewrite bug, so it is pinned here and in the corpus.
///
/// `None` for a negative or NaN ratio, which meets no threshold — Python's loop falls off the end
/// the same way and returns `None` too.
pub fn rainbow_band_for_ratio(ratio: f64) -> Option<&'static RainbowBand> {
    RAINBOW_BANDS.iter().find(|b| ratio >= b.min_ratio)
}

/// Which rainbow band a BTC price falls in, `days` into Bitcoin's life.
///
/// `None` when there is no meaningful answer — a zero or absent price (Python's `if not price`), a
/// price whose ratio meets no band, or `days == 0` (where Python raises `ValueError` from `log(0)`).
pub fn btc_rainbow_at(price: Option<f64>, days: u32) -> Option<Rainbow> {
    let price = price?;
    if price == 0.0 {
        return None;
    }
    let fair = rainbow_fair_value_usd(days)?;
    let ratio = price / fair;
    let band = rainbow_band_for_ratio(ratio)?;
    Some(Rainbow {
        label: band.label.to_string(),
        color: band.color.to_string(),
        ratio: round_py(ratio, 3),
        fair_usd: round_py_int(fair),
    })
}

/// Whole days from the genesis block to now, in UTC.
///
/// The Python reads `date.today()`, which is *local*; for a machine east of UTC this can read one
/// day lower for part of the day. The difference moves fair value by ~0.04% at today's day count —
/// far below the width of any band — and UTC is the reproducible choice for a server.
pub fn days_since_genesis() -> u32 {
    let epoch_day = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| (d.as_secs() / 86_400) as i64)
        .unwrap_or(GENESIS_EPOCH_DAY);
    u32::try_from(epoch_day - GENESIS_EPOCH_DAY).unwrap_or(0)
}

/// [`btc_rainbow_at`] against today's date.
pub fn btc_rainbow(price: Option<f64>) -> Option<Rainbow> {
    btc_rainbow_at(price, days_since_genesis())
}

// ---------------------------------------------------------------------------------------------
// Zoned on-chain oscillators (pure)
// ---------------------------------------------------------------------------------------------

/// The sentinel upper bound on every zone table's last entry, standing in for "no ceiling".
///
/// Kept rather than replaced with [`f64::INFINITY`] because it is what the Python compares
/// against, and a real metric reading that somehow exceeded it must classify identically on both
/// sides.
pub const ZONE_TOP: f64 = 1e9;

/// One zone: everything strictly below `upper` that no earlier zone claimed.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Zone {
    pub upper: f64,
    pub label: &'static str,
    pub color: &'static str,
}

/// MVRV Z-Score — market value vs realized value, standard-deviation normalized. Low is undervalued.
#[rustfmt::skip]
pub const MVRV_ZONES: [Zone; 4] = [
    Zone { upper: 2.0, label: "Undervalued", color: "#2bb3a3" },
    Zone { upper: 4.0, label: "Fair value", color: "#e0b30b" },
    Zone { upper: 6.0, label: "Overvalued", color: "#e0883c" },
    Zone { upper: ZONE_TOP, label: "Euphoria / cycle top", color: "#e0564b" },
];

/// SOPR — realized profit/loss of spent coins, pivoting around 1.0. Below 1 means coins are being
/// sold at a loss, which is what capitulation looks like on-chain.
#[rustfmt::skip]
pub const SOPR_ZONES: [Zone; 3] = [
    Zone { upper: 0.99, label: "Capitulation / losses", color: "#2bb3a3" },
    Zone { upper: 1.01, label: "Breakeven", color: "#e0b30b" },
    Zone { upper: ZONE_TOP, label: "Profit-taking", color: "#e0883c" },
];

/// Puell Multiple — miner revenue against its own 1-year average. Miner capitulation marks bottoms.
#[rustfmt::skip]
pub const PUELL_ZONES: [Zone; 4] = [
    Zone { upper: 0.5, label: "Miner capitulation", color: "#2bb3a3" },
    Zone { upper: 1.0, label: "Undervalued", color: "#48a85b" },
    Zone { upper: 4.0, label: "Normal", color: "#e0b30b" },
    Zone { upper: ZONE_TOP, label: "Overheated / top", color: "#e0564b" },
];

/// Decimal places each metric is published to, matching what the Python rounds to.
const MVRV_DP: usize = 2;
const SOPR_DP: usize = 3;
const PUELL_DP: usize = 2;

/// A metric reading placed in its zone, in the shape the UI consumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Zoned {
    pub value: f64,
    pub label: String,
    pub color: String,
}

/// Place `value` in the first zone it falls below, rounding it to `dp` for display.
///
/// Zone edges are **exclusive from below**: an MVRV Z-Score of exactly 2.0 is *not* "Undervalued",
/// it is "Fair value". This is the opposite convention to the rainbow's `>=` bands, which is
/// exactly the kind of asymmetry a rewrite flattens by accident, so both are pinned by the corpus.
///
/// `None` when the metric is missing, and also when `value` is at or above the top zone's bound
/// (or is NaN, which compares false against everything). **The Python raises `StopIteration`
/// there** — `next()` with no default, off the end of the generator — which would escape
/// `btc_mvrv_zscore` and blow up the whole sentiment response. Returning `None` degrades to a
/// blank tile instead, which is what the UI already renders for a metric it could not fetch.
pub fn zoned(value: Option<f64>, zones: &[Zone], dp: usize) -> Option<Zoned> {
    let value = value?;
    let zone = zones.iter().find(|z| value < z.upper)?;
    Some(Zoned {
        value: round_py(value, dp),
        label: zone.label.to_string(),
        color: zone.color.to_string(),
    })
}

// ---------------------------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------------------------

/// Crypto Fear & Greed index from alternative.me.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FearGreed {
    /// 0 (extreme fear) to 100 (extreme greed).
    pub value: i64,
    pub classification: String,
}

/// USD-denominated FX and the BTC spot price, as the portfolio totals need them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rates {
    /// Always 1.0 — the base the rest of the portfolio is denominated in.
    pub usd: f64,
    /// USD to THB. `None` when both the primary and fallback FX sources are down; the UI then
    /// hides the THB column rather than showing a stale or invented rate.
    pub thb: Option<f64>,
    pub btc_usd: Option<f64>,
}

/// Latest published NAV for a Thai mutual fund.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThaiFundNav {
    pub code: String,
    /// THB per unit, rounded to 4dp as published.
    pub nav: f64,
    /// `YYYY-MM-DD`, or `None` if the upstream date was not the expected 8-digit form.
    pub nav_date: Option<String>,
    /// Percent change against the prior publication. `None` when the prior NAV was zero.
    pub change_pct: Option<f64>,
    pub currency: String,
}

/// The full sentiment bundle. Field names are the JSON contract the Sentiment page reads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sentiment {
    pub fear_greed: Option<FearGreed>,
    pub btc_rainbow: Option<Rainbow>,
    pub mvrv_zscore: Option<Zoned>,
    pub sopr: Option<Zoned>,
    pub puell: Option<Zoned>,
    /// Unix seconds, set only by [`Market::market_sentiment`] — the standalone page shows it, the
    /// embedded-in-portfolio call does not carry it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<f64>,
}

// ---------------------------------------------------------------------------------------------
// bitcoin-data.com metric extraction
// ---------------------------------------------------------------------------------------------

/// Response keys that are metadata rather than the metric itself.
const BTC_DATA_META_KEYS: [&str; 5] = ["d", "unixTs", "theLastUpdated", "timestamp", "date"];

/// The first non-metadata number in a bitcoin-data.com response, **in document order**.
///
/// The API answers `{"d": ..., "unixTs": ..., "<metric>": value}` with a different metric key per
/// endpoint, so the Python reads it field-agnostically: take the first numeric value whose key is
/// not metadata. Reproducing "first" is why this is a hand-written visitor — `serde_json::Value`
/// stores objects in a `BTreeMap` by default, which would silently re-order the keys alphabetically
/// and pick a different field on any response that carried two numbers.
///
/// One knowing divergence: Python's `isinstance(x, (int, float))` is also true for `True`/`False`,
/// so a JSON boolean would be read as 1/0 there and skipped here. No endpoint returns one.
struct FirstMetric(Option<f64>);

impl<'de> Deserialize<'de> for FirstMetric {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct V;

        impl<'de> Visitor<'de> for V {
            type Value = FirstMetric;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a bitcoin-data.com metric object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<FirstMetric, M::Error> {
                let mut found = None;
                let mut errored = false;
                while let Some(key) = map.next_key::<String>()? {
                    let value: serde_json::Value = map.next_value()?;
                    // An `error` key anywhere means the whole response is a failure — rate limits
                    // come back as 200s with an error body, and treating that as "no data" is what
                    // keeps the last good reading on screen.
                    if key == "error" {
                        errored = true;
                    }
                    if found.is_none()
                        && !BTC_DATA_META_KEYS.contains(&key.as_str())
                        && let Some(n) = as_number(&value)
                    {
                        found = Some(n);
                    }
                }
                Ok(FirstMetric(if errored { None } else { found }))
            }
        }

        deserializer.deserialize_map(V)
    }
}

/// A JSON number, whether it arrived bare or quoted — bitcoin-data.com quotes some metrics.
fn as_number(value: &serde_json::Value) -> Option<f64> {
    match value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// Metric cache staleness (pure)
// ---------------------------------------------------------------------------------------------

/// How long a good bitcoin-data.com reading is served for: ~1 request/hour/metric.
pub const METRIC_SUCCESS_TTL: Duration = Duration::from_secs(3600);
/// How long to back off after a failure before retrying that metric.
pub const METRIC_FAILURE_BACKOFF: Duration = Duration::from_secs(1800);

/// Whether a cached metric reading may still be served without re-fetching.
///
/// bitcoin-data.com allows a hard 10 requests/hour/IP across *all* metrics. A short failure TTL
/// would have each of the four metrics retry ~4×/hour, so a single 429 would exhaust the budget and
/// blank the whole panel permanently. Hence the asymmetry: an hour on success, but still half an
/// hour of quiet after a failure — during which the last good value keeps being served, because
/// these move daily and stale beats blank.
pub fn metric_reading_is_fresh(age: Duration, last_fetch_succeeded: bool) -> bool {
    age < if last_fetch_succeeded {
        METRIC_SUCCESS_TTL
    } else {
        METRIC_FAILURE_BACKOFF
    }
}

#[derive(Debug, Clone, Copy)]
struct MetricEntry {
    fetched: Instant,
    value: Option<f64>,
    ok: bool,
}

// ---------------------------------------------------------------------------------------------
// The networked half
// ---------------------------------------------------------------------------------------------

const LLAMA_PRICES: &str = "https://coins.llama.fi/prices/current";
const FRANKFURTER: &str = "https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB";
const CURRENCY_API: &str =
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json";
const FEAR_GREED: &str = "https://api.alternative.me/fng/";
const BTC_DATA: &str = "https://bitcoin-data.com/v1";
const WEALTHMAGIK: &str = "https://restapi.wealthmagik.com/fundinfo";

/// The fixed public client id WealthMagik's own web app ships. Their fund API is unauthenticated
/// but rejects requests without it.
const WM_CLIENT_ID: &str = "0324E43A029B34CDC026148C8EF5492FC9290765E7497EDD40B30B0611AAF00B";

/// Market-data fetching: every upstream call goes through [`HttpCache`], never `reqwest` directly,
/// so tests replay recorded bytes and CI never touches the network.
#[derive(Debug)]
pub struct Market {
    client: reqwest::Client,
    cache: HttpCache,
    metrics: Mutex<HashMap<String, MetricEntry>>,
}

impl Market {
    pub fn new(client: reqwest::Client, cache: HttpCache) -> Self {
        Self {
            client,
            cache,
            metrics: Mutex::new(HashMap::new()),
        }
    }

    /// A GET whose body is parsed as JSON, or `None` on any failure.
    ///
    /// Every upstream here is optional garnish on the portfolio: the Python wraps each in a bare
    /// `except`, and a market panel that fails must never take the balances down with it.
    async fn get_json(&self, url: &str) -> Option<serde_json::Value> {
        let recorded = self.cache.get(&self.client, url).await.ok()?;
        serde_json::from_str(&recorded.body).ok()
    }

    /// DefiLlama spot price for a raw key such as `coingecko:bitcoin`.
    pub async fn llama_key_price(&self, key: &str) -> Option<f64> {
        if key.is_empty() {
            return None;
        }
        let json = self.get_json(&format!("{LLAMA_PRICES}/{key}")).await?;
        json.get("coins")?.get(key)?.get("price")?.as_f64()
    }

    /// USD→THB plus the BTC spot price.
    ///
    /// Two FX sources because the primary has moved host before (`frankfurter.app` now 301s to
    /// `.dev`) and a dead FX feed would otherwise blank every THB figure on the page.
    pub async fn get_rates(&self) -> Rates {
        let mut thb = self
            .get_json(FRANKFURTER)
            .await
            .and_then(|j| j.get("rates")?.get("THB")?.as_f64());
        // `0.0` is as useless as absent, and Python's `if not thb` treats it that way.
        if thb.is_none_or(|v| v == 0.0) {
            thb = self
                .get_json(CURRENCY_API)
                .await
                .and_then(|j| j.get("usd")?.get("thb")?.as_f64());
        }
        Rates {
            usd: 1.0,
            thb: thb.filter(|v| *v != 0.0),
            btc_usd: self.llama_key_price("coingecko:bitcoin").await,
        }
    }

    /// Crypto Fear & Greed index.
    pub async fn fear_greed(&self) -> Option<FearGreed> {
        let json = self.get_json(FEAR_GREED).await?;
        let entry = json.get("data")?.get(0)?;
        // The index arrives as a quoted string, e.g. `{"value": "64"}`.
        let value = as_number(entry.get("value")?)? as i64;
        Some(FearGreed {
            value,
            classification: entry.get("value_classification")?.as_str()?.to_string(),
        })
    }

    /// One BTC on-chain metric, cached per [`metric_reading_is_fresh`].
    pub async fn btc_data(&self, metric: &str) -> Option<f64> {
        {
            let cached = self.metrics.lock().ok()?;
            if let Some(entry) = cached.get(metric)
                && metric_reading_is_fresh(entry.fetched.elapsed(), entry.ok)
            {
                return entry.value;
            }
        }

        // Parsed straight from the response text, never via `serde_json::Value` — a `Value` object
        // is a `BTreeMap`, so round-tripping through one would re-sort the keys and destroy the
        // document order `FirstMetric` depends on.
        let fetched = self
            .cache
            .get(&self.client, &format!("{BTC_DATA}/{metric}/last"))
            .await
            .ok()
            .and_then(|r| serde_json::from_str::<FirstMetric>(&r.body).ok())
            .and_then(|m| m.0);

        let mut cached = self.metrics.lock().ok()?;
        // On failure keep serving the last good reading rather than falling back to a blank; these
        // metrics update roughly daily, so a stale number is far more useful than an empty tile.
        let value = fetched.or_else(|| cached.get(metric).and_then(|e| e.value));
        cached.insert(
            metric.to_string(),
            MetricEntry {
                fetched: Instant::now(),
                value,
                ok: fetched.is_some(),
            },
        );
        value
    }

    pub async fn btc_mvrv_zscore(&self) -> Option<Zoned> {
        zoned(self.btc_data("mvrv-zscore").await, &MVRV_ZONES, MVRV_DP)
    }

    pub async fn btc_sopr(&self) -> Option<Zoned> {
        zoned(self.btc_data("sopr").await, &SOPR_ZONES, SOPR_DP)
    }

    pub async fn btc_puell(&self) -> Option<Zoned> {
        zoned(
            self.btc_data("puell-multiple").await,
            &PUELL_ZONES,
            PUELL_DP,
        )
    }

    /// The sentiment bundle for a BTC price the caller already has.
    ///
    /// Stock-to-Flow was dropped from the UI to buy back one call against the 10 req/hr limit.
    pub async fn get_sentiment(&self, btc_usd: Option<f64>) -> Sentiment {
        Sentiment {
            fear_greed: self.fear_greed().await,
            btc_rainbow: btc_rainbow(btc_usd),
            mvrv_zscore: self.btc_mvrv_zscore().await,
            sopr: self.btc_sopr().await,
            puell: self.btc_puell().await,
            fetched_at: None,
        }
    }

    /// Standalone sentiment for the Sentiment page, which has no wallet to take a BTC price from.
    pub async fn market_sentiment(&self) -> Sentiment {
        let btc = self.llama_key_price("coingecko:bitcoin").await;
        let mut sentiment = self.get_sentiment(btc).await;
        sentiment.fetched_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs_f64());
        sentiment
    }

    /// Latest NAV for a Thai mutual fund by code, e.g. `K-GOLD-A(D)`.
    ///
    /// Two unauthenticated hops — code to security id, then id to fund info. NAV is published once
    /// a day in THB per unit.
    pub async fn thai_fund_nav(&self, code: &str) -> Option<ThaiFundNav> {
        let code = code.trim().to_uppercase();
        if code.is_empty() {
            return None;
        }

        let sid = self
            .get_json(&format!(
                "{WEALTHMAGIK}/GetSecurityIDByFundCode?fundCode={code}"
            ))
            .await?;
        // The id comes back bare, sometimes quoted; both must parse the same as Python's `int()`.
        let sid = as_number(&sid)? as i64;

        let info = self
            .get_json(&format!("{WEALTHMAGIK}/GetFundInfo?securityID={sid}"))
            .await?;
        // Newer responses wrap the payload in `ResultObj`; older ones are flat.
        let root = info.get("ResultObj").unwrap_or(&info);
        let history = root.get("returnHistory")?;

        let nav = history.get("NAV").and_then(as_number)?;
        if nav == 0.0 {
            return None;
        }
        let change = history.get("NAVChg").and_then(as_number).unwrap_or(0.0);
        let prev = nav - change;
        let raw_date = history
            .get("NAVDate")
            .and_then(|d| d.as_str().map(str::to_string))
            .unwrap_or_default();

        Some(ThaiFundNav {
            code,
            nav: round_py(nav, 4),
            nav_date: format_nav_date(&raw_date),
            change_pct: (prev != 0.0).then(|| round_py(change / prev * 100.0, 2)),
            currency: "THB".to_string(),
        })
    }
}

/// A reqwest client carrying the headers both WealthMagik and the Python's `SESSION` require.
///
/// Custom headers have to live on the client rather than the request, because [`HttpCache`] owns
/// request construction — which is the right trade: it keeps every call recordable.
pub fn wealthmagik_client() -> Result<reqwest::Client> {
    use reqwest::header::{HeaderMap, HeaderValue, ORIGIN, REFERER, USER_AGENT};

    let mut headers = HeaderMap::new();
    headers.insert("clientId", HeaderValue::from_static(WM_CLIENT_ID));
    headers.insert(
        ORIGIN,
        HeaderValue::from_static("https://www.wealthmagik.com"),
    );
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://www.wealthmagik.com/"),
    );
    headers.insert(USER_AGENT, HeaderValue::from_static("portfolio-script"));
    Ok(reqwest::Client::builder()
        .default_headers(headers)
        .build()?)
}

/// WealthMagik's `YYYYMMDD` to ISO `YYYY-MM-DD`; anything else is no date at all.
fn format_nav_date(raw: &str) -> Option<String> {
    (raw.len() == 8 && raw.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("{}-{}-{}", &raw[0..4], &raw[4..6], &raw[6..8]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounding_follows_pythons_half_to_even_rule() {
        // The naive `(x * 100.0).round() / 100.0` gives 0.13 and 0.063 here, and the UI would
        // print a different number to the Python's.
        assert_eq!(round_py(0.125, 2), 0.12);
        assert_eq!(round_py(0.375, 2), 0.38);
        assert_eq!(round_py(0.0625, 3), 0.062);
        // These two are not halves at all — the nearest double sits just below — so they round down.
        assert_eq!(round_py(2.675, 2), 2.67);
        assert_eq!(round_py(1.005, 2), 1.0);
        assert_eq!(round_py_int(2.5), 2);
        assert_eq!(round_py_int(3.5), 4);
        assert_eq!(round_py_int(0.5), 0);
    }

    #[test]
    fn a_rainbow_band_edge_belongs_to_the_band_above_it() {
        for (i, band) in RAINBOW_BANDS.iter().enumerate() {
            let at_edge = rainbow_band_for_ratio(band.min_ratio).unwrap();
            assert_eq!(
                at_edge.label, band.label,
                "exactly {}x fair value should already be {:?}",
                band.min_ratio, band.label
            );
            // One ULP below must fall to the next band down — or off the table entirely for the
            // bottom band, whose edge is zero and below which nothing is classified.
            match RAINBOW_BANDS.get(i + 1) {
                Some(next) => assert_eq!(
                    rainbow_band_for_ratio(f64::from_bits(band.min_ratio.to_bits() - 1))
                        .unwrap()
                        .label,
                    next.label,
                    "one ULP below {} should be {:?}",
                    band.min_ratio,
                    next.label
                ),
                None => assert!(
                    rainbow_band_for_ratio(-f64::MIN_POSITIVE).is_none(),
                    "below the bottom band there is nothing"
                ),
            }
        }
    }

    #[test]
    fn a_price_set_from_a_band_edge_need_not_land_back_on_it() {
        // `price = ratio * fair` then `price / fair` is not an exact round trip in binary floating
        // point, so 0.8x fair value can classify as the band below. This is not a porting bug — the
        // Python does the identical two operations and lands identically — but it is why the edge
        // rule is asserted on ratios above rather than on prices.
        let days = 6000;
        let fair = rainbow_fair_value_usd(days).unwrap();
        let ratio = (0.8 * fair) / fair;
        assert!(
            ratio < 0.8,
            "the round trip is expected to undershoot here, got {ratio}"
        );
        assert_eq!(
            btc_rainbow_at(Some(0.8 * fair), days).unwrap().label,
            "Still cheap"
        );
    }

    #[test]
    fn a_price_without_a_band_is_reported_as_missing() {
        let days = 6000;
        assert_eq!(btc_rainbow_at(None, days), None, "no price");
        assert_eq!(
            btc_rainbow_at(Some(0.0), days),
            None,
            "Python's `not price`"
        );
        assert_eq!(
            btc_rainbow_at(Some(-1.0), days),
            None,
            "no band accepts a negative ratio"
        );
        assert_eq!(
            btc_rainbow_at(Some(f64::NAN), days),
            None,
            "NaN meets no threshold"
        );
        assert_eq!(
            btc_rainbow_at(Some(50_000.0), 0),
            None,
            "day zero has no fair value; Python raises ValueError from log(0)"
        );
    }

    #[test]
    fn the_fair_value_curve_rises_with_time() {
        let early = rainbow_fair_value_usd(1000).unwrap();
        let mid = rainbow_fair_value_usd(4000).unwrap();
        let late = rainbow_fair_value_usd(6000).unwrap();
        assert!(early < mid && mid < late, "{early} {mid} {late}");
    }

    #[test]
    fn a_zone_edge_belongs_to_the_zone_above_it() {
        // The mirror image of the rainbow's rule, and the reason both are pinned by the corpus.
        let at_two = zoned(Some(2.0), &MVRV_ZONES, MVRV_DP).unwrap();
        assert_eq!(at_two.label, "Fair value", "2.0 is not Undervalued");
        let just_below = zoned(
            Some(f64::from_bits(2.0f64.to_bits() - 1)),
            &MVRV_ZONES,
            MVRV_DP,
        )
        .unwrap();
        assert_eq!(just_below.label, "Undervalued", "one ULP below still is");
    }

    #[test]
    fn every_zone_table_classifies_its_own_midpoints() {
        for (zones, dp) in [
            (&MVRV_ZONES[..], MVRV_DP),
            (&SOPR_ZONES[..], SOPR_DP),
            (&PUELL_ZONES[..], PUELL_DP),
        ] {
            for (i, zone) in zones.iter().enumerate() {
                let lower = if i == 0 { -1.0 } else { zones[i - 1].upper };
                let probe = (lower + zone.upper.min(10.0)) / 2.0;
                let got = zoned(Some(probe), zones, dp).unwrap();
                assert_eq!(got.label, zone.label, "{probe} should be {:?}", zone.label);
            }
        }
    }

    #[test]
    fn a_metric_past_the_top_zone_is_missing_rather_than_a_panic() {
        // Python raises StopIteration here, which would escape and blank the whole response.
        assert_eq!(zoned(Some(ZONE_TOP), &MVRV_ZONES, MVRV_DP), None);
        assert_eq!(zoned(Some(f64::INFINITY), &SOPR_ZONES, SOPR_DP), None);
        assert_eq!(zoned(Some(f64::NAN), &PUELL_ZONES, PUELL_DP), None);
        assert_eq!(zoned(None, &MVRV_ZONES, MVRV_DP), None);
    }

    #[test]
    fn a_negative_zscore_is_undervalued_not_missing() {
        // MVRV Z genuinely goes negative at cycle bottoms; a rewrite that clamped at zero would
        // lose the most interesting reading on the page.
        let got = zoned(Some(-0.87), &MVRV_ZONES, MVRV_DP).unwrap();
        assert_eq!(got.label, "Undervalued");
        assert_eq!(got.value, -0.87);
    }

    #[test]
    fn the_metric_value_is_read_in_document_order_not_alphabetical() {
        // `unixTs` sorts before `sopr`, so a BTreeMap-backed parse would still work here, but
        // `alpha` sorts before `sopr` and would win. Document order must pick `sopr`.
        let json = r#"{"d":"2026-01-01","unixTs":"1767225600","sopr":1.0042,"alpha":9.9}"#;
        let parsed: FirstMetric = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.0, Some(1.0042));
    }

    #[test]
    fn metric_metadata_and_errors_never_masquerade_as_a_reading() {
        let meta_only = r#"{"d":"2026-01-01","unixTs":1767225600,"theLastUpdated":"x"}"#;
        assert_eq!(
            serde_json::from_str::<FirstMetric>(meta_only).unwrap().0,
            None
        );

        let rate_limited = r#"{"error":"too many requests","mvrv-zscore":2.5}"#;
        assert_eq!(
            serde_json::from_str::<FirstMetric>(rate_limited).unwrap().0,
            None,
            "a 200 with an error body is not data"
        );
    }

    #[test]
    fn a_quoted_metric_parses_like_a_bare_one() {
        let quoted = r#"{"d":"2026-01-01","mvrvZscore":"2.34"}"#;
        assert_eq!(
            serde_json::from_str::<FirstMetric>(quoted).unwrap().0,
            Some(2.34)
        );
    }

    #[test]
    fn a_fresh_reading_is_served_but_a_stale_one_is_refetched() {
        assert!(metric_reading_is_fresh(Duration::from_secs(0), true));
        assert!(metric_reading_is_fresh(Duration::from_secs(3599), true));
        assert!(!metric_reading_is_fresh(METRIC_SUCCESS_TTL, true));
    }

    #[test]
    fn a_failure_backs_off_for_less_time_than_a_success_is_cached() {
        // Long enough that four metrics cannot burn the 10 req/hr budget, short enough to recover.
        assert!(metric_reading_is_fresh(Duration::from_secs(1799), false));
        assert!(!metric_reading_is_fresh(METRIC_FAILURE_BACKOFF, false));
        assert!(METRIC_FAILURE_BACKOFF < METRIC_SUCCESS_TTL);
    }

    #[test]
    fn a_nav_date_is_only_reformatted_when_it_is_the_expected_shape() {
        assert_eq!(format_nav_date("20260612"), Some("2026-06-12".to_string()));
        assert_eq!(format_nav_date(""), None);
        assert_eq!(
            format_nav_date("2026-06-12"),
            None,
            "already dashed, wrong length"
        );
        assert_eq!(
            format_nav_date("2026061"),
            None,
            "seven digits is not a date"
        );
    }

    #[test]
    fn the_sentiment_json_keys_are_the_ones_the_ui_reads() {
        let sentiment = Sentiment {
            fear_greed: Some(FearGreed {
                value: 64,
                classification: "Greed".to_string(),
            }),
            btc_rainbow: btc_rainbow_at(Some(100_000.0), 6000),
            mvrv_zscore: zoned(Some(2.34), &MVRV_ZONES, MVRV_DP),
            sopr: zoned(Some(1.0042), &SOPR_ZONES, SOPR_DP),
            puell: zoned(Some(0.92), &PUELL_ZONES, PUELL_DP),
            fetched_at: None,
        };
        let json = serde_json::to_value(&sentiment).unwrap();
        for key in ["fear_greed", "btc_rainbow", "mvrv_zscore", "sopr", "puell"] {
            assert!(json.get(key).is_some(), "missing {key}");
        }
        assert!(
            json.get("fetched_at").is_none(),
            "only the standalone page carries a timestamp"
        );
        assert_eq!(json["sopr"]["value"], 1.004, "SOPR is published to 3dp");
        assert_eq!(json["mvrv_zscore"]["color"], "#e0b30b");
    }

    #[test]
    fn a_rainbow_serialises_with_a_whole_dollar_fair_value() {
        let json = serde_json::to_value(btc_rainbow_at(Some(100_000.0), 6000).unwrap()).unwrap();
        assert!(json["fair_usd"].is_i64(), "fair_usd must not be a float");
        assert!(json["ratio"].is_f64());
        assert!(json["label"].is_string() && json["color"].is_string());
    }
}
